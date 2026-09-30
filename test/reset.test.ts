import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      { file_path: "docs/memory/a.md", source: "raw", document: "# A", metadata },
      new LocalHashEmbedder(8),
      graphWriter
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

  it("resets an unsupported project format so it can be initialized again", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "docnexus"), { recursive: true });
    await writeFile(join(root, "docnexus", "project.json"), JSON.stringify({ format_version: 1, initialized_at: "old" }));

    await resetProjectData(root, { force: true });
    await expect(initializeProject(root)).resolves.toMatchObject({ created: true });
  });
});
