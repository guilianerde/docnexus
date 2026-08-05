# Changelog

All notable user-visible changes to DocNexus are recorded here.

## 0.2.0 - 2026-08-05

- Store managed Markdown files inside `.docnexus/` while preserving their project-relative logical paths.
- Persist verified extraction draft bundles under `.docnexus/drafts/<draft_id>/` before documents are added to the recall index.
- Add a completion manifest contract so document-add can consume verified source, document, and metadata artifacts.
- Advance the project data format to version 3 for the new storage boundary.

## 0.1.0 - 2026-07-18

- Initial public release with local ONNX embeddings, SQLite document/chunk state, LadybugDB graph/vector recall, CLI workflows, MCP tools, and packaged DocNexus skills.
