# DocNexus Incremental Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build command-driven file indexing and local semantic recall for DocNexus.

**Architecture:** Add focused TypeScript modules for deterministic chunking, local hash-based embeddings, SQLite-backed file index operations, recall ranking, MCP tool exposure, and a small CLI. The archive flow remains unchanged; indexing is explicit through `upsert_file_index` and `delete_file_index`.

**Tech Stack:** Node.js 24, TypeScript, `node:sqlite`, Vitest, existing `@modelcontextprotocol/sdk`, existing `zod`.

---

## File Structure

Create:

- `src/chunker.ts`: deterministic paragraph-first text chunking.
- `src/embedder.ts`: local `Embedder` interface, `LocalHashEmbedder`, cosine similarity.
- `src/file-index.ts`: SQLite-backed `upsertFileIndex`, `deleteFileIndex`, `getIndexStatus`.
- `src/recall.ts`: query embedding, chunk ranking, recall result shaping.
- `src/cli.ts`: direct command-line interface for index and recall commands.
- `test/chunker.test.ts`: chunker unit tests.
- `test/embedder.test.ts`: embedder unit tests.
- `test/file-index.test.ts`: file index integration tests.
- `test/recall.test.ts`: recall integration tests.
- `test/cli.test.ts`: CLI parser and command behavior tests.

Modify:

- `src/ids.ts`: add ID helpers for indexed files, chunks, and events.
- `src/mcp.ts`: expose `upsert_file_index`, `delete_file_index`, `recall`, and `index_status`.
- `package.json`: add `docnexus` CLI bin while keeping `docnexus-mcp`.
- `test/mcp.test.ts`: cover new MCP tools.

Keep unchanged:

- `archive_record` behavior.
- `docnexus-capture` skill behavior.
- `.docnexus/records/<id>/` archive retention.

---

### Task 1: Deterministic Chunker

**Files:**
- Create: `src/chunker.ts`
- Create: `test/chunker.test.ts`

- [ ] **Step 1: Write failing chunker tests**

Create `test/chunker.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { chunkText } from "../src/chunker.js";

describe("chunkText", () => {
  it("rejects empty content", () => {
    expect(() => chunkText(" \n\t ")).toThrow("file content is empty");
  });

  it("returns one chunk for short content", () => {
    const chunks = chunkText("# Title\n\nA short paragraph.");

    expect(chunks).toEqual([
      {
        index: 0,
        text: "# Title\n\nA short paragraph.",
        text_hash: expect.stringMatching(/^[0-9a-f]{64}$/)
      }
    ]);
  });

  it("splits long content into stable ordered chunks", () => {
    const paragraph = "DocNexus keeps local project memory for agents. ".repeat(12).trim();
    const content = Array.from({ length: 8 }, (_, index) => `${paragraph} Section ${index}.`).join("\n\n");

    const chunks = chunkText(content, { targetSize: 500 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index));
    expect(chunks.every((chunk) => chunk.text.trim().length > 0)).toBe(true);
    expect(new Set(chunks.map((chunk) => chunk.text_hash)).size).toBe(chunks.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- test/chunker.test.ts
```

Expected: FAIL with an import error for `../src/chunker.js`.

- [ ] **Step 3: Implement chunker**

Create `src/chunker.ts`:

```ts
import { sha256 } from "./hash.js";

export interface TextChunk {
  index: number;
  text: string;
  text_hash: string;
}

export interface ChunkTextOptions {
  targetSize?: number;
}

const defaultTargetSize = 1000;

export function chunkText(content: string, options: ChunkTextOptions = {}): TextChunk[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    throw new Error("file content is empty");
  }

  const targetSize = options.targetSize ?? defaultTargetSize;
  const paragraphs = normalized.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }

    const next = `${current}\n\n${paragraph}`;
    if (next.length <= targetSize) {
      current = next;
      continue;
    }

    chunks.push(current);
    current = paragraph;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.map((text, index) => ({
    index,
    text,
    text_hash: sha256(text)
  }));
}
```

- [ ] **Step 4: Run chunker tests**

Run:

