import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeProject } from "../dist/src/project.js";
import { upsertManagedDocument } from "../dist/src/managed-documents.js";
import { recall } from "../dist/src/recall.js";
import { searchDocuments } from "../dist/src/search.js";
import { RealEmbedder } from "../dist/src/embedder-real.js";
import { bundledEmbeddingModelsPath } from "../dist/src/embedding-models.js";

const fixture = JSON.parse(await readFile(new URL("../test/fixtures/retrieval-eval.json", import.meta.url), "utf8"));
delete process.env.DOCNEXUS_DATABASE_URL; // This evaluation owns only its temporary local projection.
const root = await mkdtemp(join(tmpdir(), "docnexus-retrieval-eval-"));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("retrieval evaluation forbids network access"); };
try {
  await initializeProject(root);
  for (const document of fixture.documents) {
    await upsertManagedDocument(root, {
      file_path: document.path, source: "Evaluation fixture", document: document.body,
      metadata: { title: document.title, summary: document.summary, tags: [], entities: document.entities, relationships: document.relationships }
    });
  }
  const embedder = new RealEmbedder({ localModelPath: bundledEmbeddingModelsPath() });
  const rows = [];
  for (const query of fixture.queries) {
    const row = { kind: query.kind, query: query.query, expected: query.expected };
    for (const mode of ["vector", "hybrid"]) {
      const output = await recall(root, { query: query.query, limit: 3, mode }, embedder);
      const paths = [...new Set(output.results.map((result) => result.document_ref.path))];
      row[mode] = { paths, rank: query.expected ? paths.indexOf(query.expected) + 1 : null };
    }
    if (!query.expected) row.keyword_hits = (await searchDocuments(root, { query: query.query })).results.length;
    rows.push(row);
  }
  const answerable = rows.filter((row) => row.expected);
  const metrics = {};
  for (const mode of ["vector", "hybrid"]) {
    metrics[mode] = {
      recall_at_1: answerable.filter((row) => row[mode].rank === 1).length / answerable.length,
      recall_at_3: answerable.filter((row) => row[mode].rank > 0).length / answerable.length,
      mrr_at_3: answerable.reduce((sum, row) => sum + (row[mode].rank > 0 ? 1 / row[mode].rank : 0), 0) / answerable.length
    };
  }
  console.log(JSON.stringify({
    model: embedder.model,
    documents: fixture.documents.length,
    answerable_queries: answerable.length,
    metrics, rows,
    limits: "Small fixed regression corpus; not a production benchmark. No-answer nearest neighbors require agent abstention; scores are not truth confidence."
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
