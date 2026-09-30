import { DatabaseSync } from "node:sqlite";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { chunkText } from "./chunker.js";
import { createDefaultEmbedder } from "./embedder-default.js";
import type { Embedder } from "./embedder.js";
import { relationshipsToEdges } from "./graph-mapping.js";
import { sha256, stableJson } from "./hash.js";
import { createChunkId, createDocumentId } from "./ids.js";
import {
  databasePath,
  libraryPath,
  recordRelativePath,
  recordsPath,
  schemasPath,
  storePath,
  WORKSPACE_DIRNAME,
  workspacePath
} from "./layout.js";
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

/** Identity and hashes of one managed document, stored as `docnexus/records/<id>/record.json`. */
export interface RecordFile {
  id: string;
  file_path: string;
  title: string;
  created_at: string;
  updated_at: string;
  source_hash: string;
  document_hash: string;
  metadata_hash: string;
}

export interface UpsertOptions {
  /** Accept the current library file even when it differs from the last ingested content. */
  acceptLibraryEdit?: boolean;
  /** Restore this record's identity when the index has no row for it yet (fresh clone, rebuild). */
  identity?: RecordFile;
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
  removed_documents: number;
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
  record?: string;
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
  await mkdir(storePath(projectRoot), { recursive: true });
  await mkdir(recordsPath(projectRoot), { recursive: true });
  await mkdir(libraryPath(projectRoot), { recursive: true });
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
  embedder: Embedder = createDefaultEmbedder(projectRoot),
  graphWriter: ManagedGraphWriter = defaultGraphWriter,
  options: UpsertOptions = {}
): Promise<ManagedDocumentWriteResult> {
  if (typeof input.source !== "string" || typeof input.document !== "string" || !input.metadata) {
    throw new Error("source, document, and metadata are required");
  }
  assertValidMetadata(input.metadata);
  const resolved = await resolveManagedTarget(projectRoot, input.file_path);
  await ensureManagedStore(projectRoot);

  const db = openManagedDatabase(projectRoot);
  let existing: DocumentRow | undefined;
  try {
    existing = getDocumentRowByPath(db, resolved.relativePath);
  } finally {
    db.close();
  }

  const identity = options.identity?.file_path === resolved.relativePath ? options.identity : undefined;
  const prior = existing ?? identity;
  const currentTarget = await readIfExists(resolved.absolutePath);
  if (!prior && currentTarget !== undefined) {
    throw new Error("unmanaged file already exists at file_path");
  }
  if (prior && currentTarget === undefined) {
    throw new Error("managed library file is missing; delete the document or restore the file");
  }
  if (prior && !options.acceptLibraryEdit && sha256(currentTarget as string) !== prior.document_hash) {
    throw new Error("managed target was externally modified; run \"docnexus document sync\" to adopt the edit");
  }

  const now = new Date().toISOString();
  const id = prior?.id ?? createDocumentId();
  const metadataJson = stableJson(input.metadata);
  const hashes = {
    source_hash: sha256(input.source),
    document_hash: sha256(input.document),
    metadata_hash: sha256(metadataJson)
  };
  const unchanged = prior !== undefined
    && prior.source_hash === hashes.source_hash
    && prior.document_hash === hashes.document_hash
    && prior.metadata_hash === hashes.metadata_hash;
  const row: DocumentRow = {
    id,
    file_path: resolved.relativePath,
    title: input.metadata.title,
    summary: input.metadata.summary,
    tags_json: JSON.stringify(input.metadata.tags),
    ...hashes,
    created_at: prior?.created_at ?? now,
    updated_at: unchanged ? (prior as RecordFile).updated_at : now,
    sidecar_path: recordRelativePath(id)
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
    operation: prior ? "updated" : "created",
    chunk_count: chunks.length,
    updated_at: row.updated_at
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
    output.document = await readFile((await resolveManagedTarget(projectRoot, document.file_path)).absolutePath, "utf8");
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
    workspace_path: workspacePath(projectRoot),
    library_path: libraryPath(projectRoot),
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
      : getDocumentRowByPath(db, (await resolveManagedTarget(projectRoot, input.file_path as string)).relativePath);
  } finally {
    db.close();
  }
  if (!row) {
    throw new Error("managed document not found");
  }
  const resolved = await resolveManagedTarget(projectRoot, row.file_path);
  const target = await readIfExists(resolved.absolutePath);
  if (target === undefined || sha256(target) !== row.document_hash) {
    throw new Error("managed target was externally modified");
  }
  const snapshot = await snapshotCurrent(projectRoot, row, row, target);
  const metadata = JSON.parse(snapshot.metadata as string) as DocNexusMetadata;
  try {
    await graphWriter.deleteDocumentGraph(projectRoot, row.id);
    await rm(resolved.absolutePath, { force: true });
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

export interface IndexDrift {
  record_count: number;
  indexed_count: number;
  /** Records with no index row (new files, fresh clone). */
  unindexed: string[];
  /** Records whose hashes differ from the index row (changed by git pull or another checkout). */
  outdated: string[];
  /** Index rows whose record no longer exists. */
  orphaned: string[];
  /** Records whose library file was edited after ingestion; adopt with `document sync`. */
  edited: string[];
  /** Records whose library file is missing. */
  missing_library: string[];
  in_sync: boolean;
}

export async function listRecordFiles(projectRoot: string): Promise<RecordFile[]> {
  const entries = await readdir(recordsPath(projectRoot), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const records: RecordFile[] = [];
  for (const entry of entries.filter((value) => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const content = await readIfExists(join(recordsPath(projectRoot), entry.name, "record.json"));
    if (content === undefined) {
      continue;
    }
    const record = JSON.parse(content) as RecordFile;
    if (record.id !== entry.name) {
      throw new Error(`record ${entry.name} has a mismatched id`);
    }
    records.push(record);
  }
  return records;
}

export async function readRecordMetadata(projectRoot: string, documentId: string): Promise<DocNexusMetadata> {
  return JSON.parse(await readFile(join(projectRoot, recordRelativePath(documentId), "metadata.json"), "utf8")) as DocNexusMetadata;
}

export async function inspectIndex(projectRoot: string): Promise<IndexDrift> {
  const records = await listRecordFiles(projectRoot);
  const rows = new Map((await listManagedDocuments(projectRoot)).map((row) => [row.id, row]));
  const drift: IndexDrift = {
    record_count: records.length,
    indexed_count: rows.size,
    unindexed: [],
    outdated: [],
    orphaned: [...rows.keys()].filter((id) => !records.some((record) => record.id === id)),
    edited: [],
    missing_library: [],
    in_sync: true
  };
  for (const record of records) {
    const row = rows.get(record.id);
    if (!row) {
      drift.unindexed.push(record.id);
    } else if (
      row.file_path !== record.file_path
      || row.source_hash !== record.source_hash
      || row.document_hash !== record.document_hash
      || row.metadata_hash !== record.metadata_hash
    ) {
      drift.outdated.push(record.id);
    }
    const library = await readIfExists(join(libraryPath(projectRoot), record.file_path));
    if (library === undefined) {
      drift.missing_library.push(record.id);
    } else if (sha256(library) !== record.document_hash) {
      drift.edited.push(record.id);
    }
  }
  drift.in_sync = drift.unindexed.length + drift.outdated.length + drift.orphaned.length === 0;
  return drift;
}

/**
 * Brings the derived store in line with the text records. With `all`, every record is re-embedded
 * and re-graphed; otherwise only unindexed and outdated records are processed.
 */
export async function reconcileIndex(
  projectRoot: string,
  options: { all: boolean },
  embedder: Embedder = createDefaultEmbedder(projectRoot),
  graphWriter: ManagedGraphWriter = defaultGraphWriter
): Promise<RebuildManagedDocumentsOutput> {
  const startedAt = new Date().toISOString();
  const drift = await inspectIndex(projectRoot);
  const records = await listRecordFiles(projectRoot);
  const failures: RebuildManagedDocumentsOutput["failed_documents"] = [];
  let removed = 0;

  for (const id of drift.orphaned) {
    try {
      await graphWriter.deleteDocumentGraph(projectRoot, id);
      deleteDocumentRows(projectRoot, id);
      removed += 1;
    } catch (error) {
      failures.push({ document_id: id, file_path: "", error: error instanceof Error ? error.message : String(error) });
    }
  }

  const pending = options.all
    ? records
    : records.filter((record) => drift.unindexed.includes(record.id) || drift.outdated.includes(record.id));
  let rebuilt = 0;
  for (const record of pending) {
    try {
      const directory = join(projectRoot, recordRelativePath(record.id));
      const source = await readFile(join(directory, "source.md"), "utf8");
      const metadataJson = await readFile(join(directory, "metadata.json"), "utf8");
      const document = await readIfExists(join(libraryPath(projectRoot), record.file_path));
      if (document === undefined) {
        throw new Error("managed library file is missing");
      }
      if (sha256(document) !== record.document_hash) {
        throw new Error("library file was edited after ingestion; run \"docnexus document sync\" to adopt the edit");
      }
      if (sha256(source) !== record.source_hash) {
        throw new Error("record source.md does not match record.json");
      }
      const metadata = JSON.parse(metadataJson) as DocNexusMetadata;
      if (sha256(stableJson(metadata)) !== record.metadata_hash) {
        throw new Error("record metadata.json does not match record.json");
      }
      await upsertManagedDocument(
        projectRoot,
        { file_path: record.file_path, source, document, metadata },
        embedder,
        graphWriter,
        { identity: record }
      );
      rebuilt += 1;
    } catch (error) {
      failures.push({
        document_id: record.id,
        file_path: record.file_path,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return {
    result: failures.length > 0 ? "completed_with_errors" : "completed",
    processed_documents: pending.length,
    rebuilt_documents: rebuilt,
    removed_documents: removed,
    failed_documents: failures,
    started_at: startedAt,
    finished_at: new Date().toISOString()
  };
}

export async function rebuildManagedDocuments(
  projectRoot: string,
  options: { force: boolean },
  embedder: Embedder = createDefaultEmbedder(projectRoot),
  graphWriter: ManagedGraphWriter = defaultGraphWriter
): Promise<RebuildManagedDocumentsOutput> {
  if (!options.force) {
    throw new Error("rebuild requires --force");
  }
  return reconcileIndex(projectRoot, { all: true }, embedder, graphWriter);
}

/** Adopts a hand edit of a library file as the new current document, optionally with refreshed metadata. */
export async function syncManagedDocument(
  projectRoot: string,
  input: { id?: string; file_path?: string; metadata?: DocNexusMetadata },
  embedder: Embedder = createDefaultEmbedder(projectRoot),
  graphWriter: ManagedGraphWriter = defaultGraphWriter
): Promise<ManagedDocumentWriteResult & { metadata_updated: boolean }> {
  if (Number(Boolean(input.id)) + Number(Boolean(input.file_path)) !== 1) {
    throw new Error("provide exactly one of id or file_path");
  }
  const filePath = input.file_path === undefined ? undefined : await normalizeManagedFilePath(projectRoot, input.file_path);
  const record = (await listRecordFiles(projectRoot)).find((value) => value.id === input.id || value.file_path === filePath);
  if (!record) {
    throw new Error("managed document not found");
  }
  const directory = join(projectRoot, recordRelativePath(record.id));
  const document = await readIfExists(join(libraryPath(projectRoot), record.file_path));
  if (document === undefined) {
    throw new Error("managed library file is missing; delete the document or restore the file");
  }
  if (document.trim().length === 0) {
    throw new Error("managed library file is empty");
  }
  const metadata = input.metadata ?? (JSON.parse(await readFile(join(directory, "metadata.json"), "utf8")) as DocNexusMetadata);
  const result = await upsertManagedDocument(
    projectRoot,
    { file_path: record.file_path, source: await readFile(join(directory, "source.md"), "utf8"), document, metadata },
    embedder,
    graphWriter,
    { acceptLibraryEdit: true, identity: record }
  );
  return { ...result, metadata_updated: input.metadata !== undefined };
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

async function resolveManagedTarget(projectRoot: string, filePath: string): Promise<{ absolutePath: string; relativePath: string }> {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new Error("file_path is required");
  }
  if (isAbsolute(filePath) || extname(filePath).toLowerCase() !== ".md") {
    throw new Error("file_path must be a project-relative Markdown path");
  }
  const root = await realpath(resolve(projectRoot));
  const managedRoot = libraryPath(root);
  const absolutePath = resolve(managedRoot, filePath);
  const relativePath = relative(managedRoot, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`file_path must remain inside the ${WORKSPACE_DIRNAME}/library directory`);
  }

  await assertNoSymbolicLinks(root, join(WORKSPACE_DIRNAME, "library", relativePath));
  return { absolutePath, relativePath: relativePath.split(sep).join("/") };
}

/** Validates a logical managed path and returns its normalized library-relative form. */
export async function normalizeManagedFilePath(projectRoot: string, filePath: string): Promise<string> {
  return (await resolveManagedTarget(projectRoot, filePath)).relativePath;
}

export async function isManagedFilePath(projectRoot: string, filePath: string): Promise<boolean> {
  const db = openManagedDatabase(projectRoot);
  try {
    return getDocumentRowByPath(db, filePath) !== undefined;
  } finally {
    db.close();
  }
}

export async function assertNoSymbolicLinks(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (info === undefined) {
      return;
    }
    if (info.isSymbolicLink()) {
      throw new Error("file_path must not contain symbolic links");
    }
  }
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
  let chunks: ChunkRow[] = [];
  if (existing) {
    const db = openManagedDatabase(projectRoot);
    try {
      chunks = db.prepare("SELECT * FROM file_chunks WHERE document_id = ? ORDER BY chunk_index").all(existing.id) as unknown as ChunkRow[];
    } finally {
      db.close();
    }
  }
  const directory = join(projectRoot, row.sidecar_path);
  return {
    row: existing,
    chunks,
    target,
    source: await readIfExists(join(directory, "source.md")),
    metadata: await readIfExists(join(directory, "metadata.json")),
    record: await readIfExists(join(directory, "record.json"))
  };
}

function toRecordFile(row: DocumentRow): RecordFile {
  return {
    id: row.id,
    file_path: row.file_path,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source_hash: row.source_hash,
    document_hash: row.document_hash,
    metadata_hash: row.metadata_hash
  };
}

async function writeCurrentFiles(
  projectRoot: string,
  row: DocumentRow,
  source: string,
  document: string,
  metadataJson: string
): Promise<void> {
  await atomicWrite(join(libraryPath(projectRoot), row.file_path), document);
  const directory = join(projectRoot, row.sidecar_path);
  await atomicWrite(join(directory, "source.md"), source);
  await atomicWrite(join(directory, "metadata.json"), `${metadataJson}\n`);
  await atomicWrite(join(directory, "record.json"), `${JSON.stringify(toRecordFile(row), null, 2)}\n`);
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
  const directory = join(projectRoot, row.sidecar_path);
  await restoreFile(join(libraryPath(projectRoot), row.file_path), snapshot.target);
  await restoreFile(join(directory, "source.md"), snapshot.source);
  await restoreFile(join(directory, "metadata.json"), snapshot.metadata);
  await restoreFile(join(directory, "record.json"), snapshot.record);
  if (snapshot.source === undefined && snapshot.metadata === undefined && snapshot.record === undefined) {
    await rm(directory, { recursive: true, force: true });
  }
  if (snapshot.row) {
    replaceDocumentState(projectRoot, snapshot.row, snapshot.chunks.map(fromChunkRow));
    return;
  }
  deleteDocumentRows(projectRoot, row.id);
}

async function restoreFile(path: string, content: string | undefined): Promise<void> {
  if (content === undefined) {
    await rm(path, { force: true });
    return;
  }
  await atomicWrite(path, content);
}

function deleteDocumentRows(projectRoot: string, documentId: string): void {
  const db = openManagedDatabase(projectRoot);
  try {
    db.prepare("DELETE FROM file_chunks WHERE document_id = ?").run(documentId);
    db.prepare("DELETE FROM documents WHERE id = ?").run(documentId);
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
