import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeConceptIndex } from "./concepts.js";
import { draftsPath, libraryPath, projectMarkerPath, WORKSPACE_DIRNAME, workspacePath } from "./layout.js";
import { ensureManagedStore } from "./managed-documents.js";
import { type LinkSkillsOutput, linkSkills, type SkillsTarget, syncSkills } from "./skills.js";

export { projectMarkerPath };

export const PROJECT_FORMAT_VERSION = 5;

interface ProjectMarker {
  format_version: number;
  initialized_at: string;
}

export interface InitializeProjectInput {
  agents?: SkillsTarget[];
  packagedSkillsRoot?: string;
}

export interface InitializeProjectOutput {
  project_root: string;
  workspace: string;
  initialized: true;
  created: boolean;
  skills: readonly string[];
  links: LinkSkillsOutput[];
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

/**
 * Creates the `docnexus/` workspace (skills, drafts, library, store) and optionally links the skills
 * into agent directories. Re-running on an initialized project refreshes skills and links only.
 */
export async function initializeProject(
  projectRoot: string,
  input: InitializeProjectInput = {}
): Promise<InitializeProjectOutput> {
  const root = await assertProjectDirectory(projectRoot);
  const marker = await readMarker(root);
  if (!marker) {
    const entries = await readdir(workspacePath(root)).catch(() => []);
    if (entries.length > 0) {
      throw new Error(
        `${workspacePath(root)} already exists and is not a DocNexus workspace; move it before running "docnexus init"`
      );
    }
    await mkdir(workspacePath(root), { recursive: true });
    await mkdir(draftsPath(root), { recursive: true });
    await mkdir(libraryPath(root), { recursive: true });
    await ensureManagedStore(root);
    await writeFile(workspaceReadmePath(root), WORKSPACE_README);
    await writeFile(resolve(workspacePath(root), ".gitignore"), "store/\n");
  } else {
    // A cloned workspace carries text files only; recreate the derived store and empty folders.
    await mkdir(draftsPath(root), { recursive: true });
    await ensureManagedStore(root);
  }
  await writeConceptIndex(root);

  const skills = await syncSkills(root, input.packagedSkillsRoot);
  const links: LinkSkillsOutput[] = [];
  for (const agent of input.agents ?? []) {
    links.push(await linkSkills(root, agent));
  }

  if (!marker) {
    await writeFile(
      projectMarkerPath(root),
      `${JSON.stringify({ format_version: PROJECT_FORMAT_VERSION, initialized_at: new Date().toISOString() }, null, 2)}\n`,
      { flag: "wx" }
    );
  }
  return { project_root: root, workspace: workspacePath(root), initialized: true, created: !marker, skills: skills.synced, links };
}

function workspaceReadmePath(projectRoot: string): string {
  return resolve(workspacePath(projectRoot), "README.md");
}

const WORKSPACE_README = `# ${WORKSPACE_DIRNAME}/

DocNexus project workspace. Everything DocNexus owns for this project lives here.

| Path | Purpose |
| --- | --- |
| \`skills/\` | Project skills. Start from \`skills/docnexus/SKILL.md\`. |
| \`drafts/\` | Extraction drafts; \`manifest.json\` marks a sealed draft. |
| \`library/\` | Managed Markdown documents. You may edit them; adopt edits with \`docnexus document sync\`. |
| \`records/\` | Per-document source, metadata, and \`record.json\`; the text source of truth. |
| \`CONCEPTS.md\` | Generated concept index that agents load while working. |
| \`schemas/\` | Metadata JSON schema used by the skills. |
| \`store/\` | Derived state (SQLite, LadybugDB graph, optional models). Safe to ignore in Git. |

Everything except \`store/\` is plain text and can be committed. After cloning or pulling, run
\`./node_modules/.bin/docnexus index sync\` to rebuild \`store/\` from the text files.

Run \`./node_modules/.bin/docnexus status\` for an overview.
`;
