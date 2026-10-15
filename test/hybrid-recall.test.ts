import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fuseDocumentRanks } from "../src/hybrid-recall.js";
import { initializeProject } from "../src/project.js";
import { upsertManagedDocument } from "../src/managed-documents.js";
import { recall } from "../src/recall.js";
import { searchDocuments } from "../src/search.js";
import { RealEmbedder } from "../src/embedder-real.js";
import { bundledEmbeddingModelsPath } from "../src/embedding-models.js";
import { LocalHashEmbedder } from "../src/embedder.js";
import type { DocNexusMetadata } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "docnexus-hybrid-"));
  roots.push(path);
  await initializeProject(path);
  return path;
}
const metadata: DocNexusMetadata = { title: "Document", summary: "Fixture context", tags: [], entities: [], relationships: [] };

describe("document-level hybrid recall", () => {
  it("fuses independent ranks without comparing incompatible scores or counting duplicate chunks", () => {
    const fused = fuseDocumentRanks(["exact", "both"], ["semantic", "semantic", "both", "semantic"]);
    expect(fused[0]).toMatchObject({ id: "both", ranks: { keyword: 2, vector: 2 } });
    expect(fused.find((row) => row.id === "both")!.score).toBeCloseTo(2 / 62);
    expect(fused.find((row) => row.id === "semantic")!.score).toBeCloseTo(1 / 61);
    expect(fuseDocumentRanks([], [])).toEqual([]);
    expect(fuseDocumentRanks(["only"], [])).toEqual([{ id: "only", score: 1 / 61, ranks: { keyword: 1 } }]);
  });

  it("includes keyword-only candidates with graph evidence even outside the vector candidate window", async () => {
    const path = await root();
    const vector = (first: number, second: number) => [first, second, ...Array(510).fill(0)] as number[];
    const embedder = { dimension: 512, embed: async (text: string) => text.startsWith("distractor") || text === "needle_identifier" ? vector(1, 0) : vector(0, 1) };
    for (let index = 0; index < 21; index++) await upsertManagedDocument(path, { file_path: `distractor-${index}.md`, source: "fixture", document: `distractor ${index}`, metadata });
    const saved = await upsertManagedDocument(path, { file_path: "exact.md", source: "fixture", document: "Actual implementation details.", metadata: { ...metadata, title: "needle_identifier", entities: [{ name: "Caller", type: "component", description: "Caller" }, { name: "Target", type: "component", description: "Target" }], relationships: [{ from: "Caller", to: "Target", type: "depends_on", description: "Calls target" }] } });
    const found = await recall(path, { query: "needle_identifier", limit: 2 }, embedder);
    const hit = found.results.find((row) => row.document_ref.document_id === saved.id)!;
    expect(hit.ranking).toMatchObject({ primary: "rrf", source_ranks: { keyword: 1 } });
    expect(hit.ranking.source_ranks).not.toHaveProperty("vector");
    expect(hit.matched_chunk.score).toBe(0);
    expect(found.context_groups.find((group) => group.document.document_id === saved.id)!.graph_context.paths).toContainEqual(expect.objectContaining({ relationship: "DEPENDS_ON", source_document_id: saved.id }));
  }, 20_000);

  it("returns unique documents, reports each ranking source and retains explicit vector mode", async () => {
    const path = await root();
    await upsertManagedDocument(path, { file_path: "long.md", source: "fixture", document: Array.from({ length: 6 }, (_, index) => `needle ${index} ${"details ".repeat(130)}`).join("\n\n"), metadata });
    await upsertManagedDocument(path, { file_path: "short.md", source: "fixture", document: "needle implementation", metadata });
    const found = await recall(path, { query: "needle", limit: 5 }, new LocalHashEmbedder());
    expect(found.results).toHaveLength(2);
    expect(found.context_groups).toHaveLength(2);
    expect(found.results.every((row) => row.ranking.primary === "rrf" && row.ranking.source_ranks?.keyword)).toBe(true);
    expect((await recall(path, { query: "needle", mode: "vector", limit: 5 }, new LocalHashEmbedder())).results.every((row) => row.ranking.primary === "chunk_similarity")).toBe(true);
    await expect(recall(path, { query: "x", mode: "invalid" as "hybrid" })).rejects.toThrow("mode");
  });

  it("does not give a single-character Chinese distraction a keyword vote", async () => {
    const path = await root();
    const noise = await upsertManagedDocument(path, { file_path: "generic.md", source: "fixture", document: "保存当前知识。", metadata: { ...metadata, title: "文档说明", summary: "项目文档" } });
    const relevant = await upsertManagedDocument(path, { file_path: "long-text.md", source: "fixture", document: "长文回归检查末尾内容。", metadata: { ...metadata, title: "检索评估" } });
    const output = await recall(path, { query: "长文", limit: 2 }, new LocalHashEmbedder());
    expect(output.results[0].document_ref.document_id).toBe(relevant.id);
    expect(output.results[0].keyword_match?.matched_terms).toContain("长文");
    const distraction = output.results.find((result) => result.document_ref.document_id === noise.id);
    expect(distraction).toBeDefined();
    expect(distraction?.keyword_match).toBeUndefined();
    expect(distraction!.ranking.source_ranks).not.toHaveProperty("keyword");
  });

  it("meets the small bilingual evaluation set using the packaged offline ONNX model", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("evaluation forbids network")));
    const path = await root();
    const fixture = JSON.parse(await readFile(new URL("./fixtures/retrieval-eval.json", import.meta.url), "utf8")) as {
      documents: Array<{ path: string; title: string; summary: string; body: string; entities: DocNexusMetadata["entities"]; relationships: DocNexusMetadata["relationships"] }>;
      queries: Array<{ kind: string; query: string; expected: string | null; edge?: string }>;
    };
    for (const document of fixture.documents) await upsertManagedDocument(path, { file_path: document.path, source: "Evaluation fixture", document: document.body, metadata: { title: document.title, summary: document.summary, tags: [], entities: document.entities, relationships: document.relationships } });
    const embedder = new RealEmbedder({ localModelPath: bundledEmbeddingModelsPath() });
    const measurements: Array<{ kind: string; first: string; rank: number }> = [];
    for (const query of fixture.queries) {
      const output = await recall(path, { query: query.query, limit: 3 }, embedder);
      if (query.expected) {
        const rank = output.results.findIndex((row) => row.document_ref.path === query.expected) + 1;
        measurements.push({ kind: query.kind, first: output.results[0].document_ref.path, rank });
        expect(rank, `${query.kind}: ${JSON.stringify(output.results.map((row) => row.document_ref.path))}`).toBeGreaterThan(0);
        if (query.kind === "identifier" || query.kind === "alias") expect(rank).toBe(1);
        if (query.edge) expect(output.context_groups.find((group) => group.document.path === query.expected)!.graph_context.paths.some((edge) => edge.relationship === query.edge)).toBe(true);
      } else {
        // Retrieval still returns nearest neighbors; this is evidence for an agent's abstention case.
        expect((await searchDocuments(path, { query: query.query })).results).toEqual([]);
        expect(output.results.every((row) => row.ranking.source_ranks?.keyword === undefined)).toBe(true);
      }
    }
    expect(measurements).toHaveLength(6);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  }, 30_000);
});
