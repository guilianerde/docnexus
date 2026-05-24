# DocNexus

[中文说明](./README.zh-CN.md)

DocNexus is a local project-memory service for coding agents such as Codex and Claude. An agent refines selected source material, stores one current managed Markdown document per project path, and recalls structured Graph RAG context with cited files.

DocNexus is inspired by the agent-facing workflow style of [GitNexus](https://github.com/abhigyanpatwari/GitNexus). It is focused on manual triggering, project-local storage, one globally registered MCP server, and bundled skills.

## Capabilities

- `docnexus-capture` refines source and metadata before one MCP write creates or updates a recallable managed document.
- `docnexus-recall` invokes CLI retrieval and answers from document-grouped context with file references.
- MCP exposes storage, metadata validation, deletion, and status tools for agents.
- CLI exposes project initialization, skill installation, retrieval, index maintenance, graph audit/repair, destructive document deletion, and reset.
- Embeddings run locally with `BAAI/bge-small-zh-v1.5` by default.
- LadybugDB stores current graph/vector state; SQLite stores current managed document and chunk state.

DocNexus does not call an LLM provider. Document refinement and final answers remain agent responsibilities.

## Architecture

```text
Agent / User
  |
  | manual capture or recall skill
  v
Skills
  - refine source into current document + metadata
  - answer from grouped recall context
  |
  v
Global MCP service                 CLI
  - explicit project_root          - recall / maintenance / reset
  - current document CRUD          |
  |                                |
  +---------------+----------------+
                  v
Project-local .docnexus/
  - SQLite documents + file_chunks
  - LadybugDB graph/vector state
  - current source and metadata sidecars
```

## Install And Initialize

Requirements: Node.js with `node:sqlite` support and npm.

Install the executable once:

```bash
npm install -g @docnexus/docnexus
```

Initialize each project independently and install skills where needed:

```bash
cd /path/to/your-project
docnexus init
docnexus skills install --target codex
docnexus skills install --target claude
```

Without a global installation:

```bash
npx -y @docnexus/docnexus init
npx -y @docnexus/docnexus skills install --target codex
```

Each initialized project owns its own `.docnexus/` data domain. Data, embeddings, and graph state are not shared across projects.

## Register MCP Once

The MCP process is started on demand by the client. Every tool invocation must provide the absolute initialized `project_root`.

Codex:

```bash
codex mcp add docnexus -- docnexus mcp
```

```toml
[mcp_servers.docnexus]
command = "docnexus"
args = ["mcp"]
```

Claude Code:

```bash
claude mcp add --transport stdio docnexus -- docnexus mcp
```

```json
{
  "mcpServers": {
    "docnexus": {
      "command": "docnexus",
      "args": ["mcp"]
    }
  }
}
```

## MCP Tools

| Tool | Purpose |
| --- | --- |
| `archive_record` | Create or overwrite one current managed Markdown document and immediately index it. |
| `list_records` | List current managed documents, optionally filtered by tag. |
| `get_record` | Read a current document's source, Markdown, and/or metadata. |
| `status` | Report current managed document storage status. |
| `validate_metadata` | Validate metadata before storage. |
| `delete_document` | Physically delete a managed file and derived state; requires `confirm: true`. |
| `index_status` | Report current document and chunk counts. |

The retained `archive_record`, `list_records`, and `get_record` names refer to current state only. No previous document versions are retained.

Example create or update call:

```json
{
  "project_root": "/absolute/path/to/your-project",
  "file_path": "docs/memory/auth.md",
  "source": "Original selected material",
  "document": "# Authentication\n\nCurrent refined decision.",
  "metadata": {
    "title": "Authentication",
    "summary": "Current authentication decisions.",
    "tags": ["auth"],
    "entities": [],
    "relationships": []
  }
}
```

A subsequent write to the same managed `file_path` replaces its source, document, metadata, chunks, embeddings, and graph state.

## Capture And Recall Workflow

Capture is manually requested:

1. The agent uses `docnexus-capture` to prepare `source`, refined `document`, and structured `metadata`.
2. The agent chooses a project-relative target Markdown `file_path`.
3. Metadata is validated through MCP.
4. One `archive_record` call writes the current target document, current sidecars, chunks, embeddings, and LadybugDB graph state.

Recall is manually requested:

```bash
docnexus recall "local embedding and LadybugDB" --limit 5
```

Recall returns vector-ranked `results[]` and document-level `context_groups[]`. Each group is keyed by its current `document_id`, references its managed file path, and may include bounded neighboring chunks and one-hop graph supporting evidence. Metadata and graph context are required; recall does not provide a reduced fallback response.

## CLI Commands

Run commands in an initialized project unless stated otherwise:

```bash
docnexus index status
docnexus index rebuild --force
docnexus graph audit
docnexus graph repair --force
docnexus recall "query" --limit 5
```

`index rebuild --force` is maintenance only: it rebuilds current derived state from registered managed documents and their current sidecars. It does not import unmanaged files.

Delete a managed document by path or ID:

```bash
docnexus document delete --file docs/memory/auth.md --force
docnexus document delete --id doc_0000000000000000 --force
```

Deletion physically removes the managed project Markdown file, its current sidecars, SQLite row/chunks, and LadybugDB document/chunk state. There is no retained per-document deletion log.

Reset the DocNexus data domain:

```bash
docnexus reset --force
docnexus init
```

For a current-format project, reset removes all registered managed target files and the complete `.docnexus/` directory. For an old or unreadable store, reset removes `.docnexus/` only because ownership of external target files cannot be determined safely.

## Storage Layout

```text
docs/memory/auth.md                  # current managed Markdown example
.docnexus/
  project.json                       # format version marker
  index.sqlite                       # documents + file_chunks
  store.lbug                         # current graph/vector state
  documents/
    <document_id>/
      source.md                      # current source only
      metadata.json                  # current metadata only
  schemas/
    metadata.schema.json
```

One `file_path` identifies one current document. Updates replace state in place; no history or independent unmanaged indexing is supported.

## Embeddings And Graph Maintenance

Default local model:

```text
BAAI/bge-small-zh-v1.5
```

For deterministic tests:

```bash
DOCNEXUS_EMBEDDER=hash npm test
```

`docnexus graph audit` reports drift between current SQLite documents and LadybugDB. `docnexus graph repair --force` removes stale graph documents and orphan concepts and rebuilds the vector index. Use `docnexus index rebuild --force` to recreate missing or inconsistent current document graph/chunk state.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
node dist/src/cli.js mcp
```

## Current Scope

Implemented:

- Scoped npm distribution and per-project initialization.
- One global MCP registration with explicit `project_root` per call.
- Skill-driven refinement and conversation recall.
- Single-version current managed document storage and physical deletion/reset.
- Local embeddings, LadybugDB vector/graph recall, grouped Graph RAG context.
- CLI rebuild, graph audit, and graph repair maintenance.

Not implemented:

- Automatic capture or file watching.
- External model provider integration.
- MCP-side final answer generation.
- Deeper multi-hop graph reasoning.
