# DocNexus Agent Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the DocNexus v0 skill-first local archive: a TypeScript MCP server that stores Agent-refined source, Markdown, and metadata in `.docnexus/`, plus a manual `docnexus-capture` skill.

**Architecture:** The skill layer handles manual trigger, source preservation, document refinement, and metadata generation. The MCP server exposes storage/query tools only, backed by focused TypeScript core modules for schema validation, hashing, project store initialization, SQLite indexing, and record file access.

**Tech Stack:** Node.js 24, TypeScript, `node:sqlite`, `@modelcontextprotocol/sdk`, Vitest, JSON Schema-style validation implemented in local TypeScript.

---

## File Structure

Create these files:

- `package.json`: npm scripts and dependencies.
- `tsconfig.json`: strict TypeScript compiler config.
- `vitest.config.ts`: Vitest config.
- `src/types.ts`: shared metadata, record, and error types.
- `src/metadata.ts`: schema constants and metadata validation.
- `src/hash.ts`: SHA-256 helpers.
- `src/ids.ts`: record ID generation.
- `src/store.ts`: `.docnexus/` initialization, file writes, SQLite index, list/get/status.
- `src/mcp.ts`: MCP server tool registration and transport.
- `src/index.ts`: CLI entrypoint for the MCP server.
- `skills/docnexus-capture/SKILL.md`: manual Agent workflow.
- `test/metadata.test.ts`: metadata validation tests.
- `test/store.test.ts`: archive/list/get/status integration tests.
- `test/mcp.test.ts`: MCP handler-level tests using exported tool handlers.
- `.gitignore`: ignore runtime `.docnexus/` and build output.

No existing project code is modified except adding these project files.

---

### Task 1: Scaffold TypeScript Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Write package configuration**

Create `package.json`:

```json
{
  "name": "docnexus",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "docnexus-mcp": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "mcp": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.8.0",
    "vitest": "^3.1.0"
  }
}
```

- [ ] **Step 2: Write TypeScript config**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2024"],
    "types": ["node"],
    "rootDir": ".",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]
}
```

- [ ] **Step 3: Write Vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    restoreMocks: true
  }
});
```

- [ ] **Step 4: Write ignore rules**

Create `.gitignore`:

```gitignore
node_modules/
dist/
.docnexus/
.DS_Store
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`

Expected: `package-lock.json` is created and npm exits with code 0.

- [ ] **Step 6: Verify scaffold scripts fail only because no source exists**

Run: `npm run typecheck`

Expected: TypeScript exits with an error like `No inputs were found` or reports missing source files. This confirms the compiler is wired before source files are added.

- [ ] **Step 7: Commit scaffold**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore
git commit -m "chore: scaffold DocNexus TypeScript project"
```

---

### Task 2: Metadata Types and Validation

**Files:**
- Create: `src/types.ts`
- Create: `src/metadata.ts`
- Create: `test/metadata.test.ts`

- [ ] **Step 1: Write failing metadata validation tests**

Create `test/metadata.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateMetadata } from "../src/metadata.js";

const validMetadata = {
  title: "DocNexus MVP",
  summary: "DocNexus v0 archives Agent-refined source, Markdown, and metadata in a local project store for later retrieval.",
  tags: ["agent-memory", "mcp"],
  entities: [
    {
      name: "DocNexus",
      type: "component",
      description: "Local project memory archive used by coding agents."
    }
  ],
  relationships: [
    {
      from: "docnexus-capture",
      to: "archive_record",
      type: "depends_on",
      description: "The skill calls the MCP archive tool after producing content."
    }
  ]
};

