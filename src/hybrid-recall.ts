import { DocNexusError } from "./errors.js";
import { embedText } from "./embedder.js";
import type { Embedder } from "./embedder.js";
import { EMBEDDING_DIMENSION } from "./embedding-config.js";
import { factsForDocuments, normalizeName } from "./knowledge.js";
import { findVectorCandidates, loadPostgresContext, readChunkTexts, type VectorCandidate } from "./postgres-store.js";
import type { GroupedRecallData } from "./recall-groups.js";
import { withSyncedRetrieval } from "./retrieval-index.js";
import { searchSnapshot } from "./search.js";

export interface FusedRank {
  id: string;
  score: number;
  ranks: { keyword?: number; vector?: number };
}

/** Fuse document ranks, so many chunks in one document cannot accumulate extra votes. */
export function fuseDocumentRanks(keyword: string[], vector: string[]): FusedRank[] {
  const documents = new Map<string, FusedRank>();
  for (const [source, ids] of [["keyword", keyword], ["vector", vector]] as const) {
    [...new Set(ids)].forEach((id, index) => {
      const entry = documents.get(id) ?? { id, score: 0, ranks: {} };
      entry.ranks[source] = index + 1;
      entry.score += 1 / (60 + index + 1);
      documents.set(id, entry);
    });
  }
  return [...documents.values()].sort((a, b) => b.score - a.score
    || Math.min(a.ranks.keyword ?? Infinity, a.ranks.vector ?? Infinity) - Math.min(b.ranks.keyword ?? Infinity, b.ranks.vector ?? Infinity)
    || a.id.localeCompare(b.id));
}

export async function hybridRecall(projectRoot: string, query: string, limit: number, embedder: Embedder, category?: string): Promise<GroupedRecallData> {
  const embedding = await embedText(embedder, query);
  if (embedding.length !== EMBEDDING_DIMENSION || !embedding.every(Number.isFinite)) throw new DocNexusError("embedding_failed", "embedding dimension mismatch or non-finite values");
  return withSyncedRetrieval(projectRoot, {}, embedder, async (db, snapshot) => {
    const candidates = Math.min(100, Math.max(20, limit * 5));
    const documentIds = category === undefined ? undefined : snapshot.documents.filter(document => (document.metadata.category ?? "uncategorized") === category).map(document => document.id);
    const keyword = searchSnapshot(snapshot, { query, limit: candidates, category });
    const vector = await findVectorCandidates(db, embedding, candidates, true, undefined, documentIds);
    const ranked = fuseDocumentRanks(keyword.results.map((result) => result.id), vector.map((result) => result.document_id)).slice(0, limit);
    if (!ranked.length) return { results: [], context_groups: [], as_of: snapshot.at, snapshot_revision: snapshot.revision };
    const selected: VectorCandidate[] = [];
    const keywordOnly = ranked.filter(rank => !vector.some(result => result.document_id === rank.id));
    const keywordChunks = keywordOnly.length ? await readChunkTexts(db, keywordOnly.map(rank => rank.id)) : [];
    for (const rank of ranked) {
      const match = vector.find((result) => result.document_id === rank.id);
      if (match) selected.push(match);
      else {
        const terms = keyword.results.find((result) => result.id === rank.id)!.matched_terms;
        const chunks = keywordChunks.filter(chunk => chunk.document_id === rank.id);
        const score = (text: string) => terms.filter((term) => normalizeName(text).includes(term)).length;
        const chunk = chunks.sort((a, b) => score(b.text) - score(a.text) || a.chunk_index - b.chunk_index)[0];
        if (!chunk) throw new Error(`indexed document has no chunks: ${rank.id}`);
        selected.push({ id: chunk.id, document_id: rank.id, score: 0 });
      }
    }
    // Load graph/neighbor evidence for keyword-only documents as well as vector candidates.
    const context = await loadPostgresContext(db, selected, documentIds);
    const { documents: knowledgeDocuments, knowledge } = snapshot;
    const results: GroupedRecallData["results"] = [];
    const groups: GroupedRecallData["context_groups"] = [];
    for (const rank of ranked) {
      const group = context.context_groups.find((value) => value.document.document_id === rank.id);
      if (!group) throw new Error(`missing hybrid context: ${rank.id}`);
      const chunk = group.matched_chunks.find((value) => value.chunk_id === selected.find(match => match.document_id === rank.id)!.id)!;
      chunk.score = selected.find(match => match.document_id === rank.id)!.score;
      group.ranking = { primary: "rrf", primary_score: rank.score };
      const facts = factsForDocuments(knowledge.facts, [rank.id,
        ...group.graph_context.supporting_chunks.map((support) => support.document_id),
        ...group.graph_context.paths.flatMap((path) => path.source_document_id ? [path.source_document_id] : [])
      ], knowledgeDocuments);
      if (facts.length) group.facts = facts;
      const lexical = keyword.results.find((result) => result.id === rank.id);
      group.matches = [
        ...(chunk.source_anchor ? [{ source: vector.some(value => value.document_id === rank.id) ? "vector" as const : "keyword" as const, anchor: chunk.source_anchor }] : []),
        ...(lexical?.source_anchor ? [{ source: "keyword" as const, anchor: lexical.source_anchor }] : [])
      ];
      results.push({
        matched_chunk: chunk,
        ...(lexical ? { keyword_match: { snippet: lexical.snippet, line: lexical.line, matched_terms: lexical.matched_terms, score: lexical.score, source_anchor: lexical.source_anchor } } : {}),
        document_ref: { document_id: rank.id, group_id: rank.id, path: group.document.path },
        ranking: { primary: "rrf", rrf_score: rank.score, source_ranks: rank.ranks, graph_used_as: "grouped_supporting_context" }
      });
      groups.push(group);
    }
    return { results, context_groups: groups, as_of: snapshot.at, snapshot_revision: snapshot.revision };
  });
}
