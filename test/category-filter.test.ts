import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializeProject } from "../src/project.js";
import { classifyManagedDocument, upsertManagedDocument } from "../src/managed-documents.js";
import { searchDocuments } from "../src/search.js";
import { recall } from "../src/recall.js";
import { recallEvidence } from "../src/recall-evidence.js";
import { LocalHashEmbedder } from "../src/embedder.js";
import { syncRetrievalIndex } from "../src/retrieval-index.js";
import { withRetrievalDatabase } from "../src/postgres-engine.js";
import { findVectorCandidates } from "../src/postgres-store.js";
import { runCli } from "../src/cli.js";
import type { DocNexusMetadata } from "../src/types.js";

const roots: string[] = [];
const metadata: DocNexusMetadata = { title: "Policy", summary: "Current conventions", tags: [], entities: [], relationships: [] };
const model = new LocalHashEmbedder();
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), "docnexus-category-")); roots.push(path); await initializeProject(path); return path; }
async function add(path: string, file: string, category?: string, document = "needle policy", extra: Partial<DocNexusMetadata> = {}) {
  return upsertManagedDocument(path, { file_path: file, source: "Category regression", document, metadata: { ...metadata, ...(category === undefined ? {} : { category }), ...extra } });
}

it("filters literal candidates before limit with exact category names and legacy uncategorized values", async () => {
  const path = await root();
  await add(path, "a.md", "other", "needle policy", { title: "needle" });
  const selected = await add(path, "b.md", "codeReview");
  const lower = await add(path, "c.md", "codereview");
  const unicode = await add(path, "d.md", "代码 评审");
  const legacy = await add(path, "e.md");
  for (const [category, id] of [["codeReview", selected.id], ["codereview", lower.id], ["代码 评审", unicode.id], ["uncategorized", legacy.id]]) {
    expect((await searchDocuments(path, { query: "needle", category, limit: 1 })).results.map(result => result.id)).toEqual([id]);
  }
  expect((await searchDocuments(path, { query: "needle", category: "missing" })).results).toEqual([]);
  expect((await searchDocuments(path, { query: "needle" })).results).toHaveLength(5);
});

it.each(["hybrid", "vector"] as const)("scopes %s candidates and graph expansion before their limits", async mode => {
  const path = await root();
  const vector = (first: number) => [first, 1 - first, ...Array(510).fill(0)];
  const embedder = { dimension: 512, embed: async (text: string) => vector(text === "needle" || text.includes("Distractor") ? 1 : 0) };
  const caller = { name: "Caller", type: "component" as const, description: "Caller" };
  const target = { name: "Target", type: "component" as const, description: "Target" };
  for (let index = 0; index < 21; index++) await add(path, `a-noise-${index}.md`, "other", "Distractor needle", {
    entities: [caller, target], relationships: [{ from: "Caller", to: "Target", type: "depends_on", description: "Out-of-category declaration" }]
  });
  const primary = await add(path, "review.md", "codeReview", "needle policy", { entities: [caller], relationships: [
    { from: "Caller", to: "Target", type: "depends_on", description: "Review declaration" }
  ] });
  const support = await add(path, "z-support.md", "codeReview", "Target conventions", { entities: [target] });
  const output = await recall(path, { query: "needle", category: "codeReview", mode, limit: 2 }, embedder);
  expect(new Set(output.results.map(result => result.document_ref.document_id))).toEqual(new Set([primary.id, support.id]));
  const group = output.context_groups.find(group => group.document.document_id === primary.id)!;
  expect(group.graph_context.paths).toHaveLength(1);
  expect(group.graph_context.paths[0].source_document_id).toBe(primary.id);
  expect(group.graph_context.supporting_chunks.map(chunk => chunk.document_id)).toEqual([support.id]);
  const packet = await recallEvidence(path, { query: "needle", category: "codeReview", mode, return_unit: "section", context_budget: 8000 }, embedder);
  expect(packet.evidence.length).toBeGreaterThan(0);
  expect(packet.evidence.every(block => [primary.id, support.id].includes(block.document_id))).toBe(true);
  expect((await recall(path, { query: "needle", category: "missing", mode }, embedder)).results).toEqual([]);
});

