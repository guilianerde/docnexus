# DocNexus Graph Audit and Repair Design

Date: 2026-05-21

## Context

DocNexus now stores project memory in two layers:

- SQLite is the source-of-truth ledger for archived records, indexed files, file chunks, and index events.
- LadybugDB is the derived graph/vector recall store for `Project`, `Document`, `Chunk`, `Concept`, and relationship edges.

Index upsert/delete/rebuild already update LadybugDB, but the project does not yet provide a dedicated way to inspect or repair drift between SQLite and LadybugDB. Before production Graph RAG tuning or deeper multi-hop reasoning, DocNexus needs a reliable graph maintenance foundation. Otherwise stale documents, stale chunks, orphan concepts, or broken vector indexes can distort recall quality and make tuning hard to evaluate.

## Goal

Add CLI-only graph audit and repair commands that verify and repair LadybugDB derived graph state against the SQLite source-of-truth ledger.

This iteration should provide:

- `docnexus graph audit`
- `docnexus graph repair --force`
- structured JSON audit output
- explicit repair with a `--force` guard
- audit/repair tests around stale, deleted, missing, chunk-count, orphan concept, and vector-index conditions

## Non-Goals

This iteration does not:

- Change `docnexus recall` ranking.
- Add deeper multi-hop graph traversal.
- Add MCP graph audit or repair tools.
- Automatically repair graph drift during recall.
- Delete archived records under `.docnexus/records/`.
- Delete or rewrite SQLite `records`, `indexed_files`, `file_chunks`, or historical `index_events`.
- Clear or rewrite the full LadybugDB store unless a focused repair operation requires deleting stale derived nodes.

## Command Ownership

Graph maintenance is a CLI maintenance workflow.

```bash
docnexus graph audit
docnexus graph repair --force
```

MCP remains focused on low-level archive, metadata, index, and status tools. The recall skill continues to call CLI recall and is not involved in graph maintenance.

## Audit Semantics

`docnexus graph audit` is read-only.

It returns JSON with this shape:

```json
{
  "result": "clean|issues_found",
  "summary": {
    "indexed_files": 0,
    "ladybug_documents": 0,
    "ladybug_chunks": 0,
    "missing_documents": 0,
    "stale_documents": 0,
    "deleted_documents": 0,
    "chunk_count_mismatches": 0,
    "orphan_concepts": 0,
    "vector_index_ok": true
  },
  "issues": {
    "missing_documents": [],
    "stale_documents": [],
    "deleted_documents": [],
    "chunk_count_mismatches": [],
    "orphan_concepts": [],
    "vector_index": []
  },
  "checked_at": "ISO timestamp"
}
```

### Missing Documents

A missing document exists when SQLite has:

```sql
indexed_files.index_state = 'indexed'
```

but LadybugDB has no `Document` with the same `file_id`.

Audit should report:

```json
{
  "file_id": "file_...",
  "file_path": "path/to/file.md"
}
```

### Stale Documents

A stale document exists when LadybugDB has a `Document.file_id` that does not exist in SQLite `indexed_files`.

Audit should report:

```json
{
  "file_id": "file_...",
  "file_path": "path/from/ladybug.md"
}
```

### Deleted Documents

A deleted document exists when SQLite has an `indexed_files` row with:

```sql
index_state = 'deleted'
```

and LadybugDB still has a `Document` with that `file_id`.

Audit should report:

```json
{
  "file_id": "file_...",
  "file_path": "path/to/file.md"
}
```

### Chunk Count Mismatches

A chunk count mismatch exists when SQLite `file_chunks` count for an indexed file differs from LadybugDB `Chunk` count for the same `file_id`.

Audit should report:

```json
{
  "file_id": "file_...",
  "file_path": "path/to/file.md",
  "sqlite_chunks": 3,
  "ladybug_chunks": 2
}
```

### Orphan Concepts

An orphan concept is a LadybugDB `Concept` node that is not mentioned by any `Document` through `MENTIONS`.

Audit should report:

```json
{
  "concept_id": "concept_...",
  "name": "Concept Name",
  "type": "tool"
}
```

### Vector Index Check

Audit should verify that the vector index can be queried when LadybugDB has chunks.

The check should:

- return `true` when there are zero chunks
- return `true` when a small vector query succeeds
- return issue detail when the query fails

Audit should not rebuild the vector index.

## Repair Semantics

`docnexus graph repair --force` mutates LadybugDB derived graph state and writes an audit event.

Without `--force`, it fails with:

