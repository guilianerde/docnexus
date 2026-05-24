# DocNexus Single-Version Managed Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace historical archive/index state with one current managed document per project path, make archive creation immediately indexable, physically delete managed documents and derived state, and add an explicit destructive reset path.

**Architecture:** Introduce a `managed-documents` boundary that owns the format v2 SQLite schema, current source/document/metadata sidecars, chunk persistence, and the create/update/delete lifecycle. The global MCP layer and CLI become thin callers of this boundary; recall, LadybugDB, and graph maintenance read only the current document model. There is no migration layer from format v1: normal operations reject it and `reset --force` removes its `.docnexus` state.

**Tech Stack:** TypeScript, Node.js filesystem APIs, SQLite, LadybugDB, Vitest, Zod, MCP SDK.

---

## Scope And File Map

The implementation is a breaking storage and protocol update. Keep the existing global MCP routing requirement: every MCP tool call still supplies absolute `project_root`.

**Create**

- `src/managed-documents.ts`: format v2 SQLite schema, managed path validation, create/update/read/delete/rebuild/status lifecycle, transactional restoration around graph writes.
- `src/reset.ts`: destructive project reset behavior that also works against old or unreadable stores.
- `test/managed-documents.test.ts`: lifecycle, overwrite, no-history, conflict, rollback, rebuild, and status tests.
- `test/reset.test.ts`: reset confirmation, current-format managed file removal, and old-format `.docnexus` removal tests.

**Modify**

- `src/project.ts`: format version `2`, format validation, and initialization of the new schema.
- `src/types.ts`: current document request/result and recall output fields.
- `src/ids.ts`: document identifiers replacing record/file/event lifecycle identifiers.
- `src/ladybug-store.ts`: store graph entities using `document_id` and remove deleted/history assumptions.
- `src/graph-mapping.ts`: map a current managed document into graph input.
- `src/graph-maintenance.ts`: consistency and cleanup operate on current documents only.
- `src/recall-groups.ts`: return current document references keyed by `document_id`.
- `src/mcp.ts`: retain archive/read/status tool names where specified, add `delete_document`, remove standalone index mutation tools.
- `src/cli.ts`: add `document delete` and `reset`, remove standalone index mutation commands, retain rebuild/status maintenance commands.
- `test/project.test.ts`, `test/ladybug-store.test.ts`, `test/graph-maintenance.test.ts`, `test/recall-groups.test.ts`, `test/mcp.test.ts`, `test/cli.test.ts`: verify new model and public contracts.
- `skills/docnexus-capture/SKILL.md`, `skills/docnexus-recall/SKILL.md`: current-document workflow and references.
- `README.md`, `README.zh-CN.md`, `docs/product-brief-docnexus-mvp.md`, `docs/product-brief-docnexus-mvp.zh-CN.md`, `docs/product-brief-docnexus-mvp.en.md`: document current-only lifecycle, delete/reset, and the removed independent index operation.

**Delete after consumers are migrated**

- `src/store.ts`: replaced by `src/managed-documents.ts`.
- `src/file-index.ts`: independent indexing no longer exists.
- `test/store.test.ts`, `test/file-index.test.ts`: replaced by current lifecycle coverage.

## Public Contract Target

`archive_record` remains the MCP write tool name, but it is no longer an archive-history operation. It creates or overwrites exactly one managed current document and indexes it in the same request.

```ts
interface ArchiveRecordInput {
  project_root: string;
  file_path: string; // project-relative managed Markdown target path
  source: string;
  document: string;
  metadata: Record<string, unknown>;
}

interface ArchiveRecordResult {
  id: string;
  file_path: string;
  operation: "created" | "updated";
  chunk_count: number;
  updated_at: string;
}
```

`delete_document` physically removes one managed document. It accepts either `file_path` or `id`, not both.

```ts
interface DeleteDocumentInput {
  project_root: string;
  file_path?: string;
  id?: string;
  confirm: true;
}
```

CLI destructive operations are:

```bash
docnexus document delete --file docs/memory/auth.md --force
docnexus document delete --id doc_0123abcd --force
docnexus reset --force
```

The normal CLI/MCP API does not expose `index upsert`, `index delete`, `upsert_file_index`, or `delete_file_index`. `docnexus index rebuild --force` remains an explicit maintenance command over already managed current documents.

## Task 1: Establish Format V2 And The Current Document Schema

**Files:**

- Create: `src/managed-documents.ts`
- Modify: `src/project.ts`
- Modify: `src/ids.ts`
- Modify: `src/types.ts`
- Modify: `test/project.test.ts`
- Create: `test/managed-documents.test.ts`

- [ ] **Step 1: Write failing initialization and schema tests**

