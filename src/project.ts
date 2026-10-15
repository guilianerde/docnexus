import { DocNexusError } from "./errors.js";
import { withProjectLock } from "./project-lock.js";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeConceptIndex } from "./concepts.js";
import { draftsPath, libraryPath, projectMarkerPath, WORKSPACE_DIRNAME, WORKSPACE_INSTALLATION_ENTRIES, workspacePath } from "./layout.js";
import { ensureIgnoredEntries } from "./workspace-io.js";
import { assertNoSymbolicLinks, ensureManagedWorkspace } from "./managed-documents.js";
import { type LinkSkillsOutput, linkSkills, type SkillsTarget, syncSkills } from "./skills.js";

export { projectMarkerPath };

export const PROJECT_FORMAT_VERSION = 6;

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
    throw new DocNexusError("project_not_found", `project root does not exist: ${root}`);
  }
  if (!info.isDirectory()) {
    throw new DocNexusError("unsupported_format", `project root is not a directory: ${root}`);
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
    throw new DocNexusError("unsupported_format",
      `unsupported DocNexus project format at ${projectMarkerPath(projectRoot)}; run "docnexus reset --force" and then "docnexus init"`
    );
  }
  return marker as ProjectMarker;
}

export async function requireInitializedProject(projectRoot: string): Promise<string> {
  return withProjectLock(projectRoot, async () => {
    const root = await assertProjectDirectory(projectRoot);
    await assertNoSymbolicLinks(root, WORKSPACE_DIRNAME);
    if (!(await readMarker(root))) {
      throw new DocNexusError("project_not_initialized", `DocNexus project is not initialized: ${root}. Run "docnexus init" in that project first.`);
    }
    return root;
  });
}

/**
 * Creates the `docnexus/` workspace (skills, drafts, library, records) and optionally links the skills
 * into agent directories. Re-running on an initialized project refreshes skills and links only.
 */
export async function initializeProject(
  projectRoot: string,
  input: InitializeProjectInput = {}
): Promise<InitializeProjectOutput> {
  return withProjectLock(projectRoot, async () => {
    const root = await assertProjectDirectory(projectRoot);
    await assertNoSymbolicLinks(root, WORKSPACE_DIRNAME);
    const marker = await readMarker(root);
    if (!marker) {
      const entries = await readdir(workspacePath(root)).catch(() => []);
      if (entries.length > 0 && !(await isInstallationOnly(root, entries))) {
        throw new DocNexusError("unsupported_format",
          `${workspacePath(root)} already exists and is not a DocNexus workspace; move it before running "docnexus init"`
        );
      }
      await mkdir(workspacePath(root), { recursive: true });
      await mkdir(draftsPath(root), { recursive: true });
      await mkdir(libraryPath(root), { recursive: true });
      await ensureManagedWorkspace(root);
      await writeFile(workspaceReadmePath(root), WORKSPACE_README);
    } else {
      // A clone already carries all memory; only empty directories may need recreating.
      await mkdir(draftsPath(root), { recursive: true });
      await ensureManagedWorkspace(root);
    }
    await ensureIgnoredEntries(root, ["node_modules/", "store/", ".runtime/"]);
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
  });
}

async function isInstallationOnly(projectRoot: string, entries: string[]): Promise<boolean> {
  if (entries.some(entry => !WORKSPACE_INSTALLATION_ENTRIES.includes(entry) && entry !== ".gitignore")) return false;
  try {
    const manifest = JSON.parse(await readFile(resolve(workspacePath(projectRoot), "package.json"), "utf8"));
    const dependency = manifest?.dependencies?.["@rowansenne/docnexus"] ?? manifest?.devDependencies?.["@rowansenne/docnexus"];
    return typeof dependency === "string" && dependency.trim().length > 0;
  } catch { return false; }
}

function workspaceReadmePath(projectRoot: string): string {
  return resolve(workspacePath(projectRoot), "README.md");
}

const WORKSPACE_README = `# ${WORKSPACE_DIRNAME}/

DocNexus project workspace. Everything DocNexus owns for this project lives here.

| Path | Purpose |
| --- | --- |
| \`package.json\`, \`package-lock.json\` | Isolated DocNexus npm manifest and lockfile. |
| \`node_modules/\` | Reinstallable npm runtime, ignored by Git. |
| \`skills/\` | Project skills. Start from \`skills/docnexus/SKILL.md\`. |
| \`drafts/\` | Extraction drafts; \`manifest.json\` marks a sealed draft. |
| \`library/\` | Author-owned Markdown and fact references with generated read-only fact blocks. Adopt authored edits with \`docnexus document sync\`. |
| \`records/\` | Per-document source, metadata, timeline, and \`record.json\`; the text source of truth. |
| \`CONCEPTS.md\` | Generated concept index that agents load while working. |
| \`schemas/\` | Metadata JSON schema used by the skills. |
| \`store/\` | Rebuildable PostgreSQL/PGLite retrieval projections and optional local model overrides. |
| \`.runtime/\` | Pending text transaction recovery journal; do not delete during recovery. |

Everything except \`node_modules/\`, \`store/\` and \`.runtime/\` is plain text and can be committed. Restore the runtime with \`npm ci --prefix ./docnexus\` from the project root. CLI access takes the local project lock and recovers pending text transactions first.
Run \`./docnexus/node_modules/.bin/docnexus index sync\` after a Git pull; default hybrid recall also syncs automatically. Avoid Git changes and external edits during writes or pending recovery.
Entity aliases and optional facts track identity, provenance and effective validity. Run \`docnexus facts list --include-inactive\` to inspect fact history.
Define a fact only in its owner's metadata; reference it on a standalone \`{{fact:fact_id}}\` line. The CLI renders attributed current values and updates dependent pages. Use \`document get --include template,metadata\` for the editable structure and \`document render\` to refresh all views; there is no background timer.
The model running skills chooses project-defined \`metadata.category\` names and \`category_reason\` from project context and existing documents. Use \`document classify --id <id> --category <name> --reason <basis>\` for category-only adjustments. \`document query\` derives current Markdown, used-category counts and revision from text without another stored document source.

Run \`./docnexus/node_modules/.bin/docnexus status\` from the project root for an overview. Legacy root installations may use \`./node_modules/.bin/docnexus\`. Reset removes knowledge and integration but preserves the npm installation.
`;
