import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSION } from "../src/embedding-config.js";
import {
  deleteDocumentGraph,
  deleteLadybugConceptsByIds,
  deleteLadybugDocumentsByIds,
  ensureLadybugStore,
  checkLadybugVectorIndex,
  isLadybugAvailable,
  ladybugStorePath,
  listLadybugDocumentSummaries,
  listLadybugOrphanConcepts,
  queryLadybugRows,
  recallFromLadybug,
  rebuildLadybugVectorIndex,
  replaceDocumentGraph,
  type ReplaceDocumentGraphInput
} from "../src/ladybug-store.js";

const tempRoots: string[] = [];
const runIntegration = process.env.DOCNEXUS_LADYBUG_INTEGRATION === "1";

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-ladybug-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LadybugDB store", () => {
  it("reports runtime availability", async () => {
    await expect(isLadybugAvailable()).resolves.toEqual(expect.any(Boolean));
  });

  it("initializes schema and vector index idempotently", async () => {
    if (!runIntegration || !(await isLadybugAvailable())) {
      return;
    }

    const projectRoot = await makeRoot();
    await ensureLadybugStore(projectRoot);
    await ensureLadybugStore(projectRoot);

    await expect(stat(ladybugStorePath(projectRoot))).resolves.toBeDefined();
    await expect(queryLadybugRows(projectRoot, "MATCH (p:Project) RETURN count(p) AS count")).resolves.toEqual([
      expect.objectContaining({ count: expect.any(Number) })
    ]);
  });

  it("replaces and deletes a document graph", async () => {
    if (!runIntegration || !(await isLadybugAvailable())) {
      return;
    }

    const projectRoot = await makeRoot();
    await ensureLadybugStore(projectRoot);

    const embedding = Array.from({ length: EMBEDDING_DIMENSION }, (_, index) => (index === 0 ? 1 : 0));
    await replaceDocumentGraph(projectRoot, {
      project: { id: "project", name: "project", root_path: projectRoot },
      document: {
        id: "doc_1",
        title: "Auth Notes",
        path: "auth.md",
        summary: "Authentication architecture notes.",
        content_hash: "hash",
        updated_at: "2026-05-20T00:00:00.000Z"
      },
      chunks: [
        {
          id: "chunk_1",
          document_id: "doc_1",
          text: "JWT authentication middleware.",
          text_hash: "text_hash_1",
          chunk_index: 0,
          embedding
        }
      ],
      concepts: [{ id: "concept_auth", name: "Auth", type: "component", description: "Authentication." }],
      edges: []
    });

    await expect(queryLadybugRows(projectRoot, "MATCH (d:Document) RETURN d.id AS id")).resolves.toEqual([
      expect.objectContaining({ id: "doc_1" })
    ]);
    await expect(queryLadybugRows(projectRoot, "MATCH (c:Chunk) RETURN c.id AS id")).resolves.toEqual([
      expect.objectContaining({ id: "chunk_1" })
    ]);
    await expect(listLadybugDocumentSummaries(projectRoot)).resolves.toEqual([
      expect.objectContaining({ document_id: "doc_1", file_path: "auth.md", chunk_count: 1 })
    ]);
    await expect(checkLadybugVectorIndex(projectRoot)).resolves.toEqual({ ok: true });
    await expect(rebuildLadybugVectorIndex(projectRoot)).resolves.toBeUndefined();

    await deleteDocumentGraph(projectRoot, "doc_1");

    await expect(queryLadybugRows(projectRoot, "MATCH (d:Document) RETURN d.id AS id")).resolves.toEqual([]);
    await expect(queryLadybugRows(projectRoot, "MATCH (c:Chunk) RETURN c.id AS id")).resolves.toEqual([]);
  });

  it("lists and deletes graph maintenance documents and orphan concepts", async () => {
    if (!runIntegration || !(await isLadybugAvailable())) {
      return;
    }

    const projectRoot = await makeRoot();
    await ensureLadybugStore(projectRoot);
    const embedding = Array.from({ length: EMBEDDING_DIMENSION }, (_, index) => (index === 0 ? 1 : 0));
    await replaceDocumentGraph(projectRoot, {
      project: { id: "project", name: "project", root_path: projectRoot },
      document: {
        id: "doc_2",
        title: "Graph Notes",
        path: "graph.md",
        summary: "Graph maintenance notes.",
        content_hash: "hash",
        updated_at: "2026-05-20T00:00:00.000Z"
      },
      chunks: [
        {
          id: "chunk_2",
          document_id: "doc_2",
          text: "Graph maintenance chunk.",
          text_hash: "text_hash_2",
          chunk_index: 0,
          embedding
        }
      ],
      concepts: [],
      edges: []
    });
    await queryLadybugRows(
      projectRoot,
      "CREATE (:Concept {id: 'concept_orphan', name: 'Orphan', type: 'tool', description: 'Detached.'})"
    );

    await expect(listLadybugOrphanConcepts(projectRoot)).resolves.toEqual([
      { concept_id: "concept_orphan", name: "Orphan", type: "tool" }
    ]);

    await deleteLadybugConceptsByIds(projectRoot, ["concept_orphan"]);
    await deleteLadybugDocumentsByIds(projectRoot, ["doc_2"]);

    await expect(listLadybugOrphanConcepts(projectRoot)).resolves.toEqual([]);
    await expect(listLadybugDocumentSummaries(projectRoot)).resolves.toEqual([]);
  });

  it("returns one grouped context per document with one-hop evidence", async () => {
    if (!runIntegration || !(await isLadybugAvailable())) {
      return;
    }

    const projectRoot = await makeRoot();
    const embedding = Array.from({ length: EMBEDDING_DIMENSION }, (_, index) => (index === 0 ? 1 : 0));
    const lowerSimilarityEmbedding = Array.from({ length: EMBEDDING_DIMENSION }, (_, index) => (index === 1 ? 1 : 0));
    await replaceDocumentGraph(projectRoot, primaryGraph(projectRoot, embedding));
    await replaceDocumentGraph(projectRoot, supportingGraph(projectRoot, lowerSimilarityEmbedding));

    const output = await recallFromLadybug(projectRoot, embedding, 2);
    const primaryGroup = output.context_groups.find((group) => group.group_id === "doc_primary");

    expect(output.results.length).toBeGreaterThan(0);
    expect(output.results[0].document_ref.document_id).toBe("doc_primary");
    expect(primaryGroup?.graph_context.paths).toContainEqual({
      from: "Recall",
      relationship: "DEPENDS_ON",
      to: "LadybugDB"
    });
    expect(primaryGroup?.graph_context.supporting_chunks).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "ladybug.md" })])
    );
  });
});

