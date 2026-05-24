# DocNexus LadybugDB Merge Finish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the completed LadybugDB graph recall branch into `main`, verify the merged project, and clean up the temporary feature worktree and branch.

**Architecture:** This is an integration finish task, not a new feature build. Preserve current `main` state, back up conflicting untracked product brief files, fast-forward or merge the feature branch, then verify the final `main` with the project's test, typecheck, build, and CLI status commands.

**Tech Stack:** Git, Node.js, npm, TypeScript, Vitest, DocNexus CLI, LadybugDB implementation already present on `codex/docnexus-ladybugdb-graph-recall`.

---

## File Structure

No new source files should be created by this plan.

Expected tracked files introduced or updated by the merge:

- `package.json`: includes `@ladybugdb/core`.
- `package-lock.json`: includes LadybugDB dependency resolution.
- `src/embedding-config.ts`: shared embedding dimension constant.
- `src/embedder.ts`: uses shared embedding dimension.
- `src/graph-mapping.ts`: maps metadata entities and relationships to graph concepts and edges.
- `src/ladybug-store.ts`: owns LadybugDB schema, graph writes/deletes, and graph-backed recall.
- `src/file-index.ts`: synchronizes upsert/delete lifecycle to LadybugDB.
- `src/recall.ts`: uses LadybugDB-backed recall.
- `src/store.ts`: exposes archive paths needed for graph sync.
- `test/embedder.test.ts`: covers shared embedding dimension.
- `test/graph-mapping.test.ts`: covers metadata-to-graph mapping.
- `test/ladybug-store.test.ts`: covers LadybugDB adapter behavior with availability guard.
- `test/file-index.test.ts`: covers graph writer integration and failure audit behavior.
- `test/recall.test.ts`: covers recall output shape through injected reader.
- `test/mcp.test.ts`: aligns MCP tests with graph-backed recall behavior.
- `docs/product-brief-docnexus-mvp.zh-CN.md`: Chinese product brief describing LadybugDB integration.
- `docs/product-brief-docnexus-mvp.en.md`: English product brief describing LadybugDB integration.
- `docs/product-brief-docnexus-mvp.md`: product brief entry or default brief.

Only these potentially conflicting untracked product brief paths may be moved before merge:

- `docNeuxs/docs/product-brief-docnexus-mvp.zh-CN.md`
- `docNeuxs/docs/product-brief-docnexus-mvp.en.md`
- `docNeuxs/docs/product-brief-docnexus-mvp.md`

Unrelated untracked directories and files must remain untouched.

---

### Task 1: Inspect Merge Preconditions And Back Up Conflicting Product Briefs

**Files:**
- Read: `docNeuxs/docs/product-brief-docnexus-mvp.zh-CN.md`
- Read: `docNeuxs/docs/product-brief-docnexus-mvp.en.md`
- Read: `docNeuxs/docs/product-brief-docnexus-mvp.md`
- Read: feature branch versions of the same paths
- May move: only the three product brief files listed above, and only after backup

- [ ] **Step 1: Confirm current branch and feature branch**

Run from `/Users/rowansen/Documents/project`:

```bash
git branch --show-current
git branch --list 'codex/docnexus-ladybugdb-graph-recall'
git worktree list
```

Expected:

- current branch is `main`
- branch `codex/docnexus-ladybugdb-graph-recall` exists
- feature worktree path is listed

- [ ] **Step 2: Inspect current dirty state**

Run:

```bash
git status --short
```

Expected:

- untracked product brief files may appear under `docNeuxs/docs/`
- unrelated untracked directories may appear
- no staged changes from this merge task

- [ ] **Step 3: Identify files that would be overwritten by merge**

Run:

```bash
git ls-tree -r --name-only codex/docnexus-ladybugdb-graph-recall -- docNeuxs/docs/product-brief-docnexus-mvp.zh-CN.md docNeuxs/docs/product-brief-docnexus-mvp.en.md docNeuxs/docs/product-brief-docnexus-mvp.md
```

Expected:

- the command lists the product brief files tracked by the feature branch

- [ ] **Step 4: Compare main untracked product brief content with feature branch content**

Run these commands from `/Users/rowansen/Documents/project`:

```bash
git show codex/docnexus-ladybugdb-graph-recall:docNeuxs/docs/product-brief-docnexus-mvp.zh-CN.md > /private/tmp/docnexus-feature-brief.zh-CN.md
diff -u docNeuxs/docs/product-brief-docnexus-mvp.zh-CN.md /private/tmp/docnexus-feature-brief.zh-CN.md
```

```bash
git show codex/docnexus-ladybugdb-graph-recall:docNeuxs/docs/product-brief-docnexus-mvp.en.md > /private/tmp/docnexus-feature-brief.en.md
diff -u docNeuxs/docs/product-brief-docnexus-mvp.en.md /private/tmp/docnexus-feature-brief.en.md
```

```bash
git show codex/docnexus-ladybugdb-graph-recall:docNeuxs/docs/product-brief-docnexus-mvp.md > /private/tmp/docnexus-feature-brief.default.md
diff -u docNeuxs/docs/product-brief-docnexus-mvp.md /private/tmp/docnexus-feature-brief.default.md
```

Expected:

- differences show the feature branch documentation includes the LadybugDB implemented state
- if a file is identical, no backup is necessary for that file, but moving it is still allowed if Git would otherwise block the merge

- [ ] **Step 5: Create a timestamped backup directory**

Run:

