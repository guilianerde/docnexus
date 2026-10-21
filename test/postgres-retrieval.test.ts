import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeProject } from "../src/project.js";
import { classifyManagedDocument, deleteManagedDocument, getManagedRecord, upsertManagedDocument } from "../src/managed-documents.js";
import { LocalHashEmbedder } from "../src/embedder.js";
import { ensureRetrievalStore, inspectRetrievalIndex, listIndexedChunks, syncRetrievalIndex } from "../src/retrieval-index.js";
import { withRetrievalDatabase } from "../src/postgres-engine.js";
import { findVectorCandidates, loadPostgresContext, readChunks, replacePostgresProjection, tables } from "../src/postgres-store.js";
import { recall } from "../src/recall.js";
import { auditGraph, repairGraph } from "../src/graph-maintenance.js";
import { queryDocuments } from "../src/document-query.js";

const roots: string[] = [];
const embedder = new LocalHashEmbedder();
const metadata = { title: "Policy", summary: "Current policy", tags: [], entities: [{ name: "Caller", type: "component" as const, description: "Caller" }, { name: "Target", type: "component" as const, description: "Target" }], relationships: [{ from: "Caller", to: "Target", type: "depends_on" as const, description: "Caller depends on Target" }] };
const input = { file_path: "policy.md", source: "User decision", document: "# Policy\n\nRefresh tokens rotate hourly.", metadata };
async function root() { const root = await mkdtemp(join(tmpdir(), "docnexus-postgres-")); roots.push(root); await initializeProject(root); return root; }
async function indexOid(root: string) {
  return withRetrievalDatabase(root, async db => (await db.query<{ oid: number; storage: string }>("SELECT oid::int AS oid,relfilenode::text AS storage FROM pg_class WHERE oid=to_regclass($1)", [`${db.schema}.chunks_embedding_idx`]))[0]);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("unified PostgreSQL retrieval", () => {
  it("fills document candidates even when one long document occupies the chunk window", async () => {
    const path = await root();
    const vector = (first: number, second: number) => [first, second, ...Array(510).fill(0)];
    const model = { dimension: 512, embed: async (text: string) => text.includes("dominant") ? vector(1, 0) : vector(0, 1) };
    await upsertManagedDocument(path, { ...input, document: "dominant ".repeat(3000) });
    for (const file of ["other-a.md", "other-b.md"]) await upsertManagedDocument(path, { ...input, file_path: file, document: "Other evidence" });
    await syncRetrievalIndex(path, {}, model);
    await withRetrievalDatabase(path, async db => {
      const query = vi.spyOn(db, "query");
      const candidates = await findVectorCandidates(db, vector(1, 0), 3, true);
      expect(new Set(candidates.map(hit => hit.document_id)).size).toBe(3);
      expect(query.mock.calls.every(([sql]) => !sql.includes("document_concepts"))).toBe(true);
      query.mockClear();
      const context = await loadPostgresContext(db, candidates.slice(-1));
      expect(context.context_groups).toHaveLength(1);
      expect(query.mock.calls).toHaveLength(5);
      const graphRead = query.mock.calls.findIndex(([sql]) => sql.includes("graph_one_hop"));
      expect(await query.mock.results[graphRead].value).toHaveLength(3);
      expect(context.context_groups[0].same_document_chunks.length).toBeLessThanOrEqual(2);
    });
  });

  it("keeps canonical text usable when the configured database cannot be opened", async () => {
    process.env.DOCNEXUS_DATABASE_URL = "unavailable database";
    const warning = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const path = await root();
      const saved = await upsertManagedDocument(path, input);
      expect((await queryDocuments(path, { all: true })).documents[0].id).toBe(saved.id);
      expect((await inspectRetrievalIndex(path)).in_sync).toBe(false);
      await expect(recall(path, { query: "Refresh tokens" }, embedder)).rejects.toThrow("PostgreSQL connection URL");
      await deleteManagedDocument(path, { id: saved.id, confirm: true });
      expect((await queryDocuments(path, { all: true })).documents).toEqual([]);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("derived deletion pending"));
    } finally { delete process.env.DOCNEXUS_DATABASE_URL; warning.mockRestore(); }
  });

  it("keeps HNSW across insert, replace, delete-all and reinsertion, including reopening", async () => {
    const path = await root();
    const saved = await upsertManagedDocument(path, input);
    await syncRetrievalIndex(path, {}, embedder);
    const oid = await indexOid(path);
    const first = await recall(path, { query: "Refresh tokens rotate hourly", mode: "vector", limit: 1 }, embedder);
    expect(first.results[0].document_ref.document_id).toBe(saved.id);
    await upsertManagedDocument(path, { ...input, source: "Revised decision", document: "# Policy\n\nRefresh tokens rotate on every use." });
    await syncRetrievalIndex(path, {}, embedder);
    expect((await listIndexedChunks(path, saved.id)).map(c => c.text).join("\n")).not.toContain("hourly");
    expect(await indexOid(path)).toEqual(oid);
    await deleteManagedDocument(path, { id: saved.id, confirm: true });
    expect((await recall(path, { query: "Refresh tokens", mode: "vector" }, embedder)).results).toEqual([]);
    const recreated = await upsertManagedDocument(path, input);
    await syncRetrievalIndex(path, {}, embedder);
    expect((await recall(path, { query: "Refresh tokens", limit: 1 }, embedder)).results[0].document_ref.document_id).toBe(recreated.id);
    expect(await indexOid(path)).toEqual(oid);
    expect((await auditGraph(path)).result).toBe("clean");
  });

  it("reuses chunk ids and vectors after classification-only changes", async () => {
    const path = await root(); const saved = await upsertManagedDocument(path, input);
    await syncRetrievalIndex(path, {}, embedder);
    const before = await listIndexedChunks(path, saved.id); const oid = await indexOid(path);
    await classifyManagedDocument(path, { id: saved.id, category: "接口约定", reason: "User classification" });
    const result = await syncRetrievalIndex(path, {}, embedder);
    expect(result).toMatchObject({ embedded_chunks: 0, reused_chunks: before.length });
    const version = (await getManagedRecord(path, saved.id)).record_version;
    expect(await listIndexedChunks(path, saved.id)).toEqual(before.map(chunk => ({ ...chunk, source_anchor: { ...chunk.source_anchor!, record_version: version } })));
    expect(await indexOid(path)).toEqual(oid);
    expect((await syncRetrievalIndex(path, {}, embedder)).processed_documents).toBe(0);
  });

  it("reuses unchanged fragments when a long document is extended", async () => {
    const path = await root(); const body = "# Policy\n\n" + "Preserve deployment logs and verification results. ".repeat(70);
    const saved = await upsertManagedDocument(path, { ...input, document: body });
    await syncRetrievalIndex(path, {}, embedder);
    const before = await listIndexedChunks(path, saved.id);
    await upsertManagedDocument(path, { ...input, document: body + "\n\nNew conclusion: restart the queue after recovery." });
    const result = await syncRetrievalIndex(path, {}, embedder);
    const after = await listIndexedChunks(path, saved.id);
    expect(result.reused_chunks).toBeGreaterThan(0); expect(result.embedded_chunks).toBeGreaterThan(0);
    expect(after.some(c => before.some(old => old.id === c.id && old.text === c.text))).toBe(true);
  });

  it("rolls back document, vectors and graph when a relationship write fails", async () => {
    const path = await root(); const saved = await upsertManagedDocument(path, input); await syncRetrievalIndex(path, {}, embedder);
    const before = await listIndexedChunks(path, saved.id);
    await expect(withRetrievalDatabase(path, async db => {
      const doc = (await db.query<any>(`SELECT * FROM ${tables(db).documents} WHERE id=$1`, [saved.id]))[0];
      const chunks = await readChunks(db, saved.id);
      await replacePostgresProjection(db, { ...doc, title: "Should roll back" }, chunks.map(c => ({ ...c, id: "new_" + c.id })), { concepts: [], edges: [{ label: "DEPENDS_ON", from: "missing", to: "also_missing", description: "Invalid" }] }, chunks[0].embedding_signature);
    })).rejects.toThrow();
    expect(await listIndexedChunks(path, saved.id)).toEqual(before);
    expect((await withRetrievalDatabase(path, db => db.query<{ title: string }>(`SELECT title FROM ${tables(db).documents} WHERE id=$1`, [saved.id])))![0].title).toBe(input.metadata.title);
    expect((await auditGraph(path)).result).toBe("clean");
  });

  it("rebuilds a deleted store from text and isolates projects", async () => {
    const path = await root(); const saved = await upsertManagedDocument(path, input); await syncRetrievalIndex(path, {}, embedder);
    const before = await getManagedRecord(path, saved.id);
    const record = await readFile(join(path, "docnexus/records", saved.id, "record.json"), "utf8");
    await rm(join(path, ".docnexus/store"), { recursive: true, force: true });
    expect((await inspectRetrievalIndex(path)).unindexed).toEqual([saved.id]);
    await syncRetrievalIndex(path, {}, embedder);
    expect(await getManagedRecord(path, saved.id)).toEqual(before);
    expect(await readFile(join(path, "docnexus/records", saved.id, "record.json"), "utf8")).toBe(record);
    expect((await recall(await root(), { query: "Refresh tokens" }, embedder)).results).toEqual([]);
  });

  it("repairs missing graph declarations while retaining vectors and HNSW", async () => {
    const path = await root(); const saved = await upsertManagedDocument(path, input); await syncRetrievalIndex(path, {}, embedder);
    const before = await listIndexedChunks(path, saved.id); const oid = await indexOid(path);
    await withRetrievalDatabase(path, db => db.query(`DELETE FROM ${tables(db).edges} WHERE document_id=$1`, [saved.id]));
    expect((await auditGraph(path)).issues.missing_edges).toHaveLength(1);
    await expect(repairGraph(path, { force: false })).rejects.toThrow("--force");
    expect((await repairGraph(path, { force: true })).result).toBe("completed");
    expect(await listIndexedChunks(path, saved.id)).toEqual(before); expect(await indexOid(path)).toEqual(oid);
  });

  it("retries model failures and invalidates strategy or model signatures", async () => {
    const path = await root(); const saved = await upsertManagedDocument(path, input);
    await expect(syncRetrievalIndex(path, {}, { dimension: 512, embed: async () => { throw new Error("model failed"); } })).rejects.toThrow("model failed");
    await syncRetrievalIndex(path, {}, embedder);
    await withRetrievalDatabase(path, db => db.query(`DELETE FROM ${tables(db).state} WHERE key='chunking_signature'`));
    expect((await inspectRetrievalIndex(path)).outdated).toEqual([saved.id]);
    expect((await syncRetrievalIndex(path, {}, embedder)).reused_chunks).toBeGreaterThan(0);
    const changed = { dimension: 512, embed: async (text: string) => (await embedder.embed(text)).map(v => -v) };
    expect((await syncRetrievalIndex(path, {}, changed)).embedded_chunks).toBeGreaterThan(0);
  });
});
