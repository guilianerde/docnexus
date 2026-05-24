# DocNexus Document Skills And CLI Design

Date: 2026-05-24

## Purpose

DocNexus currently exposes current-document creation/overwrite and physical deletion as MCP tools:

- `archive_record`
- `delete_document`

These are mutation workflows initiated deliberately by a user in conversation. They will move out of MCP and be exposed through agent skills backed by CLI commands. MCP remains a read/validation service for an agent, but no longer provides these two document mutation tools.

## Confirmed Decisions

- Document extraction is a separate agent workflow and does not persist, index, or overwrite a managed document.
- Document addition persists an already prepared source, refined Markdown document, and metadata set, then indexes and updates LadybugDB in the existing single operation.
- Document deletion physically deletes the current managed document and its derived state, with no historical retention.
- The skills are explicitly/manual invoked workflows named:
  - `/docnexus-document-extract`
  - `/docnexus-document-add`
  - `/docnexus-document-delete`
- A new path is written without an extra confirmation prompt.
- When `/docnexus-document-add` targets an existing managed `file_path`, the skill must ask the user for confirmation before overwriting.
- CLI also enforces the overwrite boundary: updating an existing managed document requires explicit `--replace`. This prevents a skill or manual caller from accidentally bypassing the confirmation workflow.
- Existing ranking, embeddings, LadybugDB persistence, current-only document model, and project isolation are unchanged.

## Command Ownership

### Skill Workflows

`docnexus-document-extract` is an LLM workflow. It accepts user-selected source content or a source file and prepares:

- preserved source material;
- refined Markdown document;
- metadata matching the existing DocNexus schema; and
- a proposed project-relative managed document path.

It does not call document mutation commands. It may use `validate_metadata` through MCP while refining metadata, because that tool is validation-only.

`docnexus-document-add` receives or locates the approved source, refined Markdown, metadata, and managed `file_path`. It:

1. Determines whether `file_path` is already a managed current document.
2. If it is already managed, asks the user to confirm replacement and stops unless they confirm.
3. Runs the CLI add command without `--replace` for a new document, or with `--replace` only after replacement confirmation.
4. Reports the returned document ID, path, operation, and chunk count.

`docnexus-document-delete` identifies a managed document by `file_path` or ID, asks for explicit destructive deletion confirmation, and runs the CLI delete command only after confirmation.

The existing `docnexus-capture` skill is removed from installation and documentation to avoid two workflows owning the same mutation behavior.

### CLI Commands

Add the document write command:

```bash
docnexus document add \
  --file docs/memory/auth.md \
  --source-file /absolute/path/to/source.md \
  --document-file /absolute/path/to/refined.md \
  --metadata-file /absolute/path/to/metadata.json
```

For an existing managed path, require:

```bash
docnexus document add \
  --file docs/memory/auth.md \
  --source-file /absolute/path/to/source.md \
  --document-file /absolute/path/to/refined.md \
  --metadata-file /absolute/path/to/metadata.json \
  --replace
```

The command reads the three artifact files, parses JSON metadata, and delegates to the existing `upsertManagedDocument` operation. For a new document, `--replace` is unnecessary; for an existing document, omission fails without changing state.

Retain the existing physical delete commands:

```bash
docnexus document delete --file docs/memory/auth.md --force
docnexus document delete --id doc_0000000000000000 --force
```

Deletion remains destructive and fails before changes without `--force`.

### MCP Surface

Remove:

- `archive_record`
- `delete_document`

Retain:

- `list_records`
- `get_record`
- `status`
- `validate_metadata`
- `index_status`

All retained MCP tools continue to require absolute initialized `project_root`. `list_records` and `get_record` remain names for current managed documents; this change does not rename the read API.

## Data Flow

### Extract Then Add

1. The user invokes `/docnexus-document-extract` and identifies source material.
2. The agent produces source, refined Markdown, metadata, and a proposed managed file path.
3. The user invokes `/docnexus-document-add` or instructs the agent to add the extracted document.
4. The skill checks whether the target is already a managed document.
5. A new target proceeds directly; an existing managed target requires user confirmation and `--replace`.
6. CLI calls `upsertManagedDocument`, which writes the managed Markdown and sidecars and replaces chunks, embeddings, and LadybugDB graph state atomically under the existing behavior.

### Delete

1. The user invokes `/docnexus-document-delete` with a file path or document ID.
2. The skill describes that the managed Markdown and all derived state will be physically removed.
3. After explicit user confirmation, it runs `docnexus document delete ... --force`.
4. CLI calls `deleteManagedDocument` and reports the deletion result.

## Error Behavior

- `document add` requires `--file`, `--source-file`, `--document-file`, and `--metadata-file`.
- Artifact file read errors and malformed metadata JSON fail without mutation.
- Invalid metadata fails using existing metadata validation in `upsertManagedDocument`.
- An unmanaged file already present at the proposed managed path continues to be rejected.
- Updating an existing managed path without `--replace` fails without mutation.
- Existing protection for externally modified managed Markdown remains unchanged.
- `document delete` without `--force` fails without mutation.
- MCP calls to removed `archive_record` and `delete_document` fail as unknown tools.

## Implementation Scope

Included:

- CLI `document add` command and overwrite gate.
- Three document skill definitions and their installation list.
- Removal of `archive_record` and `delete_document` MCP registrations and handlers.
- Tests for CLI create/update confirmation enforcement, CLI deletion, MCP removal, and installed skill set.
- README and product brief updates in Chinese and English.

Excluded:

- Any data model migration.
- Changes to graph/vector storage or retrieval.
- Automatic document extraction.
- A new staging directory or persisted draft model for extracted artifacts.
- Renaming the retained current-document read tools.

## Verification

Automated verification must demonstrate:

- `docnexus document add` creates and indexes a new managed document from artifact files.
- A second `document add` to the same managed path fails without `--replace` and succeeds with it.
- `docnexus document delete --force` still physically removes a document created through the CLI.
- MCP rejects `archive_record` and `delete_document` as unknown tools while retained MCP reads/validation still work.
- Installed skills include `docnexus-document-extract`, `docnexus-document-add`, `docnexus-document-delete`, and `docnexus-recall`, and no longer install `docnexus-capture`.
- Documentation describes skills plus CLI as the mutation route and omits the removed MCP mutation tools.

