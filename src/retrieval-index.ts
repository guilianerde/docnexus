import { embedText } from "./embedder.js";
import { documentAnchor, factAnchor, recordVersion } from "./source-anchor.js";
import { asDocNexusError, DocNexusError } from "./errors.js";
import { loadWorkspaceSnapshot, type WorkspaceSnapshot } from "./workspace-snapshot.js";
import { randomUUID } from "node:crypto";
import { withProjectLock } from "./project-lock.js";
import { CHUNKING_SIGNATURE, chunkText } from "./chunker.js";
import { createDefaultEmbedder } from "./embedder-default.js";
import type { Embedder } from "./embedder.js";
import { EMBEDDING_DIMENSION } from "./embedding-config.js";
import { relationshipsToEdges } from "./graph-mapping.js";
import { sha256, stableJson } from "./hash.js";
import { createChunkId } from "./ids.js";
import { listRecordFiles, refreshFactViews } from "./managed-documents.js";
import type { ManagedChunk } from "./types.js";
import { projectionKnowledge, resolveKnowledge } from "./knowledge.js";
import { loadKnowledgeDocuments } from "./knowledge-service.js";
import { withRetrievalDatabase, type RetrievalDatabase } from "./postgres-engine.js";
import { deletePostgresDocument, ensurePostgresStore, inspectProjectionSchema, readChunks, readIndexedProjections, readIndexState, replacePostgresProjection, writeIndexState } from "./postgres-store.js";
import { addUsageMetric } from "./usage-metrics.js";

export interface RetrievalIndexState {
  available: boolean; record_count: number; indexed_count: number; chunk_count: number;
  unindexed: string[]; outdated: string[]; orphaned: string[]; in_sync: boolean; message?: string;
  schema_version?: string | null; expected_schema_version?: number; schema_status?: "missing" | "legacy" | "current" | "unsupported";
}
export interface IndexSyncResult {
  result: "completed"; processed_documents: number; rebuilt_documents: number; removed_documents: number;
  embedded_chunks: number; reused_chunks: number;
}

export async function ensureRetrievalStore(root: string): Promise<void> {
  await withProjectLock(root, async () => { await withRetrievalDatabase(root, ensurePostgresStore); });
}

/** Never creates a missing database or loads an embedding model. */
export async function inspectRetrievalIndex(root: string, at = new Date().toISOString(), snapshot?: WorkspaceSnapshot): Promise<RetrievalIndexState> {
  return withProjectLock(root, async () => {
    const records = snapshot?.records ?? await listRecordFiles(root);
    const documents = snapshot?.documents ?? await loadKnowledgeDocuments(root);
    const knowledge = snapshot?.knowledge ?? resolveKnowledge(documents, at);
    const versions = new Map(records.map(record => [record.id, sha256(stableJson(record))]));
    const expected = new Map(documents.map(document => [document.id, anchoredProjectionSignature(snapshot?.projectDocument(document.id) ?? projectionKnowledge(knowledge, document), versions)]));
    const missing: RetrievalIndexState = { available: false, record_count: records.length, indexed_count: 0, chunk_count: 0, unindexed: records.map(r => r.id), outdated: [], orphaned: [], in_sync: records.length === 0 };
    try {
      return (await withRetrievalDatabase(root, async db => {
        const schema = await inspectProjectionSchema(db);
        const version = { schema_version: schema.version, expected_schema_version: schema.expected_version, schema_status: schema.status };
        if (schema.status === "missing") return { ...missing, ...version };
        if (schema.status !== "current") return { ...missing, ...version, available: true, in_sync: false,
          message: schema.status === "legacy" ? "retrieval projection needs rebuilding; run docnexus index sync" : "incompatible retrieval projection; use a compatible DocNexus release" };
        const indexed = await readIndexedProjections(db);
        const state = await readIndexState(db);
        const byId = new Map(indexed.map(row => [row.id, row]));
        const ids = new Set(records.map(r => r.id));
        const unindexed = records.filter(r => !byId.has(r.id)).map(r => r.id);
        const outdated = records.filter(r => {
          const row = byId.get(r.id);
          return row && (state.get("chunking_signature") !== CHUNKING_SIGNATURE || row.projection_signature !== expected.get(r.id) || row.document_hash !== r.document_hash || row.metadata_hash !== r.metadata_hash || row.record_version !== sha256(stableJson(r)) || row.file_path !== r.file_path || row.chunk_count === 0 || row.missing_anchor_count > 0);
        }).map(r => r.id);
        const orphaned = indexed.filter(row => !ids.has(row.id)).map(row => row.id);
        return { ...version, available: true, record_count: records.length, indexed_count: indexed.length, chunk_count: indexed.reduce((sum, row) => sum + row.chunk_count, 0), unindexed, outdated, orphaned, in_sync: unindexed.length + outdated.length + orphaned.length === 0 };
      }, false)) ?? missing;
    } catch (error) { return { ...missing, in_sync: false, message: (error as Error).message }; }
  });
}

