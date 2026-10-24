# Changelog

## 0.28.1 — 2026-10-25

- Normalize the worker regression fixture’s temporary project path before constructing its Git context, matching the CLI entry point on macOS. Runtime behavior is unchanged from 0.28.0; 0.28.0 was not published to npm because release verification stopped at this fixture.

## 0.28.0 — 2026-10-25

- Coalesce merge-worker requests behind one crash-released lease per Git index, retaining events received during processing and shutdown. Report Git hook health in CLI init and doctor, checking script contents, executable permissions, the CLI file and Node on PATH; automatic setup failures remain nonfatal and non-Git projects are explicitly skipped.

- Check repaired-merge index signatures before loading Git blobs, and wait for unresolved content using index entries alone. Reuse the captured entries when a full snapshot is required. Batch parent-path lookups with bounded command arguments and read both parents' record/metadata blobs through one `cat-file --batch`, retaining identity, file-mode, hash and fact-history checks.

## 0.27.1 — 2026-10-23

- Reject project-relative library prefixes in `draft seal --file` before writing the seal or changing metadata. Return a corrected library-relative path and retry command preserving the draft id, base version and category arguments. Match only the configured library prefix, preserving legitimate nested paths and existing record reads.
- Return the final project-relative `library_path` from draft sealing and preview alongside the library-relative `file_path`. Align CLI help, validation errors and extraction guidance with these path meanings.

Compatibility: workspace format 7, draft manifest format 3 and projection schema 2 remain unchanged. Existing records with duplicated library prefixes remain readable; this release does not relocate them.

## 0.27.0 — 2026-10-23

- Check catalog-wide document-path uniqueness when staged records change, without hashing unrelated document assets. Install `pre-merge-commit` alongside `pre-commit` so conflict-free automatic merge commits also validate staged knowledge. npm installation/upgrades and CLI init automatically install/update hooks in initialized Git projects, including older scripts and the new hook. Projects without Git skip setup; failures warn without aborting package installation or initialization.

Compatibility: workspace format 7, draft manifest format 3 and projection schema 2 remain unchanged. Hook setup is automatic; existing installations are updated in place and `docnexus git hooks install|uninstall` remain available for manual maintenance.

## 0.26.1 — 2026-10-22

- Update the knowledge-evaluation README evidence excerpt after the documentation rewrite so release verification can replay the fixture; runtime behavior is unchanged. 0.26.0 was not published to npm because verification stopped at this fixture.

## 0.26.0 — 2026-10-22

- Add opt-in native Git hooks: persist unresolved/resolve-undo conflicts tied to merge parents, automatically sync reviewed staged contents and atomically stage generated records/views/navigation, then validate the staged knowledge before commit. Preserve existing native hooks, support uninstall, refuse unstaged knowledge overwrites and custom hook-manager rewrites, and guard index locks, worktrees and recursion. Semantic conflict resolution and Git commits remain user-owned.

- Skip knowledge validation for code-only commits, hash only affected document units for ordinary knowledge edits (reading only changed records, with a full-catalog fallback for library-only changes), and reuse verified Git-object checkpoints for repaired merges. Preserve necessary cross-document fact/reference checks, give unadopted prose a document-sync recovery action, reject rebase/cherry-pick/revert immediately, and resolve native hook runtimes through project-relative paths and PATH. Missing runtimes no longer block code-only commits; existing hook installations need one reinstall to update their scripts.

- Timestamp every queued merge-repair log line with ISO 8601 and rotate the log at 64 KiB into one `git-merge.log.1` backup. Worker start, outcome and failure entries stay attributable without unbounded file growth.

- Write an editable `docnexus/categories.md` starter list during initialization with suggested project categories such as `pitfalls` and `templates`. Extraction reads it as guidance only: the CLI never reads it, it is not an allow-list, and category counts still derive from document metadata. Re-init preserves existing edits and rejects symlinked guide paths.

Compatibility: workspace format 7, draft manifest format 3 and projection schema 2 remain unchanged. Git hooks stay opt-in; installations created by an earlier build need one `docnexus git hooks install` to replace absolute-path scripts. No new migration is required.

