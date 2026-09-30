import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readlink, rm, stat, symlink } from "node:fs/promises";
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

export interface SyncSkillsOutput {
  destination: string;
  synced: readonly string[];
}

export interface LinkSkillsOutput {
  target: SkillsTarget;
  directory: string;
  linked: string[];
}

export interface SkillsState {
  installed: string[];
  missing: string[];
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

/** Copies the packaged skills into `docnexus/skills/`, replacing previous copies of the same skills. */
export async function syncSkills(projectRoot: string, packagedSkillsRoot = bundledSkillsRoot()): Promise<SyncSkillsOutput> {
  const destination = skillsPath(projectRoot);
  await mkdir(destination, { recursive: true });
  for (const skill of SKILL_NAMES) {
    await rm(join(destination, skill), { recursive: true, force: true });
    await cp(join(packagedSkillsRoot, skill), join(destination, skill), { recursive: true });
  }
  return { destination, synced: SKILL_NAMES };
}

/**
 * Exposes `docnexus/skills/<name>` to an agent by linking it from the agent's project skills directory.
 * The link is the only DocNexus entry outside `docnexus/`; the skill content itself stays in the workspace.
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
  return { target, directory, linked };
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
  return { installed, missing, links };
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
