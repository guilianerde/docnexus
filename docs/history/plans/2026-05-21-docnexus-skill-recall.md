# DocNexus Skill-Driven Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move recall out of the MCP tool surface and make it a `docnexus-recall` skill workflow backed by the existing CLI recall command.

**Architecture:** MCP keeps archive, metadata, indexing, and status tools, but no longer exposes `recall`. CLI keeps `docnexus recall` as the raw retrieval command. The new skill owns the conversation flow: run CLI recall, interpret returned chunks and graph context, answer with references.

**Tech Stack:** Node.js, TypeScript, MCP SDK, Vitest, Markdown skills/docs.

---

## File Map

- Modify `src/mcp.ts`: remove the `recall` import, `callTool` branch, and server tool registration.
- Modify `test/mcp.test.ts`: remove MCP recall success/validation expectations; assert `recall` is unknown while indexing tools still work.
- Create `skills/docnexus-recall/SKILL.md`: define manual recall workflow through CLI and answer/reference behavior.
- Modify `README.md`: split CLI, skills, and MCP ownership; remove `recall` from MCP tool list; document `docnexus-recall`.
- Modify `README.zh-CN.md`: Chinese equivalent of root README changes.
- Modify `docs/product-brief-docnexus-mvp.md`, `docs/product-brief-docnexus-mvp.en.md`, `docs/product-brief-docnexus-mvp.zh-CN.md`: update product architecture and recall workflow.

## Task 1: MCP Contract Tests

**Files:**
- Modify: `test/mcp.test.ts`

- [ ] **Step 1: Update the MCP indexing test to stop using recall**

Replace this test name and body section:

```ts
it("indexes, recalls, and deletes a file through MCP handlers", async () => {
```

with:

```ts
it("indexes and deletes a file through MCP handlers", async () => {
```

Then remove this block from the same test:

```ts
const recalled = await callTool(projectRoot, "recall", { query: "local chunks", limit: 1 });
expect(recalled.results).toHaveLength(1);
expect(recalled.results[0]).toMatchObject({
  file_path: "memory.md",
  text: expect.stringContaining("local chunks")
});
```

- [ ] **Step 2: Replace invalid recall limit test with unknown recall tool test**

Replace:

```ts
it("rejects invalid recall limits before querying", async () => {
  const projectRoot = await makeRoot();

  await expect(callTool(projectRoot, "recall", { query: "x", limit: 1.5 })).rejects.toThrow(
    "limit must be a positive integer"
  );
});
```

with:

```ts
it("does not expose recall through MCP", async () => {
  const projectRoot = await makeRoot();

  await expect(callTool(projectRoot, "recall", { query: "x", limit: 1 })).rejects.toThrow(
    "Unknown tool: recall"
  );
});
```

- [ ] **Step 3: Run MCP tests and verify failure**

Run:

```bash
npm test -- test/mcp.test.ts
```

Expected: FAIL because `src/mcp.ts` still exposes the recall tool, so the new unknown-tool assertion will not pass.

## Task 2: Remove Recall From MCP

**Files:**
- Modify: `src/mcp.ts`
- Test: `test/mcp.test.ts`

- [ ] **Step 1: Remove the recall import**

Delete this line from `src/mcp.ts`:

```ts
import { recall } from "./recall.js";
```

- [ ] **Step 2: Remove the callTool recall branch**

Delete this switch branch from `callTool`:

```ts
case "recall":
  if (typeof input.query !== "string") {
    throw new Error("query must be a non-empty string");
  }
  return recall(projectRoot, {
    query: input.query,
    limit: positiveInteger(input.limit)
  });
```

- [ ] **Step 3: Remove the server tool registration**

Delete this `server.tool` block:

```ts
server.tool(
  "recall",
  {
    query: z.string().min(1),
    limit: z.number().int().positive().optional()
  },
  async (args) => toolResponse(await callTool(projectRoot, "recall", args))
);
```

- [ ] **Step 4: Run MCP tests**

Run:

```bash
npm test -- test/mcp.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run CLI recall tests**

Run:

```bash
npm test -- test/cli.test.ts
```

Expected: PASS, confirming CLI recall remains available.

## Task 3: Add Recall Skill

**Files:**
- Create: `skills/docnexus-recall/SKILL.md`

- [ ] **Step 1: Create the skill file**

Create `skills/docnexus-recall/SKILL.md` with:

```markdown
---
name: docnexus-recall
description: Manually retrieve DocNexus project memory with the CLI recall command, then answer the user's question using returned chunks and graph context with file references.
---

# DocNexus Recall

Use this skill only when the user explicitly asks to use DocNexus recall, search project memory, retrieve indexed project context, or answer from DocNexus memory.

Do not trigger automatically for every question. DocNexus recall is manually requested.

## Workflow

1. Identify the user's recall query. Use the user's wording when possible.
2. Use `5` as the default limit unless the user asks for a different number of results.
3. Run recall from the project root.
4. Prefer the linked CLI command:

```bash
docnexus recall "<query>" --limit 5
```

