# DocNexus Grouped Recall Context Design

Date: 2026-05-23

## Context

DocNexus currently returns relevance-first Graph RAG recall results as a flat list of primary chunk hits. Each result carries:

- `matched_chunk`, ranked by vector similarity
- `document_context`, including document metadata and nearby chunks
- `graph_context`, including direct concepts, typed one-hop paths, and supporting chunks
- `ranking`, stating that graph data is supporting evidence

That contract has established the correct ranking boundary, but it repeats document-level evidence when several primary chunks belong to the same file. The storage query path also enriches each result separately by loading graph paths and supporting chunks for each primary row.

For a recall limit of `N`, the current path performs one primary vector query followed by two enrichment queries for each result. Repeated hits from the same document therefore repeat database work and repeated JSON evidence.

GitNexus provides a useful architectural precedent: retrieval hits remain ranking evidence, while related hits are collected into a stable context unit for agent consumption. GitNexus uses code execution processes as its context unit. DocNexus should adopt the collection principle, but use its existing `Document` / `file_id` entity rather than introduce a process model that does not fit document memory.

## Goal

Add a complete document-grouped recall view and batch the one-hop enrichment query path.

This iteration should:

- preserve vector-ranked primary chunk matches
- replace repeated per-result context with a complete `context_groups[]` view grouped by document
- let agents read each matched document's supporting evidence once
- batch document and graph enrichment instead of querying for each primary match
- keep one-hop graph evidence controlled, deduplicated, and capped
- validate the grouped path through real LadybugDB integration coverage

## Non-Goals

This iteration does not:

- add BM25 or reciprocal-rank fusion
- change embedding model behavior or add model switching
- add two-hop or deeper graph reasoning
- introduce process, topic-cluster, or new metadata entity types
- change MCP tools
- generate final answers inside DocNexus
- add automatic capture or file watching

## Chosen Approach

Use a two-view recall contract:

1. `results[]` is the ordered list of primary vector-matched chunks.
2. `context_groups[]` is the complete document-level evidence view consumed by the recall skill.

Primary matching remains chunk-based. Grouping is an output and enrichment concern, not a new ranking algorithm. Each context group corresponds to exactly one matched `file_id`; the first version uses that `file_id` as `group_id`.

This is a breaking recall JSON contract change. Existing consumers must switch from reading `results[].document_context` and `results[].graph_context` to reading `context_groups[]`.

## Output Contract

The CLI returns:

```json
{
  "query": "LadybugDB and embedding",
  "results": [
    {
      "matched_chunk": {
        "chunk_id": "chunk_001",
        "chunk_index": 2,
        "text": "LadybugDB stores chunk vectors.",
        "score": 0.91
      },
      "document_ref": {
        "group_id": "file_001",
        "file_id": "file_001",
        "path": "docs/architecture.md"
      },
      "ranking": {
        "primary": "chunk_similarity",
        "graph_used_as": "grouped_supporting_context"
      }
    }
  ],
  "context_groups": [
    {
      "group_id": "file_001",
      "document": {
        "file_id": "file_001",
        "path": "docs/architecture.md",
        "record_id": "rec_001",
        "title": "Architecture",
        "summary": "DocNexus storage architecture."
      },
      "matched_chunks": [
        {
          "chunk_id": "chunk_001",
          "chunk_index": 2,
          "text": "LadybugDB stores chunk vectors.",
          "score": 0.91
        }
      ],
      "same_document_chunks": [],
      "graph_context": {
        "concepts": ["LadybugDB", "Embedding"],
        "related_concepts": ["Vector Recall"],
        "paths": [],
        "supporting_chunks": []
      },
      "ranking": {
        "primary_score": 0.91,
        "primary": "highest_matched_chunk_score"
      }
    }
  ]
}
```

### `results[]`

`results[]` remains ordered by `matched_chunk.score` descending and contains only primary recall evidence:

- `matched_chunk`
- `document_ref.group_id`
- `document_ref.file_id`
- `document_ref.path`
- `ranking`

It no longer exposes `document_context` or `graph_context`.

### `context_groups[]`

`context_groups[]` contains one complete evidence group per matched document:

- `group_id`, equal to `document.file_id` in this iteration
- `document`, carrying metadata required for source identification and answer framing
- `matched_chunks[]`, containing all primary hits from the document
- `same_document_chunks[]`, containing nearby non-primary chunks
- `graph_context`, containing direct concepts, related concepts, typed one-hop paths, and cross-document supporting chunks
- `ranking.primary_score`, equal to the group's highest matched chunk score

Groups are ordered by `ranking.primary_score` descending. When two groups share the same highest score, their order is the order in which they first appear in `results[]`.

Within a group, `matched_chunks[]` is ordered by score descending, preserving the order inherited from `results[]` on equal scores.

## Data Flow

`recallFromLadybug(...)` should use four stages.

### 1. Primary Vector Recall

Query LadybugDB's chunk vector index for up to `limit` primary matches. Load the minimal document identity required to form `document_ref` and create document groups.

This stage alone determines `results[]` ordering.

### 2. Document Grouping

Group primary matches by `file_id`.

For each distinct matched document:

- create one `group_id`
- collect its primary `matched_chunks[]`
- assign `primary_score` from its highest-scoring chunk
- record the document's first primary-result position as its stable tie breaker

### 3. Batched Enrichment

Load enrichment for all matched `file_id` values in fixed query batches, instead of loading it per primary match. The existing primary vector query already returns document metadata, direct/related concepts, and nearby same-document chunks. Additional batch queries load:

