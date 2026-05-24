import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalHashEmbedder } from "../src/embedder.js";
import { auditGraph, repairGraph, type GraphMaintenanceStore } from "../src/graph-maintenance.js";
import { upsertManagedDocument, type ManagedGraphWriter } from "../src/managed-documents.js";
import { initializeProject } from "../src/project.js";

const roots: string[] = [];
const noopGraphWriter: ManagedGraphWriter = {
  replaceDocumentGraph: async () => {},
  deleteDocumentGraph: async () => {}
};
const metadata = {
  title: "Graph",
  summary: "Current graph maintenance document.",
  tags: ["graph"],
  entities: [],
  relationships: []
};

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-graph-maintenance-"));
  roots.push(root);
  await initializeProject(root);
  return root;
}

async function addDocument(root: string, path: string) {
  return upsertManagedDocument(
    root,
    { file_path: path, source: "source", document: `# ${path}\n\nCurrent text.`, metadata },
    new LocalHashEmbedder(8),
    noopGraphWriter
  );
}

function makeStore(overrides: Partial<GraphMaintenanceStore> = {}): GraphMaintenanceStore {
  return {
    listDocumentSummaries: async () => [],
    listOrphanConcepts: async () => [],
    checkVectorIndex: async () => ({ ok: true }),
    deleteDocumentsByIds: async () => {},
    deleteConceptsByIds: async () => {},
    rebuildVectorIndex: async () => {},
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("graph maintenance", () => {
  it("reports a clean current document graph state", async () => {
    const root = await makeRoot();
    const document = await addDocument(root, "clean.md");
    const store = makeStore({
      listDocumentSummaries: async () => [{ document_id: document.id, file_path: "clean.md", chunk_count: 1 }]
    });

    await expect(auditGraph(root, store)).resolves.toMatchObject({
      result: "clean",
      summary: { documents: 1, missing_documents: 0, stale_documents: 0, chunk_count_mismatches: 0 },
      issues: { missing_documents: [], stale_documents: [], chunk_count_mismatches: [] }
    });
  });

  it("reports missing, stale, chunk-count, orphan-concept, and vector-index issues only", async () => {
    const root = await makeRoot();
    const missing = await addDocument(root, "missing.md");
    const mismatch = await addDocument(root, "mismatch.md");
    const audit = await auditGraph(root, makeStore({
      listDocumentSummaries: async () => [
        { document_id: mismatch.id, file_path: "mismatch.md", chunk_count: 0 },
        { document_id: "doc_stale", file_path: "stale.md", chunk_count: 2 }
      ],
      listOrphanConcepts: async () => [{ concept_id: "concept_orphan", name: "Orphan", type: "tool" }],
      checkVectorIndex: async () => ({ ok: false, message: "vector unavailable" })
    }));

    expect(audit.summary).not.toHaveProperty("deleted_documents");
    expect(audit.issues).not.toHaveProperty("deleted_documents");
    expect(audit.summary).toMatchObject({ documents: 2, missing_documents: 1, stale_documents: 1, chunk_count_mismatches: 1 });
    expect(audit.issues.missing_documents).toEqual([{ document_id: missing.id, file_path: "missing.md" }]);
    expect(audit.issues.stale_documents).toEqual([{ document_id: "doc_stale", file_path: "stale.md" }]);
  });

  it("requires force for graph repair", async () => {
    const root = await makeRoot();
    await expect(repairGraph(root, { force: false })).rejects.toThrow("graph repair requires --force");
  });

  it("deletes only stale graph documents and orphan concepts during repair", async () => {
    const root = await makeRoot();
    const missing = await addDocument(root, "missing.md");
    const mismatch = await addDocument(root, "mismatch.md");
    const deletedDocuments: string[][] = [];
    const before = makeStore({
      listDocumentSummaries: async () => [
        { document_id: mismatch.id, file_path: "mismatch.md", chunk_count: 0 },
        { document_id: "doc_stale", file_path: "stale.md", chunk_count: 2 }
      ],
      listOrphanConcepts: async () => [{ concept_id: "concept_orphan", name: "Orphan", type: "tool" }],
      deleteDocumentsByIds: async (_root, ids) => {
        deletedDocuments.push(ids);
      }
    });
    const after = makeStore({
      listDocumentSummaries: async () => [{ document_id: mismatch.id, file_path: "mismatch.md", chunk_count: 0 }]
    });
    let call = 0;

    const result = await repairGraph(root, { force: true }, () => (++call === 1 ? before : after));

    expect(deletedDocuments).toEqual([["doc_stale"]]);
    expect(result.actions).toMatchObject({ deleted_stale_documents: 1, deleted_orphan_concepts: 1, rebuilt_vector_index: true });
    expect(result.actions).not.toHaveProperty("deleted_deleted_documents");
    expect(result.after).toMatchObject({ total_issues: 2, remaining_issue_types: ["missing_documents", "chunk_count_mismatches"] });
    expect(missing.id).toMatch(/^doc_[0-9a-f]{16}$/);
  });
});