## 0.25.0 — 2026-10-22

Compatibility: workspace format 7, draft manifest format 3 and projection schema 2 remain unchanged. CLI `document get` now defaults to the current body; use `--include` for metadata, source, template or timeline. Refined ingestion/adoption enforces a 4000-character rendered-body limit, with semantic splitting handled by the agent. Existing long documents remain readable. The legacy format 1–6 installation cleanup policy is unchanged.

Release validation: the maintainer explicitly requested skipping tests for this release. The v0.25.0 release skips CI verification and retains the OIDC version checks and package build; subsequent release tags retain the normal verification workflow.

- Limit refined rendered Markdown to 4000 Unicode characters at sealing, preview, ingestion and hand-edit adoption; report document_too_long and guide agents to split by meaning into independent drafts. Preserve provenance and existing long-document reads. CLI document get now defaults to current Markdown only; other assets require --include.

- Read record lists and current-knowledge snapshots with 24 bounded workers, retaining input order and draining started reads before releasing the lock on failure. Reuse directory entries and pending/completed path checks within a snapshot to avoid repeated lstat calls; metadata and Markdown reads overlap while content hashes remain checked.
- Filter standalone English filler words in multiword keyword queries while preserving original phrases, negation and literal lookups. Prioritize exact normalized titles, paths and filenames (optionally without .md), and cite matching names through metadata anchors. Hybrid recall uses the updated lexical ranks while retaining the original embedding query and RRF.

## 0.24.3 — 2026-10-22

- Load only records, metadata and current Markdown in query/index snapshots; retain body and metadata hash validation while moving source/history integrity checks to doctor, explicit reads and writes. Reuse root/output resolution and shared directory checks within each locked snapshot, without mtime or cross-request caches.

- Query snapshots read three knowledge files per document instead of five and validate two asset content hashes instead of four. Source/history damage no longer blocks current knowledge queries; unadopted Markdown/metadata edits, fact-time changes and symbolic links are still detected. Current scans remain O(N).

Compatibility: workspace format 7, draft manifest format 3 and retrieval projection schema 2 are unchanged. Format-7 data is preserved; the existing install-time deletion policy for recognized legacy formats 1–6 remains in effect.

## 0.24.2 — 2026-10-21

- Upgrade markdown-it to 15.0.3 to fix GHSA-gfr2-rv44-r23c and GHSA-vfgh-jcmw-g37q; production audit reports zero vulnerabilities. Separate cold database startup allowance from the unchanged five-second inference-lock concurrency assertions.
- Fix cross-platform release checks: normalize source and knowledge-workspace line endings, inspect every component of portable paths on Windows, and run npm and CLI JavaScript through Node instead of Windows command shims in installation verification. Preserve native Windows junction behavior in tests.

Breaking change: workspace format 7; old workspaces are unsupported and no migration is provided. Draft manifest format 3 and retrieval projection schema 2 are unchanged.

- Add npm postinstall cleanup that forcibly deletes recognized legacy root workspaces, old knowledge/history and obsolete integration, while preserving the new npm runtime and format-7 data. Refuse installation inside the old docnexus/ prefix; skip source checkouts, global installs, npx caches and transitive dependencies.
- Move the project-local npm installation, packaged skills, schema, drafts, retrieval indexes and recovery/usage state to `.docnexus/`.
- Add `init --output-dir <project-relative-parent>` for knowledge Markdown, source records, impact history and readable concept navigation. Always create a `docnexus/` child under that parent; default the parent to the project root. Persist the parent in `.docnexus/project.json` and return configured paths from CLI results, search, document queries and status.
- Generate agent context and navigation using the configured directory, and apply it to durable write recovery, reset and optional knowledge Git setup. Reject output directory changes on initialized projects and unsafe or occupied destinations.

## 0.24.1 — 2026-10-21

Not published to npm: production dependency audit detected markdown-it denial-of-service vulnerabilities, and slow CI runners exceeded the concurrency fixture's cold-start deadline. Superseded by 0.24.2, which updates the dependency and separates startup waiting from lock assertions.

