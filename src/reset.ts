import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  listManagedTargetPathsForReset,
  removeManagedTargetForReset,
  storePath
} from "./managed-documents.js";
import { PROJECT_FORMAT_VERSION } from "./project.js";

export interface ResetOutput {
  deleted_managed_files: string[];
  removed_store: true;
}

export async function resetProjectData(projectRoot: string, options: { force: boolean }): Promise<ResetOutput> {
  if (!options.force) {
    throw new Error("reset requires --force");
  }
  const marker = await readMarkerLoosely(projectRoot);
  let managedFiles: string[] = [];
  if (marker?.format_version === PROJECT_FORMAT_VERSION) {
    managedFiles = await listManagedTargetPathsForReset(projectRoot).catch(() => []);
    for (const filePath of managedFiles) {
      await removeManagedTargetForReset(projectRoot, filePath);
    }
  }
  await rm(storePath(projectRoot), { recursive: true, force: true });
  return { deleted_managed_files: managedFiles, removed_store: true };
}

async function readMarkerLoosely(projectRoot: string): Promise<{ format_version?: number } | undefined> {
  const markerPath = join(storePath(projectRoot), "project.json");
  const content = await readFile(markerPath, "utf8").catch(() => undefined);
  if (!content) {
    return undefined;
  }
  try {
    return JSON.parse(content) as { format_version?: number };
  } catch {
    return undefined;
  }
}
