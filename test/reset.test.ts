import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalHashEmbedder } from "../src/embedder.js";
import { upsertManagedDocument, type ManagedGraphWriter } from "../src/managed-documents.js";
import { initializeProject } from "../src/project.js";
import { resetProjectData } from "../src/reset.js";

const roots: string[] = [];
const graphWriter: ManagedGraphWriter = {
  replaceDocumentGraph: async () => {},
  deleteDocumentGraph: async () => {}
};
const metadata = {
  title: "Reset",
  summary: "Reset current managed state.",
  tags: ["reset"],
  entities: [],
  relationships: []
};

async function makeRoot(initialized = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-reset-"));
  roots.push(root);
  if (initialized) {
    await initializeProject(root);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("reset", () => {
  it("rejects reset unless force is supplied", async () => {
    const root = await makeRoot();
    await expect(resetProjectData(root, { force: false })).rejects.toThrow("--force");
    await expect(access(join(root, ".docnexus"))).resolves.toBeUndefined();
  });

  it("removes current-format managed target files and the full internal store", async () => {
    const root = await makeRoot();
    for (const file_path of ["docs/memory/a.md", "docs/memory/b.md"]) {
      await upsertManagedDocument(
        root,
        { file_path, source: "raw", document: `# ${file_path}`, metadata },
        new LocalHashEmbedder(8),
        graphWriter
      );
    }

    await expect(resetProjectData(root, { force: true })).resolves.toMatchObject({
      deleted_managed_files: ["docs/memory/a.md", "docs/memory/b.md"],
      removed_store: true
    });
    await expect(access(join(root, "docs/memory/a.md"))).rejects.toThrow();
    await expect(access(join(root, ".docnexus"))).rejects.toThrow();
  });

  it("removes only .docnexus for an old store", async () => {
    const root = await makeRoot(false);
    await mkdir(join(root, ".docnexus"), { recursive: true });
    await mkdir(join(root, "docs/memory"), { recursive: true });
    await writeFile(join(root, ".docnexus", "project.json"), JSON.stringify({ format_version: 1, initialized_at: "old" }));
    await writeFile(join(root, "docs/memory/legacy.md"), "outside recoverable v2 ownership");

    await resetProjectData(root, { force: true });

    await expect(readFile(join(root, "docs/memory/legacy.md"), "utf8")).resolves.toContain("outside recoverable");
    await expect(access(join(root, ".docnexus"))).rejects.toThrow();
  });
});
