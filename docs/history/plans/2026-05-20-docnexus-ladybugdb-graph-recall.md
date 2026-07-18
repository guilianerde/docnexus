# DocNexus LadybugDB Graph Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add LadybugDB as DocNexus's project-local graph/vector recall store while keeping SQLite as the archive and lifecycle ledger.

**Architecture:** Keep the public MCP and CLI contracts stable. Add a focused LadybugDB adapter for `.docnexus/store.lbug`, a pure metadata-to-graph mapper, and a graph-backed recall path. `upsert_file_index` and `delete_file_index` continue to maintain SQLite, then update LadybugDB as derived recall state.

**Tech Stack:** Node.js 24, TypeScript, `node:sqlite`, LadybugDB `@ladybugdb/core`, Vitest, existing MCP SDK, existing Zod.

---

## External References Checked

- Ladybug Node.js API: `https://docs.ladybugdb.com/client-apis/nodejs/`
- Ladybug installation: `https://docs.ladybugdb.com/installation/`
- Ladybug vector extension: `https://docs.ladybugdb.com/extensions/vector/`
- Ladybug system requirements: `https://docs.ladybugdb.com/system-requirements/`

Relevant constraints from the docs:

- Install Node package with `npm install @ladybugdb/core`.
- Node API supports `new lbug.Database("example.lbug")` and `new lbug.Connection(db)`.
- Sync API exposes `conn.querySync(...)`.
- Vector indexes support node table properties only.
- `CREATE_VECTOR_INDEX` indexes `FLOAT` or `DOUBLE` array properties.
- `QUERY_VECTOR_INDEX(table, index, query_vector, k)` returns `node` and `distance`.

---

## File Structure

Create:

- `src/embedding-config.ts`: shared embedding dimension constant.
- `src/graph-mapping.ts`: deterministic concept IDs and metadata relationship mapping.
- `src/ladybug-store.ts`: LadybugDB import, schema initialization, graph writes, graph deletes, vector recall.
- `test/graph-mapping.test.ts`: pure metadata mapping tests.
- `test/ladybug-store.test.ts`: LadybugDB integration tests with runtime availability guard.

Modify:

- `package.json`: add `@ladybugdb/core` dependency.
- `package-lock.json`: update via `npm install @ladybugdb/core`.
- `src/embedder.ts`: use shared `EMBEDDING_DIMENSION` as default.
- `src/file-index.ts`: call LadybugDB replace/delete graph operations after SQLite lifecycle update.
- `src/recall.ts`: switch recall implementation from SQLite cosine ranking to LadybugDB vector recall.
- `test/file-index.test.ts`: verify LadybugDB graph side effects when available.
- `test/recall.test.ts`: verify graph-backed recall output fields.
- `test/mcp.test.ts`: update recall expectations to include graph context fields.

Do not modify:

- `skills/docnexus-capture/SKILL.md`
- archive record storage semantics
- public MCP tool names
- public CLI command names

---