## 0.24.0 — 2026-10-21

GitHub release verification failed before npm publication because a retrieval-evaluation source excerpt retained an old documentation version and Windows validation exposed path, line-ending and command-shim assumptions. Not published to npm; superseded by 0.24.1. The fixture now anchors the unchanged architecture description without a release-number prefix; questions, evidence labels and scoring criteria are unchanged.

## 0.23.0 — 2026-10-18

Compatibility: workspace format 6, draft manifest format 3 and retrieval projection schema 2 remain unchanged. Existing format-6 workspaces need no reset. Skills refresh on the next workspace command. Re-run `docnexus init --agent claude|codex|all` to refresh the agent rules block in `AGENTS.md`/`CLAUDE.md` and generate `docnexus/concepts/`; the next memory write also regenerates the concept files.

- Split `docnexus/CONCEPTS.md` into a short category map (at most 3 KB) and generated per-category files under `docnexus/concepts/`. Every file stays within 32 KB; oversized categories become a hub plus paged per-type files. `concepts --category <name>` lists one domain. Stale generated files are removed; hand-placed files are kept.
- Agents decide from the task whether to recall, not from the map: a topic missing from the map is never a reason to skip. Capture searches and recalls first and browses category files only to disambiguate. Prefer domain categories over document genres.
- `draft seal` validates fact chains on every seal and reports all issues at once in `knowledge_conflict` `details.issues[]`, each with the field, problem and a field-specific fix. `facts.md` adds a change-to-repair table.
- `impact save` returns a summary (per-page decision, status and `needs_review`); read full evidence and history with `impact get`.
- `target_changed` errors point `next_action.argv` at the full reread of the changed page.
- Related-page impact candidates must come from search and recall for the changed claim; catalog- or title-only scopes are limited and marked unverified.
- `eval:agent` checks task order and final state, adds `archive`/`check-archive` for byte-exact run archives, forbids rework after review, and adds a retrieval-trigger scenario (`prepare --scenario retrieval`) with one fresh context per task.

## 0.22.1 — 2026-10-18

Compatibility: workspace format 6, draft manifest format 3 and retrieval projection schema 2 remain unchanged. Existing format-6 workspaces need no reset. Previously tracked package copies require an explicit index-only migration to stop tracking them; knowledge and npm manifests/lockfiles remain versioned.

- Keep consumer workspaces' six official skill copies, version stamp and generated metadata schema local with precise Git ignore rules. Preserve custom skill names, knowledge and dependency manifests/lockfiles; initialization restores local assets and agent links after a clone. Existing tracked copies require an explicit index-only migration; workspace format remains unchanged.

## 0.22.0 — 2026-10-18

Compatibility: workspace format 6, draft manifest format 3 and retrieval projection schema 2 remain unchanged. The embedding runtime change re-embeds existing projections on the next `recall` or `index sync`; text and timelines are untouched.

- Upgrade `@huggingface/transformers` to 4.3.1 (`onnxruntime-node` 1.30.0), clearing the five moderate `sprintf-js` audit findings. Tokenization is unchanged; q8 vectors shift slightly and the development retrieval set showed no keyword/hybrid change.
- Ship a smaller package: exclude source maps, type declarations and raw evaluation baselines (200 → 97 files).
- Split CLI dispatch into a command table (`cli-commands.ts`) and shared argument helpers (`cli-options.ts`) without changing command behavior.
- Run tests and the tarball smoke test on macOS and Windows in CI; Windows is advisory until its first green run.
- Move per-round validation figures from the roadmap to a separate validation history page.

## 0.21.0 — 2026-10-17

Compatibility: workspace format 6, draft manifest format 3 and retrieval projection schema 2 remain unchanged. Existing format-6 workspaces need no data migration; package-version synchronization refreshes installed skills.

