# Changelog

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
