import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { EMBEDDING_DIMENSION } from "./embedding-config.js";
import type { GraphConcept, GraphEdge } from "./graph-mapping.js";
import {
  buildGroupedRecall,
  type GroupedRecallData,
  type RecallContextChunk,
  type RecallPathCandidate,
  type RecallPrimaryMatch,
  type RecallSupportingCandidate
} from "./recall-groups.js";
import { storePath } from "./managed-documents.js";

const require = createRequire(import.meta.url);
// LadybugDB otherwise requests its default 8 TB mmap address range on every open.
const LADYBUG_MAX_DATABASE_SIZE = 1024 * 1024 * 1024;

type QueryResult = {
  getAllSync?: () => unknown[];
  getAllObjects?: () => unknown[];
  get_as_js?: () => unknown[];
  getAsJs?: () => unknown[];
  toArray?: () => unknown[];
  close?: () => void;
};

type LadybugConnection = {
  querySync: (query: string) => QueryResult | unknown[];
  close?: () => void;
  closeSync?: () => void;
};

type LadybugModule = {
  Database: new (
    path: string,
    bufferManagerSize?: number,
    enableCompression?: boolean,
    readOnly?: boolean,
    maxDBSize?: number
  ) => { close?: () => void; closeSync?: () => void };
  Connection: new (database: unknown) => LadybugConnection;
};

export interface LadybugProjectNode {
  id: string;
  name: string;
  root_path: string;
}

export interface LadybugDocumentNode {
  id: string;
  title: string;
  path: string;
  summary: string;
  content_hash: string;
  updated_at: string;
}

export interface LadybugChunkNode {
  id: string;
  document_id: string;
  text: string;
  text_hash: string;
  chunk_index: number;
  embedding: number[];
}

export interface ReplaceDocumentGraphInput {
  project: LadybugProjectNode;
  document: LadybugDocumentNode;
  chunks: LadybugChunkNode[];
  concepts: GraphConcept[];
  edges: GraphEdge[];
}

export interface LadybugDocumentSummary {
  document_id: string;
  file_path: string;
  chunk_count: number;
}

export interface LadybugOrphanConcept {
  concept_id: string;
  name: string;
  type: string;
}

export interface LadybugVectorIndexHealth {
  ok: boolean;
  message?: string;
}

const schemaStatements = [
  "CREATE NODE TABLE Project(id STRING, name STRING, root_path STRING, PRIMARY KEY (id));",
  "CREATE NODE TABLE Document(id STRING, title STRING, path STRING, summary STRING, content_hash STRING, updated_at STRING, PRIMARY KEY (id));",
  `CREATE NODE TABLE Chunk(id STRING, document_id STRING, text STRING, text_hash STRING, chunk_index INT64, embedding FLOAT[${EMBEDDING_DIMENSION}], PRIMARY KEY (id));`,
  "CREATE NODE TABLE Concept(id STRING, name STRING, type STRING, description STRING, PRIMARY KEY (id));",
  "CREATE REL TABLE HAS_DOCUMENT(FROM Project TO Document);",
  "CREATE REL TABLE HAS_CHUNK(FROM Document TO Chunk);",
  "CREATE REL TABLE NEXT_CHUNK(FROM Chunk TO Chunk);",
  "CREATE REL TABLE MENTIONS(FROM Document TO Concept);",
  "CREATE REL TABLE DEPENDS_ON(FROM Concept TO Concept);",
  "CREATE REL TABLE RELATES_TO(FROM Concept TO Concept);",
  "CREATE REL TABLE IMPLEMENTS(FROM Concept TO Concept);",
  "CREATE REL TABLE REPLACES(FROM Concept TO Concept);",
  "CREATE REL TABLE DECIDES(FROM Concept TO Concept);"
];

export function ladybugStorePath(projectRoot: string): string {
  return join(storePath(projectRoot), "store.lbug");
}

