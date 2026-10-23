import { lstat, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { asDocNexusError } from "./errors.js";
import { workspacePath } from "./layout.js";
import { assertNoSymbolicLinks, readIfExists } from "./workspace-io.js";

/** Installation/init supplies hooks once the project and its Git repository exist. */
export async function installProjectGitHooks(projectRoot: string): Promise<void> {
  try {
    const root = await realpath(projectRoot);
    await assertNoSymbolicLinks(root, ".docnexus/project.json");
    if (await readIfExists(join(root, ".docnexus/project.json")) === undefined) return;
    const workspace = workspacePath(root);
    await assertNoSymbolicLinks(root, relative(root, workspace));
    // No Git subprocess or hook runtime is needed for projects without Git.
    for (let directory = workspace; ; directory = dirname(directory)) {
      const entry = await lstat(join(directory, ".git")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (entry) {
        const { manageGitHooks } = await import("./git-hooks.js");
        await manageGitHooks(root, "install");
        process.stderr.write("docnexus: installed/updated local Git hooks.\n");
        return;
      }
      if (dirname(directory) === directory) return;
    }
  } catch (error) {
    const failure = asDocNexusError(error);
    process.stderr.write(`docnexus: automatic Git hook setup skipped (${failure.code}): ${failure.message}\n`);
  }
}