it("keeps document-pool completion within the category when a long document fills the vector window", async () => {
  const path = await root();
  const vector = (first: number) => [first, 1 - first, ...Array(510).fill(0)];
  const embedder = { dimension: 512, embed: async (text: string) => vector(text.includes("dominant") ? 1 : 0) };
  const long = await add(path, "long.md", "codeReview", "dominant ".repeat(3000));
  const short = await add(path, "short.md", "codeReview", "Other evidence");
  await add(path, "blocked.md", "other", "Other evidence");
  await syncRetrievalIndex(path, {}, embedder);
  await withRetrievalDatabase(path, async db => {
    await db.exec("SET enable_seqscan=off; SET hnsw.ef_search=1");
    try {
      const hits = await findVectorCandidates(db, vector(1), 3, true, undefined, [long.id, short.id]);
      expect(new Set(hits.map(hit => hit.document_id))).toEqual(new Set([long.id, short.id]));
      expect(await findVectorCandidates(db, vector(1), 3, true, undefined, [])).toEqual([]);
    } finally { await db.exec("RESET enable_seqscan; RESET hnsw.ef_search"); }
  });
});

it("uses current classifications after reclassification in both recall modes", async () => {
  const path = await root();
  const saved = await add(path, "review.md", "codeReview");
  const legacy = await add(path, "legacy.md");
  for (const mode of ["hybrid", "vector"] as const) {
    expect((await recall(path, { query: "needle", category: "uncategorized", mode }, model)).results.map(result => result.document_ref.document_id)).toEqual([legacy.id]);
  }
  await classifyManagedDocument(path, { id: saved.id, category: "评审结果", reason: "User-selected category" });
  expect((await searchDocuments(path, { query: "needle", category: "codeReview" })).results).toEqual([]);
  for (const mode of ["hybrid", "vector"] as const) {
    expect((await recall(path, { query: "needle", category: "codeReview", mode }, model)).results).toEqual([]);
    expect((await recall(path, { query: "needle", category: "评审结果", mode }, model)).results.map(result => result.document_ref.document_id)).toEqual([saved.id]);
    expect((await recall(path, { query: "needle", mode }, model)).results).toHaveLength(2);
  }
});

it("retains the canonical owner of a fact referenced by an in-category document", async () => {
  const path = await root();
  const owner = await add(path, "owner.md", "other", "{{fact:fact_category}}", { facts: [
    { id: "fact_category", text: "Review rule requires verification.", provenance: "Owner decision", valid_from: "2000-01-01T00:00:00Z" }
  ] });
  const reader = await add(path, "review.md", "codeReview", "{{fact:fact_category}}");
  const packet = await recallEvidence(path, { query: "verification", category: "codeReview", context_budget: 8000 }, model);
  expect(packet.evidence).toContainEqual(expect.objectContaining({ kind: "fact", document_id: owner.id, fact: expect.objectContaining({ id: "fact_category", status: "active" }) }));
  const found = await recall(path, { query: "verification", category: "codeReview" }, model);
  expect(found.results.map(result => result.document_ref.document_id)).toEqual([reader.id]);
});

it("wires CLI category filters through search, vector/hybrid recall and budgeted evidence", async () => {
  const path = await root();
  const saved = await add(path, "review.md", "codeReview");
  await add(path, "other.md", "other");
  expect(JSON.parse(await runCli(["search", "needle", "--category", "codeReview"], path)).results.map((result: { id: string }) => result.id)).toEqual([saved.id]);
  for (const mode of ["hybrid", "vector"]) {
    const result = JSON.parse(await runCli(["recall", "needle", "--category", "codeReview", "--mode", mode], path));
    expect(result.results.map((result: { document_ref: { document_id: string } }) => result.document_ref.document_id)).toEqual([saved.id]);
    const packet = JSON.parse(await runCli(["recall", "needle", "--category", "codeReview", "--mode", mode, "--return-unit", "page", "--context-budget", "8000"], path));
    expect(packet.evidence.length).toBeGreaterThan(0);
    expect(packet.evidence.every((block: { document_id: string }) => block.document_id === saved.id)).toBe(true);
  }
  for (const command of ["search", "recall"]) {
    await expect(runCli([command, "needle", "--category", ""], path)).rejects.toMatchObject({ code: "invalid_params" });
    await expect(runCli([command, "needle", "--category"], path)).rejects.toMatchObject({ code: "invalid_params" });
  }
});

it.each(["", " codeReview", "codeReview ", "x".repeat(81), "bad\nname", 42])("rejects invalid category %j before loading a model or workspace", async category => {
  const embedder = { dimension: 512, embed: vi.fn() };
  const input = { query: "needle", category: category as string };
  await expect(searchDocuments("/unused", input)).rejects.toMatchObject({ code: "invalid_params" });
  await expect(recall("/unused", input, embedder)).rejects.toMatchObject({ code: "invalid_params" });
  expect(embedder.embed).not.toHaveBeenCalled();
});
