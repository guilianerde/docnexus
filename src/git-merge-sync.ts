import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DocNexusError } from "./errors.js";
import { sha256, stableJson } from "./hash.js";
import { libraryRelativePath, recordRelativePath, recordsPath, workspacePath } from "./layout.js";
import { assertValidMetadata } from "./metadata.js";
import { factIssuesError, factUpdateIssues, resolveKnowledge, type KnowledgeDocument } from "./knowledge.js";
import { factDocumentTemplate, renderFactDocument } from "./fact-renderer.js";
import { assertRefinedDocumentLength } from "./document-length.js";
import { assertNoSymbolicLinks } from "./workspace-io.js";
import { runWorkspaceGit } from "./workspace-git.js";
import { parseRecordFile, resolveManagedTarget, type RecordFile } from "./workspace-reader.js";
import type { DocNexusMetadata } from "./types.js";

const notReady = (message: string) => new DocNexusError("git_merge_not_ready", message);
const posix = (path: string) => path.split(sep).join("/");

function assertResolved(content: string, path: string): void {
  // A standalone equals underline can be a valid Markdown setext heading.
  if (/^(?:<{7,}|>{7,}|\|{7,})(?:[ \t].*)?\r?$/m.test(content)) {
    throw notReady(`resolve Git conflict markers in ${path}, then stage the reviewed contents for automatic repair`);
  }
}

export interface GitMergeSnapshot {
  conflicts: string[];
  recordIds: string[];
  read: (projectRelativePath: string) => Promise<string>;
}

