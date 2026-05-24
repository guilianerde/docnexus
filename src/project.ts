import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ensureManagedStore, storePath } from "./managed-documents.js";

export const PROJECT_FORMAT_VERSION = 2;

interface ProjectMarker {
  format_version: number;
  initialized_at: string;
}

export interface InitializeProjectOutput {
  project_root: string;
  initialized: true;
  adopted_existing_store: boolean;
}

export function projectMarkerPath(projectRoot: string): string {
  return join(storePath(projectRoot), "project.json");
}

async function assertProjectDirectory(projectRoot: string): Promise<string> {
  const root = resolve(projectRoot);
  const info = await stat(root).catch(() => undefined);
  if (!info) {
    throw new Error(`project root does not exist: ${root}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`project root is not a directory: ${root}`);
  }
  return root;
}

async function readMarker(projectRoot: string): Promise<ProjectMarker | undefined> {
  const content = await readFile(projectMarkerPath(projectRoot), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (content === undefined) {
    return undefined;
  }
  const marker = JSON.parse(content) as Partial<ProjectMarker>;
  if (marker.format_version !== PROJECT_FORMAT_VERSION || typeof marker.initialized_at !== "string") {
    throw new Error(
      `unsupported DocNexus project format at ${projectMarkerPath(projectRoot)}; run "docnexus reset --force" and then "docnexus init"`
    );
  }
  return marker as ProjectMarker;
}

export async function requireInitializedProject(projectRoot: string): Promise<string> {
  const root = await assertProjectDirectory(projectRoot);
  if (!(await readMarker(root))) {
    throw new Error(`DocNexus project is not initialized: ${root}. Run "docnexus init" in that project first.`);
  }
  return root;
}

export async function initializeProject(projectRoot: string): Promise<InitializeProjectOutput> {
  const root = await assertProjectDirectory(projectRoot);
  const marker = await readMarker(root);
  if (marker) {
    return { project_root: root, initialized: true, adopted_existing_store: false };
  }
  const existingStore = await access(storePath(root)).then(() => true).catch(() => false);
  if (existingStore) {
    throw new Error(
      `uninitialized DocNexus data exists at ${storePath(root)}; run "docnexus reset --force" and then "docnexus init"`
    );
  }

  await mkdir(storePath(root), { recursive: true });
  await ensureManagedStore(root);
  await writeFile(
    projectMarkerPath(root),
    `${JSON.stringify({ format_version: PROJECT_FORMAT_VERSION, initialized_at: new Date().toISOString() }, null, 2)}\n`,
    { flag: "wx" }
  );
  return { project_root: root, initialized: true, adopted_existing_store: false };
}
