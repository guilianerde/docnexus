# DocNexus Grouped Recall Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return vector-ranked recall hits plus complete document-level `context_groups[]`, while replacing per-hit LadybugDB enrichment with bounded batched retrieval.

**Architecture:** Add a small pure grouping module that owns the new recall data shapes, stable document grouping, evidence deduplication, and caps. Keep `src/ladybug-store.ts` responsible for three LadybugDB query batches and raw-row normalization, then let `src/recall.ts` validate the required metadata/graph anchors and expose the new breaking JSON contract unchanged through the CLI.

**Tech Stack:** TypeScript, Node.js, Vitest, LadybugDB `@ladybugdb/core`, local embedder path, Markdown skills/documentation.

---

## File Structure

- Create `src/recall-groups.ts`: public grouped storage types and pure `buildGroupedRecall(...)` assembly logic.
- Create `test/recall-groups.test.ts`: fast unit coverage for grouping, stable order, deduplication, and evidence caps.
- Modify `src/ladybug-store.ts`: replace per-result enrichment with three fixed query batches and return raw inputs assembled into grouped output.
- Modify `src/recall.ts`: expose `results[]` plus `context_groups[]`, validate group metadata/direct concepts, and remove the old per-result context contract.
- Modify `test/recall.test.ts`: contract and validation tests against an injected grouped reader.
- Modify `test/cli.test.ts`: real CLI/LadybugDB path expectations for the breaking grouped JSON response.
- Modify `test/ladybug-store.test.ts`: opt-in real LadybugDB grouped retrieval/resource coverage.
- Modify `skills/docnexus-recall/SKILL.md`: teach the agent to rank with `results[]` and answer from `context_groups[]`.
- Modify `README.md`, `README.zh-CN.md`, `docs/product-brief-docnexus-mvp.md`, `docs/product-brief-docnexus-mvp.en.md`, `docs/product-brief-docnexus-mvp.zh-CN.md`: document the new output protocol and grouped one-hop evidence.

No MCP source or archive/index lifecycle source should change.

### Task 1: Pure Document Group Assembly

**Files:**
- Create: `src/recall-groups.ts`
- Create: `test/recall-groups.test.ts`

- [ ] **Step 1: Write failing tests for document grouping, ordering, and caps**

Create `test/recall-groups.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildGroupedRecall, type RecallPrimaryMatch } from "../src/recall-groups.js";

const primary: RecallPrimaryMatch[] = [
  {
    matched_chunk: { chunk_id: "a2", chunk_index: 2, text: "A second", score: 0.95 },
    document: { file_id: "file_a", path: "a.md", record_id: "rec_a", title: "A", summary: "Summary A." },
    concepts: ["Recall"],
    related_concepts: ["LadybugDB"],
    same_document_chunks: [{ chunk_id: "a1", chunk_index: 1, text: "Already primary", reason: "same_document_before" }]
  },
  {
    matched_chunk: { chunk_id: "b1", chunk_index: 0, text: "B first", score: 0.81 },
    document: { file_id: "file_b", path: "b.md", record_id: "rec_b", title: "B", summary: "Summary B." },
    concepts: ["Storage"],
    related_concepts: [],
    same_document_chunks: []
  },
  {
    matched_chunk: { chunk_id: "a1", chunk_index: 1, text: "Already primary", score: 0.72 },
    document: { file_id: "file_a", path: "a.md", record_id: "rec_a", title: "A", summary: "Summary A." },
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
      document_ref: { group_id: "file_a", file_id: "file_a", path: "a.md" },
      ranking: { primary: "chunk_similarity", graph_used_as: "grouped_supporting_context" }
    });
    expect(output.results[0]).not.toHaveProperty("document_context");
    expect(output.results[0]).not.toHaveProperty("graph_context");
    expect(output.context_groups.map((group) => group.group_id)).toEqual(["file_a", "file_b"]);
    expect(output.context_groups[0].matched_chunks.map((chunk) => chunk.chunk_id)).toEqual(["a2", "a1"]);
    expect(output.context_groups[0].same_document_chunks).toEqual([
      expect.objectContaining({ chunk_id: "a0" })
    ]);
  });

  it("deduplicates and caps one-hop evidence per document group", () => {
    const paths = Array.from({ length: 7 }, (_, index) => ({
      file_id: "file_a",
      from: "Recall",
      relationship: "RELATES_TO",
      to: `Concept ${index}`
    }));
    paths.push({ file_id: "file_a", from: "Recall", relationship: "RELATES_TO", to: "Concept 0" });
    const supporting = Array.from({ length: 4 }, (_, index) => ({
      source_file_id: "file_a",
      file_id: "support",
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
```

