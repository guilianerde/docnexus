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
  it("initializes a project with a versioned marker and store layout", async () => {
    const root = await makeRoot();

    const result = await initializeProject(root);
    const marker = JSON.parse(await readFile(projectMarkerPath(root), "utf8"));

    expect(result).toEqual({ project_root: root, initialized: true, adopted_existing_store: false });
    expect(marker).toMatchObject({ format_version: 2, initialized_at: expect.any(String) });
    await expect(stat(join(root, ".docnexus", "index.sqlite"))).resolves.toBeDefined();

    const db = new DatabaseSync(join(root, ".docnexus", "index.sqlite"));
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    db.close();
    expect(tables).toEqual(["documents", "file_chunks"]);
  });

  it("is idempotent and preserves existing project data", async () => {
    const root = await makeRoot();
    await initializeProject(root);
    const sentinel = join(root, ".docnexus", "keep.md");
    await writeFile(sentinel, "existing data");
    const before = await readFile(projectMarkerPath(root), "utf8");

    await initializeProject(root);

    await expect(readFile(sentinel, "utf8")).resolves.toBe("existing data");
    await expect(readFile(projectMarkerPath(root), "utf8")).resolves.toBe(before);
  });

  it("refuses an unmarked existing store until it is reset", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".docnexus", "records"), { recursive: true });
    await writeFile(join(root, ".docnexus", "records", "legacy.md"), "legacy");

    await expect(initializeProject(root)).rejects.toThrow("docnexus reset --force");
    await expect(readFile(join(root, ".docnexus", "records", "legacy.md"), "utf8")).resolves.toBe("legacy");
    await expect(readFile(projectMarkerPath(root), "utf8")).rejects.toThrow();
  });

  it("rejects unsupported markers and non-existent project roots", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".docnexus"), { recursive: true });
    await writeFile(projectMarkerPath(root), JSON.stringify({ format_version: 99, initialized_at: "x" }));

    await expect(requireInitializedProject(root)).rejects.toThrow("unsupported DocNexus project format");
    await expect(initializeProject(join(root, "missing"))).rejects.toThrow("project root does not exist");
  });
});
