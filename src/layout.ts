import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DocNexusError } from "./errors.js";

export const PROJECT_FORMAT_VERSION = 7;
export const INTERNAL_DIRNAME = ".docnexus";
export const WORKSPACE_DIRNAME = "docnexus";
export const WORKSPACE_INSTALLATION_ENTRIES = ["package.json", "package-lock.json", "node_modules"];
const initializing = new AsyncLocalStorage<{ root: string; directory: string }>();

export function internalPath(projectRoot: string): string {
  return join(projectRoot, INTERNAL_DIRNAME);
}

export function projectMarkerPath(projectRoot: string): string {
  return join(internalPath(projectRoot), "project.json");
}

/** Output selects a parent within the project; knowledge always lives in its docnexus/ child. */
export function normalizeOutputDirectory(projectRoot: string, value: string): string {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f`]/.test(value) || value.includes("\\")) {
    throw new DocNexusError("invalid_params", "--output-dir requires a project-relative directory");
  }
  const path = relative(resolve(projectRoot), resolve(projectRoot, value));
  const first = path.split(sep)[0];
  if (isAbsolute(value) || first === ".." || [INTERNAL_DIRNAME, ".git", ".agents", ".claude", "node_modules"].includes(first)) {
    throw new DocNexusError("invalid_params", "--output-dir must be a parent directory inside the project, outside .docnexus and agent/runtime directories");
  }
  return path.split(sep).join("/") || ".";
}

export function workspaceDirectory(projectRoot: string): string {
  const pending = initializing.getStore();
  if (pending?.root === resolve(projectRoot)) return join(pending.directory, WORKSPACE_DIRNAME).split(sep).join("/");
  let text: string;
  try { text = readFileSync(projectMarkerPath(projectRoot), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return WORKSPACE_DIRNAME;
    throw error;
  }
  const marker = JSON.parse(text) as { format_version: number; output_dir: string };
  if (marker.format_version !== PROJECT_FORMAT_VERSION || typeof marker.output_dir !== "string") {
    throw new DocNexusError("unsupported_format", `unsupported DocNexus project format at ${projectMarkerPath(projectRoot)}; use a fresh project`);
  }
  return join(normalizeOutputDirectory(projectRoot, marker.output_dir), WORKSPACE_DIRNAME).split(sep).join("/");
}

/** Init preflight uses the proposed layout before persisting the project marker. */
export function withOutputDirectory<T>(root: string, directory: string, operation: () => Promise<T>): Promise<T> {
  return initializing.run({ root: resolve(root), directory }, operation);
}

export function workspacePath(projectRoot: string): string {
  return join(projectRoot, workspaceDirectory(projectRoot));
}

export function skillsPath(projectRoot: string): string {
  return join(internalPath(projectRoot), "skills");
}

export function draftsPath(projectRoot: string): string {
  return join(internalPath(projectRoot), "drafts");
}

export function libraryPath(projectRoot: string): string {
  return join(workspacePath(projectRoot), "library");
}

export function schemasPath(projectRoot: string): string {
  return join(internalPath(projectRoot), "schemas");
}

export function recordsPath(projectRoot: string): string {
  return join(workspacePath(projectRoot), "records");
}

export function conceptIndexPath(projectRoot: string): string {
  return join(workspacePath(projectRoot), "CONCEPTS.md");
}

export function conceptShardsPath(projectRoot: string): string {
  return join(workspacePath(projectRoot), "concepts");
}

export function recordRelativePath(documentId: string, projectRoot: string): string {
  return `${workspaceDirectory(projectRoot)}/records/${documentId}`;
}

export function libraryRelativePath(filePath: string, projectRoot?: string): string {
  return `${projectRoot ? workspaceDirectory(projectRoot) : WORKSPACE_DIRNAME}/library/${filePath}`;
}

/** Retrieval data is local and rebuildable; it never lives in the knowledge output. */
export function storePath(projectRoot: string): string {
  return join(internalPath(projectRoot), "store");
}

export function projectModelsPath(projectRoot: string): string {
  return join(storePath(projectRoot), "models");
}