Extend `test/project.test.ts` to assert that a new project marker declares format version `2` and initialization creates a SQLite store with `documents` and `file_chunks`, without `records`, `indexed_files`, or `index_events`.

Add the first tests in `test/managed-documents.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/project.js";
import { getManagedSchemaTables } from "../src/managed-documents.js";

it("initializes only the format v2 current document tables", async () => {
  const root = await makeProjectDir();
  await initializeProject(root);

  await expect(getManagedSchemaTables(root)).resolves.toEqual([
    "documents",
    "file_chunks",
  ]);
});
```

- [ ] **Step 2: Run tests to prove they fail before the schema exists**

Run:

```bash
npm test -- test/project.test.ts test/managed-documents.test.ts
```

Expected failure: format version is still `1`, and `src/managed-documents.ts` or the new table assertions are unavailable.

- [ ] **Step 3: Add the minimal schema and identifiers**

In `src/ids.ts`, add the stable current document identifier constructor:

```ts
export function createDocumentId(): string {
  return `doc_${randomBytes(12).toString("hex")}`;
}
```

In `src/types.ts`, introduce current-document types without adding history fields:

```ts
export interface ManagedDocument {
  id: string;
  file_path: string;
  title: string;
  summary: string;
  tags: string[];
  source_hash: string;
  document_hash: string;
  metadata_hash: string;
  created_at: string;
  updated_at: string;
  sidecar_path: string;
}

export interface ManagedChunk {
  id: string;
  document_id: string;
  chunk_index: number;
  text: string;
  text_hash: string;
  embedding: number[];
  created_at: string;
}
```

Create `src/managed-documents.ts` as the single schema owner:

```ts
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

export function databasePath(projectRoot: string): string {
  return join(storePath(projectRoot), "index.sqlite");
}

export async function ensureManagedStore(projectRoot: string): Promise<void> {
  await mkdir(storePath(projectRoot), { recursive: true });
  const db = openDatabase(databasePath(projectRoot));
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(CURRENT_SCHEMA_SQL);
  db.close();
}
```

Use the project marker as the only accepted normal-operation schema gate in `src/project.ts`:

```ts
export const PROJECT_FORMAT_VERSION = 2;
```

Change project initialization to call `ensureManagedStore(projectRoot)`. Change project validation so a format other than `2` fails with an actionable error directing the caller to `docnexus reset --force` followed by `docnexus init`.

- [ ] **Step 4: Run the focused tests**

Run:

```bash
npm test -- test/project.test.ts test/managed-documents.test.ts
npm run typecheck
```

Expected result: the new project initializes with format `2` and only current-document tables.

- [ ] **Step 5: Commit the schema foundation**

```bash
git add src/managed-documents.ts src/project.ts src/ids.ts src/types.ts test/project.test.ts test/managed-documents.test.ts
git commit -m "feat: initialize current managed document storage"
```

## Task 2: Implement Single-Version Create And Update With Immediate Indexing

**Files:**

- Modify: `src/managed-documents.ts`
- Modify: `src/metadata.ts`
- Modify: `src/graph-mapping.ts`
- Modify: `src/types.ts`
- Modify: `test/managed-documents.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Add tests that use a fake embedder and fake graph writer:

```ts
it("creates a target document, current sidecars, chunks, and graph input in one call", async () => {
  const result = await upsertManagedDocument(root, {
    file_path: "docs/memory/auth.md",
    source: "raw source",
    document: "# Authentication\n\nToken rotation.",
    metadata: validMetadata("Authentication"),
  }, fakeEmbedder, graphWriter);

  expect(result.operation).toBe("created");
  await expect(readFile(join(root, "docs/memory/auth.md"), "utf8"))
    .resolves.toContain("Token rotation.");
  expect(await listManagedDocuments(root)).toHaveLength(1);
  expect(await listChunks(root, result.id)).not.toHaveLength(0);
  expect(graphWriter.replaced).toEqual([result.id]);
});

it("overwrites the managed path without retaining prior content or chunks", async () => {
  const first = await createAuthDocument(root, "old source", "old document");
  const second = await createAuthDocument(root, "new source", "new document");

  expect(second.id).toBe(first.id);
  expect(second.operation).toBe("updated");
  expect(await listManagedDocuments(root)).toHaveLength(1);
  expect(await readCurrentSource(root, first.id)).toBe("new source");
  expect(await allPersistedText(root)).not.toContain("old document");
});
```

Also test these rejection cases:

- `file_path` is absolute or escapes the project root.
- The initial target path already exists but is not in `documents`.
- An update target was externally modified and no longer matches its stored `document_hash`.
- Invalid metadata prevents any target file or row from being written.
- A graph writer failure restores the prior target, sidecars, row, and chunks for an update; for a create it leaves no managed target or row.

- [ ] **Step 2: Run the lifecycle tests and confirm the missing behavior**

Run:

```bash
npm test -- test/managed-documents.test.ts
```

Expected failure: `upsertManagedDocument`, sidecar/chunk persistence, and rollback behavior are not implemented.

- [ ] **Step 3: Implement the one-boundary managed write API**

Export the write boundary from `src/managed-documents.ts`:

```ts
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

