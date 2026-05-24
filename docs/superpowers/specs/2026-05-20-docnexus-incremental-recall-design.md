# DocNexus Incremental Recall Design

Date: 2026-05-20

## Context

DocNexus currently provides a skill-first local archive for Agent-refined project memory. The implemented MVP can preserve source content, normalized Markdown, and metadata under `.docnexus/`, and exposes MCP tools for archive, validation, listing, retrieval, and status.

The original `docPlan.md` describes a larger local Graph RAG system with CLI commands, embedded vector search, incremental hashing, and graph traversal. The next phase should move toward that goal without introducing a large graph database or external model provider too early.

## Goal

Add a command-driven incremental semantic index and recall layer.

The user or Agent explicitly tells DocNexus which file changed. DocNexus indexes that file, updates it when requested, deletes its recall index when requested, and returns relevant chunks for natural-language recall queries.

This phase must remain local, deterministic, and Agent-oriented:

- no automatic directory scanning
- no file watcher
- no background capture
- no external embedding or LLM provider
- no final natural-language answer generation inside MCP
- no full LadybugDB or Graph RAG implementation yet

## Chosen Approach

Use a file-level command-driven incremental index backed by SQLite.

New and updated files share one operation: `upsert_file_index`. Deletion is explicit through `delete_file_index`. Recall queries use local embeddings stored in SQLite and return matching chunks for the Agent to interpret.

This keeps the implementation small enough to verify while adding the first real retrieval capability.

## Architecture

DocNexus gains one new local service layer: the index service.

### Existing Layers

The existing archive flow remains unchanged:

1. `docnexus-capture` skill refines source into `document` and `metadata`.
2. MCP validates metadata.
3. MCP archives source, document, and metadata under `.docnexus/records/<id>/`.

### New Index Service

The index service owns:

- reading a user-specified file path
- normalizing and hashing file content
- chunking text
- generating local embeddings
- storing chunks and embeddings in SQLite
- deleting recall indexes for explicitly specified files
- ranking recall results
- writing index audit events

MCP and CLI both call the same TypeScript service functions. MCP is the Agent-facing interface; CLI is the manual local command interface.

## Command-Driven File Lifecycle

DocNexus does not infer file changes by scanning the project. The caller must specify the changed file.

### Add or Update

`upsert_file_index` handles both new and existing files.

Input includes a file path and optional file name or archive record ID. The service reads the file, computes a content hash, compares it to any existing indexed row for that file, and returns:

- `created` when the file was not indexed before
- `updated` when the file existed and content changed
- `noop` when the file hash did not change

When updating, old chunks and embeddings for that file are removed before new chunks are inserted.

### Delete

`delete_file_index` removes a file from recall results. It accepts either `file_path` or `file_id`.

Deletion only affects the recall index:

- delete the file's chunks and embeddings
- mark the file row as `deleted`
- write an audit event

It does not delete archived source, document, or metadata under `.docnexus/records/<id>/`.

## Storage Design

The existing `.docnexus/index.sqlite` database is extended with three new tables.

### `indexed_files`

Tracks files that have been explicitly added to the recall index.

```text
id TEXT PRIMARY KEY
file_name TEXT NOT NULL
file_path TEXT NOT NULL UNIQUE
content_hash TEXT NOT NULL
metadata_hash TEXT
record_id TEXT
index_state TEXT NOT NULL
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
deleted_at TEXT
```

Rules:

- `file_path` may be provided as an absolute path or a project-relative path.
- If the resolved file is under the project root, `file_path` is stored relative to the project root. Files outside the project root are rejected in this phase.
- `file_name` defaults to the basename of `file_path` when the caller does not provide one.
- `record_id` is optional and links to an archive record when known.
- `index_state` is one of `indexed`, `deleted`, or `failed`.
- A deleted file can be reactivated by calling `upsert_file_index` again.

### `file_chunks`

Stores indexed text chunks and their local embeddings.

```text
id TEXT PRIMARY KEY
file_id TEXT NOT NULL
chunk_index INTEGER NOT NULL
text TEXT NOT NULL
text_hash TEXT NOT NULL
embedding_json TEXT NOT NULL
created_at TEXT NOT NULL
```

The first implementation stores embeddings as JSON arrays. Similarity is calculated in TypeScript after loading candidate chunks from SQLite. This avoids introducing a vector database before chunking, hashing, and recall behavior are stable.

### `index_events`

Provides an audit trail for explicit indexing operations.

```text
id TEXT PRIMARY KEY
file_id TEXT
operation TEXT NOT NULL
file_path TEXT NOT NULL
result TEXT NOT NULL
message TEXT
created_at TEXT NOT NULL
```

Allowed `operation` values:

- `upsert`
- `delete`

Allowed `result` values:

- `created`
- `updated`
- `noop`
- `deleted`
- `failed`

## Hashing Rules

`content_hash` is `sha256(file content)`.

If metadata is provided later, or when a file is associated with `record_id`, `metadata_hash` may be included in the indexed file row. The first implementation compares content hash for file updates. Metadata hash is reserved for a later phase that re-indexes when metadata changes.