describe("validateMetadata", () => {
  it("accepts valid metadata", () => {
    expect(validateMetadata(validMetadata)).toEqual({ valid: true, errors: [] });
  });

  it("rejects missing required fields", () => {
    const result = validateMetadata({ title: "Missing summary" });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("summary must be a non-empty string");
    expect(result.errors).toContain("tags must be an array of strings");
    expect(result.errors).toContain("entities must be an array");
    expect(result.errors).toContain("relationships must be an array");
  });

  it("rejects invalid enum values", () => {
    const result = validateMetadata({
      ...validMetadata,
      entities: [{ name: "X", type: "service", description: "bad enum" }],
      relationships: [{ from: "A", to: "B", type: "calls", description: "bad enum" }]
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("entities[0].type must be one of component, concept, protocol, decision, file, tool, other");
    expect(result.errors).toContain("relationships[0].type must be one of depends_on, mentions, implements, replaces, relates_to, decides");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/metadata.test.ts`

Expected: FAIL with an import error for `../src/metadata.js`.

- [ ] **Step 3: Create shared types**

Create `src/types.ts`:

```ts
export const entityTypes = ["component", "concept", "protocol", "decision", "file", "tool", "other"] as const;
export const relationshipTypes = ["depends_on", "mentions", "implements", "replaces", "relates_to", "decides"] as const;

export type EntityType = (typeof entityTypes)[number];
export type RelationshipType = (typeof relationshipTypes)[number];

export interface MetadataEntity {
  name: string;
  type: EntityType;
  description: string;
}

export interface MetadataRelationship {
  from: string;
  to: string;
  type: RelationshipType;
  description: string;
}

export interface DocNexusMetadata {
  title: string;
  summary: string;
  tags: string[];
  entities: MetadataEntity[];
  relationships: MetadataRelationship[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ArchiveRecordInput {
  source: string;
  document: string;
  metadata: DocNexusMetadata;
  source_name?: string;
}

export interface ArchiveRecordOutput {
  id: string;
  record_path: string;
  created_at: string;
  hashes: {
    source: string;
    document: string;
    metadata: string;
  };
}

export interface StoredRecordSummary {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  created_at: string;
}

export interface StoreStatus {
  project_root: string;
  store_path: string;
  initialized: boolean;
  record_count: number;
}
```

- [ ] **Step 4: Implement validator**

Create `src/metadata.ts`:

```ts
import { entityTypes, relationshipTypes, type DocNexusMetadata, type ValidationResult } from "./types.js";

export const metadataSchema = {
  title: "DocNexus metadata schema",
  entityTypes,
  relationshipTypes
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateMetadata(value: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isRecord(value)) {
    return { valid: false, errors: ["metadata must be an object"] };
  }

  if (!isNonEmptyString(value.title)) {
    errors.push("title must be a non-empty string");
  }

  if (!isNonEmptyString(value.summary)) {
    errors.push("summary must be a non-empty string");
  }

  if (!Array.isArray(value.tags) || value.tags.some((tag) => !isNonEmptyString(tag))) {
    errors.push("tags must be an array of strings");
  }

  if (!Array.isArray(value.entities)) {
    errors.push("entities must be an array");
  } else {
    value.entities.forEach((entity, index) => {
      if (!isRecord(entity)) {
        errors.push(`entities[${index}] must be an object`);
        return;
      }
      if (!isNonEmptyString(entity.name)) {
        errors.push(`entities[${index}].name must be a non-empty string`);
      }
      if (!entityTypes.includes(entity.type as never)) {
        errors.push(`entities[${index}].type must be one of ${entityTypes.join(", ")}`);
      }
      if (!isNonEmptyString(entity.description)) {
        errors.push(`entities[${index}].description must be a non-empty string`);
      }
    });
  }

  if (!Array.isArray(value.relationships)) {
    errors.push("relationships must be an array");
  } else {
    value.relationships.forEach((relationship, index) => {
      if (!isRecord(relationship)) {
        errors.push(`relationships[${index}] must be an object`);
        return;
      }
      if (!isNonEmptyString(relationship.from)) {
        errors.push(`relationships[${index}].from must be a non-empty string`);
      }
      if (!isNonEmptyString(relationship.to)) {
        errors.push(`relationships[${index}].to must be a non-empty string`);
      }
      if (!relationshipTypes.includes(relationship.type as never)) {
        errors.push(`relationships[${index}].type must be one of ${relationshipTypes.join(", ")}`);
      }
      if (!isNonEmptyString(relationship.description)) {
        errors.push(`relationships[${index}].description must be a non-empty string`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

export function assertValidMetadata(value: unknown): asserts value is DocNexusMetadata {
  const result = validateMetadata(value);
  if (!result.valid) {
    throw new Error(`Invalid metadata: ${result.errors.join("; ")}`);
  }
}
```

- [ ] **Step 5: Run metadata tests**

Run: `npm test -- test/metadata.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 6: Commit metadata validation**

```bash
git add src/types.ts src/metadata.ts test/metadata.test.ts
git commit -m "feat: add DocNexus metadata validation"
```

---

### Task 3: Archive Store Core

**Files:**
- Create: `src/hash.ts`
- Create: `src/ids.ts`
- Create: `src/store.ts`
- Create: `test/store.test.ts`

- [ ] **Step 1: Write failing store integration tests**

Create `test/store.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { archiveRecord, getRecord, getStatus, listRecords } from "../src/store.js";

const tempRoots: string[] = [];

const metadata = {
  title: "Manual Capture",
  summary: "The DocNexus skill manually refines Agent context and asks MCP to persist the resulting record in the local store.",
  tags: ["capture", "skill"],
  entities: [
    {
      name: "docnexus-capture",
      type: "tool" as const,
      description: "Manual skill used by Agents to refine and archive project knowledge."
    }
  ],
  relationships: [
    {
      from: "docnexus-capture",
      to: "archive_record",
      type: "depends_on" as const,
      description: "The skill depends on the MCP archive tool for durable storage."
    }
  ]
};

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-store-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("store", () => {
  it("archives source, document, metadata, and index row", async () => {
    const projectRoot = await makeRoot();

    const result = await archiveRecord(projectRoot, {
      source: "# Raw discussion",
      document: "# Refined document",
      metadata
    });

    expect(result.id).toMatch(/^rec_[0-9a-f]{16}$/);
    expect(result.record_path).toContain(".docnexus/records/");
    expect(result.hashes.source).toHaveLength(64);

    await expect(readFile(join(result.record_path, "source.md"), "utf8")).resolves.toBe("# Raw discussion");
    await expect(readFile(join(result.record_path, "document.md"), "utf8")).resolves.toBe("# Refined document");
    await expect(readFile(join(result.record_path, "metadata.json"), "utf8")).resolves.toContain("\"title\": \"Manual Capture\"");

    const listed = await listRecords(projectRoot, {});
    expect(listed.records).toEqual([
      {
        id: result.id,
        title: "Manual Capture",
        summary: metadata.summary,
        tags: ["capture", "skill"],
        created_at: result.created_at
      }
    ]);
  });

  it("gets selected record assets", async () => {
    const projectRoot = await makeRoot();
    const archived = await archiveRecord(projectRoot, {
      source: "source text",
      document: "document text",
      metadata
    });

    const record = await getRecord(projectRoot, archived.id, ["document", "metadata"]);

    expect(record).toEqual({
      id: archived.id,
      document: "document text",
      metadata
    });
  });

  it("reports status before and after initialization", async () => {
    const projectRoot = await makeRoot();

    await expect(getStatus(projectRoot)).resolves.toMatchObject({
      project_root: projectRoot,
      initialized: false,
      record_count: 0
    });

    await archiveRecord(projectRoot, {
      source: "source text",
      document: "document text",
      metadata
    });

    await expect(getStatus(projectRoot)).resolves.toMatchObject({
      project_root: projectRoot,
      initialized: true,
      record_count: 1
    });
  });

  it("rejects invalid metadata", async () => {
    const projectRoot = await makeRoot();

    await expect(
      archiveRecord(projectRoot, {
        source: "source text",
        document: "document text",
        metadata: { title: "invalid" } as never
      })
    ).rejects.toThrow("Invalid metadata");
  });
});
```

- [ ] **Step 2: Run store tests to verify they fail**

Run: `npm test -- test/store.test.ts`

Expected: FAIL with an import error for `../src/store.js`.

- [ ] **Step 3: Implement hash helper**

Create `src/hash.ts`:

```ts
import { createHash } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(flattenKeys(value)).sort(), 2);
}

function flattenKeys(value: unknown, keys: Record<string, true> = {}): Record<string, true> {
  if (Array.isArray(value)) {
    value.forEach((item) => flattenKeys(item, keys));
  } else if (value && typeof value === "object") {
    Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
      keys[key] = true;
      flattenKeys(item, keys);
    });
  }
  return keys;
}
```

- [ ] **Step 4: Implement record IDs**

Create `src/ids.ts`:

```ts
import { randomBytes } from "node:crypto";

export function createRecordId(): string {
  return `rec_${randomBytes(8).toString("hex")}`;
}
```

- [ ] **Step 5: Implement store core**

Create `src/store.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertValidMetadata, metadataSchema } from "./metadata.js";
import { sha256, stableJson } from "./hash.js";
import { createRecordId } from "./ids.js";
import type { ArchiveRecordInput, ArchiveRecordOutput, StoreStatus, StoredRecordSummary } from "./types.js";

export interface ListRecordsInput {
  limit?: number;
  tag?: string;
}

export type RecordAsset = "source" | "document" | "metadata";

export interface GetRecordOutput {
  id: string;
  source?: string;
  document?: string;
  metadata?: unknown;
}

export function storePath(projectRoot: string): string {
  return join(projectRoot, ".docnexus");
}

function dbPath(projectRoot: string): string {
  return join(storePath(projectRoot), "index.sqlite");
}

function recordsPath(projectRoot: string): string {
  return join(storePath(projectRoot), "records");
}

function schemasPath(projectRoot: string): string {
  return join(storePath(projectRoot), "schemas");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureStore(projectRoot: string): Promise<void> {
  await mkdir(recordsPath(projectRoot), { recursive: true });
  await mkdir(schemasPath(projectRoot), { recursive: true });
  await writeFile(join(schemasPath(projectRoot), "metadata.schema.json"), JSON.stringify(metadataSchema, null, 2));

  const db = openDatabase(projectRoot);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        document_hash TEXT NOT NULL,
        metadata_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_path TEXT NOT NULL
      )
    `);
  } finally {
    db.close();
  }
}

function openDatabase(projectRoot: string): DatabaseSync {
  return new DatabaseSync(dbPath(projectRoot));
}

export async function archiveRecord(projectRoot: string, input: ArchiveRecordInput): Promise<ArchiveRecordOutput> {
  if (!input.source || !input.document || !input.metadata) {
    throw new Error("source, document, and metadata are required");
  }

  assertValidMetadata(input.metadata);
  await ensureStore(projectRoot);

  const id = createRecordId();
  const recordPath = join(recordsPath(projectRoot), id);
  const createdAt = new Date().toISOString();
  const metadataJson = stableJson(input.metadata);
  const hashes = {
    source: sha256(input.source),
    document: sha256(input.document),
    metadata: sha256(metadataJson)
  };

  await mkdir(recordPath, { recursive: true });
  await writeFile(join(recordPath, "source.md"), input.source);
  await writeFile(join(recordPath, "document.md"), input.document);
  await writeFile(join(recordPath, "metadata.json"), `${metadataJson}\n`);

  const db = openDatabase(projectRoot);
  try {
    db.prepare(`
      INSERT INTO records (
        id, title, summary, tags_json, source_hash, document_hash, metadata_hash, created_at, updated_at, record_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.metadata.title,
      input.metadata.summary,
      JSON.stringify(input.metadata.tags),
      hashes.source,
      hashes.document,
      hashes.metadata,
      createdAt,
      createdAt,
      recordPath
    );
  } finally {
    db.close();
  }

  return { id, record_path: recordPath, created_at: createdAt, hashes };
}

export async function listRecords(projectRoot: string, input: ListRecordsInput): Promise<{ records: StoredRecordSummary[] }> {
  if (!(await exists(dbPath(projectRoot)))) {
    return { records: [] };
  }

  const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 100) : 50;
  const db = openDatabase(projectRoot);
  try {
    const rows = db.prepare(`
      SELECT id, title, summary, tags_json, created_at
      FROM records
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as Array<{ id: string; title: string; summary: string; tags_json: string; created_at: string }>;

    const records = rows
      .map((row) => ({
        id: row.id,
        title: row.title,
        summary: row.summary,
        tags: JSON.parse(row.tags_json) as string[],
        created_at: row.created_at
      }))
      .filter((record) => !input.tag || record.tags.includes(input.tag));

    return { records };
  } finally {
    db.close();
  }
}

export async function getRecord(projectRoot: string, id: string, include: RecordAsset[] = ["source", "document", "metadata"]): Promise<GetRecordOutput> {
  if (!(await exists(dbPath(projectRoot)))) {
    throw new Error(`Unknown record id: ${id}`);
  }

  const db = openDatabase(projectRoot);
  let recordPath: string | undefined;
  try {
    const row = db.prepare("SELECT record_path FROM records WHERE id = ?").get(id) as { record_path: string } | undefined;
    recordPath = row?.record_path;
  } finally {
    db.close();
  }

  if (!recordPath) {
    throw new Error(`Unknown record id: ${id}`);
  }

  const result: GetRecordOutput = { id };
  if (include.includes("source")) {
    result.source = await readFile(join(recordPath, "source.md"), "utf8");
  }
  if (include.includes("document")) {
    result.document = await readFile(join(recordPath, "document.md"), "utf8");
  }
  if (include.includes("metadata")) {
    result.metadata = JSON.parse(await readFile(join(recordPath, "metadata.json"), "utf8"));
  }
  return result;
}

export async function getStatus(projectRoot: string): Promise<StoreStatus> {
  const initialized = await exists(dbPath(projectRoot));
  if (!initialized) {
    return {
      project_root: projectRoot,
      store_path: storePath(projectRoot),
      initialized: false,
      record_count: 0
    };
  }

  const db = openDatabase(projectRoot);
  try {
    const row = db.prepare("SELECT COUNT(*) as count FROM records").get() as { count: number };
    return {
      project_root: projectRoot,
      store_path: storePath(projectRoot),
      initialized: true,
      record_count: row.count
    };
  } finally {
    db.close();
  }
}

export async function ensureParentDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}
```

- [ ] **Step 6: Run store tests**

Run: `npm test -- test/store.test.ts`

Expected: PASS, 4 tests. Node may print an experimental warning for `node:sqlite`; that warning is acceptable on Node 24.

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit store core**

```bash
git add src/hash.ts src/ids.ts src/store.ts test/store.test.ts
git commit -m "feat: add local DocNexus archive store"
```

---

### Task 4: MCP Tool Handlers and Server

**Files:**
- Create: `src/mcp.ts`
- Create: `src/index.ts`
- Create: `test/mcp.test.ts`

- [ ] **Step 1: Write failing MCP handler tests**

Create `test/mcp.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { callTool } from "../src/mcp.js";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-mcp-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const metadata = {
  title: "MCP Contract",
  summary: "The MCP layer archives already-refined Agent content and returns durable record paths and hashes.",
  tags: ["mcp"],
  entities: [],
  relationships: []
};

describe("callTool", () => {
  it("archives and reads a record", async () => {
    const projectRoot = await makeRoot();
    const archived = await callTool(projectRoot, "archive_record", {
      source: "source",
      document: "document",
      metadata
    });

    expect(archived).toMatchObject({
      record_path: expect.stringContaining(".docnexus/records/"),
      hashes: {
        source: expect.any(String),
        document: expect.any(String),
        metadata: expect.any(String)
      }
    });

    const read = await callTool(projectRoot, "get_record", {
      id: archived.id,
      include: ["source", "metadata"]
    });

    expect(read).toEqual({
      id: archived.id,
      source: "source",
      metadata
    });
  });

  it("validates metadata without archiving", async () => {
    const projectRoot = await makeRoot();

    await expect(callTool(projectRoot, "validate_metadata", { metadata })).resolves.toEqual({
      valid: true,
      errors: []
    });
  });

  it("rejects unknown tools", async () => {
    const projectRoot = await makeRoot();

    await expect(callTool(projectRoot, "missing_tool", {})).rejects.toThrow("Unknown tool: missing_tool");
  });
});
```

- [ ] **Step 2: Run MCP tests to verify they fail**

Run: `npm test -- test/mcp.test.ts`

Expected: FAIL with an import error for `../src/mcp.js`.

- [ ] **Step 3: Implement MCP handlers and server registration**

Create `src/mcp.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { validateMetadata } from "./metadata.js";
import { archiveRecord, getRecord, getStatus, listRecords, type RecordAsset } from "./store.js";
import type { ArchiveRecordInput } from "./types.js";

type ToolArgs = Record<string, unknown>;

function asObject(value: unknown): ToolArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("tool arguments must be an object");
  }
  return value as ToolArgs;
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("include must be an array of strings");
  }
  return value;
}

export async function callTool(projectRoot: string, name: string, args: unknown): Promise<any> {
  const input = asObject(args);

  switch (name) {
    case "archive_record":
      return archiveRecord(projectRoot, input as unknown as ArchiveRecordInput);
    case "list_records":
      return listRecords(projectRoot, {
        limit: typeof input.limit === "number" ? input.limit : undefined,
        tag: typeof input.tag === "string" ? input.tag : undefined
      });
    case "get_record":
      if (typeof input.id !== "string") {
        throw new Error("id must be a string");
      }
      return getRecord(projectRoot, input.id, stringArray(input.include) as RecordAsset[] | undefined);
    case "status":
      return getStatus(projectRoot);
    case "validate_metadata":
      return validateMetadata(input.metadata);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function toolResponse(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

export function createServer(projectRoot: string): McpServer {
  const server = new McpServer({
    name: "docnexus",
    version: "0.1.0"
  });

  server.tool(
    "archive_record",
    {
      source: z.string().min(1),
      document: z.string().min(1),
      metadata: z.record(z.string(), z.unknown()),
      source_name: z.string().optional()
    },
    async (args) => toolResponse(await callTool(projectRoot, "archive_record", args))
  );

  server.tool(
    "list_records",
    {
      limit: z.number().optional(),
      tag: z.string().optional()
    },
    async (args) => toolResponse(await callTool(projectRoot, "list_records", args))
  );

  server.tool(
    "get_record",
    {
      id: z.string(),
      include: z.array(z.enum(["source", "document", "metadata"])).optional()
    },
    async (args) => toolResponse(await callTool(projectRoot, "get_record", args))
  );

  server.tool("status", {}, async () => toolResponse(await callTool(projectRoot, "status", {})));

  server.tool(
    "validate_metadata",
    {
      metadata: z.record(z.string(), z.unknown())
    },
    async (args) => toolResponse(await callTool(projectRoot, "validate_metadata", args))
  );

  return server;
}

export async function runMcpServer(projectRoot = process.cwd()): Promise<void> {
  const server = createServer(projectRoot);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- [ ] **Step 4: Add zod dependency if MCP SDK does not provide it transitively**

Run: `npm install zod`

Expected: npm exits with code 0 and `package.json` includes `zod` in dependencies. Keep this even if TypeScript resolved zod through MCP SDK transitively, because direct imports require direct dependencies.

- [ ] **Step 5: Implement entrypoint**

Create `src/index.ts`:

```ts
#!/usr/bin/env node
import { runMcpServer } from "./mcp.js";

await runMcpServer();
```

- [ ] **Step 6: Run MCP tests**

Run: `npm test -- test/mcp.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 7: Build project**

Run: `npm run build`

Expected: PASS and `dist/src/index.js` exists.

- [ ] **Step 8: Fix bin path if compiler emits under `dist/src`**

If `npm run build` creates `dist/src/index.js`, update `package.json`:

```json
{
  "bin": {
    "docnexus-mcp": "./dist/src/index.js"
  }
}
```

Then run: `npm run build`

Expected: PASS.

- [ ] **Step 9: Commit MCP server**

```bash
git add package.json package-lock.json src/mcp.ts src/index.ts test/mcp.test.ts
git commit -m "feat: expose DocNexus MCP archive tools"
```

---

### Task 5: Manual `docnexus-capture` Skill

**Files:**
- Create: `skills/docnexus-capture/SKILL.md`

- [ ] **Step 1: Write the skill document**

Create `skills/docnexus-capture/SKILL.md`:

```markdown
---
name: docnexus-capture
description: Manually refine a user-selected discussion, plan, note, or file into DocNexus source, Markdown, and metadata, then archive it through the DocNexus MCP server.
---

# DocNexus Capture

Use this skill only when the user explicitly asks to use DocNexus, archive project memory, capture a discussion, preserve a plan, or refine a file into the local DocNexus archive.

Do not trigger automatically. Do not archive background conversation without explicit user intent.

## Workflow

1. Identify the source content from the current conversation or the file path the user named.
2. Preserve the source content as `source`. Keep the original meaning and important wording intact.
3. Create `document` as normalized Markdown with these sections when applicable:
   - Title
   - Context
   - Decisions
   - Architecture
   - Data Model
   - Tool or Skill Contracts
   - Open Questions
   - Next Steps
4. Create `metadata` with this exact shape:

```json
{
  "title": "string",
  "summary": "100-150 Chinese characters for Chinese content, or 40-80 English words for English content",
  "tags": ["string"],
  "entities": [
    {
      "name": "string",
      "type": "component|concept|protocol|decision|file|tool|other",
      "description": "string"
    }
  ],
  "relationships": [
    {
      "from": "string",
      "to": "string",
      "type": "depends_on|mentions|implements|replaces|relates_to|decides",
      "description": "string"
    }
  ]
}
```

5. Call the DocNexus MCP `validate_metadata` tool.
6. If validation fails, repair the metadata and validate again.
7. Call the DocNexus MCP `archive_record` tool with `source`, `document`, and `metadata`.
8. Report the returned `id` and `record_path` to the user.

## Constraints

- The MCP server stores content only. It does not generate or rewrite documents.
- Keep source content complete enough for later audit.
- Do not invent entities or relationships that are not supported by the source.
- Use `decision` entities for explicit choices and `tool` entities for MCP tools or skills.
- If the user asks for automatic capture, explain that DocNexus v0 is manually triggered.
```

- [ ] **Step 2: Verify skill file is discoverable**

Run: `test -f skills/docnexus-capture/SKILL.md`

Expected: command exits with code 0.

- [ ] **Step 3: Commit skill**

```bash
git add skills/docnexus-capture/SKILL.md
git commit -m "feat: add manual DocNexus capture skill"
```

---

### Task 6: Full Verification

**Files:**
- Modify only files needed to fix failures found by the commands in this task.

- [ ] **Step 1: Run all tests**

Run: `npm test`

Expected: PASS for metadata, store, and MCP tests.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Run build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 4: Manually smoke-test archive through handler**

Run:

```bash
node --input-type=module -e "import { mkdtemp } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { callTool } from './dist/src/mcp.js'; const root = await mkdtemp(join(tmpdir(), 'docnexus-smoke-')); const metadata = { title: 'Smoke Test', summary: 'DocNexus archives a refined Agent document and metadata through the MCP handler during smoke verification.', tags: ['smoke'], entities: [], relationships: [] }; const archived = await callTool(root, 'archive_record', { source: 'raw', document: '# refined', metadata }); console.log(JSON.stringify({ id: archived.id, hasPath: archived.record_path.includes('.docnexus/records/') }, null, 2));"
```

Expected output:

```json
{
  "id": "rec_<random hex>",
  "hasPath": true
}
```

The exact `id` value changes each run.

- [ ] **Step 5: Check Git status**

Run: `git status --short`

Expected: only intentional implementation files are modified or untracked. Parent-directory unrelated untracked entries may still appear because the Git root is `/Users/rowansen/Documents/project`; do not stage them.

- [ ] **Step 6: Commit verification fixes**

If Step 1-4 required fixes:

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src test skills
git commit -m "test: verify DocNexus MVP"
```

If no fixes were required, skip this commit.

---

## Self-Review Notes

Spec coverage:

- Manual skill trigger is covered by Task 5.
- Skill-owned refinement and metadata generation are covered by Task 5.
- MCP-owned archive/query/status/validation are covered by Task 4.
- `.docnexus/records/<id>/source.md`, `document.md`, and `metadata.json` are covered by Task 3.
- `index.sqlite` is covered by Task 3.
- Structured validation errors are covered by Tasks 2 and 4.
- Non-goals are preserved: no LLM provider, no MCP-side generation, no embeddings, no Graph RAG, no automatic capture.

Implementation risk:

- `node:sqlite` requires Node 22.5+ and is available in the current environment as Node 24.14.1.
- If `@modelcontextprotocol/sdk` API types differ from the plan snippets, keep the public `callTool` behavior and tests stable while adjusting only MCP registration code.