export interface ManagedGraphWriter {
  replaceDocument(projectRoot: string, document: ManagedDocument, chunks: ManagedChunk[]): Promise<void>;
  deleteDocument(projectRoot: string, documentId: string): Promise<void>;
}
```

Implement these operations:

```ts
export async function upsertManagedDocument(
  projectRoot: string,
  input: ManagedDocumentWriteInput,
  embedder: Embedder = getDefaultEmbedder(),
  graphWriter: ManagedGraphWriter = getDefaultGraphWriter(),
): Promise<ManagedDocumentWriteResult>;

export async function listManagedDocuments(projectRoot: string): Promise<ManagedDocument[]>;
export async function getManagedDocument(projectRoot: string, selector: { id?: string; file_path?: string }): Promise<ManagedDocument>;
export async function listManagedChunks(projectRoot: string, documentId: string): Promise<ManagedChunk[]>;
```

Implement path handling with a project-relative normalized Markdown target:

```ts
function resolveManagedTarget(projectRoot: string, filePath: string): string {
  if (isAbsolute(filePath) || extname(filePath).toLowerCase() !== ".md") {
    throw new Error("file_path must be a project-relative Markdown path");
  }
  const target = resolve(projectRoot, filePath);
  const prefix = `${resolve(projectRoot)}${sep}`;
  if (!target.startsWith(prefix)) {
    throw new Error("file_path must remain inside the project root");
  }
  return target;
}
```

For each upsert:

1. Validate metadata and target path before writing.
2. Read an existing `documents` row by `file_path`.
3. On create, reject an existing target file to avoid taking ownership of user content.
4. On update, hash the current target and reject external drift against `document_hash`.
5. Chunk and embed the new refined document before mutating stored state.
6. Snapshot the prior row, chunks, target file, and current sidecars.
7. Write the target and sidecars under `.docnexus/documents/<id>/` using temporary sibling files and `rename`.
8. Replace the `documents` row and its `file_chunks` inside one SQLite transaction.
9. Call `graphWriter.replaceDocument`.
10. If step 8 or 9 fails, restore the snapshot or remove new files/rows and rethrow.

Sidecars contain only the current values:

```text
.docnexus/documents/<document_id>/source.md
.docnexus/documents/<document_id>/metadata.json
```

Do not create history folders, event rows, deleted flags, or version counters.

- [ ] **Step 4: Adapt metadata and graph input mapping to document identity**

Change `src/graph-mapping.ts` so graph conversion takes a `ManagedDocument` and `ManagedChunk[]` and uses `document_id`, not `record_id` or indexed-file history identifiers:

```ts
export function toGraphDocument(
  document: ManagedDocument,
  chunks: ManagedChunk[],
  metadata: DocNexusMetadata,
): GraphDocumentInput {
  return {
    document_id: document.id,
    file_path: document.file_path,
    title: document.title,
    chunks: chunks.map((chunk) => ({
      id: chunk.id,
      document_id: document.id,
      text: chunk.text,
      embedding: chunk.embedding,
    })),
    entities: metadata.entities ?? [],
    relationships: metadata.relationships ?? [],
  };
}
```

- [ ] **Step 5: Verify immediate indexing and overwrite behavior**

Run:

```bash
npm test -- test/managed-documents.test.ts
npm run typecheck
```

Expected result: create/update produces exactly one current managed document, current chunks are immediately persisted, and graph failures do not leave partial current state.

- [ ] **Step 6: Commit the managed write lifecycle**

```bash
git add src/managed-documents.ts src/metadata.ts src/graph-mapping.ts src/types.ts test/managed-documents.test.ts
git commit -m "feat: upsert current managed documents with indexing"
```

## Task 3: Implement Physical Document Deletion And Destructive Reset

**Files:**

- Modify: `src/managed-documents.ts`
- Create: `src/reset.ts`
- Create: `test/reset.test.ts`
- Modify: `test/managed-documents.test.ts`

- [ ] **Step 1: Write failing delete and reset tests**

Add document deletion tests:

```ts
it("requires explicit confirmation before deleting a managed document", async () => {
  await expect(deleteManagedDocument(root, { file_path: "docs/memory/auth.md", confirm: false }, graphWriter))
    .rejects.toThrow("confirmation");
});

