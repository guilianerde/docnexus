---
name: docnexus-extract
description: Use when the user asks DocNexus to extract, refine, or capture source material into a reviewable draft, or when the docnexus capture pipeline reaches its extract stage. Writes and seals a draft under docnexus/drafts/ without storing or indexing it.
---

# DocNexus Extract

Stage 1 of the capture pipeline. The output is a sealed draft; this skill does not store or index anything.

## Workflow

1. Identify the original content the user selected: pasted text, a named project file, or the relevant conversation excerpt. Ask if it is ambiguous.
2. Allocate a draft (use a short topic slug):

```bash
./node_modules/.bin/docnexus draft new --slug <topic>
```

   The JSON result gives `draft_id` and the exact `artifacts.source`, `artifacts.document`, and `artifacts.metadata` paths. Write only to those paths.
3. Write `source.md`: the original material, preserving its meaning. It must not be empty.
4. Write `document.md`: a refined Markdown document with a `#` title and sections suited to the material. Keep facts faithful to the source.
5. Write `metadata.json` matching `docnexus/schemas/metadata.schema.json`:

```json
{
  "title": "Token rotation",
  "summary": "How refresh tokens are rotated and revoked.",
  "tags": ["auth"],
  "entities": [
    { "name": "Auth service", "type": "component", "description": "Service that issues and revokes tokens." },
    { "name": "Refresh token", "type": "concept", "description": "Long-lived credential rotated on every use." }
  ],
  "relationships": [
    { "from": "Auth service", "to": "Refresh token", "type": "implements", "description": "Issues and rotates the token." }
  ]
}
```

   - Entity `type`: `component`, `concept`, `protocol`, `decision`, `file`, `tool`, or `other`.
   - Relationship `type`: `depends_on`, `mentions`, `implements`, `replaces`, `relates_to`, or `decides`; `from` and `to` should name declared entities.
   - At least one source-grounded entity is required.
6. Choose a library `file_path`: a relative Markdown path such as `auth/token-rotation.md`. It is stored at `docnexus/library/<file_path>`. Check `./node_modules/.bin/docnexus document list` to reuse an existing path only when the user intends to update that document.
7. Seal the draft. Sealing validates all three artifacts and the metadata, records their hashes, and writes `manifest.json`:

```bash
./node_modules/.bin/docnexus draft seal --id <draft_id> --file <file_path>
```

   On a validation error, fix the named artifact and run seal again. Use `./node_modules/.bin/docnexus metadata validate --file <metadata_path>` to iterate on metadata alone.

## Result

End with exactly one outcome. On success:

```text
result: draft_ready
draft_id: <draft_id>
file_path: <file_path>
replaces_managed_document: <true|false>
title: <metadata.title>
entities: <entity names>
```

On failure report `result: draft_failed`, the failed step, the CLI error, and the draft id if one was allocated.

## Constraints

- Never run `docnexus document add` here; ingestion belongs to `docnexus-ingest`.
- Never write outside the draft directory returned by `draft new`, and never reuse a sealed or ingested draft for different content; allocate a new one.
- Editing an artifact after sealing invalidates the draft until it is sealed again.
- Never invent entities or relationships absent from the source.
