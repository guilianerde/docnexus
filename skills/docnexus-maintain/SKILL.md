---
name: docnexus-maintain
description: Use when the user asks to check DocNexus health or status, sync memory after git pull or clone, or when a DocNexus command reports index, graph, embedding, skills, or project-format problems that need diagnosis, sync, rebuild, repair, or reset.
---

# DocNexus Maintain

Diagnose first, repair second, reset last.

## 1. Diagnose (read-only, always safe)

```bash
./node_modules/.bin/docnexus doctor
./node_modules/.bin/docnexus status
./node_modules/.bin/docnexus index status
./node_modules/.bin/docnexus graph audit
```

Summarize failing checks and the `recommendations` from `doctor`.

## 2. Sync (safe, no confirmation needed)

`docnexus/` is plain text except `store/`, which is git-ignored and derived. After a clone, `git pull`, or branch switch:

```bash
./node_modules/.bin/docnexus index sync
```

It indexes new or changed records and drops index entries whose record was deleted. Library files edited by hand are reported, not adopted; hand those to `docnexus-library` → *Adopt hand edits*.

## 3. Repair (confirm each with the user)

| Symptom | Command |
| --- | --- |
| `doctor` reports missing or outdated skills | `./node_modules/.bin/docnexus skills sync` (also runs automatically on the next command) |
| Agent cannot see DocNexus skills | `./node_modules/.bin/docnexus skills link --target claude` (or `codex`, `all`) |
| Stale graph documents, orphan concepts, broken vector index | `./node_modules/.bin/docnexus graph repair --force` |
| Missing graph documents, chunk-count mismatches, project moved to a new path, embedding model changed | `./node_modules/.bin/docnexus index rebuild --force` (re-embeds every record) |
| Replace the bundled embedding model | `./node_modules/.bin/docnexus embeddings install --from <project_dir> [--replace]` |

Run `graph repair` before `index rebuild` when both are suggested, then re-run `graph audit` to confirm.

## 4. Reset (last resort)

`reset --force` deletes the entire `docnexus/` folder — library documents, records, drafts, skills, and the store — plus the agent skill links and the DocNexus block in CLAUDE.md / AGENTS.md. Only suggest it for an unsupported project format or unrecoverable corruption. After explicit confirmation:

```bash
./node_modules/.bin/docnexus reset --force
./node_modules/.bin/docnexus init --agent claude
```

## Constraints

- Never run a `--force` or `--replace` command without explicit user confirmation.
- `index sync` and `index rebuild` only process documents that have a record in `docnexus/records/`; they never import unmanaged files.