it("physically removes the managed target, sidecars, chunks, row, and graph data", async () => {
  const created = await createAuthDocument(root);
  await deleteManagedDocument(root, { id: created.id, confirm: true }, graphWriter);

  await expect(access(join(root, "docs/memory/auth.md"))).rejects.toThrow();
  await expect(access(join(root, ".docnexus/documents", created.id))).rejects.toThrow();
  expect(await listManagedDocuments(root)).toEqual([]);
  expect(await listManagedChunks(root, created.id)).toEqual([]);
  expect(graphWriter.deleted).toEqual([created.id]);
});
```

Create `test/reset.test.ts` with:

```ts
it("rejects reset unless force is supplied", async () => {
  await expect(resetProjectData(root, { force: false })).rejects.toThrow("--force");
});

it("removes current-format managed target files and the full internal store", async () => {
  await createManagedFiles(root, ["docs/memory/a.md", "docs/memory/b.md"]);
  await resetProjectData(root, { force: true });

  await expect(access(join(root, "docs/memory/a.md"))).rejects.toThrow();
  await expect(access(join(root, ".docnexus"))).rejects.toThrow();
});

it("removes only .docnexus for an old or unreadable store", async () => {
  await writeOldFormatMarker(root);
  await writeFile(join(root, "docs/memory/legacy.md"), "outside recoverable v2 ownership");
  await resetProjectData(root, { force: true });

  await expect(readFile(join(root, "docs/memory/legacy.md"), "utf8"))
    .resolves.toContain("outside recoverable v2 ownership");
  await expect(access(join(root, ".docnexus"))).rejects.toThrow();
});
```

- [ ] **Step 2: Run focused tests to observe the failure**

Run:

```bash
npm test -- test/managed-documents.test.ts test/reset.test.ts
```

Expected failure: physical deletion and reset entry points are absent.

- [ ] **Step 3: Add physical delete to the managed boundary**

Implement:

```ts
export interface DeleteManagedDocumentInput {
  id?: string;
  file_path?: string;
  confirm: boolean;
}

export async function deleteManagedDocument(
  projectRoot: string,
  input: DeleteManagedDocumentInput,
  graphWriter: ManagedGraphWriter = getDefaultGraphWriter(),
): Promise<{ id: string; file_path: string; deleted: true }>;
```

The implementation must:

1. Reject unless `confirm === true`.
2. Require exactly one of `id` or `file_path`.
3. Resolve an existing managed row and verify the current target still matches `document_hash`.
4. Snapshot files/rows/chunks before mutation.
5. Delete graph entities, target Markdown file, current sidecars, chunks, and the document row.
6. If graph or filesystem/database work fails after mutation starts, restore the current managed state and report failure.
7. Remove now-empty sidecar parent directories only within `.docnexus/documents/`.

- [ ] **Step 4: Add reset as a deliberately separate destructive recovery path**

Create `src/reset.ts`:

```ts
export async function resetProjectData(
  projectRoot: string,
  options: { force: boolean },
): Promise<{ deleted_managed_files: string[]; removed_store: true }> {
  if (!options.force) {
    throw new Error("reset requires --force");
  }

  const marker = await readMarkerLoosely(projectRoot);
  const managedFiles =
    marker?.format_version === PROJECT_FORMAT_VERSION
      ? await listManagedTargetPathsForReset(projectRoot)
      : [];

  for (const filePath of managedFiles) {
    await rm(resolveVerifiedManagedTarget(projectRoot, filePath), { force: true });
  }
  await rm(storePath(projectRoot), { recursive: true, force: true });
  return { deleted_managed_files: managedFiles, removed_store: true };
}
```

Reset intentionally does not parse v1 records/index tables. If the marker is missing, malformed, or not format `2`, it removes only `.docnexus/`, since it cannot safely identify project files that old storage owned.

- [ ] **Step 5: Verify physical deletion and reset**

Run:

```bash
npm test -- test/managed-documents.test.ts test/reset.test.ts
npm run typecheck
```

Expected result: deletion leaves no current document residue, and reset has the approved safe behavior for v2 versus old/unreadable state.

- [ ] **Step 6: Commit destructive operations**

```bash
git add src/managed-documents.ts src/reset.ts test/managed-documents.test.ts test/reset.test.ts
git commit -m "feat: delete and reset managed documents physically"
```

## Task 4: Move LadybugDB, Recall, And Graph Maintenance To Current Documents

**Files:**

- Modify: `src/ladybug-store.ts`
- Modify: `src/graph-mapping.ts`
- Modify: `src/graph-maintenance.ts`
- Modify: `src/recall-groups.ts`
- Modify: `src/managed-documents.ts`
- Modify: `src/types.ts`
- Modify: `test/ladybug-store.test.ts`
- Modify: `test/graph-mapping.test.ts`
- Modify: `test/graph-maintenance.test.ts`
- Modify: `test/recall-groups.test.ts`
- Modify: `test/recall.test.ts`
- Modify: `test/managed-documents.test.ts`

- [ ] **Step 1: Write failing graph and recall tests for current document identity**

Update `test/ladybug-store.test.ts`, `test/recall-groups.test.ts`, and `test/recall.test.ts` to require `document_id` and `file_path` references, with no `record_id`, `file_id`, deleted record, or historical event fields in returned public context:

```ts
it("returns grouped recall context using the current document identity", async () => {
  const result = await recall(root, "token rotation");
  expect(result.groups[0]).toMatchObject({
    document_id: expect.stringMatching(/^doc_/),
    file_path: "docs/memory/auth.md",
  });
  expect(result.groups[0]).not.toHaveProperty("record_id");
  expect(result.groups[0]).not.toHaveProperty("file_id");
});
```

Change graph maintenance tests to assert:

- A managed document missing graph nodes is reported and can be repaired.
- A graph node with no current `documents` row is stale and can be deleted.
- No report or repair output depends on tombstones, deleted records, or index event history.
- Rebuild reads only managed target files and current sidecars.

Update `test/graph-mapping.test.ts` to assert that the newly added document-to-graph mapping carries `document_id`, `file_path`, chunks, entities, and metadata relationships through to the LadybugDB input.

- [ ] **Step 2: Run graph/recall tests to expose old identities**

Run:

```bash
npm test -- test/ladybug-store.test.ts test/graph-mapping.test.ts test/graph-maintenance.test.ts test/recall-groups.test.ts test/recall.test.ts test/managed-documents.test.ts
```

Expected failure: existing graph and recall paths still consume old record/index identities or table APIs.

- [ ] **Step 3: Change LadybugDB schema and graph operations to `document_id`**

Update `src/ladybug-store.ts` to expose current-only operations:

```ts
export interface GraphDocumentInput {
  document_id: string;
  file_path: string;
  title: string;
  chunks: Array<{
    id: string;
    document_id: string;
    text: string;
    embedding: number[];
  }>;
  entities: MetadataEntity[];
  relationships: MetadataRelationship[];
}

