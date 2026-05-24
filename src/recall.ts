import { type Embedder } from "./embedder.js";
import { createDefaultEmbedder } from "./embedder-default.js";
import { recallFromLadybug } from "./ladybug-store.js";
import { type GroupedRecallData, type RecallContextGroup } from "./recall-groups.js";

export interface RecallInput {
  query: string;
  limit?: number;
}

export interface RecallOutput extends GroupedRecallData {
  query: string;
}

export interface RecallReader {
  recallFromLadybug: typeof recallFromLadybug;
}

const defaultRecallReader: RecallReader = {
  recallFromLadybug
};

export async function recall(
  projectRoot: string,
  input: RecallInput,
  embedder?: Embedder,
  reader: RecallReader = defaultRecallReader
): Promise<RecallOutput> {
  const activeEmbedder = embedder ?? createDefaultEmbedder();
  if (typeof input.query !== "string" || input.query.trim().length === 0) {
    throw new Error("query must be a non-empty string");
  }
  const limit = normalizeLimit(input.limit);

  const query = input.query.trim();
  const queryEmbedding = await activeEmbedder.embed(query);
  if (queryEmbedding.length !== activeEmbedder.dimension) {
    throw new Error("embedding dimension mismatch");
  }

  const grouped = await reader.recallFromLadybug(projectRoot, queryEmbedding, limit);
  grouped.context_groups.forEach(validateContextGroup);

  return { query, results: grouped.results, context_groups: grouped.context_groups };
}

function validateContextGroup(group: RecallContextGroup): void {
  if (!group.document.summary.trim()) {
    throw new Error(`recall requires document metadata for ${group.document.path}`);
  }
  if (group.graph_context.concepts.length === 0) {
    throw new Error(`recall requires graph context for ${group.document.path}`);
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) {
    return 5;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("limit must be a positive integer");
  }
  return Math.min(value, 20);
}
