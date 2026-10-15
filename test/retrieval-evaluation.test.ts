import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initializeProject } from "../src/project.js";
import { upsertManagedDocument } from "../src/managed-documents.js";
import { loadWorkspaceSnapshot } from "../src/workspace-snapshot.js";
import { assembleEvidence } from "../src/evidence.js";
import { buildGroupedRecall } from "../src/recall-groups.js";
import { scoreEvidence, scoreRetrieval, validateRetrievalCorpus, type RetrievalCorpus, type RetrievalQuestion } from "../src/retrieval-evaluation.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const corpus = JSON.parse(await readFile(new URL("./fixtures/retrieval-quality-eval.json", import.meta.url), "utf8")) as RetrievalCorpus;

it("freezes at least 30 source-anchored project questions with disjoint development and holdout target families", async () => {
  validateRetrievalCorpus(corpus);
  expect(corpus.questions.filter(question => question.origin === "repository" && question.expected_paths.length).length).toBeGreaterThanOrEqual(30);
  expect(new Set(corpus.questions.map(question => question.split))).toEqual(new Set(["dev", "holdout"]));
  expect(corpus.questions.some(question => question.kind === "conflict" && question.expected_paths.length === 2)).toBe(true);
  expect(corpus.questions.filter(question => !question.expected_paths.length).length).toBeGreaterThanOrEqual(4);
  for (const document of corpus.documents) if (document.source_path) {
    const source = await readFile(new URL(`../${document.source_path}`, import.meta.url), "utf8");
    for (const excerpt of document.excerpts!) expect(source, `Source drift: ${document.source_path}`).toContain(excerpt);
  }
});

it("rejects leaked splits, absent answer spans, duplicate ids and unsupported labels without rationale", () => {
  const leaked = structuredClone(corpus); leaked.questions[0].split = "holdout";
  expect(() => validateRetrievalCorpus(leaked)).toThrow("split leakage");
  const absent = structuredClone(corpus); absent.questions[0].evidence[0].text = "INVENTED_ANSWER";
  expect(() => validateRetrievalCorpus(absent)).toThrow("absent from canonical target");
  const duplicate = structuredClone(corpus); duplicate.questions.push(duplicate.questions[0]);
  expect(() => validateRetrievalCorpus(duplicate)).toThrow("duplicate question");
  const unsupported = structuredClone(corpus); delete unsupported.questions.find(question => !question.expected_paths.length)!.rationale;
  expect(() => validateRetrievalCorpus(unsupported)).toThrow("unsupported question");
});

it("deduplicates ranks, measures all required documents, and never counts neighbors as successful abstention", () => {
  expect(scoreRetrieval(["noise", "noise", "answer"], ["answer", "other"])).toMatchObject({ rank: 2, hit_at_1: 0, hit_at_3: 1, document_recall_at_3: 0.5, all_documents_at_3: 0, mrr_at_3: 0.5 });
  expect(scoreRetrieval(["noise"], ["answer"])).toMatchObject({ rank: null, hit_at_3: 0, mrr_at_3: 0 });
  expect(scoreRetrieval(["neighbor"], [])).toMatchObject({ answerable: false, candidate_documents: 1, hit_at_1: null, hit_at_3: null, mrr_at_3: null });
});

it("requires the actual cited source, current fact state and complete response budget for coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "docnexus-quality-metrics-")); roots.push(root);
  await initializeProject(root);
  const text = "CURRENT_ASSERTION";
  const metadata = { title: "Policy", summary: "Policy", tags: [], entities: [], relationships: [] };
  const owner = await upsertManagedDocument(root, { file_path: "owner.md", source: "Decision", document: "{{fact:fact_quality_unit}}", metadata: { ...metadata,
    facts: [{ id: "fact_quality_unit", text, provenance: "Owner decision", valid_from: "2000-01-01T00:00:00Z" }] } });
  await upsertManagedDocument(root, { file_path: "other.md", source: "Context", document: text, metadata });
  const snapshot = await loadWorkspaceSnapshot(root);
  const grouped = buildGroupedRecall([{ document: { document_id: owner.id, path: "owner.md", title: "Policy", summary: "Policy" },
    matched_chunk: { chunk_id: "unit", chunk_index: 0, text: `[fact_quality_unit] ${text}`, score: 1 }, concepts: [], related_concepts: [], same_document_chunks: [] }], [], []);
  const question: RetrievalQuestion = { id: "unit", split: "dev", origin: "simulated", kind: "fact", query: text, expected_paths: ["owner.md"],
    evidence: [{ path: "owner.md", text, fact_id: "fact_quality_unit", status: "active" }] };
  const packet = assembleEvidence(snapshot, text, grouped);
  expect(scoreEvidence(snapshot, packet, question)).toMatchObject({ coverage: 1, citation_errors: 0, fact_errors: 0, budget_ok: true });
  const wrongSource = structuredClone(question); wrongSource.evidence[0].path = "other.md";
  expect(scoreEvidence(snapshot, packet, wrongSource).coverage).toBe(0);
  const stale = structuredClone(packet); stale.evidence[0].record_version = "0".repeat(64);
  expect(scoreEvidence(snapshot, stale, question)).toMatchObject({ coverage: 0, citation_errors: 1 });
  const falseState = structuredClone(packet); falseState.evidence[0].fact!.status = "expired";
  expect(scoreEvidence(snapshot, falseState, question)).toMatchObject({ coverage: 0, fact_errors: 1 });
  const falseEstimate = structuredClone(packet); falseEstimate.delivery.estimated_tokens--;
  expect(scoreEvidence(snapshot, falseEstimate, question).budget_ok).toBe(false);
});