export async function syncRetrievalIndex(root: string, options: { all?: boolean } = {}, embedder: Embedder = createDefaultEmbedder(root)): Promise<IndexSyncResult> {
  return withSyncedRetrieval(root, options, embedder, async (_db, _snapshot, result) => result);
}

/** Compute outside the project lock, then validate and commit before using the projection. */
export async function withSyncedRetrieval<T>(root: string, options: { all?: boolean }, embedder: Embedder,
  operation: (db: RetrievalDatabase, snapshot: WorkspaceSnapshot, result: IndexSyncResult) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    addUsageMetric("sync_attempts");
    const snapshot = await loadWorkspaceSnapshot(root).catch((error: Error) => {
      const failure = asDocNexusError(error, "text_integrity_error");
      if (failure.code !== "text_integrity_error") throw failure;
      throw new DocNexusError("text_integrity_error", `memory text is missing, invalid or externally modified; run doctor and document sync before indexing: ${failure.message}`);
    });
    const { records, documents } = snapshot;
    const tokenBudget = records.length ? await embedder.tokenBudget?.().catch(error => { throw asDocNexusError(error, "embedding_failed"); }) : undefined;
    let signature: string | undefined;
    if (records.length) {
      if (embedder.dimension !== EMBEDDING_DIMENSION) throw new DocNexusError("embedding_failed", "embedding dimension mismatch");
      const probe = await embedText(embedder, "DocNexus embedding model signature");
      validateEmbedding(probe);
      signature = sha256(JSON.stringify({ probe, tokenLimit: tokenBudget?.maxTokens ?? null }));
    }
    const versions = new Map(records.map(record => [record.id, snapshot.recordVersion(record.id)]));
    const projections = new Map(documents.map(document => {
      const projection = snapshot.projectDocument(document.id);
      return [document.id, { ...projection, signature: anchoredProjectionSignature(projection, versions) }] as const;
    }));
    const plan = await withProjectLock(root, async () => (await withRetrievalDatabase(root, async db => {
      await ensurePostgresStore(db);
      const state = await inspectRetrievalIndex(root, snapshot.at, snapshot);
      const stored = await readIndexState(db);
      signature ??= stored.get("embedding_signature") ?? "";
      const modelChanged = records.length > 0 && signature !== stored.get("embedding_signature");
      const pending = options.all || modelChanged ? records : records.filter(r => state.unindexed.includes(r.id) || state.outdated.includes(r.id));
      const previous = new Map<string, Awaited<ReturnType<typeof readChunks>>>();
      for (const record of pending) previous.set(record.id, await readChunks(db, record.id));
      return { pending, orphaned: state.orphaned, previous, generation: stored.get("index_generation"),
        stateChanged: modelChanged || stored.get("chunking_signature") !== CHUNKING_SIGNATURE };
    }))!);
    let embedded = 0, reused = 0;
    const prepared: Array<{ record: WorkspaceSnapshot["records"][number]; projection: ReturnType<typeof projectionKnowledge>; chunks: ManagedChunk[] }> = [];
    for (const record of plan.pending) {
      const projection = projections.get(record.id)!;
      const parts = chunkText(snapshot.sourceDocument(record.id).rendered, { tokenBudget }).map(part => ({ ...part,
        source_anchor: documentAnchor(snapshot, record.id, part.source_start, part.source_end) }));
      for (const fact of projection.facts) parts.push(...chunkText(`[${fact.id}] ${fact.text}\nSource: ${fact.provenance}\nValid from: ${fact.valid_from}`, { tokenBudget }).map(part => ({ ...part, source_anchor: factAnchor(snapshot, fact) })));
      const candidates = new Map<string, Awaited<ReturnType<typeof readChunks>>>();
      for (const chunk of plan.previous.get(record.id)!) {
        if (chunk.embedding_signature !== signature) continue;
        const rows = candidates.get(chunk.text_hash) ?? []; rows.push(chunk); candidates.set(chunk.text_hash, rows);
      }
      const chunks: ManagedChunk[] = [];
      for (const [index, part] of parts.entries()) {
        const bucket = candidates.get(part.text_hash);
        const matching = bucket?.findIndex(old => old.text === part.text) ?? -1;
        const old = matching >= 0 ? bucket!.splice(matching, 1)[0] : undefined;
        const embedding = old?.embedding ?? await embedText(embedder, part.text);
        validateEmbedding(embedding);
        old ? reused++ : embedded++;
        chunks.push({ id: old?.id ?? createChunkId(), document_id: record.id, chunk_index: index, text: part.text, text_hash: part.text_hash, embedding, created_at: old?.created_at ?? record.updated_at, source_anchor: part.source_anchor });
      }
      prepared.push({ record, projection, chunks });
    }
    const committed = await withProjectLock(root, async () => {
      // This also detects fact activation/expiry while the model was running.
      const current = await loadWorkspaceSnapshot(root);
      if (current.revision !== snapshot.revision) return { retry: true as const };
      return (await withRetrievalDatabase(root, async db => {
        await ensurePostgresStore(db);
        if ((await readIndexState(db)).get("index_generation") !== plan.generation) return { retry: true as const };
        await refreshFactViews(root, current);
        // Invalidate other prepared plans before the first per-document commit,
        // including when a later document fails and the batch is retried.
        if (prepared.length || plan.orphaned.length || plan.stateChanged) await writeIndexState(db, "index_generation", randomUUID());
        for (const id of plan.orphaned) await deletePostgresDocument(db, id);
        for (const { record, projection, chunks } of prepared) {
          await replacePostgresProjection(db, { ...record, record_version: recordVersion(snapshot, record.id), summary: projection.metadata.summary, tags: projection.metadata.tags, projection_signature: projection.signature }, chunks, relationshipsToEdges(projection.metadata), signature!);
        }
        // A failed batch retains old model/chunking signatures for the next sync.
        if (plan.stateChanged) await db.transaction(async tx => {
          if (signature) await writeIndexState(tx, "embedding_signature", signature);
          await writeIndexState(tx, "chunking_signature", CHUNKING_SIGNATURE);
        });
        const result: IndexSyncResult = { result: "completed", processed_documents: prepared.length, rebuilt_documents: prepared.length,
          removed_documents: plan.orphaned.length, embedded_chunks: embedded, reused_chunks: reused };
        addUsageMetric("sync_processed_documents", result.processed_documents);
        addUsageMetric("sync_embedded_chunks", result.embedded_chunks);
        addUsageMetric("sync_reused_chunks", result.reused_chunks);
        addUsageMetric("sync_removed_documents", result.removed_documents);
        return { retry: false as const, value: await operation(db, current, result) };
      }))!;
    });
    if (!committed.retry) return committed.value;
  }
  throw new DocNexusError("concurrent_update", "memory or retrieval index changed repeatedly during embedding; retry after current updates complete");
}

