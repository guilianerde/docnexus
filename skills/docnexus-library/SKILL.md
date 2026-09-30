---
name: docnexus-library
description: Use when the user asks DocNexus to list concepts, list or show stored memory documents or drafts, adopt hand edits of library files, permanently delete a managed document, or discard a draft.
---

# DocNexus Library

Browse and curate what DocNexus holds.

## Read

```bash
./node_modules/.bin/docnexus concepts [--type <entity_type>] [--query <text>] [--format md]
./node_modules/.bin/docnexus document list [--limit 50] [--tag <tag>]
./node_modules/.bin/docnexus document get --id <document_id> --include document,metadata
./node_modules/.bin/docnexus draft list [--status open|ready|ingested|invalid]
```

- Present documents as `title` — `docnexus/library/<file_path>` with tags and `updated_at`.
- `--include` accepts any of `source,document,metadata`; request only what the user needs.
- Draft status: `open` (not sealed), `ready` (sealed, awaiting ingest), `ingested`, `invalid` (unreadable manifest).

## Adopt hand edits

Users may edit `docnexus/library/<file_path>` directly. Until adopted, the index keeps the old content and `status` lists the file under `index.edited_library_files`.

1. Read the edited file and its current metadata: `./node_modules/.bin/docnexus document get --id <id> --include metadata`.
2. Check whether title, summary, tags, entities, or relationships are now wrong. If they are, allocate a draft (`docnexus draft new --slug <topic>`), write the corrected `metadata.json` there, and validate it with `docnexus metadata validate --file <path>`.
3. Confirm with the user, then run one of:

```bash
./node_modules/.bin/docnexus document sync --id <document_id>
./node_modules/.bin/docnexus document sync --id <document_id> --metadata-file docnexus/drafts/<draft_id>/metadata.json
```

4. Report `id`, `library_path`, and `metadata_updated`. The original `source.md` is kept unchanged.

## Delete a document

1. Resolve exactly one target by `id` or `file_path`; use `document list` if the user described it loosely.
2. Tell the user deletion permanently removes `docnexus/library/<file_path>`, its sidecars, chunks, embeddings, and graph state, with no retained version.
3. Ask for confirmation. Only after explicit confirmation run one of:

```bash
./node_modules/.bin/docnexus document delete --id <document_id> --force
./node_modules/.bin/docnexus document delete --file <file_path> --force
```

4. Report the deleted `id` and `file_path`.

## Discard a draft

Drafts are disposable but may hold unsaved work. Confirm with the user, then:

```bash
./node_modules/.bin/docnexus draft discard --id <draft_id> --force
```

Offer to discard `ingested` drafts when the user asks to tidy up.

## Constraints

- `--force` records a confirmation that already happened; never use it to skip asking.
- To change a document's content, run the capture pipeline with the same `file_path` instead of editing the library file.
