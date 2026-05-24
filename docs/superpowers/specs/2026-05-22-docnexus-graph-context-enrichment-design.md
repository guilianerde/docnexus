# DocNexus Graph Context Enrichment Design

Date: 2026-05-22

## Context

DocNexus now returns structured relevance-first Graph RAG recall results:

- `matched_chunk` is the primary evidence and owns main ranking.
- `document_context` carries source-document context.
- `graph_context` carries graph-derived supporting context.
- `ranking` states that graph context is supporting context, not the primary ranking driver.

The current structure is correct, but several fields are placeholders in practice:

- `document_context.same_document_chunks` is always empty.
- `graph_context.paths` is always empty.
- `graph_context.supporting_chunks` is always empty.

This makes the output shape future-ready, but the recall skill cannot yet use graph paths or additional supporting chunks as evidence.

## Goal

Fill the existing structured Graph RAG context fields with real one-hop context while keeping relevance-first ranking unchanged.

This iteration should:

- populate `same_document_chunks`
- populate one-hop `graph_context.paths`
- populate one-hop `graph_context.supporting_chunks`
- preserve the existing CLI JSON structure
- keep primary result order controlled by `matched_chunk.score`

## Non-Goals

This iteration does not:

- Add two-hop or three-hop graph reasoning.
- Promote graph-neighbor chunks into the primary ranked result list.
- Change `matched_chunk.score` semantics.
- Change MCP tools.
- Change embedding model behavior.
- Add model switching.
- Add automatic recall.
- Generate final answers inside DocNexus.

## Chosen Approach

Use one-hop context enrichment after primary vector recall.

The flow remains:

1. Query LadybugDB vector index for top matched chunks.
2. Keep those chunks as primary results.
3. For each primary result, enrich document context and graph context.
4. Return the same structured recall JSON shape.

Graph-derived data explains and expands a matched chunk, but it does not reorder primary results.

## Context Fields

### `document_context.same_document_chunks`

Return a small number of additional chunks from the same document.

Rules:

- Exclude the primary `matched_chunk`.
- Prefer nearby chunks around the matched chunk.
- Keep the list capped at `2`.
- Include `chunk_id`, `chunk_index`, `text`, and `reason`.
- Use reasons such as `same_document_before`, `same_document_after`, or `same_document_nearby`.

This field helps the agent understand the matched chunk in its local document flow.

### `graph_context.paths`

Return direct one-hop concept relationships from concepts mentioned by the matched document.

Rules:

- Start from concepts directly mentioned by the matched document.
- Follow only one relationship edge.
- Include relationship labels already modeled by LadybugDB:
  - `DEPENDS_ON`
  - `RELATES_TO`
  - `IMPLEMENTS`
  - `REPLACES`
  - `DECIDES`
- Cap at `5` paths per result.
- Preserve typed relationship names.

Example:

```json
{
  "from": "DocNexus Recall",
  "relationship": "DEPENDS_ON",
  "to": "LadybugDB"
}
```

This field gives the agent an explicit graph explanation instead of only flattened `related_concepts`.

### `graph_context.supporting_chunks`

Return a small number of chunks connected through one-hop related concepts.

Rules:

- Start from the matched document's direct concepts.
- Follow one concept relationship to related concepts.
- Find other documents that mention those related concepts.
- Return chunks from those related documents as supporting context.
- Exclude the primary matched chunk.
- Cap at `3` supporting chunks per result.
- Include `file_id`, `path`, `title`, `chunk_id`, `chunk_index`, `text`, and `reason`.
- Use `reason = "related_concept:<concept name>"`.

Supporting chunks remain evidence context only. They do not become primary recall results in this phase.

## Output Contract

The existing structured CLI JSON shape remains unchanged:

```json
{
  "query": "string",
  "results": [
    {
      "matched_chunk": {},
      "document_context": {
        "same_document_chunks": []
      },
      "graph_context": {
        "concepts": [],
        "related_concepts": [],
        "supporting_chunks": [],
        "paths": []
      },
      "ranking": {
        "primary": "chunk_similarity",
        "graph_used_as": "supporting_context"
      }
    }
  ]
}
```

This iteration fills existing arrays. It should not reintroduce old flat recall fields.

## Error Handling

The hard dependency rules from relevance-first Graph RAG remain:

- missing document metadata fails recall
- empty direct graph concepts fail recall

The new enrichment fields are derived from valid graph context:

- If there are direct concepts but no one-hop relationships, `paths` may be empty.
- If there are direct concepts but no related documents, `supporting_chunks` may be empty.
- If a document has only one chunk, `same_document_chunks` may be empty.

These empty enrichment arrays are valid because the required graph anchor exists.

## Implementation Boundaries

Keep the change concentrated in the recall storage/query path:

- `src/ladybug-store.ts` should enrich `LadybugRecallRow`.
- `src/recall.ts` should keep validation and output mapping simple.
- `src/cli.ts` should remain a thin JSON printer.
- `skills/docnexus-recall/SKILL.md` likely needs only wording updates if the current instructions already mention graph paths and supporting chunks.

No MCP behavior should change.

## Testing Strategy

Add tests before implementation:

- same-document context excludes the matched chunk and is capped.
- graph paths include typed one-hop relationships.
- supporting chunks are returned from related concept documents.
- supporting chunks do not reorder primary results.
- old flat fields remain absent.
- hard dependency failures still work for missing metadata and missing direct graph concepts.

Use injected/stubbed readers for pure recall contract tests. Use guarded LadybugDB integration tests only where runtime stability allows.

## Success Criteria

The feature is complete when:

- `document_context.same_document_chunks` is populated when nearby document chunks exist.
- `graph_context.paths` is populated when one-hop concept relationships exist.
- `graph_context.supporting_chunks` is populated when related concept documents exist.
- primary result order remains based on `matched_chunk.score`.
- CLI JSON shape remains structured-only.
- tests, typecheck, and build pass.
