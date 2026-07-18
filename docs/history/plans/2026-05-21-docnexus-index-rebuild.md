# DocNexus Index Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add `docnexus index rebuild --force` to manually rebuild LadybugDB-derived graph/vector recall state from currently indexed files.

**Architecture:** Add a focused rebuild service in `src/file-index.ts` so it can reuse existing chunking, metadata mapping, embedding, event logging, and LadybugDB graph writer code. Wire only the CLI command in `src/cli.ts`; MCP remains unchanged for this iteration.

**Tech Stack:** Node.js 24, TypeScript, `node:sqlite`, LadybugDB adapter, existing embedder abstraction, Vitest.

---

## File Structure

- Modify `src/file-index.ts`: add rebuild input/output types and `rebuildFileIndex(...)`.
- Modify `src/cli.ts`: add `docnexus index rebuild --force`.
- Modify `test/file-index.test.ts`: add service-level rebuild tests.
- Modify `test/cli.test.ts`: add CLI contract tests.
- Modify product docs after implementation: move CLI rebuild into implemented scope.

## Task 1: Service-Level Rebuild Behavior

**Files:**
- Modify: `test/file-index.test.ts`
- Modify: `src/file-index.ts`

- [x] **Step 1: Write failing tests**

Add tests that assert:

- empty index returns `completed` with zero counts
- indexed files are rebuilt through `replaceDocumentGraph`
- rebuild appends `index_events.operation = 'rebuild'`
- a missing file is reported in `failed_files` and other files continue

- [x] **Step 2: Verify tests fail**

Run:

```bash
npm test -- test/file-index.test.ts
```

Expected: fail because `rebuildFileIndex` is not exported.

- [x] **Step 3: Implement minimal rebuild service**

Add `rebuildFileIndex(projectRoot, input, embedder?, graphWriter?)` in `src/file-index.ts`.

Behavior:

- require `input.force === true`
- load `indexed_files` rows with `index_state = 'indexed'`
- for each row, re-read current file content, re-chunk, re-embed, read linked metadata, call `replaceDocumentGraph`
- append `index_events` with `operation = 'rebuild'`, `result = 'success' | 'failed'`
- keep SQLite lifecycle rows unchanged

- [x] **Step 4: Verify service tests pass**

Run:

```bash
npm test -- test/file-index.test.ts
```

Expected: pass.

## Task 2: CLI Command

**Files:**
- Modify: `test/cli.test.ts`
- Modify: `src/cli.ts`

- [x] **Step 1: Write failing CLI tests**

Add tests that assert:

- `docnexus index rebuild` without `--force` fails
- `docnexus index rebuild --force` returns JSON with `processed_files`, `rebuilt_files`, and `failed_files`

- [x] **Step 2: Verify tests fail**

Run:

```bash
npm test -- test/cli.test.ts
```

Expected: fail because CLI does not recognize `index rebuild`.

- [x] **Step 3: Wire CLI to service**

Add branch in `runCli`:

```ts
if (command === "index" && subcommand === "rebuild") {
  const options = parseOptions(rest);
  return json(await rebuildFileIndex(projectRoot, { force: options.force === "true" || rest.includes("--force") }));
}
```

Parse `--force` as a boolean flag without requiring a value.

- [x] **Step 4: Verify CLI tests pass**

Run:

```bash
npm test -- test/cli.test.ts
```

Expected: pass.

## Task 3: Documentation And Full Verification

**Files:**
- Modify: `docs/product-brief-docnexus-mvp.md`
- Modify: `docs/product-brief-docnexus-mvp.zh-CN.md`
- Modify: `docs/product-brief-docnexus-mvp.en.md`

- [x] **Step 1: Update docs**

Document `docnexus index rebuild --force` as implemented CLI-only operational repair.

- [x] **Step 2: Run full checks**

Run:

```bash
npm test
npm run typecheck
npm run build
node dist/src/cli.js index rebuild --force
```

Expected: tests, typecheck, and build pass; CLI rebuild returns valid JSON.

- [x] **Step 3: Commit**

Commit implementation, tests, plan, and docs.

