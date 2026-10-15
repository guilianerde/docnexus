---
name: docnexus-ingest
description: Use when the user asks DocNexus to save, store, or add a sealed draft to project memory, or when the docnexus capture pipeline reaches its ingest stage.
---

# DocNexus Ingest

Stage 3 of the capture pipeline. Stores one sealed draft as a managed document in `docnexus/library/` and appends a source-attributed timeline event in a single command.

Use the sealed metadata category exactly, including categories selected explicitly by a user or calling skill. Do not run classification or pass a category override to `document add`. To change the category before ingestion, return to `draft seal --category <name>`, then review the updated metadata before saving. Existing version and overwrite checks still apply.

## Workflow

1. Identify the draft. Use the `draft_id` handed over by `docnexus-extract`; otherwise list candidates:

```bash
./node_modules/.bin/docnexus draft list --status ready
```

   If several drafts are ready and the user did not name one, ask which to ingest. If none is ready, run `docnexus-extract` first.
2. Ingest:

```bash
./node_modules/.bin/docnexus document add --draft <draft_id>
```

3. If the path is already managed, ensure the user explicitly authorized replacing that `file_path` after seeing the proposed current document. Ask only when that authorization is missing. Then run:

```bash
./node_modules/.bin/docnexus document add --draft <draft_id> --replace
```

4. If the target changed since sealing, reread its current document/template, metadata and timeline. Merge those changes with the draft, preserving still-valid knowledge and user classification corrections, then seal and review again. Resealing old content alone would discard the newer knowledge. A newly occupied path or a deleted/recreated target also requires a fresh review; `--replace` does not bypass the version check. Pending format-1/2 draft manifests require rereading, merging and resealing as format 3; stored documents remain format 6.
   If the draft or its referenced facts changed after sealing, read the changes and seal again. For a fact-backed document, review the generated `preview.md` before ingestion; show materially changed conclusions when existing authorization does not cover them. The CLI checks the sealed preview hash against current effective facts.
5. Memory files and the draft's ingested receipt are covered by one recoverable text transaction. The next CLI access completes an interrupted transaction before reading memory. Derived vectors and graph projections are synchronized by the next recall or `docnexus index sync`; this does not add another timeline event. If a command was interrupted, inspect the draft status before retrying ingestion.
6. Report `id`, `library_path`, `operation`, and `timeline_path`. The draft is now marked `ingested` and cannot be ingested again.

## Constraints

- Never pass `--replace` without the user's explicit confirmation of the overwrite.
- Never copy files into `docnexus/library/` or `docnexus/records/` yourself; the CLI owns them.
- If the CLI reports `managed target was externally modified`, the user edited the library file by hand. Stop, tell the user, and offer `docnexus-library` → *Adopt hand edits* before replacing it; never overwrite their edit silently.
