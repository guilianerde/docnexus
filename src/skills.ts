import { existsSync, readFileSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { installAgentContext } from "./agent-context.js";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { skillsPath, WORKSPACE_DIRNAME } from "./layout.js";

export type SkillsTarget = "codex" | "claude";

export const SKILLS_TARGETS: readonly SkillsTarget[] = ["claude", "codex"];

/** `docnexus` is the entry skill; it routes every request to one of the workflow skills. */
export const SKILL_NAMES = [
  "docnexus",
  "docnexus-extract",
  "docnexus-ingest",
  "docnexus-recall",
  "docnexus-library",
  "docnexus-maintain"
] as const;

const VERSION_FILE = ".docnexus-skills.json";

export interface SyncSkillsOutput {
  destination: string;
  synced: readonly string[];
  version: string;
}

export interface LinkSkillsOutput {
  target: SkillsTarget;
  directory: string;
  linked: string[];
  context_file: string;
}

export interface SkillsState {
  installed: string[];
  missing: string[];
  version?: string;
  package_version: string;
  outdated: boolean;
  links: Record<SkillsTarget, { linked: string[]; missing: string[] }>;
}

export function bundledSkillsRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const compiledPath = resolve(moduleDirectory, "../../skills");
  return existsSync(join(compiledPath, SKILL_NAMES[0], "SKILL.md")) ? compiledPath : resolve(moduleDirectory, "../skills");
}

export function agentSkillsDirectory(projectRoot: string, target: SkillsTarget): string {
  return join(projectRoot, target === "codex" ? ".agents" : ".claude", "skills");
}

export function parseSkillsTargets(value: string | undefined): SkillsTarget[] {
  if (value === "all") {
    return [...SKILLS_TARGETS];
  }
  if (value === "codex" || value === "claude") {
    return [value];
  }
  throw new Error("target must be claude, codex, or all");
}

/** Version of the installed DocNexus package; skills synced from it carry the same stamp. */
export function packageVersion(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(moduleDirectory, "../../package.json"), resolve(moduleDirectory, "../package.json")]) {
    try {
      const manifest = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (manifest.name === "@rowansenne/docnexus" && manifest.version) {
        return manifest.version;
      }
    } catch {
      // Try the next layout.
    }
  }
  return "0.0.0";
}

async function readSkillsVersion(projectRoot: string): Promise<string | undefined> {
  try {
    return (JSON.parse(await readFile(join(skillsPath(projectRoot), VERSION_FILE), "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/** Re-syncs workspace skills when they are missing or were synced from another package version. */
export async function ensureSkillsCurrent(projectRoot: string): Promise<SyncSkillsOutput | undefined> {
  const state = await inspectSkills(projectRoot);
  return state.outdated || state.missing.length > 0 ? syncSkills(projectRoot) : undefined;
}

/** Copies the packaged skills into `docnexus/skills/`, replacing previous copies of the same skills. */
export async function syncSkills(projectRoot: string, packagedSkillsRoot = bundledSkillsRoot()): Promise<SyncSkillsOutput> {
  const destination = skillsPath(projectRoot);
  await mkdir(destination, { recursive: true });
  for (const skill of SKILL_NAMES) {
    await rm(join(destination, skill), { recursive: true, force: true });
    await cp(join(packagedSkillsRoot, skill), join(destination, skill), { recursive: true });
  }
  const version = packageVersion();
  await writeFile(join(destination, VERSION_FILE), `${JSON.stringify({ version }, null, 2)}\n`);
  return { destination, synced: SKILL_NAMES, version };
}

/**
 * Exposes `docnexus/skills/<name>` to an agent by linking it from the agent's project skills directory, and
 * adds a marked DocNexus block to the agent's instructions file (CLAUDE.md or AGENTS.md) so the agent loads
 * the concept index and recalls on its own. These are the only DocNexus entries outside `docnexus/`.
 */
export async function linkSkills(projectRoot: string, target: SkillsTarget): Promise<LinkSkillsOutput> {
  const directory = agentSkillsDirectory(projectRoot, target);
  await mkdir(directory, { recursive: true });
  const linked: string[] = [];
  for (const skill of SKILL_NAMES) {
    const source = join(skillsPath(projectRoot), skill);
    if (!(await stat(source).then((info) => info.isDirectory()).catch(() => false))) {
      throw new Error(`skill ${skill} is missing from ${WORKSPACE_DIRNAME}/skills; run "docnexus skills sync"`);
    }
    const linkPath = join(directory, skill);
    const existing = await lstat(linkPath).catch(() => undefined);
    if (existing && !existing.isSymbolicLink()) {
      throw new Error(`${linkPath} exists and is not a DocNexus skill link; remove it and retry`);
    }
    if (existing) {
      await rm(linkPath, { force: true });
    }
    if (process.platform === "win32") {
      await symlink(source, linkPath, "junction");
    } else {
      await symlink(relative(directory, source), linkPath, "dir");
    }
    linked.push(skill);
  }
  const contextFile = await installAgentContext(projectRoot, target);
  return { target, directory, linked, context_file: contextFile };
}

/** Removes agent links that point into this project's `docnexus/skills/`. Other entries are left untouched. */
export async function unlinkSkills(projectRoot: string): Promise<string[]> {
  const removed: string[] = [];
  for (const target of SKILLS_TARGETS) {
    const directory = agentSkillsDirectory(projectRoot, target);
    for (const skill of SKILL_NAMES) {
      const linkPath = join(directory, skill);
      if (await pointsIntoWorkspace(projectRoot, linkPath)) {
        await rm(linkPath, { force: true });
        removed.push(relative(projectRoot, linkPath).split("\\").join("/"));
      }
    }
  }
  return removed;
}

export async function inspectSkills(projectRoot: string): Promise<SkillsState> {
  const installed: string[] = [];
  const missing: string[] = [];
  for (const skill of SKILL_NAMES) {
    const present = await stat(join(skillsPath(projectRoot), skill, "SKILL.md")).then((info) => info.isFile()).catch(() => false);
    (present ? installed : missing).push(skill);
  }
  const links = {} as SkillsState["links"];
  for (const target of SKILLS_TARGETS) {
    const state = { linked: [] as string[], missing: [] as string[] };
    for (const skill of SKILL_NAMES) {
      const linkPath = join(agentSkillsDirectory(projectRoot, target), skill);
      (await pointsIntoWorkspace(projectRoot, linkPath) ? state.linked : state.missing).push(skill);
    }
    links[target] = state;
  }
  const version = await readSkillsVersion(projectRoot);
  const current = packageVersion();
  return { installed, missing, version, package_version: current, outdated: version !== current, links };
}

async function pointsIntoWorkspace(projectRoot: string, linkPath: string): Promise<boolean> {
  const info = await lstat(linkPath).catch(() => undefined);
  if (!info?.isSymbolicLink()) {
    return false;
  }
  const target = resolve(dirname(linkPath), await readlink(linkPath));
  const inside = relative(skillsPath(projectRoot), target);
  return inside.length > 0 && !inside.startsWith("..") && !inside.includes("/") && !inside.includes("\\");
}
