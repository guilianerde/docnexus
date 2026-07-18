# DocNexus LadybugDB Merge Finish Design

Date: 2026-05-21

## Context

DocNexus `main` currently contains the LadybugDB graph recall design and implementation plan, but not the completed implementation. The completed work exists on the local branch `codex/docnexus-ladybugdb-graph-recall` in a feature worktree.

The feature branch adds LadybugDB as DocNexus's project-local graph/vector recall store, updates recall to use LadybugDB, and updates the Chinese and English product briefs to describe the new architecture.

The `main` worktree also contains untracked product brief files with the same paths as files tracked on the feature branch. A direct merge can fail because Git will not overwrite untracked files.

## Goal

Finish the LadybugDB Graph Recall integration by merging the completed feature branch into `main`, reconciling documentation state, verifying the merged project, and cleaning up the temporary feature worktree and branch.

## Scope

This task includes:

- merge `codex/docnexus-ladybugdb-graph-recall` into `main`
- preserve or back up untracked product brief files before merge if they would be overwritten
- keep the feature branch product brief content as the intended current product documentation
- verify code, tests, build, and CLI status on the merged `main`
- remove the temporary feature worktree
- delete the local feature branch after a successful merge

This task does not include:

- new LadybugDB feature work
- graph ranking changes
- embedding model replacement
- rebuild or repair command implementation
- cleanup of unrelated untracked directories outside this merge conflict
- deletion of archived `.docnexus` project data

## Merge Strategy

The merge should be conservative and explicit.

1. Check `main` status and identify untracked files that collide with files tracked by the feature branch.
2. For the product brief files, compare the current untracked `main` versions with the feature branch versions.
3. If the feature branch versions are the newer LadybugDB-aware documentation, back up the untracked `main` versions to `/private/tmp/docnexus-product-docs-backup-<timestamp>/`.
4. Remove or move only those exact conflicting untracked product brief files after backup.
5. Merge the feature branch into `main`.
6. Leave unrelated untracked directories and files untouched.

The expected product brief files are:

- `docs/product-brief-docnexus-mvp.zh-CN.md`
- `docs/product-brief-docnexus-mvp.en.md`
- `docs/product-brief-docnexus-mvp.md`

## Documentation Result

After merge, the product documentation should describe the implemented state:

- Skills refine source content and metadata.
- MCP/CLI store archives, index files, and expose recall.
- SQLite remains the archive, lifecycle, and audit ledger.
- LadybugDB stores `Project`, `Document`, `Chunk`, `Concept`, and graph relationships in `.docnexus/store.lbug`.
- Recall uses LadybugDB vector search, then graph traversal for document context, neighboring chunks, concepts, and related concepts.
- MCP still does not call an LLM or generate final natural-language answers.

The documentation must not continue to list LadybugDB or Graph RAG as wholly unimplemented. It may still list future work such as production graph tuning, rebuild/repair commands, concept cleanup, deeper graph reasoning, and replacing `LocalHashEmbedder`.

## Verification

Run verification from the merged `main` worktree:

```bash
npm test
npm run typecheck
npm run build
node dist/src/cli.js index status
```

Expected results:

- the full Vitest suite passes
- TypeScript typecheck passes
- build succeeds
- CLI status returns valid JSON
- no merge conflict markers remain in source or documentation

## Cleanup

After successful verification:

- remove the feature worktree at `.worktrees/codex/docnexus-ladybugdb-graph-recall`
- prune stale worktree metadata
- delete local branch `codex/docnexus-ladybugdb-graph-recall`

Cleanup must happen only after the merge and verification succeed.

## Risks And Handling

- **Untracked file overwrite risk:** Back up conflicting untracked product brief files before allowing the merge to replace them.
- **Dirty worktree risk:** Do not touch unrelated untracked directories or files.
- **Verification failure risk:** Stop cleanup if tests, typecheck, build, or CLI status fail; keep the feature branch/worktree available for fixes.
- **LadybugDB environment risk:** Default test verification should use the existing test behavior. Deep native LadybugDB vector integration tests that require special environment flags are not part of this merge gate unless explicitly requested.
