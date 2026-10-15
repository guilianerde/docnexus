import { embedText } from "./embedder.js";
import { DocNexusError } from "./errors.js";
import { type WorkspaceSnapshot } from "./workspace-snapshot.js";
import { withSyncedRetrieval } from "./retrieval-index.js";
import { type Embedder } from "./embedder.js";
import { createDefaultEmbedder } from "./embedder-default.js";
import { recallFromPostgres } from "./postgres-store.js";
import { type GroupedRecallData, type RecallContextGroup } from "./recall-groups.js";
import { hybridRecall } from "./hybrid-recall.js";
import { withProjectLock } from "./project-lock.js";
import { factsForDocuments } from "./knowledge.js";

export interface RecallInput {
  query: string;
  limit?: number;
  mode?: "hybrid" | "vector";
}

export interface RecallOutput extends GroupedRecallData {
  query: string;
}

export interface RecallReader {
  recallFromPostgres: typeof recallFromPostgres;
}

const defaultRecallReader: RecallReader = {
  recallFromPostgres
};

export async function recall(
  projectRoot: string,
  input: RecallInput,
  embedder?: Embedder,
  reader: RecallReader = defaultRecallReader
): Promise<RecallOutput> {
  const activeEmbedder = embedder ?? createDefaultEmbedder(projectRoot);
  if (typeof input.query !== "string" || input.query.trim().length === 0) {
    throw new DocNexusError("invalid_params", "query must be a non-empty string");
  }
  const limit = normalizeLimit(input.limit);

  const query = input.query.trim();
  if (input.mode !== undefined && !["hybrid", "vector"].includes(input.mode)) throw new DocNexusError("invalid_params", "mode must be hybrid or vector");
  if ((input.mode ?? "hybrid") === "hybrid") {
    const grouped = await hybridRecall(projectRoot, query, limit, activeEmbedder);
    grouped.context_groups.forEach(validateContextGroup);
    return { query, ...grouped };
  }
  const queryEmbedding = await embedText(activeEmbedder, query);
  if (queryEmbedding.length !== activeEmbedder.dimension) throw new DocNexusError("embedding_failed", "embedding dimension mismatch");
  const retrieve = async (snapshot?: WorkspaceSnapshot) => {
    const grouped = await reader.recallFromPostgres(projectRoot, queryEmbedding, limit);
    if (reader === defaultRecallReader) {
      const { documents: knowledgeDocuments, knowledge } = snapshot!;
      for (const group of grouped.context_groups) {
        const facts = factsForDocuments(knowledge.facts, [group.document.document_id,
          ...group.graph_context.supporting_chunks.map((support) => support.document_id),
          ...group.graph_context.paths.flatMap((path) => path.source_document_id ? [path.source_document_id] : [])
        ], knowledgeDocuments);
        if (facts.length) group.facts = facts;
      }
    }
    grouped.context_groups.forEach(validateContextGroup);

    return { query, results: grouped.results, context_groups: grouped.context_groups,
      ...(snapshot ? { as_of: snapshot.at, snapshot_revision: snapshot.revision } : {}) };
  };
  return reader === defaultRecallReader
    ? withSyncedRetrieval(projectRoot, {}, activeEmbedder, async (_db, snapshot) => retrieve(snapshot))
    : withProjectLock(projectRoot, () => retrieve());
}

function validateContextGroup(group: RecallContextGroup): void {
  if (!group.document.summary.trim()) {
    throw new DocNexusError("text_integrity_error", `recall requires document metadata for ${group.document.path}`);
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) {
    return 5;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new DocNexusError("invalid_params", "limit must be a positive integer");
  }
  return Math.min(value, 20);
}
