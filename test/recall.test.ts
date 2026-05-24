import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalHashEmbedder } from "../src/embedder.js";
import { type GroupedRecallData, type RecallContextGroup } from "../src/recall-groups.js";
import { recall, type RecallReader } from "../src/recall.js";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-recall-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("recall", () => {
  it("returns ranked results linked to complete document context groups", async () => {
    const projectRoot = await makeRoot();
    const output = await recall(projectRoot, { query: "JWT authentication", limit: 1 }, new LocalHashEmbedder(), {
      recallFromLadybug: async () => groupedData("auth", 0.9)
    });

    expect(output.query).toBe("JWT authentication");
    expect(output.results[0]).toMatchObject({
      matched_chunk: { chunk_id: "chunk_auth", text: expect.stringContaining("auth"), score: 0.9 },
      document_ref: { group_id: "doc_auth", document_id: "doc_auth", path: "auth.md" },
      ranking: { primary: "chunk_similarity", graph_used_as: "grouped_supporting_context" }
    });
    expect(output.results[0]).not.toHaveProperty("document_context");
    expect(output.results[0]).not.toHaveProperty("graph_context");
    expect(output.context_groups[0]).toMatchObject({
      group_id: "doc_auth",
      document: { document_id: "doc_auth", path: "auth.md", summary: expect.stringContaining("auth") },
      graph_context: { concepts: ["auth"] }
    });
  });

  it("returns an empty grouped response when no indexed content is recalled", async () => {
    const projectRoot = await makeRoot();

    await expect(recall(projectRoot, { query: "nothing" }, new LocalHashEmbedder(), emptyRecallReader())).resolves.toEqual({
      query: "nothing",
      results: [],
      context_groups: []
    });
  });

  it("validates query and limit", async () => {
    const projectRoot = await makeRoot();

    await expect(recall(projectRoot, { query: "" })).rejects.toThrow("query must be a non-empty string");
    await expect(recall(projectRoot, { query: "x", limit: 0 })).rejects.toThrow("limit must be a positive integer");
  });

  it("preserves populated same-document and one-hop supporting context in its group", async () => {
    const projectRoot = await makeRoot();
    const data = groupedData("primary", 0.94);
    data.context_groups[0].same_document_chunks = [
      {
        chunk_id: "chunk_nearby",
        chunk_index: 0,
        text: "Vector retrieval selects the primary chunk.",
        reason: "same_document_before"
      }
    ];
    data.context_groups[0].graph_context.paths = [
      { from: "Recall", relationship: "DEPENDS_ON", to: "LadybugDB" }
    ];
    data.context_groups[0].graph_context.supporting_chunks = [
      {
        document_id: "doc_graph",
        path: "ladybug.md",
        title: "LadybugDB",
        chunk_id: "chunk_support",
        chunk_index: 0,
        text: "LadybugDB stores graph context.",
        reason: "related_concept:LadybugDB"
      }
    ];

    const output = await recall(projectRoot, { query: "graph retrieval", limit: 1 }, new LocalHashEmbedder(), {
      recallFromLadybug: async () => data
    });

    expect(output.context_groups[0].same_document_chunks).toHaveLength(1);
    expect(output.context_groups[0].graph_context.paths).toEqual([
      { from: "Recall", relationship: "DEPENDS_ON", to: "LadybugDB" }
    ]);
    expect(output.context_groups[0].graph_context.supporting_chunks[0]).toMatchObject({
      path: "ladybug.md",
      reason: "related_concept:LadybugDB"
    });
  });

  it("does not promote grouped supporting context over matched chunk ranking", async () => {
    const projectRoot = await makeRoot();
    const high = groupedData("high", 0.92);
    const low = groupedData("low", 0.61);
    low.context_groups[0].graph_context.supporting_chunks = [
      {
        document_id: "doc_support",
        path: "support.md",
        title: "Support",
        chunk_id: "chunk_support",
        chunk_index: 0,
        text: "Support",
        reason: "related_concept:Support"
      }
    ];
    const output = await recall(projectRoot, { query: "ranking", limit: 2 }, new LocalHashEmbedder(), {
      recallFromLadybug: async () => ({
        results: [...high.results, ...low.results],
        context_groups: [...high.context_groups, ...low.context_groups]
      })
    });

    expect(output.results.map((result) => result.matched_chunk.chunk_id)).toEqual(["chunk_high", "chunk_low"]);
  });

  it("fails when required document metadata is missing", async () => {
    const projectRoot = await makeRoot();
    const data = groupedData("auth", 0.9);
    data.context_groups[0].document.summary = "";

    await expect(
      recall(projectRoot, { query: "JWT authentication", limit: 1 }, new LocalHashEmbedder(), {
        recallFromLadybug: async () => data
      })
    ).rejects.toThrow("recall requires document metadata");
  });

  it("fails when required graph context is missing", async () => {
    const projectRoot = await makeRoot();
    const data = groupedData("auth", 0.9);
    data.context_groups[0].graph_context.concepts = [];

    await expect(
      recall(projectRoot, { query: "JWT authentication", limit: 1 }, new LocalHashEmbedder(), {
        recallFromLadybug: async () => data
      })
    ).rejects.toThrow("recall requires graph context");
  });
});

function emptyRecallReader(): RecallReader {
  return {
    recallFromLadybug: async () => ({ results: [], context_groups: [] })
  };
}

function groupedData(id: string, score: number): GroupedRecallData {
  const group: RecallContextGroup = {
    group_id: `doc_${id}`,
    document: {
      document_id: `doc_${id}`,
      path: `${id}.md`,
      title: id,
      summary: `${id} summary`
    },
    matched_chunks: [{ chunk_id: `chunk_${id}`, chunk_index: 0, text: `${id} evidence`, score }],
    same_document_chunks: [],
    graph_context: {
      concepts: [id],
      related_concepts: [],
      supporting_chunks: [],
      paths: []
    },
    ranking: {
      primary_score: score,
      primary: "highest_matched_chunk_score"
    }
  };
  return {
    results: [
      {
        matched_chunk: group.matched_chunks[0],
        document_ref: { group_id: group.group_id, document_id: group.group_id, path: group.document.path },
        ranking: { primary: "chunk_similarity", graph_used_as: "grouped_supporting_context" }
      }
    ],
    context_groups: [group]
  };
}
