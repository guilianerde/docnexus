import { describe, expect, it } from "vitest";
import { buildGroupedRecall, type RecallPrimaryMatch } from "../src/recall-groups.js";

const primary: RecallPrimaryMatch[] = [
  {
    matched_chunk: { chunk_id: "a2", chunk_index: 2, text: "A second", score: 0.95 },
    document: { document_id: "doc_a", path: "a.md", title: "A", summary: "Summary A." },
    concepts: ["Recall"],
    related_concepts: ["LadybugDB"],
    same_document_chunks: [{ chunk_id: "a1", chunk_index: 1, text: "Already primary", reason: "same_document_before" }]
  },
  {
    matched_chunk: { chunk_id: "b1", chunk_index: 0, text: "B first", score: 0.81 },
    document: { document_id: "doc_b", path: "b.md", title: "B", summary: "Summary B." },
    concepts: ["Storage"],
    related_concepts: [],
    same_document_chunks: []
  },
  {
    matched_chunk: { chunk_id: "a1", chunk_index: 1, text: "Already primary", score: 0.72 },
    document: { document_id: "doc_a", path: "a.md", title: "A", summary: "Summary A." },
    concepts: ["Recall"],
    related_concepts: ["LadybugDB"],
    same_document_chunks: [
      { chunk_id: "a0", chunk_index: 0, text: "Nearby", reason: "same_document_before" },
      { chunk_id: "a0", chunk_index: 0, text: "Nearby", reason: "same_document_before" }
    ]
  }
];

describe("buildGroupedRecall", () => {
  it("keeps primary order while grouping complete context by document", () => {
    const output = buildGroupedRecall(primary, [], []);

    expect(output.results.map((result) => result.matched_chunk.chunk_id)).toEqual(["a2", "b1", "a1"]);
    expect(output.results[0]).toMatchObject({
      document_ref: { group_id: "doc_a", document_id: "doc_a", path: "a.md" },
      ranking: { primary: "chunk_similarity", graph_used_as: "grouped_supporting_context" }
    });
    expect(output.results[0]).not.toHaveProperty("document_context");
    expect(output.results[0]).not.toHaveProperty("graph_context");
    expect(output.context_groups.map((group) => group.group_id)).toEqual(["doc_a", "doc_b"]);
    expect(output.context_groups[0].matched_chunks.map((chunk) => chunk.chunk_id)).toEqual(["a2", "a1"]);
    expect(output.context_groups[0].same_document_chunks).toEqual([
      expect.objectContaining({ chunk_id: "a0" })
    ]);
  });

  it("deduplicates and caps one-hop evidence per document group", () => {
    const paths = Array.from({ length: 7 }, (_, index) => ({
      document_id: "doc_a",
      from: "Recall",
      relationship: "RELATES_TO",
      to: `Concept ${index}`
    }));
    paths.push({ document_id: "doc_a", from: "Recall", relationship: "RELATES_TO", to: "Concept 0" });
    const supporting = Array.from({ length: 4 }, (_, index) => ({
      source_document_id: "doc_a",
      document_id: "doc_support",
      path: "support.md",
      title: "Support",
      chunk_id: `support_${index}`,
      chunk_index: index,
      text: `Supporting ${index}`,
      reason: "related_concept:LadybugDB"
    }));
    supporting.push(supporting[0]);

    const group = buildGroupedRecall(primary.slice(0, 1), paths, supporting).context_groups[0];

    expect(group.graph_context.paths).toHaveLength(5);
    expect(group.graph_context.supporting_chunks).toHaveLength(3);
    expect(new Set(group.graph_context.supporting_chunks.map((chunk) => chunk.chunk_id)).size).toBe(3);
  });
});
