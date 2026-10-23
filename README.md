# DocNexus

[中文说明](./README.zh-CN.md)

DocNexus is local project memory for coding agents such as Codex and Claude. Inspired by [GBrain](https://github.com/garrytan/gbrain), it keeps current knowledge as Markdown next to a source-attributed timeline. Skills refine, find and cite knowledge; a thin CLI manages text and rebuildable PostgreSQL + pgvector projections, using embedded PGLite by default or an external Postgres.

Agents consult memory proactively, and every write requires user authorization. Keyword lookup reads text directly; default recall fuses keyword and local vector ranks with one-hop graph evidence. The CLI makes no external LLM calls, and the bundled quantized ONNX model loads offline.

> **0.24.2 breaking change:** workspace format 7 separates `.docnexus/` program files from configurable knowledge output. Installation deletes recognized legacy workspaces, including knowledge, sources and history; no migration is provided. Draft manifest 3 and projection schema 2 are unchanged. 0.25.0 additionally defaults `document get` to the current body only and enforces the 4000-character refined-body limit.

## Installation cleanup

npm `postinstall` deletes recognized legacy `docnexus/` directories (format 1–6) and legacy data under `.docnexus/`, including knowledge, sources and Git history. It preserves npm manifests, the lockfile and `node_modules/`; unrecognized directories, external symlink targets, global/npx installs and source checkouts are untouched. There is no confirmation, migration or backup. `--ignore-scripts` skips cleanup, but initialization still refuses legacy workspaces.

## Quick start

Requires Node.js 22.13.0+ and npm. Run in the target project:

```bash
mkdir -p .docnexus
npm install --prefix ./.docnexus --save-exact @rowansenne/docnexus
./.docnexus/node_modules/.bin/docnexus init --output-dir docs/knowledge --agent codex  # or claude / all
./.docnexus/node_modules/.bin/docnexus doctor
```

`init --output-dir <parent>` creates `<parent>/docnexus/`; omit it to use `docnexus/`. The setting is stored in `.docnexus/project.json` and cannot change without an explicit reset. Program files, skills, schema, drafts and retrieval indexes stay in `.docnexus/`. Run commands from the project root or pass `--project-root <path>`; `status` prints the configured paths. Update with `...@latest` and restore dependencies with `npm ci --prefix ./.docnexus`.

Ask the agent to remember a decision, explain a project convention or list saved documents. `docnexus/CONCEPTS.md` is a short category map routing to one concept file per domain under `docnexus/concepts/`.

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
  .gitattributes                  # preserve LF canonical text across Git clones
  CONCEPTS.md                     # generated readable category map (≤ 3 KB)
  concepts/                       # generated readable category navigation
  categories.md                   # editable starter category suggestions
  impacts/                        # related-page impact history
  library/                        # current knowledge Markdown
  records/<id>/                   # source.md, metadata.json, timeline.md, record.json
```

`library/` stores current knowledge; `records/<id>/` stores each source, metadata and timeline. Timeline dates are save times, not event dates; keyword and vector indexes exclude source and timeline text. Generated navigation stays bounded: `CONCEPTS.md` stays within 3 KB, each category file within 32 KB, and oversized categories are paged by entity type. `categories.md` is an editable starter list, not a taxonomy; the CLI never reads it.

Before a capture, the agent searches/recalls and reads plausible candidates in full, then chooses update, create, skip or conflict and carries the reason and read versions into review. This is a skill workflow, not CLI-enforced semantic deduplication. See [capture resolution](skills/docnexus-extract/references/capture-resolution.md).

## Find and answer

```bash
./.docnexus/node_modules/.bin/docnexus search "Refresh token" --limit 5
./.docnexus/node_modules/.bin/docnexus recall "When should refresh tokens rotate?" --limit 5
./.docnexus/node_modules/.bin/docnexus document get --id <id> --include document,metadata
./.docnexus/node_modules/.bin/docnexus document get --id <id> --include document,timeline
```

`search` matches current bodies, paths, titles, summaries, tags, entity names/aliases and active facts. `recall` adds local 512-dimensional vectors from `BAAI/bge-small-zh-v1.5` and fuses document ranks; it returns a representative chunk, neighbors and one-hop graph evidence. `--category` filters exactly and case-sensitively, and `uncategorized` covers documents without a category. Scores are not confidence.

Read the complete document before answering and cite `docnexus/library/<file_path>`. Use `document get` for files with generated fact blocks so effective-time changes are refreshed, and state evidence gaps or conflicts.

Facts are defined once in their owner metadata with stable ids, provenance and effective times, then referenced on a standalone `{{fact:fact_id}}` line. The CLI renders attributed blocks and follows replacement, expiry and withdrawal; `document render` refreshes them. There is no background timer.

```bash
./.docnexus/node_modules/.bin/docnexus facts list --entity "<canonical name or alias>" --include-inactive
./.docnexus/node_modules/.bin/docnexus facts list --at "2026-10-14T12:00:00+08:00" --include-inactive
```

See the [fact workflow](skills/docnexus-extract/references/facts.md) for lifecycle details.

## Viewer and document query

Run `./.docnexus/node_modules/.bin/docnexus view` and open the printed local URL to browse categories, paginated documents, classification reasons and fact provenance. Use `--port 4317` to choose a port and Ctrl+C to stop. The viewer is read-only, loads on opening/manual refresh/category changes, and verifies canonical text and fact time on every request.

```bash
./.docnexus/node_modules/.bin/docnexus document query --all
./.docnexus/node_modules/.bin/docnexus document query --page 1 --page-size 20 --category architecture
node .docnexus/skills/docnexus-library/scripts/query-documents.mjs --all
```

`document query` returns full Markdown, category counts, classification reasons and pagination. Pass `--revision <hash>` on later pages; writes, reclassification, deletion or fact-state changes invalidate old revisions. `document classify --id <id> --category <name> --reason <basis>` changes only classification and audit history.

Category priority is: explicit caller choice, existing category, starter suggestion, then a new name. `init` writes `docnexus/categories.md` (for example `pitfalls`, `templates`); agents treat it as guidance, never as an allow-list, and editing it does not reclassify documents.

Refined documents are limited to **4000 Unicode characters** of rendered Markdown, including headings, code and expanded facts. Sealing, preview, ingestion and hand-edit adoption reject larger bodies with `document_too_long`; split by meaning instead of truncating. `document get` returns the current body by default; use `--include` for source, metadata, template or timeline. See [semantic splitting](skills/docnexus-extract/references/document-length.md).

## Skills and capture

| Skill | Responsibility |
| --- | --- |
| `docnexus` | Preflight, routing and capture orchestration |
| `docnexus-extract` | Refine or merge knowledge into a sealed draft |
| `docnexus-ingest` | Save an authorized sealed draft and append its timeline |
| `docnexus-recall` | Find files, read full documents, answer and cite |
| `docnexus-library` | Browse, read history, adopt edits, delete and manage drafts |
| `docnexus-maintain` | Diagnose text integrity, refresh directories and skills, reset |

Capture: `draft new` → write three artifacts → `draft seal` → `draft preview --id <id>` → user review → `document add --draft <id>`. Preview returns sealed Markdown, `document_hash` and `sealed_version`; changed facts, targets or artifacts require merging/resealing and a new preview. Replacing an existing path needs explicit authorization and `--replace`.

Updates pass `--base-version <record_version>` from the read used to compose the draft; conflicts require rereading and merging before resealing. Sealing pins the target version, and ingestion rejects newer prose, source or category changes. See [knowledge maintenance evaluation](docs/operations/knowledge-evaluation.zh-CN.md) for regression replays.

`observed_at` comes only from an explicit timezone-qualified observation in the current source; never inherit it or substitute an event/save date. Related-page impact checks are handed off with the draft and can be persisted under `docnexus/impacts/`. Register them after primary ingestion with `impact save --file <input.json>`; resume with `impact list/get/set`. They are separate operations and never authorize related writes. See [impact tracking](skills/docnexus-library/references/impacts.md).

A caller can supply an explicit category and skip model classification:

```bash
./.docnexus/node_modules/.bin/docnexus draft seal --id <draft_id> --file reviews/report.md --base-version new \
  --category codeReview --category-reason "Produced by the code-review skill"
./.docnexus/node_modules/.bin/docnexus document add --draft <draft_id>
```

`init --agent` links skills into `.agents/skills/` or `.claude/skills/` and adds a marked block to `AGENTS.md` or `CLAUDE.md`; re-run it to refresh an older block.

## Git and hand edits

DocNexus creates no Git repository by default. Opt into a separate knowledge repository with:

```bash
./.docnexus/node_modules/.bin/docnexus init --agent codex --git-remote git@example.com:team/project-memory.git
git -C docnexus status
```

This initializes `docnexus/.git/` and pins one branch; wrong branch, detached HEAD or extra local branches block reads, writes and reset. It does not validate remotes, commit, fetch or push. `reset --force` preserves `.git`, remote configuration and history.

Users may edit library prose and fact references; generated fact blocks are read-only. `document sync` adopts an edit, keeps the original source and appends the edited content to the timeline. Managed paths reject symlinks, writes share a project lock and recover after interruption; avoid Git operations during writes.

npm installation/upgrades and CLI `init` automatically install or update local Git hooks when the initialized knowledge workspace belongs to a Git repository. No separate hook-install command is needed. Resolve and **stage content normally**; the index hook records conflicts (including resolved stages), automatically repairs and stages generated assets when content is ready, and `pre-commit`/`pre-merge-commit` validate staged knowledge, including conflict-free merges that create a merge commit. Wait for the ready message, review the staged diff, then commit. Unstaged knowledge edits are refused, existing native hooks are chained, and custom `core.hooksPath` managers require explicit integration. Use `docnexus git hooks status` or `docnexus git hooks uninstall` to inspect/restore hooks; timestamped queued-worker details are in `.docnexus/.runtime/git-merge.log`, which rotates once to `.log.1` at 64 KiB. Hooks are local; the normal dependency installation and CLI `init` after cloning restore them automatically; current scripts use project-relative paths and Node from PATH. Upgrades automatically add `pre-merge-commit` and replace older absolute-path scripts. Projects without Git skip setup; setup failures warn without failing npm installation or initialization. Disabling npm lifecycle scripts skips the installation-time update; CLI `init` still performs setup. Code-only commits skip knowledge checks; ordinary knowledge edits hash only affected units, record changes also check catalog-wide path uniqueness, and semantic changes retain dependency checks. Missing runtimes warn and skip automatic capture, and block only knowledge commits or pending knowledge merges until Node and local dependencies are restored. Git commits and remote operations remain user-controlled. Clean pulls need no adoption; rebase, same-path creates, renames and deletes require manual document-level recovery. See the [Git merge workflow](skills/docnexus-library/references/git-merge.md).

Commit the knowledge output plus `.docnexus/project.json` and npm manifests. Drafts, runtime state, skills, schema and retrieval stores are Git-ignored. Restore with `npm ci --prefix ./.docnexus`, `init --agent`, then `recall` or `index sync`.

## Database engines

PGLite is the zero-configuration default, created at `.docnexus/store/brain.pglite` on first index sync or semantic recall. For an existing Postgres server with pgvector, set `DOCNEXUS_DATABASE_URL` and run `index sync`; credentials stay out of project files. Both engines share schema and SQL, and text remains canonical. Projections rebuild from text, and moved or cloned projects get separate schemas. `reset --force` drops the remote schema before deleting local state.

## Local usage observation

Optional and off by default. Records latency, error codes, anonymized query/document identities, retrieval metrics and embedding calls; query text, document content, paths and credentials are excluded. Nothing is uploaded.

```bash
./.docnexus/node_modules/.bin/docnexus usage enable
./.docnexus/node_modules/.bin/docnexus usage status
./.docnexus/node_modules/.bin/docnexus usage feedback --rating miss --reason needs_multihop
./.docnexus/node_modules/.bin/docnexus usage export > .docnexus/.runtime/usage-report.json
./.docnexus/node_modules/.bin/docnexus usage disable
```

See the [observation contract](docs/operations/usage-observation.zh-CN.md). Metrics do not establish answer correctness.

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
git hooks install|status|uninstall
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

Workspace commands refresh skills when the installed package version changes; `doctor` only reports drift. `file_path` is relative to `docnexus/library/`. Mutations require user authorization; `--force` and `--replace` record authorization already obtained. Use `--json` for stable failure codes and `docnexus protocol` for their definitions. For bounded evidence, run `recall "question" --return-unit section --context-budget 4000`; see [evidence delivery](docs/architecture/evidence-delivery.zh-CN.md).

## Development

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run eval:retrieval
npm run eval:retrieval:quality
npm run eval:knowledge
npm run eval:agent -- prepare
node scripts/tarball-smoke.mjs
```

Ordinary tests use deterministic hash embeddings; the real-runtime E2E enables the packaged ONNX model with a network sentinel. The tarball smoke installs locked dependency versions. See the [documentation index](./docs/README.md) for architecture, skills, product scope and release checks.