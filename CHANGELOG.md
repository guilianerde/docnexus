# Changelog

All notable user-visible changes to DocNexus are recorded here.

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
