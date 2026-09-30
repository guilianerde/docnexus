---
name: docnexus
description: Entry point for DocNexus project memory. Use when the user asks DocNexus to remember, capture, save, recall, search, list, show, sync, delete, or check the health of project memory, or when a project task should be grounded in memory; routes the request to the matching DocNexus workflow skill.
---

# DocNexus

DocNexus keeps curated project memory in the `docnexus/` folder of this project and recalls it as grouped Graph RAG context. This skill decides which workflow runs; the workflow skills perform the steps.

Run every command from the project root with `./node_modules/.bin/docnexus`. Never use a global CLI or another repository's build.

## Workspace

```text
docnexus/
  CONCEPTS.md   generated concept index — load it to know what memory covers
  skills/       project skills (this file lives in skills/docnexus/)
  drafts/       extraction drafts; manifest.json marks a sealed draft
  library/      managed Markdown documents (the curated output)
  records/<id>/ source.md, metadata.json, record.json — the text source of truth
  schemas/      metadata.schema.json
  store/        derived index and graph, rebuilt from records (git-ignored)
```

Agents write only inside drafts. Users may edit `library/` files by hand; such edits are adopted with `document sync`. Never edit `records/` or `store/`.

## Working with memory

Memory is used proactively, not only on request:

1. At the start of a project task, read `docnexus/CONCEPTS.md` (it may already be loaded through CLAUDE.md or AGENTS.md). It is small: concept names, one-line descriptions, and the documents that define them.
2. If the task touches a listed concept, a documented decision, or a component you are about to change, run `docnexus-recall` yourself before planning or editing. Do not ask the user for permission; recall is read-only.
3. When the work produces a decision, convention, or explanation worth keeping, offer to capture it. Capture only after the user agrees.

## Preflight

Run once per conversation before the first DocNexus command:

```bash
./node_modules/.bin/docnexus status
```

- Not initialized → tell the user to run `./node_modules/.bin/docnexus init --agent claude` (or `codex`) and stop.
- Unsupported format → tell the user to run `./node_modules/.bin/docnexus reset --force` then `init`. Never run reset yourself without explicit confirmation.
- `index.in_sync` is false (for example after `git pull`) → run `./node_modules/.bin/docnexus index sync`. It only rebuilds derived state; no confirmation is needed. (`recall` also does this automatically.)
- `index.edited_library_files` is not empty → the user edited library files by hand. Tell them and offer `docnexus-library` → *Adopt hand edits*.
- `drafts.ready > 0` → mention that sealed drafts are waiting for ingestion.

## Routing

| User intent | Workflow |
| --- | --- |
| Remember, save, capture, or document material into memory | **Capture pipeline** below |
| Only extract or refine material, without saving yet | `docnexus-extract` |
| Save an existing sealed draft | `docnexus-ingest` |
| Ask a question from memory, recall, search; or a task touches a known concept | `docnexus-recall` |
| List concepts or documents, show, adopt hand edits, delete a document, discard a draft | `docnexus-library` |
| Health check, index or graph problems, sync after git pull, rebuild, repair, reset | `docnexus-maintain` |

When the intent is unclear, ask one short question instead of guessing.

## Capture pipeline

Each stage has one owner and one hand-off artifact:

1. **Extract** (`docnexus-extract`): write `source.md`, `document.md`, `metadata.json` into a new draft and seal it. Hand-off: `draft_id`, `file_path`, `replaces_managed_document`.
2. **Review**: show the user the proposed `file_path`, title, summary, tags, and entity names. Skip this pause only when the user already asked to save without review.
3. **Ingest** (`docnexus-ingest`): store the sealed draft. If `replaces_managed_document` is true, ask for overwrite confirmation first.
4. **Report**: the document `id`, `library_path`, `operation`, and `chunk_count`. `CONCEPTS.md` is regenerated automatically.

Stop the pipeline at the first failed stage and report which stage failed; never skip ahead.

## Hard rules

- Destructive or overwriting actions (`--replace`, `document sync`, `document delete`, `draft discard`, `reset`, `index rebuild`, `graph repair`) need the user's explicit confirmation in this conversation. `--force` records that confirmation; it never replaces it.
- Read-only commands (`status`, `concepts`, `recall`, `document list/get`, `draft list`, `doctor`) and `index sync` may run without asking.
- Keep every input file inside the project. Cite memory as `docnexus/library/<file_path>`.
- Do not invent facts, entities, or relationships absent from the source or from recalled context.
