# DocNexus Graph Audit and Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add CLI-only graph audit and repair commands that detect and clean LadybugDB drift against the SQLite index ledger.

**Architecture:** SQLite remains the source of truth for indexed file and chunk state. `src/graph-maintenance.ts` compares SQLite rows with LadybugDB summaries and owns audit/repair JSON shaping. `src/ladybug-store.ts` exposes focused graph-maintenance helpers for document summaries, orphan concepts, vector-index health, deletion, and vector-index rebuild.

**Tech Stack:** TypeScript, Node.js `node:sqlite`, LadybugDB, Vitest, existing DocNexus CLI.

---

### Task 1: Graph Audit Service Tests

**Files:**
- Create: `test/graph-maintenance.test.ts`
- Create later: `src/graph-maintenance.ts`

- [ ] **Step 1: Write failing audit tests**

Create tests that use mocked graph dependencies so they do not require a real LadybugDB runtime:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureIndexStore, openIndexDatabase, upsertFileIndex } from "../src/file-index.js";
import { auditGraph, repairGraph, type GraphMaintenanceStore } from "../src/graph-maintenance.js";

const tempRoots: string[] = [];

const noopGraphWriter = {
  replaceDocumentGraph: async () => {},
  deleteDocumentGraph: async () => {}
};

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-graph-maintenance-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("graph maintenance", () => {
  it("reports clean graph state", async () => {
    const projectRoot = await makeRoot();
    const filePath = join(projectRoot, "clean.md");
    await writeFile(filePath, "Clean graph state.");
    const indexed = await upsertFileIndex(projectRoot, { file_path: filePath }, undefined, noopGraphWriter);
    const graphStore: GraphMaintenanceStore = {
      listDocumentSummaries: async () => [{ file_id: indexed.file_id, file_path: "clean.md", chunk_count: 1 }],
      listOrphanConcepts: async () => [],
      checkVectorIndex: async () => ({ ok: true }),
      deleteDocumentsByFileIds: async () => {},
      deleteConceptsByIds: async () => {},
      rebuildVectorIndex: async () => {}
    };

    await expect(auditGraph(projectRoot, graphStore)).resolves.toMatchObject({
      result: "clean",
      summary: {
        indexed_files: 1,
        ladybug_documents: 1,
        ladybug_chunks: 1,
        missing_documents: 0,
        stale_documents: 0,
        deleted_documents: 0,
        chunk_count_mismatches: 0,
        orphan_concepts: 0,
        vector_index_ok: true
      },
      issues: {
        missing_documents: [],
        stale_documents: [],
        deleted_documents: [],
        chunk_count_mismatches: [],
        orphan_concepts: [],
        vector_index: []
      }
    });
  });

  it("reports missing, stale, deleted, chunk-count, orphan concept, and vector-index issues", async () => {
    const projectRoot = await makeRoot();
    const missingPath = join(projectRoot, "missing.md");
    const mismatchPath = join(projectRoot, "mismatch.md");
    const deletedPath = join(projectRoot, "deleted.md");
    await writeFile(missingPath, "Missing graph doc.");
    await writeFile(mismatchPath, "Mismatched graph chunks.");
    await writeFile(deletedPath, "Deleted graph doc.");
    const missing = await upsertFileIndex(projectRoot, { file_path: missingPath }, undefined, noopGraphWriter);
    const mismatch = await upsertFileIndex(projectRoot, { file_path: mismatchPath }, undefined, noopGraphWriter);
    const deleted = await upsertFileIndex(projectRoot, { file_path: deletedPath }, undefined, noopGraphWriter);

    const db = openIndexDatabase(projectRoot);
    try {
      db.prepare("UPDATE indexed_files SET index_state = 'deleted', deleted_at = updated_at WHERE id = ?").run(deleted.file_id);
      db.prepare("DELETE FROM file_chunks WHERE file_id = ?").run(deleted.file_id);
    } finally {
      db.close();
    }

    const graphStore: GraphMaintenanceStore = {
      listDocumentSummaries: async () => [
        { file_id: mismatch.file_id, file_path: "mismatch.md", chunk_count: 0 },
        { file_id: deleted.file_id, file_path: "deleted.md", chunk_count: 1 },
        { file_id: "file_stale", file_path: "stale.md", chunk_count: 2 }
      ],
      listOrphanConcepts: async () => [{ concept_id: "concept_orphan", name: "Orphan", type: "tool" }],
      checkVectorIndex: async () => ({ ok: false, message: "vector index unavailable" }),
      deleteDocumentsByFileIds: async () => {},
      deleteConceptsByIds: async () => {},
      rebuildVectorIndex: async () => {}
    };

    const audit = await auditGraph(projectRoot, graphStore);

    expect(audit.result).toBe("issues_found");
    expect(audit.summary).toMatchObject({
      indexed_files: 2,
      ladybug_documents: 3,
      ladybug_chunks: 3,
      missing_documents: 1,
      stale_documents: 1,
      deleted_documents: 1,
      chunk_count_mismatches: 1,
      orphan_concepts: 1,
      vector_index_ok: false
    });
    expect(audit.issues.missing_documents).toEqual([{ file_id: missing.file_id, file_path: "missing.md" }]);
    expect(audit.issues.stale_documents).toEqual([{ file_id: "file_stale", file_path: "stale.md" }]);
    expect(audit.issues.deleted_documents).toEqual([{ file_id: deleted.file_id, file_path: "deleted.md" }]);
    expect(audit.issues.chunk_count_mismatches).toEqual([
      { file_id: mismatch.file_id, file_path: "mismatch.md", sqlite_chunks: 1, ladybug_chunks: 0 }
    ]);
    expect(audit.issues.orphan_concepts).toEqual([{ concept_id: "concept_orphan", name: "Orphan", type: "tool" }]);
    expect(audit.issues.vector_index).toEqual([{ message: "vector index unavailable" }]);
    expect(audit.checked_at).toEqual(expect.any(String));
  });
});
```

- [ ] **Step 2: Run audit tests to verify RED**

Run: `npm test -- test/graph-maintenance.test.ts`

Expected: fail because `src/graph-maintenance.ts` does not exist or does not export the requested API.

### Task 2: Graph Repair Service Tests

**Files:**
- Modify: `test/graph-maintenance.test.ts`
- Modify later: `src/graph-maintenance.ts`

- [ ] **Step 1: Add failing repair tests**

Append repair tests covering the `--force` guard, cleanup actions, remaining issue recommendations, and `index_events` row:

```ts
  it("requires force for graph repair", async () => {
    const projectRoot = await makeRoot();
    await expect(repairGraph(projectRoot, { force: false })).rejects.toThrow("graph repair requires --force");
  });

  it("deletes repairable graph drift, rebuilds vector index, and records an event", async () => {
    const projectRoot = await makeRoot();
    const missingPath = join(projectRoot, "missing.md");
    const mismatchPath = join(projectRoot, "mismatch.md");
    const deletedPath = join(projectRoot, "deleted.md");
    await writeFile(missingPath, "Missing graph doc.");
    await writeFile(mismatchPath, "Mismatched graph chunks.");
    await writeFile(deletedPath, "Deleted graph doc.");
    const missing = await upsertFileIndex(projectRoot, { file_path: missingPath }, undefined, noopGraphWriter);
    const mismatch = await upsertFileIndex(projectRoot, { file_path: mismatchPath }, undefined, noopGraphWriter);
    const deleted = await upsertFileIndex(projectRoot, { file_path: deletedPath }, undefined, noopGraphWriter);

    const db = openIndexDatabase(projectRoot);
    try {
      db.prepare("UPDATE indexed_files SET index_state = 'deleted', deleted_at = updated_at WHERE id = ?").run(deleted.file_id);
      db.prepare("DELETE FROM file_chunks WHERE file_id = ?").run(deleted.file_id);
    } finally {
      db.close();
    }

    const deletedDocuments: string[][] = [];
    const deletedConcepts: string[][] = [];
    let rebuilt = false;
    const beforeStore: GraphMaintenanceStore = {
      listDocumentSummaries: async () => [
        { file_id: mismatch.file_id, file_path: "mismatch.md", chunk_count: 0 },
        { file_id: deleted.file_id, file_path: "deleted.md", chunk_count: 1 },
        { file_id: "file_stale", file_path: "stale.md", chunk_count: 2 }
      ],
      listOrphanConcepts: async () => [{ concept_id: "concept_orphan", name: "Orphan", type: "tool" }],
      checkVectorIndex: async () => ({ ok: true }),
      deleteDocumentsByFileIds: async (fileIds) => deletedDocuments.push(fileIds),
      deleteConceptsByIds: async (conceptIds) => deletedConcepts.push(conceptIds),
      rebuildVectorIndex: async () => {
        rebuilt = true;
      }
    };

    const repairedStore: GraphMaintenanceStore = {
      ...beforeStore,
      listDocumentSummaries: async () => [{ file_id: mismatch.file_id, file_path: "mismatch.md", chunk_count: 0 }],
      listOrphanConcepts: async () => []
    };

    let calls = 0;
    const graphStoreFactory = () => {
      calls += 1;
      return calls === 1 ? beforeStore : repairedStore;
    };

    const result = await repairGraph(projectRoot, { force: true }, graphStoreFactory);

    expect(deletedDocuments).toEqual([[deleted.file_id, "file_stale"]]);
    expect(deletedConcepts).toEqual([["concept_orphan"]]);
    expect(rebuilt).toBe(true);
    expect(result).toMatchObject({
      result: "completed_with_remaining_issues",
      actions: {
        deleted_stale_documents: 1,
        deleted_deleted_documents: 1,
        deleted_orphan_concepts: 1,
        rebuilt_vector_index: true
      },
      before: { total_issues: 4 },
      after: {
        total_issues: 2,
        remaining_issue_types: ["missing_documents", "chunk_count_mismatches"]
      },
      recommendations: ["Run docnexus index rebuild --force to recreate missing documents or chunk-count mismatches."]
    });

    const eventDb = openIndexDatabase(projectRoot);
    try {
      const event = eventDb
        .prepare("SELECT operation, file_path, result FROM index_events WHERE operation = 'graph_repair' ORDER BY created_at DESC LIMIT 1")
        .get();
      expect(event).toEqual({ operation: "graph_repair", file_path: "<graph>", result: "success" });
    } finally {
      eventDb.close();
    }
  });
