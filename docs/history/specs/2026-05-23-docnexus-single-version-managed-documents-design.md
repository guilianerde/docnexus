# DocNexus Single-Version Managed Documents Design

## Purpose

DocNexus currently has two persistent concepts:

- `records` and `.docnexus/records/<record_id>/` retain archived source, refined document, and metadata snapshots.
- `indexed_files` tracks mutable project files that may optionally point to an archived `record_id` for chunks, embeddings, and LadybugDB graph state.

That split is no longer required. DocNexus will manage current documents only: one project path identifies one current refined document, with one current source and metadata set, and all recall state derived from that version. Historical archive retention is removed.

## Confirmed Decisions

- The Agent or skill still performs document refinement before calling DocNexus. MCP does not call an LLM or generate content.
- A single archive/create operation persists and indexes a current managed document.
- The caller provides a project-relative target `file_path`; it is the unique document identity.
- First archive to a new path creates the target refined Markdown document. A later archive to the same managed path replaces its current source, document, metadata, chunks, embeddings, and graph state.
- Only the current source is retained for review; replaced versions are not kept.
- Independent indexing of files not created through archive is removed from the supported workflow.
- Document deletion physically deletes its target project file, DocNexus sidecar content, SQLite current state/chunks, and LadybugDB derived state.
- Deletion leaves no per-document audit or tombstone data.
- A destructive `reset` command clears all managed project files and the `.docnexus/` data domain for new-format stores.
- No automatic migration or compatibility layer for existing `records` / `indexed_files` stores is implemented.
- The previously implemented global MCP rule remains: every MCP tool invocation requires an absolute initialized `project_root`.

## Data Model

### Project Format

The version in `.docnexus/project.json` is incremented for the new model. Normal data commands operate only on the current format. Existing pre-change projects must be reset or manually remove `.docnexus/`, reinitialize, and capture current documents again.

### SQLite

`index.sqlite` uses one current-document table:

```sql
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  document_hash TEXT NOT NULL,
  metadata_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sidecar_path TEXT NOT NULL
);
```

`documents` replaces both `records` and `indexed_files`. There is no `record_id`, `index_state`, or `deleted_at`, because a row means a current managed document exists.

Chunks remain derived current state:

```sql
CREATE TABLE file_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

`file_chunks` is replaced when its document is updated and removed when its document is deleted.

The existing `index_events` table is removed. Since deletion is required to be traceless and the new model stores current state only, DocNexus does not retain operation rows that identify managed documents. Status reports current document and chunk counts only.

### Filesystem Layout

The refined Markdown document is written to the caller's managed project path, for example:

```text
docs/memory/auth.md
```

DocNexus stores only current sidecar assets under:

```text
.docnexus/
  project.json
  index.sqlite
  store.lbug
  schemas/
    metadata.schema.json
  documents/
    <document_id>/
      source.md
      metadata.json
