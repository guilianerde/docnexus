import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeProject } from "../src/project.js";
import { queryDocuments } from "../src/document-query.js";
import { CATEGORY_GUIDE_FILE } from "../src/category-guide.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-category-guide-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("starter category guide", () => {
  it("creates an editable suggestion list without seeding a taxonomy", async () => {
    const root = await makeRoot();
    await initializeProject(root);

    const guide = await readFile(join(root, "docnexus", CATEGORY_GUIDE_FILE), "utf8");
    expect(guide).toContain("| pitfalls |");
    expect(guide).toContain("| templates |");
    expect(guide).toContain("| api-contracts |");
    expect(guide).toContain("not a fixed taxonomy");
    expect(guide).toContain("document classify");
    expect(guide).not.toContain("项目踩坑");

    const output = await queryDocuments(root);
    expect(output.total_documents).toBe(0);
    expect(output.categories).toEqual([]);
  });

  it("keeps project edits when init runs again", async () => {
    const root = await makeRoot();
    await initializeProject(root);
    const path = join(root, "docnexus", CATEGORY_GUIDE_FILE);
    const edited = "# Our categories\n\n- 构建事故\n- 发布清单\n";
    await writeFile(path, edited);

    await expect(initializeProject(root)).resolves.toMatchObject({ created: false });
    await expect(readFile(path, "utf8")).resolves.toBe(edited);
  });

  it("rejects symlinked guides instead of following or replacing them", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await initializeProject(root);
    const path = join(root, "docnexus", CATEGORY_GUIDE_FILE);
    const external = join(outside, "external.md");
    await writeFile(external, "outside sentinel");
    await rm(path);
    await symlink(external, path, "file");

    await expect(initializeProject(root)).rejects.toThrow("symbolic links");
    await expect(readFile(external, "utf8")).resolves.toBe("outside sentinel");

    await rm(path);
    await symlink(join(outside, "missing.md"), path, "file");
    await expect(initializeProject(root)).rejects.toThrow("symbolic links");
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });
});