```bash
npm test -- test/chunker.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit chunker**

```bash
git add src/chunker.ts test/chunker.test.ts
git commit -m "feat: add DocNexus text chunker"
```

---

### Task 2: Local Embedder

**Files:**
- Create: `src/embedder.ts`
- Create: `test/embedder.test.ts`

- [ ] **Step 1: Write failing embedder tests**

Create `test/embedder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LocalHashEmbedder, cosineSimilarity } from "../src/embedder.js";

describe("LocalHashEmbedder", () => {
  it("creates stable vectors with a fixed dimension", () => {
    const embedder = new LocalHashEmbedder(32);

    const first = embedder.embed("DocNexus local recall");
    const second = embedder.embed("DocNexus local recall");

    expect(first).toHaveLength(32);
    expect(second).toEqual(first);
  });

  it("creates different vectors for different text", () => {
    const embedder = new LocalHashEmbedder(32);

    expect(embedder.embed("archive record")).not.toEqual(embedder.embed("delete index"));
  });

  it("computes cosine similarity", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("rejects dimension mismatches", () => {
    expect(() => cosineSimilarity([1, 0], [1])).toThrow("embedding dimension mismatch");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- test/embedder.test.ts
```

Expected: FAIL with an import error for `../src/embedder.js`.

- [ ] **Step 3: Implement local embedder**

Create `src/embedder.ts`:

```ts
import { createHash } from "node:crypto";

export interface Embedder {
  dimension: number;
  embed(text: string): number[];
}

export class LocalHashEmbedder implements Embedder {
  readonly dimension: number;

  constructor(dimension = 64) {
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new Error("embedding dimension must be a positive integer");
    }
    this.dimension = dimension;
  }

  embed(text: string): number[] {
    const tokens = tokenize(text);
    const vector = Array.from({ length: this.dimension }, () => 0);

    for (const token of tokens) {
      const hash = createHash("sha256").update(token, "utf8").digest();
      const index = hash.readUInt32BE(0) % this.dimension;
      const sign = hash[4] % 2 === 0 ? 1 : -1;
      vector[index] += sign;
    }

    return normalize(vector);
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    throw new Error("embedding dimension mismatch");
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function tokenize(text: string): string[] {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu);
  return tokens && tokens.length > 0 ? tokens : [text];
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }
  return vector.map((value) => value / magnitude);
}
```

- [ ] **Step 4: Run embedder tests**

Run:

```bash
npm test -- test/embedder.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit embedder**

```bash
git add src/embedder.ts test/embedder.test.ts
git commit -m "feat: add local DocNexus embedder"
```

---

### Task 3: Index IDs and File Index Store

**Files:**
- Modify: `src/ids.ts`
- Create: `src/file-index.ts`
- Create: `test/file-index.test.ts`

- [ ] **Step 1: Write failing file index tests**

Create `test/file-index.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteFileIndex, getIndexStatus, upsertFileIndex } from "../src/file-index.js";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-index-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file index", () => {
  it("creates, noops, and updates an indexed file", async () => {
    const projectRoot = await makeRoot();
    const filePath = join(projectRoot, "notes.md");
    await writeFile(filePath, "# Notes\n\nDocNexus indexes local memory.");

    const created = await upsertFileIndex(projectRoot, { file_path: filePath });
    expect(created).toMatchObject({
      file_path: "notes.md",
      result: "created",
      chunk_count: 1
    });
    expect(created.file_id).toMatch(/^file_[0-9a-f]{16}$/);
    expect(created.content_hash).toMatch(/^[0-9a-f]{64}$/);

    const noop = await upsertFileIndex(projectRoot, { file_path: filePath });
    expect(noop).toMatchObject({
      file_id: created.file_id,
      file_path: "notes.md",
      result: "noop",
      chunk_count: 1,
      content_hash: created.content_hash
    });

    await writeFile(filePath, "# Notes\n\nDocNexus indexes changed local memory.");
    const updated = await upsertFileIndex(projectRoot, { file_path: filePath });
    expect(updated).toMatchObject({
      file_id: created.file_id,
      file_path: "notes.md",
      result: "updated",
      chunk_count: 1
    });
    expect(updated.content_hash).not.toBe(created.content_hash);
  });

  it("rejects files outside the project root", async () => {
    const projectRoot = await makeRoot();
    const outsideRoot = await makeRoot();
    const filePath = join(outsideRoot, "outside.md");
    await writeFile(filePath, "outside");

    await expect(upsertFileIndex(projectRoot, { file_path: filePath })).rejects.toThrow(
      "file must be under project root"
    );
  });

  it("deletes chunks and marks the file deleted", async () => {
    const projectRoot = await makeRoot();
    const filePath = join(projectRoot, "delete.md");
    await writeFile(filePath, "Delete this index.");

    const created = await upsertFileIndex(projectRoot, { file_path: filePath });
    const deleted = await deleteFileIndex(projectRoot, { file_id: created.file_id });

    expect(deleted).toEqual({
      file_id: created.file_id,
      file_path: "delete.md",
      result: "deleted"
    });

    await expect(getIndexStatus(projectRoot)).resolves.toMatchObject({
      indexed_file_count: 0,
      chunk_count: 0,
      deleted_file_count: 1
    });
  });

  it("returns a clear error for unknown deletes", async () => {
    const projectRoot = await makeRoot();

    await expect(deleteFileIndex(projectRoot, { file_path: "missing.md" })).rejects.toThrow("indexed file not found");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- test/file-index.test.ts
```

Expected: FAIL with an import error for `../src/file-index.js`.

- [ ] **Step 3: Add ID helpers**

Modify `src/ids.ts`:

```ts
import { randomBytes } from "node:crypto";

export function createRecordId(): string {
  return `rec_${randomHex()}`;
}

export function createFileId(): string {
  return `file_${randomHex()}`;
}

export function createChunkId(): string {
  return `chunk_${randomHex()}`;
}

export function createEventId(): string {
  return `evt_${randomHex()}`;
}

function randomHex(): string {
  return randomBytes(8).toString("hex");
}
```

- [ ] **Step 4: Implement file index store**

Create `src/file-index.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { chunkText } from "./chunker.js";
import { LocalHashEmbedder, type Embedder } from "./embedder.js";
import { sha256 } from "./hash.js";
import { createChunkId, createEventId, createFileId } from "./ids.js";
import { storePath } from "./store.js";

export interface UpsertFileIndexInput {
  file_path: string;
  file_name?: string;
  record_id?: string;
}

export interface UpsertFileIndexOutput {
  file_id: string;
  file_path: string;
  result: "created" | "updated" | "noop";
  chunk_count: number;
  content_hash: string;
}

export interface DeleteFileIndexInput {
  file_path?: string;
  file_id?: string;
}

export interface DeleteFileIndexOutput {
  file_id: string;
  file_path: string;
  result: "deleted";
}

export interface IndexStatusOutput {
  indexed_file_count: number;
  chunk_count: number;
  deleted_file_count: number;
  last_event?: {
    operation: string;
    result: string;
    created_at: string;
  };
}

interface IndexedFileRow {
  id: string;
  file_name: string;
  file_path: string;
  content_hash: string;
  record_id: string | null;
  index_state: string;
}

interface CountRow {
  count: number;
}

interface LastEventRow {
  operation: string;
  result: string;
  created_at: string;
}

const defaultEmbedder = new LocalHashEmbedder();

export async function upsertFileIndex(
  projectRoot: string,
  input: UpsertFileIndexInput,
  embedder: Embedder = defaultEmbedder
): Promise<UpsertFileIndexOutput> {
  if (typeof input.file_path !== "string" || input.file_path.trim().length === 0) {
    throw new Error("file_path is required");
  }

  const resolved = resolveProjectFile(projectRoot, input.file_path);
  const content = await readFile(resolved.absolutePath, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("file does not exist");
    }
    throw new Error("file is not readable");
  });
  const chunks = chunkText(content);
  const contentHash = sha256(content);

  await ensureIndexStore(projectRoot);
  const now = new Date().toISOString();
  const db = openDatabase(projectRoot);

  try {
    const existing = getFileByPath(db, resolved.relativePath);
    if (existing && existing.content_hash === contentHash && existing.index_state === "indexed") {
      const chunkCount = countChunks(db, existing.id);
      insertEvent(db, existing.id, "upsert", resolved.relativePath, "noop", null, now);
      return {
        file_id: existing.id,
        file_path: resolved.relativePath,
        result: "noop",
        chunk_count: chunkCount,
        content_hash: contentHash
      };
    }

    const fileId = existing?.id ?? createFileId();
    db.prepare("DELETE FROM file_chunks WHERE file_id = ?").run(fileId);

    if (existing) {
      db.prepare(`
        UPDATE indexed_files
        SET file_name = ?, content_hash = ?, record_id = ?, index_state = 'indexed', updated_at = ?, deleted_at = NULL
        WHERE id = ?
      `).run(input.file_name ?? basename(resolved.relativePath), contentHash, input.record_id ?? existing.record_id, now, fileId);
    } else {
      db.prepare(`
        INSERT INTO indexed_files (
          id, file_name, file_path, content_hash, metadata_hash, record_id, index_state, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, NULL, ?, 'indexed', ?, ?, NULL)
      `).run(fileId, input.file_name ?? basename(resolved.relativePath), resolved.relativePath, contentHash, input.record_id ?? null, now, now);
    }

    for (const chunk of chunks) {
      const embedding = embedder.embed(chunk.text);
      if (embedding.length !== embedder.dimension) {
        throw new Error("embedding dimension mismatch");
      }
      db.prepare(`
        INSERT INTO file_chunks (id, file_id, chunk_index, text, text_hash, embedding_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(createChunkId(), fileId, chunk.index, chunk.text, chunk.text_hash, JSON.stringify(embedding), now);
    }

    const result = existing ? "updated" : "created";
    insertEvent(db, fileId, "upsert", resolved.relativePath, result, null, now);

    return {
      file_id: fileId,
      file_path: resolved.relativePath,
      result,
      chunk_count: chunks.length,
      content_hash: contentHash
    };
  } finally {
    db.close();
  }
}

export async function deleteFileIndex(projectRoot: string, input: DeleteFileIndexInput): Promise<DeleteFileIndexOutput> {
  if (!input.file_id && !input.file_path) {
    throw new Error("file_path or file_id is required");
  }

  await ensureIndexStore(projectRoot);
  const db = openDatabase(projectRoot);
  const now = new Date().toISOString();

  try {
    const row = input.file_id
      ? getFileById(db, input.file_id)
      : getFileByPath(db, resolveProjectFile(projectRoot, input.file_path as string).relativePath);

    if (!row) {
      throw new Error("indexed file not found");
    }

    db.prepare("DELETE FROM file_chunks WHERE file_id = ?").run(row.id);
    db.prepare("UPDATE indexed_files SET index_state = 'deleted', updated_at = ?, deleted_at = ? WHERE id = ?").run(now, now, row.id);
    insertEvent(db, row.id, "delete", row.file_path, "deleted", null, now);

    return {
      file_id: row.id,
      file_path: row.file_path,
      result: "deleted"
    };
  } finally {
    db.close();
  }
}

export async function getIndexStatus(projectRoot: string): Promise<IndexStatusOutput> {
  await ensureIndexStore(projectRoot);
  const db = openDatabase(projectRoot);

  try {
    const indexed = db.prepare("SELECT COUNT(*) as count FROM indexed_files WHERE index_state = 'indexed'").get() as CountRow;
    const deleted = db.prepare("SELECT COUNT(*) as count FROM indexed_files WHERE index_state = 'deleted'").get() as CountRow;
    const chunks = db.prepare(`
      SELECT COUNT(*) as count
      FROM file_chunks
      JOIN indexed_files ON indexed_files.id = file_chunks.file_id
      WHERE indexed_files.index_state = 'indexed'
    `).get() as CountRow;
    const lastEvent = db.prepare(`
      SELECT operation, result, created_at
      FROM index_events
      ORDER BY created_at DESC
      LIMIT 1
    `).get() as LastEventRow | undefined;

    return {
      indexed_file_count: indexed.count,
      chunk_count: chunks.count,
      deleted_file_count: deleted.count,
      ...(lastEvent ? { last_event: lastEvent } : {})
    };
  } finally {
    db.close();
  }
}

export async function ensureIndexStore(projectRoot: string): Promise<void> {
  await mkdir(storePath(projectRoot), { recursive: true });
  const db = openDatabase(projectRoot);

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS indexed_files (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        content_hash TEXT NOT NULL,
        metadata_hash TEXT,
        record_id TEXT,
        index_state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS file_chunks (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS index_events (
        id TEXT PRIMARY KEY,
        file_id TEXT,
        operation TEXT NOT NULL,
        file_path TEXT NOT NULL,
        result TEXT NOT NULL,
        message TEXT,
        created_at TEXT NOT NULL
      );
    `);
  } finally {
    db.close();
  }
}

export function openIndexDatabase(projectRoot: string): DatabaseSync {
  return openDatabase(projectRoot);
}

function openDatabase(projectRoot: string): DatabaseSync {
  return new DatabaseSync(join(storePath(projectRoot), "index.sqlite"));
}

function resolveProjectFile(projectRoot: string, filePath: string): { absolutePath: string; relativePath: string } {
  const root = resolve(projectRoot);
  const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  const relativePath = relative(root, absolutePath);

  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("file must be under project root");
  }

  return {
    absolutePath,
    relativePath: relativePath.split(sep).join("/")
  };
}

function getFileByPath(db: DatabaseSync, filePath: string): IndexedFileRow | undefined {
  return db.prepare("SELECT id, file_name, file_path, content_hash, record_id, index_state FROM indexed_files WHERE file_path = ?").get(filePath) as IndexedFileRow | undefined;
}

function getFileById(db: DatabaseSync, fileId: string): IndexedFileRow | undefined {
  return db.prepare("SELECT id, file_name, file_path, content_hash, record_id, index_state FROM indexed_files WHERE id = ?").get(fileId) as IndexedFileRow | undefined;
}

function countChunks(db: DatabaseSync, fileId: string): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM file_chunks WHERE file_id = ?").get(fileId) as CountRow;
  return row.count;
}

function insertEvent(
  db: DatabaseSync,
  fileId: string | null,
  operation: string,
  filePath: string,
  result: string,
  message: string | null,
  createdAt: string
): void {
  db.prepare(`
    INSERT INTO index_events (id, file_id, operation, file_path, result, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(createEventId(), fileId, operation, filePath, result, message, createdAt);
}
```

- [ ] **Step 5: Run file index tests**

Run:

```bash
npm test -- test/file-index.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit file index store**

```bash
git add src/ids.ts src/file-index.ts test/file-index.test.ts
git commit -m "feat: add explicit DocNexus file index"
```

---

### Task 4: Recall Service

**Files:**
- Create: `src/recall.ts`
- Create: `test/recall.test.ts`

- [ ] **Step 1: Write failing recall tests**

Create `test/recall.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteFileIndex, upsertFileIndex } from "../src/file-index.js";
import { recall } from "../src/recall.js";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-recall-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("recall", () => {
  it("returns ranked chunks for indexed files", async () => {
    const projectRoot = await makeRoot();
    const authFile = join(projectRoot, "auth.md");
    const billingFile = join(projectRoot, "billing.md");
    await writeFile(authFile, "JWT token validation and authentication middleware.");
    await writeFile(billingFile, "Stripe invoice billing and subscription lifecycle.");

    await upsertFileIndex(projectRoot, { file_path: authFile });
    await upsertFileIndex(projectRoot, { file_path: billingFile });

    const result = await recall(projectRoot, { query: "JWT authentication", limit: 1 });

    expect(result.query).toBe("JWT authentication");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      file_path: "auth.md",
      chunk_index: 0,
      text: expect.stringContaining("JWT")
    });
    expect(result.results[0]?.score).toBeGreaterThan(0);
  });

  it("excludes deleted files", async () => {
    const projectRoot = await makeRoot();
    const filePath = join(projectRoot, "deleted.md");
    await writeFile(filePath, "Deleted recall content.");
    const indexed = await upsertFileIndex(projectRoot, { file_path: filePath });
    await deleteFileIndex(projectRoot, { file_id: indexed.file_id });

    await expect(recall(projectRoot, { query: "Deleted recall content" })).resolves.toEqual({
      query: "Deleted recall content",
      results: []
    });
  });

  it("returns empty results for an empty index", async () => {
    const projectRoot = await makeRoot();

    await expect(recall(projectRoot, { query: "nothing" })).resolves.toEqual({
      query: "nothing",
      results: []
    });
  });

  it("validates query and limit", async () => {
    const projectRoot = await makeRoot();

    await expect(recall(projectRoot, { query: "" })).rejects.toThrow("query must be a non-empty string");
    await expect(recall(projectRoot, { query: "x", limit: 0 })).rejects.toThrow("limit must be a positive integer");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- test/recall.test.ts
```

Expected: FAIL with an import error for `../src/recall.js`.

- [ ] **Step 3: Implement recall service**

Create `src/recall.ts`:

```ts
import { LocalHashEmbedder, cosineSimilarity, type Embedder } from "./embedder.js";
import { ensureIndexStore, openIndexDatabase } from "./file-index.js";

export interface RecallInput {
  query: string;
  limit?: number;
}

export interface RecallResult {
  file_id: string;
  file_path: string;
  record_id?: string;
  chunk_id: string;
  chunk_index: number;
  score: number;
  text: string;
}

export interface RecallOutput {
  query: string;
  results: RecallResult[];
}

interface ChunkRow {
  chunk_id: string;
  file_id: string;
  file_path: string;
  record_id: string | null;
  chunk_index: number;
  text: string;
  embedding_json: string;
}

const defaultEmbedder = new LocalHashEmbedder();

export async function recall(
  projectRoot: string,
  input: RecallInput,
  embedder: Embedder = defaultEmbedder
): Promise<RecallOutput> {
  if (typeof input.query !== "string" || input.query.trim().length === 0) {
    throw new Error("query must be a non-empty string");
  }
  const limit = normalizeLimit(input.limit);
  await ensureIndexStore(projectRoot);

  const query = input.query.trim();
  const queryEmbedding = embedder.embed(query);
  if (queryEmbedding.length !== embedder.dimension) {
    throw new Error("embedding dimension mismatch");
  }

  const db = openIndexDatabase(projectRoot);
  try {
    const rows = db.prepare(`
      SELECT
        file_chunks.id AS chunk_id,
        file_chunks.file_id AS file_id,
        indexed_files.file_path AS file_path,
        indexed_files.record_id AS record_id,
        file_chunks.chunk_index AS chunk_index,
        file_chunks.text AS text,
        file_chunks.embedding_json AS embedding_json
      FROM file_chunks
      JOIN indexed_files ON indexed_files.id = file_chunks.file_id
      WHERE indexed_files.index_state = 'indexed'
    `).all() as unknown as ChunkRow[];

    const results = rows
      .map((row) => {
        const embedding = JSON.parse(row.embedding_json) as number[];
        const score = cosineSimilarity(queryEmbedding, embedding);
        return {
          file_id: row.file_id,
          file_path: row.file_path,
          ...(row.record_id ? { record_id: row.record_id } : {}),
          chunk_id: row.chunk_id,
          chunk_index: row.chunk_index,
          score,
          text: row.text
        };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);

    return { query, results };
  } finally {
    db.close();
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) {
    return 5;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("limit must be a positive integer");
  }
  return Math.min(value, 20);
}
```

- [ ] **Step 4: Run recall tests**

Run:

```bash
npm test -- test/recall.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit recall service**

```bash
git add src/recall.ts test/recall.test.ts
git commit -m "feat: add local DocNexus recall"
```

---

### Task 5: MCP Tools

**Files:**
- Modify: `src/mcp.ts`
- Modify: `test/mcp.test.ts`

- [ ] **Step 1: Add failing MCP tests**

Append these tests inside `describe("callTool", () => { ... })` in `test/mcp.test.ts`:

```ts
  it("indexes, recalls, and deletes a file through MCP handlers", async () => {
    const projectRoot = await makeRoot();
    const filePath = join(projectRoot, "memory.md");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(filePath, "Agent memory recall through local chunks.")
    );

    const indexed = await callTool(projectRoot, "upsert_file_index", { file_path: filePath });
    expect(indexed).toMatchObject({
      file_path: "memory.md",
      result: "created",
      chunk_count: 1
    });

    const recalled = await callTool(projectRoot, "recall", { query: "local chunks", limit: 1 });
    expect(recalled.results).toHaveLength(1);
    expect(recalled.results[0]).toMatchObject({
      file_path: "memory.md",
      text: expect.stringContaining("local chunks")
    });

    const deleted = await callTool(projectRoot, "delete_file_index", { file_id: indexed.file_id });
    expect(deleted).toEqual({
      file_id: indexed.file_id,
      file_path: "memory.md",
      result: "deleted"
    });
  });

  it("reports index status through MCP handlers", async () => {
    const projectRoot = await makeRoot();

    await expect(callTool(projectRoot, "index_status", {})).resolves.toMatchObject({
      indexed_file_count: 0,
      chunk_count: 0,
      deleted_file_count: 0
    });
  });

  it("rejects invalid recall limits before querying", async () => {
    const projectRoot = await makeRoot();

    await expect(callTool(projectRoot, "recall", { query: "x", limit: 1.5 })).rejects.toThrow(
      "limit must be a positive integer"
    );
  });
```

- [ ] **Step 2: Run MCP tests to verify they fail**

Run:

```bash
npm test -- test/mcp.test.ts
```

Expected: FAIL with `Unknown tool: upsert_file_index`.

- [ ] **Step 3: Add MCP handler imports and validators**

Modify imports at the top of `src/mcp.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { deleteFileIndex, getIndexStatus, upsertFileIndex } from "./file-index.js";
import { validateMetadata } from "./metadata.js";
import { recall } from "./recall.js";
import { archiveRecord, getRecord, getStatus, listRecords, type RecordAsset } from "./store.js";
import type { ArchiveRecordInput } from "./types.js";
```

Add helper:

```ts
function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}
```

- [ ] **Step 4: Add new `callTool` cases**

Inside the `switch (name)` in `src/mcp.ts`, add:

```ts
    case "upsert_file_index":
      if (typeof input.file_path !== "string") {
        throw new Error("file_path is required");
      }
      return upsertFileIndex(projectRoot, {
        file_path: input.file_path,
        file_name: optionalString(input.file_name, "file_name"),
        record_id: optionalString(input.record_id, "record_id")
      });
    case "delete_file_index":
      return deleteFileIndex(projectRoot, {
        file_path: optionalString(input.file_path, "file_path"),
        file_id: optionalString(input.file_id, "file_id")
      });
    case "recall":
      if (typeof input.query !== "string") {
        throw new Error("query must be a non-empty string");
      }
      return recall(projectRoot, {
        query: input.query,
        limit: positiveInteger(input.limit)
      });
    case "index_status":
      return getIndexStatus(projectRoot);
```

- [ ] **Step 5: Register MCP server tools**

Inside `createServer(projectRoot: string)`, before the final `return server;`, add:

```ts
  server.tool(
    "upsert_file_index",
    {
      file_path: z.string().min(1),
      file_name: z.string().optional(),
      record_id: z.string().optional()
    },
    async (args) => toolResponse(await callTool(projectRoot, "upsert_file_index", args))
  );

  server.tool(
    "delete_file_index",
    {
      file_path: z.string().optional(),
      file_id: z.string().optional()
    },
    async (args) => toolResponse(await callTool(projectRoot, "delete_file_index", args))
  );

  server.tool(
    "recall",
    {
      query: z.string().min(1),
      limit: z.number().int().positive().optional()
    },
    async (args) => toolResponse(await callTool(projectRoot, "recall", args))
  );

  server.tool("index_status", {}, async () => toolResponse(await callTool(projectRoot, "index_status", {})));
```

- [ ] **Step 6: Run MCP tests**

Run:

```bash
npm test -- test/mcp.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit MCP tools**

```bash
git add src/mcp.ts test/mcp.test.ts
git commit -m "feat: expose DocNexus recall MCP tools"
```

---

### Task 6: CLI Commands

**Files:**
- Create: `src/cli.ts`
- Create: `test/cli.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing CLI tests**

Create `test/cli.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-cli-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runCli", () => {
  it("upserts, recalls, deletes, and reports status", async () => {
    const projectRoot = await makeRoot();
    const filePath = join(projectRoot, "cli.md");
    await writeFile(filePath, "CLI local recall content.");

    const upsert = await runCli(["index", "upsert", filePath], projectRoot);
    expect(JSON.parse(upsert)).toMatchObject({
      file_path: "cli.md",
      result: "created"
    });

    const recall = await runCli(["recall", "local recall", "--limit", "1"], projectRoot);
    expect(JSON.parse(recall).results).toHaveLength(1);

    const status = await runCli(["index", "status"], projectRoot);
    expect(JSON.parse(status)).toMatchObject({
      indexed_file_count: 1,
      chunk_count: 1
    });

    const fileId = JSON.parse(upsert).file_id as string;
    const deleted = await runCli(["index", "delete", "--id", fileId], projectRoot);
    expect(JSON.parse(deleted)).toMatchObject({
      file_id: fileId,
      result: "deleted"
    });
  });

  it("prints usage for unknown commands", async () => {
    const projectRoot = await makeRoot();

    await expect(runCli(["unknown"], projectRoot)).rejects.toThrow("Unknown command");
  });
});
```

- [ ] **Step 2: Run CLI tests to verify they fail**

Run:

```bash
npm test -- test/cli.test.ts
```

Expected: FAIL with an import error for `../src/cli.js`.

- [ ] **Step 3: Implement CLI module**

Create `src/cli.ts`:

```ts
import { deleteFileIndex, getIndexStatus, upsertFileIndex } from "./file-index.js";
import { recall } from "./recall.js";

export async function runCli(argv: string[], projectRoot = process.cwd()): Promise<string> {
  const [command, subcommand, ...rest] = argv;

  if (command === "index" && subcommand === "upsert") {
    const filePath = rest[0];
    if (!filePath) {
      throw new Error("file_path is required");
    }
    const options = parseOptions(rest.slice(1));
    return json(
      await upsertFileIndex(projectRoot, {
        file_path: filePath,
        file_name: options.name,
        record_id: options["record-id"]
      })
    );
  }

  if (command === "index" && subcommand === "delete") {
    const options = parseOptions(rest);
    return json(
      await deleteFileIndex(projectRoot, {
        file_path: options.file,
        file_id: options.id
      })
    );
  }

  if (command === "index" && subcommand === "status") {
    return json(await getIndexStatus(projectRoot));
  }

  if (command === "recall") {
    const query = subcommand;
    if (!query) {
      throw new Error("query must be a non-empty string");
    }
    const options = parseOptions(rest);
    return json(
      await recall(projectRoot, {
        query,
        limit: options.limit ? Number(options.limit) : undefined
      })
    );
  }

  throw new Error(`Unknown command. Usage:
docnexus index upsert path/to/file.md --name FileName --record-id rec_0000000000000000
docnexus index delete --file path/to/file.md
docnexus index delete --id file_0000000000000000
docnexus recall "local memory" --limit 5
docnexus index status`);
}

function parseOptions(args: string[]): Record<string, string> {
  const options: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--")) {
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${key} requires a value`);
    }
    options[key.slice(2)] = value;
    index += 1;
  }

  return options;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2))
    .then((output) => process.stdout.write(output))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
```

- [ ] **Step 4: Add CLI bin**

Modify `package.json` bin section:

```json
  "bin": {
    "docnexus": "./dist/src/cli.js",
    "docnexus-mcp": "./dist/src/index.js"
  },
```

- [ ] **Step 5: Run CLI tests**

Run:

```bash
npm test -- test/cli.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit CLI**

```bash
git add src/cli.ts test/cli.test.ts package.json package-lock.json
git commit -m "feat: add DocNexus index CLI"
```

---

### Task 7: Full Verification and Plan Closeout

**Files:**
- No new files.
- Verify all modified files from previous tasks.

- [ ] **Step 1: Run full test suite**

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

Expected: exits with code 0.

- [ ] **Step 3: Run build**

Run:

```bash
npm run build
```

Expected: exits with code 0 and produces `dist/`.

- [ ] **Step 4: Smoke test built CLI**

Run:

```bash
node dist/src/cli.js index status
```

Expected: prints JSON with `indexed_file_count`, `chunk_count`, and `deleted_file_count`.

- [ ] **Step 5: Check git status**

Run:

```bash
git status --short
```

Expected: only intentional tracked changes remain before any final commit. Unrelated untracked sibling project directories may still appear from the parent repository and should not be touched.

- [ ] **Step 6: Commit any verification-only fixes**

If verification changed tracked source or test files, inspect the exact changed file list:

```bash
git status --short
```

Expected: any changed tracked files are related to the incremental recall implementation. If there are related fixes, stage the exact paths printed by `git status --short`, then commit:

```bash
git add src/chunker.ts src/embedder.ts src/file-index.ts src/recall.ts src/mcp.ts src/cli.ts test/chunker.test.ts test/embedder.test.ts test/file-index.test.ts test/recall.test.ts test/mcp.test.ts test/cli.test.ts package.json package-lock.json
git commit -m "fix: stabilize DocNexus incremental recall"
```

If none of those files changed, do not create an empty commit.