/** Prepare without writing so automatic recovery can protect the index and worktree first. */
export async function prepareGitMerge(projectRoot: string, snapshot: GitMergeSnapshot) {
  const root = await realpath(projectRoot);
  const workspace = workspacePath(root);
  let gitRoot = workspace;
  const git = (args: string[]) => runWorkspaceGit(gitRoot, args);
  const repository = await realpath((await git(["rev-parse", "--show-toplevel"])).trim());
  gitRoot = repository;
  const prefix = posix(relative(repository, workspace));
  if (isAbsolute(prefix) || prefix === ".." || prefix.startsWith("../")) throw notReady("knowledge output must be inside the selected Git repository");
  const repoPath = (path: string) => posix(relative(repository, join(root, path)));
  const knowledgePrefix = prefix ? `${prefix}/` : "";
  const recordsPrefix = `${knowledgePrefix}records/`;
  const libraryPrefix = `${knowledgePrefix}library/`;
  const mergeHeadPath = resolve(repository, (await git(["rev-parse", "--git-path", "MERGE_HEAD"])).trim());
  const mergeHead = await readFile(mergeHeadPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw notReady("automatic repair requires an unfinished ordinary Git merge; resolve and stage content before completing the merge");
    throw error;
  });
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?\n?$/.test(mergeHead)) throw notReady("only an ordinary two-parent Git merge is supported");
  const theirs = mergeHead.trim();
  const ours = (await git(["rev-parse", "--verify", "HEAD"])).trim();
  const unmerged = await git(["diff", "--no-relative", "--name-only", "--diff-filter=U", "-z"]);
  const paths = snapshot.conflicts;
  const ids = new Set<string>();
  const libraryConflicts = new Set(paths.filter(path => path.startsWith(libraryPrefix)));
  for (const path of paths.filter(path => path.startsWith(recordsPrefix))) {
    const match = /^(doc_[a-f0-9]{16})\/(?:record\.json|metadata\.json|source\.md|timeline\.md)$/.exec(path.slice(recordsPrefix.length));
    if (!match) throw notReady(`unsupported record conflict: ${path}`);
    ids.add(match[1]);
  }

  // Unmerged record.json cannot be parsed. Other staged records can still
  // identify a library-only conflict.
  await assertNoSymbolicLinks(root, relative(root, recordsPath(root)));
  const records = new Map<string, RecordFile>();
  for (const id of snapshot.recordIds) {
    if (ids.has(id)) continue;
    const record = await parseRecordFile(root, id, await snapshot.read(`${recordRelativePath(id, root)}/record.json`));
    records.set(record.id, record);
    if (libraryConflicts.has(repoPath(libraryRelativePath(record.file_path, root)))) ids.add(record.id);
  }

  async function committedFile(commit: string, path: string): Promise<string> {
    const entry = await git(["ls-tree", "-z", commit, "--", path]);
    const match = /^(100644|100755) blob ([a-f0-9]+)\t([\s\S]*)\0$/.exec(entry);
    if (!match || match[3] !== path) throw notReady(`both Git parents must contain the same regular document assets: ${path}; creates, deletes and renames require manual recovery`);
    return git(["cat-file", "blob", match[2]]);
  }

  const documents: KnowledgeDocument[] = [];
  const assets = new Map<string, { source: string; document: string; metadata: DocNexusMetadata; timeline: string }>();
  const parents = new Map<string, KnowledgeDocument[]>();
  const read = snapshot.read;
  async function readMergedAssets(record: RecordFile, verify: boolean) {
    const target = await resolveManagedTarget(root, record.file_path);
    const directory = recordRelativePath(record.id, root);
    const [source, document, metadataJson, timeline] = (await Promise.allSettled([
      read(`${directory}/source.md`), read(libraryRelativePath(record.file_path, root)),
      read(`${directory}/metadata.json`), read(`${directory}/timeline.md`)
    ])).map(result => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    if (!verify) for (const [name, content] of [["source.md", source], ["metadata.json", metadataJson], ["timeline.md", timeline], [target.relativePath, document]]) assertResolved(content, `${record.id}/${name}`);
    let metadata: unknown;
    try { metadata = JSON.parse(metadataJson); }
    catch { throw notReady(`resolve invalid JSON in ${directory}/metadata.json`); }
    assertValidMetadata(metadata);
    if (!source.trim() || !document.trim() || !timeline.trim()) throw notReady(`source, document and timeline must remain non-empty for ${record.id}`);
    if (verify && (metadata.title !== record.title || sha256(source) !== record.source_hash || sha256(factDocumentTemplate(document)) !== record.document_hash
      || sha256(stableJson(metadata)) !== record.metadata_hash || sha256(timeline) !== record.timeline_hash)) throw notReady(`nonconflicting document ${record.id} has inconsistent staged assets; review and sync it before retrying`);
    return { source, document, metadata, timeline };
  }
  for (const id of [...ids].sort()) {
    const versions: RecordFile[] = [];
    const previous: KnowledgeDocument[] = [];
    for (const commit of [ours, theirs]) {
      const recordPath = repoPath(`${recordRelativePath(id, root)}/record.json`);
      const record = await parseRecordFile(root, id, await committedFile(commit, recordPath));
      const metadata: unknown = JSON.parse(await committedFile(commit, repoPath(`${recordRelativePath(id, root)}/metadata.json`)));
      assertValidMetadata(metadata);
      if (sha256(stableJson(metadata)) !== record.metadata_hash) throw notReady(`committed metadata does not match record ${id} in ${commit}`);
      versions.push(record);
      previous.push({ id, file_path: record.file_path, metadata });
    }
    const [record, other] = versions;
    if (record.file_path !== other.file_path || record.created_at !== other.created_at) throw notReady(`document ${id} changed identity or path; restore one complete document unit before recovery`);
    records.set(id, record);
    parents.set(id, previous);
    assets.set(id, await readMergedAssets(record, false));
    // A repeated index notification must not append the same adoption event.
    const current = await read(`${recordRelativePath(id, root)}/record.json`).then(text => parseRecordFile(root, id, text)).catch(() => undefined);
    const content = assets.get(id)!;
    if (current?.file_path === record.file_path && current.created_at === record.created_at
      && current.source_hash === sha256(content.source) && current.document_hash === sha256(factDocumentTemplate(content.document))
      && current.metadata_hash === sha256(stableJson(content.metadata)) && current.timeline_hash === sha256(content.timeline)
      && content.timeline.includes(`Git parents: ${ours}, ${theirs}\n`)) records.set(id, current);
  }
  for (const path of libraryConflicts) {
    if (![...ids].some(id => repoPath(libraryRelativePath(records.get(id)!.file_path, root)) === path)) throw notReady(`unmatched library conflict: ${path}; creates, deletes and renames require manual recovery`);
  }
  const filePaths = new Set<string>();
  for (const record of records.values()) {
    if (filePaths.has(record.file_path)) throw notReady(`duplicate document path ${record.file_path}; same-path creates require manual recovery`);
    filePaths.add(record.file_path);
    const current = assets.get(record.id) ?? await readMergedAssets(record, true);
    documents.push({ id: record.id, file_path: record.file_path, metadata: current.metadata,
      document: current.document, document_hash: sha256(factDocumentTemplate(current.document)) });
  }
  const issues = documents.flatMap(document => (parents.get(document.id) ?? []).flatMap(previous => factUpdateIssues(previous, document)));
  if (issues.length) throw factIssuesError(issues);
  const knowledge = resolveKnowledge(documents);
  const files = new Map<string, string | null>();
  const now = new Date().toISOString();
  const repaired: Array<{ id: string; file_path: string; library_path: string }> = [];
  for (const document of documents) {
    const record = records.get(document.id)!;
    const rendered = renderFactDocument(document.document!, knowledge.facts).document;
    const target = await resolveManagedTarget(root, document.file_path);
    const current = assets.get(document.id);
    if (current) {
      assertRefinedDocumentLength(rendered, document.file_path);
      const unchanged = record.source_hash === sha256(current.source) && record.document_hash === document.document_hash
        && record.metadata_hash === sha256(stableJson(current.metadata)) && record.timeline_hash === sha256(current.timeline)
        && current.timeline.includes(`Git parents: ${ours}, ${theirs}\n`);
      const timeline = unchanged ? current.timeline : `${current.timeline}\n## ${now} — adopted Git merge\n\nGit parents: ${ours}, ${theirs}\n\n${current.metadata.title}\n\n### Adopted document\n\n${rendered}\n`;
      const next: RecordFile = { ...record, title: current.metadata.title, updated_at: unchanged ? record.updated_at : now,
        source_hash: sha256(current.source), document_hash: document.document_hash!,
        metadata_hash: sha256(stableJson(current.metadata)), timeline_hash: sha256(timeline) };
      const directory = join(recordsPath(root), document.id);
      files.set(join(directory, "metadata.json"), `${stableJson(current.metadata)}\n`);
      files.set(join(directory, "timeline.md"), timeline);
      files.set(join(directory, "record.json"), `${JSON.stringify(next, null, 2)}\n`);
      files.set(target.absolutePath, rendered);
      repaired.push({ id: document.id, file_path: document.file_path, library_path: libraryRelativePath(document.file_path, root) });
    } else if (rendered !== document.document) {
      assertRefinedDocumentLength(rendered, document.file_path);
      files.set(target.absolutePath, rendered);
    }
  }
  // Git does not share the project lock. Reject a changed integration state
  // before persisting an intent, and leave staging/committing to the caller.
  if ((await git(["rev-parse", "--verify", "HEAD"])).trim() !== ours || await readFile(mergeHeadPath, "utf8") !== mergeHead
    || await git(["diff", "--no-relative", "--name-only", "--diff-filter=U", "-z"]) !== unmerged) throw notReady("Git merge state changed while preparing the repair; reread the merged contents and retry");
  return { files, result: { operation: "adopted_git_merge", parents: [ours, theirs], count: repaired.length, documents: repaired, staged: false } };
}
