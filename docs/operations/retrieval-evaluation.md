# Retrieval regression evaluation

Run from the repository after installing dependencies:

```bash
npm run eval:retrieval
```

The command builds current code, creates an isolated temporary project, uses the bundled `BAAI/bge-small-zh-v1.5` q8 ONNX model, forbids network requests and prints per-query ranks plus aggregate metrics. It deletes its own temporary project on completion.

The fixed corpus in `test/fixtures/retrieval-eval.json` contains five documents, six answerable queries (identifier, entity alias, Chinese, English, semantic and relationship) and one no-answer query. `test/hybrid-recall.test.ts` also checks duplicate-document votes, keyword-only candidates outside the vector window, graph provenance and real offline retrieval.

Observed locally on 2026-10-14:

| Mode | First result correct | Relevant document in top 3 | MRR@3 |
| --- | --- | --- | --- |
| Vector | 5/6 | 6/6 | 0.889 |
| Hybrid | 6/6 | 6/6 | 1.000 |

`RefreshPolicy` illustrates the difference: the alias's document ranked third by vector similarity and first after fusion with the exact alias match. The no-answer query had zero lexical matches but both modes returned semantic neighbors.

These are small regression results, not a production benchmark or evidence of general superiority. They do not measure agent answer quality, historical reasoning, latency at scale or successful abstention. Scores do not determine whether an answer exists: the agent must read evidence and decline unsupported conclusions.

Default hybrid retrieval takes `min(100, max(20, limit * 5))` candidates per arm, collapses vector chunks to first-seen document ranks and sums `1 / (60 + rank)` per arm. Duplicate chunks never add votes. One representative chunk and one context group are returned per document; graph support does not contribute to ranking. `--mode vector` retains the original chunk-oriented behavior for comparison.

Expand the corpus with real project queries and adversarial aliases, outdated prose, conflicting sources and unsupported questions before changing model or fusion parameters. Track quality and latency separately; this fixture is too small to justify a performance claim.

## Long-document regression

```bash
npx vitest run test/long-document-recall.test.ts
```

This offline test indexes a long Chinese paragraph, a long code block and a long canonical fact. Their conclusions appear near the end, beyond the former single-paragraph input window. It verifies every indexed chunk fits the actual tokenizer budget, all vectors are finite, and the three ending conclusions appear among the first three **pure vector** results. No keyword fallback or network requests are allowed. Canonical documents and timelines must remain unchanged, and oversized direct embedding inputs and queries must fail explicitly.

Observed locally on 2026-10-14: all three ending-conclusion cases passed at top 3 using a 256-token chunk budget. A 512-token trial did not put the repeated-paragraph conclusion in the first three results: avoiding truncation alone does not eliminate semantic dilution. This small synthetic stress test supports the regression setting, not a claim that 256 tokens is globally optimal or that every ending conclusion ranks first. Expand with real long documents before further tuning.

Chunk tests additionally check strict lengths including special tokens and heading context, complete source-character coverage across overlaps, Unicode boundaries, code lines and fenced heading examples. Index tests verify missing/changed strategy signatures and changed model token limits trigger rebuilding, while canonical text/history stay intact. The installed tarball smoke checks actual tokenizer access and rejects inputs exceeding the model's capacity.

## Chinese lexical precision regression

```bash
npx vitest run test/search.test.ts test/hybrid-recall.test.ts
```

The previous word-segmentation path split `长文` into `长` and `文`. Any matching term admitted a document, and name/summary weights could place a generic document containing only `文` ahead of a full phrase in the body. Snippets selected the first weak matching line, which could hide the relevant evidence. These problems were in literal lookup; `search` does not load the embedding model.

Version 0.12.1 supplements segmentation with adjacent Han character pairs, suppresses isolated Han matches in multiword queries and ranks complete phrases, coverage and field weights in that order. Snippets use their strongest literal evidence and do not invent body line numbers for metadata-only matches. Multiword partial matches remain possible; this is lexical precision work, not synonym understanding, conflict detection or an automatic no-answer decision.

A same-source comparison on the six-document snapshot from the live project skills test, observed on 2026-10-15:

| Query | Before | After |
| --- | --- | --- |
| `长文` | Four candidates, including two matched only through `文` | Two candidates actually containing `长文` |
| `文档查询` | A generic architecture page preceded the reading guide | Query contract and reading guide rank first and second |
| `维护者授权` | Knowledge-evaluation page ranked before the release rule | Complete release-rule phrase ranks first |
| `远程 embedding` | Earlier `embedding` evidence could be selected | Snippet shows the complete phrase with its undecided proposal context |
| `page_size` | Query owner and referencing guide matched | Both remain, with current structured-fact evidence |

Canonical snapshot hashes were unchanged during the comparison. This is a targeted regression on a small corpus, not a general Chinese-language benchmark. Tests also cover phrase/coverage ordering, alias-only evidence, long-line excerpts, explicit single-character lookup, English identifiers and paths, normalization and inactive-fact exclusion. Hybrid regression checks that a generic `文` page receives no keyword vote for `长文`, while vector-only candidates remain possible.