```bash
mkdir -p /private/tmp/docnexus-product-docs-backup-2026-05-21
```

Expected:

- backup directory exists

- [ ] **Step 6: Copy conflicting untracked product brief files into the backup directory**

Run:

```bash
cp docNeuxs/docs/product-brief-docnexus-mvp.zh-CN.md /private/tmp/docnexus-product-docs-backup-2026-05-21/product-brief-docnexus-mvp.zh-CN.md
cp docNeuxs/docs/product-brief-docnexus-mvp.en.md /private/tmp/docnexus-product-docs-backup-2026-05-21/product-brief-docnexus-mvp.en.md
cp docNeuxs/docs/product-brief-docnexus-mvp.md /private/tmp/docnexus-product-docs-backup-2026-05-21/product-brief-docnexus-mvp.md
```

Expected:

- the three current untracked product brief files are preserved under `/private/tmp/docnexus-product-docs-backup-2026-05-21/`

- [ ] **Step 7: Remove only the conflicting untracked product brief files from main**

Run:

```bash
rm docNeuxs/docs/product-brief-docnexus-mvp.zh-CN.md docNeuxs/docs/product-brief-docnexus-mvp.en.md docNeuxs/docs/product-brief-docnexus-mvp.md
```

Expected:

- only the three product brief files are removed from the worktree
- the backup copies remain in `/private/tmp/docnexus-product-docs-backup-2026-05-21/`
- unrelated untracked files and directories still exist

---

### Task 2: Merge The LadybugDB Feature Branch Into Main

**Files:**
- Modify via merge: tracked project files from `codex/docnexus-ladybugdb-graph-recall`

- [ ] **Step 1: Merge the feature branch**

Run from `/Users/rowansen/Documents/project`:

```bash
git merge codex/docnexus-ladybugdb-graph-recall
```

Expected:

- merge succeeds
- fast-forward is acceptable
- non-fast-forward merge commit is acceptable if Git requires it
- no conflict markers remain

- [ ] **Step 2: Inspect merged status**

Run:

```bash
git status --short
```

Expected:

- no staged or unstaged tracked changes from a failed merge
- unrelated untracked directories may still appear

- [ ] **Step 3: Confirm LadybugDB dependency is present**

Run:

```bash
rg -n '"@ladybugdb/core"|store.lbug|LadybugDB' docNeuxs/package.json docNeuxs/docs/product-brief-docnexus-mvp.zh-CN.md docNeuxs/docs/product-brief-docnexus-mvp.en.md docNeuxs/src/ladybug-store.ts
```

Expected:

- `package.json` includes `@ladybugdb/core`
- docs mention LadybugDB implemented state
- `src/ladybug-store.ts` exists and mentions `store.lbug`

---

### Task 3: Verify Merged Main

**Files:**
- Read/execute project verification only

- [ ] **Step 1: Run the full test suite**

Run from `/Users/rowansen/Documents/project/docNeuxs`:

```bash
npm test
```

Expected:

- Vitest exits successfully
- all default tests pass

- [ ] **Step 2: Run TypeScript typecheck**

Run:

```bash
npm run typecheck
```

Expected:

- command exits successfully
- no TypeScript errors

- [ ] **Step 3: Run build**

Run:

```bash
npm run build
```

Expected:

- command exits successfully
- `dist/` is produced or updated according to the existing project build setup

- [ ] **Step 4: Run CLI index status**

Run:

```bash
node dist/src/cli.js index status
```

Expected:

- command exits successfully
- output is valid JSON with index status fields

- [ ] **Step 5: Scan for merge conflict markers**

Run from `/Users/rowansen/Documents/project`:

```bash
rg -n '<<<<<<<|=======|>>>>>>>' docNeuxs/src docNeuxs/test docNeuxs/docs docNeuxs/package.json
```

Expected:

- no results
- command may exit with code 1 because no matches were found

---

### Task 4: Clean Up Feature Worktree And Branch

**Files:**
- Remove worktree metadata and feature worktree after successful verification

- [ ] **Step 1: Remove the feature worktree**

Run from `/Users/rowansen/Documents/project`:

```bash
git worktree remove /Users/rowansen/Documents/project/docNeuxs/.worktrees/codex/docnexus-ladybugdb-graph-recall
```

Expected:

- feature worktree directory is removed

- [ ] **Step 2: Prune stale worktree metadata**

Run:

```bash
git worktree prune
```

Expected:

- command exits successfully

- [ ] **Step 3: Delete the merged local feature branch**

Run:

```bash
git branch -d codex/docnexus-ladybugdb-graph-recall
```

Expected:

- branch is deleted
- if Git reports the branch is not fully merged, stop and inspect before using any force delete

- [ ] **Step 4: Confirm final repository state**

Run:

```bash
git status --short
git branch --list 'codex/docnexus-ladybugdb-graph-recall'
git worktree list
```

Expected:

- no `codex/docnexus-ladybugdb-graph-recall` branch is listed
- the feature worktree is no longer listed
- unrelated untracked directories may still appear
- tracked project state is clean after the merge

---

### Task 5: Final Report

**Files:**
- No file changes

- [ ] **Step 1: Summarize the integration result**

Report:

- merge result commit or fast-forward target commit
- backup directory path for pre-existing product brief files
- verification commands and pass/fail result
- feature worktree cleanup result
- feature branch cleanup result
- any unrelated untracked files left untouched

Expected:

- user can tell exactly what changed and what remains outside scope
