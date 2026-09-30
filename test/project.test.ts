import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeProject,
  projectMarkerPath,
  requireInitializedProject
} from "../src/project.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-project-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project initialization", () => {
  it("creates the docnexus workspace with skills, drafts, library, schemas, and store", async () => {
    const root = await makeRoot();

    const result = await initializeProject(root);
    const marker = JSON.parse(await readFile(projectMarkerPath(root), "utf8"));

    expect(result).toMatchObject({ project_root: root, workspace: join(root, "docnexus"), initialized: true, created: true });
    expect(result.skills).toContain("docnexus");
    expect(marker).toMatchObject({ format_version: 4, initialized_at: expect.any(String) });
    expect(projectMarkerPath(root)).toBe(join(root, "docnexus", "project.json"));
    for (const path of ["skills/docnexus/SKILL.md", "drafts", "library", "schemas/metadata.schema.json", "store/index.sqlite", "README.md"]) {
      await expect(stat(join(root, "docnexus", path))).resolves.toBeDefined();
    }
    await expect(stat(join(root, ".docnexus"))).rejects.toThrow();

    const db = new DatabaseSync(join(root, "docnexus", "store", "index.sqlite"));
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    db.close();
    expect(tables).toEqual(["documents", "file_chunks"]);
  });

  it("is idempotent, preserves data, and refreshes skills", async () => {
    const root = await makeRoot();
    await initializeProject(root);
    const sentinel = join(root, "docnexus", "library", "keep.md");
    await writeFile(sentinel, "existing data");
    await writeFile(join(root, "docnexus", "skills", "docnexus", "SKILL.md"), "stale");
    const before = await readFile(projectMarkerPath(root), "utf8");

    await expect(initializeProject(root)).resolves.toMatchObject({ created: false });

    await expect(readFile(sentinel, "utf8")).resolves.toBe("existing data");
    await expect(readFile(projectMarkerPath(root), "utf8")).resolves.toBe(before);
    await expect(readFile(join(root, "docnexus", "skills", "docnexus", "SKILL.md"), "utf8")).resolves.toContain("name: docnexus");
  });

  it("refuses to adopt an unrelated docnexus folder", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "docnexus"), { recursive: true });
    await writeFile(join(root, "docnexus", "notes.md"), "user content");

    await expect(initializeProject(root)).rejects.toThrow("is not a DocNexus workspace");
    await expect(readFile(join(root, "docnexus", "notes.md"), "utf8")).resolves.toBe("user content");
    await expect(readFile(projectMarkerPath(root), "utf8")).rejects.toThrow();
  });

  it("rejects unsupported markers and non-existent project roots", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "docnexus"), { recursive: true });
    await writeFile(projectMarkerPath(root), JSON.stringify({ format_version: 3, initialized_at: "x" }));

    await expect(requireInitializedProject(root)).rejects.toThrow("unsupported DocNexus project format");
    await expect(initializeProject(join(root, "missing"))).rejects.toThrow("project root does not exist");
  });
});