```

- [ ] **Step 2: Run repair tests to verify RED**

Run: `npm test -- test/graph-maintenance.test.ts`

Expected: fail because `repairGraph` is not implemented.

### Task 3: Implement Graph Maintenance Service

**Files:**
- Create: `src/graph-maintenance.ts`

- [ ] **Step 1: Implement service types and audit logic**

Implement `auditGraph`, `repairGraph`, injected store dependencies, issue counting, recommendation generation, and `graph_repair` event writing through `openIndexDatabase`.

- [ ] **Step 2: Run graph-maintenance tests**

Run: `npm test -- test/graph-maintenance.test.ts`

Expected: pass.

### Task 4: LadybugDB Maintenance Helpers

**Files:**
- Modify: `src/ladybug-store.ts`
- Modify: `test/ladybug-store.test.ts`

- [ ] **Step 1: Add failing Ladybug helper integration assertions**

Extend the integration test to assert document summaries, orphan concept listing/deletion, document deletion by file ids, vector health check, and vector index rebuild. These assertions remain guarded by `DOCNEXUS_LADYBUG_INTEGRATION === "1"`.

- [ ] **Step 2: Run Ladybug tests to verify RED**

Run: `npm test -- test/ladybug-store.test.ts`

Expected: fail because the helper exports do not exist.

- [ ] **Step 3: Implement focused Ladybug helpers**

Add exports:

```ts
listLadybugDocumentSummaries(projectRoot)
listLadybugOrphanConcepts(projectRoot)
deleteLadybugDocumentsByFileIds(projectRoot, fileIds)
deleteLadybugConceptsByIds(projectRoot, conceptIds)
rebuildLadybugVectorIndex(projectRoot)
checkLadybugVectorIndex(projectRoot)
```

- [ ] **Step 4: Run Ladybug tests**

Run: `npm test -- test/ladybug-store.test.ts`

Expected: pass.

### Task 5: CLI Integration

**Files:**
- Modify: `src/cli.ts`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Add failing CLI tests**

Add tests for:

```ts
const audit = JSON.parse(await runCli(["graph", "audit"], projectRoot));
expect(audit.result).toBe("clean");