- [ ] **Step 2: Run the new test and verify it fails because the module does not exist**

Run:

```bash
npm test -- test/recall-groups.test.ts
```

Expected: FAIL because `../src/recall-groups.js` cannot be resolved.

- [ ] **Step 3: Implement grouped recall types and pure assembly**

Create `src/recall-groups.ts`:

```ts
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
  file_id: string;
  path: string;
  record_id?: string;
  title: string;
  summary: string;
}

export interface RecallGraphPath {
  from: string;
  relationship: string;
  to: string;
}

export interface RecallSupportingChunk extends RecallContextChunk {
  file_id: string;
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
  file_id: string;
}

export interface RecallSupportingCandidate extends RecallSupportingChunk {
  source_file_id: string;
}

export interface GroupedRecallResult {
  matched_chunk: RecallMatchedChunk;
  document_ref: {
    group_id: string;
    file_id: string;
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
      group_id: row.document.file_id,
      file_id: row.document.file_id,
      path: row.document.path
    },
    ranking: {
      primary: "chunk_similarity",
      graph_used_as: "grouped_supporting_context"
    }
  }));
  const groups = new Map<string, RecallContextGroup>();

  for (const row of primary) {
    let group = groups.get(row.document.file_id);
    if (!group) {
      group = {
        group_id: row.document.file_id,
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
      groups.set(row.document.file_id, group);
    }
    group.matched_chunks.push(row.matched_chunk);
    appendStrings(group.graph_context.concepts, row.concepts);
    appendStrings(group.graph_context.related_concepts, row.related_concepts);
    appendChunks(group.same_document_chunks, row.same_document_chunks);
  }

  for (const path of paths) {
    const group = groups.get(path.file_id);
    if (!group || group.graph_context.paths.length === 5) continue;
    const key = `${path.from}\u0000${path.relationship}\u0000${path.to}`;
    if (group.graph_context.paths.some((value) => `${value.from}\u0000${value.relationship}\u0000${value.to}` === key)) continue;
    group.graph_context.paths.push({ from: path.from, relationship: path.relationship, to: path.to });
  }
  for (const chunk of supporting) {
    const group = groups.get(chunk.source_file_id);
    if (!group || group.graph_context.supporting_chunks.length === 3) continue;
    if (group.graph_context.supporting_chunks.some((value) => value.chunk_id === chunk.chunk_id)) continue;
    const { source_file_id: _sourceFileId, ...value } = chunk;
    group.graph_context.supporting_chunks.push(value);
  }

  for (const group of groups.values()) {
    const matchedIds = new Set(group.matched_chunks.map((chunk) => chunk.chunk_id));
    group.same_document_chunks = group.same_document_chunks.filter((chunk) => !matchedIds.has(chunk.chunk_id)).slice(0, 2);
  }

  return { results, context_groups: [...groups.values()] };
}

function appendStrings(target: string[], input: string[]): void {
  for (const value of input) if (!target.includes(value)) target.push(value);
}

function appendChunks(target: RecallContextChunk[], input: RecallContextChunk[]): void {
  for (const chunk of input) {
    if (!target.some((value) => value.chunk_id === chunk.chunk_id)) target.push(chunk);
  }
}
```

The map insertion order supplies the required stable tie breaker because `primary` arrives in score order and each group is first inserted on its best matching chunk.

