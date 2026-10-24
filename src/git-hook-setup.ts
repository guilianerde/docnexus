import { lstat, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { asDocNexusError } from "./errors.js";
import { workspacePath } from "./layout.js";
import { assertNoSymbolicLinks, readIfExists } from "./workspace-io.js";
import type { GitHooksHealth } from "./git-hooks.js";

async function unavailableProject(root: string): Promise<string | undefined> {
  await assertNoSymbolicLinks(root, ".docnexus/project.json");
  if (await readIfExists(join(root, ".docnexus/project.json")) === undefined) return "project_not_initialized";
  const workspace = workspacePath(root);
  await assertNoSymbolicLinks(root, relative(root, workspace));
  // No Git subprocess or hook runtime is needed for projects without Git.
  for (let directory = workspace; ; directory = dirname(directory)) {
    const entry = await lstat(join(directory, ".git")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (entry) return undefined;
    if (dirname(directory) === directory) return "no_git_repository";
  }
}

function failedHealth(error: unknown): GitHooksHealth {
  const failure = asDocNexusError(error);
  return { ok: false, status: "unavailable", installed: false, reason: String(failure.details?.reason ?? failure.code), message: failure.message };
}

/** Shared by init and doctor; a non-Git project is healthy and explicitly skipped. */
export async function inspectProjectGitHooks(projectRoot: string): Promise<GitHooksHealth> {
  try {
    const root = await realpath(projectRoot);
    const reason = await unavailableProject(root);
    if (reason) return { ok: true, status: "skipped", skipped: true, installed: false, reason };
    const { inspectGitHooks } = await import("./git-hooks.js");
    return await inspectGitHooks(root);
  } catch (error) { return failedHealth(error); }
}

/** Installation/init supplies hooks once the project and its Git repository exist. */
export async function installProjectGitHooks(projectRoot: string): Promise<GitHooksHealth> {
  let health: GitHooksHealth;
  try {
    const root = await realpath(projectRoot);
    const reason = await unavailableProject(root);
    if (reason) return { ok: true, status: "skipped", skipped: true, installed: false, reason };
    const { inspectGitHooks, manageGitHooks } = await import("./git-hooks.js");
    await manageGitHooks(root, "install");
    health = await inspectGitHooks(root);
  } catch (error) {
    health = failedHealth(error);
  }
  process.stderr.write(health.ok ? "docnexus: installed/updated local Git hooks.\n"
    : `docnexus: Git hook setup is not healthy (${health.reason ?? health.status}): ${health.message}\n`);
  return health;
}
