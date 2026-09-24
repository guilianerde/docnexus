# DocNexus Product Brief (MVP)

DocNexus is a local project-memory service for agents such as Codex and Claude. Skills perform intelligent refinement and answer generation; CLI persists managed documents and provides recall and maintenance commands; CLI supplies read, validation, and status commands. Workflows are manually triggered.

## Product Contract

- CLI never invokes an LLM. The agent produces `source`, refined Markdown `document`, and structured `metadata`.
- Metadata must include at least one source-grounded entity; CLI validation and persistence enforce the same rule.
- One project-relative `file_path` identifies one current managed document.
- Managed targets must remain within the project's `.docnexus/` directory and may not contain symbolic links; creation, deletion, and reset share this boundary.
- `./node_modules/.bin/docnexus document add` creates or overwrites that document and immediately synchronizes chunks, local embeddings, and LadybugDB graph/vector state.
- Rewriting the same managed path replaces current state; prior versions are not retained.
- Updating a managed path requires user confirmation in `/docnexus-document-add` and explicit CLI `--replace`.
- `/docnexus-document-delete` confirms removal before `./node_modules/.bin/docnexus document delete ... --force` physically removes the managed file and all derived state.
- `./node_modules/.bin/docnexus reset --force` clears current-format managed files plus `.docnexus/`; old or damaged data domains lose `.docnexus/` only.
- `./node_modules/.bin/docnexus index rebuild --force` maintains existing managed documents only; it is not an ingest route.
- `./node_modules/.bin/docnexus doctor` checks Node/SQLite, project initialization, SQLite schema, LadybugDB vector index health, and local embedding availability.
- `./node_modules/.bin/docnexus embeddings install --from <model-dir>` is an optional override route for copying prepared Transformers.js model assets into the current project's `.docnexus/models/`.

## Deployment and isolation

Install the npm dependency and skills in each target project:

```bash
npm install --save-dev @rowansenne/docnexus
./node_modules/.bin/docnexus init
./node_modules/.bin/docnexus skills install --target codex
```

Each project stores SQLite, LadybugDB, drafts, managed documents, and sidecars under `.docnexus/`, and skills under `.agents/skills/` or `.claude/skills/`. No MCP registration is needed.

## Agent Workflow

1. `/docnexus-document-extract` validates metadata and writes a complete draft bundle under `.docnexus/drafts/<draft_id>/`, reporting success only after `source.md`, `document.md`, `metadata.json`, and `manifest.json` are verified.
2. `/docnexus-document-add` consumes the verified draft manifest and runs `./node_modules/.bin/docnexus document add`; existing managed paths require confirmed `--replace`.
3. CLI writes the target Markdown, current sidecars, SQLite document/chunks, embeddings, and graph data.
4. `docnexus-recall` runs CLI recall and receives vector-ranked `results[]` plus document-grouped `context_groups[]`.
5. The agent answers using the grouped chunks and bounded graph context, citing managed file paths.

## Storage

```text
.docnexus/
  <managed file_path>.md
  drafts/<draft_id>/
    source.md
    document.md
    metadata.json
    manifest.json
  project.json
  index.sqlite                  # documents + file_chunks
  store.lbug
  models/
  documents/<document_id>/
    source.md
    metadata.json
  schemas/metadata.schema.json
```

Metadata and graph state are required for recall. Embeddings load the packaged quantized ONNX assets for `BAAI/bge-small-zh-v1.5` in local-only mode by default; runtime checks project `.docnexus/models/` overrides before package `models/`. Automatic capture, file watching, provider-hosted LLM integration, CLI-side answer generation, and deeper multi-hop reasoning are outside the current MVP.
