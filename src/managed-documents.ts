import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { chunkText } from "./chunker.js";
import { createDefaultEmbedder } from "./embedder-default.js";
import type { Embedder } from "./embedder.js";
import { relationshipsToEdges } from "./graph-mapping.js";
import { sha256, stableJson } from "./hash.js";
import { createChunkId, createDocumentId } from "./ids.js";
import { assertValidMetadata, metadataSchema } from "./metadata.js";
import type { DocNexusMetadata, ManagedChunk, ManagedDocument, StoreStatus, StoredRecordSummary } from "./types.js";

export const CURRENT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    document_hash TEXT NOT NULL,
    metadata_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sidecar_path TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS file_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    embedding_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    UNIQUE (document_id, chunk_index)
  );
`;

export function storePath(projectRoot: string): string {
  return join(projectRoot, ".docnexus");
}

export function documentsPath(projectRoot: string): string {
  return join(storePath(projectRoot), "documents");
}

export function databasePath(projectRoot: string): string {
  return join(storePath(projectRoot), "index.sqlite");
}

function schemasPath(projectRoot: string): string {
  return join(storePath(projectRoot), "schemas");
}

export function openManagedDatabase(projectRoot: string): DatabaseSync {
  return new DatabaseSync(databasePath(projectRoot));
}

export interface ManagedDocumentWriteInput {
  file_path: string;
  source: string;
  document: string;
  metadata: DocNexusMetadata;
}

export interface ManagedDocumentWriteResult {
  id: string;
  file_path: string;
  operation: "created" | "updated";
  chunk_count: number;
  updated_at: string;
}

export interface ManagedGraphWriteInput {
  document: ManagedDocument;
  chunks: ManagedChunk[];
  metadata: DocNexusMetadata;
}

export interface ManagedGraphWriter {
  replaceDocumentGraph(projectRoot: string, input: ManagedGraphWriteInput): Promise<void>;
  deleteDocumentGraph(projectRoot: string, documentId: string): Promise<void>;
}

export interface DeleteManagedDocumentInput {
  id?: string;
  file_path?: string;
  confirm: boolean;
}

export interface ManagedIndexStatusOutput {
  document_count: number;
  chunk_count: number;
}

export interface ListManagedRecordsInput {
  limit?: number;
  tag?: string;
}

export type ManagedRecordAsset = "source" | "document" | "metadata";

export interface RebuildManagedDocumentsOutput {
  result: "completed" | "completed_with_errors";
  processed_documents: number;
  rebuilt_documents: number;
  failed_documents: Array<{ document_id: string; file_path: string; error: string }>;
  started_at: string;
  finished_at: string;
}

interface DocumentRow {
  id: string;
  file_path: string;
  title: string;
  summary: string;
  tags_json: string;
  source_hash: string;
  document_hash: string;
  metadata_hash: string;
  created_at: string;
  updated_at: string;
  sidecar_path: string;
}

interface ChunkRow {
  id: string;
  document_id: string;
  chunk_index: number;
  text: string;
  text_hash: string;
  embedding_json: string;
  created_at: string;
}

interface CurrentSnapshot {
  row?: DocumentRow;
  chunks: ChunkRow[];
  target?: string;
  source?: string;
  metadata?: string;
}

const defaultGraphWriter: ManagedGraphWriter = {
  async replaceDocumentGraph(projectRoot, input) {
    const graph = await import("./ladybug-store.js");
    const mapping = relationshipsToEdges(input.metadata);
    await graph.replaceDocumentGraph(projectRoot, {
      project: { id: "project", name: basename(projectRoot), root_path: resolve(projectRoot) },
      document: {
        id: input.document.id,
        title: input.document.title,
        path: input.document.file_path,
        summary: input.document.summary,
        content_hash: input.document.document_hash,
        updated_at: input.document.updated_at
      },
      chunks: input.chunks.map((chunk) => ({
        id: chunk.id,
        document_id: input.document.id,
        text: chunk.text,
        text_hash: chunk.text_hash,
        chunk_index: chunk.chunk_index,
        embedding: chunk.embedding
      })),
      concepts: mapping.concepts,
      edges: mapping.edges
    });
  },
  async deleteDocumentGraph(projectRoot, documentId) {
    const graph = await import("./ladybug-store.js");
    await graph.deleteDocumentGraph(projectRoot, documentId);
  }
};

export async function ensureManagedStore(projectRoot: string): Promise<void> {
  await mkdir(documentsPath(projectRoot), { recursive: true });
  await mkdir(schemasPath(projectRoot), { recursive: true });
  await writeFile(join(schemasPath(projectRoot), "metadata.schema.json"), `${stableJson(metadataSchema)}\n`);

  const db = openManagedDatabase(projectRoot);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(CURRENT_SCHEMA_SQL);
  } finally {
    db.close();
  }
}

export async function upsertManagedDocument(
  projectRoot: string,
  input: ManagedDocumentWriteInput,
  embedder: Embedder = createDefaultEmbedder(),
  graphWriter: ManagedGraphWriter = defaultGraphWriter
): Promise<ManagedDocumentWriteResult> {
  if (typeof input.source !== "string" || typeof input.document !== "string" || !input.metadata) {
    throw new Error("source, document, and metadata are required");
  }
  assertValidMetadata(input.metadata);
  const resolved = resolveManagedTarget(projectRoot, input.file_path);
  await ensureManagedStore(projectRoot);

  const db = openManagedDatabase(projectRoot);
  let existing: DocumentRow | undefined;
  try {
    existing = getDocumentRowByPath(db, resolved.relativePath);
  } finally {
    db.close();
  }

  const currentTarget = await readIfExists(resolved.absolutePath);
  if (!existing && currentTarget !== undefined) {
    throw new Error("unmanaged file already exists at file_path");
  }
  if (existing && (currentTarget === undefined || sha256(currentTarget) !== existing.document_hash)) {
    throw new Error("managed target was externally modified");
  }

  const now = new Date().toISOString();
  const id = existing?.id ?? createDocumentId();
  const metadataJson = stableJson(input.metadata);
  const sidecarRelativePath = `.docnexus/documents/${id}`;
  const row: DocumentRow = {
    id,
    file_path: resolved.relativePath,
    title: input.metadata.title,
    summary: input.metadata.summary,
    tags_json: JSON.stringify(input.metadata.tags),
    source_hash: sha256(input.source),
    document_hash: sha256(input.document),
    metadata_hash: sha256(metadataJson),
    created_at: existing?.created_at ?? now,
    updated_at: now,
    sidecar_path: sidecarRelativePath
  };
  const chunks: ManagedChunk[] = [];
  for (const chunk of chunkText(input.document)) {
    const embedding = await embedder.embed(chunk.text);
    if (embedding.length !== embedder.dimension) {
      throw new Error("embedding dimension mismatch");
    }
    chunks.push({
      id: createChunkId(),
      document_id: id,
      chunk_index: chunk.index,
      text: chunk.text,
      text_hash: chunk.text_hash,
      embedding,
      created_at: now
    });
  }

  const snapshot = await snapshotCurrent(projectRoot, row, existing, currentTarget);
  let graphWriteStarted = false;
  try {
    await writeCurrentFiles(projectRoot, row, input.source, input.document, metadataJson);
    replaceDocumentState(projectRoot, row, chunks);
    const document = fromDocumentRow(row);
    graphWriteStarted = true;
    await graphWriter.replaceDocumentGraph(projectRoot, { document, chunks, metadata: input.metadata });
  } catch (error) {
    await restoreCurrent(projectRoot, row, snapshot);
    if (graphWriteStarted) {
      try {
        if (snapshot.row) {
          await graphWriter.replaceDocumentGraph(projectRoot, {
            document: fromDocumentRow(snapshot.row),
            chunks: snapshot.chunks.map(fromChunkRow),
            metadata: JSON.parse(snapshot.metadata as string) as DocNexusMetadata
          });
        } else {
          await graphWriter.deleteDocumentGraph(projectRoot, row.id);
        }
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "graph write failed and prior graph state could not be restored"
        );
      }
    }
    throw error;
  }

  return {
    id,
    file_path: row.file_path,
    operation: existing ? "updated" : "created",
    chunk_count: chunks.length,
    updated_at: now
  };
}

export async function listManagedDocuments(projectRoot: string): Promise<ManagedDocument[]> {
  const db = openManagedDatabase(projectRoot);
  try {
    return (db.prepare("SELECT * FROM documents ORDER BY updated_at DESC").all() as unknown as DocumentRow[]).map(fromDocumentRow);
  } finally {
    db.close();
  }
}

export async function listManagedRecords(
  projectRoot: string,
  input: ListManagedRecordsInput = {}
): Promise<{ records: StoredRecordSummary[] }> {
  const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 100) : 50;
  const documents = (await listManagedDocuments(projectRoot))
    .filter((document) => !input.tag || document.tags.includes(input.tag))
    .slice(0, limit)
    .map((document) => ({
      id: document.id,
      file_path: document.file_path,
      title: document.title,
      summary: document.summary,
      tags: document.tags,
      updated_at: document.updated_at
    }));
  return { records: documents };
}

export async function getManagedRecord(
  projectRoot: string,
  id: string,
  include: ManagedRecordAsset[] = ["source", "document", "metadata"]
): Promise<{ id: string; file_path: string; source?: string; document?: string; metadata?: DocNexusMetadata }> {
  const document = (await listManagedDocuments(projectRoot)).find((value) => value.id === id);
  if (!document) {
    throw new Error(`Unknown document id: ${id}`);
  }
  const output: { id: string; file_path: string; source?: string; document?: string; metadata?: DocNexusMetadata } = {
    id,
    file_path: document.file_path
  };
  if (include.includes("source")) {
    output.source = await readFile(join(projectRoot, document.sidecar_path, "source.md"), "utf8");
  }
  if (include.includes("document")) {
    output.document = await readFile(join(projectRoot, document.file_path), "utf8");
  }
  if (include.includes("metadata")) {
    output.metadata = JSON.parse(await readFile(join(projectRoot, document.sidecar_path, "metadata.json"), "utf8")) as DocNexusMetadata;
  }
  return output;
}

export async function getManagedStatus(projectRoot: string): Promise<StoreStatus> {
  const documents = await listManagedDocuments(projectRoot);
  return {
    project_root: projectRoot,
    store_path: storePath(projectRoot),
    initialized: true,
    document_count: documents.length
  };
}

export async function listManagedChunks(projectRoot: string, documentId: string): Promise<ManagedChunk[]> {
  const db = openManagedDatabase(projectRoot);
  try {
    const rows = db
      .prepare("SELECT * FROM file_chunks WHERE document_id = ? ORDER BY chunk_index ASC")
      .all(documentId) as unknown as ChunkRow[];
    return rows.map(fromChunkRow);
  } finally {
    db.close();
  }
}

export async function deleteManagedDocument(
  projectRoot: string,
  input: DeleteManagedDocumentInput,
  graphWriter: ManagedGraphWriter = defaultGraphWriter
): Promise<{ id: string; file_path: string; deleted: true }> {
  if (!input.confirm) {
    throw new Error("document deletion requires explicit confirmation");
  }
  if (Number(Boolean(input.id)) + Number(Boolean(input.file_path)) !== 1) {
    throw new Error("provide exactly one of id or file_path");
  }
  const db = openManagedDatabase(projectRoot);
  let row: DocumentRow | undefined;
  try {
    row = input.id
      ? db.prepare("SELECT * FROM documents WHERE id = ?").get(input.id) as DocumentRow | undefined
      : getDocumentRowByPath(db, resolveManagedTarget(projectRoot, input.file_path as string).relativePath);
  } finally {
    db.close();
  }
  if (!row) {
    throw new Error("managed document not found");
  }
  const target = await readIfExists(join(projectRoot, row.file_path));
  if (target === undefined || sha256(target) !== row.document_hash) {
    throw new Error("managed target was externally modified");
  }
  const snapshot = await snapshotCurrent(projectRoot, row, row, target);
  const metadata = JSON.parse(snapshot.metadata as string) as DocNexusMetadata;
  try {
    await graphWriter.deleteDocumentGraph(projectRoot, row.id);
    await rm(join(projectRoot, row.file_path), { force: true });
    await rm(join(projectRoot, row.sidecar_path), { recursive: true, force: true });
    const deleteDb = openManagedDatabase(projectRoot);
    try {
      deleteDb.exec("PRAGMA foreign_keys = ON; BEGIN");
      deleteDb.prepare("DELETE FROM file_chunks WHERE document_id = ?").run(row.id);
      deleteDb.prepare("DELETE FROM documents WHERE id = ?").run(row.id);
      deleteDb.exec("COMMIT");
    } catch (error) {
      try {
        deleteDb.exec("ROLLBACK");
      } catch {
        // Transaction may already be closed.
      }
      throw error;
    } finally {
      deleteDb.close();
    }
  } catch (error) {
    await restoreCurrent(projectRoot, row, snapshot);
    try {
      await graphWriter.replaceDocumentGraph(projectRoot, {
        document: fromDocumentRow(row),
        chunks: snapshot.chunks.map(fromChunkRow),
        metadata
      });
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "document deletion failed and prior graph state could not be restored"
      );
    }
    throw error;
  }
  return { id: row.id, file_path: row.file_path, deleted: true };
}

export async function listManagedTargetPathsForReset(projectRoot: string): Promise<string[]> {
  const db = openManagedDatabase(projectRoot);
  try {
    return (db.prepare("SELECT file_path FROM documents ORDER BY file_path ASC").all() as unknown as Array<{ file_path: string }>)
      .map((row) => row.file_path);
  } finally {
    db.close();
  }
}

export async function getManagedIndexStatus(projectRoot: string): Promise<ManagedIndexStatusOutput> {
  const db = openManagedDatabase(projectRoot);
  try {
    const documents = db.prepare("SELECT COUNT(*) AS count FROM documents").get() as { count: number };
    const chunks = db.prepare("SELECT COUNT(*) AS count FROM file_chunks").get() as { count: number };
    return { document_count: documents.count, chunk_count: chunks.count };
  } finally {
    db.close();
  }
}

export async function rebuildManagedDocuments(
  projectRoot: string,
  options: { force: boolean },
  embedder: Embedder = createDefaultEmbedder(),
  graphWriter: ManagedGraphWriter = defaultGraphWriter
): Promise<RebuildManagedDocumentsOutput> {
  if (!options.force) {
    throw new Error("rebuild requires --force");
  }
  const startedAt = new Date().toISOString();
  const documents = await listManagedDocuments(projectRoot);
  const failures: RebuildManagedDocumentsOutput["failed_documents"] = [];
  let rebuilt = 0;

  for (const document of documents) {
    try {
      const sidecar = join(projectRoot, document.sidecar_path);
      const source = await readFile(join(sidecar, "source.md"), "utf8");
      const metadata = JSON.parse(await readFile(join(sidecar, "metadata.json"), "utf8")) as DocNexusMetadata;
      const current = await readFile(join(projectRoot, document.file_path), "utf8");
      if (sha256(current) !== document.document_hash) {
        throw new Error("managed target was externally modified");
      }
      await upsertManagedDocument(
        projectRoot,
        { file_path: document.file_path, source, document: current, metadata },
        embedder,
        graphWriter
      );
      rebuilt += 1;
    } catch (error) {
      failures.push({
        document_id: document.id,
        file_path: document.file_path,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return {
    result: failures.length > 0 ? "completed_with_errors" : "completed",
    processed_documents: documents.length,
    rebuilt_documents: rebuilt,
    failed_documents: failures,
    started_at: startedAt,
    finished_at: new Date().toISOString()
  };
}

export async function removeManagedTargetForReset(projectRoot: string, filePath: string): Promise<void> {
  const target = resolveManagedTarget(projectRoot, filePath);
  await rm(target.absolutePath, { force: true });
}

export async function getManagedSchemaTables(projectRoot: string): Promise<string[]> {
  const db = openManagedDatabase(projectRoot);
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
  } finally {
    db.close();
  }
}

function resolveManagedTarget(projectRoot: string, filePath: string): { absolutePath: string; relativePath: string } {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new Error("file_path is required");
  }
  if (isAbsolute(filePath) || extname(filePath).toLowerCase() !== ".md") {
    throw new Error("file_path must be a project-relative Markdown path");
  }
  const root = resolve(projectRoot);
  const absolutePath = resolve(root, filePath);
  const relativePath = relative(root, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("file_path must remain inside the project root");
  }
  return { absolutePath, relativePath: relativePath.split(sep).join("/") };
}

function getDocumentRowByPath(db: DatabaseSync, filePath: string): DocumentRow | undefined {
  return db.prepare("SELECT * FROM documents WHERE file_path = ?").get(filePath) as DocumentRow | undefined;
}

async function readIfExists(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
}

async function snapshotCurrent(
  projectRoot: string,
  row: DocumentRow,
  existing: DocumentRow | undefined,
  target: string | undefined
): Promise<CurrentSnapshot> {
  if (!existing) {
    return { chunks: [], target };
  }
  const db = openManagedDatabase(projectRoot);
  let chunks: ChunkRow[];
  try {
    chunks = db.prepare("SELECT * FROM file_chunks WHERE document_id = ? ORDER BY chunk_index").all(existing.id) as unknown as ChunkRow[];
  } finally {
    db.close();
  }
  const sidecar = join(projectRoot, existing.sidecar_path);
  return {
    row: existing,
    chunks,
    target,
    source: await readIfExists(join(sidecar, "source.md")),
    metadata: await readIfExists(join(sidecar, "metadata.json"))
  };
}

async function writeCurrentFiles(
  projectRoot: string,
  row: DocumentRow,
  source: string,
  document: string,
  metadataJson: string
): Promise<void> {
  await atomicWrite(join(projectRoot, row.file_path), document);
  const sidecar = join(projectRoot, row.sidecar_path);
  await atomicWrite(join(sidecar, "source.md"), source);
  await atomicWrite(join(sidecar, "metadata.json"), `${metadataJson}\n`);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.docnexus-tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tempPath, content);
  await rename(tempPath, path);
}

function replaceDocumentState(projectRoot: string, row: DocumentRow, chunks: ManagedChunk[]): void {
  const db = openManagedDatabase(projectRoot);
  try {
    db.exec("PRAGMA foreign_keys = ON; BEGIN");
    db.prepare("DELETE FROM file_chunks WHERE document_id = ?").run(row.id);
    db.prepare(`
      INSERT INTO documents (
        id, file_path, title, summary, tags_json, source_hash, document_hash, metadata_hash, created_at, updated_at, sidecar_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        file_path = excluded.file_path,
        title = excluded.title,
        summary = excluded.summary,
        tags_json = excluded.tags_json,
        source_hash = excluded.source_hash,
        document_hash = excluded.document_hash,
        metadata_hash = excluded.metadata_hash,
        updated_at = excluded.updated_at,
        sidecar_path = excluded.sidecar_path
    `).run(
      row.id,
      row.file_path,
      row.title,
      row.summary,
      row.tags_json,
      row.source_hash,
      row.document_hash,
      row.metadata_hash,
      row.created_at,
      row.updated_at,
      row.sidecar_path
    );
    for (const chunk of chunks) {
      db.prepare(`
        INSERT INTO file_chunks (id, document_id, chunk_index, text, text_hash, embedding_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        chunk.id,
        chunk.document_id,
        chunk.chunk_index,
        chunk.text,
        chunk.text_hash,
        JSON.stringify(chunk.embedding),
        chunk.created_at
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Transaction may have failed before it began.
    }
    throw error;
  } finally {
    db.close();
  }
}

