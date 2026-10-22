---
name: docnexus-library
description: Browse DocNexus documents and saved related-page impact work, resume pending checks, classify documents, adopt reviewed edits or Git conflict resolutions, delete managed documents, or discard drafts.
---

# DocNexus Library

Run commands from the project root using `./.docnexus/node_modules/.bin/docnexus`. Do not change into `.docnexus/`; from another directory pass `--project-root <project>`.

Run `docnexus status` to read `workspace_path` and `library_path`; knowledge output is `<parent>/docnexus/`, where `init --output-dir <project-relative-parent>` selects the parent (default: project root). Paths below using `docnexus/library`, `docnexus/records`, `docnexus/concepts`, `docnexus/impacts` or `docnexus/CONCEPTS.md` illustrate the default output: substitute the configured workspace. Use returned artifact, library and timeline paths directly. Internal files always remain under `.docnexus/`.

Browse and curate what DocNexus holds.

For saved related-page work, follow [impact tracking](references/impacts.md): list pending and needs-review pages, read current evidence, then acknowledge progress with a fresh impact revision. Status updates do not change documents or authorize edits.

## Read

```bash
./.docnexus/node_modules/.bin/docnexus concepts [--type <entity_type>] [--query <text>] [--format md]
./.docnexus/node_modules/.bin/docnexus document list [--limit 50] [--tag <tag>]
./.docnexus/node_modules/.bin/docnexus document get --id <document_id> --include document,metadata
./.docnexus/node_modules/.bin/docnexus document get --id <document_id> --include template,metadata
./.docnexus/node_modules/.bin/docnexus document render
./.docnexus/node_modules/.bin/docnexus draft list [--status open|ready|ingested|invalid]
./.docnexus/node_modules/.bin/docnexus facts list [--entity <name-or-alias>] [--at <ISO-timestamp>] [--include-inactive]
```

- Present documents as `title` — `docnexus/library/<file_path>` with tags and `updated_at`.
- `--include` accepts any of `source,document,metadata,timeline,template`. `template` contains author-owned prose and fact placeholders; `document` contains the current generated view. No separate template file is stored.
- CLI `document get` defaults to the current body only. Request the other assets explicitly when needed, especially for history, source review or updates; they are not covered by the 4000-character refined-body limit.
- Generated fact blocks are read-only projections of metadata. Changing their text does not change a fact and is repaired on access. Edit the owner's facts through a reviewed draft or metadata sync; references in other pages refresh automatically. Render refreshes derived views without changing source history.
- Draft status: `open` (not sealed), `ready` (sealed, awaiting ingest), `ingested`, `invalid` (unreadable manifest).

## Query for a document viewer

```bash
./.docnexus/node_modules/.bin/docnexus document query --all
./.docnexus/node_modules/.bin/docnexus document query --page 1 --page-size 20
./.docnexus/node_modules/.bin/docnexus document query --category architecture --page 1 --page-size 20
node .docnexus/skills/docnexus-library/scripts/query-documents.mjs --all
```

The script is a thin adapter to the project's installed CLI. From another directory, start its arguments with `--project-root <project>`. It returns JSON on stdout; errors use stderr and a nonzero exit code.

