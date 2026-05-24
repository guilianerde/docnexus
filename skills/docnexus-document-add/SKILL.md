---
name: docnexus-document-add
description: Use when the user explicitly asks to add or update an already prepared document in DocNexus memory.
---

# DocNexus Document Add

Use only for persisting prepared source, refined Markdown, metadata, and a project-relative `file_path`.

## Workflow

1. Confirm the target project is initialized with DocNexus.
2. Obtain the prepared `source`, `document`, `metadata`, and target `file_path`; create temporary artifact files when only conversation content is available.
3. For a proposed new managed path, run:

```bash
docnexus document add --file <file_path> --source-file <source_path> --document-file <document_path> --metadata-file <metadata_path>
```

4. If CLI reports that the path is already managed and requires `--replace`, stop and ask the user to confirm replacement. Only after explicit confirmation run:

```bash
docnexus document add --file <file_path> --source-file <source_path> --document-file <document_path> --metadata-file <metadata_path> --replace
```

5. Report the returned `id`, `file_path`, `operation`, and `chunk_count`.

## Constraints

- Never use `--replace` before the user has confirmed overwriting the current managed document.
- Never add an unmanaged existing project file as though it were a DocNexus document; choose a different path or resolve the conflict with the user.
- This command performs persistence, indexing, embedding, and graph update together. Do not call an independent index mutation route.
