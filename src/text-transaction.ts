import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { workspaceDirectory } from "./layout.js";
import { withProjectLock } from "./project-lock.js";
import { DocNexusError } from "./errors.js";
import { assertNoSymbolicLinks, atomicWrite, ensureIgnoredEntries, readIfExists, syncDirectory } from "./workspace-io.js";

interface Journal {
  version: 1;
  phase: "apply" | "rollback";
  entries: Array<{ path: string; before: string | null; after: string | null }>;
  remove_directories: string[];
  rollback_directories: string[];
  remove_indexed_document?: string;
  git_merge?: true;
}

const JOURNAL = ".docnexus/.runtime/transaction.json";

async function safePath(root: string, path: string, directory = false): Promise<string> {
  const absolute = resolve(root, path);
  const normalized = relative(root, absolute).split(sep).join("/");
  const prefix = `${workspaceDirectory(root)}/`;
  const knowledge = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : "";
  const allowed = directory
    ? /^records\/doc_[a-f0-9]{16}$/.test(knowledge)
    : /^(library\/.+\.md|records\/doc_[a-f0-9]{16}\/(source\.md|metadata\.json|timeline\.md|record\.json))$/.test(knowledge)
      || /^\.docnexus\/drafts\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/manifest\.json$/.test(normalized);
  if (isAbsolute(path) || normalized !== path || !allowed) throw new Error("invalid text transaction path");
  await assertNoSymbolicLinks(root, path.split("/").join(sep));
  return absolute;
}

async function journalPath(root: string): Promise<string> {
  await assertNoSymbolicLinks(root, JOURNAL.split("/").join(sep));
  return join(root, JOURNAL);
}

async function applyJournal(root: string, journal: Journal): Promise<void> {
  if (journal.version !== 1 || !["apply", "rollback"].includes(journal.phase) || !Array.isArray(journal.entries)
    || !Array.isArray(journal.remove_directories) || !Array.isArray(journal.rollback_directories)
    || (journal.git_merge !== undefined && journal.git_merge !== true)
    || (journal.remove_indexed_document !== undefined && !/^doc_[a-f0-9]{16}$/.test(journal.remove_indexed_document))) {
    throw new Error("invalid text transaction journal; inspect .docnexus/.runtime/transaction.json");
  }
  // Validate the whole intent before touching any destination.
  for (const entry of journal.entries) {
    if (![entry.before, entry.after].every((value) => value === null || typeof value === "string")) throw new Error("invalid text transaction contents");
    await safePath(root, entry.path);
  }
  for (const path of [...journal.remove_directories, ...journal.rollback_directories]) await safePath(root, path, true);
  const directories = new Set<string>();
  for (const entry of journal.entries) {
    const target = await safePath(root, entry.path);
    const content = journal.phase === "apply" ? entry.after : entry.before;
    if (content === null) {
      await rm(target, { force: true });
    } else await atomicWrite(target, content);
    // Persist newly created parent entries as well as each file's contents.
    let parent = dirname(target);
    while (parent !== root && parent.startsWith(`${root}${sep}`)) {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  for (const path of journal.phase === "apply" ? journal.remove_directories : journal.rollback_directories) {
    const target = await safePath(root, path, true);
    await rm(target, { recursive: true, force: true });
    directories.add(dirname(target));
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    if (await stat(directory).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    })) await syncDirectory(directory);
  }
  if (journal.phase === "apply" && journal.remove_indexed_document) {
    const { removeIndexedDocument } = await import("./retrieval-index.js");
    await removeIndexedDocument(root, journal.remove_indexed_document);
  }
  // A Git repair's before-images can contain unresolved records. Restore them
  // even though a derived navigation index cannot be rebuilt from that state.
  if (!(journal.git_merge && journal.phase === "rollback")) {
    const { writeConceptIndex } = await import("./concepts.js");
    await writeConceptIndex(root);
  }
}

export async function assertNoPendingTextTransaction(root: string): Promise<void> {
  if (await readIfExists(await journalPath(root)) !== undefined) {
    throw new DocNexusError("text_integrity_error", "Git merge repair refuses a pending .docnexus/.runtime/transaction.json; preserve the checkout and inspect the interrupted write before proceeding. Do not delete the journal or replay it over merged files blindly.");
  }
}

export async function recoverTextTransaction(root: string): Promise<void> {
  const path = await journalPath(root);
  const content = await readIfExists(path);
  if (content === undefined) return;
  await applyJournal(root, JSON.parse(content) as Journal);
  await rm(path);
  await syncDirectory(dirname(path));
}

/** A durable intent is replayed after a crash; ordinary failures durably switch to rollback. */
export async function commitTextTransaction(
  projectRoot: string,
  files: Map<string, string | null>,
  options: { removeDirectories?: string[]; rollbackDirectories?: string[]; removeIndexedDocument?: string; gitMerge?: boolean } = {}
): Promise<void> {
  return withProjectLock(projectRoot, async () => {
    const root = await realpath(projectRoot);
    await ensureIgnoredEntries(root, [".runtime/"]);
    const entries: Journal["entries"] = [];
    for (const [absolute, after] of files) {
      const path = relative(root, absolute).split(sep).join("/");
      const target = await safePath(root, path);
      entries.push({ path, before: (await readIfExists(target)) ?? null, after });
    }
    const journal: Journal = {
      version: 1, phase: "apply", entries,
      remove_directories: (options.removeDirectories ?? []).map((path) => relative(root, path).split(sep).join("/")),
      rollback_directories: (options.rollbackDirectories ?? []).map((path) => relative(root, path).split(sep).join("/")),
      remove_indexed_document: options.removeIndexedDocument,
      ...(options.gitMerge ? { git_merge: true as const } : {})
    };
    const path = await journalPath(root);
    await mkdir(dirname(path), { recursive: true });
    await syncDirectory(dirname(dirname(path)));
    await atomicWrite(path, JSON.stringify(journal));
    try { await applyJournal(root, journal); }
    catch (error) {
      journal.phase = "rollback";
      try {
        await atomicWrite(path, JSON.stringify(journal));
        await applyJournal(root, journal);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], "document write failed; durable recovery is pending");
      }
      await rm(path);
      await syncDirectory(dirname(path));
      throw error;
    }
    await rm(path);
    await syncDirectory(dirname(path));
  });
}