- typed one-hop graph paths
- cross-document supporting chunks linked through one-hop related concepts

The intended query budget is fixed with respect to the requested result limit:

- one primary vector query, including document identity, metadata anchors, concepts, and nearby chunks
- one typed path query
- one supporting-chunk query

The implementation may combine enrichment queries where LadybugDB query behavior makes that simpler, but it must not restore per-result enrichment loops.

### 4. Output Assembly

Build both response views from the same primary match list and enrichment maps:

- `results[]` exposes ranking evidence and group references.
- `context_groups[]` exposes complete evidence for answer generation.

No enrichment evidence may reorder `results[]`.

## Evidence Rules

### Same-Document Chunks

- Include only nearby chunks belonging to the same matched document.
- Exclude every chunk already present in that group's `matched_chunks[]`.
- Deduplicate by `chunk_id`.
- Keep the existing bounded nearby-context policy.
- Preserve a reason such as `same_document_before` or `same_document_after`.

### Graph Paths

- Begin from concepts directly mentioned by the grouped document.
- Follow only one modeled relationship edge:
  - `DEPENDS_ON`
  - `RELATES_TO`
  - `IMPLEMENTS`
  - `REPLACES`
  - `DECIDES`
- Deduplicate within a group by `(from, relationship, to)`.
- Return at most `5` paths per group.

### Supporting Chunks

- Begin from the grouped document's direct concepts.
- Follow one modeled relationship edge to a related concept.
- Return chunks from other documents that mention that related concept.
- Exclude chunks from the source group document.
- Deduplicate within a group by `chunk_id`.
- Return at most `3` supporting chunks per group.
- Preserve the inclusion reason as `related_concept:<concept name>`.

Supporting chunks remain explanation and corroboration evidence only. They do not become primary results and do not affect primary ordering.

## Error Handling

The existing hard-dependency policy remains:

- Every document represented by a primary match must have a non-empty archived metadata summary.
- Every document represented by a primary match must have at least one direct graph concept.
- If either requirement is missing for any primary document, recall fails as a whole and returns no partial grouped response.

The following are valid empty optional evidence lists:

- `same_document_chunks` when no non-primary nearby chunks exist
- `graph_context.paths` when direct concepts have no modeled relationship
- `graph_context.supporting_chunks` when no related document evidence exists

If a batched enrichment query fails, recall returns a clear LadybugDB enrichment failure. It must not silently fall back to repeated per-result querying or return an incomplete group shape.

The known LadybugDB mmap/resource failure in real integration execution is not to be hidden with fallback behavior. The implementation plan must attempt to reproduce it through the grouped retrieval path and either resolve it or report it as a verified blocker with failure evidence.

## Skill Consumption

`skills/docnexus-recall/SKILL.md` should instruct the agent to:

- use `results[]` to understand primary chunk ranking and scores
- use `context_groups[]` as the source of complete document and graph evidence for composing the answer
- treat a group as one source document even when it contains multiple matched chunks
- cite `context_groups[].document.path`, using the group's highest matching chunk index and score when useful
- use typed paths only to explain one-hop relationships
- use supporting chunks only as supporting cross-document evidence
- report missing required Graph RAG context clearly when recall fails

## Implementation Boundaries

Keep the implementation focused on recall contract and LadybugDB retrieval:

- `src/ladybug-store.ts`: batch enrichment and provide grouped storage output or the data needed to build it.
- `src/recall.ts`: define and validate the new public recall JSON contract.
- `src/cli.ts`: continue printing recall output without CLI-specific reshaping.
- `skills/docnexus-recall/SKILL.md`: consume the new grouped contract.
- README and product brief documents: explain the breaking protocol and grouped evidence workflow.

MCP behavior and archive/index lifecycle behavior do not change.

## Testing Strategy

Write tests before implementation for:

- `results[]` contains `document_ref` and no longer contains `document_context` or `graph_context`.
- `context_groups[]` returns complete document and graph evidence.
- two primary hits from one file generate one group with two ordered `matched_chunks`.
- group order uses the highest matched chunk score and stable first-result tie breaking.
- `same_document_chunks` excludes chunks already present in `matched_chunks`.
- paths are deduplicated and capped at `5` per group.
- supporting chunks are deduplicated and capped at `3` per group.
- graph evidence does not reorder primary results.
- missing required metadata or direct concepts fails the whole recall response.
- an enrichment query failure does not return a partial grouped response.

Use unit-level contract tests for output mapping and validation. Add or extend real LadybugDB integration tests for:

- batch retrieval across multiple matched documents
- repeated primary matches from the same document
- evidence deduplication and caps
- connection/resource cleanup during grouped retrieval
- the previously observed mmap/resource failure path

## Success Criteria

This iteration is complete when:

- `docnexus recall` returns the new `results[]` plus `context_groups[]` contract.
- `results[]` preserves vector chunk ranking while referencing groups explicitly.
- every matched document has one complete, deduplicated context group.
- the enrichment path uses fixed query batches rather than per-primary-result graph queries.
- metadata and direct graph context remain hard dependencies.
- the recall skill and English/Chinese product documentation consume and describe the grouped contract.
- unit tests, real LadybugDB integration verification, type checking, and build pass.

If real LadybugDB integration exposes a reproducible runtime blocker, implementation is not complete; the blocker must be reported with evidence before further design or remediation is agreed.
