# Fact lifecycle

Use optional `metadata.facts` for claims that need explicit source and validity tracking. Define each fact only once in its owning document's metadata. Other documents reference its id instead of copying the claim or its definition. Ordinary documents without structured facts remain supported.

Before adding a fact about an entity, inspect its existing facts:

```bash
./docnexus/node_modules/.bin/docnexus facts list --entity "<canonical name or alias>" --include-inactive
```

Example metadata fields (inside a complete metadata object):

```json
{
  "entities": [
    { "name": "Auth service", "type": "component", "description": "Authentication service", "aliases": ["AuthSvc", "认证服务"] }
  ],
  "facts": [
    {
      "id": "fact_rotation_daily",
      "text": "Refresh tokens rotate daily.",
      "provenance": "User decision in meeting 2026-10-01",
      "entity": "Auth service",
      "valid_from": "2026-10-01T09:00:00+08:00"
    },
    {
      "id": "fact_rotation_hourly",
      "text": "Refresh tokens rotate hourly.",
      "provenance": "User revised the policy in chat 2026-10-14",
      "entity": "Auth service",
      "valid_from": "2026-10-14T15:00:00+08:00",
      "replaces": "fact_rotation_daily"
    }
  ]
}
```

- Choose a stable, project-unique `fact_` id with letters, digits, hyphens or underscores. Preserve it in future edits. A metadata update must retain earlier fact entries.
- `text`, `provenance`, `entity`, `valid_from` and `replaces` are immutable for an existing id. Correct a claim by adding a new fact that explicitly replaces it. Do not infer replacement merely because two claims differ.
- `provenance` identifies the actual source. `valid_from` is when the claim becomes true, with an explicit timezone. Distinguish this from when the document is saved. If the effective date is unknown and matters, ask; if a user makes a decision effective now, use the current timestamp and state that basis.
- `entity` is optional; when present it must resolve to a declared entity or alias. Replacements must share the same canonical entity, including across documents. Prefer keeping a chain on the same canonical topic page.
- Set optional `valid_until` for an exclusive expiry. To retract an incorrect claim without replacing it, add `withdrawn_at` and `withdrawal_reason`. An existing expiry or withdrawal cannot be undone; add a new fact instead.
- A future replacement leaves the earlier fact active until the new fact's effective time. Expiry or withdrawal of the successor never revives its predecessor.
- Runtime statuses are `active`, `scheduled`, `expired`, `superseded`, and `withdrawn`. They are derived; do not write `status` into metadata.
- Put structured claims in Markdown through standalone references such as `{{fact:fact_rotation_daily}}`. The original id remains a stable reference: generated prose follows its effective replacement chain, including across documents. Preserve the reference when adding a replacement fact; do not manually copy the new wording into other pages.
- The CLI materializes `<!-- docnexus:fact fact_id -->` blocks with the current claim, provenance, effective time, owner path and status. Their contents are derived and repaired on access; edit metadata to change a fact. Preserve the markers and keep explanations outside them.
- Expired, withdrawn and not-yet-effective claims produce a status notice, not the inactive assertion. Fact writes refresh dependent pages within the same recoverable transaction. Document reads, search and index sync refresh elapsed-time changes; `docnexus document render` refreshes all views explicitly. There is no background refresh timer.
- Read author-owned text and reference placeholders with `docnexus document get --id <id> --include template,metadata`. No separate template file is stored. Code fences keep reference syntax literal; inline references are not supported.
- Avoid repeating changing fact values in hand-written explanations, summaries or entity descriptions. Free prose is not automatically understood or rewritten. Existing duplicated assertions need one reviewed conversion to references; do not infer or mechanically replace ambiguous paraphrases.
- For fact-backed drafts, sealing validates references and emits `preview.md` plus a hash. Review the preview and metadata. Ingestion refuses preview tampering or effective fact changes since sealing; reseal and review the new preview. On an ambiguous alias or invalid reference, inspect existing knowledge and correct the draft before resealing.

Example `document.md`:

```markdown
# Token rotation

## Current policy

{{fact:fact_rotation_daily}}

## Rationale

This policy limits credential replay. The current interval comes from the referenced decision.
```

The same reference can appear in another document without a second `facts` entry there.

Historical inspection:

```bash
./docnexus/node_modules/.bin/docnexus facts list --entity "AuthSvc" --at "2026-10-14T14:00:00+08:00" --include-inactive
```

This evaluates validity using the currently stored fact history; it does not reconstruct a Git snapshot of what was known at that time.
