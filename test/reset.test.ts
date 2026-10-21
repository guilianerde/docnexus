import { access, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { upsertManagedDocument } from "../src/managed-documents.js";
import { initializeProject } from "../src/project.js";
import { resetProjectData } from "../src/reset.js";

const roots: string[] = [];
const metadata = {
  title: "Reset",
  summary: "Reset current managed state.",
  tags: ["reset"],
  entities: [{ name: "Reset", type: "tool" as const, description: "The command that removes managed state." }],
  relationships: []
};

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-reset-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("reset", () => {
  it("rejects reset unless force is supplied", async () => {
    const root = await makeRoot();
    await initializeProject(root);
    await expect(resetProjectData(root, { force: false })).rejects.toThrow("--force");
    await expect(access(join(root, "docnexus"))).resolves.toBeUndefined();
  });

  it("removes the whole workspace and only the skill links pointing into it", async () => {
    const root = await makeRoot();
    await initializeProject(root, { agents: ["claude"] });
    await upsertManagedDocument(
      root,
      { file_path: "docs/memory/a.md", source: "raw", document: "# A", metadata }
    );
    await mkdir(join(root, ".claude", "skills", "other-skill"), { recursive: true });
    await writeFile(join(root, ".claude", "skills", "other-skill", "SKILL.md"), "keep");

    const result = await resetProjectData(root, { force: true });

    expect(result.removed_workspace).toBe(join(root, "docnexus"));
    expect(result.removed_links).toContain(".claude/skills/docnexus");
    await expect(access(join(root, "docnexus"))).rejects.toThrow();
    await expect(lstat(join(root, ".claude", "skills", "docnexus"))).rejects.toThrow();
    await expect(readFile(join(root, ".claude", "skills", "other-skill", "SKILL.md"), "utf8")).resolves.toBe("keep");
  });

  it("refuses to delete a docnexus folder without a project marker", async () => {
    const root = await makeRoot();
    await expect(resetProjectData(root, { force: true })).rejects.toThrow("no DocNexus workspace");
    await mkdir(join(root, "docnexus"), { recursive: true });
    await writeFile(join(root, "docnexus", "notes.md"), "user content");

    await expect(resetProjectData(root, { force: true })).rejects.toThrow("no DocNexus project marker");
    await expect(readFile(join(root, "docnexus", "notes.md"), "utf8")).resolves.toBe("user content");
  });

  it("preserves a workspace npm installation and host manifests so reset can be followed by init", async () => {
    const root = await makeRoot();
    await initializeProject(root, { agents: ["codex"] });
    const directory = join(root, ".docnexus");
    await mkdir(join(directory, "node_modules"));
    const files = new Map([
      [join(root, "package.json"), '{"name":"host"}'],
      [join(root, "package-lock.json"), "host lock"],
      [join(directory, "package.json"), '{"dependencies":{"@rowansenne/docnexus":"0.16.0"}}'],
      [join(directory, "package-lock.json"), "runtime lock"],
      [join(directory, "node_modules", "keep"), "runtime"]
    ]);
    for (const [path, value] of files) await writeFile(path, value);
    await upsertManagedDocument(root, { file_path: "a.md", source: "raw", document: "# A", metadata });
    expect(await resetProjectData(root, { force: true })).toMatchObject({ preserved_installation: true });
    expect((await readdir(directory)).sort()).toEqual([".gitignore", "node_modules", "package-lock.json", "package.json"]);
    expect(await readFile(join(directory, ".gitignore"), "utf8")).toContain("node_modules/");
    for (const [path, value] of files) expect(await readFile(path, "utf8")).toBe(value);
    await expect(lstat(join(root, ".agents", "skills", "docnexus"))).rejects.toThrow();
    await expect(initializeProject(root, { agents: ["codex"] })).resolves.toMatchObject({ created: true });
    expect(await readdir(join(root, "docnexus", "records"))).toEqual([]);
  });

});