### Task 1: Add LadybugDB Dependency And Embedding Dimension Constant

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/embedding-config.ts`
- Modify: `src/embedder.ts`
- Test: `test/embedder.test.ts`

- [ ] **Step 1: Install LadybugDB**

Run:

```bash
npm install @ladybugdb/core
```

Expected: `package.json` gains `@ladybugdb/core` under `dependencies`, and `package-lock.json` updates.

- [ ] **Step 2: Add shared embedding dimension**

Create `src/embedding-config.ts`:

```ts
export const EMBEDDING_DIMENSION = 64;
```

- [ ] **Step 3: Update the default embedder dimension**

Modify the top of `src/embedder.ts`:

```ts
import { createHash } from "node:crypto";
import { EMBEDDING_DIMENSION } from "./embedding-config.js";
```

Replace the constructor default:

```ts
  constructor(dimension = EMBEDDING_DIMENSION) {
```

- [ ] **Step 4: Add a test for the default dimension**

Append to `test/embedder.test.ts`:

```ts
import { EMBEDDING_DIMENSION } from "../src/embedding-config.js";
```

Add this case inside `describe("LocalHashEmbedder", () => { ... })`:

```ts
  it("uses the shared embedding dimension by default", () => {
    const embedder = new LocalHashEmbedder();

    expect(embedder.dimension).toBe(EMBEDDING_DIMENSION);
    expect(embedder.embed("dimension check")).toHaveLength(EMBEDDING_DIMENSION);
  });
```

- [ ] **Step 5: Run embedder tests**

Run:

```bash
npm test -- test/embedder.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit dependency and dimension constant**

```bash
git add package.json package-lock.json src/embedding-config.ts src/embedder.ts test/embedder.test.ts
git commit -m "feat: add LadybugDB dependency and embedding dimension"
```

---

### Task 2: Add Metadata Graph Mapping

**Files:**
- Create: `src/graph-mapping.ts`
- Create: `test/graph-mapping.test.ts`

- [ ] **Step 1: Write graph mapping tests**

Create `test/graph-mapping.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createConceptId,
  mapRelationshipTypeToEdge,
  normalizeConceptKey,
  relationshipsToEdges
} from "../src/graph-mapping.js";
import type { DocNexusMetadata } from "../src/types.js";

describe("graph mapping", () => {
  it("creates deterministic concept ids from normalized name and type", () => {
    expect(normalizeConceptKey(" Component ", "tool")).toBe("tool:component");
    expect(createConceptId(" DocNexus ", "component")).toBe(createConceptId("docnexus", "component"));
    expect(createConceptId("DocNexus", "component")).toMatch(/^concept_[0-9a-f]{16}$/);
  });

  it("maps metadata relationship types to LadybugDB edge labels", () => {
    expect(mapRelationshipTypeToEdge("depends_on")).toBe("DEPENDS_ON");
    expect(mapRelationshipTypeToEdge("mentions")).toBe("RELATES_TO");
    expect(mapRelationshipTypeToEdge("relates_to")).toBe("RELATES_TO");
    expect(mapRelationshipTypeToEdge("implements")).toBe("IMPLEMENTS");
    expect(mapRelationshipTypeToEdge("replaces")).toBe("REPLACES");
    expect(mapRelationshipTypeToEdge("decides")).toBe("DECIDES");
  });

  it("creates placeholder concepts for relationship endpoints not listed as entities", () => {
    const metadata: DocNexusMetadata = {
      title: "Graph Mapping",
      summary: "Graph mapping test metadata for DocNexus relationship endpoint handling.",
      tags: ["graph"],
      entities: [{ name: "DocNexus", type: "component", description: "Local memory service." }],
      relationships: [{ from: "DocNexus", to: "LadybugDB", type: "depends_on", description: "Stores graph recall." }]
    };

    const mapped = relationshipsToEdges(metadata);

    expect(mapped.concepts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "DocNexus", type: "component" }),
        expect.objectContaining({
          name: "LadybugDB",
          type: "other",
          description: "Referenced by metadata relationship."
        })
      ])
    );
    expect(mapped.edges).toEqual([
      expect.objectContaining({
        label: "DEPENDS_ON",
        from: expect.stringMatching(/^concept_[0-9a-f]{16}$/),
        to: expect.stringMatching(/^concept_[0-9a-f]{16}$/),
        description: "Stores graph recall."
      })
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- test/graph-mapping.test.ts
```

Expected: FAIL with an import error for `../src/graph-mapping.js`.

- [ ] **Step 3: Implement graph mapping**

Create `src/graph-mapping.ts`:

```ts
import { createHash } from "node:crypto";
import type { DocNexusMetadata, EntityType, MetadataEntity, RelationshipType } from "./types.js";

export type LadybugRelationshipLabel = "DEPENDS_ON" | "RELATES_TO" | "IMPLEMENTS" | "REPLACES" | "DECIDES";

export interface GraphConcept extends MetadataEntity {
  id: string;
}

export interface GraphEdge {
  label: LadybugRelationshipLabel;
  from: string;
  to: string;
  description: string;
}

export interface GraphMapping {
  concepts: GraphConcept[];
  edges: GraphEdge[];
}

export function normalizeConceptKey(name: string, type: EntityType): string {
  return `${type}:${name.trim().toLowerCase()}`;
}

export function createConceptId(name: string, type: EntityType): string {
  const hash = createHash("sha256").update(normalizeConceptKey(name, type), "utf8").digest("hex").slice(0, 16);
  return `concept_${hash}`;
}

export function mapRelationshipTypeToEdge(type: RelationshipType): LadybugRelationshipLabel {
  switch (type) {
    case "depends_on":
      return "DEPENDS_ON";
    case "implements":
      return "IMPLEMENTS";
    case "replaces":
      return "REPLACES";
    case "decides":
      return "DECIDES";
    case "mentions":
    case "relates_to":
      return "RELATES_TO";
  }
}

export function relationshipsToEdges(metadata: DocNexusMetadata): GraphMapping {
  const conceptsByName = new Map<string, GraphConcept>();

  for (const entity of metadata.entities) {
    const concept: GraphConcept = {
      ...entity,
      id: createConceptId(entity.name, entity.type)
    };
    conceptsByName.set(entity.name.trim().toLowerCase(), concept);
  }

  for (const relationship of metadata.relationships) {
    ensureConcept(conceptsByName, relationship.from);
    ensureConcept(conceptsByName, relationship.to);
  }

  const edges = metadata.relationships.map((relationship) => ({
    label: mapRelationshipTypeToEdge(relationship.type),
    from: conceptsByName.get(relationship.from.trim().toLowerCase())!.id,
    to: conceptsByName.get(relationship.to.trim().toLowerCase())!.id,
    description: relationship.description
  }));

  return {
    concepts: Array.from(conceptsByName.values()),
    edges
  };
}

function ensureConcept(conceptsByName: Map<string, GraphConcept>, name: string): void {
  const key = name.trim().toLowerCase();
  if (conceptsByName.has(key)) {
    return;
  }

  conceptsByName.set(key, {
    id: createConceptId(name, "other"),
    name,
    type: "other",
    description: "Referenced by metadata relationship."
  });
}
```

- [ ] **Step 4: Run graph mapping tests**

Run:

```bash
npm test -- test/graph-mapping.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit graph mapping**

```bash
git add src/graph-mapping.ts test/graph-mapping.test.ts
git commit -m "feat: add DocNexus graph metadata mapping"
```

---

### Task 3: Add LadybugDB Store Initialization

**Files:**
- Create: `src/ladybug-store.ts`
- Create: `test/ladybug-store.test.ts`

- [ ] **Step 1: Write initialization tests**

Create `test/ladybug-store.test.ts`:

```ts
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureLadybugStore,
  isLadybugAvailable,
  ladybugStorePath,
  queryLadybugRows
} from "../src/ladybug-store.js";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-ladybug-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LadybugDB store", () => {
  it("reports runtime availability", async () => {
    await expect(isLadybugAvailable()).resolves.toEqual(expect.any(Boolean));
  });

  it("initializes schema and vector index idempotently", async () => {
    if (!(await isLadybugAvailable())) {
      return;
    }

    const projectRoot = await makeRoot();
    await ensureLadybugStore(projectRoot);
    await ensureLadybugStore(projectRoot);

    await expect(stat(ladybugStorePath(projectRoot))).resolves.toBeDefined();
    await expect(queryLadybugRows(projectRoot, "MATCH (p:Project) RETURN count(p) AS count")).resolves.toEqual([
      expect.objectContaining({ count: expect.any(Number) })
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- test/ladybug-store.test.ts
```

Expected: FAIL with an import error for `../src/ladybug-store.js`.

- [ ] **Step 3: Implement LadybugDB import and schema initialization**

Create `src/ladybug-store.ts` with these exported functions first:

```ts
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { EMBEDDING_DIMENSION } from "./embedding-config.js";
import { storePath } from "./store.js";

const require = createRequire(import.meta.url);

type QueryResult = {
  getAllObjects?: () => unknown[];
  get_as_js?: () => unknown[];
  getAsJs?: () => unknown[];
  toArray?: () => unknown[];
};

type LadybugConnection = {
  querySync: (query: string, params?: Record<string, unknown>) => QueryResult | unknown[];
  close?: () => void;
};

type LadybugModule = {
  Database: new (path: string) => unknown;
  Connection: new (database: unknown) => LadybugConnection;
};

const schemaStatements = [
  "CREATE NODE TABLE Project(id STRING, name STRING, root_path STRING, PRIMARY KEY (id));",
  "CREATE NODE TABLE Document(id STRING, file_id STRING, record_id STRING, title STRING, path STRING, summary STRING, content_hash STRING, updated_at STRING, PRIMARY KEY (id));",
  `CREATE NODE TABLE Chunk(id STRING, file_id STRING, document_id STRING, text STRING, text_hash STRING, chunk_index INT64, embedding FLOAT[${EMBEDDING_DIMENSION}], PRIMARY KEY (id));`,
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
  try {
    loadLadybug();
    return true;
  } catch {
    return false;
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

export async function queryLadybugRows(projectRoot: string, query: string, params: Record<string, unknown> = {}): Promise<unknown[]> {
  return withLadybugConnection(projectRoot, (connection) => rowsFromResult(connection.querySync(query, params)));
}

function withLadybugConnection<T>(projectRoot: string, callback: (connection: LadybugConnection) => T): T {
  const lbug = loadLadybug();
  const database = new lbug.Database(ladybugStorePath(projectRoot));
  const connection = new lbug.Connection(database);
  try {
    return callback(connection);
  } finally {
    connection.close?.();
  }
}

function loadLadybug(): LadybugModule {
  try {
    return require("@ladybugdb/core") as LadybugModule;
  } catch {
    throw new Error("LadybugDB dependency is not installed");
  }
}

function runIdempotent(connection: LadybugConnection, statement: string): void {
  try {
    connection.querySync(statement);
  } catch (error) {
    if (isAlreadyExistsError(error) || isExtensionAlreadyLoadedError(error)) {
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

function rowsFromResult(result: QueryResult | unknown[]): unknown[] {
  if (Array.isArray(result)) {
    return result;
  }
  if (result && typeof result === "object") {
    if (typeof result.getAllObjects === "function") return result.getAllObjects();
    if (typeof result.get_as_js === "function") return result.get_as_js();
    if (typeof result.getAsJs === "function") return result.getAsJs();
    if (typeof result.toArray === "function") return result.toArray();
  }
  return [];
}
```

- [ ] **Step 4: Run Ladybug store tests**

Run:

```bash
npm test -- test/ladybug-store.test.ts
```

Expected: PASS when LadybugDB loads. If the package cannot load on the current platform, the availability test passes with `false` and the integration case returns early.

- [ ] **Step 5: Commit LadybugDB store initialization**

```bash
git add src/ladybug-store.ts test/ladybug-store.test.ts
git commit -m "feat: initialize DocNexus LadybugDB store"
```

---

### Task 4: Add LadybugDB Graph Replace/Delete Operations

**Files:**
- Modify: `src/ladybug-store.ts`
- Modify: `test/ladybug-store.test.ts`

- [ ] **Step 1: Add graph operation tests**

Append imports in `test/ladybug-store.test.ts`:

```ts
import { EMBEDDING_DIMENSION } from "../src/embedding-config.js";
import { deleteDocumentGraph, replaceDocumentGraph } from "../src/ladybug-store.js";
```

Add this test inside `describe("LadybugDB store", () => { ... })`:

```ts
  it("replaces and deletes a document graph", async () => {
    if (!(await isLadybugAvailable())) {
      return;
    }

    const projectRoot = await makeRoot();
    await ensureLadybugStore(projectRoot);

    const embedding = Array.from({ length: EMBEDDING_DIMENSION }, (_, index) => (index === 0 ? 1 : 0));
    await replaceDocumentGraph(projectRoot, {
      project: { id: "project", name: "project", root_path: projectRoot },
      document: {
        id: "doc_file_1",
        file_id: "file_1",
        record_id: "rec_1",
        title: "Auth Notes",
        path: "auth.md",
        summary: "Authentication architecture notes.",
        content_hash: "hash",
        updated_at: "2026-05-20T00:00:00.000Z"
      },
      chunks: [
        {
          id: "chunk_1",
          file_id: "file_1",
          document_id: "doc_file_1",
          text: "JWT authentication middleware.",
          text_hash: "text_hash_1",
          chunk_index: 0,
          embedding
        }
      ],
      concepts: [{ id: "concept_auth", name: "Auth", type: "component", description: "Authentication." }],
      edges: []
    });

    await expect(queryLadybugRows(projectRoot, "MATCH (d:Document) RETURN d.id AS id")).resolves.toEqual([
      expect.objectContaining({ id: "doc_file_1" })
    ]);
    await expect(queryLadybugRows(projectRoot, "MATCH (c:Chunk) RETURN c.id AS id")).resolves.toEqual([
      expect.objectContaining({ id: "chunk_1" })
    ]);

    await deleteDocumentGraph(projectRoot, "file_1");

    await expect(queryLadybugRows(projectRoot, "MATCH (d:Document) RETURN d.id AS id")).resolves.toEqual([]);
    await expect(queryLadybugRows(projectRoot, "MATCH (c:Chunk) RETURN c.id AS id")).resolves.toEqual([]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- test/ladybug-store.test.ts
```

Expected: FAIL with missing exports `replaceDocumentGraph` and `deleteDocumentGraph`.

- [ ] **Step 3: Add graph operation types and exports**

Add to `src/ladybug-store.ts`:

```ts
import type { GraphConcept, GraphEdge } from "./graph-mapping.js";

export interface LadybugProjectNode {
  id: string;
  name: string;
  root_path: string;
}

export interface LadybugDocumentNode {
  id: string;
  file_id: string;
  record_id?: string;
  title: string;
  path: string;
  summary: string;
  content_hash: string;
  updated_at: string;
}

export interface LadybugChunkNode {
  id: string;
  file_id: string;
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
```

- [ ] **Step 4: Implement replace/delete**

Add to `src/ladybug-store.ts`:

```ts
export async function replaceDocumentGraph(projectRoot: string, input: ReplaceDocumentGraphInput): Promise<void> {
  await ensureLadybugStore(projectRoot);
  validateChunkEmbeddings(input.chunks);

  withLadybugConnection(projectRoot, (connection) => {
    deleteDocumentGraphSync(connection, input.document.file_id);

    connection.querySync(
      "MERGE (p:Project {id: $id}) SET p.name = $name, p.root_path = $root_path",
      input.project
    );
    connection.querySync(
      `
      CREATE (d:Document {
        id: $id,
        file_id: $file_id,
        record_id: $record_id,
        title: $title,
        path: $path,
        summary: $summary,
        content_hash: $content_hash,
        updated_at: $updated_at
      })
      `,
      { ...input.document, record_id: input.document.record_id ?? null }
    );
    connection.querySync(
      `
      MATCH (p:Project {id: $project_id}), (d:Document {id: $document_id})
      CREATE (p)-[:HAS_DOCUMENT]->(d)
      `,
      { project_id: input.project.id, document_id: input.document.id }
    );

    for (const chunk of input.chunks) {
      connection.querySync(
        `
        CREATE (c:Chunk {
          id: $id,
          file_id: $file_id,
          document_id: $document_id,
          text: $text,
          text_hash: $text_hash,
          chunk_index: $chunk_index,
          embedding: $embedding
        })
        `,
        chunk
      );
      connection.querySync(
        `
        MATCH (d:Document {id: $document_id}), (c:Chunk {id: $chunk_id})
        CREATE (d)-[:HAS_CHUNK]->(c)
        `,
        { document_id: input.document.id, chunk_id: chunk.id }
      );
    }

    for (let index = 0; index < input.chunks.length - 1; index += 1) {
      connection.querySync(
        `
        MATCH (left:Chunk {id: $left_id}), (right:Chunk {id: $right_id})
        CREATE (left)-[:NEXT_CHUNK]->(right)
        `,
        { left_id: input.chunks[index].id, right_id: input.chunks[index + 1].id }
      );
    }

    for (const concept of input.concepts) {
      connection.querySync(
        "MERGE (c:Concept {id: $id}) SET c.name = $name, c.type = $type, c.description = $description",
        concept
      );
      connection.querySync(
        `
        MATCH (d:Document {id: $document_id}), (c:Concept {id: $concept_id})
        MERGE (d)-[:MENTIONS]->(c)
        `,
        { document_id: input.document.id, concept_id: concept.id }
      );
    }

    for (const edge of input.edges) {
      connection.querySync(
        `
        MATCH (from:Concept {id: $from}), (to:Concept {id: $to})
        MERGE (from)-[:${edge.label} {description: $description}]->(to)
        `,
        { from: edge.from, to: edge.to, description: edge.description }
      );
    }

    runIdempotent(
      connection,
      "CALL CREATE_VECTOR_INDEX('Chunk', 'chunk_vector_index', 'embedding', metric := 'cosine');"
    );
  });
}

export async function deleteDocumentGraph(projectRoot: string, fileId: string): Promise<void> {
  await ensureLadybugStore(projectRoot);
  withLadybugConnection(projectRoot, (connection) => {
    deleteDocumentGraphSync(connection, fileId);
  });
}

function deleteDocumentGraphSync(connection: LadybugConnection, fileId: string): void {
  connection.querySync("MATCH (d:Document {file_id: $file_id}) DETACH DELETE d", { file_id: fileId });
  connection.querySync("MATCH (c:Chunk {file_id: $file_id}) DETACH DELETE c", { file_id: fileId });
}

function validateChunkEmbeddings(chunks: LadybugChunkNode[]): void {
  for (const chunk of chunks) {
    if (chunk.embedding.length !== EMBEDDING_DIMENSION) {
      throw new Error("embedding dimension mismatch");
    }
  }
}
```

If LadybugDB rejects `MERGE ... SET` syntax in this exact form, keep the same behavior and replace it with `MATCH` then conditional `CREATE` using the simplest syntax supported by the installed package. Do not change the exported function signatures.

- [ ] **Step 5: Run Ladybug store tests**

Run:

```bash
npm test -- test/ladybug-store.test.ts
```

Expected: PASS or runtime-guarded skip when LadybugDB is unavailable.

- [ ] **Step 6: Commit graph operations**

```bash
git add src/ladybug-store.ts test/ladybug-store.test.ts
git commit -m "feat: add LadybugDB document graph operations"
```

---

### Task 5: Wire File Upsert/Delete To LadybugDB

**Files:**
- Modify: `src/file-index.ts`
- Modify: `test/file-index.test.ts`

- [ ] **Step 1: Add file index graph side-effect test**

Append imports to `test/file-index.test.ts`:

```ts
import { archiveRecord } from "../src/store.js";
import { isLadybugAvailable, queryLadybugRows } from "../src/ladybug-store.js";
```

Add this test:

```ts
  it("writes indexed files and metadata relationships to LadybugDB when available", async () => {
    if (!(await isLadybugAvailable())) {
      return;
    }

    const projectRoot = await makeRoot();
    const record = await archiveRecord(projectRoot, {
      source: "Raw auth discussion",
      document: "# Auth\n\nJWT authentication middleware.",
      metadata: {
        title: "Auth Architecture",
        summary: "Auth architecture notes explain how DocNexus records JWT middleware decisions and stores graph recall metadata.",
        tags: ["auth"],
        entities: [
          { name: "DocNexus", type: "component", description: "Local memory service." },
          { name: "LadybugDB", type: "tool", description: "Graph vector store." }
        ],
        relationships: [
          { from: "DocNexus", to: "LadybugDB", type: "depends_on", description: "Uses graph storage." }
        ]
      }
    });
    const filePath = join(projectRoot, "auth.md");
    await writeFile(filePath, "# Auth\n\nJWT authentication middleware.");

    const indexed = await upsertFileIndex(projectRoot, { file_path: filePath, record_id: record.id });

    await expect(queryLadybugRows(projectRoot, "MATCH (d:Document) RETURN d.file_id AS file_id")).resolves.toEqual([
      expect.objectContaining({ file_id: indexed.file_id })
    ]);
    await expect(queryLadybugRows(projectRoot, "MATCH (c:Concept) RETURN c.name AS name ORDER BY name")).resolves.toEqual([
      expect.objectContaining({ name: "DocNexus" }),
      expect.objectContaining({ name: "LadybugDB" })
    ]);

    await deleteFileIndex(projectRoot, { file_id: indexed.file_id });

    await expect(queryLadybugRows(projectRoot, "MATCH (d:Document) RETURN d.file_id AS file_id")).resolves.toEqual([]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- test/file-index.test.ts
```

Expected: FAIL because `upsertFileIndex` does not write to LadybugDB yet.

- [ ] **Step 3: Export `recordsPath` helper from store**

Modify `src/store.ts`:

```ts
export function recordsPath(projectRoot: string): string {
  return join(storePath(projectRoot), "records");
}
```

Remove the old non-exported `function recordsPath(...)` declaration and keep all current callers working.

- [ ] **Step 4: Modify file-index imports**

In `src/file-index.ts`, add:

```ts
import { existsSync } from "node:fs";
import { relationshipsToEdges } from "./graph-mapping.js";
import { deleteDocumentGraph, replaceDocumentGraph, type LadybugChunkNode } from "./ladybug-store.js";
import { recordsPath } from "./store.js";
import type { DocNexusMetadata } from "./types.js";
```

Keep the existing `storePath` import from `./store.js`.

- [ ] **Step 5: Preserve generated chunk IDs for both stores**

Inside `upsertFileIndex`, before inserting chunks, replace the `for (const chunk of chunks)` loop with:

```ts
    const ladybugChunks: LadybugChunkNode[] = [];
    for (const chunk of chunks) {
      const chunkId = createChunkId();
      const embedding = embedder.embed(chunk.text);
      if (embedding.length !== embedder.dimension) {
        throw new Error("embedding dimension mismatch");
      }
      db.prepare(`
        INSERT INTO file_chunks (id, file_id, chunk_index, text, text_hash, embedding_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(chunkId, fileId, chunk.index, chunk.text, chunk.text_hash, JSON.stringify(embedding), now);
      ladybugChunks.push({
        id: chunkId,
        file_id: fileId,
        document_id: `doc_${fileId}`,
        text: chunk.text,
        text_hash: chunk.text_hash,
        chunk_index: chunk.index,
        embedding
      });
    }
```

- [ ] **Step 6: Write LadybugDB graph after SQLite rows**

After `insertEvent(db, fileId, "upsert", ...)` and before returning, add:

```ts
    const recordId = input.record_id ?? existing?.record_id ?? undefined;
    const metadata = recordId ? await readRecordMetadata(projectRoot, recordId) : undefined;
    const graphMapping = metadata ? relationshipsToEdges(metadata) : { concepts: [], edges: [] };

    await replaceDocumentGraph(projectRoot, {
      project: {
        id: "project",
        name: basename(projectRoot),
        root_path: resolve(projectRoot)
      },
      document: {
        id: `doc_${fileId}`,
        file_id: fileId,
        ...(recordId ? { record_id: recordId } : {}),
        title: metadata?.title ?? input.file_name ?? basename(resolved.relativePath),
        path: resolved.relativePath,
        summary: metadata?.summary ?? "",
        content_hash: contentHash,
        updated_at: now
      },
      chunks: ladybugChunks,
      concepts: graphMapping.concepts,
      edges: graphMapping.edges
    });
```

- [ ] **Step 7: Delete LadybugDB graph on explicit delete**

Inside `deleteFileIndex`, after the SQLite `insertEvent(...)`, add:

```ts
    await deleteDocumentGraph(projectRoot, row.id);
```

- [ ] **Step 8: Add metadata reader helper**

Add to the bottom of `src/file-index.ts`:

```ts
async function readRecordMetadata(projectRoot: string, recordId: string): Promise<DocNexusMetadata | undefined> {
  const metadataPath = join(recordsPath(projectRoot), recordId, "metadata.json");
  if (!existsSync(metadataPath)) {
    return undefined;
  }
  return JSON.parse(await readFile(metadataPath, "utf8")) as DocNexusMetadata;
}
```

- [ ] **Step 9: Run file index tests**

Run:

```bash
npm test -- test/file-index.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit file index wiring**

```bash
git add src/store.ts src/file-index.ts test/file-index.test.ts
git commit -m "feat: sync DocNexus file index to LadybugDB"
```

---

### Task 6: Implement LadybugDB Recall

**Files:**
- Modify: `src/ladybug-store.ts`
- Modify: `src/recall.ts`
- Modify: `test/recall.test.ts`
- Modify: `test/mcp.test.ts`

- [ ] **Step 1: Add graph-backed recall tests**

Update `test/recall.test.ts` expected ranked result to include graph fields:

```ts
    expect(result.results[0]).toMatchObject({
      file_path: "auth.md",
      chunk_index: 0,
      text: expect.stringContaining("JWT"),
      concepts: expect.any(Array),
      related_concepts: expect.any(Array)
    });
```

Add this test:

```ts
  it("returns document and graph context when metadata is linked", async () => {
    const projectRoot = await makeRoot();
    const record = await archiveRecord(projectRoot, {
      source: "Raw auth discussion",
      document: "# Auth\n\nJWT authentication middleware.",
      metadata: {
        title: "Auth Architecture",
        summary: "Auth architecture notes explain JWT middleware and LadybugDB graph recall context for agent retrieval.",
        tags: ["auth"],
        entities: [
          { name: "Auth Middleware", type: "component", description: "Validates JWT tokens." },
          { name: "LadybugDB", type: "tool", description: "Stores graph recall." }
        ],
        relationships: [
          { from: "Auth Middleware", to: "LadybugDB", type: "relates_to", description: "Appears in recall graph." }
        ]
      }
    });
    const filePath = join(projectRoot, "auth.md");
    await writeFile(filePath, "JWT token validation and authentication middleware.");
    await upsertFileIndex(projectRoot, { file_path: filePath, record_id: record.id });

    const result = await recall(projectRoot, { query: "JWT authentication", limit: 1 });

    expect(result.results[0]).toMatchObject({
      file_path: "auth.md",
      record_id: record.id,
      document_title: "Auth Architecture",
      document_summary: expect.stringContaining("JWT"),
      concepts: expect.arrayContaining(["Auth Middleware"]),
      related_concepts: expect.arrayContaining(["LadybugDB"])
    });
  });
```

Add missing import:

```ts
import { archiveRecord } from "../src/store.js";
```

- [ ] **Step 2: Run recall tests to verify they fail**

Run:

```bash
npm test -- test/recall.test.ts
```

Expected: FAIL because recall still reads SQLite and does not return graph context.

- [ ] **Step 3: Add Ladybug recall types and query**

Add to `src/ladybug-store.ts`:

```ts
export interface LadybugRecallRow {
  file_id: string;
  file_path: string;
  record_id: string | null;
  document_title: string;
  document_summary: string;
  chunk_id: string;
  chunk_index: number;
  score: number;
  text: string;
  next_text: string | null;
  concepts: string[];
  related_concepts: string[];
}

export async function recallFromLadybug(
  projectRoot: string,
  queryEmbedding: number[],
  limit: number
): Promise<LadybugRecallRow[]> {
  if (queryEmbedding.length !== EMBEDDING_DIMENSION) {
    throw new Error("embedding dimension mismatch");
  }

  await ensureLadybugStore(projectRoot);
  const rows = await queryLadybugRows(
    projectRoot,
    `
    CALL QUERY_VECTOR_INDEX('Chunk', 'chunk_vector_index', $query_embedding, $limit)
    WITH node AS c, distance AS distance
    MATCH (d:Document)-[:HAS_CHUNK]->(c)
    OPTIONAL MATCH (c)-[:NEXT_CHUNK]->(nextChunk:Chunk)
    OPTIONAL MATCH (d)-[:MENTIONS]->(concept:Concept)
    OPTIONAL MATCH (concept)-[:DEPENDS_ON|RELATES_TO|IMPLEMENTS|REPLACES|DECIDES]->(related:Concept)
    RETURN
      c.file_id AS file_id,
      d.path AS file_path,
      d.record_id AS record_id,
      d.title AS document_title,
      d.summary AS document_summary,
      c.id AS chunk_id,
      c.chunk_index AS chunk_index,
      distance AS score,
      c.text AS text,
      nextChunk.text AS next_text,
      collect(DISTINCT concept.name) AS concepts,
      collect(DISTINCT related.name) AS related_concepts
    ORDER BY distance
    LIMIT $limit
    `,
    { query_embedding: queryEmbedding, limit }
  );

  return rows as LadybugRecallRow[];
}
```

- [ ] **Step 4: Replace SQLite recall implementation**

Modify `src/recall.ts` to remove `cosineSimilarity`, `ensureIndexStore`, and `openIndexDatabase` imports. Add:

```ts
import { recallFromLadybug } from "./ladybug-store.js";
```

Update `RecallResult`:

```ts
export interface RecallResult {
  file_id: string;
  file_path: string;
  record_id?: string;
  document_title: string;
  document_summary: string;
  chunk_id: string;
  chunk_index: number;
  score: number;
  text: string;
  next_text?: string;
  concepts: string[];
  related_concepts: string[];
}
```

Replace the SQLite query block with:

```ts
  const rows = await recallFromLadybug(projectRoot, queryEmbedding, limit);
  const results = rows.map((row) => ({
    file_id: row.file_id,
    file_path: row.file_path,
    ...(row.record_id ? { record_id: row.record_id } : {}),
    document_title: row.document_title,
    document_summary: row.document_summary,
    chunk_id: row.chunk_id,
    chunk_index: row.chunk_index,
    score: row.score,
    text: row.text,
    ...(row.next_text ? { next_text: row.next_text } : {}),
    concepts: row.concepts ?? [],
    related_concepts: row.related_concepts ?? []
  }));

  return { query, results };
```

- [ ] **Step 5: Update MCP recall test expectations**

In `test/mcp.test.ts`, find the recall tool test and ensure it accepts graph fields:

```ts
await expect(callTool(projectRoot, "recall", { query: "local memory" })).resolves.toMatchObject({
  query: "local memory",
  results: expect.any(Array)
});
```

Do not assert the old SQLite-only result shape.

- [ ] **Step 6: Run recall and MCP tests**

Run:

```bash
npm test -- test/recall.test.ts test/mcp.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit LadybugDB recall**

```bash
git add src/ladybug-store.ts src/recall.ts test/recall.test.ts test/mcp.test.ts
git commit -m "feat: query DocNexus recall from LadybugDB"
```

---

### Task 7: Add Failure Event Handling For LadybugDB Write Errors

**Files:**
- Modify: `src/file-index.ts`
- Modify: `test/file-index.test.ts`

- [ ] **Step 1: Export an injectable graph writer for tests**

In `src/file-index.ts`, define:

```ts
interface GraphWriter {
  replaceDocumentGraph: typeof replaceDocumentGraph;
  deleteDocumentGraph: typeof deleteDocumentGraph;
}

const defaultGraphWriter: GraphWriter = {
  replaceDocumentGraph,
  deleteDocumentGraph
};
```

Change `upsertFileIndex` signature:

```ts
export async function upsertFileIndex(
  projectRoot: string,
  input: UpsertFileIndexInput,
  embedder: Embedder = defaultEmbedder,
  graphWriter: GraphWriter = defaultGraphWriter
): Promise<UpsertFileIndexOutput> {
```

Change `deleteFileIndex` signature:

```ts
export async function deleteFileIndex(
  projectRoot: string,
  input: DeleteFileIndexInput,
  graphWriter: GraphWriter = defaultGraphWriter
): Promise<DeleteFileIndexOutput> {
```

Update internal calls to use `graphWriter.replaceDocumentGraph` and `graphWriter.deleteDocumentGraph`.

- [ ] **Step 2: Add failure event test**

Add this test to `test/file-index.test.ts`:

```ts
  it("records failed index event when LadybugDB graph write fails", async () => {
    const projectRoot = await makeRoot();
    const filePath = join(projectRoot, "failure.md");
    await writeFile(filePath, "Failure event content.");

    await expect(
      upsertFileIndex(
        projectRoot,
        { file_path: filePath },
        undefined,
        {
          replaceDocumentGraph: async () => {
            throw new Error("failed to write LadybugDB graph");
          },
          deleteDocumentGraph: async () => {}
        }
      )
    ).rejects.toThrow("failed to write LadybugDB graph");

    await expect(getIndexStatus(projectRoot)).resolves.toMatchObject({
      last_event: expect.objectContaining({
        operation: "upsert",
        result: "failed"
      })
    });
  });
```

- [ ] **Step 3: Write failed events on graph write errors**

In `upsertFileIndex`, move the graph input currently passed directly to `replaceDocumentGraph` into a named constant:

```ts
    const graphInput = {
      project: {
        id: "project",
        name: basename(projectRoot),
        root_path: resolve(projectRoot)
      },
      document: {
        id: `doc_${fileId}`,
        file_id: fileId,
        ...(recordId ? { record_id: recordId } : {}),
        title: metadata?.title ?? input.file_name ?? basename(resolved.relativePath),
        path: resolved.relativePath,
        summary: metadata?.summary ?? "",
        content_hash: contentHash,
        updated_at: now
      },
      chunks: ladybugChunks,
      concepts: graphMapping.concepts,
      edges: graphMapping.edges
    };
```

Then wrap the graph writer call:

```ts
    try {
      await graphWriter.replaceDocumentGraph(projectRoot, graphInput);
    } catch (error) {
      insertEvent(
        db,
        fileId,
        "upsert",
        resolved.relativePath,
        "failed",
        error instanceof Error ? error.message : String(error),
        new Date().toISOString()
      );
      throw error;
    }
```

Keep the existing successful event only after graph write succeeds.

In `deleteFileIndex`, wrap `graphWriter.deleteDocumentGraph` similarly and write:

```ts
insertEvent(db, row.id, "delete", row.file_path, "failed", message, new Date().toISOString());
```

before rethrowing.

- [ ] **Step 4: Run file index tests**

Run:

```bash
npm test -- test/file-index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit failure event handling**

```bash
git add src/file-index.ts test/file-index.test.ts
git commit -m "fix: record LadybugDB index failures"
```

---

### Task 8: Update Product Documentation

**Files:**
- Modify: `docs/product-brief-docnexus-mvp.zh-CN.md`
- Modify: `docs/product-brief-docnexus-mvp.en.md`
- Modify: `docs/product-brief-docnexus-mvp.md`

- [ ] **Step 1: Update Chinese product brief**

In `docs/product-brief-docnexus-mvp.zh-CN.md`, update these points:

- Local Core becomes `SQLite + LadybugDB`.
- Storage includes `.docnexus/store.lbug`.
- Recall flow says LadybugDB vector index and graph traversal are now used.
- "当前已实现" adds LadybugDB graph/vector recall.
- "当前暂未实现" removes LadybugDB/Kuzu graph database and full Graph RAG distinction should become "production Graph RAG tuning / full rebuild / graph cleanup".

- [ ] **Step 2: Update English product brief**

Mirror the same changes in `docs/product-brief-docnexus-mvp.en.md`.

- [ ] **Step 3: Update combined product brief**

Mirror both language changes in `docs/product-brief-docnexus-mvp.md`.

- [ ] **Step 4: Search for stale statements**

Run:

```bash
rg -n "LadybugDB/Kuzu graph database|TypeScript 层计算 cosine|calculates cosine similarity in TypeScript|LocalHashEmbedder 生成 query embedding" docs/product-brief-docnexus-mvp*.md
```

Expected: no stale claims that LadybugDB is not implemented or that recall is SQLite-only.

- [ ] **Step 5: Commit docs**

```bash
git add docs/product-brief-docnexus-mvp.zh-CN.md docs/product-brief-docnexus-mvp.en.md docs/product-brief-docnexus-mvp.md
git commit -m "docs: update DocNexus LadybugDB product brief"
```

---

### Task 9: Full Verification

**Files:**
- No code changes expected.

- [ ] **Step 1: Run full tests**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 4: Run CLI smoke test**

Run:

```bash
node dist/src/cli.js index status
```

Expected: JSON output with `indexed_file_count`, `chunk_count`, and `deleted_file_count`.

- [ ] **Step 5: Inspect git status**

Run:

```bash
git status --short
```

Expected: only known unrelated untracked files remain, or no output if docs were committed and the repo is otherwise clean.

---

## Self-Review

Spec coverage:

- LadybugDB `.docnexus/store.lbug`: Task 3.
- Schema and vector index: Task 3.
- Metadata entities/relationships: Task 2 and Task 5.
- Upsert graph replacement: Task 4 and Task 5.
- Delete recall graph: Task 4 and Task 5.
- LadybugDB recall with graph context: Task 6.
- Error handling and failed audit events: Task 7.
- Public CLI/MCP names unchanged: Task 6 keeps contracts stable.
- Documentation update: Task 8.
- Full verification: Task 9.

Type consistency:

- `EMBEDDING_DIMENSION` is shared by embedder and Ladybug schema.
- `GraphConcept` and `GraphEdge` are produced by `graph-mapping.ts` and consumed by `ladybug-store.ts`.
- `replaceDocumentGraph` uses the same `chunkId` generated for SQLite chunks.
- `recallFromLadybug` returns fields matching `RecallResult`.

Known implementation risk:

- LadybugDB Node result conversion may expose a different method than `getAllObjects`, `get_as_js`, `getAsJs`, or `toArray`. If tests show the actual method name, update only `rowsFromResult` in `src/ladybug-store.ts`; keep all public DocNexus signatures unchanged.
