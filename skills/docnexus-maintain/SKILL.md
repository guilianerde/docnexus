---
name: docnexus-maintain
description: Use when the user asks to check DocNexus health or status, or when a DocNexus command reports index, graph, embedding, skills, or project-format problems that need diagnosis, rebuild, repair, or reset.
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

## 2. Repair (confirm each with the user)

| Symptom | Command |
| --- | --- |
| `doctor` reports missing skills | `./node_modules/.bin/docnexus skills sync` |
| Agent cannot see DocNexus skills | `./node_modules/.bin/docnexus skills link --target claude` (or `codex`, `all`) |
| Stale graph documents, orphan concepts, broken vector index | `./node_modules/.bin/docnexus graph repair --force` |
| Missing graph documents, chunk-count mismatches, project moved to a new path | `./node_modules/.bin/docnexus index rebuild --force` |
| Replace the bundled embedding model | `./node_modules/.bin/docnexus embeddings install --from <project_dir> [--replace]` |

Run `graph repair` before `index rebuild` when both are suggested, then re-run `graph audit` to confirm.

## 3. Reset (last resort)

`reset --force` deletes the entire `docnexus/` folder — library documents, drafts, skills, and the store — plus the agent skill links pointing into it. Only suggest it for an unsupported project format or unrecoverable corruption. After explicit confirmation:

```bash
./node_modules/.bin/docnexus reset --force
./node_modules/.bin/docnexus init --agent claude
```

## Constraints

- Never run a `--force` or `--replace` command without explicit user confirmation.
- `index rebuild` only reprocesses registered library documents; it never imports unmanaged files.
