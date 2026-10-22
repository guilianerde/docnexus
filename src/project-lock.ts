import { DocNexusError } from "./errors.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { sha256 } from "./hash.js";
import { assertNoSymbolicLinks } from "./workspace-io.js";
import { addUsageMetric } from "./usage-metrics.js";
import { assertWorkspaceBranch } from "./workspace-git.js";

const leases = new AsyncLocalStorage<ReadonlySet<string>>();

/** Serialize local processes; the OS releases SQLite's lock even after SIGKILL. */
export async function withProjectLock<T>(projectRoot: string, operation: () => Promise<T>, waitMs = 30_000, options: { rejectPendingTransaction?: boolean } = {}): Promise<T> {
  const root = await realpath(projectRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new DocNexusError("project_not_found", `project root does not exist: ${projectRoot}`);
    throw error;
  });
  if (leases.getStore()?.has(root)) return operation();
  // Outside the workspace so reset/re-init cannot unlink a held lock.
  // Unix TMPDIR can vary per agent; use one OS-wide location for the same user/project.
  const temporaryRoot = await realpath(process.platform === "win32" ? tmpdir() : "/tmp");
  const lockDirectory = `docnexus-locks-${process.getuid?.() ?? "local"}`;
  const directory = join(temporaryRoot, lockDirectory);
  await assertNoSymbolicLinks(temporaryRoot, lockDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (process.getuid && info.uid !== process.getuid()) throw new DocNexusError("text_integrity_error", "project lock directory has a different owner");
  const file = `${sha256(root)}.sqlite`;
  for (const suffix of ["", "-journal", "-wal", "-shm"]) await assertNoSymbolicLinks(directory, file + suffix);
  const db = new DatabaseSync(join(directory, file));
  const deadline = Date.now() + waitMs;
  const waitStart = performance.now();
  try {
    while (true) {
      try { db.exec("BEGIN IMMEDIATE"); break; }
      catch (error) {
        if (!/database is locked/.test(String(error))) throw error;
        if (Date.now() >= deadline) throw new DocNexusError("project_busy", "DocNexus project is busy; retry after the current operation completes");
        await setTimeout(20);
      }
    }
    addUsageMetric("project_lock_wait_ms", performance.now() - waitStart);
    return await leases.run(new Set([...(leases.getStore() ?? []), root]), async () => {
      await assertNoSymbolicLinks(root, ".docnexus/project.json");
      const { recoverTextTransaction, assertNoPendingTextTransaction } = await import("./text-transaction.js");
      await assertWorkspaceBranch(root);
      if (options.rejectPendingTransaction) await assertNoPendingTextTransaction(root);
      await recoverTextTransaction(root);
      return operation();
    });
  } finally { db.close(); }
}
