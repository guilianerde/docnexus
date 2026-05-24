---
name: docnexus-capture
description: Use when the user explicitly asks to capture, preserve, or update selected project knowledge in DocNexus.
---

# DocNexus Capture

Use this skill only when the user explicitly asks to use DocNexus, capture project memory, preserve a plan, or refine a file into a current managed document.

Do not trigger automatically. Do not capture background conversation without explicit user intent.

The MCP server is configured once globally. Before invoking MCP tools, determine the initialized target project's absolute path. Every MCP call in this skill must include that path as `project_root`. If MCP reports that the project is not initialized, instruct the user to run `docnexus init` in that project before capture.

## Workflow

1. Identify the source content from the current conversation or the file path the user named.
2. Preserve the source content as `source`. Keep the original meaning and important wording intact.
3. Create `document` as normalized Markdown with these sections when applicable:
   - Title
   - Context
   - Decisions
   - Architecture
   - Data Model
   - Tool or Skill Contracts
   - Open Questions
   - Next Steps
4. Create `metadata` with this exact shape:

```json
{
  "title": "string",
  "summary": "100-150 Chinese characters for Chinese content, or 40-80 English words for English content",
  "tags": ["string"],
  "entities": [
    {
      "name": "string",
      "type": "component|concept|protocol|decision|file|tool|other",
      "description": "string"
    }
  ],
  "relationships": [
    {
      "from": "string",
      "to": "string",
      "type": "depends_on|mentions|implements|replaces|relates_to|decides",
      "description": "string"
    }
  ]
}
```

5. Select a project-relative Markdown `file_path` for the current managed document, such as `docs/memory/auth.md`. Confirm it with the user when overwriting or deleting an existing managed document is not already explicit.
6. Call the DocNexus MCP `validate_metadata` tool with `project_root` and `metadata`.
7. If validation fails, repair the metadata and repeat validation until it passes. Do not call `archive_record` if metadata cannot be made valid.
8. Call `archive_record` once with `project_root`, `file_path`, `source`, `document`, and `metadata`. A later call with the same managed `file_path` replaces its current source, document, metadata, chunks, and graph state.
9. Report the returned `id`, `file_path`, and whether the operation was `created` or `updated`.

Example write request:

```json
{
  "project_root": "/absolute/path/to/project",
  "file_path": "docs/memory/auth.md",
  "source": "Original selected content",
  "document": "# Authentication\n\nCurrent refined decision.",
  "metadata": {
    "title": "Authentication",
    "summary": "Current authentication decisions.",
    "tags": ["auth"],
    "entities": [],
    "relationships": []
  }
}
```

## Constraints

- The MCP server stores content only. It does not generate or rewrite documents.
- Keep the current source complete enough for review. DocNexus does not retain replaced versions.
- Never call an independent file-index mutation tool; `archive_record` performs persistence and indexing together.
- Only when the user explicitly requests destructive removal, call `delete_document` with either `id` or `file_path` and `confirm: true`. This deletes the managed project file and its derived state.
- Do not invent entities or relationships that are not supported by the source.
- Use `decision` entities for explicit choices and `tool` entities for MCP tools or skills.
- If the user asks for automatic capture, explain that DocNexus v0 is manually triggered.
