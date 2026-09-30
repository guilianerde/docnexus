---
name: docnexus-recall
description: Use proactively, without waiting to be asked, whenever a task in this project touches a concept listed in docnexus/CONCEPTS.md or a documented decision, component, convention, or earlier design; also when the user asks to recall, search, or answer from DocNexus project memory. Read-only.
---

# DocNexus Recall

Loads curated project knowledge into your working context. You decide when to use it.

## When to recall

Recall on your own when any of these holds:

- The task names or will change something listed in `docnexus/CONCEPTS.md`.
- You are about to make or revisit a design decision, choose between approaches, or follow a project convention.
- The user refers to earlier decisions ("as we agreed", "the usual way", "why is X like this").
- The user explicitly asks DocNexus or project memory.

Skip recall for trivial or self-contained edits, general programming questions, and anything already recalled in this conversation. Prefer one focused recall per topic; at most three per task unless the user asks for more.

## Building the query

- Load `docnexus/CONCEPTS.md` first if it is not already in context. Use concept names from it verbatim in the query; they are the graph anchors.
- Combine the concept with the intent: `"<concept> <what you need to know>"`, e.g. `"Refresh token rotation policy"`.
- Narrow the concept list when it is long: `./node_modules/.bin/docnexus concepts --query <word>` or `--type decision`.

## Workflow

1. Build the query as above; for user questions use the user's wording.
2. Use `5` as the default limit unless the user asks for a different number of results.
3. Run recall from an initialized DocNexus project (it syncs a stale index automatically):

```bash
./node_modules/.bin/docnexus recall "<query>" --limit 5
```

4. If the command reports that the project is not initialized, tell the user to run `./node_modules/.bin/docnexus init --agent claude` (or `codex`) in the project before retrying. Do not fall back to a global CLI or another repository's `dist/src/cli.js` path.
5. Parse the JSON output.
6. Read `results[]` as the primary ranked chunk evidence list. Each result points to a current managed document group through `document_ref.document_id` and `document_ref.group_id`.
7. Read `context_groups[]` as the complete answer context. Each group consolidates one current managed document, its primary matched chunks, nearby same-document chunks, and one-hop graph evidence.
8. Treat `results[].matched_chunk.score` as the relevance signal. Do not rerank results because a group has additional graph support.
9. Answer the user's question from `context_groups[]`, using `results[]` to explain why a document was recalled. Do not claim DocNexus evidence for facts absent from the grouped context.
10. Include a concise `References` section listing the library files used. `document.path` is relative to `docnexus/library/`; cite it as `docnexus/library/<path>`. Include the highest matched chunk index and score for each cited group when present.
11. If recall fails, report that DocNexus could not return required Graph RAG context and hand over to `docnexus-maintain` for diagnosis.
12. If recall returns no results, say DocNexus did not find matching current managed document context. You may still answer from the current conversation if that is useful, but keep that distinction clear.
13. When you recalled on your own during a task, say so in one line (for example "Checked DocNexus: auth/token-rotation.md requires …") and let the recalled facts shape the work. If memory conflicts with the code or the user's request, point out the conflict instead of silently picking one.

## Output Guidance

- Keep the answer focused on the user's query.
- Prefer concrete project facts from `context_groups[].matched_chunks` over generic explanation.
- Use `context_groups[].same_document_chunks` to complete the local document meaning.
- Use `context_groups[].graph_context.paths` to explain typed one-hop relationships.
- Use `context_groups[].graph_context.supporting_chunks` only as supporting cross-document evidence.
- Treat all chunks in one group as one source document when citing references.
- Mention uncertainty when recalled context is incomplete or conflicting.
- Do not paste large chunks verbatim. Summarize and cite the file paths.

## Reference Format

Use this shape when results include source locations:

```markdown
References:
- `docnexus/library/<context_groups[].document.path>`, chunk `context_groups[].matched_chunks[0].chunk_index`, score `context_groups[].matched_chunks[0].score`
```

If scores or chunk indexes are absent, omit only the missing fields.
