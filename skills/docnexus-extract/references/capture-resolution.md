# Resolve a capture before writing

Run this check for every capture, including calls from another skill and an explicit new filename. It belongs to the host agent: the CLI does not infer semantic duplicates or enforce a similarity threshold. Respect the caller's chosen category, document purpose, target and authorization.

## Find and read candidates

1. Identify the primary subject, purpose and event/version identity of the new material.
2. Search the subject's names, aliases or identifiers, then recall a short description of the new information. Check exact concept names and aliases with `docnexus concepts --query <term>`. Browse the related category file in `docnexus/concepts/` only to disambiguate or when results are weak; use `document list` or paginated `document query` when needed. An absent map or category entry is not proof of a new subject:

```bash
./docnexus/node_modules/.bin/docnexus search "<subject or identifier>" --limit 10
./docnexus/node_modules/.bin/docnexus recall "<subject and proposed knowledge>" --limit 5
./docnexus/node_modules/.bin/docnexus document get --id <candidate_id> --include source,document,template,metadata,timeline
```

   If a category is supplied, search it first using `--category <exact name>`. Unless the user explicitly restricts lookup to that category, also check the subject across categories to find shared facts and related pages. Cross-category relevance does not authorize changing another category's page. If lookup is explicitly restricted, report that boundary and keep the decision within it.
3. Read plausible candidates in full, retaining their `record_version`. Compare subject identity, document purpose, event/date/version, current claims, source provenance and fact lifecycle. Similar wording, a shared category or a high score alone does not justify merging. If recall is unavailable, use literal variants plus the document catalog and full reads; disclose the fallback. Failed or incomplete lookup is not evidence that no duplicate exists.

## Choose one disposition

| Decision | When | Action |
| --- | --- | --- |
| `update` | Same subject and purpose, with new knowledge, a justified correction or additional provenance | Reuse the existing path and compose its complete current knowledge from the read template plus new source. Preserve valid prose, facts, ids, references and history. |
| `create` | New subject, or a distinct event/report/version worth retaining separately | Create a new path and cite related existing pages where useful. Reuse existing fact references rather than defining another copy. |
| `skip` | Same material is already represented, with no new claim, event or useful provenance | Report the existing document and the comparison basis. Allocate no draft and perform no memory write. |
| `conflict` | Material contradicts current knowledge without clear replacement authority, or multiple targets remain ambiguous | Report both claims/targets and their sources. Prepare no replacement or ingestion until the ambiguity is resolved; ask only for the missing decision. |

An explicit user correction can justify `update`; a later timestamp alone cannot. Preserve superseded structured fact entries and use `replaces` only when the source explicitly supports replacement. A new independent source can add useful provenance even when the conclusion is unchanged, so it need not be skipped. Keep `observed_at` grounded in the new source.

Separate event records from enduring knowledge. Two code reviews of the same module on different commits are distinct reports: preserve each report under the caller's exact category. A durable module page may also need updating, but that is a separate draft with its own version/read/review and authorization. Do not overwrite one review with another, delete older pages, or update every related page merely because it was retrieved.

Honor an explicit target. If the user asks for a separate file despite overlap, explain the overlap and retain that choice. If they name an update target, do not silently redirect it. An occupied target still requires the existing replacement/version checks. Caller-selected classification does not authorize reclassifying a related document to make it a merge target.

## Check related-page impact

For a proposed create/update, check whether the new claims affect other current pages. Use the existing subject search/recall, entity names, fact ids and links to find candidates; follow concrete dependencies as needed, without claiming an exhaustive whole-library scan. Read each plausible page's full document/template and metadata, and timeline when needed to distinguish historical reports, retaining its `record_version`. A search hit or shared entity alone is not a dependency or permission to edit.

Include an `impact_check` with lookup scope/limitations and related `pages`, each with `id`, `file_path`, the actually read `record_version`, `decision`, evidence and proposed action:

