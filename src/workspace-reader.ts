import { DocNexusError } from "./errors.js";
import { readdir, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sha256, stableJson } from "./hash.js";
import { libraryPath, recordRelativePath, recordsPath, workspaceDirectory } from "./layout.js";
import { assertValidMetadata } from "./metadata.js";
import type { DocNexusMetadata } from "./types.js";
import { assertNoSymbolicLinks, readIfExists } from "./workspace-io.js";
import { withProjectLock } from "./project-lock.js";
import { factDocumentTemplate } from "./fact-renderer.js";

export interface RecordFile {
  id: string;
  file_path: string;
  title: string;
  created_at: string;
  updated_at: string;
  source_hash: string;
  document_hash: string;
  metadata_hash: string;
  timeline_hash: string;
}

/** Only reuse directory checks inside one locked snapshot, never across requests. */
export async function createWorkspaceReadContext(projectRoot: string) {
  const root = await realpath(projectRoot);
  return { root, directory: workspaceDirectory(root), checkedDirectories: new Set<string>() };
}

type WorkspaceReadContext = Awaited<ReturnType<typeof createWorkspaceReadContext>>;

export function assertDocumentId(id: string): void {
  if (!/^doc_[a-f0-9]{16}$/.test(id)) throw new DocNexusError("invalid_params", "invalid document id");
}

export async function recordDirectory(projectRoot: string, id: string, context?: WorkspaceReadContext): Promise<string> {
  assertDocumentId(id);
  const root = context?.root ?? await realpath(projectRoot);
  const path = context ? join(context.directory, "records", id) : recordRelativePath(id, root);
  await assertNoSymbolicLinks(root, path, context?.checkedDirectories);
  return join(root, path);
}

export async function readRecordAsset(projectRoot: string, id: string, name: string, context?: WorkspaceReadContext): Promise<string> {
  const directory = await recordDirectory(projectRoot, id, context);
  const root = context?.root ?? await realpath(projectRoot);
  await assertNoSymbolicLinks(root, relative(root, join(directory, name)), context?.checkedDirectories);
  return readFile(join(directory, name), "utf8");
}

export async function listRecordFiles(projectRoot: string, context?: WorkspaceReadContext): Promise<RecordFile[]> {
  const read = async () => {
    const root = context?.root ?? await realpath(projectRoot);
    const directory = context ? join(root, context.directory, "records") : recordsPath(root);
    await assertNoSymbolicLinks(root, relative(root, directory), context?.checkedDirectories);
    const entries = await readdir(directory, { withFileTypes: true });
    const records: RecordFile[] = [];
    const paths = new Set<string>();
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new DocNexusError("text_integrity_error", "record directory must not contain symbolic links");
      if (!entry.isDirectory()) continue;
      const record = await readRecordFile(root, entry.name, context);
      if (paths.has(record.file_path)) {
        throw new DocNexusError("text_integrity_error", `duplicate record file_path: ${record.file_path}`);
      }
      paths.add(record.file_path);
      records.push(record);
    }
    return records;
  };
  return context ? read() : withProjectLock(projectRoot, read);
}

export async function readRecordFile(projectRoot: string, id: string, context?: WorkspaceReadContext): Promise<RecordFile> {
  const content = await readRecordAsset(projectRoot, id, "record.json", context).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new DocNexusError("document_not_found", `Unknown document id: ${id}`);
    throw error;
  });
  const record = JSON.parse(content) as RecordFile;
  if (record.id !== id) throw new DocNexusError("text_integrity_error", `record ${id} has a mismatched id`);
  if ((await resolveManagedTarget(projectRoot, record.file_path, context)).relativePath !== record.file_path) {
    throw new DocNexusError("text_integrity_error", `invalid record file_path: ${record.file_path}`);
  }
  for (const key of ["source_hash", "document_hash", "metadata_hash", "timeline_hash"] as const) {
    if (!/^[a-f0-9]{64}$/.test(record[key])) throw new DocNexusError("text_integrity_error", `record ${id} has an invalid ${key}`);
  }
  if (typeof record.title !== "string" || !Number.isFinite(Date.parse(record.created_at)) || !Number.isFinite(Date.parse(record.updated_at))) {
    throw new DocNexusError("text_integrity_error", `record ${id} has invalid metadata`);
  }
  return record;
}

