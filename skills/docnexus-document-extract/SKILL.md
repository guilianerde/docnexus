---
name: docnexus-document-extract
description: Use when the user explicitly asks to extract or refine source material into a DocNexus managed-document draft.
---

# DocNexus Document Extract

Use only when the user explicitly requests DocNexus document extraction or refinement. This workflow prepares a draft; it does not store or index it.

## Workflow

1. Identify the requested original content or named source file.
2. Preserve its material meaning as `source`.
3. Produce a refined Markdown `document` with sections appropriate to the material.
4. Produce `metadata` with `title`, `summary`, `tags`, `entities`, and `relationships` matching the DocNexus schema.
5. Propose a project-relative Markdown `file_path`, such as `docs/memory/auth.md`.
6. When validation is requested or needed before add, call MCP `validate_metadata` with the initialized project's absolute `project_root` and `metadata`.
7. Present the draft artifacts and proposed `file_path` for review or use by `/docnexus-document-add`.

## Constraints

- Do not run `docnexus document add` in this workflow.
- Do not write, overwrite, delete, index, or graph-store a managed document.
- Do not invent entities or relationships absent from the source.
- Extraction alone never changes DocNexus state.