export async function replaceDocumentGraph(projectRoot: string, input: GraphDocumentInput): Promise<void>;
export async function deleteDocumentGraph(projectRoot: string, documentId: string): Promise<void>;
```

Because v1 stores are not supported, create only the new Ladybug node/edge model; do not add read fallbacks for old property names.

- [ ] **Step 4: Adapt recall grouping and maintenance reports**

In `src/recall-groups.ts`, group candidate chunks by `document_id`, return `file_path`, and load neighboring context only from that same current document.

In `src/graph-maintenance.ts`:

- Compare Ladybug document identities against `documents.id`.
- Replace report field names derived from `indexed_files` with `documents`.
- Treat orphan graph data as stale current data, not retained deletion history.
- Repair by replaying current managed document sidecars/chunks through `replaceDocumentGraph`.
- Clean by calling `deleteDocumentGraph` for orphan graph documents.

In `src/managed-documents.ts`, implement `rebuildManagedDocuments(projectRoot, ...)` to regenerate chunks/embeddings/graph only from rows in `documents` and their matching current target/sidecars. Reject a rebuild when the target content hash does not match its row; do not silently repair an externally edited managed file.

- [ ] **Step 5: Run current graph/recall/rebuild verification**

Run:

```bash
npm test -- test/ladybug-store.test.ts test/graph-mapping.test.ts test/graph-maintenance.test.ts test/recall-groups.test.ts test/recall.test.ts test/managed-documents.test.ts
npm run typecheck
```

Expected result: LadybugDB, recall grouping, graph audit/repair/cleanup, and rebuild use only current managed documents.

- [ ] **Step 6: Commit graph and recall migration**

```bash
git add src/ladybug-store.ts src/graph-mapping.ts src/graph-maintenance.ts src/recall-groups.ts src/managed-documents.ts src/types.ts test/ladybug-store.test.ts test/graph-mapping.test.ts test/graph-maintenance.test.ts test/recall-groups.test.ts test/recall.test.ts test/managed-documents.test.ts
git commit -m "feat: align graph recall with managed documents"
```

## Task 5: Replace MCP And CLI Mutation Contracts

**Files:**

- Modify: `src/mcp.ts`
- Modify: `src/cli.ts`
- Modify: `src/types.ts`
- Modify: `test/mcp.test.ts`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Write failing MCP tool contract tests**

Update `test/mcp.test.ts` to assert the registered tool names and inputs:

```ts
it("exposes current-document mutation tools only", async () => {
  const tools = await listMcpTools();
  expect(tools.map((tool) => tool.name)).toContain("archive_record");
  expect(tools.map((tool) => tool.name)).toContain("delete_document");
  expect(tools.map((tool) => tool.name)).not.toContain("upsert_file_index");
  expect(tools.map((tool) => tool.name)).not.toContain("delete_file_index");
});

