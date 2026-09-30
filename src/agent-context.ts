import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_DIRNAME } from "./layout.js";
import type { SkillsTarget } from "./skills.js";

const START = "<!-- docnexus:start -->";
const END = "<!-- docnexus:end -->";

export function agentContextFile(target: SkillsTarget): string {
  return target === "claude" ? "CLAUDE.md" : "AGENTS.md";
}

function block(target: SkillsTarget): string {
  // Claude Code expands `@path` imports in CLAUDE.md, so the concept index is loaded with the project context.
  const conceptIndex = target === "claude"
    ? `@${WORKSPACE_DIRNAME}/CONCEPTS.md`
    : `\`${WORKSPACE_DIRNAME}/CONCEPTS.md\` (read it at the start of each task)`;
  return [
    START,
    "## DocNexus project memory",
    "",
    `This project keeps curated memory in \`${WORKSPACE_DIRNAME}/\`. Concept index: ${conceptIndex}`,
    "",
    "- Before planning or changing code, check whether the task touches a concept in the index or a documented decision, component, or convention. If it does, use the `docnexus-recall` skill on your own and ground your work in what it returns.",
    "- When the task produces a decision or knowledge worth keeping, offer to capture it with the `docnexus` skill; never store it without the user's consent.",
    END
  ].join("\n");
}

/** Inserts or refreshes the DocNexus block in the agent's project instructions file. */
export async function installAgentContext(projectRoot: string, target: SkillsTarget): Promise<string> {
  const file = agentContextFile(target);
  const path = join(projectRoot, file);
  const current = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  const start = current.indexOf(START);
  const end = current.indexOf(END);
  const next = start >= 0 && end > start
    ? `${current.slice(0, start)}${block(target)}${current.slice(end + END.length)}`
    : `${current}${current.length === 0 || current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n"}${block(target)}\n`;
  if (next !== current) {
    await writeFile(path, next);
  }
  return file;
}

/** Removes the DocNexus block from both instruction files, leaving the rest untouched. */
export async function removeAgentContext(projectRoot: string): Promise<string[]> {
  const removed: string[] = [];
  for (const file of ["CLAUDE.md", "AGENTS.md"]) {
    const path = join(projectRoot, file);
    const current = await readFile(path, "utf8").catch(() => undefined);
    if (current === undefined) {
      continue;
    }
    const start = current.indexOf(START);
    const end = current.indexOf(END);
    if (start < 0 || end < start) {
      continue;
    }
    const before = current.slice(0, start).replace(/\n+$/, "");
    const after = current.slice(end + END.length).replace(/^\n+/, "");
    if (!before && !after) {
      await rm(path, { force: true });
    } else {
      await writeFile(path, `${[before, after].filter((part) => part.length > 0).join("\n\n")}\n`);
    }
    removed.push(file);
  }
  return removed;
}

export async function hasAgentContext(projectRoot: string, target: SkillsTarget): Promise<boolean> {
  const content = await readFile(join(projectRoot, agentContextFile(target)), "utf8").catch(() => "");
  return content.includes(START) && content.includes(END);
}
