import { EMBEDDING_DIMENSION } from "./embedding-config.js";
import { withRetrievalDatabase, type RetrievalDatabase } from "./postgres-engine.js";
import { buildGroupedRecall, type GroupedRecallData, type RecallPrimaryMatch, type RecallPathCandidate, type RecallSupportingCandidate } from "./recall-groups.js";
import type { GraphMapping } from "./graph-mapping.js";
import type { ManagedChunk } from "./types.js";
import { withProjectLock } from "./project-lock.js";
import { randomUUID } from "node:crypto";
import { DocNexusError } from "./errors.js";
import type { SourceAnchor } from "./source-anchor.js";

export const PROJECTION_SCHEMA_VERSION = 2;

export async function inspectProjectionSchema(db: RetrievalDatabase) {
  const stateExists = (await db.query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [`${db.schema}.index_state`]))[0].present;
  const version = stateExists ? (await db.query<{ value: string }>(`SELECT value FROM ${tables(db).state} WHERE key='projection_schema_version'`))[0]?.value ?? null : null;
  if (version !== null && !["1", String(PROJECTION_SCHEMA_VERSION)].includes(version)) return { version, expected_version: PROJECTION_SCHEMA_VERSION, status: "unsupported" as const };
  if (!await hasRetrievalSchema(db)) return { version, expected_version: PROJECTION_SCHEMA_VERSION, status: stateExists ? "legacy" as const : "missing" as const };
  const shape = await db.query<{ present: boolean }>(`SELECT to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL
    AND to_regclass($3) IS NOT NULL AND to_regclass($4) IS NOT NULL
    AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=$5 AND table_name='chunks' AND column_name='source_anchor' AND data_type='jsonb')
    AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=$5 AND table_name='documents' AND column_name='record_version' AND data_type='text') AS present`,
  [`${db.schema}.chunks`, `${db.schema}.concepts`, `${db.schema}.document_concepts`, `${db.schema}.edges`, db.schema]);
  return { version, expected_version: PROJECTION_SCHEMA_VERSION, status: version === String(PROJECTION_SCHEMA_VERSION) && shape[0].present ? "current" as const : "legacy" as const };
}

export interface DocumentProjection {
  record_version?: string;
  id: string; file_path: string; title: string; summary: string; tags: string[];
  source_hash: string; document_hash: string; metadata_hash: string; created_at: string; updated_at: string;
  projection_signature: string;
}
export interface IndexedProjection extends DocumentProjection { chunk_count: number; missing_anchor_count: number }

export function tables(db: RetrievalDatabase) {
  const prefix = `"${db.schema}".`;
  return { documents: prefix + "documents", chunks: prefix + "chunks", concepts: prefix + "concepts", mentions: prefix + "document_concepts", edges: prefix + "edges", state: prefix + "index_state" };
}

export async function hasRetrievalSchema(db: RetrievalDatabase): Promise<boolean> {
  return (await db.query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [`${db.schema}.documents`]))[0].present;
}