- [ ] **Step 4: Run the grouping test and typecheck**

Run:

```bash
npm test -- test/recall-groups.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the pure grouping unit**

```bash
git add src/recall-groups.ts test/recall-groups.test.ts
git commit -m "feat: add grouped recall assembly"
```

### Task 2: Grouped Recall Contract and Batched LadybugDB Retrieval

**Files:**
- Modify: `src/recall.ts`
- Modify: `test/recall.test.ts`
- Modify: `src/ladybug-store.ts`
- Modify: `test/cli.test.ts`
- Modify: `test/ladybug-store.test.ts`

- [ ] **Step 1: Replace unit contract tests with grouped-output expectations**

Update the stub reader rows in `test/recall.test.ts` to return `GroupedRecallData`, and change the primary contract assertion to:

```ts
const output = await recall(projectRoot, { query: "JWT authentication", limit: 1 }, new LocalHashEmbedder(), {
  recallFromLadybug: async () => ({
    results: [
      {
        matched_chunk: { chunk_id: "chunk_auth", chunk_index: 0, text: "JWT middleware.", score: 0.9 },
        document_ref: { group_id: "file_auth", file_id: "file_auth", path: "auth.md" },
        ranking: { primary: "chunk_similarity", graph_used_as: "grouped_supporting_context" }
      }
    ],
    context_groups: [
      {
        group_id: "file_auth",
        document: {
          file_id: "file_auth",
          path: "auth.md",
          record_id: "rec_auth",
          title: "Auth Architecture",
          summary: "Authentication architecture notes."
        },
        matched_chunks: [{ chunk_id: "chunk_auth", chunk_index: 0, text: "JWT middleware.", score: 0.9 }],
        same_document_chunks: [],
        graph_context: { concepts: ["Auth"], related_concepts: [], paths: [], supporting_chunks: [] },
        ranking: { primary_score: 0.9, primary: "highest_matched_chunk_score" }
      }
    ]
  })
});

