import { DocNexusError } from "./errors.js";
import { withProjectLock } from "./project-lock.js";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeConceptIndex } from "./concepts.js";
import { ensureCategoryGuide } from "./category-guide.js";
import { draftsPath, PROJECT_FORMAT_VERSION, internalPath, INTERNAL_DIRNAME, libraryPath, normalizeOutputDirectory, projectMarkerPath, WORKSPACE_DIRNAME, WORKSPACE_INSTALLATION_ENTRIES, workspaceDirectory, workspacePath, withOutputDirectory } from "./layout.js";
import { atomicWrite, ensureIgnoredEntries, readIfExists } from "./workspace-io.js";
import { assertNoSymbolicLinks, ensureManagedWorkspace } from "./managed-documents.js";
import { type LinkSkillsOutput, linkSkills, type SkillsTarget, syncSkills } from "./skills.js";
import { assertWorkspaceRepository, configureWorkspaceGit, prepareWorkspaceGit } from "./workspace-git.js";

export { projectMarkerPath, PROJECT_FORMAT_VERSION };

interface ProjectMarker {
  format_version: number;
  initialized_at: string;
  output_dir: string;
}

export interface InitializeProjectInput {
  agents?: SkillsTarget[];
  packagedSkillsRoot?: string;
  gitRemote?: string;
  outputDir?: string;
}

export interface InitializeProjectOutput {
  project_root: string;
  workspace: string;
  internal_directory: string;
  initialized: true;
  created: boolean;
  skills: readonly string[];
  links: LinkSkillsOutput[];
  git?: { repository: string; remote: string; branch: string };
}

async function assertProjectDirectory(projectRoot: string): Promise<string> {
  const root = resolve(projectRoot);
  const info = await stat(root).catch(() => undefined);
  if (!info) throw new DocNexusError("project_not_found", `project root does not exist: ${root}`);
  if (!info.isDirectory()) throw new DocNexusError("unsupported_format", `project root is not a directory: ${root}`);
  return root;
}

