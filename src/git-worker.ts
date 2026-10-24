import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mapWithConcurrency } from "./concurrency.js";
import type { GitContext } from "./git-index.js";
import { assertNoSymbolicLinks } from "./workspace-io.js";

const REQUESTS = "docnexus-worker-requests";

/** One active worker per Git index; the OS releases this lease after a crash. */
export async function acquireGitWorker(context: GitContext): Promise<DatabaseSync | undefined> {
  const root = dirname(context.index);
  const name = "docnexus-worker.sqlite";
  for (const suffix of ["", "-journal", "-wal", "-shm"]) await assertNoSymbolicLinks(root, name + suffix);
  const db = new DatabaseSync(join(root, name));
  try { db.exec("BEGIN IMMEDIATE"); return db; }
  catch (error) {
    db.close();
    if (/database is locked/.test(String(error))) return undefined;
    throw error;
  }
}

/** Separate request files let index events wake a worker without waiting for its lease. */
export async function requestGitWorker(context: GitContext): Promise<void> {
  const root = dirname(context.index);
  await assertNoSymbolicLinks(root, REQUESTS);
  await mkdir(join(root, REQUESTS), { recursive: true, mode: 0o700 });
  const request = await open(join(root, REQUESTS, randomUUID()), "wx", 0o600);
  await request.close();
}

export async function gitWorkerRequests(context: GitContext): Promise<string[]> {
  const root = dirname(context.index);
  await assertNoSymbolicLinks(root, REQUESTS);
  return (await readdir(join(root, REQUESTS)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })).filter(name => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name));
}

export async function clearGitWorkerRequests(context: GitContext, requests: string[]): Promise<void> {
  const root = dirname(context.index);
  await assertNoSymbolicLinks(root, REQUESTS);
  await mapWithConcurrency(requests, 24, async name => {
    const path = join(root, REQUESTS, name);
    // A request is an empty file; do not recursively remove unexpected directories.
    const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (entry?.isDirectory()) throw new Error("Git worker request must be a file");
    await rm(path, { force: true });
  });
}
