# DocNexus Product Brief (MVP)

DocNexus is a local project-memory tool for agents such as Codex and Claude, driven entirely through skills. Skills make judgments and generate content (refinement, review, answers); the project-local CLI enforces verifiable contracts (draft sealing, ingestion, recall, maintenance). Workflows are manually triggered.

## Product Contract

- CLI never invokes an LLM. The agent produces `source`, refined Markdown `document`, and structured `metadata`.
- Everything DocNexus owns in a project lives in `docnexus/`: `skills/`, `drafts/`, `library/`, `schemas/`, `store/`. Agents write only inside the draft directory allocated by `draft new`.
- Metadata must include at least one source-grounded entity; `metadata validate`, `draft seal`, and persistence enforce the same rule.
- `draft seal` checks that the three artifacts are non-empty and the metadata is valid, records their hashes, and writes the manifest; editing after sealing makes ingestion fail.
- `document add --draft <id>` accepts only `ready` drafts, marks them `ingested`, and synchronizes chunks, local embeddings, and LadybugDB graph/vector state.
- One `file_path` (relative to `docnexus/library/`) identifies one current document. Updates replace it in place with no history; overwriting requires user confirmation and `--replace`.
- Managed paths and draft directories must stay inside `docnexus/` and may not contain symbolic links.
- `document delete ... --force` physically removes the library file and all derived state after confirmation.
- `reset --force` removes the whole `docnexus/` workspace and the skill links into it; a same-named folder without a DocNexus marker is refused.
- `index rebuild --force` maintains registered managed documents only; it is not an import route.
- `records/<id>/` (source, metadata, `record.json`) plus `library/` form the text source of truth; `store/` is derived, `index sync` rebuilds it entirely from text, and `recall` does so automatically when it is stale.
- Users may edit `library/` files by hand; `document sync` adopts the edit after confirmation and can refresh metadata.
- `CONCEPTS.md` is regenerated after every change; `init --agent` adds a block to `CLAUDE.md`/`AGENTS.md` so the agent loads the concept index and recalls on its own. Recall is read-only; writes still need consent.
- Skills carry a package version stamp and refresh automatically when it differs.
- `doctor` checks Node/SQLite, initialization, skills version and links, SQLite schema, index sync state, the LadybugDB vector index, and local embeddings.

## Deployment

```bash
npm install --save-dev @rowansenne/docnexus
./node_modules/.bin/docnexus init --agent claude
```

`init` creates the workspace and syncs skills; `--agent` links `.claude/skills/` or `.agents/skills/` entries to `docnexus/skills/`. No MCP or user-level installation is needed.

## Agent Workflow

1. `/docnexus` runs a `status` preflight and routes by intent.
2. Capture: `docnexus-extract` (`draft new` → write artifacts → `draft seal`) → user review → `docnexus-ingest` (`document add --draft`).
3. Recall: the agent decides on its own from `CONCEPTS.md`, or on request, runs `docnexus-recall`, works or answers from `context_groups[]`, and cites `docnexus/library/<path>`.
4. Library: `docnexus-library` lists, shows, and deletes documents and drafts.
5. Maintenance: `docnexus-maintain` diagnoses, then repairs, rebuilds, or resets as needed.

Metadata and graph state are required for recall. Embeddings load the packaged quantized ONNX assets for `BAAI/bge-small-zh-v1.5` in local-only mode, preferring a project override in `docnexus/store/models/`. Automatic capture, file watching, provider-hosted LLMs, CLI-side answer generation, and deeper multi-hop reasoning are outside the current MVP.
