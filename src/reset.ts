import { lstat, readFile, rm } from "node:fs/promises";
import { removeAgentContext } from "./agent-context.js";
import { projectMarkerPath, workspacePath } from "./layout.js";
import { unlinkSkills } from "./skills.js";

export interface ResetOutput {
  removed_workspace: string;
  removed_links: string[];
  cleaned_context_files: string[];
}

/** Deletes the whole `docnexus/` workspace, the agent skill links into it, and the DocNexus instruction blocks. */
export async function resetProjectData(projectRoot: string, options: { force: boolean }): Promise<ResetOutput> {
  if (!options.force) {
    throw new Error("reset requires --force");
  }
  const workspace = workspacePath(projectRoot);
  const info = await lstat(workspace).catch(() => undefined);
  if (!info) {
    throw new Error(`no DocNexus workspace found at ${workspace}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`${workspace} is not a directory; refusing to reset`);
  }
  if (!(await hasMarker(projectRoot))) {
    throw new Error(`${workspace} has no DocNexus project marker; refusing to delete it`);
  }
  const removedLinks = await unlinkSkills(projectRoot);
  const cleaned = await removeAgentContext(projectRoot);
  await rm(workspace, { recursive: true, force: true });
  return { removed_workspace: workspace, removed_links: removedLinks, cleaned_context_files: cleaned };
}

async function hasMarker(projectRoot: string): Promise<boolean> {
  const content = await readFile(projectMarkerPath(projectRoot), "utf8").catch(() => undefined);
  if (!content) {
    return false;
  }
  try {
    return typeof (JSON.parse(content) as { format_version?: unknown }).format_version === "number";
  } catch {
    return false;
  }
}
