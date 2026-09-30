import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeProject } from "../src/project.js";
import { inspectSkills, linkSkills, SKILL_NAMES, syncSkills } from "../src/skills.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-skills-"));
  roots.push(root);
  return root;
}

async function readSkill(name: string): Promise<string> {
  return readFile(join(process.cwd(), "skills", name, "SKILL.md"), "utf8");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("packaged skills", () => {
  it("ships every orchestrated skill with matching frontmatter", async () => {
    for (const name of SKILL_NAMES) {
      const content = await readSkill(name);
      expect(content.startsWith(`---\nname: ${name}\ndescription: `)).toBe(true);
      expect(content).not.toContain(".docnexus");
    }
  });

  it("routes every workflow from the entry skill", async () => {
    const entry = await readSkill("docnexus");
    for (const name of SKILL_NAMES.filter((value) => value !== "docnexus")) {
      expect(entry).toContain(`\`${name}\``);
    }
    expect(entry).toContain("Capture pipeline");
    expect(entry).toContain("docnexus status");
  });

  it("describes the draft pipeline contract", async () => {
    const extract = await readSkill("docnexus-extract");
    const ingest = await readSkill("docnexus-ingest");
    const library = await readSkill("docnexus-library");
    const maintain = await readSkill("docnexus-maintain");

    expect(extract).toContain("docnexus draft new");
    expect(extract).toContain("docnexus draft seal --id <draft_id> --file <file_path>");
    expect(extract).toContain("result: draft_ready");
    expect(extract).toContain("Never run `docnexus document add` here");
    expect(ingest).toContain("docnexus document add --draft <draft_id>");
    expect(ingest).toContain("--replace");
    expect(library).toContain("docnexus document delete --id <document_id> --force");
    expect(library).toContain("docnexus draft discard --id <draft_id> --force");
    expect(maintain).toContain("docnexus reset --force");
  });
});

describe("skills sync and link", () => {
  it("links workspace skills into agent directories and reports their state", async () => {
    const root = await makeRoot();
    await initializeProject(root);

    expect((await inspectSkills(root)).links.claude.linked).toEqual([]);
    const result = await linkSkills(root, "codex");

    expect(result.directory).toBe(join(root, ".agents", "skills"));
    expect(result.linked).toEqual([...SKILL_NAMES]);
    expect((await lstat(join(root, ".agents", "skills", "docnexus"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(root, ".agents", "skills", "docnexus"))).toBe(join("..", "..", "docnexus", "skills", "docnexus"));
    await expect(readFile(join(root, ".agents", "skills", "docnexus-ingest", "SKILL.md"), "utf8")).resolves.toContain("docnexus-ingest");
    const state = await inspectSkills(root);
    expect(state).toMatchObject({ installed: [...SKILL_NAMES], missing: [] });
    expect(state.links.codex.missing).toEqual([]);

    await expect(linkSkills(root, "codex")).resolves.toMatchObject({ linked: [...SKILL_NAMES] });
  });

  it("refuses to replace a real directory and requires synced skills", async () => {
    const root = await makeRoot();
    await initializeProject(root);
    await mkdir(join(root, ".claude", "skills", "docnexus-recall"), { recursive: true });
    await writeFile(join(root, ".claude", "skills", "docnexus-recall", "SKILL.md"), "old copy");

    await expect(linkSkills(root, "claude")).rejects.toThrow("is not a DocNexus skill link");

    await rm(join(root, "docnexus", "skills", "docnexus-maintain"), { recursive: true });
    await expect(linkSkills(root, "codex")).rejects.toThrow("docnexus skills sync");
    expect((await inspectSkills(root)).missing).toEqual(["docnexus-maintain"]);
    await syncSkills(root);
    expect((await inspectSkills(root)).missing).toEqual([]);
  });
});
