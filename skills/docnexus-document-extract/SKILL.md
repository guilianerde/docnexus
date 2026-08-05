---
name: docnexus-document-extract
description: Use when the user explicitly asks to extract or refine source material into a DocNexus managed-document draft.
---

# DocNexus Document Extract

Use only when the user explicitly requests DocNexus document extraction or refinement. This workflow must persist a reviewable draft bundle under `.docnexus/drafts/`; it does not store or index it as a managed document.

## Workflow

1. Confirm the target project is initialized with DocNexus.
2. Identify the requested original content or named source file.
3. Preserve its material meaning as non-empty `source`.
4. Produce a non-empty refined Markdown `document` with sections appropriate to the material.
5. Produce `metadata` with `title`, `summary`, `tags`, `entities`, and `relationships` matching the DocNexus schema.
6. Propose a project-relative Markdown `file_path`, such as `docs/memory/auth.md`; when added, DocNexus stores it at `.docnexus/<file_path>`.
7. Call MCP `validate_metadata` with the initialized project's absolute `project_root` and `metadata`. Do not create a successful draft when validation fails.
8. Create a unique, previously nonexistent `.docnexus/drafts/<draft_id>/` directory. Use a readable ID such as `draft_20260805T140501Z_auth` and never overwrite an existing draft.
9. Write these artifacts:
   - `source.md`: the preserved source.
   - `document.md`: the refined Markdown document.
   - `metadata.json`: the validated metadata as JSON.
   - `manifest.json`: the completion manifest defined below. Write this file last.
10. Read all four files back. Verify that `source.md` and `document.md` are non-empty, both JSON files parse, metadata still validates, and every manifest path and `file_path` matches the created draft.
11. Only after verification, report the required success result for review or use by `/docnexus-document-add`.

## Manifest Contract

Write `.docnexus/drafts/<draft_id>/manifest.json` with this shape:

```json
{
  "schema_version": 1,
  "status": "ready",
  "draft_id": "draft_20260805T140501Z_auth",
  "created_at": "2026-08-05T14:05:01.000Z",
  "file_path": "docs/memory/auth.md",
  "artifacts": {
    "source": ".docnexus/drafts/draft_20260805T140501Z_auth/source.md",
    "document": ".docnexus/drafts/draft_20260805T140501Z_auth/document.md",
    "metadata": ".docnexus/drafts/draft_20260805T140501Z_auth/metadata.json"
  }
}
```

All manifest paths are project-relative and must remain under the same draft directory.

## Required Result

Every invocation must end with exactly one explicit outcome. On success, report all fields below; do not merely display the refined content:

```text
result: draft_created
draft_id: <draft_id>
draft_directory: .docnexus/drafts/<draft_id>
manifest_file: .docnexus/drafts/<draft_id>/manifest.json
source_file: .docnexus/drafts/<draft_id>/source.md
document_file: .docnexus/drafts/<draft_id>/document.md
metadata_file: .docnexus/drafts/<draft_id>/metadata.json
file_path: <proposed managed file_path>
metadata_validation: passed
```

If any step fails, report `result: draft_failed`, the failed step, the error, and any files that were created. Never report `draft_created` unless the four verified files exist.

## Constraints

- Do not run `docnexus document add` in this workflow.
- Do not write, overwrite, delete, index, or graph-store a managed document. Draft files are the only allowed writes.
- Do not place draft artifacts outside `.docnexus/drafts/<draft_id>/`.
- Do not overwrite an existing draft directory or report paths that were not verified on disk.
- Do not invent entities or relationships absent from the source.
- Include at least one source-grounded entity; drafts without an entity cannot be stored or recalled.
- Extraction changes only the draft workspace; it never changes managed-document, index, embedding, or graph state.
