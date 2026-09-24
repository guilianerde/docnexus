# DocNexus

[中文说明](./README.zh-CN.md)

DocNexus is a local project-memory service for coding agents such as Codex and Claude. An agent refines selected source material, stores one current managed Markdown document per project path, and recalls structured Graph RAG context with cited files.

DocNexus is inspired by the agent-facing workflow style of [GitNexus](https://github.com/abhigyanpatwari/GitNexus). It is focused on manual triggering, project-local storage, project-installed skills and a project-local CLI.

## Capabilities

- `docnexus-document-extract` writes a verified source/document/metadata draft bundle and completion manifest under `.docnexus/drafts/` without indexing it.
- `docnexus-document-add` creates or updates a recallable managed document through CLI, confirming before replacement.
- `docnexus-document-delete` performs confirmed physical removal through CLI.
- `docnexus-recall` invokes CLI retrieval and answers from document-grouped context with file references.
- CLI exposes project initialization, runtime diagnostics, skill installation, document mutation, retrieval, index maintenance, graph audit/repair, and reset.
- Embeddings run locally with `BAAI/bge-small-zh-v1.5` by default and are loaded in local-only mode.
- LadybugDB stores current graph/vector state; SQLite stores current managed document and chunk state.

DocNexus does not call an LLM provider. Document refinement and final answers remain agent responsibilities.

## Architecture and setup

Each project keeps its skills, runtime dependency, reference materials, drafts, outputs, SQLite database, and LadybugDB graph within its own directory. There is no MCP service or user-level skills installation. Node.js 22.13.0 or newer and npm are required.

```text
<project>/
  node_modules/@rowansenne/docnexus/   # project-installed CLI and bundled model
  .agents/skills/docnexus-*/          # Codex skills (optional)
  .claude/skills/docnexus-*/          # Claude skills (optional)
  .docnexus/                          # all persistent DocNexus data
    drafts/                           # source, refined document, metadata, manifest
    index.sqlite                      # document and chunk ledger
    store.lbug                        # graph and vector state
    documents/                        # current source and metadata sidecars
    models/                           # optional project model override
```

Run from each target project:

```bash
npm install --save-dev @rowansenne/docnexus
./node_modules/.bin/docnexus init
./node_modules/.bin/docnexus skills install --target codex
./node_modules/.bin/docnexus skills install --target claude
./node_modules/.bin/docnexus doctor
```

Install only the skill target you use. Existing `.docnexus/` projects keep their data; install the local package and project skills without resetting the store. Remove any old global DocNexus MCP registration separately in your agent client settings.

See the [project skills migration assessment](./docs/architecture/project-skills-migration.zh-CN.md) for tradeoffs and existing-project steps.

## Document And Recall Workflow

Document extraction and storage are manually requested:

1. `/docnexus-document-extract` validates metadata and writes `source.md`, `document.md`, `metadata.json`, and a completion `manifest.json` under a unique `.docnexus/drafts/<draft_id>/` directory.
2. Extraction reports `draft_created` only after all four files have been read back and verified; the proposed managed `file_path` remains in the manifest.
3. `/docnexus-document-add` runs CLI storage and indexing. Metadata must include at least one source-grounded entity. If the path is already managed, it asks for confirmation before issuing `--replace`.
4. `/docnexus-document-delete` asks for destructive confirmation and then runs CLI physical deletion.

Recall is manually requested:

```bash
./node_modules/.bin/docnexus recall "local embedding and LadybugDB" --limit 5
```

Recall returns vector-ranked `results[]` and document-level `context_groups[]`. Each group is keyed by its current `document_id`, references its managed file path, and may include bounded neighboring chunks and one-hop graph supporting evidence. Metadata and graph context are required; every stored document must declare at least one entity, and recall does not provide a reduced fallback response.

## CLI Commands

Run commands from the initialized project with its local CLI. Document input files must resolve inside that project:

```bash
./node_modules/.bin/docnexus document add --file docs/memory/auth.md --source-file .docnexus/drafts/example/source.md --document-file .docnexus/drafts/example/document.md --metadata-file .docnexus/drafts/example/metadata.json
./node_modules/.bin/docnexus document add --file docs/memory/auth.md --source-file .docnexus/drafts/example/source.md --document-file .docnexus/drafts/example/document.md --metadata-file .docnexus/drafts/example/metadata.json --replace
./node_modules/.bin/docnexus doctor
./node_modules/.bin/docnexus metadata validate --file .docnexus/drafts/example/metadata.json
./node_modules/.bin/docnexus document list
./node_modules/.bin/docnexus document get --id <document_id> --include source,document,metadata
./node_modules/.bin/docnexus status
./node_modules/.bin/docnexus embeddings install --from models/BAAI/bge-small-zh-v1.5
./node_modules/.bin/docnexus embeddings install --from models/BAAI/bge-small-zh-v1.5 --replace
./node_modules/.bin/docnexus index status
./node_modules/.bin/docnexus index rebuild --force
./node_modules/.bin/docnexus graph audit
./node_modules/.bin/docnexus graph repair --force
./node_modules/.bin/docnexus recall "query" --limit 5
```

`index rebuild --force` is maintenance only: it rebuilds current derived state from registered managed documents and their current sidecars. It does not import unmanaged files.

`--replace` is required for an existing managed path and is used only after the user confirms replacement. Delete a managed document by path or ID after confirmation:

```bash
./node_modules/.bin/docnexus document delete --file docs/memory/auth.md --force
./node_modules/.bin/docnexus document delete --id doc_0000000000000000 --force
```

Deletion physically removes the managed Markdown file under `.docnexus/`, its current sidecars, SQLite row/chunks, and LadybugDB document/chunk state. There is no retained per-document deletion log.

Reset the DocNexus data domain:

```bash
./node_modules/.bin/docnexus reset --force
./node_modules/.bin/docnexus init
```

For a current-format project, reset removes the complete `.docnexus/` directory, including all registered managed target files. For an old or unreadable store, reset likewise removes only `.docnexus/`.

To prevent path escape, document creation, deletion, and current-format reset reject managed target paths containing symbolic links and enforce containment within the project's `.docnexus/` directory.

## Storage Layout

```text
.docnexus/
  docs/memory/auth.md                # managed Markdown example (logical file_path omits .docnexus/)
  drafts/
    <draft_id>/
      source.md                      # extracted source artifact
      document.md                    # refined Markdown artifact
      metadata.json                  # validated metadata artifact
      manifest.json                  # written last; marks a complete draft
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

DocNexus configures Transformers.js with `local_files_only` and disables remote model loading. The npm package includes the quantized ONNX assets under `models/BAAI/bge-small-zh-v1.5/`, so users download the default model with the package. At runtime DocNexus looks for a project override in `.docnexus/models/` first, then falls back to the packaged `models/` directory. A normal install does not require `./node_modules/.bin/docnexus embeddings install`.

To override the packaged model, install a prepared local Transformers.js model directory into the current project:

```bash
./node_modules/.bin/docnexus embeddings install --from models/BAAI/bge-small-zh-v1.5
```

The source directory must contain `config.json`, `tokenizer.json`, and the q8 asset `onnx/model_quantized.onnx`. Reinstalling over an existing project model requires `--replace`.

For deterministic tests:

```bash
DOCNEXUS_EMBEDDER=hash npm test
```

`./node_modules/.bin/docnexus graph audit` reports drift between current SQLite documents and LadybugDB. `./node_modules/.bin/docnexus graph repair --force` removes stale graph documents and orphan concepts and rebuilds the vector index. Use `./node_modules/.bin/docnexus index rebuild --force` to recreate missing or inconsistent current document graph/chunk state.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

## Current Scope

Implemented:

- Scoped npm distribution and per-project initialization.
- Project-installed skills and CLI without MCP registration.
- Runtime diagnostics through `./node_modules/.bin/docnexus doctor`.
- Project-local embedding model asset installation.
- Skill-driven refinement and conversation recall.
- Single-version current managed document storage and physical deletion/reset.
- Local embeddings, LadybugDB vector/graph recall, grouped Graph RAG context.
- CLI rebuild, graph audit, and graph repair maintenance.

Not implemented:

- Automatic capture or file watching.
- External model provider integration.
- CLI-side final answer generation.
- Deeper multi-hop graph reasoning.

See the [documentation center](./docs/README.md) for the architecture, product brief, release guide, and [prioritized roadmap](./docs/roadmap/current.zh-CN.md).
