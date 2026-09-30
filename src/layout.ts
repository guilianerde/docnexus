import { join } from "node:path";

/**
 * Every DocNexus asset of a project lives under one visible `docnexus/` folder:
 *
 *   docnexus/
 *     project.json      format marker
 *     skills/           project skills (source of truth for agent links)
 *     drafts/           extraction drafts awaiting ingestion
 *     library/          managed Markdown documents (the curated output)
 *     records/<id>/     per-document source, metadata, and record.json (text source of truth)
 *     CONCEPTS.md       generated concept index agents load while working
 *     schemas/          JSON schemas used by the skills
 *     store/            derived, rebuildable state: SQLite ledger, LadybugDB graph, models
 *
 * Everything except `store/` is plain text and can be committed; `index sync` rebuilds `store/` from it.
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

export function recordsPath(projectRoot: string): string {
  return join(workspacePath(projectRoot), "records");
}

export function conceptIndexPath(projectRoot: string): string {
  return join(workspacePath(projectRoot), "CONCEPTS.md");
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

/** Project-relative record directory recorded in the SQLite ledger. */
export function recordRelativePath(documentId: string): string {
  return `${WORKSPACE_DIRNAME}/records/${documentId}`;
}

/** Project-relative path of a managed document inside the library. */
export function libraryRelativePath(filePath: string): string {
  return `${WORKSPACE_DIRNAME}/library/${filePath}`;
}
