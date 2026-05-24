# DocNexus Agent Memory Design

Date: 2026-05-17

## Context

The current project contains `docPlan.md`, which describes a local Agent-oriented intelligent documentation and Graph RAG system inspired by the GitNexus model. The full plan includes CLI commands, MCP integration, local project storage, metadata extraction, embedded graph/vector indexing, incremental sync, and recall.

The first implementation phase will deliberately narrow that scope. The goal is to make DocNexus useful to Codex, Claude Code, and similar coding agents through a manual skill-driven workflow, while keeping persistent storage consistent through a small MCP API.

## MVP Goal

DocNexus v0 should provide a local project memory archive for Agent-produced documentation.

The user manually triggers a DocNexus skill. The Agent uses that skill to refine the selected conversation, document, plan, or notes into:

- preserved source content
- a normalized Markdown document
- structured metadata JSON

The Agent then calls the DocNexus MCP server to archive those three assets under the current project in `.docnexus/`.

## Chosen Approach

Use a skill-first architecture with a thin MCP storage service.

The skill layer owns intelligent extraction and document refinement. The MCP layer owns local archive consistency, validation, indexing, and retrieval. MCP does not call an LLM and does not generate or rewrite documentation.

This keeps the first version aligned with the product intent: DocNexus is a service for Agents, and the Agent's skill workflow is the intelligence layer.

## Architecture

DocNexus has three layers in the first phase.

### Skills Layer

The primary skill is `docnexus-capture`.

It is manually triggered by explicit user intent, such as:

- "Use DocNexus to archive this discussion."
- "Call docnexus-capture for the current plan."
- "Refine this file with DocNexus and archive it."

The skill guides the Agent to:

1. Collect the source content from the current context or a user-specified file.
2. Preserve the source content without lossy rewriting.
3. Produce a normalized `document.md`.
4. Produce a schema-compliant `metadata.json`.
5. Call the MCP `archive_record` tool.
6. Report the archive result to the user.

The skill does not trigger automatically. DocNexus is not a background memory system in the MVP.

### MCP Layer

The MCP server provides a small local repository API:

- `archive_record`
- `list_records`
- `get_record`
- `status`
- `validate_metadata`

MCP responsibilities:

- initialize `.docnexus/` when needed
- validate metadata against the local schema
- generate record IDs
- write source, document, and metadata files
- compute content hashes
- maintain `index.sqlite`
- read archived records

MCP non-responsibilities:

- no LLM calls
- no document generation
- no rewriting Agent output
- no embedding generation
- no Graph RAG

### Local Core Layer

The local core library backs the MCP server. It handles project root detection, archive path creation, file writes, SQLite access, hash calculation, schema validation, and record reads.

The intended implementation shape is a Node.js/TypeScript package.

## Storage Layout

All first-phase data lives in the project-local hidden store:

```text
<project-root>/
└── .docnexus/
    ├── index.sqlite
    ├── records/
    │   └── <record_id>/
    │       ├── source.md
    │       ├── document.md
    │       └── metadata.json
    └── schemas/
        └── metadata.schema.json
```

Record assets:

- `source.md`: original content provided by the Agent.
- `document.md`: refined technical Markdown produced by the skill workflow.
- `metadata.json`: structured metadata produced by the skill workflow.
- `metadata.schema.json`: local schema used by skills and MCP validation.

## SQLite Index

`index.sqlite` contains a minimal `records` table:

```text
records
- id
- title
- summary
- tags_json
- source_hash
- document_hash
- metadata_hash
- created_at
- updated_at
- record_path
```

The index supports status, listing, retrieval, later deduplication, and future recall features. The MVP allows duplicate content but records hashes so later versions can add merge or dedupe behavior without changing the archive format.

## Metadata Schema

The first metadata shape is:

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

Validation should reject missing required fields, invalid enum values, and malformed arrays. It should return structured errors that an Agent can use to fix its metadata and retry.

## MCP Tool Contracts

### `archive_record`

Input:

```json
{
  "source": "string",
  "document": "string",
  "metadata": {},
  "source_name": "optional string"
}
```

Output:

```json
{
  "id": "string",
  "record_path": "string",
  "created_at": "ISO timestamp",
  "hashes": {
    "source": "string",
    "document": "string",
    "metadata": "string"
  }
}
```

Behavior:

1. Ensure `.docnexus/` exists.
2. Validate required fields.
3. Validate `metadata`.
4. Generate a record ID.
5. Write `source.md`, `document.md`, and `metadata.json`.
6. Insert a row into `index.sqlite`.
7. Return archive details.

### `list_records`

Input:

```json
{
  "limit": "optional number",
  "tag": "optional string"
}
```

Output:

```json
{
  "records": [
    {
      "id": "string",
      "title": "string",
      "summary": "string",
      "tags": ["string"],
      "created_at": "ISO timestamp"
    }
  ]
}
```

### `get_record`

Input:

```json
{
  "id": "string",
  "include": ["source", "document", "metadata"]
}
```

Output:

```json
{
  "id": "string",
  "source": "optional string",
  "document": "optional string",
  "metadata": "optional object"
}
```

### `status`

Input: none.

Output:

```json
{
  "project_root": "string",
  "store_path": "string",
  "initialized": true,
  "record_count": 0
}
```

### `validate_metadata`

Input:

```json
{
  "metadata": {}
}
```

Output:

```json
{
  "valid": true,
  "errors": []
}
```

## Error Handling

Errors should be structured and actionable for Agents.

Expected MVP errors:

- missing `source`, `document`, or `metadata`
- invalid metadata schema
- invalid or missing project root
- filesystem write failure
- SQLite initialization or write failure
- unknown record ID

MCP should not silently repair malformed Agent output. It should return validation errors so the skill workflow can regenerate or correct the content.

## Testing Strategy

Unit tests:

- metadata schema validation
- record ID generation
- hash calculation
- project store path resolution
- SQLite insert and query behavior

Integration tests:

- `archive_record` creates all three record files and writes the SQLite row
- `list_records` returns indexed records
- `get_record` returns requested assets only
- `status` reports initialized and record count correctly
- invalid metadata returns structured validation errors

Fixture test:

- archive a sample raw project discussion
- verify preserved source, generated document, metadata, hashes, and SQLite index consistency

## Non-Goals

The MVP will not implement:

- automatic conversation capture
- automatic trigger decisions
- browser or terminal history scraping
- external model provider integration
- MCP-side LLM calls
- embeddings
- vector search
- LadybugDB or Kuzu integration
- Graph RAG
- global project registry
- export to `docs/`
- deduplication, merge, or version graph
- background file watching

## Future Extension Points

The archive format intentionally leaves room for later phases:

- add local lightweight embedding generation from `document.md`
- add vector and graph indexes from `metadata.json`
- add recall tools over archived records
- add export of selected documents into `docs/`
- add global registry for multiple projects
- add duplicate detection using stored hashes

These extensions should build on the stable record archive rather than changing the first-phase storage contract.
