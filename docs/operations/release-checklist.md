# Release Checklist

## Default push and release workflow

Follow the project instructions in the repository-root `AGENTS.md`. Reuse successful checks from development; do not repeat the full local verification suite just because a push or release was requested.

- **Git push only:** inspect the current diff, run `git diff --check`, commit the task's files and push. Do not bump versions or publish a package.
- **npm release:** align version metadata, the version test, changelog and affected documentation; commit, push, tag that commit and publish a stable GitHub Release. Follow the release workflow through npm publication and verify the official registry's version and `latest` tag.

The release workflow runs the complete Node.js 22/24 checks before its publish job. Do not wait for ordinary push CI before creating the Release, run the entire suite again locally, or publish a second time from the terminal. Run additional local checks only for changed behavior that lacks verification, failures or unresolved concerns. For documentation-only changes, inspect content, links and affected source excerpts.

If npm reports processing or temporarily returns 404 after a successful upload, wait about 30 seconds between official version/latest checks. This is not a reason to rebuild, republish or increment the version again.

## Optional local diagnostics

Use the relevant commands below when investigating a failure or explicitly validating a change. They are not mandatory pre-push steps.

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run eval:retrieval
npm run eval:retrieval:quality
npm run eval:knowledge
npm pack --dry-run
npm run audit:prod
node scripts/tarball-smoke.mjs
```

## CI coverage and review reference

The detailed items below document regression coverage and compatibility expectations. Consult the relevant items when changing that area; do not turn this reference into a repeated manual release gate.

- [ ] CI passes on supported Node.js 22 and 24.
- [ ] Runtime dependencies and lockfile contain the local graph/embedding stack; the production audit has no unaccepted high/critical findings.
- [ ] The tarball contains the CLI, six skills, the document query adapter, current docs and the complete q8 ONNX model.
- [ ] The packaged local viewer serves its HTML/JS/CSS and current documents, rejects writes and foreign hosts/origins, and restarts pagination after source revisions. Desktop/mobile reading, empty/error states and classification changes are checked.
- [ ] Full/page document queries agree, return current fact-backed Markdown and dynamic category counts, and refuse stale revisions after writes or effective-time changes.
- [ ] Project-defined categories and reasons work; category-only edits preserve content/facts, append audit history, reject stale context and recover from write failures.
- [ ] Sealed drafts reject changed, deleted/recreated and newly occupied targets; unrelated writes remain valid. Reread/merge/reseal preserves newer knowledge. Old draft manifests require resealing.
- [ ] `draft preview` returns validated ordinary/fact-expanded Markdown with the sealed version and content hash; seal/ingestion agree on the version. Resealing, fact-time drift, tampering and unadopted target edits invalidate old evidence. Content delivery, declared review and user authorization are distinct, without a mandatory production read receipt.
- [ ] Replacement-source observation times, preserved historical facts and versioned related-page impact handoffs are covered by isolated agent scenarios; raw observations and semantic review are retained separately from deterministic checker fixtures.
- [ ] Real-source knowledge replay passes with source anchors intact. Recorded model decisions and simulated changes are labeled, and live model judgment is evaluated separately.
- [ ] The installed orchestration query script works from an explicit project root; a text clone can query without retrieval stores.
- [ ] The smoke test installs the release tarball using the repository's locked runtime dependencies in an isolated project. Offline installation requires a populated npm cache; normal CI prepares it with `npm ci`.
- [ ] `init --agent codex`, doctor, sealed capture, keyword search, real local semantic recall, full document/timeline reads and concepts work.
- [ ] Removing derived stores from a text clone causes hybrid recall to rebuild PGLite/pgvector projections without changing sources or timelines.
- [ ] Native Postgres + pgvector integration passes through `DOCNEXUS_TEST_DATABASE_URL`; local wire-protocol tests alone do not establish native server parity.
- [ ] Ordinary inserts, updates, deletion of all chunks and reinsertion retain the HNSW index; classification-only changes reuse vectors, and a failed relationship write rolls back the complete document projection.
- [ ] Deletion removes current knowledge, timeline and database projections; dangling fact references are refused.
- [ ] Process crash tests cover save, deletion, rollback, draft receipt recovery and lock release; concurrent updates preserve both timeline sources.
- [ ] Fact references generate attributed Markdown, refresh dependent pages and indexes, and recover with the canonical fact write without changing dependent timelines.
- [ ] Generated block repair preserves authored prose; missing references, deletion with references and preview drift/tampering are refused.
- [ ] `npm run eval:retrieval` reports vector/hybrid ranks on the fixed bilingual corpus.
- [ ] Chinese short terms do not admit isolated-character distractions, complete phrases/coverage outrank field weights, snippets show actual strongest evidence, and identifiers, aliases and active-fact lookup remain intact.
- [ ] Actual tokenizer budgets include headings, overlap and special tokens; long paragraphs, code and facts retain ending conclusions in offline pure-vector top-3 regression. Oversized queries fail explicitly, old chunk signatures rebuild and text/history remain unchanged.
- [ ] Alias resolution, future activation, expiry, withdrawal and cross-document replacement invalidate the appropriate projections without rewriting text.
- [ ] Tests cover relation ownership on update, embedding signature changes, retry after model failure, text failure compensation, project isolation and path boundaries.
- [ ] Real-runtime E2E uses the packaged ONNX model with a network sentinel. Deterministic hash tests do not replace this check.

## Documentation and compatibility

- [ ] Caller-selected categories use `draft seal --category` before review; exact names, optional/default reasons, sealed metadata hashes and audit history are preserved. Invalid inputs, late ingestion overrides, post-seal edits and stale targets are refused. The no-override path remains compatible.
- [ ] Viewer conditional requests bind ETags to revision, pagination and category; unchanged views return an empty 304 without HTML rendering. Source corruption and fact-time changes still invalidate or reject the request; frontend recovery fetches full content after an error.
- [ ] Budgeted evidence retains directly matched atomic facts and their current replacements before prose; source/status fields and complete JSON budgets remain valid. Record any omitted answer evidence as a quality failure, separately from consistency checks.
- [ ] The expanded retrieval suite validates source anchors and split labels, reports repository/simulation outcomes separately, and compares fixed candidates across window/section/page and both budgets. Default/CI runs development only; holdout comparisons are explicit and recorded. Initial failures remain in the baseline report.
- [ ] Both READMEs distinguish literal `search`, default hybrid `recall` and `recall --mode vector`.
- [ ] Documentation explains text truth, rebuildable databases and separate backup for custom model overrides.
- [ ] Workspace format remains 6, with no migration from earlier formats.
- [ ] Documentation distinguishes save dates from event dates and source history from compiled-page versions.
- [ ] Current architecture, product scope, roadmap and changelog match shipped behavior.
- [ ] Package metadata, license and security contact are correct.

Publishing requires the maintainer's authorization. Passing these checks does not publish the package.

## GitHub Actions publishing

`.github/workflows/release.yml` runs when a **stable GitHub Release is published** in `guilianerde/docnexus`. Draft releases, prereleases and ordinary commits do not trigger npm publication. Publishing a stable Release authorizes this workflow to publish its version to npm's `latest` tag.

One-time setup in the npm package's [settings](https://www.npmjs.com/package/@rowansenne/docnexus/access): add a GitHub Actions Trusted Publisher with organization/user `guilianerde`, repository `docnexus`, workflow filename `release.yml` (without a directory), and no environment name. Allow direct `npm publish`. No `NPM_TOKEN` repository secret is required. Follow the current [npm trusted publishing instructions](https://docs.npmjs.com/trusted-publishers/), including the first-publication deadline for a new binding; configure it when the next version is ready to ship.

For each release:

1. Update `package.json`, both root versions in `package-lock.json`, the package-version test, changelog and current documentation; commit and push the release changes.
2. Create a tag `v<package.json version>` on that commit, such as `v0.18.0`, and publish a GitHub Release for it. The workflow does not increment versions or create tags.
3. The workflow runs the existing Node.js 22/24 CI, including native Postgres tests, evaluations, audit and installed-tarball smoke. If it passes, Node.js 24 checks tag/manifest/lockfile agreement, packs the release and publishes that tarball with OIDC and provenance.
4. Check the workflow result and npm version/`latest` metadata. After fixing a transient failure, rerun the failed job. An already published version cannot be overwritten; release a new version for content changes.

Only the publish job receives `id-token: write`. Release builds disable npm dependency caching. Keep the workflow filename aligned with the npm Trusted Publisher configuration.

## Audit snapshot — 2026-10-14

The production audit passes the high/critical gate after upgrading the sharp override to `^0.35.5`. Five moderate findings remain in the `sprintf-js → roarr → global-agent → onnxruntime-node → transformers` dependency chain. The underlying [sprintf-js advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) has no patched release; npm proposes a breaking Transformers upgrade. Evaluate that upgrade separately rather than treating this gate as a zero-vulnerability result.

## Workspace-local installation

- [ ] Default init works without Git. Optional `init --git-remote` configures only the knowledge origin, excludes it from an existing host repository and refuses host-tracked files without changing its index.
- [ ] New knowledge repositories pin `main`; existing repositories retain their single current branch. Branch mismatch, detached HEAD and extra local branches block operations before recovery. Reset retains the pin, history, remote and npm installation; clones explicitly configure a new local pin.
- [ ] The installed tarball includes `workspace-git.js` and exercises opt-in setup, branch refusal and Git-preserving reset. Documentation distinguishes the local guard from Git command interception or remote branch protection.
- [ ] Install the tarball under docnexus/ in a host project without npm files. Init, capture, category search/recall, viewer and the query adapter work without adding root package.json, package-lock.json or node_modules.
- [ ] Init preserves the installation and host manifests, rejects unrelated nonempty directories, and does not create docnexus/docnexus when invoked from the project root or with an explicit project root.
- [ ] Reset clears knowledge and agent integration while preserving the nested manifest, lockfile and executable; reinitialization works. Legacy root installations and query adapters still work.
