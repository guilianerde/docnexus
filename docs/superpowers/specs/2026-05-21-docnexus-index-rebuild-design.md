# DocNexus Index Rebuild Design

Date: 2026-05-21

## Context

DocNexus currently supports explicit file indexing, deletion, LadybugDB graph/vector recall, and local real embeddings. The remaining operational gap is a manual way to repair or refresh the derived LadybugDB recall store after embedding changes, graph write failures, local store corruption, or schema/runtime upgrades.

The first rebuild version should stay narrow: rebuild only the LadybugDB-derived recall state from the currently indexed files. It must preserve archive data and SQLite lifecycle data.

## Goal

Add a manual CLI command:

```bash
docnexus index rebuild --force
```

The command rebuilds LadybugDB `Document`, `Chunk`, `Concept`, and relationship data from `indexed_files` rows whose `index_state` is `indexed`.

## Scope

This iteration includes:

- CLI-only rebuild command.
- Explicit `--force` requirement.
- Rebuild source is `indexed_files.index_state = 'indexed'`.
- Re-read each indexed file from disk.
- Re-chunk content and regenerate embeddings with the current default embedder.
- Re-read linked metadata from `record_id` when available.
- Replace each document graph in LadybugDB using the existing graph writer.
- Append `index_events` rows for rebuild success or failure.
- Return a JSON summary.

This iteration does not include:

- MCP rebuild tool.
- File watcher or automatic rebuild.
- Global transaction rollback.
- Detailed consistency diff report.
- Rebuild from `.docnexus/records/*/document.md`.
- Model switching.
- Clearing `records`, `indexed_files`, `file_chunks`, or `index_events`.

## Command Contract

Command:

```bash
docnexus index rebuild --force
```

Behavior:

- Without `--force`, the command fails with a clear error.
- The command is manual and one-shot.
- It does not delete archive records.
- It does not clear or rewrite SQLite lifecycle tables.
- It appends rebuild audit events into `index_events`.
- It rebuilds LadybugDB state for all currently indexed files.

Output shape:

```json
{
  "result": "completed",
  "processed_files": 3,
  "rebuilt_files": 3,
  "failed_files": [],
  "started_at": "2026-05-21T00:00:00.000Z",
  "finished_at": "2026-05-21T00:00:01.000Z"
}
```

When one or more files fail:

```json
{
  "result": "completed_with_errors",
  "processed_files": 3,
  "rebuilt_files": 2,
  "failed_files": [
    {
      "file_id": "file_...",
      "file_path": "docs/missing.md",
      "error": "file does not exist"
    }
  ],
  "started_at": "2026-05-21T00:00:00.000Z",
  "finished_at": "2026-05-21T00:00:01.000Z"
}
```

## Execution Flow

1. Parse `docnexus index rebuild --force`.
2. Open `.docnexus/index.sqlite`.
3. Load rows from `indexed_files` where `index_state = 'indexed'`.
4. For each row:
   - Resolve `file_path` under `projectRoot`.
   - Read current file content.
   - Recompute `content_hash`.
   - Split current content into chunks.
   - Generate embeddings with the current default embedder.
   - Read metadata from linked `record_id` if present.
   - Map metadata entities and relationships into graph concepts and edges.
   - Call `replaceDocumentGraph` to replace LadybugDB data for that file.
   - Append `index_events` with `operation = 'rebuild'` and `result = 'success'`.
5. If a file fails:
   - Append `index_events` with `operation = 'rebuild'`, `result = 'failed'`, and the error message.
   - Add the file to `failed_files`.
   - Continue with the next file.
6. Return the summary JSON.

## SQLite Policy

Rebuild preserves SQLite as the source of lifecycle truth.

The command must not clear:

- `records`
- `indexed_files`
- `file_chunks`
- `index_events`

The command may read `indexed_files`, `file_chunks`, and record metadata, but this first version should avoid rewriting SQLite chunk rows. Its purpose is to repair the LadybugDB-derived recall store, not to redefine file lifecycle state.

Audit events are append-only:

- success: `operation = 'rebuild'`, `result = 'success'`
- failure: `operation = 'rebuild'`, `result = 'failed'`, `error = <message>`

## LadybugDB Policy

For each indexed file, rebuild calls the existing document graph replacement operation. This keeps behavior consistent with normal `index upsert`:

- old LadybugDB document/chunk data for the file is removed
- current chunks and embeddings are inserted
- document metadata is written
- concepts and relationships are mapped from metadata
- vector index remains usable after replacement

This command does not attempt to delete LadybugDB data for files that are no longer present in `indexed_files.index_state = 'indexed'`. Cleanup of stale graph data can be added later as a separate repair mode.

## Error Handling

- Missing `--force`: fail before touching storage.
- No indexed files: return `completed` with zero counts.
- File read failure: record failed file and continue.
- Embedding failure: record failed file and continue.
- Metadata read failure: record failed file and continue.
- LadybugDB write failure: record failed file and continue.

The first version intentionally does not implement global rollback. Rebuild is an operational repair command and should recover as much as possible in one run.

## Tests

Unit and integration tests should cover:

- CLI rejects `docnexus index rebuild` without `--force`.
- Empty index returns completed summary with zero counts.
- Rebuild processes indexed files and returns rebuilt count.
- Rebuild appends `index_events` rows with `operation = 'rebuild'`.
- Single-file failure is reported in `failed_files` and does not stop other files.
- Existing `index upsert`, `index delete`, `recall`, and `index status` behavior remains unchanged.

## Documentation Updates

Update Chinese and English product docs to move graph cleanup/full rebuild from "not implemented" into implemented scope once the command lands, while keeping future work for:

- consistency report
- stale graph cleanup
- MCP rebuild tool
- model switching
- deeper graph recall tuning

## Completion Criteria

- `docnexus index rebuild --force` exists and returns JSON.
- The command rebuilds LadybugDB data from current indexed files.
- SQLite lifecycle tables are preserved.
- Rebuild audit events are appended.
- Tests, typecheck, and build pass.