await expect(runCli(["graph", "repair"], projectRoot)).rejects.toThrow("graph repair requires --force");

const repair = JSON.parse(await runCli(["graph", "repair", "--force"], projectRoot));
expect(repair.actions.rebuilt_vector_index).toBe(true);
```

- [ ] **Step 2: Run CLI tests to verify RED**

Run: `npm test -- test/cli.test.ts`

Expected: fail because `graph` commands are unknown.

- [ ] **Step 3: Wire CLI graph commands**

Import `auditGraph` and `repairGraph`, dispatch:

```ts
docnexus graph audit
docnexus graph repair --force
```

Update usage text.

- [ ] **Step 4: Run CLI tests**

Run: `npm test -- test/cli.test.ts`

Expected: pass.

### Task 6: Documentation and Verification

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/product-brief-docnexus-mvp.en.md`
- Modify: `docs/product-brief-docnexus-mvp.zh-CN.md`

- [ ] **Step 1: Update docs**

Document:

```bash
docnexus graph audit
docnexus graph repair --force
```

Explain that audit is read-only, repair cleans stale/deleted documents and orphan concepts, rebuilds the vector index, records `graph_repair`, and recommends `docnexus index rebuild --force` for missing docs or chunk-count mismatches.

- [ ] **Step 2: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected: all pass.

- [ ] **Step 3: Commit**

Run:

```bash
git add docs/superpowers/plans/2026-05-21-docnexus-graph-audit-repair.md src/graph-maintenance.ts src/ladybug-store.ts src/cli.ts test/graph-maintenance.test.ts test/ladybug-store.test.ts test/cli.test.ts README.md README.zh-CN.md docs/product-brief-docnexus-mvp.en.md docs/product-brief-docnexus-mvp.zh-CN.md
git commit -m "feat: add graph audit repair workflow"
```
