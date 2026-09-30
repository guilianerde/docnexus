# DocNexus

[中文说明](./README.zh-CN.md)

DocNexus is a local project-memory tool for coding agents such as Codex and Claude, driven **entirely through skills**. The agent refines selected material; DocNexus stores it as managed Markdown inside the project's `docnexus/` workspace and recalls grouped Graph RAG context with cited files.

DocNexus is inspired by the agent-facing workflow style of [GitNexus](https://github.com/abhigyanpatwari/GitNexus) and focuses on manual triggering and project-local storage.

> 0.4.0 is a breaking release: the data folder moves from `.docnexus/` to `docnexus/`, the skills are reorganized, and older projects are not migrated. See [Skills workspace and orchestration](./docs/architecture/skills-workspace.zh-CN.md#4-破坏性变更与升级).

## Quick start

Node.js 22.13.0 or newer and npm are required. From the target project root:

```bash
npm install --save-dev @rowansenne/docnexus
./node_modules/.bin/docnexus init --agent claude   # or --agent codex / --agent all
./node_modules/.bin/docnexus doctor
```

Then use `/docnexus` in your agent: "remember this design note", "what does DocNexus say about auth?", "list DocNexus documents".

## Workspace

`init` creates `docnexus/` in the project. DocNexus skills, drafts, output, and derived data all live there:

```text
docnexus/
  project.json          # format marker
  skills/               # project skills (source of truth)
  drafts/<draft_id>/    # extraction drafts: source.md, document.md, metadata.json, manifest.json
  library/              # managed documents (readable output)
  schemas/              # metadata.schema.json
  store/                # index.sqlite, graph.lbug, sidecars, optional models/
```

`--agent` links `.claude/skills/` or `.agents/skills/` entries to `docnexus/skills/`; these links are the only DocNexus entries outside the workspace.

## Skill orchestration

| Skill | Use it for |
| --- | --- |
| `docnexus` | Entry point: preflight, intent routing, capture pipeline |
| `docnexus-extract` | Refine source material into a sealed draft |
| `docnexus-ingest` | Store a sealed draft in the library and index it |
| `docnexus-recall` | Answer from recalled context, citing `docnexus/library/` files |
| `docnexus-library` | List, show, or delete documents; list or discard drafts |
| `docnexus-maintain` | Diagnose, repair, rebuild, reset |

"Remember this" requests run the capture pipeline:

1. **Extract**: `draft new` allocates a draft → the agent writes three artifacts → `draft seal` validates metadata, records hashes, and writes the manifest.
2. **Review**: show the user the `file_path`, title, and entities.
3. **Ingest**: `document add --draft <id>`; an already managed path needs confirmation and `--replace`.
4. **Report**: `id`, `library_path`, and chunk count; the draft becomes `ingested`.

Every destructive action (`--replace`, delete, draft discard, rebuild, repair, reset) requires explicit confirmation in the conversation.

DocNexus never calls an LLM provider; refinement and final answers remain agent responsibilities.

## CLI commands

Skills call the project-local CLI; input files must resolve inside the project.

```bash
# Setup
./node_modules/.bin/docnexus init [--agent claude|codex|all]
./node_modules/.bin/docnexus skills sync
./node_modules/.bin/docnexus skills link --target claude|codex|all
./node_modules/.bin/docnexus doctor
./node_modules/.bin/docnexus status

# Capture
./node_modules/.bin/docnexus draft new --slug auth
./node_modules/.bin/docnexus metadata validate --file docnexus/drafts/<draft_id>/metadata.json
./node_modules/.bin/docnexus draft seal --id <draft_id> --file auth/token-rotation.md
./node_modules/.bin/docnexus document add --draft <draft_id> [--replace]
./node_modules/.bin/docnexus draft list [--status open|ready|ingested|invalid]
./node_modules/.bin/docnexus draft discard --id <draft_id> --force

# Recall
./node_modules/.bin/docnexus recall "local embedding and LadybugDB" --limit 5

# Library
./node_modules/.bin/docnexus document list [--limit 50] [--tag tag]
./node_modules/.bin/docnexus document get --id <document_id> --include source,document,metadata
./node_modules/.bin/docnexus document delete --file auth/token-rotation.md --force
./node_modules/.bin/docnexus document delete --id doc_0000000000000000 --force

# Maintenance
./node_modules/.bin/docnexus index status
./node_modules/.bin/docnexus index rebuild --force
./node_modules/.bin/docnexus graph audit
./node_modules/.bin/docnexus graph repair --force
./node_modules/.bin/docnexus embeddings install --from <model_dir> [--replace]
./node_modules/.bin/docnexus reset --force
```

- `file_path` is a Markdown path relative to `docnexus/library/`. One path is one current document; updates replace it in place with no history.
- Recall returns vector-ranked `results[]` and document-level `context_groups[]` with neighboring chunks and one-hop graph evidence. Every document must declare at least one entity; there is no reduced fallback.
- `index rebuild --force` only reprocesses registered managed documents; it never imports unmanaged files.
- Deletion removes the library file, sidecars, SQLite rows/chunks, and LadybugDB state.
- `reset --force` removes the whole `docnexus/` workspace and the skill links pointing into it; a same-named folder without a DocNexus marker is refused.
- Managed paths and draft directories reject symbolic links to keep writes inside `docnexus/`.

## Embeddings

The default local model is `BAAI/bge-small-zh-v1.5`, loaded with `local_files_only` and remote loading disabled. The quantized ONNX assets ship in the npm package; at runtime a project override in `docnexus/store/models/` wins over the packaged `models/`. Override directories must contain `config.json`, `tokenizer.json`, and `onnx/model_quantized.onnx`.

For deterministic tests:

```bash
DOCNEXUS_EMBEDDER=hash npm test
```

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

## Current scope

Implemented: project-local `docnexus/` workspace; an entry orchestration skill plus five workflow skills; CLI-managed draft sealing and ingestion; single-version managed documents with physical deletion and reset; local embeddings, LadybugDB vector/graph recall, and grouped context; doctor, rebuild, graph audit, and repair.

Not implemented: automatic capture or file watching, external model providers, CLI-side answer generation, deeper multi-hop graph reasoning.

See the [documentation center](./docs/README.md) for architecture, product brief, release guide, and roadmap.
