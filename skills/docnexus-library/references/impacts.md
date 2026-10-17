# Persist and resume related-page impact work

Impact records are review context, not project facts or permission to modify a document. They live in `docnexus/impacts/<impact_id>.json`, separate from the library, skills and rebuildable stores. Keep them with the knowledge workspace in Git and backups. No workspace migration or retrieval index is needed.

## Save an impact check

During extraction, write the reviewed `scope`, `limitations` and related `pages` to `impact.json` inside the returned draft directory. This is a resumable attachment, not one of the three sealed knowledge artifacts. If the session ends before ingestion, the attachment remains; it is not yet a saved impact record.

After the authorized primary document is ingested, read its full current document/metadata with `document get`. Add its actual `id` and `record_version` as `source` to that attachment, preserving the related-page decisions and their actual read versions:

```json
{
  "source": { "id": "<primary document id>", "record_version": "<version just read>" },
  "scope": "Subject and lookup scope",
  "limitations": "Lookup failures, unverified candidates or coverage limits; empty if none",
  "pages": [
    {
      "id": "<related document id>",
      "file_path": "auth/client-guide.md",
      "record_version": "<version actually read, or null only when unverified>",
      "decision": "update",
      "evidence": "Why the new confirmed knowledge affects this page",
      "proposed_action": "What needs checking or changing"
    }
  ]
}
```

Decisions are `update`, `no_change`, `conflict`, `unverified`. Exclude the primary page from `pages`; an empty array is allowed with an explicit successful lookup scope. `no_change` starts done; the other decisions start pending. Unknown read versions must remain null and unverified, never guessed from a search hit.

```bash
./docnexus/node_modules/.bin/docnexus impact save --file docnexus/drafts/<draft_id>/impact.json
```

The CLI verifies the current source and checked-page versions and paths. If they changed, reread the affected source/pages, reconsider the decisions, update the attachment and save again; do not just replace version strings. Equal input returns the existing impact record with its progress intact. Save within the user's authorized capture scope; additional document edits still require their own authorization.

Primary ingestion and impact saving are separate operations. If saving fails, report the primary as saved and impact tracking as pending, retain the draft attachment and resume the save after resolving the error. Do not re-ingest the primary, discard its draft or claim the impact check is durably registered until `impact save` succeeds. Report `impact_id` and `impact_path` with the document result. Old ingested drafts without an attachment need fresh reads and impact assessment; do not invent a historical checklist.

## Resume and resolve

```bash
./docnexus/node_modules/.bin/docnexus impact list
./docnexus/node_modules/.bin/docnexus impact list --status pending
./docnexus/node_modules/.bin/docnexus impact list --status needs_review
./docnexus/node_modules/.bin/docnexus impact get --id <impact_id>
```

Each page retains its original decision/read version and status history. `pending` needs action, `done` records a completed check and `dismissed` records a reasoned decision not to pursue it. `needs_review` is computed from changes to the source or target identity/version/rendered content since the last recorded check. It can reopen a done or dismissed page, including after a fact expires without changing the record version. Read both pending and needs-review work; checking only pending can miss reopened items.

Each `--status` accepts one value. Use the two separate queries above or an unfiltered list to see both pending and needs-review items; comma-separated statuses are not supported.

Before acknowledging a page, read the current source and related full document, resolve or explain any conflict and inspect the latest `impact get`. For content changes, use a separate authorized draft with the actual base version, preview and ingestion. Then acknowledge the result using the fresh impact revision:

```bash
./docnexus/node_modules/.bin/docnexus impact set --id <impact_id> --document <document_id> \
  --status done --reason "Reviewed the current page and verified the separate update" --revision <impact_revision>
```

Use `pending` to record a renewed check that still needs work, `dismissed` only with a source-grounded reason within authorization. Deleted pages cannot be marked done; a replacement at the same path is a different identity. `impact_changed` requires fresh reads and a new judgment, not a revision-only retry.

Status changes append history and never edit knowledge or resolve a fact conflict mechanically. A saved check records the agent's judgment, not proof of complete dependency coverage, semantic correctness or user approval. These records are not indexed as current knowledge. Queries render current facts in memory without refreshing library files. Corrupt or symlinked records are refused rather than silently dropped; inspect/restore the named text file. Reset removes impacts along with other project knowledge.