function primaryGraph(projectRoot: string, embedding: number[]): ReplaceDocumentGraphInput {
  return {
    project: { id: "project", name: "project", root_path: projectRoot },
    document: {
      id: "doc_primary",
      title: "Recall",
      path: "recall.md",
      summary: "Recall uses LadybugDB as supporting graph evidence.",
      content_hash: "hash_primary",
      updated_at: "2026-05-23T00:00:00.000Z"
    },
    chunks: [
      {
        id: "chunk_primary",
        document_id: "doc_primary",
        text: "Recall depends on LadybugDB.",
        text_hash: "text_hash_primary",
        chunk_index: 0,
        embedding
      }
    ],
    concepts: [
      { id: "concept_recall", name: "Recall", type: "concept", description: "Recall workflow." },
      { id: "concept_ladybug", name: "LadybugDB", type: "tool", description: "Graph storage." }
    ],
    edges: [
      {
        from: "concept_recall",
        to: "concept_ladybug",
        label: "DEPENDS_ON",
        description: "Recall uses the graph store."
      }
    ]
  };
}

function supportingGraph(projectRoot: string, embedding: number[]): ReplaceDocumentGraphInput {
  return {
    project: { id: "project", name: "project", root_path: projectRoot },
    document: {
      id: "doc_supporting",
      title: "Ladybug Store",
      path: "ladybug.md",
      summary: "LadybugDB persists graph and vector evidence.",
      content_hash: "hash_supporting",
      updated_at: "2026-05-23T00:00:00.000Z"
    },
    chunks: [
      {
        id: "chunk_supporting",
        document_id: "doc_supporting",
        text: "LadybugDB persists graph context.",
        text_hash: "text_hash_supporting",
        chunk_index: 0,
        embedding
      }
    ],
    concepts: [{ id: "concept_ladybug", name: "LadybugDB", type: "tool", description: "Graph storage." }],
    edges: []
  };
}