export async function isLadybugAvailable(): Promise<boolean> {
  let root: string | undefined;
  try {
    loadLadybug();
    root = await mkdtemp(join(tmpdir(), "docnexus-ladybug-probe-"));
    await ensureLadybugStore(root);
    return true;
  } catch {
    return false;
  } finally {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

export async function ensureLadybugStore(projectRoot: string): Promise<void> {
  await mkdir(storePath(projectRoot), { recursive: true });
  withLadybugConnection(projectRoot, (connection) => {
    for (const statement of schemaStatements) {
      runIdempotent(connection, statement);
    }
    runIdempotent(connection, "INSTALL vector;");
    runIdempotent(connection, "LOAD vector;");
    runIdempotent(
      connection,
      "CALL CREATE_VECTOR_INDEX('Chunk', 'chunk_vector_index', 'embedding', metric := 'cosine');"
    );
  });
}

export async function queryLadybugRows(
  projectRoot: string,
  query: string,
  params: Record<string, unknown> = {}
): Promise<unknown[]> {
  return withLadybugConnection(projectRoot, (connection) => {
    if (needsVectorExtension(query)) {
      loadVectorExtension(connection);
    }
    const result = connection.querySync(bindParams(query, params));
    try {
      return rowsFromResult(result);
    } finally {
      closeQueryResult(result);
    }
  });
}

export async function replaceDocumentGraph(projectRoot: string, input: ReplaceDocumentGraphInput): Promise<void> {
  await ensureLadybugStore(projectRoot);
  validateChunkEmbeddings(input.chunks);

  withLadybugConnection(projectRoot, (connection) => {
    loadVectorExtension(connection);
    dropVectorIndex(connection);
    deleteDocumentGraphSync(connection, input.document.id);

    runQuery(
      connection,
      "MERGE (p:Project {id: $id}) SET p.name = $name, p.root_path = $root_path",
      input.project
    );
    runQuery(
      connection,
      `
      CREATE (d:Document {
        id: $id,
        title: $title,
        path: $path,
        summary: $summary,
        content_hash: $content_hash,
        updated_at: $updated_at
      })
      `,
      input.document
    );
    runQuery(
      connection,
      `
      MATCH (p:Project), (d:Document)
      WHERE p.id = $project_id AND d.id = $document_id
      CREATE (p)-[:HAS_DOCUMENT]->(d)
      `,
      { project_id: input.project.id, document_id: input.document.id }
    );

    for (const chunk of input.chunks) {
      runQuery(
        connection,
        `
        CREATE (c:Chunk {
          id: $id,
          document_id: $document_id,
          text: $text,
          text_hash: $text_hash,
          chunk_index: $chunk_index,
          embedding: $embedding
        })
        `,
        chunk
      );
      runQuery(
        connection,
        `
        MATCH (d:Document), (c:Chunk)
        WHERE d.id = $document_id AND c.id = $chunk_id
        CREATE (d)-[:HAS_CHUNK]->(c)
        `,
        { document_id: input.document.id, chunk_id: chunk.id }
      );
    }

    for (let index = 0; index < input.chunks.length - 1; index += 1) {
      runQuery(
        connection,
        `
        MATCH (left:Chunk), (right:Chunk)
        WHERE left.id = $left_id AND right.id = $right_id
        CREATE (left)-[:NEXT_CHUNK]->(right)
        `,
        { left_id: input.chunks[index].id, right_id: input.chunks[index + 1].id }
      );
    }

    for (const concept of input.concepts) {
      runQuery(
        connection,
        "MERGE (c:Concept {id: $id}) SET c.name = $name, c.type = $type, c.description = $description",
        concept
      );
      runQuery(
        connection,
        `
        MATCH (d:Document), (c:Concept)
        WHERE d.id = $document_id AND c.id = $concept_id
        MERGE (d)-[:MENTIONS]->(c)
        `,
        { document_id: input.document.id, concept_id: concept.id }
      );
    }

    for (const edge of input.edges) {
      runQuery(
        connection,
        `
        MATCH (from:Concept), (to:Concept)
        WHERE from.id = $from AND to.id = $to
        MERGE (from)-[:${edge.label}]->(to)
        `,
        { from: edge.from, to: edge.to }
      );
    }

    createVectorIndex(connection);
  });
}

export async function deleteDocumentGraph(projectRoot: string, documentId: string): Promise<void> {
  await ensureLadybugStore(projectRoot);
  withLadybugConnection(projectRoot, (connection) => {
    loadVectorExtension(connection);
    dropVectorIndex(connection);
    deleteDocumentGraphSync(connection, documentId);
    createVectorIndex(connection);
  });
}

export async function listLadybugDocumentSummaries(projectRoot: string): Promise<LadybugDocumentSummary[]> {
  await ensureLadybugStore(projectRoot);
  const rows = await queryLadybugRows(
    projectRoot,
    `
    MATCH (d:Document)
    OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:Chunk)
    RETURN d.id AS document_id, d.path AS file_path, count(c) AS chunk_count
    ORDER BY file_path ASC
    `
  );

  return rows.map((row) => {
    const value = row as { document_id: string; file_path: string; chunk_count: number };
    return {
      document_id: value.document_id,
      file_path: value.file_path,
      chunk_count: Number(value.chunk_count)
    };
  });
}

export async function listLadybugOrphanConcepts(projectRoot: string): Promise<LadybugOrphanConcept[]> {
  await ensureLadybugStore(projectRoot);
  const concepts = await queryLadybugRows(
    projectRoot,
    "MATCH (c:Concept) RETURN c.id AS concept_id, c.name AS name, c.type AS type ORDER BY name ASC"
  );
  const mentioned = await queryLadybugRows(
    projectRoot,
    "MATCH (:Document)-[:MENTIONS]->(c:Concept) RETURN DISTINCT c.id AS concept_id"
  );
  const mentionedIds = new Set(
    mentioned.map((row) => (row as { concept_id?: unknown }).concept_id).filter((id): id is string => typeof id === "string")
  );

  return concepts
    .map((row) => row as { concept_id: string; name: string; type: string })
    .filter((concept) => !mentionedIds.has(concept.concept_id))
    .map((concept) => ({
      concept_id: concept.concept_id,
      name: concept.name,
      type: concept.type
    }));
}

export async function deleteLadybugDocumentsByIds(projectRoot: string, documentIds: string[]): Promise<void> {
  if (documentIds.length === 0) {
    return;
  }

  await ensureLadybugStore(projectRoot);
  withLadybugConnection(projectRoot, (connection) => {
    loadVectorExtension(connection);
    dropVectorIndex(connection);
    for (const documentId of documentIds) {
      deleteDocumentGraphSync(connection, documentId);
    }
    createVectorIndex(connection);
  });
}

export async function deleteLadybugConceptsByIds(projectRoot: string, conceptIds: string[]): Promise<void> {
  if (conceptIds.length === 0) {
    return;
  }

  await ensureLadybugStore(projectRoot);
  withLadybugConnection(projectRoot, (connection) => {
    for (const conceptId of conceptIds) {
      runQuery(connection, "MATCH (c:Concept) WHERE c.id = $concept_id DETACH DELETE c", { concept_id: conceptId });
    }
  });
}

export async function rebuildLadybugVectorIndex(projectRoot: string): Promise<void> {
  await ensureLadybugStore(projectRoot);
  withLadybugConnection(projectRoot, (connection) => {
    loadVectorExtension(connection);
    dropVectorIndex(connection);
    createVectorIndex(connection);
  });
}

export async function checkLadybugVectorIndex(projectRoot: string): Promise<LadybugVectorIndexHealth> {
  try {
    await ensureLadybugStore(projectRoot);
    const countRows = await queryLadybugRows(projectRoot, "MATCH (c:Chunk) RETURN count(c) AS count");
    const chunkCount = Number((countRows[0] as { count?: unknown } | undefined)?.count ?? 0);
    if (chunkCount === 0) {
      return { ok: true };
    }

    const queryEmbedding = Array.from({ length: EMBEDDING_DIMENSION }, () => 0);
    await queryLadybugRows(
      projectRoot,
      "CALL QUERY_VECTOR_INDEX('Chunk', 'chunk_vector_index', $query_embedding, 1) RETURN node",
      { query_embedding: queryEmbedding }
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function recallFromLadybug(
  projectRoot: string,
  queryEmbedding: number[],
  limit: number
): Promise<GroupedRecallData> {
  if (queryEmbedding.length !== EMBEDDING_DIMENSION) {
    throw new Error("embedding dimension mismatch");
  }

  await ensureLadybugStore(projectRoot);
  const rows = await queryLadybugRows(
    projectRoot,
    `
    CALL QUERY_VECTOR_INDEX('Chunk', 'chunk_vector_index', $query_embedding, $limit)
    WITH node AS c, distance AS score
    MATCH (d:Document)-[:HAS_CHUNK]->(c)
    OPTIONAL MATCH (previousChunk:Chunk)-[:NEXT_CHUNK]->(c)
    OPTIONAL MATCH (c)-[:NEXT_CHUNK]->(nextChunk:Chunk)
    OPTIONAL MATCH (d)-[:MENTIONS]->(concept:Concept)
    OPTIONAL MATCH (concept)-[:DEPENDS_ON|RELATES_TO|IMPLEMENTS|REPLACES|DECIDES]->(related:Concept)
    RETURN
      d.id AS document_id,
      d.path AS file_path,
      d.title AS document_title,
      d.summary AS document_summary,
      c.id AS chunk_id,
      c.chunk_index AS chunk_index,
      1 - score AS score,
      c.text AS text,
      previousChunk.id AS previous_chunk_id,
      previousChunk.chunk_index AS previous_chunk_index,
      previousChunk.text AS previous_text,
      nextChunk.id AS next_chunk_id,
      nextChunk.chunk_index AS next_chunk_index,
      nextChunk.text AS next_text,
      collect(DISTINCT concept.name) AS concepts,
      collect(DISTINCT related.name) AS related_concepts
    ORDER BY score DESC
    LIMIT $limit
    `,
    { query_embedding: queryEmbedding, limit }
  );

  const primaryRows = rows.map(normalizePrimaryMatch);
  if (primaryRows.length === 0) {
    return { results: [], context_groups: [] };
  }
  const documentIds = [...new Set(primaryRows.map((row) => row.document.document_id))];
  const paths = await loadGraphPathsForDocuments(projectRoot, documentIds);
  const supporting = await loadSupportingChunksForDocuments(projectRoot, documentIds);

  return buildGroupedRecall(primaryRows, paths, supporting);
}

async function loadGraphPathsForDocuments(projectRoot: string, documentIds: string[]): Promise<RecallPathCandidate[]> {
  const rows = await queryLadybugRows(
    projectRoot,
    `
    MATCH (d:Document)-[:MENTIONS]->(from:Concept)-[:DEPENDS_ON]->(to:Concept)
    WHERE d.id IN $document_ids
    RETURN d.id AS document_id, from.name AS from_name, 'DEPENDS_ON' AS relationship, to.name AS to_name
    UNION ALL
    MATCH (d:Document)-[:MENTIONS]->(from:Concept)-[:RELATES_TO]->(to:Concept)
    WHERE d.id IN $document_ids
    RETURN d.id AS document_id, from.name AS from_name, 'RELATES_TO' AS relationship, to.name AS to_name
    UNION ALL
    MATCH (d:Document)-[:MENTIONS]->(from:Concept)-[:IMPLEMENTS]->(to:Concept)
    WHERE d.id IN $document_ids
    RETURN d.id AS document_id, from.name AS from_name, 'IMPLEMENTS' AS relationship, to.name AS to_name
    UNION ALL
    MATCH (d:Document)-[:MENTIONS]->(from:Concept)-[:REPLACES]->(to:Concept)
    WHERE d.id IN $document_ids
    RETURN d.id AS document_id, from.name AS from_name, 'REPLACES' AS relationship, to.name AS to_name
    UNION ALL
    MATCH (d:Document)-[:MENTIONS]->(from:Concept)-[:DECIDES]->(to:Concept)
    WHERE d.id IN $document_ids
    RETURN d.id AS document_id, from.name AS from_name, 'DECIDES' AS relationship, to.name AS to_name
    `,
    { document_ids: documentIds }
  );

  return rows.map((row) => {
    const value = row as { document_id: string; from_name: string; relationship: string; to_name: string };
    return {
      document_id: value.document_id,
      from: value.from_name,
      relationship: value.relationship,
      to: value.to_name
    };
  });
}

async function loadSupportingChunksForDocuments(
  projectRoot: string,
  documentIds: string[]
): Promise<RecallSupportingCandidate[]> {
  const rows = await queryLadybugRows(
    projectRoot,
    `
    MATCH (matched:Document)-[:MENTIONS]->(:Concept)-[:DEPENDS_ON|RELATES_TO|IMPLEMENTS|REPLACES|DECIDES]->(related:Concept)
    MATCH (supporting:Document)-[:MENTIONS]->(related)
    MATCH (supporting)-[:HAS_CHUNK]->(chunk:Chunk)
    WHERE matched.id IN $document_ids
      AND supporting.id <> matched.id
    RETURN
      matched.id AS source_document_id,
      supporting.id AS document_id,
      supporting.path AS path,
      supporting.title AS title,
      chunk.id AS chunk_id,
      chunk.chunk_index AS chunk_index,
      chunk.text AS text,
      related.name AS related_concept
    ORDER BY source_document_id ASC, supporting.path ASC, chunk.chunk_index ASC
    `,
    { document_ids: documentIds }
  );

  return rows.map((row) => {
    const value = row as {
      source_document_id: string;
      document_id: string;
      path: string;
      title: string;
      chunk_id: string;
      chunk_index: number;
      text: string;
      related_concept: string;
    };
    return {
      source_document_id: value.source_document_id,
      document_id: value.document_id,
      path: value.path,
      title: value.title,
      chunk_id: value.chunk_id,
      chunk_index: Number(value.chunk_index),
      text: value.text,
      reason: `related_concept:${value.related_concept}`
    };
  });
}

function withLadybugConnection<T>(projectRoot: string, callback: (connection: LadybugConnection) => T): T {
  const lbug = loadLadybug();
  const database = new lbug.Database(ladybugStorePath(projectRoot), 0, true, false, LADYBUG_MAX_DATABASE_SIZE);
  const connection = new lbug.Connection(database);
  try {
    return callback(connection);
  } finally {
    connection.closeSync?.();
    connection.close?.();
    database.closeSync?.();
    database.close?.();
  }
}

function loadLadybug(): LadybugModule {
  try {
    return require("@ladybugdb/core") as LadybugModule;
  } catch {
    throw new Error("LadybugDB dependency is not installed");
  }
}

function deleteDocumentGraphSync(connection: LadybugConnection, documentId: string): void {
  runQuery(connection, "MATCH (d:Document) WHERE d.id = $document_id DETACH DELETE d", { document_id: documentId });
  runQuery(connection, "MATCH (c:Chunk) WHERE c.document_id = $document_id DETACH DELETE c", { document_id: documentId });
}

function validateChunkEmbeddings(chunks: LadybugChunkNode[]): void {
  for (const chunk of chunks) {
    if (chunk.embedding.length !== EMBEDDING_DIMENSION) {
      throw new Error("embedding dimension mismatch");
    }
  }
}

function runIdempotent(connection: LadybugConnection, statement: string): void {
  try {
    closeQueryResult(connection.querySync(statement));
  } catch (error) {
    if (isAlreadyExistsError(error) || isExtensionAlreadyLoadedError(error)) {
      return;
    }
    throw error;
  }
}

function createVectorIndex(connection: LadybugConnection): void {
  runIdempotent(
    connection,
    "CALL CREATE_VECTOR_INDEX('Chunk', 'chunk_vector_index', 'embedding', metric := 'cosine');"
  );
}

function loadVectorExtension(connection: LadybugConnection): void {
  runIdempotent(connection, "LOAD vector;");
}

function needsVectorExtension(query: string): boolean {
  return /QUERY_VECTOR_INDEX|CREATE_VECTOR_INDEX|DROP_VECTOR_INDEX/i.test(query);
}

function dropVectorIndex(connection: LadybugConnection): void {
  try {
    closeQueryResult(connection.querySync("CALL DROP_VECTOR_INDEX('Chunk', 'chunk_vector_index');"));
  } catch (error) {
    if (isMissingVectorIndexError(error)) {
      return;
    }
    throw error;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|exist/i.test(message);
}

function isExtensionAlreadyLoadedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already installed|already loaded/i.test(message);
}

function isMissingVectorIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /does not exist|not found|cannot find|not in catalog/i.test(message);
}

function rowsFromResult(result: QueryResult | unknown[]): unknown[] {
  if (Array.isArray(result)) {
    return result;
  }
  if (result && typeof result === "object") {
    if (typeof result.getAllSync === "function") return result.getAllSync();
    if (typeof result.getAllObjects === "function") return result.getAllObjects();
    if (typeof result.get_as_js === "function") return result.get_as_js();
    if (typeof result.getAsJs === "function") return result.getAsJs();
    if (typeof result.toArray === "function") return result.toArray();
  }
  return [];
}

function runQuery(
  connection: LadybugConnection,
  query: string,
  params: object = {}
): QueryResult | unknown[] {
  const result = connection.querySync(bindParams(query, params as Record<string, unknown>));
  closeQueryResult(result);
  return result;
}

function bindParams(query: string, params: Record<string, unknown>): string {
  return query.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, (placeholder) => {
    const name = placeholder.slice(1);
    if (!(name in params)) {
      return placeholder;
    }
    return cypherLiteral(params[name]);
  });
}

function cypherLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "string") {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cypher number must be finite");
    }
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => cypherLiteral(item)).join(", ")}]`;
  }
  throw new Error("Unsupported Cypher parameter value");
}

function normalizePrimaryMatch(row: unknown): RecallPrimaryMatch {
  const value = row as {
    document_id: string;
    file_path: string;
    document_title: string;
    document_summary: string;
    chunk_id: string;
    chunk_index: number;
    score: number;
    text: string;
    previous_chunk_id: string | null;
    previous_chunk_index: number | null;
    previous_text: string | null;
    next_chunk_id: string | null;
    next_chunk_index: number | null;
    next_text: string | null;
    concepts?: unknown[];
    related_concepts?: unknown[];
  };
  const sameDocumentChunks: RecallContextChunk[] = [];
  if (value.previous_chunk_id && value.previous_text) {
    sameDocumentChunks.push({
      chunk_id: value.previous_chunk_id,
      chunk_index: Number(value.previous_chunk_index),
      text: value.previous_text,
      reason: "same_document_before"
    });
  }
  if (value.next_chunk_id && value.next_text) {
    sameDocumentChunks.push({
      chunk_id: value.next_chunk_id,
      chunk_index: Number(value.next_chunk_index),
      text: value.next_text,
      reason: "same_document_after"
    });
  }

  return {
    matched_chunk: {
      chunk_id: value.chunk_id,
      chunk_index: Number(value.chunk_index),
      text: value.text,
      score: Number(value.score)
    },
    document: {
      document_id: value.document_id,
      path: value.file_path,
      title: value.document_title,
      summary: value.document_summary
    },
    concepts: normalizeStringList(value.concepts),
    related_concepts: normalizeStringList(value.related_concepts),
    same_document_chunks: sameDocumentChunks
  };
}

function normalizeStringList(value: unknown[] | undefined): string[] {
  return (value ?? []).filter((item): item is string => typeof item === "string");
}

function closeQueryResult(result: QueryResult | unknown[]): void {
  if (!Array.isArray(result)) {
    result.close?.();
  }
}
