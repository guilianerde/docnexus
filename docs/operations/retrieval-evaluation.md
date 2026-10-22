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

## Source-based quality baseline

The original five-document smoke corpus remains unchanged. The separate quality suite evaluates 15 documents: ten curated extracts anchored in four repository source files, and five explicitly simulated documents. Its 44 authored questions comprise 30 source-supported project questions, six unsupported questions, and eight simulation cases covering aliases, long-document endings, replacement, expiry, withdrawal, future facts, cross-document references and an unapproved proposal conflicting with a confirmed decision.

```bash
npm run eval:retrieval:quality                         # development split only
npm run eval:retrieval:quality -- --split holdout      # explicit held-out comparison
npm run eval:retrieval:quality -- --split all          # initial full baseline
```

The labels live in `test/fixtures/retrieval-quality-eval.json`. Development has 30 questions (21 source-supported, three unsupported, six simulated); holdout has 14 (nine source-supported, three unsupported, two simulated). All questions targeting a document family belong to one split. Both splits search the same full corpus, including distractors. CI runs development only on Node.js 24; it gates source drift, citation/fact consistency, response budgets and unexpected errors, not a retrospectively selected quality threshold. Keep retrieval defaults frozen while establishing the baseline, and evaluate proposed changes on development before an explicit holdout comparison.

These are repository-authored questions over selected source excerpts, not observed user traffic, an independent human annotation study or a blind holdout. Answer spans must exist in their target source or simulated fact registry before evaluation. Changed source excerpts fail validation and require rereading and reviewing the labels; the runner does not silently rewrite them. The report records fixture/source hashes, model identity, initial indexing cost and per-question results. Simulated results and source-supported results are reported separately.

The runner compares these existing product paths:

- **Keyword:** top three literal document results. Evidence starts from the returned snippet, with no vector, graph or neighbor expansion.
- **Vector:** public `recall --mode vector --limit 3`, which ranks chunks and can return fewer than three unique documents.
- **Hybrid:** public default recall, returning up to three unique documents.

This measures product behavior; the differing candidate units and expansion policies make it unsuitable as an isolated ranking-algorithm ablation. Each mode retrieves once per question, then reuses those exact candidates for `window`, `section` and `page` under 1200 and 4000 complete-response byte budgets. Evidence assembly never reruns retrieval to make one delivery strategy look better.

Metrics distinguish the following:

| Measurement | Meaning |
| --- | --- |
| `hit_at_1`, `hit_at_3`, `mrr_at_3` | Position of the first labeled relevant document; duplicate chunks do not improve document rank |
| `document_recall_at_3`, `all_documents_at_3` | Fraction/all of the required documents retrieved, including multi-document conflict questions |
| `mean_coverage`, `complete`, `missing` | Exact labeled answer spans or fact/status units retained with their correct source; partial or misplaced evidence does not count |
| `citation_errors`, `fact_errors`, `budget_violations` | Mechanical source-version and fact-lifecycle consistency, and the actual complete JSON byte budget |
| `no_answer_with_candidates` | Unsupported questions that still return neighbors; this is **not** successful or failed agent abstention |
| `embedding_calls`, `retrieval_ms`, `assembly_ms` | Observed calls and timing, with initial indexing recorded separately |

Latency is one sample per question in fixed keyword/vector/hybrid order, after indexing with a reused local model. Its p50/p95 describe this small workload, not cold CLI performance or a scale benchmark. Exact evidence coverage is also stricter than semantic sufficiency and does not measure a host model's final answer, citation selection, proactive reading or refusal. Those remain explicitly unmeasured and need the separate [agent evaluation](agent-evaluation.zh-CN.md).

The first full report is [retrieval-quality-2026-10-15.json](baselines/retrieval-quality-2026-10-15.json). Failed retrievals and omitted answer evidence remain in its per-question rows; the baseline does not assert that the hybrid strategy always wins.

That report preserves the source hashes at the time of measurement. Later documentation edits do not rewrite the historical results; a new comparison must record its own fixture/source hashes and outcomes.

Observed on 2026-10-15, **source-supported questions only**, excluding simulations and unsupported questions:

| Split | Mode | Top 1 | Top 3 | MRR@3 | Complete section evidence, budget 4000 |
| --- | --- | --- | --- | --- | --- |
| Development | Keyword | 17/21 | 20/21 | 0.873 | 18/21 |
| Development | Vector | 13/21 | 18/21 | 0.730 | 18/21 |
| Development | Hybrid | 18/21 | 18/21 | 0.857 | 18/21 |
| Holdout | Keyword | 8/9 | 9/9 | 0.944 | 8/9 |
| Holdout | Vector | 6/9 | 7/9 | 0.722 | 7/9 |
| Holdout | Hybrid | 7/9 | 9/9 | 0.870 | 8/9 |

All 792 delivery comparisons had zero mechanical citation, fact-state or budget violations; there were no network attempts or unexpected errors. This does not mean all questions retained their answers. For example:

- `concurrency-locks-3`: the hybrid top three contain the correct lock document, but section evidence at budget 4000 omits its answer after earlier context consumes the budget.
- `retrieval-fusion-3`: the English question about whether similarity proves answer existence misses the labeled source in all three retrieval modes.
- `sim-long-ending`: the longer query combining `QUEUE_RECOVERY_ORDER` with Chinese wording misses the long document in all three modes.
- `sim-withdrawn`: hybrid retrieves the fact registry but omits the requested withdrawal state under section budget 4000.

Keep these failures as development/review inputs. Evidence coverage, retrieval rank and host-agent answer quality are separate outcomes; neither the passing consistency checks nor the holdout's small sample justify a general quality claim.

### Architecture comparison — 2026-10-15

The [architecture report](baselines/retrieval-quality-architecture-2026-10-15.json) uses the same 44 questions, model and retrieval parameters after projection versioning, structured source anchors and budget planning. The original report remains unchanged. Keyword delivery now passes the public search anchor alongside its snippet; the old adapter used snippet-only text lookup. Differences therefore describe the integrated pipeline, not a budget-only ablation. Some original holdout failures were inspected during diagnosis, so this is a known regression comparison; independent generalization claims require new unseen questions.

All 792 deliveries again had zero mechanical citation/fact errors, budget violations or unexpected errors, with no network attempts. Complete labeled evidence under section/4000, repository-supported questions only:

| Split | Mode | Original | Architecture update |
| --- | --- | --- | --- |
| Development | Keyword | 18/21 | 17/21 |
| Development | Vector | 18/21 | 18/21 |
| Development | Hybrid | 18/21 | 18/21 |
| Original holdout | Keyword | 8/9 | 9/9 |
| Original holdout | Vector | 7/9 | 7/9 |
| Original holdout | Hybrid | 8/9 | 9/9 |

`concurrency-locks-3` now retains the answer with hybrid delivery; `sim-withdrawn` retains its atomic withdrawal state. The keyword-only development cases `documents-pagination-3` and `operations-release-3` lose their labeled span at this budget, while other coverage changes offset one of those losses. Their document retrieval succeeds, but compact-hit reservation and precise field anchors give different context than the earlier page fallback. These failures remain recorded rather than being removed from the corpus. `sim-long-ending` and hybrid `sim-cross-document` still miss relevant documents; this change does not repair query analysis or ranking. Complete labeled evidence is not full-document delivery or model answer accuracy.

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

## English query terms and exact-name lookup

Current keyword ranking adds an exact normalized title/path/filename tier before complete phrases, coverage and field weights. Paths and filenames may omit .md; matching names are delivered as metadata anchors. Multiword queries omit standalone English filler words from lexical terms, preserving original phrases, literal path/identifier components, negation, single-word queries and all-filler lookups. Vector embedding still receives the original query, and document-level RRF is unchanged.

Targeted regressions reproduce filler-only documents outranking refresh-token knowledge and substring matches outranking an exact filename/title before the change. They also cover punctuation, Unicode normalization, paths with spaces, code identifiers inside questions, negation, original-phrase ranking and metadata evidence. The existing Chinese, source-anchor and offline bilingual hybrid regressions remain applicable. These are controlled regression cases, not proof of general English retrieval superiority or a new latency benchmark.

Observed on 2026-10-22: comparing the previous and updated keyword rankers on the same text snapshot for 30 known development queries (27 answerable) retained Hit@1 at 22/27, Hit@3 at 25/27 and MRR@3 at 0.8642, with no answer-rank regressions. Three candidate lists changed; the publishing-authorization query dropped an irrelevant candidate. Existing misses and candidates for no-answer questions remain. The complete development evaluation of keyword/vector/hybrid delivery reported zero citation errors, fact errors, budget violations, unexpected errors and network attempts. These existing questions are regression coverage, not independent generalization evidence.
