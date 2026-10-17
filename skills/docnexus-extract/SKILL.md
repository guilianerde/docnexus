---
name: docnexus-extract
description: Use when the user asks DocNexus to extract, refine, or capture source material into a reviewable draft, or when the docnexus capture pipeline reaches its extract stage. Writes and seals a draft under docnexus/drafts/ without storing it as project memory.
---

# DocNexus Extract

Run commands from the project root using `./docnexus/node_modules/.bin/docnexus`. For a legacy root installation without that executable, use `./node_modules/.bin/docnexus` instead. Do not change into `docnexus/`; from another directory pass `--project-root <project>`.

Stage 1 of the capture pipeline. The output is a sealed draft; this skill does not store the draft in the library.

## Workflow

1. Identify the original content the user selected: pasted text, a named project file, or the relevant conversation excerpt. Ask if it is ambiguous.
2. Before allocating any draft, follow [capture resolution](references/capture-resolution.md): search/recall and read existing candidate pages, then decide `create`, `update`, `skip` or `conflict`. Hand off the decision, reason, checked document versions and proposed target. For create/update, retain the related-page impact check as a draft attachment following [impact tracking](../docnexus-library/references/impacts.md). `skip` and `conflict` end without sealing or ingestion.
3. For `create` or `update`, allocate a draft (use a short topic slug):

```bash
./docnexus/node_modules/.bin/docnexus draft new --slug <topic>
```

   The JSON result gives `draft_id` and the exact `artifacts.source`, `artifacts.document`, and `artifacts.metadata` paths. Write only to those paths.
4. Write `source.md`: the original material, preserving its meaning. It must not be empty.
5. Write `document.md`: a refined Markdown document with a `#` title and sections suited to the material. Keep facts faithful to the source.
6. Write `metadata.json` matching `docnexus/schemas/metadata.schema.json`:

```json
{
  "title": "Token rotation",
  "summary": "How refresh tokens are rotated and revoked.",
  "category": "guide",
  "category_reason": "The document explains an operational procedure, matching this project's existing guides.",
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

   - If the user or calling skill explicitly supplies a category, use its exact name and skip model classification for this document. Record the supplied basis, or `Explicit category supplied by caller.` when none is supplied; pass `--category <name>` and optional `--category-reason <basis>` to `draft seal`. Do not infer a caller instruction from the source material alone.
   - Otherwise, let the model choose a project-defined `category` after reading project context, the current category catalog and relevant existing documents; follow [contextual classification](../docnexus-library/references/classification.md). Prefer existing category ids, create a useful new name when necessary, and record `category_reason`. The example's guide category is illustrative, not a fixed taxonomy.
   - Revisit existing classifications when new context changes their meaning. Hand relevant category-only adjustments to `docnexus-library` after the primary capture/update, within existing authorization; keep this extraction stage focused on its draft. Legacy documents without categories can be classified when their content is reviewed. Use tags for cross-cutting subjects and avoid cosmetic category churn.
   - Set optional `observed_at` only from an explicit observation/statement timestamp with timezone in the current `source.md`. On replacement, remove the old value if the new material has none; do not inherit it from the merged knowledge, save time or event date. A date without a time/timezone, or an ambiguous date, stays in the source/prose without an invented timestamp. Preserve historical facts' `valid_from` and provenance independently. Report the selected source quote and timestamp, or why the field is omitted, in the review handoff.
   - Entity `type`: `component`, `concept`, `protocol`, `decision`, `file`, `tool`, or `other`.
   - Relationship `type`: `depends_on`, `mentions`, `implements`, `replaces`, `relates_to`, or `decides`; `from` and `to` should name declared entities.
   - `entities` and `relationships` may be empty; include only useful, source-grounded names and links.
   - Check canonical names and aliases in `docnexus/CONCEPTS.md` before creating entities. Reuse the canonical name and type. Put source-grounded alternative names in `aliases`; ambiguous aliases are rejected rather than silently merged.
   - For decisions, conventions or claims whose validity changes over time, define optional `facts` once in the owning metadata and reference them through standalone `{{fact:fact_id}}` lines in the document; see [fact lifecycle and generated views](references/facts.md). Preserve existing fact entries and ids. New claims need source attribution and an explicit effective timestamp; use `replaces` only when the source explicitly supersedes a known fact.
7. Use the resolution's library `file_path`: a relative Markdown path such as `auth/token-rotation.md`. It is stored at `docnexus/library/<file_path>`. Check `./docnexus/node_modules/.bin/docnexus document list` to reuse an existing path only when the user intends to update that document.
   When updating a path, read and retain its `record_version` together with its current document, reference template and timeline with `docnexus document get --id <id> --include document,template,metadata,timeline`. Compile the existing knowledge plus the new source into a complete current document: preserve still-valid facts, replace explicitly superseded conclusions, and identify unresolved conflicts. Edit the reference template, keeping explanations and references; the CLI generates fact wording. Convert old hand-written duplicates to references after reviewing their meaning, retaining structured history. Do not replace a whole page with only the latest fragment. The CLI appends the new source to `timeline.md`; do not copy old timeline events into the current knowledge.
8. For an update, seal with `--base-version <record_version>` from the read used to compose the draft. If the target changed since that read, reread its document/template, metadata and timeline, merge the draft with that knowledge, preserve user classification corrections, then use the reread version. Never refresh only the version without merging the content. For a new path, use `--base-version new`. Seal the draft. Sealing validates all three artifacts and the metadata, records their hashes and the target record version, and writes `manifest.json`:

```bash
./docnexus/node_modules/.bin/docnexus draft seal --id <draft_id> --file <file_path> --base-version <record_version|new>
```

   For a caller-selected category, append `--category codeReview --category-reason "Produced by the code-review skill"`. Sealing writes the category and basis into `metadata.json` and hashes the resulting artifact. Review that final metadata with the document; do not change classification during ingestion.

   Read the sealed document through `./docnexus/node_modules/.bin/docnexus draft preview --id <draft_id>` and show it with the final metadata for review. This returns ordinary or fact-expanded Markdown, its `document_hash` and the `sealed_version`; retain that version in the handoff. `preview_file` remains available for fact-backed drafts; do not edit it directly. A successful preview means that content was delivered, not that review or user approval occurred. After resealing, read the new preview and reassess whether existing authorization covers its content. On a validation error, fix the named artifact and run seal again. Use `./docnexus/node_modules/.bin/docnexus metadata validate --file <metadata_path>` to iterate on metadata alone.

## Result

End with exactly one outcome. On success:

```text
result: draft_ready
draft_id: <draft_id>
file_path: <file_path>
replaces_managed_document: <true|false>
capture_decision: <create|update>
decision_reason: <basis>
checked_documents: <read ids, paths and record_version values>
source_time: <explicit source quote and observed_at, or omission reason>
impact_check: <scope, lookup failures and related-page decisions from capture resolution>
impact_file: <impact.json inside this draft directory; pending registration after primary ingestion>
preview: <draft_id, sealed_version and document_hash actually returned>
title: <metadata.title>
category: <metadata.category>
category_reason: <metadata.category_reason>
entities: <entity names>
```

For `skip`, report `result: capture_skipped`, the existing document references and why there is no new knowledge/provenance. For `conflict`, report `result: capture_conflict`, the conflicting evidence/targets and the unresolved decision. Neither outcome has a new `draft_id`.

On failure report `result: draft_failed`, the failed step, the CLI error, and the draft id if one was allocated.

## Constraints

- Never run `docnexus document add` here; ingestion belongs to `docnexus-ingest`.
- Never write outside the draft directory returned by `draft new`. Write the three knowledge artifacts to their returned paths and the impact check only to `impact.json` in that directory. Never reuse a sealed or ingested draft for a different capture or target; allocate a new one. Same-target corrections and stale merges must be resealed and reviewed. The impact attachment is reviewed context, not a sealed knowledge artifact.
- Editing an artifact after sealing invalidates the draft until it is sealed again.
- Never invent entities or relationships absent from the source.
