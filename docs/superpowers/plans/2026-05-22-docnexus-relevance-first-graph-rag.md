# DocNexus Relevance-First Graph RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement relevance-first structured `docnexus recall` output with metadata and graph context as hard dependencies.

**Architecture:** Keep MCP unchanged and continue using CLI recall as the raw retrieval entry. `src/ladybug-store.ts` will return enriched structured recall rows from LadybugDB, and `src/recall.ts` will validate required metadata/graph context, remove old flat fields, and expose a structured result shape for the recall skill. The recall ranking remains anchored by vector chunk similarity; document and graph context are attached as supporting context.

**Tech Stack:** Node.js, TypeScript, LadybugDB, Vitest, Markdown skills/docs.

---

## File Map

- Modify `src/recall.ts`: replace flat `RecallResult` with structured `matched_chunk`, `document_context`, `graph_context`, and `ranking`; validate required metadata and graph context.
- Modify `src/ladybug-store.ts`: enrich `LadybugRecallRow` with structured context fields, previous chunk, same-document chunks, typed graph paths, and graph supporting chunks.
- Modify `test/recall.test.ts`: add failing unit tests for structured output, flat-field removal, ranking preservation, and hard dependency failures.
- Modify `test/cli.test.ts`: update CLI recall expectations to require metadata-linked index data and structured JSON.
- Modify `test/ladybug-store.test.ts`: add guarded integration expectations for structured recall rows.
- Modify `skills/docnexus-recall/SKILL.md`: instruct agents to consume structured fields and treat CLI recall failures as missing required graph memory.
- Modify `README.md`, `README.zh-CN.md`, `docs/product-brief-docnexus-mvp.en.md`, `docs/product-brief-docnexus-mvp.zh-CN.md`, and `docs/product-brief-docnexus-mvp.md`: document the breaking recall JSON contract and graph metadata dependency.

## Task 1: Structured Recall Contract Tests

**Files:**
- Modify: `test/recall.test.ts`
- Modify: `src/recall.ts`

- [ ] **Step 1: Write failing structured-output tests**

Replace the current first recall test stub row shape with a row that includes `matched_chunk`, `document_context`, `graph_context`, and `ranking`. Assert that the result has those fields and does not expose old flat fields such as `file_path`, `chunk_id`, or `text` at result root.

- [ ] **Step 2: Write failing hard-dependency tests**

Add tests that call `recall(...)` with stubbed rows missing `document_context.summary` and rows with an empty `graph_context.concepts`; expect clear errors:

```ts
await expect(recall(projectRoot, { query: "x" }, new LocalHashEmbedder(), reader)).rejects.toThrow(
  "recall requires document metadata"
);

await expect(recall(projectRoot, { query: "x" }, new LocalHashEmbedder(), reader)).rejects.toThrow(
  "recall requires graph context"
);
```

- [ ] **Step 3: Run recall tests and verify RED**

Run:

```bash
npm test -- test/recall.test.ts
```

Expected: FAIL because production code still returns flat fields.

- [ ] **Step 4: Implement structured recall mapping**

Update `src/recall.ts` so `RecallResult` contains:

```ts
matched_chunk: {
  chunk_id: string;
  chunk_index: number;
  text: string;
  score: number;
};
document_context: {
  file_id: string;
  path: string;
  record_id?: string;
  title: string;
  summary: string;
  previous_chunk?: RecallContextChunk;
  next_chunk?: RecallContextChunk;
  same_document_chunks: RecallContextChunk[];
};
graph_context: {
  concepts: string[];
  related_concepts: string[];
  supporting_chunks: RecallSupportingChunk[];
  paths: RecallGraphPath[];
};
ranking: {
  primary: "chunk_similarity";
  graph_used_as: "supporting_context";
};
```

Validate that `document_context.summary` is non-empty and `graph_context.concepts.length > 0`.