async function readMarker(root: string): Promise<ProjectMarker | undefined> {
  await assertNoSymbolicLinks(root, join(INTERNAL_DIRNAME, "project.json"));
  const content = await readFile(projectMarkerPath(root), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (content === undefined) {
    if (await stat(join(root, WORKSPACE_DIRNAME, "project.json")).catch(() => undefined)) {
      throw new DocNexusError("unsupported_format", "Legacy DocNexus workspaces are unsupported; reinstall this release under .docnexus with npm lifecycle scripts enabled to delete legacy data. No migration is provided.");
    }
    return undefined;
  }
  const marker = JSON.parse(content) as Partial<ProjectMarker>;
  if (marker.format_version !== PROJECT_FORMAT_VERSION || typeof marker.initialized_at !== "string" || typeof marker.output_dir !== "string") {
    throw new DocNexusError("unsupported_format", `unsupported DocNexus project format at ${projectMarkerPath(root)}; use a fresh project`);
  }
  normalizeOutputDirectory(root, marker.output_dir);
  return marker as ProjectMarker;
}

export async function requireInitializedProject(projectRoot: string): Promise<string> {
  return withProjectLock(projectRoot, async () => {
    const root = await assertProjectDirectory(projectRoot);
    if (!(await readMarker(root))) {
      throw new DocNexusError("project_not_initialized", `DocNexus project is not initialized: ${root}. Run "docnexus init" in that project first.`);
    }
    await assertNoSymbolicLinks(root, workspaceDirectory(root));
    return root;
  });
}

/** Internal package assets and local state stay separate from the configurable knowledge output. */
export async function initializeProject(projectRoot: string, input: InitializeProjectInput = {}): Promise<InitializeProjectOutput> {
  return withProjectLock(projectRoot, async () => {
    const root = await assertProjectDirectory(projectRoot);
    const marker = await readMarker(root);
    const outputDir = normalizeOutputDirectory(root, input.outputDir ?? marker?.output_dir ?? ".");
    if (marker && outputDir !== marker.output_dir) {
      throw new DocNexusError("invalid_params", "--output-dir cannot change an initialized workspace; reset it explicitly or use a fresh project");
    }
    return withOutputDirectory(root, outputDir, async () => {
      await assertNoSymbolicLinks(root, workspaceDirectory(root));
      const gitPlan = input.gitRemote === undefined ? undefined : await prepareWorkspaceGit(root, input.gitRemote);
      if (!marker) {
        const internalEntries = await readdir(internalPath(root)).catch(() => []);
        if (internalEntries.length && !(await isInstallationOnly(root, internalEntries))) {
          throw new DocNexusError("unsupported_format", `${internalPath(root)} already exists and is not a DocNexus installation`);
        }
        const entries: string[] = await readdir(workspacePath(root)).catch(() => []);
        if (entries.includes(".git")) await assertWorkspaceRepository(root);
        const gitOnly = entries.includes(".git") && entries.every(entry => [".git", ".gitignore"].includes(entry));
        if (entries.length && !gitOnly) {
          throw new DocNexusError("unsupported_format", `${workspacePath(root)} already exists and is not a DocNexus workspace; choose an output parent with an empty docnexus/ directory`);
        }
        await atomicWrite(projectMarkerPath(root), `${JSON.stringify({ format_version: PROJECT_FORMAT_VERSION, initialized_at: new Date().toISOString(), output_dir: outputDir }, null, 2)}\n`);
      }
      await mkdir(workspacePath(root), { recursive: true });
      await mkdir(draftsPath(root), { recursive: true });
      await mkdir(libraryPath(root), { recursive: true });
      await ensureManagedWorkspace(root);
      await ensureCategoryGuide(root);
      await writeFile(join(workspacePath(root), "README.md"), WORKSPACE_README);
      // Keep canonical text and hashes stable when cloning knowledge on Windows.
      await assertNoSymbolicLinks(root, join(workspaceDirectory(root), ".gitattributes"));
      const attributesPath = join(workspacePath(root), ".gitattributes");
      const attributes = await readIfExists(attributesPath) ?? "";
      if (!attributes.split(/\r?\n/).includes("* text=auto eol=lf")) {
        await atomicWrite(attributesPath, `${attributes}${attributes && !attributes.endsWith("\n") ? "\n" : ""}* text=auto eol=lf\n`);
      }
      await ensureIgnoredEntries(root, ["node_modules/", "store/", ".runtime/", "drafts/"]);
      await writeConceptIndex(root);
      const skills = await syncSkills(root, input.packagedSkillsRoot);
      const links: LinkSkillsOutput[] = [];
      for (const agent of input.agents ?? []) links.push(await linkSkills(root, agent));
      const git = gitPlan ? await configureWorkspaceGit(gitPlan) : undefined;
      return { project_root: root, workspace: workspacePath(root), internal_directory: internalPath(root), initialized: true, created: !marker, skills: skills.synced, links, ...(git ? { git } : {}) };
    });
  });
}

async function isInstallationOnly(root: string, entries: string[]): Promise<boolean> {
  if (entries.some(entry => !WORKSPACE_INSTALLATION_ENTRIES.includes(entry) && entry !== ".gitignore")) return false;
  try {
    const manifest = JSON.parse(await readFile(join(internalPath(root), "package.json"), "utf8"));
    const dependency = manifest?.dependencies?.["@rowansenne/docnexus"] ?? manifest?.devDependencies?.["@rowansenne/docnexus"];
    return typeof dependency === "string" && dependency.trim().length > 0;
  } catch { return false; }
}

const WORKSPACE_README = `# DocNexus knowledge workspace

The knowledge workspace is always <output_dir>/docnexus/; output_dir defaults to the project root. This workspace contains library/ (current Markdown), records/ (sources, metadata and timelines), impacts/ (related-page review records), categories.md (editable starter category suggestions) and CONCEPTS.md plus concepts/ (generated readable navigation). Commit and back up these files together with .docnexus/project.json at the project root.

The project's .docnexus/ directory holds its npm installation, skills/, schemas/, drafts/, store/ and .runtime/. Install with npm install --prefix ./.docnexus --save-exact @rowansenne/docnexus. Run ./.docnexus/node_modules/.bin/docnexus from the project root; use --project-root when working elsewhere. After cloning, run npm ci --prefix ./.docnexus and init --agent codex (or claude/all) to restore skills and schema. Retrieval indexes are rebuilt by recall or index sync.

Use status to inspect configured paths. Edit library Markdown and adopt edits with document sync. Never edit generated fact blocks or navigation. Keep source records intact. CLI writes use a project lock and durable recovery; do not Git pull, switch branches or edit managed files during writes or pending recovery.

Optional init --git-remote configures this knowledge directory as a separate repository pinned to one local branch. No command synchronizes remotes automatically. Keep .docnexus/project.json and npm manifests separately if using a knowledge-only repository. Reset deletes the knowledge output and local state but preserves the .docnexus npm installation and the knowledge repository's .git metadata.

Optional git hooks install enables local automatic recovery for ordinary merge conflicts. Resolve and stage library, metadata, source and timeline using Git or your editor; leave record hashes to DocNexus. Wait for the synced/staged message, review the diff and commit. Code-only commits skip knowledge validation; ordinary knowledge edits check affected units and required semantic dependencies. The pre-commit hook reuses the verified index checkpoint for repaired merges. git hooks uninstall restores prior native hooks; clones need local installation. Current hook scripts resolve project-relative paths and Node from PATH; reinstall once to update old absolute-path scripts. Missing runtimes warn on capture and block knowledge commits with installation guidance, leaving code-only commits available. Custom hook managers require explicit integration. Do not discard a pending text journal to bypass a failed repair.
`;