| Decision | Meaning |
| --- | --- |
| `update` | Source-backed change makes current explanations or steps inaccurate; describe the required edit. |
| `no_change` | Read and checked; explain why it remains valid, including independent historical reports. |
| `conflict` | Give both sources and the missing replacement authority/decision; do not rewrite the disputed claim. |
| `unverified` | Found but not fully read, lookup failed or evidence is insufficient; use a null version when no full versioned read was obtained. Never report it as unaffected. |

An empty list needs the lookup basis, not a claim that no other page can be affected. Keep a related-page conflict local when the primary change is independently supported; if it undermines the primary decision, use capture `conflict` and stop. Unresolved candidates stay visible in the handoff.

Existing `{{fact:id}}` references already follow effective replacements. Check surrounding explanations and operational steps instead of duplicating the fact definition or making a draft solely to refresh a generated block. A parameter change does not itself authorize rewriting the historical design rationale.

For each related page requiring edits, prepare a separate draft only within the user's existing scope and authorization. Each draft uses its own full read, base version, sealed preview and review. Do not write a related draft inside the primary draft's directory or silently ingest all candidates. These are independent commits, not an atomic multi-page operation; report completed and pending pages if interrupted. Recheck a page before acting when its version changes, reread/merge/reseal as needed, and revise the impact decision if the new content changes it.

The impact check is agent-produced review context, not a new metadata/manifest field or a mechanically enforced whole-library consistency guarantee. It does not change the primary capture disposition or authorize cross-category writes. For create/update, retain it in the draft's `impact.json` and register it after primary ingestion using [impact tracking](../../docnexus-library/references/impacts.md); saving a document alone does not register its related-page work.

## Handoff and review

Before allocating a draft, give a compact resolution summary:

- `capture_decision`: `create`, `update`, `skip` or `conflict`.
- `decision_reason`: subject/purpose match, new information/provenance, or unresolved contradiction.
- `checked_documents`: actual read ids, paths and `record_version` values; note lookup scope/failures. An empty list requires an explanation of the successful lookup performed.
- `file_path` for a proposed create/update, plus related existing paths where relevant.
- `source_time`: a quote supporting the current source's explicit observation timestamp, or the reason `observed_at` is omitted. Event dates and prior source dates do not fill an unknown observation time.
- `impact_check` for create/update: scope/limitations and related-page decisions with evidence and read versions.

This is a workflow handoff, not a new manifest field or CLI response. Do not claim the decision was mechanically validated or stored in the manifest. For create/update, show this summary with the proposed content at the normal review stage; existing authorization still applies. Skip/conflict ends extraction without a sealed draft.

For update, seal with the version of the target actually read. New source belongs in the draft's `source.md`; the CLI preserves earlier source events in the timeline. Do not copy old timeline entries into the current body. A stale target requires rereading and redoing the comparison/merge, not simply changing `--base-version`.

When ingesting a ready draft directly, verify a resolution handoff, source-time attribution and impact check exist and match its sealed target/content. If absent (including older drafts), run this lookup/comparison using its source and proposed document before saving. If the decision requires a different target or capture intent, return to extraction, prepare a new draft and review it. A same-target merge uses the existing reread/edit/reseal/review flow; never ingest edited artifacts without resealing or bypass the target/version checks. A duplicate draft may be left ready after `skip`; report its status, and discard only with existing authorization.

These checks reduce duplicate capture through agent behavior. They are not an atomic whole-library uniqueness guarantee: another writer can create a related page after lookup. The CLI guards the selected target and sealed artifacts; on discovering new competing knowledge, repeat the resolution before writing.

The subject-page and source-history approach is adapted from [GBrain ingestion](https://github.com/garrytan/gbrain/blob/master/skills/ingest/SKILL.md) and [filing rules](https://github.com/garrytan/gbrain/blob/master/skills/_brain-filing-rules.md), using DocNexus's existing draft, fact and authorization contracts.
