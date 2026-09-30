import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConceptIndex, renderConceptIndex, writeConceptIndex } from "../src/concepts.js";
import { LocalHashEmbedder } from "../src/embedder.js";
import { upsertManagedDocument, type ManagedGraphWriter } from "../src/managed-documents.js";
import { initializeProject } from "../src/project.js";

const roots: string[] = [];
const graphWriter: ManagedGraphWriter = { replaceDocumentGraph: async () => {}, deleteDocumentGraph: async () => {} };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function add(root: string, filePath: string, entities: Array<{ name: string; type: "component" | "decision" }>, relationships = []) {
  await upsertManagedDocument(
    root,
    {
      file_path: filePath,
      source: filePath,
      document: `# ${filePath}`,
      metadata: {
        title: filePath,
        summary: filePath,
        tags: [],
        entities: entities.map((entity) => ({ ...entity, description: `${entity.name} description` })),
        relationships
      }
    },
    new LocalHashEmbedder(8),
    graphWriter
  );
}

describe("concept index", () => {
  it("merges entities across records and renders the loadable index", async () => {
    const root = await mkdtemp(join(tmpdir(), "docnexus-concepts-"));
    roots.push(root);
    await initializeProject(root);
    await expect(readFile(join(root, "docnexus", "CONCEPTS.md"), "utf8")).resolves.toContain("No concepts yet");

    await add(root, "auth.md", [{ name: "Auth service", type: "component" }, { name: "Hourly rotation", type: "decision" }], [
      { from: "Auth service", to: "Hourly rotation", type: "implements", description: "x" }
    ] as never);
    await add(root, "gateway.md", [{ name: "auth service", type: "component" }]);

    const index = await buildConceptIndex(root);
    expect(index).toMatchObject({ document_count: 2, concept_count: 2 });
    expect(index.concepts[0]).toMatchObject({
      name: "Auth service",
      type: "component",
      documents: ["auth.md", "gateway.md"],
      relations: [{ type: "implements", to: "Hourly rotation" }]
    });
    expect((await buildConceptIndex(root, { type: "decision" })).concepts.map((entry) => entry.name)).toEqual(["Hourly rotation"]);
    expect((await buildConceptIndex(root, { query: "hourly" })).concept_count).toBe(1);

    await writeConceptIndex(root);
    const markdown = await readFile(join(root, "docnexus", "CONCEPTS.md"), "utf8");
    expect(markdown).toBe(renderConceptIndex(index));
    expect(markdown).toContain("## component");
    expect(markdown).toContain("- **Auth service** — Auth service description (implements Hourly rotation) → `docnexus/library/auth.md`, `docnexus/library/gateway.md`");
    expect(markdown).toContain("docnexus-recall");
  });
});
