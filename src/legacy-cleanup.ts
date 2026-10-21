import { lstat, readdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { removeAgentContext } from "./agent-context.js";
import { INTERNAL_DIRNAME, PROJECT_FORMAT_VERSION, WORKSPACE_DIRNAME, WORKSPACE_INSTALLATION_ENTRIES } from "./layout.js";
import { agentSkillsDirectory, SKILL_NAMES, SKILLS_TARGETS } from "./skills.js";
import { assertNoSymbolicLinks } from "./workspace-io.js";

async function readJsonFile(path: string): Promise<Record<string, any> | undefined> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info?.isFile() || info.isSymbolicLink()) return undefined;
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
}

async function isLegacyDirectory(root: string, name: string): Promise<boolean> {
  const directory = join(root, name);
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info?.isDirectory() || info.isSymbolicLink()) return false;
  const marker = await readJsonFile(join(directory, "project.json"));
  if (marker) {
    return Number.isInteger(marker.format_version) && marker.format_version >= 1 && marker.format_version < PROJECT_FORMAT_VERSION
      && typeof marker.initialized_at === "string" && marker.initialized_at.length > 0;
  }
  // A pre-init legacy npm installation has no project marker yet. The new internal installation must remain.
  if (name !== WORKSPACE_DIRNAME || await lstat(join(directory, "project.json")).catch(() => undefined)) return false;
  const manifest = await readJsonFile(join(directory, "package.json"));
  const dependency = manifest?.dependencies?.["@rowansenne/docnexus"] ?? manifest?.devDependencies?.["@rowansenne/docnexus"];
  const entries = await readdir(directory);
  return typeof dependency === "string" && dependency.trim().length > 0
    && entries.every(entry => WORKSPACE_INSTALLATION_ENTRIES.includes(entry) || entry === ".gitignore");
}

async function removeLegacyLinks(root: string, directories: string[]): Promise<void> {
  for (const target of SKILLS_TARGETS) {
    const directory = agentSkillsDirectory(root, target);
    try { await assertNoSymbolicLinks(root, relative(root, directory)); }
    catch (error) { if (String(error).includes("symbolic links")) continue; throw error; }
    for (const skill of SKILL_NAMES) {
      const path = join(directory, skill);
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!info?.isSymbolicLink()) continue;
      const destination = resolve(directory, await readlink(path));
      if (basename(destination) !== skill || basename(dirname(destination)) !== "skills") continue;
      const workspace = await realpath(dirname(dirname(destination))).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (directories.some(name => workspace === join(root, name))) await rm(path, { force: true });
    }
  }
}

/** Destructive format transition, run only by the package installation hook. */
export async function cleanupLegacyProject(projectRoot: string): Promise<string[]> {
  const root = await realpath(projectRoot);
  const directories: string[] = [];
  for (const name of [WORKSPACE_DIRNAME, INTERNAL_DIRNAME]) {
    if (await isLegacyDirectory(root, name)) directories.push(name);
  }
  if (!directories.length) return [];
  const marker = await readJsonFile(join(root, INTERNAL_DIRNAME, "project.json"));
  if (marker?.format_version !== PROJECT_FORMAT_VERSION) {
    for (const file of ["AGENTS.md", "CLAUDE.md"]) await assertNoSymbolicLinks(root, file);
  }
  await removeLegacyLinks(root, directories);
  if (marker?.format_version !== PROJECT_FORMAT_VERSION) await removeAgentContext(root);
  for (const name of directories) {
    const directory = join(root, name);
    if (name === INTERNAL_DIRNAME) {
      // npm is currently installing inside node_modules; removing it would delete the new version itself.
      for (const entry of await readdir(directory)) {
        if (!WORKSPACE_INSTALLATION_ENTRIES.includes(entry)) await rm(join(directory, entry), { recursive: true, force: true });
      }
    } else await rm(directory, { recursive: true, force: true });
  }
  return directories;
}

/** Resolve the consuming project from the installed package location, never from the caller's CWD. */
export function installationProjectRoot(packageRoot: string): string | undefined {
  const modules = dirname(dirname(packageRoot));
  if (basename(modules) !== "node_modules") return undefined;
  const installation = dirname(modules);
  // A transitive dependency or npm's temporary npx cache is not a project installation.
  if (installation.split(sep).some(segment => segment === "node_modules" || segment === "_npx")) return undefined;
  if (basename(installation) === WORKSPACE_DIRNAME) {
    throw new Error("Install this breaking release with npm install --prefix ./.docnexus --save-exact @rowansenne/docnexus; the old docnexus/ installation path is unsupported. No files were deleted.");
  }
  return basename(installation) === INTERNAL_DIRNAME ? dirname(installation) : installation;
}