expect(output.results[0]).toMatchObject({
  document_ref: { group_id: "file_auth", path: "auth.md" },
  ranking: { graph_used_as: "grouped_supporting_context" }
});
expect(output.results[0]).not.toHaveProperty("document_context");
expect(output.results[0]).not.toHaveProperty("graph_context");
expect(output.context_groups[0].document.record_id).toBe("rec_auth");
expect(output.context_groups[0].graph_context.concepts).toContain("Auth");
```

Change empty reader expectations to include the new array:

```ts
await expect(recall(projectRoot, { query: "nothing" }, new LocalHashEmbedder(), emptyRecallReader())).resolves.toEqual({
  query: "nothing",
  results: [],
  context_groups: []
});
```

Update failure stubs so validation is exercised through a group:

```ts
context_groups: [
  {
    ...makeGroup("file_auth", ""),
    graph_context: { concepts: ["Auth"], related_concepts: [], paths: [], supporting_chunks: [] }
  }
]
```

and:

```ts
context_groups: [
  {
    ...makeGroup("file_auth", "Auth architecture notes."),
    graph_context: { concepts: [], related_concepts: [], paths: [], supporting_chunks: [] }
  }
]
```

- [ ] **Step 2: Update CLI tests for grouped evidence and repeated primary hits**

Change the first recall assertion in `test/cli.test.ts` to expect:

```ts
expect(recallResult.results[0]).toMatchObject({
  matched_chunk: { text: expect.stringContaining("CLI local recall") },
  document_ref: { path: "cli.md", group_id: expect.any(String) },
  ranking: { primary: "chunk_similarity", graph_used_as: "grouped_supporting_context" }
});
expect(recallResult.results[0]).not.toHaveProperty("document_context");
expect(recallResult.results[0]).not.toHaveProperty("graph_context");
expect(recallResult.context_groups[0]).toMatchObject({
  group_id: recallResult.results[0].document_ref.group_id,
  document: {
    path: "cli.md",
    record_id: record.id,
    title: "CLI Recall Notes",
    summary: expect.stringContaining("structured Graph RAG")
  },
  graph_context: { concepts: expect.arrayContaining(["CLI Recall"]), paths: [], supporting_chunks: [] }
});
```

Update the existing enrichment test to read from its group:

```ts
const group = output.context_groups.find((value: { document: { path: string } }) => value.document.path === "recall.md");
expect(group.same_document_chunks).toEqual(
  expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("Nearby supporting paragraph") })])
);
expect(group.graph_context.paths).toEqual(
  expect.arrayContaining([{ from: "Recall", relationship: "DEPENDS_ON", to: "LadybugDB" }])
);
expect(group.graph_context.supporting_chunks).toEqual(
  expect.arrayContaining([expect.objectContaining({ path: "ladybug.md", reason: "related_concept:LadybugDB" })])
);
```

Use `--limit 2` for that primary document and add:

```ts
expect(output.context_groups.filter((value: { document: { path: string } }) => value.document.path === "recall.md")).toHaveLength(1);
expect(group.matched_chunks.length).toBeGreaterThanOrEqual(1);
for (const matched of group.matched_chunks) {
  expect(group.same_document_chunks).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ chunk_id: matched.chunk_id })])
  );
}
```

- [ ] **Step 3: Extend opt-in LadybugDB integration coverage before implementation**

Import `recallFromLadybug` and `type ReplaceDocumentGraphInput` in `test/ladybug-store.test.ts` and add an opt-in test using the existing `runIntegration` guard. Create two documents whose chunks share a deterministic embedding and whose graph includes `Recall DEPENDS_ON LadybugDB`; invoke retrieval after both graphs are stored:

```ts
it("returns one grouped context per document with one-hop evidence", async () => {
  if (!runIntegration || !(await isLadybugAvailable())) return;

  const projectRoot = await makeRoot();
  const embedding = Array.from({ length: EMBEDDING_DIMENSION }, (_, index) => (index === 0 ? 1 : 0));
  await replaceDocumentGraph(projectRoot, primaryGraph(projectRoot, embedding));
  await replaceDocumentGraph(projectRoot, supportingGraph(projectRoot, embedding));

  const output = await recallFromLadybug(projectRoot, embedding, 2);
  const primaryGroup = output.context_groups.find((group) => group.group_id === "file_primary");

  expect(output.results.length).toBeGreaterThan(0);
  expect(primaryGroup?.graph_context.paths).toContainEqual({
    from: "Recall",
    relationship: "DEPENDS_ON",
    to: "LadybugDB"
  });
  expect(primaryGroup?.graph_context.supporting_chunks).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: "ladybug.md" })])
  );
});
```

Add complete graph fixtures below the test:

```ts
function primaryGraph(projectRoot: string, embedding: number[]): ReplaceDocumentGraphInput {
  return {
    project: { id: "project", name: "project", root_path: projectRoot },
    document: {
      id: "doc_primary",
      file_id: "file_primary",
      record_id: "rec_primary",
      title: "Recall",
      path: "recall.md",
      summary: "Recall uses LadybugDB as supporting graph evidence.",
      content_hash: "hash_primary",
      updated_at: "2026-05-23T00:00:00.000Z"
    },
    chunks: [
      {
        id: "chunk_primary",
        file_id: "file_primary",
        document_id: "doc_primary",
        text: "Recall depends on LadybugDB.",
        text_hash: "text_hash_primary",
        chunk_index: 0,
        embedding
      }
    ],
    concepts: [
      { id: "concept_recall", name: "Recall", type: "workflow", description: "Recall workflow." },
      { id: "concept_ladybug", name: "LadybugDB", type: "tool", description: "Graph storage." }
    ],
    edges: [{ from: "concept_recall", to: "concept_ladybug", label: "DEPENDS_ON" }]
  };
}

