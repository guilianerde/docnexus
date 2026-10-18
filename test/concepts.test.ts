import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConceptIndex, categoryFileNames, renderConceptFiles, renderConceptIndex, writeConceptIndex, type ConceptIndex } from "../src/concepts.js";
import { deleteManagedDocument, upsertManagedDocument } from "../src/managed-documents.js";
import { initializeProject } from "../src/project.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeProject(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  await initializeProject(root);
  return root;
}

async function add(root: string, filePath: string, entities: Array<{ name: string; type: "component" | "decision" }>, relationships = [], category?: string) {
  return upsertManagedDocument(
    root,
    {
      file_path: filePath,
      source: filePath,
      document: `# ${filePath}`,
      metadata: {
        title: filePath,
        summary: filePath,
        ...(category ? { category, category_reason: "test" } : {}),
        tags: [],
        entities: entities.map((entity) => ({ ...entity, description: `${entity.name} description` })),
        relationships
      }
    }
  );
}

describe("concept index", () => {
  it("merges entities across records and routes each category to its own file", async () => {
    const root = await makeProject("docnexus-concepts-");
    await expect(readFile(join(root, "docnexus", "CONCEPTS.md"), "utf8")).resolves.toContain("No project memory yet");

    await add(root, "auth.md", [{ name: "Auth service", type: "component" }, { name: "Hourly rotation", type: "decision" }], [
      { from: "Auth service", to: "Hourly rotation", type: "implements", description: "x" }
    ] as never, "鉴权");
    await add(root, "gateway.md", [{ name: "auth service", type: "component" }], [], "Gateway");

    const index = await buildConceptIndex(root);
    expect(index).toMatchObject({ document_count: 2, concept_count: 2 });
    expect(index.concepts[0]).toMatchObject({
      name: "Auth service",
      type: "component",
      documents: ["auth.md", "gateway.md"],
      categories: ["Gateway", "鉴权"],
      relations: [{ type: "implements", to: "Hourly rotation" }]
    });
    expect(index.categories).toEqual([
      { name: "Gateway", document_count: 1, concept_count: 1 },
      { name: "鉴权", document_count: 1, concept_count: 2 }
    ]);
    expect((await buildConceptIndex(root, { type: "decision" })).concepts.map((entry) => entry.name)).toEqual(["Hourly rotation"]);
    expect((await buildConceptIndex(root, { query: "hourly" })).concept_count).toBe(1);
    expect((await buildConceptIndex(root, { category: "Gateway" })).concepts.map((entry) => entry.name)).toEqual(["Auth service"]);

    await writeConceptIndex(root);
    const map = await readFile(join(root, "docnexus", "CONCEPTS.md"), "utf8");
    expect(map).toBe(renderConceptIndex(index));
    expect(map).toContain("never skip `docnexus-recall` because of this map");
    expect(map).toContain("| 鉴权 | 1 | 2 | Auth service, Hourly rotation | `docnexus/concepts/鉴权.md` |");
    expect(map).not.toContain("docnexus/library/");

    const auth = await readFile(join(root, "docnexus", "concepts", "鉴权.md"), "utf8");
    expect(auth).toContain('--category "鉴权"');
    expect(auth).toContain("## component");
    expect(auth).toContain("- **Auth service** — Auth service description (implements Hourly rotation) → `docnexus/library/auth.md`, `docnexus/library/gateway.md`");
    const gateway = await readFile(join(root, "docnexus", "concepts", "gateway.md"), "utf8");
    expect(gateway).toContain("**Auth service**");
    expect(gateway).not.toContain("Hourly rotation —");
  });

  it("lists documents with no entity annotations in their category file", async () => {
    const root = await makeProject("docnexus-directory-");
    await upsertManagedDocument(root, { file_path: "notes.md", source: "User notes", document: "# Notes", metadata: { title: "Plain notes", summary: "Project convention", tags: [], entities: [], relationships: [] } });
    await writeConceptIndex(root);
    const shard = await readFile(join(root, "docnexus/concepts/uncategorized.md"), "utf8");
    expect(shard).toContain("docnexus/library/notes.md");
    expect(shard).toContain("Plain notes");
    expect(shard).toContain("_No named concepts.");
  });

  it("removes generated files of vanished categories but keeps hand-placed files", async () => {
    const root = await makeProject("docnexus-stale-");
    const saved = await add(root, "deploy.md", [{ name: "Blue green", type: "decision" }], [], "部署");
    await add(root, "auth.md", [{ name: "Auth service", type: "component" }], [], "鉴权");
    await writeFile(join(root, "docnexus/concepts/notes.md"), "my own notes\n");
    await deleteManagedDocument(root, { id: saved.id, confirm: true });
    expect((await readdir(join(root, "docnexus/concepts"))).sort()).toEqual(["notes.md", "鉴权.md"]);
  });

  it("keeps the root map within budget and splits oversized categories by type", () => {
    const concepts: ConceptIndex["concepts"] = [];
    const documents: ConceptIndex["documents"] = [];
    const categories: ConceptIndex["categories"] = [];
    for (let c = 0; c < 80; c += 1) {
      const name = `Domain number ${c} with a fairly long category name`;
      documents.push({ id: `d${c}`, file_path: `d${c}.md`, title: `Doc ${c}`, summary: "s", category: name });
      categories.push({ name, document_count: 1, concept_count: c === 0 ? 400 : 1 });
    }
    for (let i = 0; i < 400; i += 1) {
      concepts.push({ name: `Concept ${i}`, type: i % 2 ? "component" : "decision", description: "x".repeat(150), documents: ["d0.md"], categories: [categories[0].name], relations: [] });
    }
    const index: ConceptIndex = { document_count: 80, concept_count: 400, categories, documents, concepts };
    const map = renderConceptIndex(index);
    expect(Buffer.byteLength(map)).toBeLessThanOrEqual(3072);
    expect(map).toMatch(/_\d+ more categories in `docnexus\/concepts\/`\._/);

    const files = renderConceptFiles(index);
    const slug = categoryFileNames([categories[0].name]).get(categories[0].name);
    expect(files.get(`concepts/${slug}.md`)).toContain(`docnexus/concepts/${slug}/component.md`);
    expect(files.get(`concepts/${slug}/decision.md`)).toContain("**Concept 0**");
    expect(files.get(`concepts/${slug}/component.md`)).toContain("**Concept 1**");
  });

  it("assigns collision-free, order-independent file names", () => {
    const names = categoryFileNames(["API Contract", "api-contract", "CON", "接口契约"]);
    expect(names.get("接口契约")).toBe("接口契约");
    expect(names.get("API Contract")).toMatch(/^api-contract-[0-9a-f]{8}$/);
    expect(names.get("API Contract")).not.toBe(names.get("api-contract"));
    expect(names.get("CON")).toMatch(/^con-[0-9a-f]{8}$/);
    expect(categoryFileNames(["api-contract", "API Contract"]).get("API Contract")).toBe(names.get("API Contract"));
  });
});