it("archives and immediately retrieves a current document for the explicit project", async () => {
  const created = await callTool("archive_record", {
    project_root: root,
    file_path: "docs/memory/auth.md",
    source: "raw",
    document: "# Auth\n\nRotation",
    metadata: validMetadata("Auth"),
  });
  expect(created.operation).toBe("created");
  expect((await callTool("get_record", { project_root: root, id: created.id })).file_path)
    .toBe("docs/memory/auth.md");
});

it("requires confirm true for MCP deletion", async () => {
  await expect(callTool("delete_document", {
    project_root: root,
    file_path: "docs/memory/auth.md",
  })).rejects.toThrow("confirm");
});
```

Keep assertions that `project_root` is absolute, initialized, and required for every MCP operation.

- [ ] **Step 2: Write failing CLI contract tests**

Update `test/cli.test.ts` to assert:

```ts
it("supports physical current document deletion and reset commands", async () => {
  await expect(runCli(["document", "delete", "--file", "docs/memory/auth.md"]))
    .rejects.toThrow("--force");
  await expect(runCli(["reset"])).rejects.toThrow("--force");
});

it("does not expose standalone index mutation commands", async () => {
  await expect(runCli(["index", "upsert", "--file", "docs/memory/auth.md"]))
    .rejects.toThrow("Unknown");
  await expect(runCli(["index", "delete", "--file", "docs/memory/auth.md"]))
    .rejects.toThrow("Unknown");
});
```

Add end-to-end CLI tests for `document delete --file ... --force`, `document delete --id ... --force`, `reset --force`, `index rebuild --force`, and `index status`.

- [ ] **Step 3: Run MCP and CLI tests to show obsolete routes**

Run:

```bash
npm test -- test/mcp.test.ts test/cli.test.ts
```

Expected failure: old index mutation commands/tools remain and archive lacks required managed target handling.

- [ ] **Step 4: Update MCP routing and schemas**

In `src/mcp.ts`:

- Add `file_path` to the `archive_record` Zod input schema.
- Route it to `upsertManagedDocument`.
- Keep `list_records`, `get_record`, `status`, `validate_metadata`, and `index_status`, but make their responses current-only.
- Remove the `upsert_file_index` and `delete_file_index` registrations and handlers.
- Add `delete_document` requiring `confirm: z.literal(true)` and one selector (`id` or `file_path`).

Use a schema refinement for selector exclusivity:

```ts
const deleteDocumentSchema = projectRootSchema.extend({
  id: z.string().optional(),
  file_path: z.string().optional(),
  confirm: z.literal(true),
}).refine((value) => Number(Boolean(value.id)) + Number(Boolean(value.file_path)) === 1, {
  message: "provide exactly one of id or file_path",
});
```

- [ ] **Step 5: Update CLI commands**

In `src/cli.ts`:

- Remove `index upsert` and `index delete` parsing and help output.
- Add `document delete (--file <path> | --id <id>) --force`.
- Add `reset --force`; do not call normal initialized-project validation before reset, so a v1 or corrupt store can be cleared.
- Keep `index rebuild --force` and `index status` as maintenance/read commands.
- Keep the existing CLI `recall`, `graph audit`, and `graph repair --force` entry points, routing them through the current-document modules from Task 4.

- [ ] **Step 6: Verify the public tool and CLI contract**

Run:

```bash
npm test -- test/mcp.test.ts test/cli.test.ts
npm run typecheck
```

Expected result: all document mutations occur through archive upsert or physical delete, destructive calls are guarded, and standalone indexing mutation entry points are gone.

- [ ] **Step 7: Commit the contract break**

```bash
git add src/mcp.ts src/cli.ts src/types.ts test/mcp.test.ts test/cli.test.ts
git commit -m "feat: expose managed document MCP and CLI commands"
```

## Task 6: Remove Historical Storage Code And Verify No Standalone Index Path Remains

**Files:**

- Delete: `src/store.ts`
- Delete: `src/file-index.ts`
- Delete: `test/store.test.ts`
- Delete: `test/file-index.test.ts`
- Modify: any importing source/test file reported by search

- [ ] **Step 1: Search for old model references before deletion**

Run:

```bash
rg -n "records|indexed_files|index_events|record_id|file_id|upsert_file_index|delete_file_index|createRecordId|createFileId|createEventId|from \"\\./store|from \"\\./file-index" src test
```

Expected result before cleanup: only remaining references identify files that must now be migrated or removed; no new compatibility implementation is permitted.

- [ ] **Step 2: Add a protocol regression assertion if any old public field is still reachable**

If the search exposes a returned public JSON type or MCP response still carrying `record_id`, `file_id`, `indexed_files`, or event-history data, add a failing assertion to its nearest existing test before editing it. For example:

```ts
expect(JSON.stringify(response)).not.toMatch(/record_id|file_id|indexed_files|index_events/);
```

Run that focused test and observe the failure before removing the obsolete output.

- [ ] **Step 3: Remove obsolete modules and all old lifecycle imports**

Delete `src/store.ts`, `src/file-index.ts`, `test/store.test.ts`, and `test/file-index.test.ts` after their consumers use `src/managed-documents.ts`.

Remove unused legacy ID functions and legacy public types only when `rg` proves no migrated current path imports them. Do not implement table migrations, field aliases, or dual-read behavior.

- [ ] **Step 4: Run the source and test reference scan again**

Run:

```bash
rg -n "records|indexed_files|index_events|record_id|file_id|upsert_file_index|delete_file_index|createRecordId|createFileId|createEventId|from \"\\./store|from \"\\./file-index" src test
npm test
npm run typecheck
```

Expected result: `rg` reports no old storage/protocol references under `src` or `test`, and all tests pass.

- [ ] **Step 5: Commit obsolete storage removal**

```bash
git add src test
git commit -m "refactor: remove historical archive and index storage"
```

## Task 7: Update Skills For The Current-Document Workflow

**Files:**

- Modify: `skills/docnexus-capture/SKILL.md`
- Modify: `skills/docnexus-recall/SKILL.md`

- [ ] **Step 1: Read the skill-authoring workflow before editing skills**

Use the required skill:

```text
superpowers:writing-skills
```

Follow its verification instructions while changing these skill files.

- [ ] **Step 2: Write capture skill assertions/checks before editing**

Search for instructions that expose the removed two-step archive/index behavior:

```bash
rg -n "upsert_file_index|delete_file_index|index upsert|index delete|archive_record|file_path|record_id|file_id" skills/docnexus-capture/SKILL.md skills/docnexus-recall/SKILL.md
```

Expected result before editing: at least one outdated write/reference flow needs replacement.

- [ ] **Step 3: Update capture skill behavior**

The capture skill must state:

- Refinement remains an agent/skill step, performed before storage.
- The skill selects or receives a project-relative target Markdown `file_path`.
- One `archive_record` MCP request sends `project_root`, `file_path`, `source`, `document`, and `metadata`.
- A repeated call to the same managed `file_path` replaces the current document.
- Deletion is destructive and invokes `delete_document` only after explicit user intent, with `confirm: true`.
- It never calls independent index mutation tools.

Include a concrete MCP argument example:

```json
{
  "project_root": "/absolute/project",
  "file_path": "docs/memory/auth.md",
  "source": "original material",
  "document": "# Auth\n\nRefined current document.",
  "metadata": {
    "title": "Auth",
    "summary": "Authentication decisions",
    "tags": ["auth"]
  }
}
```

- [ ] **Step 4: Update recall skill behavior**

The recall skill must state that `recall` requires format v2 metadata and graph state, returns chunks grouped by current managed document, and cites `file_path` references. Remove directions involving historical records, unarchived index entries, or fallback operation without metadata/graph.

- [ ] **Step 5: Verify no obsolete skill instruction remains**

Run:

```bash
rg -n "upsert_file_index|delete_file_index|index upsert|index delete|record_id|file_id|standalone index|unarchived" skills/docnexus-capture/SKILL.md skills/docnexus-recall/SKILL.md
```

Expected result: no obsolete instruction remains. Review any matches manually if wording is explicitly warning against unsupported operations.

- [ ] **Step 6: Commit skill updates**

```bash
git add skills/docnexus-capture/SKILL.md skills/docnexus-recall/SKILL.md
git commit -m "docs: teach skills the current document workflow"
```

## Task 8: Update Public Documentation And Usage Examples

**Files:**

- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/product-brief-docnexus-mvp.md`
- Modify: `docs/product-brief-docnexus-mvp.zh-CN.md`
- Modify: `docs/product-brief-docnexus-mvp.en.md`