async function restoreCurrent(projectRoot: string, row: DocumentRow, snapshot: CurrentSnapshot): Promise<void> {
  const target = join(projectRoot, row.file_path);
  const sidecar = join(projectRoot, row.sidecar_path);
  if (snapshot.row) {
    await atomicWrite(target, snapshot.target as string);
    await atomicWrite(join(sidecar, "source.md"), snapshot.source as string);
    await atomicWrite(join(sidecar, "metadata.json"), snapshot.metadata as string);
    const chunks = snapshot.chunks.map(fromChunkRow);
    replaceDocumentState(projectRoot, snapshot.row, chunks);
    return;
  }
  await rm(target, { force: true });
  await rm(sidecar, { recursive: true, force: true });
  const db = openManagedDatabase(projectRoot);
  try {
    db.prepare("DELETE FROM file_chunks WHERE document_id = ?").run(row.id);
    db.prepare("DELETE FROM documents WHERE id = ?").run(row.id);
  } finally {
    db.close();
  }
}

function fromDocumentRow(row: DocumentRow): ManagedDocument {
  return {
    id: row.id,
    file_path: row.file_path,
    title: row.title,
    summary: row.summary,
    tags: JSON.parse(row.tags_json) as string[],
    source_hash: row.source_hash,
    document_hash: row.document_hash,
    metadata_hash: row.metadata_hash,
    created_at: row.created_at,
    updated_at: row.updated_at,
    sidecar_path: row.sidecar_path
  };
}

function fromChunkRow(row: ChunkRow): ManagedChunk {
  return {
    id: row.id,
    document_id: row.document_id,
    chunk_index: row.chunk_index,
    text: row.text,
    text_hash: row.text_hash,
    embedding: JSON.parse(row.embedding_json) as number[],
    created_at: row.created_at
  };
}