export async function removeIndexedDocument(root: string, id: string): Promise<void> {
  await withProjectLock(root, async () => {
    try { await withRetrievalDatabase(root, async db => {
      const schema = await inspectProjectionSchema(db);
      if (schema.status === "missing") return;
      if (schema.status !== "current") throw new DocNexusError(schema.status === "unsupported" ? "index_schema_incompatible" : "index_outdated", "derived deletion requires a compatible projection");
      await deletePostgresDocument(db, id);
    }, false); }
    catch { process.stderr.write("docnexus: derived deletion pending; next index sync will reconcile it from canonical text\n"); }
  });
}

export async function listIndexedChunks(root: string, id: string): Promise<ManagedChunk[]> {
  return withProjectLock(root, async () => (await withRetrievalDatabase(root, db => readChunks(db, id), false)) ?? []);
}

function validateEmbedding(embedding: number[]): void {
  if (embedding.length !== EMBEDDING_DIMENSION || !embedding.every(Number.isFinite)) throw new DocNexusError("embedding_failed", "embedding dimension mismatch or non-finite values");
}

function anchoredProjectionSignature(projection: ReturnType<typeof projectionKnowledge>, versions: Map<string, string>): string {
  const owners = [...new Set(projection.facts.map(fact => fact.document_id))].sort();
  return sha256(stableJson({ knowledge: projection.signature, fact_owners: owners.map(id => [id, versions.get(id)]) }));
}