```

The refined document is not duplicated in `.docnexus/`; the project target file is its current persisted representation. Overwriting a managed document replaces the target file and both sidecars in place. No previous-version directories are created.

### LadybugDB

LadybugDB continues to hold current `Document`, `Chunk`, and `Concept` graph/vector state. Its document identity aligns to `documents.id`, and its document path is the same `file_path` unique key. On update, derived graph/vector state for the document is replaced. On deletion, the document, chunks, and document-derived relations are removed.

## API And Command Contract

### Archive/Create Or Replace

The MCP tool name `archive_record` is retained to limit skill-facing churn, but its semantics become current-document upsert rather than historical archive append. It requires:

```json
{
  "project_root": "/absolute/path/to/initialized/project",
  "file_path": "docs/memory/auth.md",
  "source": "Original selected content",
  "document": "# Refined Current Document",
  "metadata": {
    "title": "Authentication",
    "summary": "...",
    "tags": [],
    "entities": [],
    "relationships": []
  }
}
```

The response returns the stable current document identity and path, with a `created` or `updated` result.

Processing sequence:

1. Validate absolute MCP `project_root`, current project format, metadata, and a project-contained relative `file_path`.
2. If the target path exists but is not already registered as managed, reject the request rather than overwrite a user file.
3. Determine the existing `documents` row by `file_path`, or allocate a document ID.
4. Compute chunks and embeddings from the refined `document`.
5. Write or replace the target project document and sidecars.
6. Replace the SQLite `documents` row and `file_chunks` rows.
7. Replace LadybugDB graph/vector state using the provided metadata and generated chunks.

The implementation must avoid reporting success until filesystem, SQLite, and LadybugDB state are all updated. Test design must include failure cases to avoid silently presenting partially replaced state as a valid current document.

### List, Read, And Status

These existing low-level MCP tool names are retained with current-document semantics:

- `list_records` lists current managed documents, not historical archive snapshots.
- `get_record` reads a current document's source, target Markdown file, and metadata.
- `status` returns current managed document count.
- `index_status` returns current managed document count and current chunk count only.

Documentation will state that these names are retained for API continuity while their data semantics are current-only.

### Remove Independent Indexing

`upsert_file_index` is removed from the MCP tool surface and normal CLI workflow. There is no supported route to index a file before or independently of a managed archive/create operation.

`docnexus index rebuild --force` remains a maintenance command. It re-embeds and reconstructs LadybugDB state from currently managed target files and their current metadata sidecars; it never imports unmanaged files.

### Physical Document Delete

`delete_file_index` is replaced by `delete_document`, using business-domain terminology. It accepts a managed `file_path` or document ID.

Because it deletes a project file, confirmation is mandatory:

- MCP requires `confirm: true`.
- CLI uses `docnexus document delete --file <path> --force` or `docnexus document delete --id <id> --force`.

For a current-format managed document, successful deletion:

1. Resolves and verifies the managed document row and target project path.
2. Verifies that the target file still exists and matches the current stored document hash.
3. Deletes its LadybugDB document/chunk/derived relation state.
4. Deletes its SQLite chunks and `documents` row.
5. Deletes its sidecar directory and the target project Markdown file.

No tombstone, delete event, source, metadata, chunk, graph node, or path-specific retained record remains.

## Reset

### Command

Add:

```bash
docnexus reset --force
```

This is intentionally destructive and returns the project to the uninitialized state. It is a CLI administrative operation, not an MCP tool.

### Current-Format Reset

When `.docnexus/project.json` identifies the current documents format, reset:

1. Reads the `documents` table to enumerate managed target files.
2. Deletes each registered target file only if it lies within the project root.
3. Removes the full `.docnexus/` directory, including SQLite, LadybugDB, sidecars, schema, and project marker.

Files not listed as managed documents are never removed.

### Old Or Damaged Store Reset

To avoid implementing compatibility or migration parsing, when the marker is absent, old, or unreadable, `reset --force` removes `.docnexus/` only. It cannot determine which external project files were managed under unknown historical formats, so it does not delete project files in that case.

After any reset, the user runs:

```bash
docnexus init
```

before capturing new current documents.

## Error Behavior

- Archive requires a relative `file_path` that resolves inside the initialized project. Absolute target paths and escapes outside the project are rejected.
- Archive refuses to overwrite an existing file that has no current `documents` registration.
- Update refuses if a registered target file is missing or no longer matches the stored current `document_hash`; this prevents overwriting external edits as though they were managed history.
- `delete_document` without MCP `confirm: true` or CLI `--force` fails before changing any storage.
- Delete refuses if its registered target is missing or externally changed; the operator may resolve the file or intentionally reset the complete store.
- Existing-format mismatch fails normal operations and directs users to `docnexus reset --force` followed by `docnexus init`.
- `reset` without `--force` fails without removing anything.

## Skill And Documentation Changes

`docnexus-capture` remains responsible for preparing `source`, `document`, and `metadata`; it additionally chooses and passes a managed project-relative `file_path`. Its single `archive_record` MCP call immediately creates or replaces recallable current state.

`docnexus-recall` remains CLI-driven and consumes current LadybugDB recall context. References now point to current managed target files only.

README and product briefs will describe:

- current-only documents with no archived history;
- archive-as-create-or-replace;
- absence of standalone file index admission;
- physical destructive deletion and required confirmation;
- destructive reset behavior; and
- new-store-only upgrade procedure.

## Scope Boundaries

Included:

- New current-document SQLite schema and format version.
- Current document sidecar storage and target-file persistence.
- Archive/create-or-replace plus automatic chunk/embed/graph indexing.
- Physical `delete_document` with confirmation.
- CLI-only destructive `reset --force`.
- Current-state list/read/status, rebuild, graph audit/repair, skills, tests, and docs updates required by the new lifecycle; graph maintenance reports current findings without retaining audit events.

Excluded:

- Historical version retention.
- Migration of old `records`/`indexed_files` data.
- Automatic backup or undo after deletion/reset.
- Ingesting unmanaged existing project files.
- LLM generation inside MCP.
- Changes to global MCP explicit `project_root` routing.

## Verification

Automated tests will demonstrate:

- `docnexus init` creates only the new current-document schema and version marker.
- An archive/create call creates a target project file, current sidecars, current document row, chunks, and graph input sufficient for recall.
- A second archive at the same managed path replaces source/document/metadata/chunks/graph state while leaving exactly one current document.
- Archive rejects a target path that already contains an unmanaged file.
- No independent `upsert_file_index` route remains available through MCP or normal CLI use.
- `delete_document` without explicit confirmation causes no changes.
- Confirmed delete removes target file, sidecars, SQLite document/chunks, and LadybugDB state without leaving document event or tombstone state, and the SQLite schema contains no `index_events` table.
- `reset --force` on current format deletes all managed target files and `.docnexus/`, while retaining unmanaged files.
- `reset --force` on an old/unknown store deletes only `.docnexus/`.
- Current list/read/status, recall, rebuild, and graph maintenance operate against `documents` only.
- Updated skills and user documentation do not instruct users to perform separate archive and index steps or expect historical retention.