export async function ensurePostgresStore(db: RetrievalDatabase): Promise<void> {
  const t = tables(db);
  await db.transaction(async tx => {
    // Different projects can initialize the shared pgvector extension concurrently.
    if (db.kind === "postgres") await tx.query("SELECT pg_advisory_xact_lock(680195, 1)");
    const schema = await inspectProjectionSchema(tx);
    if (schema.status === "unsupported") throw new DocNexusError("index_schema_incompatible", "retrieval projection was created by an incompatible version; use a compatible DocNexus release", schema);
    if (schema.status === "legacy") {
      // Drop only owned derived tables, without CASCADE into external dependencies.
      await tx.exec(`DROP TABLE IF EXISTS ${t.edges},${t.mentions},${t.chunks},${t.concepts},${t.documents},${t.state}`);
    }
    await tx.exec(`
    CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
    CREATE SCHEMA IF NOT EXISTS "${db.schema}";
    CREATE TABLE IF NOT EXISTS ${t.documents} (
      id TEXT PRIMARY KEY, file_path TEXT NOT NULL UNIQUE, title TEXT NOT NULL, summary TEXT NOT NULL,
      tags JSONB NOT NULL, source_hash TEXT NOT NULL, document_hash TEXT NOT NULL, metadata_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, projection_signature TEXT NOT NULL, record_version TEXT
    );
    CREATE TABLE IF NOT EXISTS ${t.chunks} (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES ${t.documents}(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL, text TEXT NOT NULL, text_hash TEXT NOT NULL,
      embedding public.vector(${EMBEDDING_DIMENSION}) NOT NULL, embedding_signature TEXT NOT NULL, created_at TEXT NOT NULL,
      source_anchor JSONB,
      UNIQUE (document_id, chunk_index) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX IF NOT EXISTS chunks_document_idx ON ${t.chunks}(document_id);
    CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON ${t.chunks} USING hnsw (embedding public.vector_cosine_ops);
    CREATE TABLE IF NOT EXISTS ${t.concepts} (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, description TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ${t.mentions} (
      document_id TEXT NOT NULL REFERENCES ${t.documents}(id) ON DELETE CASCADE,
      concept_id TEXT NOT NULL REFERENCES ${t.concepts}(id), PRIMARY KEY(document_id, concept_id)
    );
    CREATE TABLE IF NOT EXISTS ${t.edges} (
      document_id TEXT NOT NULL REFERENCES ${t.documents}(id) ON DELETE CASCADE,
      from_id TEXT NOT NULL REFERENCES ${t.concepts}(id), to_id TEXT NOT NULL REFERENCES ${t.concepts}(id),
      label TEXT NOT NULL, description TEXT NOT NULL, PRIMARY KEY(document_id, from_id, to_id, label)
    );
    CREATE INDEX IF NOT EXISTS edges_from_idx ON ${t.edges}(from_id);
    CREATE INDEX IF NOT EXISTS edges_to_idx ON ${t.edges}(to_id);
    CREATE TABLE IF NOT EXISTS ${t.state} (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
    if (schema.status !== "current") {
      await writeIndexState(tx, "projection_schema_version", String(PROJECTION_SCHEMA_VERSION));
      await writeIndexState(tx, "index_generation", randomUUID());
    }
  });
}

export async function readIndexedProjections(db: RetrievalDatabase): Promise<IndexedProjection[]> {
  const t = tables(db);
  const rows = await db.query<IndexedProjection>(`SELECT d.*, count(c.id)::int AS chunk_count,
    count(c.id) FILTER (WHERE c.source_anchor IS NULL OR c.source_anchor='null'::jsonb)::int AS missing_anchor_count
    FROM ${t.documents} d LEFT JOIN ${t.chunks} c ON c.document_id=d.id GROUP BY d.id ORDER BY d.file_path`);
  return rows;
}

export async function readIndexState(db: RetrievalDatabase): Promise<Map<string, string>> {
  return new Map((await db.query<{ key: string; value: string }>(`SELECT key,value FROM ${tables(db).state}`)).map(row => [row.key, row.value]));
}
export async function writeIndexState(db: RetrievalDatabase, key: string, value: string): Promise<void> {
  await db.query(`INSERT INTO ${tables(db).state}(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [key, value]);
}

export async function readChunks(db: RetrievalDatabase, documentId: string): Promise<Array<ManagedChunk & { embedding_signature: string }>> {
  const rows = await db.query<Omit<ManagedChunk, "embedding"> & { embedding: string; embedding_signature: string }>(`SELECT id,document_id,chunk_index,text,text_hash,embedding::text AS embedding,embedding_signature,created_at,source_anchor FROM ${tables(db).chunks} WHERE document_id=$1 ORDER BY chunk_index`, [documentId]);
  return rows.map(row => ({ ...row, embedding: JSON.parse(row.embedding) as number[] }));
}

/** All projection changes commit together; normal writes never drop or recreate HNSW. */
export async function replacePostgresProjection(db: RetrievalDatabase, document: DocumentProjection, chunks: ManagedChunk[], graph: GraphMapping, signature: string): Promise<void> {
  const t = tables(db);
  await db.transaction(async tx => {
    await tx.query(`INSERT INTO ${t.documents}(id,file_path,title,summary,tags,source_hash,document_hash,metadata_hash,created_at,updated_at,projection_signature,record_version)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT(id) DO UPDATE SET file_path=EXCLUDED.file_path,title=EXCLUDED.title,summary=EXCLUDED.summary,tags=EXCLUDED.tags,
      source_hash=EXCLUDED.source_hash,document_hash=EXCLUDED.document_hash,metadata_hash=EXCLUDED.metadata_hash,updated_at=EXCLUDED.updated_at,projection_signature=EXCLUDED.projection_signature,record_version=EXCLUDED.record_version`,
    [document.id, document.file_path, document.title, document.summary, JSON.stringify(document.tags), document.source_hash, document.document_hash, document.metadata_hash, document.created_at, document.updated_at, document.projection_signature, document.record_version ?? null]);
    await tx.query(`DELETE FROM ${t.chunks} WHERE document_id=$1 AND NOT(id=ANY($2::text[]))`, [document.id, chunks.map(chunk => chunk.id)]);
    for (const chunk of chunks) {
      const previous = await tx.query<{ id: string; text_hash: string; embedding_signature: string }>(`SELECT id,text_hash,embedding_signature FROM ${t.chunks} WHERE id=$1`, [chunk.id]);
      if (previous[0]?.text_hash === chunk.text_hash && previous[0]?.embedding_signature === signature) {
        // Position-only changes must not write the indexed vector column.
        await tx.query(`UPDATE ${t.chunks} SET chunk_index=$2,source_anchor=$3::jsonb WHERE id=$1 AND (chunk_index<>$2 OR source_anchor IS DISTINCT FROM $3::jsonb)`, [chunk.id, chunk.chunk_index, JSON.stringify(chunk.source_anchor ?? null)]);
      } else {
        await tx.query(`INSERT INTO ${t.chunks}(id,document_id,chunk_index,text,text_hash,embedding,embedding_signature,created_at,source_anchor)
          VALUES($1,$2,$3,$4,$5,$6::public.vector,$7,$8,$9::jsonb) ON CONFLICT(id) DO UPDATE SET chunk_index=EXCLUDED.chunk_index,text=EXCLUDED.text,text_hash=EXCLUDED.text_hash,embedding=EXCLUDED.embedding,embedding_signature=EXCLUDED.embedding_signature,source_anchor=EXCLUDED.source_anchor`,
        [chunk.id, document.id, chunk.chunk_index, chunk.text, chunk.text_hash, JSON.stringify(chunk.embedding), signature, chunk.created_at, JSON.stringify(chunk.source_anchor ?? null)]);
      }
    }
    await tx.query(`DELETE FROM ${t.edges} WHERE document_id=$1`, [document.id]);
    await tx.query(`DELETE FROM ${t.mentions} WHERE document_id=$1`, [document.id]);
    for (const concept of graph.concepts) {
      await tx.query(`INSERT INTO ${t.concepts}(id,name,type,description) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,description=EXCLUDED.description`, [concept.id, concept.name, concept.type, concept.description]);
      await tx.query(`INSERT INTO ${t.mentions}(document_id,concept_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [document.id, concept.id]);
    }
    for (const edge of graph.edges) await tx.query(`INSERT INTO ${t.edges}(document_id,from_id,to_id,label,description) VALUES($1,$2,$3,$4,$5)`, [document.id, edge.from, edge.to, edge.label, edge.description]);
    await pruneOrphanConcepts(tx);
  });
}

export async function pruneOrphanConcepts(db: RetrievalDatabase): Promise<void> {
  const t = tables(db);
  await db.query(`DELETE FROM ${t.concepts} c WHERE NOT EXISTS(SELECT 1 FROM ${t.mentions} m WHERE m.concept_id=c.id) AND NOT EXISTS(SELECT 1 FROM ${t.edges} e WHERE e.from_id=c.id OR e.to_id=c.id)`);
}

export async function deletePostgresDocument(db: RetrievalDatabase, id: string): Promise<void> {
  await db.transaction(async tx => {
    await tx.query(`DELETE FROM ${tables(db).documents} WHERE id=$1`, [id]);
    await pruneOrphanConcepts(tx);
  });
}

export async function checkPostgresVectorIndex(root: string) {
  try {
    const result = await withRetrievalDatabase(root, async db => {
      if (!await hasRetrievalSchema(db)) return { ok: false, message: "retrieval schema is missing" };
      const schema = await inspectProjectionSchema(db);
      if (schema.status !== "current") return { ok: false, message: `retrieval projection schema is ${schema.status}` };
      const rows = await db.query<{ valid: boolean }>(`SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='chunks_embedding_idx'`, [db.schema]);
      return rows[0]?.valid ? { ok: true } : { ok: false, message: "HNSW index is missing or invalid" };
    }, false);
    return result ?? { ok: false, message: "retrieval store is missing" };
  } catch (error) { return { ok: false, message: (error as Error).message }; }
}

export async function rebuildPostgresVectorIndex(root: string): Promise<void> {
  await withProjectLock(root, async () => {
    await withRetrievalDatabase(root, async db => { await ensurePostgresStore(db); await db.exec(`REINDEX INDEX "${db.schema}".chunks_embedding_idx`); });
  });
}

export interface VectorCandidate { id: string; document_id: string; score: number }

/** Fetch ranking evidence only. Expand neighbors and graph evidence after fusion. */
export async function findVectorCandidates(db: RetrievalDatabase, embedding: number[], limit: number, documentLevel = false, chunkIds?: string[]): Promise<VectorCandidate[]> {
  if (embedding.length !== EMBEDDING_DIMENSION || !embedding.every(Number.isFinite)) throw new Error("embedding dimension mismatch or non-finite values");
  const t = tables(db);
  const window = documentLevel ? limit * 5 : limit;
  const values = [JSON.stringify(embedding), window, ...(chunkIds ? [chunkIds] : [])];
  const hits = await db.query<VectorCandidate>(`SELECT id,document_id,1-(embedding <=> $1::public.vector) AS score FROM ${t.chunks}
    ${chunkIds ? "WHERE id=ANY($3::text[])" : ""} ORDER BY embedding <=> $1::public.vector LIMIT $2`, values);
  if (!documentLevel) return hits;
  const byDocument = new Map<string, VectorCandidate>();
  for (const hit of hits) if (!byDocument.has(hit.document_id)) byDocument.set(hit.document_id, hit);
  const unique = [...byDocument.values()].slice(0, limit);
  if (unique.length < limit && hits.length === window) {
    // A long document can fill the ANN window. Complete the document pool using
    // each remaining document's best chunk, without transferring its other chunks.
    const extra = await db.query<VectorCandidate>(`SELECT c.id,d.id AS document_id,1-(c.embedding <=> $1::public.vector) AS score
      FROM ${t.documents} d CROSS JOIN LATERAL (
        SELECT id,embedding FROM ${t.chunks} WHERE document_id=d.id ORDER BY embedding <=> $1::public.vector LIMIT 1
      ) c WHERE NOT(d.id=ANY($3::text[])) ORDER BY c.embedding <=> $1::public.vector,d.id LIMIT $2`,
    [JSON.stringify(embedding), limit - unique.length, unique.map(hit => hit.document_id)]);
    unique.push(...extra);
  }
  return unique.sort((a, b) => Number(b.score) - Number(a.score) || a.id.localeCompare(b.id));
}

export async function readChunkTexts(db: RetrievalDatabase, documentIds: string[]) {
  return db.query<{ id: string; document_id: string; chunk_index: number; text: string; source_anchor?: SourceAnchor }>(`SELECT id,document_id,chunk_index,text,source_anchor FROM ${tables(db).chunks} WHERE document_id=ANY($1::text[]) ORDER BY document_id,chunk_index`, [documentIds]);
}

export async function loadPostgresContext(db: RetrievalDatabase, candidates: VectorCandidate[]): Promise<GroupedRecallData> {
  if (!candidates.length) return { results: [], context_groups: [] };
  const t = tables(db);
  const details = await db.query<{ id: string; document_id: string; chunk_index: number; text: string; file_path: string; title: string; summary: string; source_anchor?: SourceAnchor }>(`
    SELECT c.id,c.document_id,c.chunk_index,c.text,c.source_anchor,d.file_path,d.title,d.summary
    FROM ${t.chunks} c JOIN ${t.documents} d ON d.id=c.document_id WHERE c.id=ANY($1::text[])`, [candidates.map(hit => hit.id)]);
  const ids = [...new Set(candidates.map(hit => hit.document_id))];
  const mentions = await db.query<{ document_id: string; name: string; concept_id: string }>(`SELECT m.document_id,c.name,c.id AS concept_id FROM ${t.mentions} m JOIN ${t.concepts} c ON c.id=m.concept_id WHERE m.document_id=ANY($1::text[]) ORDER BY c.name`, [ids]);
  const paths = await db.query<RecallPathCandidate>(`SELECT selected.document_id,evidence.* FROM unnest($1::text[]) AS selected(document_id) CROSS JOIN LATERAL (
    SELECT DISTINCT f.name AS "from",e.label AS relationship,d.name AS "to",owner.id AS source_document_id,owner.file_path AS source_path,e.description
    FROM ${t.mentions} m JOIN ${t.edges} e ON e.from_id=m.concept_id JOIN ${t.concepts} f ON f.id=e.from_id JOIN ${t.concepts} d ON d.id=e.to_id JOIN ${t.documents} owner ON owner.id=e.document_id
    WHERE m.document_id=selected.document_id ORDER BY f.name,e.label,d.name,owner.file_path LIMIT 5
  ) evidence ORDER BY selected.document_id,evidence."from",evidence.relationship,evidence."to",evidence.source_path`, [ids]);
  const supporting = await db.query<RecallSupportingCandidate>(`SELECT selected.document_id AS source_document_id,evidence.* FROM unnest($1::text[]) AS selected(document_id) CROSS JOIN LATERAL (
    SELECT DISTINCT d.id AS document_id,d.file_path AS path,d.title,c.id AS chunk_id,c.chunk_index,c.text,c.source_anchor,'graph_one_hop' AS reason
    FROM ${t.mentions} m JOIN ${t.edges} e ON e.from_id=m.concept_id JOIN ${t.mentions} other ON other.concept_id=e.to_id
    JOIN ${t.documents} d ON d.id=other.document_id JOIN ${t.chunks} c ON c.document_id=d.id
    WHERE m.document_id=selected.document_id AND d.id<>m.document_id ORDER BY path,chunk_index,chunk_id LIMIT 3
  ) evidence ORDER BY selected.document_id,evidence.path,evidence.chunk_index`, [ids]);
  const neighbors = await db.query<{ matched_id: string; id: string; chunk_index: number; text: string; source_anchor?: SourceAnchor }>(`SELECT hit.id AS matched_id,n.id,n.chunk_index,n.text,n.source_anchor FROM ${t.chunks} hit JOIN ${t.chunks} n ON n.document_id=hit.document_id AND n.chunk_index IN(hit.chunk_index-1,hit.chunk_index+1) WHERE hit.id=ANY($1::text[]) ORDER BY n.chunk_index`, [candidates.map(hit => hit.id)]);
  const byId = new Map(details.map(hit => [hit.id, hit]));
  const primary: RecallPrimaryMatch[] = candidates.map(candidate => {
    const hit = byId.get(candidate.id);
    if (!hit) throw new Error(`missing indexed chunk: ${candidate.id}`);
    return {
      matched_chunk: { chunk_id: hit.id, chunk_index: hit.chunk_index, text: hit.text, score: Number(candidate.score), ...(hit.source_anchor ? { source_anchor: hit.source_anchor } : {}) },
      document: { document_id: hit.document_id, path: hit.file_path, title: hit.title, summary: hit.summary },
      concepts: mentions.filter(m => m.document_id === hit.document_id).map(m => m.name),
      related_concepts: [...new Set(paths.filter(p => p.document_id === hit.document_id).map(p => p.to))],
      same_document_chunks: neighbors.filter(n => n.matched_id === hit.id).map(n => ({ chunk_id: n.id, chunk_index: n.chunk_index, text: n.text, ...(n.source_anchor ? { source_anchor: n.source_anchor } : {}), reason: n.chunk_index < hit.chunk_index ? "same_document_before" : "same_document_after" }))
    };
  });
  return buildGroupedRecall(primary, paths, supporting);
}

export async function recallFromPostgres(root: string, embedding: number[], limit: number, chunkIds?: string[]): Promise<GroupedRecallData> {
  return withProjectLock(root, async () => (await withRetrievalDatabase(root, async db =>
    loadPostgresContext(db, await findVectorCandidates(db, embedding, limit, false, chunkIds))))!);
}
