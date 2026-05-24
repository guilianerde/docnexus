---
name: docnexus-recall
description: Use when the user explicitly asks to recall, search, or answer from DocNexus project memory.
---

# DocNexus Recall

Use this skill only when the user explicitly asks to use DocNexus recall, search project memory, retrieve indexed project context, or answer from DocNexus memory.

Do not trigger automatically for every question. DocNexus recall is manually requested.

## Workflow

1. Identify the user's recall query. Use the user's wording when possible.
2. Use `5` as the default limit unless the user asks for a different number of results.
3. Run recall from an initialized DocNexus project:

```bash
docnexus recall "<query>" --limit 5
```

4. If the command reports that the project is not initialized, tell the user to run `docnexus init` in the project before retrying. Do not fall back to a repository-local `dist/src/cli.js` path.
5. Parse the JSON output.
6. Read `results[]` as the primary ranked chunk evidence list. Each result points to a current managed document group through `document_ref.document_id` and `document_ref.group_id`.
7. Read `context_groups[]` as the complete answer context. Each group consolidates one current managed document, its primary matched chunks, nearby same-document chunks, and one-hop graph evidence.
8. Treat `results[].matched_chunk.score` as the relevance signal. Do not rerank results because a group has additional graph support.
9. Answer the user's question from `context_groups[]`, using `results[]` to explain why a document was recalled. Do not claim DocNexus evidence for facts absent from the grouped context.
10. Include a concise `References` section listing the group document paths used. Include the highest matched chunk index and score for each cited group when present.
11. If recall fails, report that DocNexus could not return required Graph RAG context. Current managed documents require metadata and LadybugDB graph state; run index rebuild or graph repair when appropriate.
12. If recall returns no results, say DocNexus did not find matching current managed document context. You may still answer from the current conversation if that is useful, but keep that distinction clear.

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
- `context_groups[].document.path`, chunk `context_groups[].matched_chunks[0].chunk_index`, score `context_groups[].matched_chunks[0].score`
```

If scores or chunk indexes are absent, omit only the missing fields.
