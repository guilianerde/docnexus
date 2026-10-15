import { createDefaultEmbedder } from "./embedder-default.js";
import { withProjectLock } from "./project-lock.js";
import { withRetrievalDatabase } from "./postgres-engine.js";
import { checkPostgresVectorIndex, pruneOrphanConcepts, readIndexedProjections, rebuildPostgresVectorIndex, tables } from "./postgres-store.js";
import { inspectRetrievalIndex, withSyncedRetrieval } from "./retrieval-index.js";
import { projectionKnowledge, resolveKnowledge } from "./knowledge.js";
import { loadKnowledgeDocuments } from "./knowledge-service.js";
import { relationshipsToEdges } from "./graph-mapping.js";

export interface GraphAuditOutput {
  result: "clean" | "issues_found";
  summary: { documents: number; postgres_documents: number; postgres_chunks: number; vector_index_ok: boolean };
  issues: { missing_documents: string[]; stale_documents: string[]; missing_concepts: Array<{ document_id: string; concept_id: string }>; missing_edges: Array<{ document_id: string; from: string; to: string; label: string }>; orphan_concepts: Array<{ id: string; name: string }>; vector_index: Array<{ message: string }> };
  checked_at: string;
}

export async function auditGraph(root: string): Promise<GraphAuditOutput> {
  return withProjectLock(root, async () => {
    if (!(await inspectRetrievalIndex(root)).available) throw new Error("retrieval store is missing or unavailable; run docnexus index sync");
    return (await withRetrievalDatabase(root, async db => {
      const t = tables(db);
      const documents = await loadKnowledgeDocuments(root);
      const knowledge = resolveKnowledge(documents);
      const indexed = await readIndexedProjections(db);
      const mentions = await db.query<{ document_id: string; concept_id: string }>(`SELECT * FROM ${t.mentions}`);
      const edges = await db.query<{ document_id: string; from_id: string; to_id: string; label: string }>(`SELECT document_id,from_id,to_id,label FROM ${t.edges}`);
      const vector = await checkPostgresVectorIndex(root);
      const issues: GraphAuditOutput["issues"] = {
        missing_documents: documents.filter(d => !indexed.some(row => row.id === d.id)).map(d => d.id),
        stale_documents: indexed.filter(row => !documents.some(d => d.id === row.id)).map(row => row.id),
        missing_concepts: [], missing_edges: [],
        orphan_concepts: await db.query(`SELECT c.id,c.name FROM ${t.concepts} c WHERE NOT EXISTS(SELECT 1 FROM ${t.mentions} m WHERE m.concept_id=c.id) AND NOT EXISTS(SELECT 1 FROM ${t.edges} e WHERE e.from_id=c.id OR e.to_id=c.id)`),
        vector_index: vector.ok ? [] : [{ message: vector.message ?? "HNSW index is unhealthy" }]
      };
      for (const document of documents) {
        if (issues.missing_documents.includes(document.id)) continue;
        const graph = relationshipsToEdges(projectionKnowledge(knowledge, document).metadata);
        for (const concept of graph.concepts) if (!mentions.some(m => m.document_id === document.id && m.concept_id === concept.id)) issues.missing_concepts.push({ document_id: document.id, concept_id: concept.id });
        for (const edge of graph.edges) if (!edges.some(e => e.document_id === document.id && e.from_id === edge.from && e.to_id === edge.to && e.label === edge.label)) issues.missing_edges.push({ document_id: document.id, from: edge.from, to: edge.to, label: edge.label });
      }
      return { result: Object.values(issues).some(rows => rows.length) ? "issues_found" as const : "clean" as const, summary: { documents: documents.length, postgres_documents: indexed.length, postgres_chunks: indexed.reduce((sum, d) => sum + d.chunk_count, 0), vector_index_ok: vector.ok }, issues, checked_at: new Date().toISOString() };
    }))!;
  });
}

export async function repairGraph(root: string, options: { force: boolean }) {
  if (!options.force) throw new Error("graph repair requires --force");
  const startedAt = new Date().toISOString();
  // Forced projection reconciliation reuses unchanged vectors and repairs graph declarations.
  return withSyncedRetrieval(root, { all: true }, createDefaultEmbedder(root), async (_db, _snapshot, synced) => {
    await withRetrievalDatabase(root, pruneOrphanConcepts);
    const health = await checkPostgresVectorIndex(root);
    if (!health.ok) await rebuildPostgresVectorIndex(root);
    const after = await auditGraph(root);
    return { result: after.result === "clean" ? "completed" : "completed_with_remaining_issues", actions: { resynced_documents: synced.rebuilt_documents, deleted_stale_documents: synced.removed_documents, rebuilt_vector_index: !health.ok }, after, started_at: startedAt, finished_at: new Date().toISOString() };
  });
}
