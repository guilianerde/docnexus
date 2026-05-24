import { cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireInitializedProject } from "./project.js";

type SkillsTarget = "codex" | "claude";
type SkillsScope = "project" | "user";

const SKILL_NAMES = ["docnexus-capture", "docnexus-recall"] as const;

export interface InstallSkillsInput {
  target: SkillsTarget;
  scope?: SkillsScope;
  projectRoot?: string;
  homeDir?: string;
  packagedSkillsRoot?: string;
}

export interface InstallSkillsOutput {
  target: SkillsTarget;
  scope: SkillsScope;
  destination: string;
  installed: readonly string[];
}

function bundledSkillsRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../skills");
}

export async function installSkills(input: InstallSkillsInput): Promise<InstallSkillsOutput> {
  if (input.target !== "codex" && input.target !== "claude") {
    throw new Error("target must be codex or claude");
  }
  const scope = input.scope ?? "project";
  if (scope !== "project" && scope !== "user") {
    throw new Error("scope must be project or user");
  }

  let destination: string;
  if (scope === "project") {
    if (!input.projectRoot) {
      throw new Error("project root is required for project-scoped skills");
    }
    const root = await requireInitializedProject(input.projectRoot);
    destination = join(root, input.target === "codex" ? ".agents" : ".claude", "skills");
  } else {
    destination = join(input.homeDir ?? homedir(), input.target === "codex" ? ".agents" : ".claude", "skills");
  }

  const source = input.packagedSkillsRoot ?? bundledSkillsRoot();
  await mkdir(destination, { recursive: true });
  for (const skill of SKILL_NAMES) {
    await cp(join(source, skill), join(destination, skill), { recursive: true, force: true });
  }
  return { target: input.target, scope, destination, installed: SKILL_NAMES };
}