- Persist related-page impact work as independent text records with source/read versions, original decisions and appended status history. Add `impact save/list/get/set`, idempotent capture, stale-context review flags (including fact-time changes) and revision-guarded acknowledgments. Keep draft attachments resumable without claiming atomicity with primary ingestion; workspace/draft/projection formats are unchanged.
- Integrate impact commands with opt-in local usage recording using only pseudonyms and counts, excluding review evidence and reasons.

## 0.20.0 — 2026-10-17

Compatibility: workspace format 6, draft manifest format 3 and retrieval projection schema 2 remain unchanged. Existing format-6 workspaces can upgrade without reset or data migration. Skills refresh on the next workspace command after the package version changes; `skills sync` can refresh them explicitly.

- Add read-only `draft preview --id` with validated sealed Markdown, content hash and manifest fingerprint; seal and ingestion return the same `sealed_version`. Preserve workspace/draft/projection formats and existing authorization rules without adding a mandatory read receipt.
- Ground replacement-source observation times in explicit source evidence and require related-page impact handoffs with read versions, evidence and unresolved candidates. Keep semantic judgments in skills and use separate drafts for authorized related edits.
- Extend isolated agent evaluation with source-time, preview delivery/review declarations and cross-page maintenance scenarios; distinguish mechanical checks from semantic review.

## 0.19.0 — 2026-10-17

Compatibility: workspace format 6, draft manifest format 3 and retrieval projection schema 2 remain unchanged. No reset or migration is required. Git remains optional; configured knowledge repositories require Git for their local branch guard.

- Add opt-in `init --git-remote <url>` for a separate knowledge repository. Keep Git optional by default, refuse host-tracked workspace files without changing the host index, configure only the workspace origin, and preserve Git history/configuration across knowledge reset and reinitialization. Setup does not commit or contact a remote; workspace, draft and projection formats are unchanged.
- Pin configured knowledge repositories to one local branch (`main` when new, the current branch when adopting). Reject DocNexus operations before recovery on branch mismatch, detached HEAD or extra local branches; retain the pin outside the checkout across reset. This is a local preflight guard, not a Git-command interceptor or server-side branch restriction; clones must configure their own pin.

## 0.18.0 — 2026-10-16

Compatibility: workspace format 6, draft manifest format 3 and retrieval projection schema 2 remain unchanged. No reset or migration is required. Usage recording is off by default and enabled per project.

- Add opt-in, local-only CLI and viewer query observation with project-keyed pseudonyms, bounded JSONL storage, a single-file JSON export and explicit query feedback. Record latency, model/database/index work, fusion retention and evidence budgets without query text, document content, paths or credentials. Recorder failures do not change ordinary command outcomes.

## 0.17.1 — 2026-10-16

Compatibility: workspace format 6, draft manifest format 3 and retrieval projection schema 2 remain unchanged. No reset or migration is required.

- Remove the local viewer's 15-second polling and refresh on returning to the tab. Load documents on opening, manual refresh, or category/page changes; retain revision checks, error recovery and HTTP ETag/304 support.
- Update viewer guidance and empty states to describe manual refresh.
- Add GitHub Release publishing through npm trusted publishing, with the existing Node.js 22/24 CI required before publication.

## 0.17.0 — 2026-10-15

Compatibility: workspace format 6, draft manifest format 3 and retrieval projection schema 2 remain unchanged. Existing root npm installations remain supported. New installations keep npm assets under `docnexus/`; reset preserves those installation entries and reports `preserved_installation: true`. No knowledge reset or migration is required.

- Isolate consumer npm manifests, lockfiles and dependencies under `docnexus/`. Allow initialization over a recognized installation, prefer the nested CLI in skills and query adapters while retaining root-install compatibility, ignore runtime dependencies in Git and preserve the installation when resetting project knowledge.

- Require capture skills to search and read existing knowledge before allocating a draft, then hand off create/update/skip/conflict decisions and read versions for review. Check direct ready-draft ingestion too, preserve independent reports and caller classifications, and retain existing version/sealing guards without changing manifests. Document semantic decisions as agent behavior, with separate model review scenarios.

## 0.16.0 — 2026-10-15