- [ ] **Step 5: Run recall tests and verify GREEN**

Run:

```bash
npm test -- test/recall.test.ts
```

Expected: PASS.

## Task 2: LadybugDB Structured Recall Rows

**Files:**
- Modify: `src/ladybug-store.ts`
- Modify: `test/ladybug-store.test.ts`

- [ ] **Step 1: Write failing LadybugDB structured row test**

In the guarded integration test, call `recallFromLadybug(...)` after inserting a metadata-linked graph and assert the first row contains:

```ts
expect(row.document_context).toMatchObject({
  path: "auth.md",
  title: "Auth Notes",
  summary: "Authentication architecture notes."
});
expect(row.graph_context.concepts).toContain("Auth");
expect(row.ranking).toEqual({
  primary: "chunk_similarity",
  graph_used_as: "supporting_context"
});
```

- [ ] **Step 2: Run LadybugDB tests and verify RED**

Run:

```bash
DOCNEXUS_LADYBUG_INTEGRATION=1 npm test -- test/ladybug-store.test.ts
```

Expected: FAIL where LadybugDB is available because rows are still flat.

- [ ] **Step 3: Implement LadybugDB structured row normalization**

Update `LadybugRecallRow` to match the structured recall shape and change `normalizeRecallRow(...)` to build nested fields from the query result. Add `previous_chunk`, `next_chunk`, empty `same_document_chunks`, empty `supporting_chunks`, and typed `paths` from relationship labels where available.

- [ ] **Step 4: Run LadybugDB test**

Run:

```bash
DOCNEXUS_LADYBUG_INTEGRATION=1 npm test -- test/ladybug-store.test.ts
```

Expected: PASS when LadybugDB is available; skip guarded runtime-specific assertions otherwise.

## Task 3: CLI Recall Breaking Contract

**Files:**
- Modify: `test/cli.test.ts`
- Modify: `src/cli.ts` only if dependency injection is needed

- [ ] **Step 1: Update CLI test data**

Change the CLI recall test to create an archived record with metadata, index the file with `--record-id`, and assert JSON results expose `matched_chunk`, `document_context`, `graph_context`, and no root flat result fields.

- [ ] **Step 2: Run CLI tests and verify RED or PASS**

Run:

```bash
npm test -- test/cli.test.ts
```

Expected: FAIL until `recall.ts` and `ladybug-store.ts` return the structured contract in default test mode.

- [ ] **Step 3: Keep CLI thin**

Do not add CLI-specific reshaping unless tests show it is necessary. CLI should print the `recall(...)` output unchanged.

- [ ] **Step 4: Run CLI tests**

Run:

```bash
npm test -- test/cli.test.ts
```

Expected: PASS.

## Task 4: Skill And Documentation Updates

**Files:**
- Modify: `skills/docnexus-recall/SKILL.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/product-brief-docnexus-mvp.en.md`
- Modify: `docs/product-brief-docnexus-mvp.zh-CN.md`
- Modify: `docs/product-brief-docnexus-mvp.md`

- [ ] **Step 1: Update recall skill**

Update the workflow to read `matched_chunk`, `document_context`, `graph_context`, and `ranking`. Make clear that recall failure means required graph memory is missing or inconsistent.

- [ ] **Step 2: Update READMEs and product briefs**

Document that `docnexus recall` returns structured Graph RAG JSON only, old flat fields are removed, and indexed files must be linked to metadata/graph context for recall to succeed.

- [ ] **Step 3: Run docs grep**

Run:

```bash
rg -n "file_path.*chunk_id|old flat|flat fields|works when graph metadata is absent|兼容旧字段" README.md README.zh-CN.md docs skills
```

Expected: no stale compatibility claims.

## Task 5: Final Verification

**Files:**
- All modified implementation, tests, skills, docs.

- [ ] **Step 1: Run full test suite**

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

- [ ] **Step 4: Check diff hygiene**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only intended files changed.
