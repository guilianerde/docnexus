# DocNexus Skill-Driven Recall Design

Date: 2026-05-21

## Context

DocNexus currently exposes recall in two places:

- MCP tool: `recall`
- CLI command: `docnexus recall "query" --limit N`

The product direction is to split DocNexus capabilities by usage mode:

- CLI handles manual maintenance commands.
- Skills handle conversation-level agent workflows.
- MCP keeps necessary low-level service tools.

Recall is a conversation workflow, not just a raw retrieval operation. The expected user experience is: the user invokes a recall skill during a conversation, the agent retrieves relevant chunks and graph context, then the agent answers using that context and lists referenced files.

## Goal

Move recall out of the MCP tool surface and make it a skill-driven conversation workflow backed by the existing CLI recall command.

This iteration should:

- Remove the MCP `recall` tool.
- Keep `docnexus recall "query" --limit N` as the retrieval command.
- Add a `docnexus-recall` skill that instructs agents how to retrieve context and answer.
- Update docs so recall is described as skill-driven, while CLI remains the low-level retrieval entry.
- Keep file indexing MCP tools for now.

## Non-Goals

This iteration does not:

- Remove `upsert_file_index`, `delete_file_index`, or `index_status` from MCP.
- Change the recall ranking algorithm.
- Change LadybugDB graph/vector storage.
- Add MCP-side final answer generation.
- Add automatic recall before every answer.
- Add file watching or automatic indexing.
- Add embedding model switching.

## Command Ownership

### CLI-Owned Commands

CLI remains the manual local command surface:

```bash
docnexus index upsert path/to/file.md --name FileName --record-id rec_0000000000000000
docnexus index delete --file path/to/file.md
docnexus index delete --id file_0000000000000000
docnexus index rebuild --force
docnexus index status
docnexus recall "query" --limit 5
```

`docnexus recall` returns raw retrieval context. It does not generate the final answer.

### Skill-Owned Workflows

Skills own agent-facing conversation workflows:

- `docnexus-capture`: refine source into document and metadata, then archive.
- `docnexus-recall`: retrieve context with CLI recall, then answer using the returned chunks and graph context.

`docnexus-recall` is manually triggered by explicit user intent such as:

- "Use DocNexus recall to answer this."
- "召回项目记忆回答这个问题。"
- "查一下 DocNexus 记忆里关于 LadybugDB 的内容。"

It should not run automatically on every user question.

### MCP-Retained Tools

MCP keeps low-level storage and maintenance tools:

- `archive_record`
- `list_records`
- `get_record`
- `status`
- `validate_metadata`
- `upsert_file_index`
- `delete_file_index`
- `index_status`

MCP removes:

- `recall`

## Skill Behavior

The new `skills/docnexus-recall/SKILL.md` should instruct the agent to:

1. Identify the user's recall query.
2. Choose a small default limit, initially `5`, unless the user asks for a different limit.
3. Run CLI recall from the project root.
4. Prefer `docnexus recall "<query>" --limit N` when the command is available.
5. Fall back to `node dist/src/cli.js recall "<query>" --limit N` when the package command is not linked.
6. Parse the JSON output.
7. Use only returned chunks and graph context as DocNexus evidence.
8. Answer the user's question in normal natural language.
9. Include a short references section with file path, chunk index, and score when present.
10. If no results are returned, say that DocNexus did not find matching indexed context and answer only from general conversation context if appropriate.

The skill should make clear that CLI recall returns context, while the LLM produces the final answer.

## MCP Changes

`src/mcp.ts` should remove recall from both layers:

- Remove the `recall` import.
- Remove the `case "recall"` branch from `callTool`.
- Remove the `server.tool("recall", ...)` registration.

After this change, calling `callTool(projectRoot, "recall", ...)` should fail with `Unknown tool: recall`.

## Test Changes

Update tests with minimal scope:

- Keep CLI recall tests unchanged where possible.
- Update MCP tests so they no longer expect recall to work through MCP.
- Add or update a test that confirms `callTool(..., "recall", ...)` is rejected as unknown.
- Keep indexing MCP tests for `upsert_file_index`, `delete_file_index`, and `index_status`.

No test should attempt to execute an agent skill end-to-end. The skill file is instructional content, not executable runtime code.

## Documentation Changes

Update root README files and product briefs:

- Remove `recall` from MCP tool lists.
- Describe `docnexus-recall` as the recommended conversation recall workflow.
- Keep `docnexus recall` in CLI usage as the raw retrieval command.
- State that the agent answers with retrieved chunks and graph context, and includes referenced files.
- Clarify that MCP still does not generate final answers.

## Success Criteria

- MCP no longer exposes `recall`.
- CLI recall still works.
- A new `docnexus-recall` skill documents the conversation recall workflow.
- Docs clearly split CLI, skills, and MCP responsibilities.
- Tests, typecheck, and build pass:

```bash
npm test
npm run typecheck
npm run build
```

## Risks

- Existing agents configured to call MCP `recall` directly will break.
  - Accepted for this iteration because the chosen direction is to make recall skill-driven.
- Skill execution depends on the CLI being available.
  - Mitigated by documenting both `docnexus` and `node dist/src/cli.js` command paths.
- Users may expect recall to happen automatically.
  - Mitigated by documenting that recall remains manually triggered.