Compatibility: workspace format 6, draft manifest format 3 and retrieval projection schema 2 remain unchanged. Existing format-6 workspaces require no reset. Category-scoped vector retrieval ranks the eligible subset exactly; broad categories may be slower than unfiltered HNSW retrieval.

- Add exact, case-sensitive `--category` filters to search and both recall modes, including budgeted evidence. Filter keyword/vector candidates before limits and fusion, constrain graph expansion, and use current canonical classifications without a projection schema change. `uncategorized` includes legacy documents with no category; referenced facts retain their canonical owners.

## 0.15.0 — 2026-10-15

Compatibility: workspace format 6 and draft manifest format 3 remain unchanged. Derived retrieval schema 2 rebuilds known older projections from canonical text on the next sync/recall; sources, histories and pending drafts are preserved. Unknown or newer projection schemas are refused.

- Version the derived retrieval schema independently of canonical text. Rebuild known legacy projections transactionally from text, diagnose version/shape mismatches, and refuse unknown/newer schemas without losing sources or drafts.
- Carry versioned body ranges, fact identities and metadata anchors through indexing, keyword/vector matches and evidence assembly. Refresh cross-document owner versions while reusing unchanged vectors, locate repeated paragraphs correctly, and reject stale anchors.
- Reserve compact primary evidence across candidates before expanding requested context. Retain both retrieval arms, directly matched fact states and distant hits while preserving citation, lifecycle and complete-response budget checks.
- Let users and calling skills supply an exact category through `draft seal --category`, with optional `--category-reason`. Seal the resulting metadata before review, preserve it through ingestion and record the classification in audit history. Skills skip model classification for that write; later authorized reclassification remains possible. Workspace format 6 and draft manifest format 3 are unchanged.
- Prioritize directly matched atomic facts in budgeted evidence, including current replacements of historical references, before prose consumes the budget. Preserve attribution, lifecycle state and complete-response budget checks.
- Add view-specific weak ETags and conditional polling to the local document viewer. Unchanged views return an empty 304 without HTML rendering or full-body transfer; canonical integrity, fact-time and revision checks still run.
- Add a source-anchored retrieval quality suite with 30 answerable repository-authored questions, six unsupported questions and eight explicit simulations. Separate development/holdout target families, reuse fixed candidates across delivery units and budgets, retain failures in the initial baseline report, and run development checks in Node.js 24 CI. Mechanical coverage remains separate from host-agent answer and abstention quality.

## 0.14.0 — 2026-10-15

This release includes the previously unpublished 0.6–0.13 work, including the PGLite/Postgres engine, fact lifecycle, hybrid recall and local document viewer.

Compatibility: workspace format 6 only; the previously published 0.5.0 used format 5. Back up older workspaces and retain their sources before choosing a new workspace or an explicit reset. There is no automatic format-5 migration. Pending draft manifests 1/2 require rereading, merging and resealing as format 3. Existing format-6 documents and histories remain usable.

- Add a shared typed operator-error registry, `--json` failure envelopes, protocol discovery and structured doctor findings.
- Add opt-in window/section/page evidence packets with source versions, explicit observation dates, atomic fact status and a complete-response conservative budget. Preserve the existing unbudgeted recall shape.
- Add a fresh-context agent acceptance entry with randomized facts, observed CLI receipts, durable-state checks and mandatory semantic review; fixture replay is kept separate from model-quality evidence.

- Reuse validated operation snapshots across search and retrieval; read each canonical asset once per snapshot and render only the requested document page. Resolve facts at one snapshot time.
- Return document `record_version` and require updates to seal with the extraction read’s `--base-version`. Use draft manifest format 3; pending format-1/2 drafts require rereading, merging and resealing.
- Separate vector candidates from final context expansion, fill document candidates crowded out by long documents, cap graph evidence in SQL and batch neighboring chunks.
- Compute model probes and embeddings outside the project lock. Recheck text/fact revisions and index generations before committing, retry conflicts up to three times, and keep database lifetimes and final retrieval serialized.
- Separate workspace reads, pure knowledge rules and draft ingestion coordination while retaining document/receipt crash recovery.

