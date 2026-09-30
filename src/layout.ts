import { join } from "node:path";

/**
 * Every DocNexus asset of a project lives under one visible `docnexus/` folder:
 *
 *   docnexus/
 *     project.json      format marker
 *     skills/           project skills (source of truth for agent links)
 *     drafts/           extraction drafts awaiting ingestion
 *     library/          managed Markdown documents (the curated output)
 *     schemas/          JSON schemas used by the skills
 *     store/            derived state: SQLite ledger, LadybugDB graph, sidecars, models
 */
export const WORKSPACE_DIRNAME = "docnexus";

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

export function storePath(projectRoot: string): string {
  return join(workspacePath(projectRoot), "store");
}

export function sidecarsPath(projectRoot: string): string {
  return join(storePath(projectRoot), "documents");
}

export function databasePath(projectRoot: string): string {
  return join(storePath(projectRoot), "index.sqlite");
}

export function graphStorePath(projectRoot: string): string {
  return join(storePath(projectRoot), "graph.lbug");
}

export function projectModelsPath(projectRoot: string): string {
  return join(storePath(projectRoot), "models");
}

/** Project-relative sidecar directory recorded in the SQLite ledger. */
export function sidecarRelativePath(documentId: string): string {
  return `${WORKSPACE_DIRNAME}/store/documents/${documentId}`;
}

/** Project-relative path of a managed document inside the library. */
export function libraryRelativePath(filePath: string): string {
  return `${WORKSPACE_DIRNAME}/library/${filePath}`;
}
