# DocNexus Relevance-First Graph RAG Design

Date: 2026-05-21

## Context

DocNexus already has the storage foundation for project-local recall:

- SQLite is the source-of-truth ledger for archives, indexed files, chunks, and index events.
- LadybugDB stores derived `Document`, `Chunk`, `Concept`, relationship, and vector index state.
- `docnexus recall` uses local embeddings and LadybugDB vector search.
- `docnexus-recall` is the conversation workflow that asks the CLI for context, then lets the agent answer with references.
- `docnexus graph audit` and `docnexus graph repair --force` now provide consistency checks and cleanup for the derived graph store.

The remaining product gap is recall quality. Current recall returns matched chunks with document summary, next chunk, direct concepts, and one-hop related concepts. That is useful, but it does not yet make the ranking policy explicit or separate high-confidence matched evidence from graph-derived supporting context.

## Goal

Improve `docnexus recall` with a relevance-first Graph RAG strategy:

- Keep chunk-to-query semantic relevance as the primary ranking signal.
- Attach document and graph context to each high-relevance match.
- Use graph relationships as controlled supporting context, not as the main ranking driver.
- Replace the old flat CLI JSON result fields with a structured context shape.
- Treat metadata and graph context as required recall dependencies.

The product principle is:

```text
Relevant chunk first, graph explains and expands.
```

## Non-Goals

This design does not add:

- Graph-first ranking.
- Deep multi-hop graph reasoning.
- Automatic recall before every answer.
- MCP final-answer generation.
- External model provider integration.
- File watching or automatic indexing.
- Embedding model switching.

## Chosen Approach

Use relevance-first retrieval with controlled graph support.

The recall pipeline should run in two layers:

1. **Primary retrieval layer**
   - Generate query embedding.
   - Query LadybugDB vector index for candidate chunks.
   - Rank primary results by chunk relevance to the query.
   - Keep the matched chunk as the anchor of each result.

2. **Context enrichment layer**
   - For each matched chunk, attach nearby and related context.
   - Context can help the agent answer, but it should not promote weak graph-neighbor chunks above stronger direct matches.

This is intentionally not pure graph expansion. Graph context is used after the system has already found relevant chunk anchors.

## Ranking Policy

Primary ranking must be dominated by matched chunk relevance.

Recommended ranking model for this phase:

```text
primary_score = chunk_similarity
```

Optional tie-breakers may be added only when the chunk similarity values are very close:

```text
final_score = chunk_similarity
            + small_title_or_summary_bonus
            + small_direct_concept_bonus
```

The bonuses must be small enough that a weak chunk cannot outrank a clearly stronger direct match.

Graph-derived supporting chunks should not participate in primary ranking in this phase. They are evidence context attached to an already selected result.

## Context Enrichment

For each matched chunk, return document context and graph context.

### Document Context

Document context should include:

- document title
- document path
- document summary
- previous chunk when available
- next chunk when available
- optionally, other high-relevance chunks from the same document

The purpose is to make the matched chunk understandable inside its source document.

### Graph Context

Graph context should include:

- directly mentioned concepts
- one-hop related concepts
- typed relationship information when available
- small supporting chunks from documents connected through those concepts

Graph supporting chunks must be limited. They should explain or expand the matched chunk, not dominate the answer.

## Output Shape

The CLI should return structured results only. The old flat result fields are intentionally not preserved because recall is becoming a Graph RAG workflow instead of a raw chunk list.

The output should separate primary evidence from supporting context:

```json
{
  "query": "string",
  "results": [
    {
      "matched_chunk": {
        "chunk_id": "string",
        "chunk_index": 0,
        "text": "matched chunk text",
        "score": 0.91
      },
      "document_context": {
        "title": "string",
        "path": "string",
        "summary": "string",
        "previous_chunk": {},
        "next_chunk": {},
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

The `docnexus-recall` skill must be updated to read the structured fields. Existing consumers that depend on flat result fields should migrate to `matched_chunk`, `document_context`, `graph_context`, and `ranking`.

## Data Flow

1. `recall(projectRoot, input, embedder)` validates query and limit.
2. The embedder creates a query vector.
3. LadybugDB vector search returns primary candidate chunks.
4. The service normalizes similarity scores.
5. For each candidate chunk:
   - require document metadata
   - load previous and next chunk
   - optionally load same-document supporting chunks
   - require direct graph concepts
   - load one-hop related concepts
   - load a capped set of graph supporting chunks
6. The service returns results ordered by primary relevance.

If required metadata or graph context is missing for a candidate, recall should fail with a clear diagnostic instead of silently returning partial context. This keeps the system honest: production Graph RAG depends on indexed files being linked to archived metadata and graph state.

## Guardrails

- Graph context must be capped per result.
- Supporting chunks should include source path, chunk index, and reason.
- Results should identify whether a chunk is the primary match or supporting context.
- Empty graph context should break recall with an actionable error for the affected result.
- Missing metadata should break recall with an actionable error for the affected result.
- Relevance sorting must remain stable when graph relationships are dense.

## Testing Strategy

Add focused tests before implementation:

- Primary ranking keeps the highest-similarity chunk first.
- Graph supporting chunks do not reorder primary results.
- A matched chunk returns document context from the same document.
- A matched chunk returns direct and one-hop graph context.
- Recall fails clearly when required metadata is absent.
- Recall fails clearly when required graph context is absent.
- CLI JSON returns structured fields only.

LadybugDB integration tests should stay guarded by `DOCNEXUS_LADYBUG_INTEGRATION=1` where runtime availability matters. Pure ranking and shape tests should use injected readers/stubs so they run in the default test suite.

## Implementation Boundaries

The implementation should be small and reversible:

- Update `LadybugRecallRow` and `RecallResult` types.
- Add focused LadybugDB query helpers for document and graph context.
- Keep the existing `recallFromLadybug(projectRoot, queryEmbedding, limit)` entry point unless a small internal helper split improves clarity.
- Do not change MCP tools.
- Do not change archive or index write semantics.
- Update `skills/docnexus-recall/SKILL.md` to consume structured fields.
- Update README/product docs after behavior is implemented.

## Success Criteria

The feature is complete when:

- `docnexus recall` ranks by direct chunk relevance first.
- Returned results include structured document and graph context.
- Graph context is visibly separated from primary matched evidence.
- The old flat recall result fields are removed from CLI JSON.
- Missing metadata or graph context causes a clear recall failure.
- Tests, typecheck, and build pass.