function supportingGraph(projectRoot: string, embedding: number[]): ReplaceDocumentGraphInput {
  return {
    project: { id: "project", name: "project", root_path: projectRoot },
    document: {
      id: "doc_supporting",
      file_id: "file_supporting",
      record_id: "rec_supporting",
      title: "Ladybug Store",
      path: "ladybug.md",
      summary: "LadybugDB persists graph and vector evidence.",
      content_hash: "hash_supporting",
      updated_at: "2026-05-23T00:00:00.000Z"
    },
    chunks: [
      {
        id: "chunk_supporting",
        file_id: "file_supporting",
        document_id: "doc_supporting",
        text: "LadybugDB persists graph context.",
        text_hash: "text_hash_supporting",
        chunk_index: 0,
        embedding
      }
    ],
    concepts: [
      { id: "concept_ladybug", name: "LadybugDB", type: "tool", description: "Graph storage." }
    ],
    edges: []
  };
}
```

- [ ] **Step 4: Run contract and integration tests to verify RED**

Run:

```bash
npm test -- test/recall.test.ts test/cli.test.ts
DOCNEXUS_LADYBUG_INTEGRATION=1 npm test -- test/ladybug-store.test.ts
```

Expected:

- unit and CLI tests FAIL because `recall(...)` still returns context per result and has no `context_groups`.
- integration test FAIL for the same contract reason, or reproduce the known LadybugDB mmap/resource failure. Preserve the exact failure text if the runtime issue occurs.

- [ ] **Step 5: Replace Ladybug storage result types and primary mapping**

In `src/ladybug-store.ts`, import the grouping contract:

```ts
import {
  buildGroupedRecall,
  type GroupedRecallData,
  type RecallContextChunk,
  type RecallPathCandidate,
  type RecallPrimaryMatch,
  type RecallSupportingCandidate
} from "./recall-groups.js";
```

Remove the obsolete exported `LadybugRecallRow`, `LadybugDocumentContext`, `LadybugGraphContext`, and `LadybugRanking` interfaces. Keep storage-specific graph write node interfaces intact.

Change the signature:

```ts
export async function recallFromLadybug(
  projectRoot: string,
  queryEmbedding: number[],
  limit: number
): Promise<GroupedRecallData> {
```

The primary query should continue fetching vector-ranked chunks, document metadata, direct concepts, related concepts, previous chunk, and next chunk. Rename `normalizeRecallRow(...)` to `normalizePrimaryMatch(...)` and return:

```ts
function normalizePrimaryMatch(row: unknown): RecallPrimaryMatch {
  const value = row as {
    file_id: string;
    file_path: string;
    record_id: string | null;
    document_title: string;
    document_summary: string;
    chunk_id: string;
    chunk_index: number;
    score: number;
    text: string;
    previous_chunk_id: string | null;
    previous_chunk_index: number | null;
    previous_text: string | null;
    next_chunk_id: string | null;
    next_chunk_index: number | null;
    next_text: string | null;
    concepts?: unknown[];
    related_concepts?: unknown[];
  };
  const sameDocumentChunks: RecallContextChunk[] = [];
  if (value.previous_chunk_id && value.previous_text) {
    sameDocumentChunks.push({
      chunk_id: value.previous_chunk_id,
      chunk_index: Number(value.previous_chunk_index),
      text: value.previous_text,
      reason: "same_document_before"
    });
  }
  if (value.next_chunk_id && value.next_text) {
    sameDocumentChunks.push({
      chunk_id: value.next_chunk_id,
      chunk_index: Number(value.next_chunk_index),
      text: value.next_text,
      reason: "same_document_after"
    });
  }
  return {
    matched_chunk: {
      chunk_id: value.chunk_id,
      chunk_index: Number(value.chunk_index),
      text: value.text,
      score: Number(value.score)
    },
    document: {
      file_id: value.file_id,
      path: value.file_path,
      ...(value.record_id ? { record_id: value.record_id } : {}),
      title: value.document_title,
      summary: value.document_summary
    },
    concepts: normalizeStringList(value.concepts),
    related_concepts: normalizeStringList(value.related_concepts),
    same_document_chunks: sameDocumentChunks
  };
}
```

- [ ] **Step 6: Replace per-result enrichment with fixed batch queries**

After the primary query in `recallFromLadybug(...)`, assemble distinct document IDs and perform one path query and one support query:

```ts
const primary = rows.map(normalizePrimaryMatch);
if (primary.length === 0) return { results: [], context_groups: [] };
const fileIds = [...new Set(primary.map((row) => row.document.file_id))];
const paths = await loadGraphPathsForFiles(projectRoot, fileIds);
const supporting = await loadSupportingChunksForFiles(projectRoot, fileIds);
return buildGroupedRecall(primary, paths, supporting);
```

Replace `loadGraphPaths(...)` with:

```ts
async function loadGraphPathsForFiles(projectRoot: string, fileIds: string[]): Promise<RecallPathCandidate[]> {
  const rows = await queryLadybugRows(
    projectRoot,
    `
    MATCH (d:Document)-[:MENTIONS]->(from:Concept)-[:DEPENDS_ON]->(to:Concept)
    WHERE d.file_id IN $file_ids
    RETURN d.file_id AS file_id, from.name AS from_name, 'DEPENDS_ON' AS relationship, to.name AS to_name
    UNION ALL
    MATCH (d:Document)-[:MENTIONS]->(from:Concept)-[:RELATES_TO]->(to:Concept)
    WHERE d.file_id IN $file_ids
    RETURN d.file_id AS file_id, from.name AS from_name, 'RELATES_TO' AS relationship, to.name AS to_name
    UNION ALL
    MATCH (d:Document)-[:MENTIONS]->(from:Concept)-[:IMPLEMENTS]->(to:Concept)
    WHERE d.file_id IN $file_ids
    RETURN d.file_id AS file_id, from.name AS from_name, 'IMPLEMENTS' AS relationship, to.name AS to_name
    UNION ALL
    MATCH (d:Document)-[:MENTIONS]->(from:Concept)-[:REPLACES]->(to:Concept)
    WHERE d.file_id IN $file_ids
    RETURN d.file_id AS file_id, from.name AS from_name, 'REPLACES' AS relationship, to.name AS to_name
    UNION ALL
    MATCH (d:Document)-[:MENTIONS]->(from:Concept)-[:DECIDES]->(to:Concept)
    WHERE d.file_id IN $file_ids
    RETURN d.file_id AS file_id, from.name AS from_name, 'DECIDES' AS relationship, to.name AS to_name
    `,
    { file_ids: fileIds }
  );
  return rows.map((row) => {
    const value = row as { file_id: string; from_name: string; relationship: string; to_name: string };
    return { file_id: value.file_id, from: value.from_name, relationship: value.relationship, to: value.to_name };
  });
}
```

Replace `loadSupportingChunks(...)` with:

```ts
async function loadSupportingChunksForFiles(
  projectRoot: string,
  fileIds: string[]
): Promise<RecallSupportingCandidate[]> {
  const rows = await queryLadybugRows(
    projectRoot,
    `
    MATCH (matched:Document)-[:MENTIONS]->(:Concept)-[:DEPENDS_ON|RELATES_TO|IMPLEMENTS|REPLACES|DECIDES]->(related:Concept)
    MATCH (supporting:Document)-[:MENTIONS]->(related)
    MATCH (supporting)-[:HAS_CHUNK]->(chunk:Chunk)
    WHERE matched.file_id IN $file_ids
      AND supporting.file_id <> matched.file_id
    RETURN
      matched.file_id AS source_file_id,
      supporting.file_id AS file_id,
      supporting.path AS path,
      supporting.title AS title,
      chunk.id AS chunk_id,
      chunk.chunk_index AS chunk_index,
      chunk.text AS text,
      related.name AS related_concept
    ORDER BY source_file_id ASC, supporting.path ASC, chunk.chunk_index ASC
    `,
    { file_ids: fileIds }
  );
  return rows.map((row) => {
    const value = row as {
      source_file_id: string;
      file_id: string;
      path: string;
      title: string;
      chunk_id: string;
      chunk_index: number;
      text: string;
      related_concept: string;
    };
    return {
      source_file_id: value.source_file_id,
      file_id: value.file_id,
      path: value.path,
      title: value.title,
      chunk_id: value.chunk_id,
      chunk_index: Number(value.chunk_index),
      text: value.text,
      reason: `related_concept:${value.related_concept}`
    };
  });
}
```

Do not put a global `LIMIT` into either batch query; per-group caps are applied deterministically in `buildGroupedRecall(...)`, and a global SQL/Cypher limit could starve later matched documents. Because the primary query already returns document metadata, direct concepts, related concepts, and nearby chunks, this implementation uses three fixed query batches: primary, paths, and supporting chunks.

- [ ] **Step 7: Update `src/recall.ts` to expose and validate grouped data**

Replace local duplicated context types with imports from the grouping module and update the public output/read boundary:

```ts
import {
  type GroupedRecallData,
  type GroupedRecallResult,
  type RecallContextGroup
} from "./recall-groups.js";

export interface RecallOutput extends GroupedRecallData {
  query: string;
}

export interface RecallReader {
  recallFromLadybug: typeof recallFromLadybug;
}

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
```

Delete the obsolete `RecallResult`, `RecallDocumentContext`, `RecallGraphContext`, `mapRecallRow(...)`, and per-row validation definitions. Import types only when consumed; do not retain dead exported aliases.

- [ ] **Step 8: Update the empty reader/helper rows and run grouped tests**

Implement `emptyRecallReader()` as:

```ts
function emptyRecallReader(): RecallReader {
  return {
    recallFromLadybug: async () => ({ results: [], context_groups: [] })
  };
}
```

Replace any test helper that constructs old Ladybug rows with a helper that constructs a `RecallContextGroup` and corresponding `GroupedRecallResult`.

Run:

```bash
npm test -- test/recall-groups.test.ts test/recall.test.ts test/cli.test.ts
DOCNEXUS_LADYBUG_INTEGRATION=1 npm test -- test/ladybug-store.test.ts
npm run typecheck
```

Expected: PASS. If the opt-in real LadybugDB command reproduces the mmap/resource failure, stop this task, capture the error, and report the implementation as blocked rather than committing a claimed complete retrieval feature.

- [ ] **Step 9: Commit the atomic grouped retrieval contract and storage change**

```bash
git add src/recall.ts src/ladybug-store.ts test/recall.test.ts test/cli.test.ts test/ladybug-store.test.ts
git commit -m "feat: batch grouped LadybugDB recall context"
```

### Task 3: Recall Skill and User Documentation

**Files:**
- Modify: `skills/docnexus-recall/SKILL.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/product-brief-docnexus-mvp.md`
- Modify: `docs/product-brief-docnexus-mvp.en.md`
- Modify: `docs/product-brief-docnexus-mvp.zh-CN.md`

- [ ] **Step 1: Update the recall skill for the grouped protocol**

Replace the field-consumption steps in `skills/docnexus-recall/SKILL.md` with:

```markdown
6. Parse the JSON output.
7. Read `results[]` as the primary ranked chunk evidence list. Each result points to a document group through `document_ref.group_id`.
8. Read `context_groups[]` as the complete answer context. Each group consolidates a matched document, all of its primary matched chunks, nearby same-document chunks, and one-hop graph evidence.
9. Treat `results[].matched_chunk.score` as the relevance signal. Do not rerank results because a group has additional graph support.
10. Answer the user's question from `context_groups[]`, using `results[]` to explain why a document was recalled.
11. Include a concise `References` section listing the group document paths used. Include the highest matched chunk index and score for each cited group when present.
```

Replace output guidance with:

```markdown
- Prefer concrete facts from `context_groups[].matched_chunks` over generic explanation.
- Use `context_groups[].same_document_chunks` to complete the local document meaning.
- Use `context_groups[].graph_context.paths` to explain typed one-hop relationships.
- Use `context_groups[].graph_context.supporting_chunks` only as supporting cross-document evidence.
- Treat all chunks in one group as one source document when citing references.
```

Replace the reference example with:

```markdown
References:
- `context_groups[].document.path`, chunk `context_groups[].matched_chunks[0].chunk_index`, score `context_groups[].matched_chunks[0].score`
```

- [ ] **Step 2: Update English and Chinese README protocol descriptions**

In `README.md` and `README.zh-CN.md`, replace statements that say each result contains document and graph context with the new boundary:

```markdown
`results[]` preserves vector-ranked primary chunks and links each hit to a document group through `document_ref`. `context_groups[]` contains the complete grouped document evidence: matched chunks, nearby source chunks, typed one-hop graph paths, and related-document supporting chunks. This is a breaking replacement for the earlier per-result `document_context` / `graph_context` fields.
```

Use an equivalent Chinese statement in `README.zh-CN.md`:

```markdown
`results[]` 保留按向量相似度排序的主命中 chunk，并通过 `document_ref` 关联文档组；`context_groups[]` 提供完整的文档级证据归集，包括命中 chunks、同文档邻近 chunks、类型化一跳图路径和关联文档 supporting chunks。本协议替代旧的逐结果 `document_context` / `graph_context` 字段，属于破坏性升级。
```

- [ ] **Step 3: Update product briefs with implementation status and workflow**

In all three product brief files, update the recall architecture/workflow paragraphs to state:

```markdown
CLI recall returns two views: vector-ranked `results[]` for primary relevance, and document-grouped `context_groups[]` for complete Graph RAG evidence. Context groups deduplicate bounded one-hop graph and nearby-document evidence without changing primary chunk ordering. The previous per-result `document_context` / `graph_context` output has been replaced.
```

Provide the Chinese equivalent in the Chinese sections/files:

```markdown
CLI recall 返回两个视图：`results[]` 保存按向量相关性排序的主命中，`context_groups[]` 按文档归集完整 Graph RAG 证据。文档组对有界一跳图谱证据和邻近原文证据进行去重，但不改变主 chunk 排序。旧版逐结果 `document_context` / `graph_context` 输出已被替换。
```

- [ ] **Step 4: Search for stale protocol descriptions**

Run:

```bash
rg -n "document_context|graph_context|context_groups|grouped|归集|逐结果|每个结果包含|Each result has" README.md README.zh-CN.md docs/product-brief-docnexus-mvp.md docs/product-brief-docnexus-mvp.en.md docs/product-brief-docnexus-mvp.zh-CN.md skills/docnexus-recall/SKILL.md
```

Expected: mentions of `document_context` and old per-result behavior occur only when explicitly describing the replaced protocol; active workflow text uses `results[]`, `document_ref`, and `context_groups[]`.

- [ ] **Step 5: Commit the skill and documentation update**

```bash
git add skills/docnexus-recall/SKILL.md README.md README.zh-CN.md docs/product-brief-docnexus-mvp.md docs/product-brief-docnexus-mvp.en.md docs/product-brief-docnexus-mvp.zh-CN.md
git commit -m "docs: describe grouped recall evidence protocol"
```

### Task 4: Full Verification

**Files:**
- Verify only: all modified source, test, skill, and documentation files

- [ ] **Step 1: Run the complete default test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Run real LadybugDB grouped integration verification**

Run:

```bash
DOCNEXUS_LADYBUG_INTEGRATION=1 npm test -- test/ladybug-store.test.ts
```

Expected: PASS. If a LadybugDB mmap/resource error occurs, record the exact test and error output and report the feature as blocked; do not claim completion.

- [ ] **Step 3: Verify type safety and distributable build**

Run:

```bash
npm run typecheck
npm run build
git diff --check
```

Expected: all commands exit successfully with no whitespace errors.

- [ ] **Step 4: Inspect repository scope**

Run:

```bash
git status --short
git diff --stat HEAD~3..HEAD
```

Expected: changed files are limited to grouped recall source/tests, the recall skill, and the protocol documentation listed in this plan; no MCP or index lifecycle code is changed.