## Chunking

Add `src/chunker.ts`.

The chunker accepts Markdown or plain text and returns ordered chunks:

```ts
{
  index: number;
  text: string;
  text_hash: string;
}
```

Initial rules:

- reject empty or whitespace-only content
- split on paragraphs first
- target roughly 800-1200 characters per chunk
- preserve input order with stable `chunk_index`
- avoid Markdown AST parsing in this phase

This keeps chunking deterministic and easy to test.

## Embedding

Add an embedding interface:

```ts
export interface Embedder {
  dimension: number;
  embed(text: string): number[];
}
```

The first implementation should provide a `LocalHashEmbedder`.

`LocalHashEmbedder` is deterministic, local, and dependency-free. It is not the final semantic model, but it lets the project complete and test the full index and recall loop without external services. The interface allows a later replacement with the project's lightweight embedding model without changing MCP or CLI contracts.

Embedding rules:

- all embeddings must have the same configured dimension
- embedding generation must be deterministic for the same text
- dimension mismatch is treated as an error

## Recall

Recall returns context chunks, not final answers.

Flow:

1. Validate `query`.
2. Generate a local query embedding.
3. Load chunks for files where `index_state = indexed`.
4. Parse `embedding_json`.
5. Compute cosine similarity.
6. Sort by score descending.
7. Return the top results.

Defaults:

- `limit = 5`
- maximum `limit = 20`
- empty index returns an empty result list

Output includes enough context for an Agent to decide how to use the result:

```json
{
  "query": "string",
  "results": [
    {
      "file_id": "string",
      "file_path": "string",
      "record_id": "optional string",
      "chunk_id": "string",
      "chunk_index": 0,
      "score": 0.92,
      "text": "string"
    }
  ]
}
```

## MCP Tool Contracts

### `upsert_file_index`

Input:

```json
{
  "file_path": "string",
  "file_name": "optional string",
  "record_id": "optional string"
}
```

Output:

```json
{
  "file_id": "string",
  "file_path": "string",
  "result": "created|updated|noop",
  "chunk_count": 0,
  "content_hash": "string"
}
```

### `delete_file_index`

Input:

```json
{
  "file_path": "optional string",
  "file_id": "optional string"
}
```

Output:

```json
{
  "file_id": "string",
  "file_path": "string",
  "result": "deleted"
}
```

### `recall`

Input:

```json
{
  "query": "string",
  "limit": "optional number"
}
```

Output:

```json
{
  "query": "string",
  "results": []
}
```

### `index_status`

Input: none.

Output:

```json
{
  "indexed_file_count": 0,
  "chunk_count": 0,
  "deleted_file_count": 0,
  "last_event": {
    "operation": "string",
    "result": "string",
    "created_at": "string"
  }
}
```

## CLI Commands

CLI commands use the same core index service as MCP.

```bash
docnexus index upsert <file_path> --name <file_name> --record-id <record_id>
docnexus index delete --file <file_path>
docnexus index delete --id <file_id>
docnexus recall "<query>" --limit 5
docnexus index status
```

The CLI does not require a long-running service. It opens the project-local store directly.

## Relationship To Existing Tools

Existing MCP tools remain:

- `archive_record`
- `list_records`
- `get_record`
- `status`
- `validate_metadata`

New MCP tools:

- `upsert_file_index`
- `delete_file_index`
- `recall`
- `index_status`

`archive_record` does not automatically index content in this phase. Indexing stays explicit so the user or Agent controls file-level lifecycle events.

## Error Handling

Errors should be short and actionable for Agents.

Expected errors:

- `file_path is required`
- `file does not exist`
- `file is not readable`
- `file content is empty`
- `file_path or file_id is required`
- `indexed file not found`
- `query must be a non-empty string`
- `limit must be a positive integer`
- `embedding dimension mismatch`

MCP does not silently repair invalid arguments.

## Testing Strategy

### Unit Tests

`chunker.test.ts`:

- rejects empty content
- splits long content into multiple chunks
- preserves stable chunk order

`embedder.test.ts`:

- same text produces the same vector
- different text produces a different vector
- vector dimension is fixed

### Integration Tests

`index.test.ts`:

- `upsert_file_index` on a new file returns `created`
- unchanged content returns `noop`
- changed content returns `updated`
- update replaces old chunks
- `delete_file_index` removes chunks and marks the file `deleted`
- deleting an unknown file returns a clear error

`recall.test.ts`:

- recall returns top matching chunks
- deleted files are excluded
- limit is enforced
- empty index returns empty results

`mcp.test.ts`:

- new tools validate arguments
- MCP handlers call the core service and return stable JSON

### Verification

Run:

```bash
npm test
npm run typecheck
npm run build
```

## Success Criteria

The phase is complete when an Agent or user can:

1. Explicitly index a named file.
2. Re-run the same command after a file update and get `updated` or `noop`.
3. Explicitly delete a file from the recall index.
4. Run a natural-language recall query and receive ranked context chunks.
5. Use all of this without external model providers, automatic scanning, or a background watcher.
