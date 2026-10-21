# DocNexus

[中文说明](./README.zh-CN.md)

DocNexus is local project memory for coding agents such as Codex and Claude. Inspired by [GBrain](https://github.com/garrytan/gbrain), it keeps compiled current knowledge beside a source-attributed timeline. Skills refine, find and read knowledge; a thin CLI manages text and rebuildable PostgreSQL + pgvector projections, using embedded PGLite by default or an external Postgres connection.

Agents consult memory proactively. Every memory write requires user authorization. Keyword lookup reads text directly; default recall fuses keyword and local vector ranks with one-hop graph evidence. The CLI makes no external LLM calls, and the default quantized ONNX model ships with the package for offline loading.

> 0.24.0 breaking change: workspace format 7 separates `.docnexus/` program files from configurable knowledge output. Installation forcibly deletes recognized legacy workspaces, including knowledge, sources and history; no data migration is provided. Draft manifest format 3 and projection schema 2 are unchanged.

## Installation cleanup

This breaking release runs destructive cleanup from npm `postinstall`. It removes recognized legacy `docnexus/` directories at the consuming project root, including knowledge, sources, runtime and any contained Git history. It also clears legacy data in `.docnexus/`, preserving its npm manifests, lockfile and `node_modules/` so the newly installed runtime remains usable. Legacy markers use DocNexus format 1–6; uninitialized old `docnexus/` installations must contain only npm installation files and a DocNexus dependency in their manifest. Old skill links and marked agent instructions are removed. There is no extra confirmation, migration or backup.

Install with `npm install --prefix ./.docnexus --save-exact @rowansenne/docnexus`; the old `--prefix ./docnexus` location is refused before deletion. Reinstallation preserves format-7 data. Unrecognized directories and external symlink targets are preserved. Global installs, temporary npx caches, transitive dependencies and source checkouts skip project cleanup. Disabling lifecycle scripts with `--ignore-scripts` skips cleanup; initialization continues to refuse legacy workspaces.

## Quick start

Requires Node.js 22.13.0 or newer and npm. Run in the target project:

```bash
mkdir -p .docnexus
npm install --prefix ./.docnexus --save-exact @rowansenne/docnexus
./.docnexus/node_modules/.bin/docnexus init --output-dir docs/knowledge --agent codex  # or claude / all
./.docnexus/node_modules/.bin/docnexus doctor
```

The installation manifest, lockfile, runtime, skills, schema, drafts and retrieval indexes stay in `.docnexus/`. `init --output-dir <parent>` selects a project-relative parent; the knowledge workspace is always `<parent>/docnexus/`. For example, `--output-dir workfull` creates `workfull/docnexus/`. Omit it to use the project root as parent and `docnexus/` as workspace. The setting is saved in `.docnexus/project.json` and reused by later commands. `status` returns `workspace_path`, `library_path` and `internal_directory`. Output cannot point outside the project or into internal/agent directories, and cannot be changed after initialization without an explicit reset. Run from the project root, or pass `--project-root <project>` from elsewhere. Update with `npm install --prefix ./.docnexus --save-exact @rowansenne/docnexus@latest`; restore dependencies with `npm ci --prefix ./.docnexus`.

The agent decides from the task when to search project memory; `docnexus/CONCEPTS.md` is a short category map that routes to one concept file per domain under `docnexus/concepts/`. Ask it to remember a decision, explain a project convention or list saved documents.

## Workspace

```text
.docnexus/
  package.json, package-lock.json  # isolated npm installation
  node_modules/                   # reinstallable runtime, Git-ignored
  project.json                    # format 7 + output_dir
  skills/                         # packaged skills and version, Git-ignored
  schemas/                        # generated metadata schema, Git-ignored
  drafts/<draft_id>/              # source, document, metadata, manifest; Git-ignored
  .runtime/                       # recovery journal and local usage; Git-ignored
  store/                          # rebuildable PGLite/pgvector index, optional models

docs/knowledge/docnexus/          # --output-dir docs/knowledge; default: docnexus/
  CONCEPTS.md                     # generated readable category map (≤ 3 KB)
  concepts/                       # generated readable category navigation
  impacts/                        # related-page impact history
  library/                        # current knowledge Markdown
  records/<id>/                   # source.md, metadata.json, timeline.md, record.json
```

Examples below use the default `docnexus/` knowledge path; substitute your configured output. Prefer the actual `library_path`, artifact and timeline paths returned by the CLI. Readable navigation updates when documents are saved. Retrieval indexes under `.docnexus/store/` are generated on the next `recall` or explicit `index sync`, and can be rebuilt from text.

`library/` contains current knowledge; the timeline records how it changed. Before updating a page, the agent reads its existing knowledge and timeline, preserves valid facts, replaces explicitly superseded conclusions and identifies unresolved conflicts. The CLI saves the reviewed author-owned text and fact references, renders fact blocks and appends an event when authored content or metadata changes. View-only refreshes add no event. An identical write adds no event.

Before each capture, the agent must search/recall existing knowledge and read plausible candidates in full. It chooses an existing-page update, a separate new document, a duplicate skip, or an unresolved conflict, and carries the reason and read versions into review. Distinct review reports/events remain separate; related durable pages need their own authorized updates. Direct ingestion of a ready draft also checks this decision. This is a skill workflow, not CLI-enforced semantic deduplication. See [capture resolution](skills/docnexus-extract/references/capture-resolution.md).

Timeline dates are save times, not necessarily the dates of events described in a source. Keyword and vector indexes exclude source material and timelines; request the timeline for historical questions. Entities and relationships project to graph nodes and edges; edges retain the declaring document and description. Both arrays may be empty, and entity-free documents still support semantic recall. Generated category files list documents even without entities. The root map stays within 3 KB; every generated category file stays within 32 KB: larger categories keep a hub file and page their concepts by entity type (`concepts/<category>/<type>.md`, `<type>-2.md`, …). Use `document list` and `concepts` for the full information.

## Find, read and answer

```bash
./.docnexus/node_modules/.bin/docnexus search "Refresh token" --limit 5
./.docnexus/node_modules/.bin/docnexus recall "When should refresh tokens rotate?" --limit 5
./.docnexus/node_modules/.bin/docnexus document get --id <id> --include document,metadata
./.docnexus/node_modules/.bin/docnexus document get --id <id> --include document,timeline
```

Use `--category codeReview` on `search` or `recall` to search an exact, case-sensitive project category; it also works with `--mode vector` and budgeted evidence. Filtering applies before candidate limits/fusion and to graph supporting documents and relation owners. `--category uncategorized` includes documents with no category; an unknown category returns no results. Referenced facts retain their canonical owners, including across categories. Omit the option to search all categories.

Search literally matches current bodies, paths, titles, summaries, tags, canonical entity names/aliases and active facts. `recall` uses the bundled `BAAI/bge-small-zh-v1.5` q8 ONNX model for 512-dimensional vectors and fuses keyword/vector document ranks with RRF. Each document contributes once and returns one representative chunk, neighboring chunks and one-hop graph evidence. `ranking.rrf_score` orders hybrid results; `source_ranks` and `keyword_match` expose the evidence. `matched_chunk.score` is vector similarity only, zero for keyword-only candidates. Use `--mode vector` for the original chunk-level vector mode. Graph support does not alter primary ranking. Scores are not truth confidence; cite a relationship’s declaring `source_path`.

The agent reads the complete selected document and cites `docnexus/library/<file_path>` in its answer. Ordinary prose can be read directly; use document get before citing a file with generated fact blocks so effective-time changes are refreshed. It states evidence gaps and conflicts with current code or instructions.

Chinese literal lookup supplements word segmentation with adjacent Han character pairs and removes isolated Han characters from multiword queries; intentional one-character queries remain supported. Ranking prioritizes complete phrases, query coverage and field weights, in that order. Snippets show the strongest evidence; metadata-only or structured-fact matches may omit a body line number. English identifiers and paths retain literal matching. Multiword queries still admit partial evidence, and lexical scores are not confidence.

Optional metadata entity `aliases` resolve alternative names to canonical graph identities. Optional `facts` track stable ids, mandatory provenance and timezone-qualified effective times, explicit `replaces`, expiry and withdrawal. Only active facts generate extra retrieval chunks; historical fact entries remain. Define a fact once in its owner metadata and reference it on a standalone `{{fact:fact_id}}` line in any project document. The CLI generates attributed Markdown blocks and follows effective replacement, expiry and withdrawal. Skills maintain explanations; existing free-prose duplicates need one reviewed conversion to references. See the [fact workflow](skills/docnexus-extract/references/facts.md). `document get --include template,metadata` returns the editable structure; `document render` refreshes all generated blocks. There is no background timer; document reads, search and index sync refresh effective-time changes.

```bash
./.docnexus/node_modules/.bin/docnexus facts list --entity "<canonical name or alias>" --include-inactive
./.docnexus/node_modules/.bin/docnexus facts list --at "2026-10-14T12:00:00+08:00" --include-inactive
```

## Local usage observation

Opt into local records, then export one JSON file for optimization analysis. Records include command latency, error codes, pseudonymous query/document identities, retrieval and evidence metrics, index work and embedding calls. Query text, document content, paths and credentials are excluded. Nothing is uploaded; recording is off by default.

```bash
./.docnexus/node_modules/.bin/docnexus usage enable
./.docnexus/node_modules/.bin/docnexus usage status
# Optional explicit feedback on the last search/recall:
./.docnexus/node_modules/.bin/docnexus usage feedback --rating miss --reason needs_multihop
./.docnexus/node_modules/.bin/docnexus usage export > .docnexus/.runtime/usage-report.json
./.docnexus/node_modules/.bin/docnexus usage disable
```

In a development checkout, build first and replace the executable with `node /path/to/docnexus/dist/src/cli.js --project-root /path/to/project`. Available since 0.18.0. The Git-ignored `.docnexus/.runtime/usage.jsonl` stops growing at 10 MiB; recording failures do not fail ordinary commands. Reset deletes the records. Metrics do not establish answer correctness; see the [observation contract](docs/operations/usage-observation.zh-CN.md).

## Document viewer query

Run `./.docnexus/node_modules/.bin/docnexus view` in an initialized project and open the printed local URL to browse categories, paginated documents, classification reasons and fact provenance. Use `--port 4317` to choose a port and Ctrl+C to stop. Pages load on opening, manual refresh, or category/page changes, without automatic polling. Revision changes restart pagination at page one. Each request retains canonical integrity and fact-time checks. The read-only viewer derives content from the same canonical text without storing another document copy. See the [local viewer](docs/architecture/document-query.zh-CN.md#本地只读浏览页).

When no explicit category is supplied, the model running orchestration skills chooses project-defined `metadata.category` names and `category_reason` from project context, existing categories and related documents. It may reuse, create or adjust categories; there is no fixed seven-category taxonomy. Legacy documents without a category remain uncategorized until reviewed; tags cover cross-cutting subjects.

```bash
./.docnexus/node_modules/.bin/docnexus document query --all
./.docnexus/node_modules/.bin/docnexus document query --page 1 --page-size 20 --category architecture
node .docnexus/skills/docnexus-library/scripts/query-documents.mjs --all
```

The JSON response contains full current Markdown, used-category counts, classification reasons and pagination. Pass the first response's `--revision <hash>` on later pages; writes, reclassification, deletion and effective fact changes invalidate old revisions. Rendered display content is derived in memory, without another stored document source, embedding calls or retrieval-store access. Use `document classify --id <id> --category <name> --reason <basis> [--revision <hash>]` for category-only changes, preserving facts, source and Markdown. The model reviews classifications during orchestration work; query itself stays read-only. See the [query contract](docs/architecture/document-query.zh-CN.md).

## Skills and capture

Long documents and active facts are split with the local model's actual tokenizer, using at most 256 tokens per chunk including heading context and special tokens. Line/sentence/word boundaries and small overlaps retain context; oversized paragraphs and code are split too. Embedding checks the model limit again and rejects oversized queries with an actionable error. The next `recall` or `index sync` rebuilds older chunk strategies without editing canonical knowledge or timelines. See [long-document regression](docs/operations/retrieval-evaluation.md#long-document-regression) for offline coverage and limits.

| Skill | Responsibility |
| --- | --- |
| `docnexus` | Preflight, routing and capture orchestration |
| `docnexus-extract` | Refine or merge knowledge into a sealed draft |
| `docnexus-ingest` | Save an authorized sealed draft and append its timeline |
| `docnexus-recall` | Find files, read full documents, answer and cite |
| `docnexus-library` | Browse, read history, adopt edits, delete and manage drafts |
| `docnexus-maintain` | Diagnose text integrity, refresh directories and skills, reset |

Capture: `draft new` → write three artifacts → `draft seal` → `draft preview --id <id>` → user review → `document add --draft <id>`. Preview returns ordinary or fact-expanded sealed Markdown, its `document_hash` and `sealed_version`; sealing and ingestion also return that sealed version. Changed facts, targets or artifacts require merging/resealing and a new preview read. Content delivery, declared review and user authorization are distinct; the CLI adds no mandatory read-before-ingest gate. Replacing an existing path requires explicit authorization and `--replace`.

Extraction sets `observed_at` only from an explicit observation/statement timestamp with timezone in the current source. Omit an unknown replacement-source time instead of inheriting the previous value or substituting event/save dates; preserve historical fact dates and provenance independently. Creates/updates also hand off a related-page impact check: full-read versions, update/no-change/conflict/unverified decisions and evidence. Fact references continue to refresh automatically; the agent checks surrounding explanations and steps. Related edits use separate drafts, versions and authorizations, without an atomic multi-page commit. See [capture resolution](skills/docnexus-extract/references/capture-resolution.md).

Version 0.21.0 persists these checks in `docnexus/impacts/<impact_id>.json`. Extraction first keeps an `impact.json` attachment in its draft directory. After authorized primary ingestion, read that document and add its actual source identity/version, then register the attachment with `impact save --file <input.json>`. These are separate operations: retain the attachment and report registration as pending if saving fails; do not re-ingest the primary. Repeated equal input returns the existing record without resetting progress. See [impact tracking](skills/docnexus-library/references/impacts.md) for the input format.

Use `impact list`, `impact list --status pending`, `impact list --status needs_review` and `impact get --id <id>` to resume work. After rereading current evidence, use `impact set --id <id> --document <document_id> --status pending|done|dismissed --reason <basis> --revision <impact_revision>`. A stale revision is refused; missing pages cannot be marked done. Changes to source/target identities, versions or rendered content reopen even completed checks as `needs_review`, including effective-time fact changes. Original decisions and status history remain. These records do not edit knowledge, establish correctness or authorize related writes; keep them in text backups/Git, not the retrieval index. Reset removes them. Old chat handoffs require fresh assessment, not automatic import; workspace, draft and projection formats stay unchanged.

A calling skill can supply an explicit category for this write and skip model classification. For example, after a code-review skill prepares the three draft artifacts:

```bash
./.docnexus/node_modules/.bin/docnexus draft seal --id <draft_id> --file reviews/report.md --base-version new \
  --category codeReview --category-reason "Produced by the code-review skill"
# Review the document and sealed metadata, then ingest.
./.docnexus/node_modules/.bin/docnexus document add --draft <draft_id>
```

The category name is preserved exactly. The basis is optional, defaulting to `Explicit category supplied by caller.` Classification is included in the sealed metadata hash, and ingestion uses that reviewed value. Updates still require the current `--base-version <record_version>` and `--replace`. Category maintenance in the same capture pipeline preserves the caller's choice; a later authorized update can change it.

Updates must pass `--base-version <record_version>` from the `document get` or `document query` read used to compose the draft. If sealing reports a conflict, reread and merge before using the new version. Use `--base-version new` for a new path. Pending manifest versions 1/2 must be resealed after rereading and merging.

Sealing records the target document version. Ingestion rejects newer prose, source or category changes, deleted/recreated targets and newly occupied paths. Reread and merge current knowledge before resealing; `--replace` does not bypass this check. Pending format-1/2 draft manifests require rereading, merging and resealing as format 3; stored documents remain workspace format 7. See [knowledge maintenance evaluation](docs/operations/knowledge-evaluation.zh-CN.md) for real-source regression replay and separate model review tasks.

`init --agent` links project skills into `.agents/skills/` or `.claude/skills/` and adds a marked block to `AGENTS.md` or `CLAUDE.md`. Claude loads the short category map through `@docnexus/CONCEPTS.md`; Codex reads it when useful. The block tells agents to decide from the task whether to recall, never to skip because a topic is missing from the map. Re-run `init --agent` to refresh an older block. Reset removes these links and blocks.

## Git and hand edits

By default, DocNexus creates no separate Git repository, configures no remote and does not require Git. Text can still be committed with the host project. Opt into a separate knowledge repository during initialization or for an existing workspace:

```bash
./.docnexus/node_modules/.bin/docnexus init --agent codex --git-remote git@example.com:team/project-memory.git
# Repeat with another address to update the knowledge repository's origin.
git -C docnexus status
```

This initializes `docnexus/.git/` and configures `origin`, leaving the host remote and index unchanged. When a host Git repository exists, it appends `/docnexus/` to the business project's `.gitignore`. If the host already tracks workspace files, setup refuses before making changes; review and remove them from the host index while retaining local files first. Success adds optional `git: { repository, remote, branch }`; the address stays in local `.git/config`, with no workspace format change. Ordinary initialization preserves existing Git configuration.

Separate knowledge repositories use one pinned branch: `main` for new repositories, or the current branch for existing repositories. Setup refuses detached HEAD or multiple local branches without renaming or deleting anything. The pin is stored in `docnexus/.git/docnexus-branch.json`. Each top-level CLI/service operation checks it before transaction recovery; the wrong branch, detached HEAD or extra local branches cause `git_branch_mismatch` and block reads, writes and reset. The pin survives reset and checkout changes, and Git is required for ordinary operations once enabled. Cloning does not copy this local `.git` policy: each member must run `init --git-remote <url>` to install the guard, including when adopting a previously configured repository.

This is a DocNexus preflight guard. It cannot block direct `git switch/checkout/branch` commands, external Git changes during operations or manual policy removal. It installs no Git hooks and does not inspect or restrict remote branches; configure hosting rules or server-side checks separately for that. The business repository can still change branches normally. Review knowledge before committing to its pinned branch; a single branch does not eliminate concurrent editing conflicts.

Setup is local only: it does not validate remote connectivity, commit, fetch, pull or push. Use standard `git -C docnexus ...` commands after CLI writes and pending recovery finish. To use existing remote knowledge, clone it into the configured output directory, restore `.docnexus/project.json` and npm manifests separately, then restore dependencies and run `init --agent codex --git-remote <url>` (or `claude` / `all`); supplying a remote does not import its contents. This recreates local skills, schema and agent links. Configure submodules and linked worktrees with Git directly; `--git-remote` manages standalone `.git/` directories only.

`reset --force` clears current knowledge and integration while preserving `.git`, remote configuration, Git history and the npm installation. It returns `preserved_git: true` when Git metadata remains; committed knowledge can still be recovered from history. Reset neither commits nor pushes deletions, and initialization can run again afterward. Git setup and initialization are not a cross-file transaction; inspect actual state before retrying an interrupted operation.

Commit the knowledge output plus `.docnexus/project.json`, `.docnexus/package.json` and `.docnexus/package-lock.json`. Internal runtime, drafts, official skills, generated schema and retrieval stores are Git-ignored. Custom skills with other names remain trackable. After cloning, restore configuration and knowledge together, run `npm ci --prefix ./.docnexus` and `init --agent codex` (or claude/all). A separate knowledge repository requires the configuration and npm manifests to be backed up and restored separately. Format 7 provides no legacy migration.

After setup or a pull, keyword search and document reads use the current text immediately; host-managed knowledge can also follow business branches, while separate knowledge repositories must satisfy the pinned-branch guard; semantic recall automatically synchronizes derived indexes. `index sync` restores PostgreSQL/pgvector projections and the concept directory, processing new, changed or missing documents. It reuses unchanged chunks and vectors, and never rebuilds HNSW during normal writes. It never imports unmanaged files or modifies sources/timelines. A changed embedding-probe output triggers re-embedding of all current documents.

## Database engines

Retrieval projection schema version 2 is independent of workspace format 7. `index status` / `doctor` expose version compatibility. Known older projections rebuild from canonical text on the next sync or recall, preserving sources, history, drafts and model assets; unknown/newer versions are refused. Keyword/vector matches retain structured source anchors, and evidence delivery reserves compact primary hits before expanding context. See the [retrieval pipeline](docs/architecture/retrieval-pipeline.zh-CN.md).

The zero-configuration default is PGLite, created lazily at `.docnexus/store/brain.pglite` on the first index sync or semantic recall. For an existing Postgres server with pgvector available, set `DOCNEXUS_DATABASE_URL` in the CLI environment and run `docnexus index sync`. Credentials are not written into project files. Both engines use the same schema and SQL; document, chunk and graph projection changes commit in one database transaction. Text remains the canonical source and is reconciled separately.

External Postgres requires permission to create a project schema and tables. A database administrator can preinstall `vector` in `public` if the runtime role cannot create extensions. Schemas are isolated by the canonical project path; relocating or cloning a project creates a separate projection. This is not a shared multi-machine write protocol or database access control. `reset --force` drops the selected project's remote schema before deleting its local workspace; an unavailable server blocks that reset.

Keyword search and the document browser continue reading text without a database or model. This adopts GBrain's PGLite/Postgres engine pattern and pgvector index maintenance, while retaining DocNexus's text search, local embeddings and one-hop graph recall. PGLite runs in-process; large datasets and concurrent server workloads should use Postgres. The existing local process lock still uses an OS-temporary SQLite file for coordination only.

Legacy `index.sqlite` and `graph.lbug` caches are no longer read. Verify the new sync before removing those obsolete caches; preserve any custom `store/models/` assets.

Saving knowledge commits text first; projections are built on the next semantic recall or explicit sync. Deleted derived databases can be rebuilt. Custom `store/models/` overrides need separate backup; without an override the package model is used. Operations affect only the selected project directory, not other worktrees.

Users may edit author-owned library prose and fact references. Generated `<!-- docnexus:fact ... -->` block contents are read-only projections; change the owning metadata facts instead. `status` reports their ids under `records.edited`; keyword search, semantic recall and CLI document reads report unadopted edits. After review, `document sync` adopts the edit, keeps the original source and appends the edited content to the timeline. Restore missing or damaged text from Git or a backup; doctor does not rewrite it.

Deletion removes the current document, source, metadata, timeline and derived entries, unless doing so would leave dangling fact references. Managed paths reject symbolic links. Local processes share a project lock; durable write-ahead intent covers memory files and draft ingestion receipts. Ordinary failures persist rollback intent; the next CLI access recovers an interrupted save, deletion or rollback before reading. Recovery copies are removed on completion. Git, external editors and other machines do not participate in the lock: avoid edits and branch changes during writes or pending recovery. Windows skips directory fsync; process crashes are tested, hardware power loss is not simulated.

## CLI

Use `./.docnexus/node_modules/.bin/docnexus` from the project root, or prefix a command with `--project-root <path>`.

```text
init [--output-dir <directory>] [--agent claude|codex|all] [--git-remote <url>]
doctor
status
skills sync
skills link --target claude|codex|all

draft new [--slug auth]
metadata validate --file .docnexus/drafts/<draft_id>/metadata.json
draft seal --id <draft_id> --file auth/rotation.md [--base-version <record_version|new>] [--category <name> [--category-reason <basis>]]
document add --draft <draft_id> [--replace]
draft list [--status open|ready|ingested|invalid]
draft discard --id <draft_id> --force

search "Refresh token" [--limit 5] [--category codeReview]
recall "Refresh token" [--limit 5] [--category codeReview]
concepts [--type component] [--query auth] [--category <name>] [--format json|md]
document list [--limit 50] [--tag auth]
document get --id <id> [--include source,document,metadata,timeline,template]
document render
facts list [--entity name] [--at ISO-timestamp] [--include-inactive]
document sync --id <id> [--metadata-file <path>]
document delete --id <id> --force
document delete --file auth/rotation.md --force
index status
index sync
index rebuild --force
graph audit
graph repair --force
embeddings install --from <model_dir> [--replace]
reset --force
```

Workspace commands refresh skills when the installed package version changes; doctor only reports drift. `file_path` is relative to `docnexus/library/`. Input files must remain inside the project. Mutations require user authorization; `--force` and `--replace` record authorization already obtained.

Use `--json` for stable failure codes and `docnexus protocol` for their definitions. `doctor` adds structured `issues[]`. For bounded evidence, run `docnexus recall "question" --return-unit section --context-budget 4000`; the independent packet includes source versions, fact status and observation time, and explicitly budgets a conservative UTF-8 byte estimate. See [evidence delivery](./docs/architecture/evidence-delivery.zh-CN.md) and [agent acceptance](./docs/operations/agent-evaluation.zh-CN.md). Agent acceptance needs a real, separately authorized fresh-context run; preparing it does not measure model quality.

## Development

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run eval:retrieval
npm run eval:retrieval:quality   # Development only; see retrieval evaluation for explicit holdout runs.
npm run eval:knowledge
npm run eval:agent -- prepare   # Maintenance tasks; add --scenario retrieval for per-task lookup
node scripts/tarball-smoke.mjs
```

Ordinary tests use deterministic hash embeddings; the real-runtime E2E enables the packaged ONNX model with a network sentinel. The tarball smoke installs locked dependency versions; offline runs need a populated npm cache, normally prepared by `npm ci`.

See the [documentation index](./docs/README.md) for architecture, skills, product scope and release checks.
