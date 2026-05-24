---
name: docnexus-document-delete
description: Use when the user explicitly asks to permanently remove a current DocNexus managed document.
---

# DocNexus Document Delete

Use only for explicit destructive removal of a current managed document.

## Workflow

1. Identify exactly one target: a managed `file_path` or a document `id`.
2. Tell the user that deletion physically removes the managed Markdown file, current sidecars, chunks, embeddings, and graph-derived state, with no retained version.
3. Stop and ask the user to confirm permanent deletion.
4. Only after explicit confirmation run one command:

```bash
docnexus document delete --file <file_path> --force
docnexus document delete --id <document_id> --force
```

5. Report the deleted `id` and `file_path`.

## Constraints

- Never run a delete command without explicit user confirmation.
- Use exactly one of `--file` or `--id`.
- `--force` indicates the confirmation already occurred; it must not be used to bypass confirmation.
