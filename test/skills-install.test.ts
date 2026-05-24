import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeProject } from "../src/project.js";
import { installSkills } from "../src/skills-install.js";

const roots: string[] = [];
const skillNames = [
  "docnexus-document-extract",
  "docnexus-document-add",
  "docnexus-document-delete",
  "docnexus-recall"
] as const;

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function makePackagedSkills(): Promise<string> {
  const root = await makeRoot("docnexus-skills-source-");
  for (const name of skillNames) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "SKILL.md"), `# ${name}\n`);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("installSkills", () => {
  it("packages skills that describe only the current managed document protocol", async () => {
    const extract = await readFile(join(process.cwd(), "skills", "docnexus-document-extract", "SKILL.md"), "utf8");
    const add = await readFile(join(process.cwd(), "skills", "docnexus-document-add", "SKILL.md"), "utf8");
    const remove = await readFile(join(process.cwd(), "skills", "docnexus-document-delete", "SKILL.md"), "utf8");
    const recall = await readFile(join(process.cwd(), "skills", "docnexus-recall", "SKILL.md"), "utf8");

    expect(extract).toContain("file_path");
    expect(extract).toContain("does not store or index");
    expect(extract).not.toContain("--source-file");
    expect(add).toContain("docnexus document add");
    expect(add).toContain("--replace");
    expect(add).toContain("confirm");
    expect(remove).toContain("docnexus document delete");
    expect(remove).toContain("--force");
    expect(recall).toContain("current managed document");
    expect(recall).not.toContain("linked to archived metadata");
  });

  it("installs the document workflow and recall skills into an initialized Codex project by default", async () => {
    const projectRoot = await makeRoot("docnexus-skills-project-");
    const source = await makePackagedSkills();
    await initializeProject(projectRoot);

    const result = await installSkills({ target: "codex", projectRoot, packagedSkillsRoot: source });

    expect(result.destination).toBe(join(projectRoot, ".agents", "skills"));
    expect(result.installed).toEqual(skillNames);
    await expect(readFile(join(result.destination, "docnexus-recall", "SKILL.md"), "utf8")).resolves.toContain("docnexus-recall");
  });

  it("installs Claude skills into the project-specific Claude directory", async () => {
    const projectRoot = await makeRoot("docnexus-skills-project-");
    const source = await makePackagedSkills();
    await initializeProject(projectRoot);

    const result = await installSkills({ target: "claude", projectRoot, packagedSkillsRoot: source });

    expect(result.destination).toBe(join(projectRoot, ".claude", "skills"));
  });

  it("allows user scope without an initialized project", async () => {
    const source = await makePackagedSkills();
    const home = await makeRoot("docnexus-skills-home-");

    const codex = await installSkills({ target: "codex", scope: "user", homeDir: home, packagedSkillsRoot: source });
    const claude = await installSkills({ target: "claude", scope: "user", homeDir: home, packagedSkillsRoot: source });

    expect(codex.destination).toBe(join(home, ".agents", "skills"));
    expect(claude.destination).toBe(join(home, ".claude", "skills"));
  });

  it("rejects project installation before initialization and invalid options", async () => {
    const root = await makeRoot("docnexus-skills-project-");
    const source = await makePackagedSkills();

    await expect(installSkills({ target: "codex", projectRoot: root, packagedSkillsRoot: source })).rejects.toThrow("Run \"docnexus init\"");
    await expect(installSkills({ target: "cursor" as never, scope: "user", packagedSkillsRoot: source })).rejects.toThrow("target must be codex or claude");
  });

  it("documents CLI mutations instead of MCP mutation tools", async () => {
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
    const readmeZh = await readFile(join(process.cwd(), "README.zh-CN.md"), "utf8");

    expect(readme).toContain("docnexus document add");
    expect(readmeZh).toContain("docnexus document add");
    expect(readme).not.toMatch(/\| `archive_record` \|/);
    expect(readmeZh).not.toMatch(/\| `archive_record` \|/);
    expect(readme).not.toMatch(/\| `delete_document` \|/);
    expect(readmeZh).not.toMatch(/\| `delete_document` \|/);
  });
});
