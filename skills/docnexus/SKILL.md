---
name: docnexus
description: Entry point for DocNexus project memory. Use when the user asks DocNexus to remember, capture, save, recall, search, list, show, delete, or check the health of project memory; routes the request to the matching DocNexus workflow skill.
---

# DocNexus

DocNexus keeps curated project memory in the visible `docnexus/` folder of this project and recalls it as grouped Graph RAG context. This skill decides which workflow runs; the workflow skills perform the steps.

Run every command from the project root with `./node_modules/.bin/docnexus`. Never use a global CLI or another repository's build.

## Workspace

```text
docnexus/
  skills/     project skills (this file lives in skills/docnexus/)
  drafts/     extraction drafts; manifest.json marks a sealed draft
  library/    managed Markdown documents (the curated output)
  schemas/    metadata.schema.json
  store/      SQLite ledger, LadybugDB graph, sidecars, optional models
```

Never edit `docnexus/library/` or `docnexus/store/` by hand. Drafts are the only files an agent writes directly.

## Preflight

Run once per conversation before the first workflow:

```bash
./node_modules/.bin/docnexus status
```

- Not initialized → tell the user to run `./node_modules/.bin/docnexus init --agent claude` (or `codex`) and stop.
- Unsupported format → tell the user to run `./node_modules/.bin/docnexus reset --force` then `init`. Never run reset yourself without explicit confirmation.
- `drafts.ready > 0` → mention that sealed drafts are waiting for ingestion.

## Routing

| User intent | Workflow |
| --- | --- |
| Remember, save, capture, or document material into memory | **Capture pipeline** below |
| Only extract or refine material, without saving yet | `docnexus-extract` |
| Save an existing sealed draft | `docnexus-ingest` |
| Ask a question from memory, recall, search | `docnexus-recall` |
| List or show documents or drafts, delete a document, discard a draft | `docnexus-library` |
| Health check, index or graph problems, rebuild, repair, reset, model override | `docnexus-maintain` |

When the intent is unclear, ask one short question instead of guessing. Recall is never automatic: use it only when the user asks DocNexus.

## Capture pipeline

The default for "remember this" requests. Each stage has one owner and one hand-off artifact:

1. **Extract** (`docnexus-extract`): write `source.md`, `document.md`, `metadata.json` into a new draft and seal it. Hand-off: `draft_id`, `file_path`, `replaces_managed_document`.
2. **Review**: show the user the proposed `file_path`, title, summary, tags, and entity names. Skip this pause only when the user already asked to save without review.
3. **Ingest** (`docnexus-ingest`): store the sealed draft. If `replaces_managed_document` is true, ask for overwrite confirmation first.
4. **Report**: the document `id`, `library_path`, `operation`, and `chunk_count`.

Stop the pipeline at the first failed stage and report which stage failed; never skip ahead.

## Hard rules

- Destructive actions (`--replace`, `document delete`, `draft discard`, `reset`, `index rebuild`, `graph repair`) need the user's explicit confirmation in this conversation. `--force` records that confirmation; it never replaces it.
- Keep every input file inside the project. Cite memory as `docnexus/library/<file_path>`.
- Do not invent facts, entities, or relationships absent from the source or from recalled context.