export async function readRecordMetadata(projectRoot: string, documentId: string, context?: WorkspaceReadContext): Promise<DocNexusMetadata> {
  const read = async () => {
    const metadata: unknown = JSON.parse(await readRecordAsset(projectRoot, documentId, "metadata.json", context));
    assertValidMetadata(metadata);
    return metadata;
  };
  return context ? read() : withProjectLock(projectRoot, read);
}

export async function readAssets(projectRoot: string, record: RecordFile, acceptLibraryEdit = false) {
  const source = await readRecordAsset(projectRoot, record.id, "source.md");
  const { metadata, document } = await readCurrentAssets(projectRoot, record, undefined, acceptLibraryEdit);
  const timeline = await readRecordAsset(projectRoot, record.id, "timeline.md");
  if (sha256(source) !== record.source_hash) throw new DocNexusError("text_integrity_error", `record ${record.id} source.md does not match record.json`);
  if (sha256(timeline) !== record.timeline_hash) throw new DocNexusError("text_integrity_error", `record ${record.id} timeline.md does not match record.json`);
  return { source, document, metadata, timeline };
}

/** Query dependencies only; source/history integrity belongs to explicit reads, writes and doctor. */
export async function readCurrentAssets(projectRoot: string, record: RecordFile, context?: WorkspaceReadContext, acceptLibraryEdit = false) {
  const metadata = await readRecordMetadata(projectRoot, record.id, context);
  const target = await resolveManagedTarget(projectRoot, record.file_path, context);
  const document = await readIfExists(target.absolutePath);
  if (document === undefined) throw new DocNexusError("text_integrity_error", `managed library file is missing: ${record.file_path}`);
  if (!acceptLibraryEdit && sha256(factDocumentTemplate(document)) !== record.document_hash) {
    throw new DocNexusError("text_integrity_error", `managed target was externally modified: ${record.file_path}; run "docnexus document sync" to adopt the edit`);
  }
  if (sha256(stableJson(metadata)) !== record.metadata_hash) throw new DocNexusError("text_integrity_error", `record ${record.id} metadata.json does not match record.json`);
  return { document, metadata };
}

export async function resolveManagedTarget(projectRoot: string, filePath: string, context?: WorkspaceReadContext): Promise<{ absolutePath: string; relativePath: string }> {
  if (typeof filePath !== "string" || !filePath.trim()) throw new DocNexusError("invalid_params", "file_path is required");
  if (isAbsolute(filePath) || extname(filePath).toLowerCase() !== ".md") throw new DocNexusError("invalid_params", "file_path must be a project-relative Markdown path");
  const root = context?.root ?? await realpath(resolve(projectRoot));
  const managedRoot = context ? join(root, context.directory, "library") : libraryPath(root);
  const absolutePath = resolve(managedRoot, filePath);
  const relativePath = relative(managedRoot, absolutePath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new DocNexusError("invalid_params", `file_path must remain inside the ${workspaceDirectory(projectRoot)}/library directory`);
  await assertNoSymbolicLinks(root, relative(root, absolutePath), context?.checkedDirectories);
  return { absolutePath, relativePath: relativePath.split(sep).join("/") };
}

export async function normalizeManagedFilePath(projectRoot: string, filePath: string): Promise<string> {
  return (await resolveManagedTarget(projectRoot, filePath)).relativePath;
}

export async function isManagedFilePath(projectRoot: string, filePath: string): Promise<boolean> {
  const normalized = await normalizeManagedFilePath(projectRoot, filePath);
  return (await listRecordFiles(projectRoot)).some((record) => record.file_path === normalized);
}
