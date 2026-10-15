import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { initializeProject } from "../dist/src/project.js";
import { upsertManagedDocument } from "../dist/src/managed-documents.js";
import { recall } from "../dist/src/recall.js";
import { searchDocuments } from "../dist/src/search.js";
import { buildGroupedRecall } from "../dist/src/recall-groups.js";
import { assembleEvidence } from "../dist/src/evidence.js";
import { loadWorkspaceSnapshot } from "../dist/src/workspace-snapshot.js";
import { syncRetrievalIndex } from "../dist/src/retrieval-index.js";
import { RealEmbedder } from "../dist/src/embedder-real.js";
import { bundledEmbeddingModelsPath } from "../dist/src/embedding-models.js";
import { sha256 } from "../dist/src/hash.js";
import { scoreEvidence, scoreRetrieval, validateRetrievalCorpus } from "../dist/src/retrieval-evaluation.js";

const args = process.argv.slice(2);
const split = args.length === 0 ? "dev" : args.length === 2 && args[0] === "--split" ? args[1] : undefined;
if (!["dev", "holdout", "all"].includes(split)) throw new Error("Usage: eval-retrieval-quality.mjs [--split dev|holdout|all]");
const fixtureText = await readFile(new URL("../test/fixtures/retrieval-quality-eval.json", import.meta.url), "utf8");
const fixture = JSON.parse(fixtureText);
validateRetrievalCorpus(fixture);
const sources = new Map();
for (const document of fixture.documents) {
  if (!document.source_path || sources.has(document.source_path)) continue;
  sources.set(document.source_path, await readFile(new URL(`../${document.source_path}`, import.meta.url), "utf8"));
}
for (const document of fixture.documents) if (document.source_path) {
  assert(document.excerpts.every(excerpt => sources.get(document.source_path).includes(excerpt)), `Source drift: ${document.source_path}; reread and review labels before evaluating`);
}
delete process.env.DOCNEXUS_DATABASE_URL;
const root = await mkdtemp(join(tmpdir(), "docnexus-quality-eval-"));
const originalFetch = globalThis.fetch;
let networkAttempts = 0, embeddingCalls = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error("retrieval quality evaluation forbids network access"); };
const modes = ["keyword", "vector", "hybrid"];
const units = ["window", "section", "page"];
const budgets = [1200, 4000];
const real = new RealEmbedder({ localModelPath: bundledEmbeddingModelsPath() });
const embedder = { dimension: real.dimension, tokenBudget: () => real.tokenBudget(), embed: async text => { embeddingCalls++; return real.embed(text); } };
const rows = [];
try {
  await initializeProject(root);
  for (const document of fixture.documents) {
    await upsertManagedDocument(root, {
      file_path: document.path,
      source: document.source_path ? sources.get(document.source_path) : "Explicit evaluation-only simulation; not a real project decision.",
      document: document.body ?? `# ${document.title}\n\n${document.excerpts.join("\n\n")}`,
      metadata: { title: document.title, summary: document.title, tags: [], entities: document.entities ?? [], relationships: document.relationships ?? [], facts: document.facts }
    });
  }
  const initialStart = performance.now();
  const initialSync = await syncRetrievalIndex(root, {}, embedder);
  const initial = { duration_ms: performance.now() - initialStart, embedding_calls: embeddingCalls, ...initialSync };
  const snapshot = await loadWorkspaceSnapshot(root);
  const questions = fixture.questions.filter(question => split === "all" || question.split === split);
  for (const question of questions) {
    const row = { id: question.id, split: question.split, origin: question.origin, kind: question.kind, query: question.query,
      expected_paths: question.expected_paths, modes: {} };
    for (const mode of modes) {
      const start = performance.now(), calls = embeddingCalls;
      let grouped, paths;
      if (mode === "keyword") {
        const found = await searchDocuments(root, { query: question.query, limit: 3 });
        paths = found.results.map(result => result.file_path);
        grouped = buildGroupedRecall(found.results.map(result => ({
          document: { document_id: result.id, path: result.file_path, title: result.title, summary: result.summary },
          matched_chunk: { chunk_id: `keyword:${result.id}`, chunk_index: 0, text: result.snippet, score: result.score, source_anchor: result.source_anchor }, match_source: "keyword",
          concepts: [], related_concepts: [], same_document_chunks: []
        })), [], []);
      } else {
        grouped = await recall(root, { query: question.query, limit: 3, mode }, embedder);
        assert.equal(grouped.snapshot_revision, snapshot.revision, "evaluation snapshot changed");
        paths = [...new Set(grouped.results.map(result => result.document_ref.path))];
      }
      const measured = { paths, retrieval_ms: performance.now() - start, embedding_calls: embeddingCalls - calls,
        retrieval: scoreRetrieval(paths, question.expected_paths), deliveries: [] };
      // Reuse exactly these candidates for every unit/budget: no second retrieval.
      for (const unit of units) for (const budget of budgets) {
        const assemblyStart = performance.now();
        try {
          const packet = assembleEvidence(snapshot, question.query, grouped, { return_unit: unit, context_budget: budget });
          measured.deliveries.push({ unit, budget, assembly_ms: performance.now() - assemblyStart, ...scoreEvidence(snapshot, packet, question) });
        } catch (error) {
          measured.deliveries.push({ unit, budget, assembly_ms: performance.now() - assemblyStart, coverage: question.evidence.length ? 0 : null,
            error: { code: error.code ?? "internal_error", message: error.message } });
        }
      }
      row.modes[mode] = measured;
    }
    rows.push(row);
    process.stderr.write(`quality evaluation: ${rows.length}/${questions.length} ${question.id}\n`);
  }
  const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const summary = {};
  for (const selectedSplit of ["dev", "holdout"].filter(value => split === "all" || value === split)) {
    summary[selectedSplit] = {};
    for (const origin of ["repository", "simulated"]) {
      const selected = rows.filter(row => row.split === selectedSplit && row.origin === origin);
      summary[selectedSplit][origin] = {};
      for (const mode of modes) {
        const answerable = selected.filter(row => row.expected_paths.length);
        const unsupported = selected.filter(row => !row.expected_paths.length);
        const times = selected.map(row => row.modes[mode].retrieval_ms).sort((a, b) => a - b);
        summary[selectedSplit][origin][mode] = {
          answerable: answerable.length, no_answer: unsupported.length,
          ...Object.fromEntries(["hit_at_1", "hit_at_3", "document_recall_at_3", "all_documents_at_3", "mrr_at_3"].map(key => [key, average(answerable.map(row => row.modes[mode].retrieval[key]))])),
          no_answer_with_candidates: unsupported.filter(row => row.modes[mode].paths.length).length,
          embedding_calls: selected.reduce((sum, row) => sum + row.modes[mode].embedding_calls, 0),
          retrieval_ms: { samples: times.length, p50: times[Math.ceil(times.length * 0.5) - 1] ?? null, p95: times[Math.ceil(times.length * 0.95) - 1] ?? null },
          evidence: units.flatMap(unit => budgets.map(budget => {
            const deliveries = selected.map(row => row.modes[mode].deliveries.find(delivery => delivery.unit === unit && delivery.budget === budget));
            const coverage = deliveries.filter(delivery => delivery.coverage !== null).map(delivery => delivery.coverage);
            return { unit, budget, samples: coverage.length, mean_coverage: average(coverage), complete: coverage.filter(value => value === 1).length,
              errors: deliveries.filter(delivery => delivery.error).length };
          }))
        };
      }
    }
  }
  const deliveries = rows.flatMap(row => modes.flatMap(mode => row.modes[mode].deliveries));
  const invariants = {
    citation_errors: deliveries.reduce((sum, delivery) => sum + (delivery.citation_errors ?? 0), 0),
    fact_errors: deliveries.reduce((sum, delivery) => sum + (delivery.fact_errors ?? 0), 0),
    budget_violations: deliveries.filter(delivery => delivery.budget_ok === false).length,
    unexpected_errors: deliveries.filter(delivery => delivery.error && delivery.error.code !== "invalid_params").length,
    network_attempts: networkAttempts
  };
  console.log(JSON.stringify({ schema_version: 1, generated_at: new Date().toISOString(), suite: "repository-authored-retrieval-quality", split,
    fixture_sha256: sha256(fixtureText), sources: [...sources].map(([path, text]) => ({ path, sha256: sha256(text) })),
    model: real.model, documents: fixture.documents.length, questions: rows.length, initial_sync: initial, summary, invariants, rows,
    not_measured: ["semantic answer quality", "host-agent citation correctness", "abstention accuracy", "proactive reads", "host-model calls", "native host activation"],
    limits: [
      "Authored questions over anchored repository excerpts, not observed user traffic or a blind held-out experiment. Simulated scenarios are reported separately.",
      "Default evaluates dev only. Target document families remain disjoint across split labels and share the retrieval corpus; known regression cases must be separated from new unseen validation questions.",
      "Original holdout failures have been inspected during architecture diagnosis. This fixture is a known regression set; new unseen questions are required for independent generalization claims.",
      "Vector uses the public top-3 chunk mode and may return fewer than three distinct documents; keyword and hybrid return up to three documents. This is a product-path baseline, not a controlled ranking ablation.",
      "Keyword evidence carries the public literal snippet and its structured source anchor, without graph or neighbor expansion. Each mode reuses fixed candidates across all delivery units and budgets.",
      "Coverage requires exact labeled text or fact/status in a valid cited block. It is evidence retention, not a judgment that the model answered correctly or abstained.",
      "Latency is one sample per question in fixed keyword/vector/hybrid order after initial indexing with a reused model, not cold CLI or a scale benchmark."
    ] }, null, 2));
  if (Object.values(invariants).some(value => value > 0)) process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
