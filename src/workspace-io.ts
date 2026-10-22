import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

export async function assertNoSymbolicLinks(root: string, relativePath: string, checkedPaths?: Map<string, Promise<boolean>>): Promise<void> {
  // Only canonical relative paths may bypass traversal using a verified leaf.
  const cached = !/(^|[\\/])\.{1,2}([\\/]|$)/.test(relativePath) && checkedPaths?.get(join(root, relativePath));
  if (cached && await cached) return;
  let current = root;
  for (const segment of relativePath.split(sep).flatMap(segment => segment.split("/"))) {
    current = join(current, segment);
    let check = checkedPaths?.get(current);
    if (!check) {
      check = lstat(current).then(info => {
        if (info.isSymbolicLink()) throw new Error("file_path must not contain symbolic links");
        return true;
      }, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      checkedPaths?.set(current, check);
    }
    if (!await check) { checkedPaths?.delete(current); return; }
  }
}

export async function readIfExists(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

export async function syncDirectory(path: string): Promise<void> {
  // Windows does not expose directory fsync through node:fs.
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Callers hold the project lock; a deterministic staging name is reusable after a crash.
  const tempPath = `${path}.docnexus-tmp`;
  try {
    await rm(tempPath, { force: true });
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(tempPath, path);
    await syncDirectory(dirname(path));
  } finally { await rm(tempPath, { force: true }); }
}

export async function ensureIgnoredEntries(root: string, entries: string[]): Promise<void> {
  await assertNoSymbolicLinks(root, join(".docnexus", ".gitignore"));
  const path = join(root, ".docnexus", ".gitignore");
  const current = (await readIfExists(path)) ?? "";
  const missing = entries.filter((entry) => !current.split(/\r?\n/).includes(entry));
  if (missing.length) await atomicWrite(path, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}
