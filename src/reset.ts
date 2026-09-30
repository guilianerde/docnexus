import { lstat, readFile, rm } from "node:fs/promises";
import { projectMarkerPath, workspacePath } from "./layout.js";
import { unlinkSkills } from "./skills.js";

export interface ResetOutput {
  removed_workspace: string;
  removed_links: string[];
}

/** Deletes the whole `docnexus/` workspace and the agent skill links that point into it. */
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
  await rm(workspace, { recursive: true, force: true });
  return { removed_workspace: workspace, removed_links: removedLinks };
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
