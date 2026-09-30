---
name: docnexus-ingest
description: Use when the user asks DocNexus to save, store, or add a sealed draft to project memory, or when the docnexus capture pipeline reaches its ingest stage.
---

# DocNexus Ingest

Stage 3 of the capture pipeline. Stores one sealed draft as a managed document in `docnexus/library/` and indexes it (chunks, embeddings, graph) in a single command.

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

3. If the CLI reports the path is already managed and requires `--replace`, stop. Tell the user which `file_path` would be overwritten and ask for confirmation. Only after explicit confirmation run:

```bash
./node_modules/.bin/docnexus document add --draft <draft_id> --replace
```

4. If the CLI reports that the draft changed after sealing, run `./node_modules/.bin/docnexus draft seal --id <draft_id> --file <file_path>` again, then retry.
5. Report `id`, `library_path`, `operation`, and `chunk_count`. The draft is now marked `ingested` and cannot be ingested again.

## Constraints

- Never pass `--replace` without the user's explicit confirmation of the overwrite.
- Never copy files into `docnexus/library/` or `docnexus/store/` yourself; the CLI owns them.
- If the CLI reports `managed target was externally modified`, stop and tell the user; do not overwrite their edit.
