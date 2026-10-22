import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { DocNexusError } from "./errors.js";
import { workspacePath } from "./layout.js";
import { readGitBlobs, runWorkspaceGit } from "./workspace-git.js";

export interface GitIndexEntry { mode: string; oid: string; stage: number; path: string }
export interface GitContext { repository: string; prefix: string; index: string; mergeHeadPath: string }

export async function gitContext(root: string): Promise<GitContext> {
  const workspace = workspacePath(root);
  const repository = await realpath((await runWorkspaceGit(workspace, ["rev-parse", "--show-toplevel"])).trim());
  const prefix = relative(repository, workspace).split(sep).join("/");
  if (isAbsolute(prefix) || prefix === ".." || prefix.startsWith("../")) throw new DocNexusError("git_operation_failed", "knowledge output is outside the Git repository");
  const path = async (name: string) => resolve(repository, (await runWorkspaceGit(repository, ["rev-parse", "--path-format=absolute", "--git-path", name])).trim());
  return { repository, prefix: prefix ? `${prefix}/` : "", index: await path("index"), mergeHeadPath: await path("MERGE_HEAD") };
}

export function knowledgePath(context: GitContext, path: string): string | undefined {
  if (!path.startsWith(context.prefix)) return undefined;
  const local = path.slice(context.prefix.length);
  if (local.split("/").some(part => !part || part === "." || part === "..")) return undefined;
  return /^(library\/.+\.md|records\/doc_[a-f0-9]{16}\/(record\.json|metadata\.json|source\.md|timeline\.md)|CONCEPTS\.md|concepts\/.+\.md)$/.test(local) ? local : undefined;
}

export function generatedPath(context: GitContext, path: string): boolean {
  const local = knowledgePath(context, path);
  return local !== undefined && (local === "CONCEPTS.md" || local.startsWith("concepts/") || local.endsWith("/record.json"));
}

export function parseIndexEntries(text: string): GitIndexEntry[] {
  return text.split("\0").filter(Boolean).map(line => {
    const match = /^([0-7]{6}) ([a-f0-9]{40}(?:[a-f0-9]{24})?) ([0-3])\t([\s\S]+)$/.exec(line);
    if (!match) throw new DocNexusError("git_operation_failed", "invalid Git index entry");
    return { mode: match[1], oid: match[2], stage: Number(match[3]), path: match[4] };
  });
}

export async function mergeParents(context: GitContext): Promise<{ ours: string; theirs: string } | undefined> {
  const value = await readFile(context.mergeHeadPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (value === undefined) return undefined;
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?\n?$/.test(value)) throw new DocNexusError("git_merge_not_ready", "automatic recovery supports an ordinary two-parent Git merge only");
  return { ours: (await runWorkspaceGit(context.repository, ["rev-parse", "HEAD"])).trim(), theirs: value.trim() };
}

export async function readIndexEntries(context: GitContext, indexFile = context.index) {
  return parseIndexEntries(await runWorkspaceGit(context.repository, ["ls-files", "--full-name", "--stage", "-z"], { indexFile }))
    .filter(entry => knowledgePath(context, entry.path));
}

export async function readIndex(context: GitContext, indexFile = context.index, include?: (entry: GitIndexEntry) => boolean) {
  const entries = (await readIndexEntries(context, indexFile)).filter(entry => !include || include(entry));
  if (entries.some(entry => entry.mode !== "100644" && entry.mode !== "100755")) throw new DocNexusError("git_merge_not_ready", "knowledge assets must be regular Git files");
  const blobs = await readGitBlobs(context.repository, entries.map(entry => entry.oid));
  const staged = new Map(entries.filter(entry => entry.stage === 0).map(entry => [entry.path, blobs.get(entry.oid)!]));
  return { entries, blobs, staged };
}