- [ ] **Step 1: Locate every obsolete user-facing command or model description**

Run:

```bash
rg -n "index upsert|index delete|upsert_file_index|delete_file_index|records|indexed_files|index_events|archive|history|历史|归档|索引" README.md README.zh-CN.md docs/product-brief-docnexus-mvp.md docs/product-brief-docnexus-mvp.zh-CN.md docs/product-brief-docnexus-mvp.en.md
```

Use the results as the documentation edit checklist.

- [ ] **Step 2: Update English documentation**

In `README.md`, `docs/product-brief-docnexus-mvp.md`, and `docs/product-brief-docnexus-mvp.en.md`, document:

- DocNexus stores one current managed document per project-relative path.
- The agent refines content first; `archive_record` writes and indexes it in one operation.
- Rewriting the same managed path replaces source, refined document, metadata, chunks, and graph data.
- `document delete --force` removes the managed Markdown file and all internal/derived data.
- `reset --force` removes all current-format managed files and `.docnexus`; old stores require reset and re-initialization.
- `index rebuild --force` is maintenance over managed documents, not an ingest API.
- MCP setup remains one global service with explicit `project_root`.

Use current commands:

```bash
npx docnexus init
npx docnexus document delete --file docs/memory/auth.md --force
npx docnexus reset --force
npx docnexus init
```