## 0.13.0 — 2026-10-15

- Replace the SQLite retrieval ledger and LadybugDB vector/graph stores with shared PostgreSQL + pgvector SQL. Use zero-configuration PGLite locally or `DOCNEXUS_DATABASE_URL` for an existing Postgres server.
- Maintain HNSW incrementally during ordinary writes; reuse unchanged chunk identities and vectors, including classification-only updates. Document, chunk and relationship projections commit in one database transaction.
- Keep format-6 canonical text, local embeddings, Chinese text search, facts, timelines, skills and the document browser. Initialize retrieval lazily; text access stays independent of database availability.
- Reset only the selected remote project schema before removing local data. Add PGLite persistence, incremental indexing, transaction rollback and Postgres wire-protocol tests; CI also exercises native Postgres + pgvector.

## 0.12.1 — 2026-10-15

Improve Chinese literal lookup precision and the evidence passed to hybrid recall.

- Supplement segmentation with adjacent Han character pairs and remove isolated Han matches from multiword queries, retaining explicit one-character lookup.
- Rank complete phrases before partial evidence, then query coverage before field weights, so a generic title cannot outrank a full body phrase.
- Select the strongest snippet from body lines, active facts and names/aliases; omit misleading line numbers for metadata-only hits and keep complete phrases visible on long lines.
- Preserve English identifiers, paths, normalization and fact validity. Keep the response shape, RRF fusion and existing indexes unchanged.

## 0.12.0 — 2026-10-14

Bound long-document embeddings with the actual local tokenizer and retain content beyond the former paragraph window.

- Split oversized paragraphs, code and active-fact projections into chunks of at most 256 tokens including special tokens and heading context, with natural boundaries, small overlaps and intact Unicode characters.
- Read tokenizer/model input limits from the offline pipeline and reject oversized embedding inputs and queries before automatic truncation.
- Track chunk strategy and model token-limit signatures so the next sync/recall rebuilds older derived indexes without rewriting canonical documents or history.
- Add offline pure-vector regression for ending conclusions in long paragraphs, code and facts, plus coverage and index invalidation tests. Preserve workspace format 6 and draft manifest format 2.

## 0.11.1 — 2026-10-14

Prevent a sealed update draft from overwriting knowledge saved after its review.

- Record the target document version at sealing and recheck it under the project lock before ingestion, including prose, sources, classification, history and document identity.
- Refuse changed, deleted/recreated or newly occupied targets even with `--replace`; unrelated writes and unchanged classifications remain valid.
- Use draft manifest format 2; existing ready format-1 drafts require rereading and resealing. Workspace format 6 and stored knowledge are unchanged.
- Teach extraction/ingestion skills to reread and merge current knowledge before resealing stale drafts.
- Add `eval:knowledge` and CI replay of five real repository documents covering classification, fact ownership/replacement, provenance and stale-draft merging. Report recorded decisions separately from unmeasured live model quality.

## 0.11.0 — 2026-10-14

Browse current project knowledge through a local read-only document viewer.

- Add `docnexus view [--port 0]`, bound to loopback with one fixed initialized project and no long-lived project lock.
- Show dynamic categories, paginated current Markdown, classification reasons, tags and fact provenance/lifecycle states in a responsive reading layout.
- Refresh manually or poll visible pages every 15 seconds; discard stale snapshots and restart pagination after writes, classification changes or effective fact changes.
- Bundle local UI assets and HTML-disabled Markdown rendering; block mutation methods, foreign origins and hosts, arbitrary file reads and automatic image loads.
- Preserve workspace format 6 and the existing CLI/Node query contract, without another document source or model service.

## 0.10.0 — 2026-10-14

Let the orchestration model evolve document categories from project context and existing knowledge.

