# Changelog

All notable user-visible changes to DocNexus are recorded here.

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
