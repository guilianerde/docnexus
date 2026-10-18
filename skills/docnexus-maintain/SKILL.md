---
name: docnexus-maintain
description: Diagnose DocNexus text, PGLite/Postgres pgvector indexes, graph projections, local model and skill problems; synchronize derived indexes after Git changes, repair projections, and reset a workspace when authorized.
---

# DocNexus Maintain

Run commands from the project root using `./docnexus/node_modules/.bin/docnexus`. For a legacy root installation without that executable, use `./node_modules/.bin/docnexus` instead. Do not change into `docnexus/`; from another directory pass `--project-root <project>`.

## Diagnose

```bash
./docnexus/node_modules/.bin/docnexus doctor --json
./docnexus/node_modules/.bin/docnexus protocol
./docnexus/node_modules/.bin/docnexus status
./docnexus/node_modules/.bin/docnexus index status
./docnexus/node_modules/.bin/docnexus graph audit
```

Machine failures carry protocol_version, code, retryable, next_action and verify. Doctor exposes the same contracts in issues[] alongside checks and recommendations; inspect stable codes instead of parsing messages. Follow action suggestions only within existing authorization. A review action never authorizes resealing, adopting text or clearing data. Full contract: packaged `docs/operations/agent-protocol.zh-CN.md`.

Every CLI access takes the local project lock and recovers an existing text transaction before reading memory. Doctor then checks confirmed text, derived index drift, database/vector availability, local embeddings and skills. It does not repair missing indexes or invent knowledge. An empty new workspace has no database until the first sync; that is normal. Graph audit requires an existing retrieval schema; if missing, synchronize first.

The default engine is PGLite at `docnexus/store/brain.pglite`. An explicit `DOCNEXUS_DATABASE_URL` selects external Postgres + pgvector; do not save credentials in memory or switch engines to conceal an outage. Verify connectivity and extension/schema permissions if that server is unavailable. Text search, document queries and ordinary text writes remain usable; semantic recall requires a successful sync. Remote schemas are keyed by canonical project path, not a cross-machine shared identity.

## Synchronize

```bash
./docnexus/node_modules/.bin/docnexus index sync
./docnexus/node_modules/.bin/docnexus document render
./docnexus/node_modules/.bin/docnexus skills sync
./docnexus/node_modules/.bin/docnexus skills link --target claude
```

`index sync` refreshes generated fact blocks, indexes new/changed current documents, removes obsolete projections, restores missing graph documents and refreshes `CONCEPTS.md` with the `concepts/` category files. Recall also runs it automatically. It reuses unchanged chunks and vectors; ordinary writes maintain HNSW incrementally. Entity aliases, fact validity and referenced fact changes invalidate affected projections. `document render` refreshes only generated Markdown blocks. These operations never adopt authored edits or append source history. A changed local embedding probe causes all current documents to be re-embedded. Skill linking also supports `codex` and `all`.

The six official `docnexus/skills/` copies, their version stamp and generated `docnexus/schemas/metadata.schema.json` are Git-ignored local package assets. Keep knowledge, sources, metadata, timelines, impacts and npm manifests/lockfiles in Git. Keep custom workflows under other skill names; never customize official copies that upgrades replace. After cloning, run `npm ci --prefix ./docnexus` and then `init --agent <target>` (also `--git-remote <url>` for separate knowledge repositories) to restore local assets and links. Existing tracked copies need an explicit reviewed `git rm --cached` migration; initialization and sync never modify the Git index.

## Repair

- A busy project: wait for the active operation and retry. The OS releases the lock when its process exits; do not delete lock files to force access.
- A pending or invalid `docnexus/.runtime/transaction.json`: preserve it and the memory files. Report the error and inspect/restore the intended journal or text with authorization; deleting it can discard the only recovery intent. Do not Git pull, switch branches, or hand-edit managed files while a CLI write is running or recovery is pending.
- Hand edits: use `docnexus-library` to review and adopt them with authorization.
- Missing/invalid source records: explain the files and restore intended text from Git or backup with authorization. Do not fabricate history or rewrite hashes to hide corruption.
- Graph audit reports stale documents, orphan concepts or a broken vector index: with authorization run `docnexus graph repair --force`, then audit again.
- To reconcile all current document projections: with authorization run `docnexus index rebuild --force`. Unchanged text with the same model signature reuses vectors; a healthy HNSW is retained. Graph repair also retains healthy indexes and only repairs an abnormal index.
- Missing local model: restore packaged assets or install a complete project-local model with `docnexus embeddings install --from <project_dir> [--replace]`. Confirm replacement when needed. Custom models under `store/models/` are not included in Git and must be backed up separately.

## Local usage observation

Only enable local observation when the user requests it. Run `docnexus usage enable`, `usage status`, `usage disable` and `usage export` through the project-local executable above. Export one shareable file with `docnexus usage export > docnexus/.runtime/usage-report.json`; nothing is uploaded. This feature is available since 0.18.0.

Records omit query text, document content, paths and credentials; pseudonyms are project-keyed and the key is not exported. The log is Git-ignored and bounded at 10 MiB. If full, export it and disable recording; never delete the entire `.runtime/` directory because it also contains recovery state. Reset deletes usage records too.

With recording enabled, record only explicit feedback: `docnexus usage feedback --rating useful|partial|miss [--reason needs_multihop|missing_document|irrelevant|truncated|stale|slow|other] [--event <event_id>]`. Without `--event`, it targets the latest recorded search/recall; use the id from `usage status` or the export when multiple queries are involved. Do not infer successful answers from nonempty candidates or invent ratings. Missing query text limits semantic diagnosis; timings and recorded paths through the system do not establish answer correctness. See packaged `docs/operations/usage-observation.zh-CN.md`.

## Reset

Optional `init --git-remote <url>` configures a standalone repository inside `docnexus/`; default initialization does not require Git. It does not commit or synchronize remotely. Host-tracked knowledge must be reviewed and removed from the host index while retaining local files before setup; never untrack files automatically to bypass this refusal. Reset preserves `.git`, origin and committed history, reporting `preserved_git: true`, while clearing current knowledge. Do not delete Git metadata to perform a knowledge reset.

Configured knowledge repositories use one pinned branch (`main` when new, the current branch when adopting an existing repository). A wrong branch, detached HEAD or extra local branches causes `git_branch_mismatch` before recovery or other DocNexus work. Review and restore the intended branch state; do not bypass the guard, delete `.git/docnexus-branch.json`, discard extra branches or repin a new branch automatically. Reset preserves the pin. Clone recipients must rerun `init --git-remote` to install the local guard. This does not intercept terminal Git commands or restrict remote branches; external Git must not run during CLI operations.

Existing format-6 text needs only an index sync for this engine change. There is no migration from formats before 6. Reset removes project knowledge, sources and timelines, derived stores and custom models, skill links and marked agent instructions. It retains workspace-local `package.json`, `package-lock.json` and `node_modules/` so the CLI can initialize again; the result includes `preserved_installation: true` when these entries remain. With a configured Postgres URL, it first drops only this project's remote schema; a failed remote cleanup blocks reset. Only run it when the user has explicitly authorized clearing that workspace:

```bash
./docnexus/node_modules/.bin/docnexus reset --force
./docnexus/node_modules/.bin/docnexus init --agent claude
```

Existing authorization need not be requested again. `--force` and `--replace` record authorization already obtained.
