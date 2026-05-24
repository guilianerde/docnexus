export interface RecallMatchedChunk {
  chunk_id: string;
  chunk_index: number;
  text: string;
  score: number;
}

export interface RecallContextChunk {
  chunk_id: string;
  chunk_index: number;
  text: string;
  reason?: string;
}

export interface RecallDocument {
  document_id: string;
  path: string;
  title: string;
  summary: string;
}

export interface RecallGraphPath {
  from: string;
  relationship: string;
  to: string;
}

export interface RecallSupportingChunk extends RecallContextChunk {
  document_id: string;
  path: string;
  title: string;
}

export interface RecallPrimaryMatch {
  matched_chunk: RecallMatchedChunk;
  document: RecallDocument;
  concepts: string[];
  related_concepts: string[];
  same_document_chunks: RecallContextChunk[];
}

export interface RecallPathCandidate extends RecallGraphPath {
  document_id: string;
}

export interface RecallSupportingCandidate extends RecallSupportingChunk {
  source_document_id: string;
}

export interface GroupedRecallResult {
  matched_chunk: RecallMatchedChunk;
  document_ref: {
    group_id: string;
    document_id: string;
    path: string;
  };
  ranking: {
    primary: "chunk_similarity";
    graph_used_as: "grouped_supporting_context";
  };
}

export interface RecallContextGroup {
  group_id: string;
  document: RecallDocument;
  matched_chunks: RecallMatchedChunk[];
  same_document_chunks: RecallContextChunk[];
  graph_context: {
    concepts: string[];
    related_concepts: string[];
    paths: RecallGraphPath[];
    supporting_chunks: RecallSupportingChunk[];
  };
  ranking: {
    primary_score: number;
    primary: "highest_matched_chunk_score";
  };
}

export interface GroupedRecallData {
  results: GroupedRecallResult[];
  context_groups: RecallContextGroup[];
}

export function buildGroupedRecall(
  primary: RecallPrimaryMatch[],
  paths: RecallPathCandidate[],
  supporting: RecallSupportingCandidate[]
): GroupedRecallData {
  const results: GroupedRecallResult[] = primary.map((row) => ({
    matched_chunk: row.matched_chunk,
    document_ref: {
      group_id: row.document.document_id,
      document_id: row.document.document_id,
      path: row.document.path
    },
    ranking: {
      primary: "chunk_similarity",
      graph_used_as: "grouped_supporting_context"
    }
  }));
  const groups = new Map<string, RecallContextGroup>();

  for (const row of primary) {
    let group = groups.get(row.document.document_id);
    if (!group) {
      group = {
        group_id: row.document.document_id,
        document: row.document,
        matched_chunks: [],
        same_document_chunks: [],
        graph_context: {
          concepts: [],
          related_concepts: [],
          paths: [],
          supporting_chunks: []
        },
        ranking: {
          primary_score: row.matched_chunk.score,
          primary: "highest_matched_chunk_score"
        }
      };
      groups.set(row.document.document_id, group);
    }
    group.matched_chunks.push(row.matched_chunk);
    appendStrings(group.graph_context.concepts, row.concepts);
    appendStrings(group.graph_context.related_concepts, row.related_concepts);
    appendChunks(group.same_document_chunks, row.same_document_chunks);
  }

  for (const path of paths) {
    const group = groups.get(path.document_id);
    if (!group || group.graph_context.paths.length === 5) continue;
    const key = `${path.from}\u0000${path.relationship}\u0000${path.to}`;
    const exists = group.graph_context.paths.some(
      (value) => `${value.from}\u0000${value.relationship}\u0000${value.to}` === key
    );
    if (!exists) {
      group.graph_context.paths.push({ from: path.from, relationship: path.relationship, to: path.to });
    }
  }

  for (const chunk of supporting) {
    const group = groups.get(chunk.source_document_id);
    if (!group || group.graph_context.supporting_chunks.length === 3) continue;
    if (group.graph_context.supporting_chunks.some((value) => value.chunk_id === chunk.chunk_id)) continue;
    const { source_document_id: _sourceDocumentId, ...value } = chunk;
    group.graph_context.supporting_chunks.push(value);
  }

  for (const group of groups.values()) {
    const matchedIds = new Set(group.matched_chunks.map((chunk) => chunk.chunk_id));
    group.same_document_chunks = group.same_document_chunks
      .filter((chunk) => !matchedIds.has(chunk.chunk_id))
      .slice(0, 2);
  }

  return { results, context_groups: [...groups.values()] };
}

function appendStrings(target: string[], input: string[]): void {
  for (const value of input) {
    if (!target.includes(value)) target.push(value);
  }
}

function appendChunks(target: RecallContextChunk[], input: RecallContextChunk[]): void {
  for (const chunk of input) {
    if (!target.some((value) => value.chunk_id === chunk.chunk_id)) target.push(chunk);
  }
}