- Accept project-defined category names and optional classification reasons, retaining old display labels without treating them as a fixed taxonomy.
- Derive viewer navigation from categories actually used by documents; return each document's classification basis.
- Add `document classify` for category-only changes with reasons and optional revision guards, preserving facts, source and Markdown while appending recoverable audit history.
- Record category changes and reasons in normal capture/update history too.
- Teach skills to read project context and related documents, reuse existing categories and adjust affected classifications within existing authorization. Query remains deterministic and read-only; no background model service is added.

## 0.9.0 — 2026-10-14

Expose categorized current documents as full or paginated JSON for human-facing viewers.

- Add `document query` and a thin orchestration script with complete rendered Markdown, category counts, fact provenance and effective status.
- Add optional primary metadata categories chosen by extraction/update skills; legacy documents without a category display as uncategorized.
- Use deterministic file-path ordering and optional snapshot revision checks to refuse pagination across writes, reclassification, deletion or effective-time changes.
- Read canonical text and render display expressions in memory, without loading embeddings, building retrieval stores or maintaining another document source.
- Preserve existing document list/get behavior and workspace format 6. Document the CLI, script and Node query contract for visualization consumers.

## 0.8.0 — 2026-10-14

Define structured facts once and generate their current Markdown expressions automatically.

- Add standalone `{{fact:fact_id}}` references and attributed, read-only generated Markdown blocks, following effective replacement chains across documents.
- Refresh dependent views in the fact write's recoverable transaction, preserving dependent source, timeline and record identity. Reads, search and index sync refresh elapsed-time changes; `document render` refreshes all views explicitly.
- Expose author-owned prose and reference placeholders through `document get --include template`, without another stored template file. Canonical document hashes exclude generated block contents.
- Include referenced facts and rendered-document hashes in retrieval context and projection signatures, invalidating stale dependent indexes automatically.
- Seal generated draft previews and refuse tampering or changed effective facts before ingestion. Reject missing references and deletion of referenced definitions.
- Preserve free-prose edit adoption and existing format 6 documents. Old hand-written duplicates require reviewed conversion to references; there is no background refresh timer or automatic semantic rewriting.

## 0.7.0 — 2026-10-14

Make project memory writes recoverable, retrieval hybrid, and fact validity explicit.

- Serialize local CLI and core memory/index operations with a process-safe project lock released on process exit.
- Persist text transaction intent and rollback images, recovering interrupted saves, deletion and draft ingestion receipts before subsequent reads.
- Default `recall` to document-level keyword/vector RRF fusion with source ranks and lexical evidence; retain `--mode vector` for comparison.
- Resolve explicit entity aliases across search, concept directories and graph endpoints; refuse ambiguous identity claims.
- Add optional immutable fact identities, attribution, effective time, expiry, explicit replacement and withdrawal; expose `facts list` with alias and effective-time filtering.
- Invalidate affected projections when aliases or fact validity change, including cross-document replacement, without rewriting confirmed text or timelines.
- Add process crash/concurrency tests and an offline bilingual retrieval regression corpus with a reproducible vector/hybrid evaluation command.
- Keep workspace format 6 and the SQLite, LadybugDB and bundled local model stack. Earlier formats remain unsupported.

## 0.6.0 — 2026-10-14

Keep compiled current knowledge and source timelines beside rebuildable local retrieval stores.

- Store current Markdown knowledge separately from source-attributed timeline events; identical writes do not add history.
- Keep SQLite document/chunk projections and LadybugDB vectors and typed relationships, with the bundled offline BGE q8 ONNX embedding model.
- Add keyword/name `search`; `recall` provides vector matches, neighboring chunks and one-hop graph evidence.
- Synchronize derived indexes automatically before semantic recall, without rewriting sources or timelines. Detect model-output changes and retry incomplete projections.
- Attribute graph edges to their declaring document, remove superseded assertions on update, and expose relationship source paths for citations.
- Preserve sealed drafts, authorized writes, hand-edit adoption, project isolation and Git portability.
- Allow entity-free documents in both the directory and semantic recall.
- Keep workspace format 6 with no migration from earlier formats. Format 6 text workspaces can build the new derived indexes directly.
- Remove historical design documents and update skills, current documentation and installed-package verification.