- The query reads canonical text and renders current fact values in memory; it does not build retrieval indexes, load embedding models or rewrite memory. `documents[].document` is complete current Markdown, suitable for a viewer. Treat it as data; render raw HTML only through the viewer's sanitization policy.
- Each document has one primary `category` and `category_label`, plus tags. Classification is an orchestration judgment recorded in metadata during extraction/update. Legacy documents without a category show `uncategorized`; do not claim they were classified automatically by the script.
- Categories are project-defined names, explicitly selected by a user/calling skill for a write or otherwise chosen by the model. `categories[]` derives currently used categories and counts from metadata; `category_reason` explains the document's classification. Preserve a caller-selected category during the same capture pipeline. `init` writes an editable `docnexus/categories.md` starter list; it is guidance, not a registry, and editing it does not reclassify documents. Legacy ids retain display labels for compatibility; they are not an allow-list. `total` counts the selected category and `total_documents` counts all documents.
- `--all` returns every matching document with `pagination: null`. Otherwise page numbers start at 1, default page size is 20 and maximum is 100. Documents sort by file path, independent of update time.
- After a write/update/delete, fetch a fresh first page. Pass its `revision` to later pages using `--revision <hash>`. On `document_revision_changed`, discard accumulated pages and restart; revisions detect changes, not retained historical snapshots. Effective fact activation/expiry also changes the revision.
- The response includes attributed facts with statuses. Only active facts support current claims; avoid displaying raw historical facts as current truth. For document history use the separate `document get` command.
- For context-based classification, renaming, merging or splitting groups, read [contextual classification](references/classification.md). Use `document classify --id <id> --category <name> --reason <basis> [--revision <snapshot>]` for category-only edits within existing authorization. Keep facts, aliases, relationships and source content intact.

## Adopt hand edits

Users may edit `docnexus/library/<file_path>` directly. Until adopted, search and document reads report the edit; `status` lists its id under `records.edited`.

1. Use `document list` to identify the path and read the edited library file and `docnexus/records/<id>/metadata.json` directly. `document get` intentionally refuses unadopted edits.
2. Check whether title, summary, tags, entities, relationships or structured facts are now wrong. Preserve earlier fact ids and entries; use explicit replacements or withdrawals following `docnexus-extract`'s [fact lifecycle](../docnexus-extract/references/facts.md). If metadata needs updating, allocate a draft (`docnexus draft new --slug <topic>`), write the corrected `metadata.json` there, and validate it with `docnexus metadata validate --file <path>`.
3. Ensure the user has authorized adopting the reviewed edit, then run one of:

```bash
./.docnexus/node_modules/.bin/docnexus document sync --id <document_id>
./.docnexus/node_modules/.bin/docnexus document sync --id <document_id> --metadata-file .docnexus/drafts/<draft_id>/metadata.json
```

4. Report `id`, `library_path`, and `metadata_updated`. The original `source.md` is kept unchanged.

## Resolve Git merge conflicts

For Git pull conflicts, use the [Git merge recovery workflow](references/git-merge.md). Enable `docnexus git hooks install` once, resolve and stage content using Git or the editor, then wait for automatic record repair before committing. Ordinary hand-edit sync cannot repair conflicted records.

## Delete a document

1. Resolve exactly one target by `id` or `file_path`; use `document list` if the user described it loosely.
2. Tell the user deletion permanently removes `docnexus/library/<file_path>`, its source, metadata, record, entire timeline and derived database entries.
3. If the user has not already explicitly confirmed deleting this target, ask. With authorization, run one of:

```bash
./.docnexus/node_modules/.bin/docnexus document delete --id <document_id> --force
./.docnexus/node_modules/.bin/docnexus document delete --file <file_path> --force
```

4. Report the deleted `id` and `file_path`.

Deletion is refused if it would leave a Markdown fact reference, another fact's replacement reference or entity identity unresolved, or revive a predecessor by removing cross-document replacement history. Prefer preserving a historical fact's owner and removing obsolete prose through a reviewed update. Do not remove replacement references merely to bypass the check.

## Discard a draft

Drafts are disposable but may hold unsaved work. Confirm with the user, then:

For ingested drafts with `impact.json`, confirm its impact check was registered before discarding the attachment. A successful primary ingestion does not prove impact registration; retain/report pending attachments until saved or the user explicitly chooses to discard that work.

```bash
./.docnexus/node_modules/.bin/docnexus draft discard --id <draft_id> --force
```

Offer to discard `ingested` drafts when the user asks to tidy up.

## Constraints

- `--force` records a confirmation that already happened; use it only when the user has authorized that action.
- To change a document's content, run the capture pipeline with the same `file_path` instead of editing the library file.
