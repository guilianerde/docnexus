import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("creates the docnexus workspace with skills, drafts, library, schemas, and records", async () => {
    const root = await makeRoot();

    const result = await initializeProject(root);
    const marker = JSON.parse(await readFile(projectMarkerPath(root), "utf8"));

    expect(result).toMatchObject({ project_root: root, workspace: join(root, "docnexus"), initialized: true, created: true });
    expect(result.skills).toContain("docnexus");
    expect(marker).toMatchObject({ format_version: 6, initialized_at: expect.any(String) });
    expect(projectMarkerPath(root)).toBe(join(root, "docnexus", "project.json"));
    for (const path of ["skills/docnexus/SKILL.md", "drafts", "library", "schemas/metadata.schema.json", "records", "README.md"]) {
      await expect(stat(join(root, "docnexus", path))).resolves.toBeDefined();
    }
    await expect(stat(join(root, ".docnexus"))).rejects.toThrow();

    await expect(stat(join(root, "docnexus", "store", "brain.pglite"))).rejects.toThrow();

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

  it.each(["dependencies", "devDependencies"])("initializes over a scoped npm installation using %s without changing host or install manifests", async dependencyField => {
    const root = await makeRoot();
    const directory = join(root, "docnexus");
    await mkdir(join(directory, "node_modules"), { recursive: true });
    const files = new Map([
      [join(root, "package.json"), '{"name":"host","scripts":{"build":"host-build"}}'],
      [join(root, "package-lock.json"), "host lock sentinel"],
      [join(directory, "package.json"), JSON.stringify({ private: true, [dependencyField]: { "@rowansenne/docnexus": "0.16.0" } })],
      [join(directory, "package-lock.json"), "installation lock sentinel"],
      [join(directory, "node_modules", "keep"), "installed runtime sentinel"]
    ]);
    for (const [path, value] of files) await writeFile(path, value);
    await expect(initializeProject(root)).resolves.toMatchObject({ created: true, project_root: root });
    for (const [path, value] of files) expect(await readFile(path, "utf8")).toBe(value);
    expect(await readFile(join(directory, ".gitignore"), "utf8")).toContain("node_modules/");
    await expect(stat(join(directory, "docnexus"))).rejects.toThrow();
  });

  it.each(["unrelated", "extra-content", "missing-manifest"])("rejects %s beside an uninitialized npm installation", async kind => {
    const root = await makeRoot();
    const directory = join(root, "docnexus");
    await mkdir(join(directory, "node_modules"), { recursive: true });
    if (kind !== "missing-manifest") await writeFile(join(directory, "package.json"), JSON.stringify({
      dependencies: { [kind === "unrelated" ? "other-package" : "@rowansenne/docnexus"]: "1.0.0" }
    }));
    if (kind === "extra-content") await writeFile(join(directory, "notes.md"), "user content");
    await expect(initializeProject(root)).rejects.toThrow("is not a DocNexus workspace");
    await expect(readFile(projectMarkerPath(root), "utf8")).rejects.toThrow();
    if (kind === "extra-content") expect(await readFile(join(directory, "notes.md"), "utf8")).toBe("user content");
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
    await writeFile(projectMarkerPath(root), JSON.stringify({ format_version: 5, initialized_at: "x" }));

    await expect(requireInitializedProject(root)).rejects.toThrow("unsupported DocNexus project format");
    await expect(initializeProject(join(root, "missing"))).rejects.toThrow("project root does not exist");
  });
});