5. If `docnexus` is not linked, use the compiled CLI:

```bash
node dist/src/cli.js recall "<query>" --limit 5
```

6. Parse the JSON output.
7. Treat returned chunks, document metadata, concepts, relationships, and adjacent chunks as DocNexus evidence.
8. Answer the user's question using the recalled context. Do not claim DocNexus evidence for facts that are not present in the returned results.
9. Include a concise `References` section listing the files used. Include chunk index and score when present.
10. If recall returns no results, say DocNexus did not find matching indexed context. You may still answer from the current conversation if that is useful, but keep that distinction clear.

## Output Guidance

- Keep the answer focused on the user's query.
- Prefer concrete project facts from recalled chunks over generic explanation.
- Mention uncertainty when recalled context is incomplete or conflicting.
- Do not paste large chunks verbatim. Summarize and cite the file paths.

## Reference Format

Use this shape when results include source locations:

```markdown
References:
- `path/to/file.md`, chunk 0, score 0.82
- `path/to/other.md`, chunk 2, score 0.74
```

If scores or chunk indexes are absent, omit only the missing fields.
```

- [ ] **Step 2: Check skill file is discoverable**

Run:

```bash
test -f skills/docnexus-recall/SKILL.md
```

Expected: exit code 0.

## Task 4: Documentation Updates

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/product-brief-docnexus-mvp.md`
- Modify: `docs/product-brief-docnexus-mvp.en.md`
- Modify: `docs/product-brief-docnexus-mvp.zh-CN.md`

- [ ] **Step 1: Update README MCP tool lists**

In `README.md`, remove this row from the MCP tools table:

```markdown
| `recall` | Return relevant chunks and graph context for a query. |
```

In `README.zh-CN.md`, remove:

```markdown
| `recall` | 根据 query 返回相关 chunks 和图谱上下文。 |
```

- [ ] **Step 2: Add recall skill to README skill workflow section**

In `README.md`, after the capture skill workflow paragraph, add:

```markdown
## Recall Skill Workflow

Use `skills/docnexus-recall/SKILL.md` when a user explicitly asks to recall project memory during a conversation.

The skill runs `docnexus recall "<query>" --limit N` or falls back to `node dist/src/cli.js recall "<query>" --limit N`. The CLI returns raw chunks and graph context. The agent then answers with that context and includes referenced files.
```

In `README.zh-CN.md`, add the Chinese equivalent:

```markdown
## Recall Skill 工作流

当用户在对话中明确要求召回项目记忆时，使用 `skills/docnexus-recall/SKILL.md`。

该 skill 会运行 `docnexus recall "<query>" --limit N`，或 fallback 到 `node dist/src/cli.js recall "<query>" --limit N`。CLI 返回原始 chunks 和图谱上下文；智能体再结合这些上下文回答，并列出参考文件。
```

- [ ] **Step 3: Update product briefs**

Update each product brief so:

- Skills layer lists both `skills/docnexus-capture/SKILL.md` and `skills/docnexus-recall/SKILL.md`.
- MCP tool list excludes `recall`.
- CLI command list still includes `docnexus recall "local memory" --limit 5`.
- Recall flow says the recall skill calls CLI recall and the agent answers with references.
- Implemented scope mentions skill-driven recall.
- MCP final answer generation remains not implemented.

- [ ] **Step 4: Search for stale MCP recall claims**

Run:

```bash
rg -n "MCP.*recall|recall.*MCP|`recall`|recall tool|MCP tools" README.md README.zh-CN.md docs/product-brief-docnexus-mvp*.md skills
```

Expected: no claim that `recall` remains an MCP tool. Mentions of CLI recall and skill-driven recall are expected.

## Task 5: Full Verification

**Files:**
- All changed files

- [ ] **Step 1: Run full tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 4: Check git diff**

Run:

```bash
git diff -- src/mcp.ts test/mcp.test.ts skills/docnexus-recall/SKILL.md README.md README.zh-CN.md docs/product-brief-docnexus-mvp.md docs/product-brief-docnexus-mvp.en.md docs/product-brief-docnexus-mvp.zh-CN.md
```

Expected: changes are limited to recall ownership split, skill addition, and docs.

- [ ] **Step 5: Commit implementation**

Stage only relevant files:

```bash
git add src/mcp.ts test/mcp.test.ts skills/docnexus-recall/SKILL.md README.md README.zh-CN.md docs/product-brief-docnexus-mvp.md docs/product-brief-docnexus-mvp.en.md docs/product-brief-docnexus-mvp.zh-CN.md docs/superpowers/plans/2026-05-21-docnexus-skill-recall.md
```

Commit:

```bash
git commit -m "feat: move DocNexus recall to skill workflow"
```

## Self-Review

- Spec coverage: MCP recall removal, CLI recall retention, new recall skill, docs update, tests, and verification are covered.
- Placeholder scan: no placeholders remain.
- Type consistency: `callTool`, `runCli`, `docnexus-recall`, and command names match existing project names.
