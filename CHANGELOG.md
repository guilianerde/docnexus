# Changelog

All notable user-visible changes to DocNexus are recorded here.

## 0.5.0 - 2026-09-30

Breaking release. Projects created by 0.4.x and earlier are not migrated; run `docnexus reset --force` and `docnexus init` again.

- Make text the only source of truth: each document keeps `source.md`, `metadata.json`, and a new `record.json` under `docnexus/records/<id>/`. `store/` is fully derived and git-ignored, so `docnexus/` can be committed and shared.
- Add `index sync` to rebuild derived state from records after a clone or `git pull`; `recall` runs it automatically when the index is stale. `index rebuild --force` now re-embeds every record from text and leaves unchanged records byte-identical.
- Add `document sync --id|--file [--metadata-file]` to adopt hand edits of library files; `status` and `doctor` list edited and missing library files.
- Generate `docnexus/CONCEPTS.md` from all records after every change and add `docnexus concepts [--type] [--query] [--format]`.
- `init --agent` and `skills link` add a marked DocNexus block to `CLAUDE.md` (with `@docnexus/CONCEPTS.md`) or `AGENTS.md`, so agents load the concept index and recall on their own; `reset` removes the block.
- Make `docnexus-recall` proactive: agents recall when a task touches a known concept, decision, or convention, without being asked. Writes still require user consent.
- Stamp synced skills with the package version; any command refreshes outdated workspace skills automatically, and `doctor` reports version drift.
- Project format version 5.

## 0.4.0 - 2026-09-30

Breaking release. Projects created by earlier versions are not migrated; see `docs/architecture/skills-workspace.zh-CN.md`.

- Move every DocNexus asset into a visible `docnexus/` workspace created by `init`: `skills/`, `drafts/`, `library/`, `schemas/`, and `store/`. The project format advances to version 4 and `.docnexus/` is no longer read.
- Store managed documents at `docnexus/library/<file_path>` and derived state (SQLite ledger, `graph.lbug`, sidecars, model overrides) under `docnexus/store/`.
- Reorganize the skills around an entry skill `docnexus` that routes requests and orchestrates the capture pipeline, plus `docnexus-extract`, `docnexus-ingest`, `docnexus-recall`, `docnexus-library`, and `docnexus-maintain`.
- Replace `skills install` with skills synced into `docnexus/skills/` by `init`/`skills sync` and exposed to agents through `init --agent` or `skills link --target claude|codex|all`.
- Add `draft new`, `draft seal`, `draft list`, and `draft discard`. Sealing validates artifacts and metadata, records hashes, and writes the manifest.
- `document add` now takes `--draft <draft_id>` only, rejects drafts modified after sealing, and marks ingested drafts.
- `status` reports draft counts; `doctor` checks workspace skills and agent links.
- `reset --force` removes the whole workspace and the skill links pointing into it, and refuses a `docnexus/` folder without a DocNexus marker.

## 0.3.0 - 2026-09-24

- Use project-installed skills and CLI without an MCP service or user-level skill installation.
- Add CLI commands for metadata validation, document listing and reading, and project status.
- Require CLI input files and model import sources to remain inside the target project.
- Keep the existing `.docnexus/` database and document format for in-place migration.
- Update the `sharp` override to 0.35.4 or newer within the 0.35 series to clear the production dependency audit.

## 0.2.0 - 2026-08-05

- Store managed Markdown files inside `.docnexus/` while preserving their project-relative logical paths.
- Persist verified extraction draft bundles under `.docnexus/drafts/<draft_id>/` before documents are added to the recall index.
- Add a completion manifest contract so document-add can consume verified source, document, and metadata artifacts.
- Advance the project data format to version 3 for the new storage boundary.

## 0.1.0 - 2026-07-18

- Initial public release with local ONNX embeddings, SQLite document/chunk state, LadybugDB graph/vector recall, CLI workflows, MCP tools, and packaged DocNexus skills.
