# DocNexus Product Brief (MVP)

DocNexus is a local project-memory service for agents such as Codex and Claude. Skills perform intelligent refinement and answer generation; CLI persists managed documents and provides recall and maintenance commands; MCP supplies read, validation, and status tools. Workflows are manually triggered.

## Product Contract

- MCP never invokes an LLM. The agent produces `source`, refined Markdown `document`, and structured `metadata`.
- One project-relative `file_path` identifies one current managed document.
- `docnexus document add` creates or overwrites that document and immediately synchronizes chunks, local embeddings, and LadybugDB graph/vector state.
- Rewriting the same managed path replaces current state; prior versions are not retained.
- Updating a managed path requires user confirmation in `/docnexus-document-add` and explicit CLI `--replace`.
- `/docnexus-document-delete` confirms removal before `docnexus document delete ... --force` physically removes the managed file and all derived state.
- `docnexus reset --force` clears current-format managed files plus `.docnexus/`; old or damaged data domains lose `.docnexus/` only.
- `docnexus index rebuild --force` maintains existing managed documents only; it is not an ingest route.

## Deployment And Isolation

```bash
npm install -g @docnexus/docnexus
cd /path/to/project
docnexus init
docnexus skills install --target codex
```

Register the MCP server once:

```bash
codex mcp add docnexus -- docnexus mcp
```

Every MCP tool invocation must include an absolute initialized `project_root`. Each project stores its own SQLite and LadybugDB state under `.docnexus/`.

## Agent Workflow

1. `/docnexus-document-extract` prepares the source, refined document, metadata, and a proposed managed `file_path` without persisting state.
2. `/docnexus-document-add` validates inputs and runs `docnexus document add`; existing managed paths require confirmed `--replace`.
3. CLI writes the target Markdown, current sidecars, SQLite document/chunks, embeddings, and graph data.
4. `docnexus-recall` runs CLI recall and receives vector-ranked `results[]` plus document-grouped `context_groups[]`.
5. The agent answers using the grouped chunks and bounded graph context, citing managed file paths.

## Storage

```text
<managed file_path>.md
.docnexus/
  project.json
  index.sqlite                  # documents + file_chunks
  store.lbug
  documents/<document_id>/
    source.md
    metadata.json
  schemas/metadata.schema.json
```

Metadata and graph state are required for recall. Automatic capture, file watching, provider-hosted LLM integration, MCP-side answer generation, and deeper multi-hop reasoning are outside the current MVP.
