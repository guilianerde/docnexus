---
name: docnexus-maintain
description: Diagnose DocNexus text, PGLite/Postgres pgvector indexes, graph projections, local model and skill problems; synchronize derived indexes after Git changes, repair projections, and reset a workspace when authorized.
---

# DocNexus Maintain

## Diagnose

```bash
./node_modules/.bin/docnexus doctor --json
./node_modules/.bin/docnexus protocol
./node_modules/.bin/docnexus status
./node_modules/.bin/docnexus index status
./node_modules/.bin/docnexus graph audit
```

Machine failures carry protocol_version, code, retryable, next_action and verify. Doctor exposes the same contracts in issues[] alongside checks and recommendations; inspect stable codes instead of parsing messages. Follow action suggestions only within existing authorization. A review action never authorizes resealing, adopting text or clearing data. Full contract: packaged `docs/operations/agent-protocol.zh-CN.md`.

Every CLI access takes the local project lock and recovers an existing text transaction before reading memory. Doctor then checks confirmed text, derived index drift, database/vector availability, local embeddings and skills. It does not repair missing indexes or invent knowledge. An empty new workspace has no database until the first sync; that is normal. Graph audit requires an existing retrieval schema; if missing, synchronize first.

The default engine is PGLite at `docnexus/store/brain.pglite`. An explicit `DOCNEXUS_DATABASE_URL` selects external Postgres + pgvector; do not save credentials in memory or switch engines to conceal an outage. Verify connectivity and extension/schema permissions if that server is unavailable. Text search, document queries and ordinary text writes remain usable; semantic recall requires a successful sync. Remote schemas are keyed by canonical project path, not a cross-machine shared identity.

## Synchronize

```bash
./node_modules/.bin/docnexus index sync
./node_modules/.bin/docnexus document render
./node_modules/.bin/docnexus skills sync
./node_modules/.bin/docnexus skills link --target claude
```

`index sync` refreshes generated fact blocks, indexes new/changed current documents, removes obsolete projections, restores missing graph documents and refreshes `CONCEPTS.md`. Recall also runs it automatically. It reuses unchanged chunks and vectors; ordinary writes maintain HNSW incrementally. Entity aliases, fact validity and referenced fact changes invalidate affected projections. `document render` refreshes only generated Markdown blocks. These operations never adopt authored edits or append source history. A changed local embedding probe causes all current documents to be re-embedded. Skill linking also supports `codex` and `all`.

## Repair

- A busy project: wait for the active operation and retry. The OS releases the lock when its process exits; do not delete lock files to force access.
- A pending or invalid `docnexus/.runtime/transaction.json`: preserve it and the memory files. Report the error and inspect/restore the intended journal or text with authorization; deleting it can discard the only recovery intent. Do not Git pull, switch branches, or hand-edit managed files while a CLI write is running or recovery is pending.
- Hand edits: use `docnexus-library` to review and adopt them with authorization.
- Missing/invalid source records: explain the files and restore intended text from Git or backup with authorization. Do not fabricate history or rewrite hashes to hide corruption.
- Graph audit reports stale documents, orphan concepts or a broken vector index: with authorization run `docnexus graph repair --force`, then audit again.
- To reconcile all current document projections: with authorization run `docnexus index rebuild --force`. Unchanged text with the same model signature reuses vectors; a healthy HNSW is retained. Graph repair also retains healthy indexes and only repairs an abnormal index.
- Missing local model: restore packaged assets or install a complete project-local model with `docnexus embeddings install --from <project_dir> [--replace]`. Confirm replacement when needed. Custom models under `store/models/` are not included in Git and must be backed up separately.

## Reset

Existing format-6 text needs only an index sync for this engine change. There is no migration from formats before 6. Reset removes the entire workspace, its sources and timelines, derived stores and custom models, skill links and marked agent instructions. With a configured Postgres URL, it first drops only this project's remote schema; a failed remote cleanup blocks reset. Only run it when the user has explicitly authorized clearing that workspace:

```bash
./node_modules/.bin/docnexus reset --force
./node_modules/.bin/docnexus init --agent claude
```

Existing authorization need not be requested again. `--force` and `--replace` record authorization already obtained.