```text
graph repair requires --force
```

Repair should:

1. Run audit first.
2. Delete stale LadybugDB `Document` and attached `Chunk` nodes when there is no SQLite indexed file row.
3. Delete LadybugDB `Document` and attached `Chunk` nodes for SQLite rows marked `deleted`.
4. Delete orphan `Concept` nodes.
5. Rebuild the vector index by dropping and recreating `chunk_vector_index`.
6. Run audit again.
7. Return before/after issue counts and repair actions.
8. Append an `index_events` row with:
   - `operation = 'graph_repair'`
   - `result = 'success'` or `failed`
   - `file_path = '<graph>'`

Repair should not attempt to recreate missing documents or fix chunk-count mismatches in this iteration. Those require re-reading source files and re-embedding content, which is already covered by `docnexus index rebuild --force`. The repair result should recommend rebuild when those issue types remain after repair.

## Repair Output

`docnexus graph repair --force` returns JSON:

```json
{
  "result": "completed|completed_with_remaining_issues",
  "actions": {
    "deleted_stale_documents": 0,
    "deleted_deleted_documents": 0,
    "deleted_orphan_concepts": 0,
    "rebuilt_vector_index": true
  },
  "before": {
    "total_issues": 0
  },
  "after": {
    "total_issues": 0,
    "remaining_issue_types": []
  },
  "recommendations": [],
  "started_at": "ISO timestamp",
  "finished_at": "ISO timestamp"
}
```

## Architecture

### `src/graph-maintenance.ts`

New service module:

- `auditGraph(projectRoot, reader?)`
- `repairGraph(projectRoot, { force }, dependencies?)`

Responsibilities:

- read SQLite `indexed_files` and `file_chunks`
- request LadybugDB document/chunk/concept summaries
- compare source-of-truth rows against derived graph state
- shape audit and repair JSON outputs
- write repair audit events to SQLite

This module should own comparison logic. It should not know LadybugDB query syntax beyond adapter return shapes.

### `src/ladybug-store.ts`

Add lower-level LadybugDB graph maintenance helpers:

- list documents with chunk counts
- list orphan concepts
- delete documents by `file_id`
- delete orphan concepts
- rebuild vector index
- check vector index health

These helpers should reuse existing connection, schema, vector index, and deletion utilities where possible.

### `src/file-index.ts`

Expose minimal event-writing support if needed, or keep repair event insertion in `graph-maintenance.ts` through the same SQLite path and schema.

Do not refactor unrelated index lifecycle logic.

### `src/cli.ts`

Add:

```bash
docnexus graph audit
docnexus graph repair --force
```

Unknown graph commands should continue to use the existing usage-error style.

## Error Handling

- `graph repair` without `--force` throws `graph repair requires --force`.
- LadybugDB unavailable should fail with the existing LadybugDB dependency error.
- Audit should not mutate state when LadybugDB queries fail.
- Repair should write a failed `index_events` row when mutation starts but fails.
- Repair should surface remaining missing documents or chunk mismatches as recommendations instead of hiding them.

## Testing

Add focused tests:

- clean graph audit returns `clean`
- missing LadybugDB document is reported
- stale LadybugDB document is reported and repaired
- deleted SQLite file with remaining LadybugDB document is reported and repaired
- chunk count mismatch is reported and not repaired
- orphan concept is reported and repaired
- `graph repair` rejects missing `--force`
- CLI routes `graph audit` and `graph repair --force`

Tests may use injected readers/writers for service-level comparison behavior and existing LadybugDB integration helpers for adapter behavior where practical.

## Documentation

Update README and product briefs:

- Move graph consistency reporting and stale graph cleanup from "not implemented" to implemented after implementation lands.
- Document CLI graph maintenance commands.
- Keep Graph RAG ranking tuning and deeper multi-hop reasoning as future work.

## Success Criteria

- `docnexus graph audit` reports graph consistency state as JSON.
- `docnexus graph repair --force` performs focused LadybugDB cleanup and vector index rebuild.
- SQLite source-of-truth tables and archived records are preserved.
- Remaining non-repairable issues recommend `docnexus index rebuild --force`.
- Tests, typecheck, and build pass:

```bash
npm test
npm run typecheck
npm run build
```

## Follow-Up Sequence

After this stage is implemented and verified:

1. Production Graph RAG tuning should add ranking signals and recall quality tests on top of clean graph state.
2. Deeper multi-hop graph reasoning should add bounded path traversal after ranking and audit behavior are stable.
