# DocNexus

[中文说明](./README.zh-CN.md)

DocNexus is a local project-memory service for coding agents such as Codex and Claude. An agent refines selected source material, stores one current managed Markdown document per project path, and recalls structured Graph RAG context with cited files.

DocNexus is inspired by the agent-facing workflow style of [GitNexus](https://github.com/abhigyanpatwari/GitNexus). It is focused on manual triggering, project-local storage, one globally registered MCP server, and bundled skills.

## Capabilities

- `docnexus-document-extract` refines selected material into a proposed document and metadata without storing it.
- `docnexus-document-add` creates or updates a recallable managed document through CLI, confirming before replacement.
- `docnexus-document-delete` performs confirmed physical removal through CLI.
- `docnexus-recall` invokes CLI retrieval and answers from document-grouped context with file references.
- MCP exposes current document reads, metadata validation, and status tools for agents.
- CLI exposes project initialization, runtime diagnostics, skill installation, document mutation, retrieval, index maintenance, graph audit/repair, and reset.
- Embeddings run locally with `BAAI/bge-small-zh-v1.5` by default and are loaded in local-only mode.
- LadybugDB stores current graph/vector state; SQLite stores current managed document and chunk state.

DocNexus does not call an LLM provider. Document refinement and final answers remain agent responsibilities.

## Architecture

```text
Agent / User
  |
  | manual document or recall skill
  v
Skills
  - extract document + metadata
  - add/delete confirmed managed documents
  - answer from grouped recall context
  |
  v
Global MCP service                 CLI
  - explicit project_root          - recall / maintenance / reset
  - read / validate / status       - document add / delete
  |                                |
  +---------------+----------------+
                  v
Project-local .docnexus/
  - SQLite documents + file_chunks
  - LadybugDB graph/vector state
  - current source and metadata sidecars
```

## Install And Initialize

Requirements: Node.js 22.13.0 or newer and npm. This is the first Node.js release where `node:sqlite` works without an experimental startup flag.

Install the executable once:

```bash
npm install -g @docnexus/docnexus
```

Initialize each project independently and install skills where needed:

```bash
cd /path/to/your-project
docnexus init
docnexus doctor
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
| `list_records` | List current managed documents, optionally filtered by tag. |
| `get_record` | Read a current document's source, Markdown, and/or metadata. |
| `status` | Report current managed document storage status. |
| `validate_metadata` | Validate prepared metadata before CLI storage. |
| `index_status` | Report current document and chunk counts. |

The retained `list_records` and `get_record` names refer to current state only. No previous document versions are retained. Document writes and deletion are CLI operations driven by explicit skills.

## Document And Recall Workflow

Document extraction and storage are manually requested:

1. `/docnexus-document-extract` prepares `source`, refined `document`, structured `metadata`, and a proposed project-relative Markdown `file_path`; it does not persist anything.
2. Metadata may be validated through MCP.
3. `/docnexus-document-add` runs CLI storage and indexing. Metadata must include at least one source-grounded entity. If the path is already managed, it asks for confirmation before issuing `--replace`.
4. `/docnexus-document-delete` asks for destructive confirmation and then runs CLI physical deletion.

Recall is manually requested:

```bash
docnexus recall "local embedding and LadybugDB" --limit 5
```

Recall returns vector-ranked `results[]` and document-level `context_groups[]`. Each group is keyed by its current `document_id`, references its managed file path, and may include bounded neighboring chunks and one-hop graph supporting evidence. Metadata and graph context are required; every stored document must declare at least one entity, and recall does not provide a reduced fallback response.

## CLI Commands

Run commands in an initialized project unless stated otherwise:

```bash
docnexus document add --file docs/memory/auth.md --source-file /tmp/source.md --document-file /tmp/auth.md --metadata-file /tmp/metadata.json
docnexus document add --file docs/memory/auth.md --source-file /tmp/source.md --document-file /tmp/auth.md --metadata-file /tmp/metadata.json --replace
docnexus doctor
docnexus embeddings install --from /path/to/BAAI/bge-small-zh-v1.5
docnexus embeddings install --from /path/to/BAAI/bge-small-zh-v1.5 --replace
docnexus index status
docnexus index rebuild --force
docnexus graph audit
docnexus graph repair --force
docnexus recall "query" --limit 5
```

`index rebuild --force` is maintenance only: it rebuilds current derived state from registered managed documents and their current sidecars. It does not import unmanaged files.

`--replace` is required for an existing managed path and is used only after the user confirms replacement. Delete a managed document by path or ID after confirmation:

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

To prevent path escape, document creation, deletion, and current-format reset reject managed target paths containing symbolic links and enforce containment against the project's real path.

## Storage Layout

```text
docs/memory/auth.md                  # current managed Markdown example
.docnexus/
  project.json                       # format version marker
  index.sqlite                       # documents + file_chunks
  store.lbug                         # current graph/vector state
  models/                            # optional project-local model override assets
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

DocNexus configures Transformers.js with `local_files_only` and disables remote model loading. The npm package includes the quantized ONNX assets under `models/BAAI/bge-small-zh-v1.5/`, so users download the default model with the package. At runtime DocNexus looks for a project override in `.docnexus/models/` first, then falls back to the packaged `models/` directory. A normal install does not require `docnexus embeddings install`.

To override the packaged model, install a prepared local Transformers.js model directory into the current project:

```bash
docnexus embeddings install --from /path/to/BAAI/bge-small-zh-v1.5
```

The source directory must contain `config.json`, `tokenizer.json`, and the q8 asset `onnx/model_quantized.onnx`. Reinstalling over an existing project model requires `--replace`.

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
- Runtime diagnostics through `docnexus doctor`.
- Project-local embedding model asset installation.
- Skill-driven refinement and conversation recall.
- Single-version current managed document storage and physical deletion/reset.
- Local embeddings, LadybugDB vector/graph recall, grouped Graph RAG context.
- CLI rebuild, graph audit, and graph repair maintenance.

Not implemented:

- Automatic capture or file watching.
- External model provider integration.
- MCP-side final answer generation.
- Deeper multi-hop graph reasoning.

See the [documentation center](./docs/README.md) for the architecture, product brief, release guide, and [prioritized roadmap](./docs/roadmap/current.zh-CN.md).
