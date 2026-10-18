import { join } from "node:path";

/** Text memory and rebuildable local indexes live under the visible docnexus/ workspace. */
export const WORKSPACE_DIRNAME = "docnexus";
export const WORKSPACE_INSTALLATION_ENTRIES = ["package.json", "package-lock.json", "node_modules"];

export function workspacePath(projectRoot: string): string {
  return join(projectRoot, WORKSPACE_DIRNAME);
}

export function projectMarkerPath(projectRoot: string): string {
  return join(workspacePath(projectRoot), "project.json");
}

export function skillsPath(projectRoot: string): string {
  return join(workspacePath(projectRoot), "skills");
}

export function draftsPath(projectRoot: string): string {
  return join(workspacePath(projectRoot), "drafts");
}

export function libraryPath(projectRoot: string): string {
  return join(workspacePath(projectRoot), "library");
}

export function schemasPath(projectRoot: string): string {
  return join(workspacePath(projectRoot), "schemas");
}

export function recordsPath(projectRoot: string): string {
  return join(workspacePath(projectRoot), "records");
}

export function conceptIndexPath(projectRoot: string): string {
  return join(workspacePath(projectRoot), "CONCEPTS.md");
}

/** Generated per-category concept files that the root map routes to. */
export function conceptShardsPath(projectRoot: string): string {
  return join(workspacePath(projectRoot), "concepts");
}

/** Project-relative directory of a document’s source, metadata, timeline and record. */
export function recordRelativePath(documentId: string): string {
  return `${WORKSPACE_DIRNAME}/records/${documentId}`;
}

/** Project-relative path of a managed document inside the library. */
export function libraryRelativePath(filePath: string): string {
  return `${WORKSPACE_DIRNAME}/library/${filePath}`;
}

/** Derived stores are ignored by Git and can be rebuilt from the text workspace. */
export function storePath(projectRoot: string): string {
  return join(workspacePath(projectRoot), "store");
}

export function projectModelsPath(projectRoot: string): string {
  return join(storePath(projectRoot), "models");
}
