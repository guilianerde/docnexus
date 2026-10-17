import { withProjectLock } from "./project-lock.js";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { removeAgentContext } from "./agent-context.js";
import { projectMarkerPath, WORKSPACE_INSTALLATION_ENTRIES, workspacePath } from "./layout.js";
import { unlinkSkills } from "./skills.js";
import { withRetrievalDatabase } from "./postgres-engine.js";
import { ensureIgnoredEntries } from "./workspace-io.js";

export interface ResetOutput {
  removed_workspace: string;
  removed_links: string[];
  cleaned_context_files: string[];
  preserved_installation?: boolean;
  preserved_git?: boolean;
}

/** Removes project memory and agent integration, retaining a workspace-local npm installation. */
export async function resetProjectData(projectRoot: string, options: { force: boolean }): Promise<ResetOutput> {
  return withProjectLock(projectRoot, async () => {
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
    if (process.env.DOCNEXUS_DATABASE_URL) {
      await withRetrievalDatabase(projectRoot, db => db.exec(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`));
    }
    const removedLinks = await unlinkSkills(projectRoot);
    const cleaned = await removeAgentContext(projectRoot);
    const entries = await readdir(workspace);
    const preserveInstallation = entries.some(entry => WORKSPACE_INSTALLATION_ENTRIES.includes(entry));
    const preserveGit = entries.includes(".git");
    if (preserveInstallation || preserveGit) {
      for (const entry of entries) {
        if (!WORKSPACE_INSTALLATION_ENTRIES.includes(entry) && entry !== ".gitignore" && entry !== ".git") await rm(join(workspace, entry), { recursive: true, force: true });
      }
      await ensureIgnoredEntries(projectRoot, ["node_modules/"]);
    } else await rm(workspace, { recursive: true, force: true });
    return { removed_workspace: workspace, removed_links: removedLinks, cleaned_context_files: cleaned,
      ...(preserveInstallation ? { preserved_installation: true } : {}), ...(preserveGit ? { preserved_git: true } : {}) };
  });
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