- [ ] **Step 3: Update Chinese documentation with the same protocol**

In `README.zh-CN.md`, `docs/product-brief-docnexus-mvp.md`, and `docs/product-brief-docnexus-mvp.zh-CN.md`, use consistent terms:

- `当前托管文档` for the single retained document.
- `提炼` as the skill/agent step before persistence.
- `创建或覆盖并立即建立索引` for `archive_record`.
- `物理删除` for document deletion and reset outcomes.
- `不提供历史留存、独立索引写入或旧格式兼容层`.

- [ ] **Step 4: Verify docs describe only the supported workflow**

Run:

```bash
rg -n "index upsert|index delete|upsert_file_index|delete_file_index|records 表|indexed_files 表|index_events|历史版本|history retention" README.md README.zh-CN.md docs/product-brief-docnexus-mvp.md docs/product-brief-docnexus-mvp.zh-CN.md docs/product-brief-docnexus-mvp.en.md
```

Expected result: there are no instructions claiming removed commands or retained history are supported.

- [ ] **Step 5: Commit public documentation updates**

```bash
git add README.md README.zh-CN.md docs/product-brief-docnexus-mvp.md docs/product-brief-docnexus-mvp.zh-CN.md docs/product-brief-docnexus-mvp.en.md
git commit -m "docs: describe single-version managed documents"
```

## Task 9: Full Verification And Release Readiness

**Files:**

- Modify only if a verification failure reveals a direct defect in the implemented feature.

- [ ] **Step 1: Load the completion verification workflow**

Use the required skill:

```text
superpowers:verification-before-completion
```

- [ ] **Step 2: Run the complete automated verification suite**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected result: all commands pass.

- [ ] **Step 3: Exercise the installed-style CLI lifecycle in a temporary project**

Run the built CLI against a temporary project directory and execute:

```bash
node dist/src/cli.js init
node dist/src/cli.js status
node dist/src/cli.js index status
node dist/src/cli.js document delete --file docs/memory/auth.md --force
node dist/src/cli.js reset --force
```

For creation/update/recall, use the existing automated MCP integration test path or a repository-supported fixture command that supplies valid metadata and graph context. Verify:

- A created current document is recallable immediately.
- Updating the same path leaves one document and no old chunk text.
- Deletion removes the target Markdown, sidecars, SQLite state, and Ladybug graph state.
- Reset removes `.docnexus` and current-format managed target files.

- [ ] **Step 4: Inspect package output and obsolete term scans**

Run:

```bash
npm pack --dry-run
rg -n "upsert_file_index|delete_file_index|index upsert|index delete|indexed_files|index_events|record_id|file_id" src test skills README.md README.zh-CN.md docs/product-brief-docnexus-mvp.md docs/product-brief-docnexus-mvp.zh-CN.md docs/product-brief-docnexus-mvp.en.md
```

Expected result: the package includes the revised CLI/skills/docs, and scan hits are absent except deliberate negative assertions or migration-free error explanations reviewed individually.

- [ ] **Step 5: Check the final diff and git status**

Run:

```bash
git status --short
git diff --stat main...HEAD
git log --oneline --decorate main..HEAD
```

Confirm that the pre-existing unrelated swap-file deletion is not staged or included in feature commits.

- [ ] **Step 6: Request code review and finish the development branch**

Use:

```text
superpowers:requesting-code-review
superpowers:finishing-a-development-branch
```

Address review findings with focused tests and commits before offering merge or pull-request completion options.
