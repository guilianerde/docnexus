import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { DocNexusError } from "./errors.js";
import { workspacePath, workspaceDirectory } from "./layout.js";
import { assertNoSymbolicLinks, atomicWrite, readIfExists } from "./workspace-io.js";

const execute = promisify(execFile);

interface GitOptions { indexFile?: string; input?: string }

function gitEnvironment(indexFile?: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return { ...env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", DOCNEXUS_GIT_INTERNAL: "1",
    ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) };
}

export interface WorkspaceGitPlan {
  root: string;
  remote: string;
  ignoreHost: boolean;
  branch: string;
  existingRepository: boolean;
}

async function git(root: string, args: string[], allow?: "no_repository" | "detached", raw = false, options: GitOptions = {}): Promise<string | undefined> {
  // Inherited Git routing must not redirect an operation into the business repository.
  try {
    const execution = execute("git", ["-C", root, ...args], { env: gitEnvironment(options.indexFile), timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
    execution.child.stdin?.on("error", () => {}); // execFile reports a failed child through its promise.
    execution.child.stdin?.end(options.input);
    const { stdout } = await execution;
    return raw ? stdout : stdout.trim();
  } catch (error) {
    const failure = error as { code?: string | number; stderr?: string };
    if (failure.code === "ENOENT") throw new DocNexusError("git_unavailable", "Install Git to configure or use a Git-managed workspace; workspaces without Git setup do not require it.");
    if (allow === "no_repository" && failure.stderr?.includes("not a git repository")) return undefined;
    if (allow === "detached" && failure.code === 1) return undefined;
    // Native driver messages can contain credentials from the remote or local config.
    throw new DocNexusError("git_operation_failed", `Git ${args[0]} failed; inspect repository permissions and configuration before retrying.`);
  }
}

/** Run Git without inherited routing, hook recursion, trimming or pathspec interpretation. */
export async function runWorkspaceGit(root: string, args: string[], options: GitOptions = {}): Promise<string> {
  return (await git(root, ["--literal-pathspecs", ...args], undefined, true, options))!;
}

/** One Git process for a staged snapshot; byte lengths are parsed before UTF-8 decoding. */
export async function readGitBlobs(root: string, objects: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(objects)];
  if (!ids.length) return new Map();
  if (ids.some(id => !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(id))) throw new DocNexusError("git_operation_failed", "invalid Git blob identity");
  const execution = execute("git", ["-C", root, "cat-file", "--batch"], {
    env: gitEnvironment(), encoding: "buffer", timeout: 30_000, maxBuffer: 256 * 1024 * 1024
  });
  execution.child.stdin?.on("error", () => {});
  execution.child.stdin?.end(`${ids.join("\n")}\n`);
  const { stdout } = await execution.catch(() => { throw new DocNexusError("git_operation_failed", "Cannot read staged Git blobs; inspect repository objects and snapshot size."); });
  const result = new Map<string, string>();
  let offset = 0;
  for (const id of ids) {
    const end = stdout.indexOf(10, offset);
    const header = stdout.subarray(offset, end).toString("ascii");
    const match = /^([a-f0-9]+) blob (\d+)$/.exec(header);
    if (!match || match[1] !== id) throw new DocNexusError("git_operation_failed", "Missing or invalid staged Git blob");
    const length = Number(match[2]);
    offset = end + 1;
    if (!Number.isSafeInteger(length) || offset + length >= stdout.length || stdout[offset + length] !== 10) throw new DocNexusError("git_operation_failed", "Truncated staged Git blob");
    result.set(id, stdout.subarray(offset, offset + length).toString("utf8"));
    offset += length + 1;
  }
  return result;
}

export async function assertWorkspaceRepository(root: string): Promise<void> {
  await assertNoSymbolicLinks(root, join(workspaceDirectory(root), ".git"));
  const workspace = workspacePath(root);
  const top = await git(workspace, ["rev-parse", "--show-toplevel"]);
  if (!top || await realpath(top) !== await realpath(workspace)) {
    throw new DocNexusError("git_operation_failed", "The knowledge .git must identify the configured workspace itself.");
  }
}

const branchPolicyFile = (root: string) => join(workspaceDirectory(root), ".git", "docnexus-branch.json");

async function currentBranch(root: string): Promise<string | undefined> {
  const ref = await git(workspacePath(root), ["symbolic-ref", "--quiet", "HEAD"], "detached");
  return ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
}

async function assertSingleBranch(root: string, branch: string): Promise<void> {
  const actual = await currentBranch(root);
  const refs = await git(workspacePath(root), ["for-each-ref", "--format=%(refname)", "refs/heads/"]);
  const branches = refs ? refs.split("\n").map(ref => ref.slice("refs/heads/".length)) : [];
  if (actual !== branch || branches.some(value => value !== branch)) {
    throw new DocNexusError("git_branch_mismatch", `Knowledge repository is pinned to ${branch}. Return to that branch and review any extra local branches before using DocNexus; no branches were changed.`,
      { allowed_branch: branch, actual_branch: actual ?? null, local_branches: branches });
  }
}

/** A pin lives outside the checkout so switching to an older commit cannot erase it. */
export async function assertWorkspaceBranch(root: string): Promise<void> {
  const metadata = await lstat(join(workspacePath(root), ".git")).catch(error => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!metadata?.isDirectory()) return;
  await assertNoSymbolicLinks(root, branchPolicyFile(root));
  const text = await readIfExists(join(root, branchPolicyFile(root)));
  if (text === undefined) return;
  let policy: { format_version?: number; branch?: string };
  try { policy = JSON.parse(text); }
  catch { throw new DocNexusError("git_operation_failed", `Invalid local knowledge branch policy; inspect ${branchPolicyFile(root)} before retrying.`); }
  if (policy?.format_version !== 1 || typeof policy.branch !== "string" || !policy.branch || policy.branch !== policy.branch.trim()) {
    throw new DocNexusError("git_operation_failed", `Invalid local knowledge branch policy; inspect ${branchPolicyFile(root)} before retrying.`);
  }
  await assertWorkspaceRepository(root);
  await assertSingleBranch(root, policy.branch);
}

/** Read-only preflight: do not create knowledge or modify either repository on a known conflict. */
export async function prepareWorkspaceGit(root: string, remote: string): Promise<WorkspaceGitPlan> {
  if (!remote || remote !== remote.trim() || remote.startsWith("-") || /[\u0000-\u001f\u007f]/.test(remote)) {
    throw new DocNexusError("invalid_params", "--git-remote requires a nonempty Git remote address without surrounding whitespace, control characters or a leading dash.");
  }
  await git(root, ["--version"]);
  await assertNoSymbolicLinks(root, join(workspaceDirectory(root), ".git"));
  const metadata = await lstat(join(workspacePath(root), ".git")).catch(error => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  let branch = "main";
  if (metadata) {
    if (!metadata.isDirectory()) throw new DocNexusError("git_operation_failed", "--git-remote requires a standalone .git directory; configure submodules or linked worktrees with Git directly.");
    await assertNoSymbolicLinks(root, join(workspaceDirectory(root), ".git", "config"));
    await assertWorkspaceRepository(root);
    const current = await currentBranch(root);
    if (!current) throw new DocNexusError("git_branch_mismatch", "Return to a named knowledge branch before enabling single-branch use.");
    branch = current;
    await assertSingleBranch(root, branch);
  }
  const host = await git(root, ["rev-parse", "--show-toplevel"], "no_repository");
  if (host) {
    const path = relative(await realpath(host), join(await realpath(root), workspaceDirectory(root))).split(sep).join("/");
    if (await git(host, ["ls-files", "--", `:(top,literal)${path}`])) {
      throw new DocNexusError("git_operation_failed", "The host repository already tracks knowledge output files. Review and remove them from its index (keeping local files) before enabling a separate knowledge repository; no index entries were changed.");
    }
    await assertNoSymbolicLinks(root, ".gitignore");
  }
  return { root, remote, ignoreHost: host !== undefined, branch, existingRepository: metadata !== undefined };
}

export async function configureWorkspaceGit(plan: WorkspaceGitPlan) {
  const workspace = workspacePath(plan.root);
  await git(workspace, plan.existingRepository ? ["init", "--quiet"] : ["init", "--quiet", `--initial-branch=${plan.branch}`]);
  await assertWorkspaceRepository(plan.root);
  await assertSingleBranch(plan.root, plan.branch);
  const remotes = (await git(workspace, ["remote"]))!.split("\n");
  await git(workspace, remotes.includes("origin") ? ["remote", "set-url", "origin", plan.remote] : ["remote", "add", "origin", plan.remote]);
  if (plan.ignoreHost) {
    await assertNoSymbolicLinks(plan.root, ".gitignore");
    const path = join(plan.root, ".gitignore");
    const current = await readIfExists(path) ?? "";
    // Keep this rule last so an earlier negation cannot expose the nested repository.
    if (current.split(/\r?\n/).filter(line => line.length).at(-1) !== `/${workspaceDirectory(plan.root)}/`) {
      await atomicWrite(path, `${current}${current && !current.endsWith("\n") ? "\n" : ""}/${workspaceDirectory(plan.root)}/\n`);
    }
  }
  await assertNoSymbolicLinks(plan.root, branchPolicyFile(plan.root));
  await atomicWrite(join(plan.root, branchPolicyFile(plan.root)), JSON.stringify({ format_version: 1, branch: plan.branch }) + "\n");
  return { repository: workspace, remote: plan.remote, branch: plan.branch };
}
