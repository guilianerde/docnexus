# DocNexus Graph Context Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate existing structured recall context fields with bounded same-document chunks, typed one-hop graph paths, and related-document supporting chunks without changing primary relevance ranking.

**Architecture:** Keep `recall()` and CLI output contracts stable while enriching rows inside `src/ladybug-store.ts` after vector retrieval. The vector index continues to select and order `matched_chunk` results; targeted graph/document queries populate arrays already present in `document_context` and `graph_context`. No MCP surface or embedding behavior changes.

**Tech Stack:** Node.js, TypeScript, LadybugDB, Vitest, Markdown skills/docs.

---

## File Map

- Modify `src/ladybug-store.ts`: add bounded enrichment helpers for nearby same-document chunks, one-hop concept paths, and supporting chunks from related documents; keep vector-ranked rows in their original order.
- Modify `test/ladybug-store.test.ts`: add guarded LadybugDB assertions for real enrichment query behavior where runtime stability permits.
- Modify `test/recall.test.ts`: assert populated structured enrichment data passes through unchanged and primary ordering remains based on matched scores.
- Modify `test/cli.test.ts`: extend the existing metadata-linked CLI recall flow with multiple documents and verify populated arrays in CLI JSON.
- Modify `skills/docnexus-recall/SKILL.md`: clarify the evidence priority and how to cite supporting chunks.
- Modify `README.md`, `README.zh-CN.md`, `docs/product-brief-docnexus-mvp.en.md`, `docs/product-brief-docnexus-mvp.zh-CN.md`, and `docs/product-brief-docnexus-mvp.md`: document that one-hop graph context fields are now populated.

## Task 1: Contract Tests For Populated Context

**Files:**
- Modify: `test/recall.test.ts`
- Verify: `src/recall.ts`

- [ ] **Step 1: Add a pass-through test for real enrichment arrays**

Add a unit test that supplies an already enriched Ladybug row and verifies the `recall()` output retains the populated arrays:

```ts
it("preserves populated same-document and one-hop supporting context", async () => {
  const projectRoot = await makeRoot();

  const output = await recall(projectRoot, { query: "graph retrieval", limit: 1 }, new LocalHashEmbedder(), {
    recallFromLadybug: async () => [
      {
        matched_chunk: {
          chunk_id: "chunk_primary",
          chunk_index: 1,
          text: "Graph retrieval uses LadybugDB.",
          score: 0.94
        },
        document_context: {
          file_id: "file_primary",
          path: "recall.md",
          title: "Recall",
          summary: "Recall behavior and graph enrichment.",
          same_document_chunks: [
            {
              chunk_id: "chunk_nearby",
              chunk_index: 0,
              text: "Vector retrieval selects the primary chunk.",
              reason: "same_document_before"
            }
          ]
        },
        graph_context: {
          concepts: ["Recall"],
          related_concepts: ["LadybugDB"],
          paths: [
            {
              from: "Recall",
              relationship: "DEPENDS_ON",
              to: "LadybugDB"
            }
          ],
          supporting_chunks: [
            {
              file_id: "file_graph",
              path: "ladybug.md",
              title: "LadybugDB",
              chunk_id: "chunk_support",
              chunk_index: 0,
              text: "LadybugDB stores graph context.",
              reason: "related_concept:LadybugDB"
            }
          ]
        },
        ranking: {
          primary: "chunk_similarity" as const,
          graph_used_as: "supporting_context" as const
        }
      }
    ]
  });

  expect(output.results[0]?.document_context.same_document_chunks).toHaveLength(1);
  expect(output.results[0]?.graph_context.paths).toEqual([
    { from: "Recall", relationship: "DEPENDS_ON", to: "LadybugDB" }
  ]);
  expect(output.results[0]?.graph_context.supporting_chunks[0]).toMatchObject({
    path: "ladybug.md",
    reason: "related_concept:LadybugDB"
  });
});
```

- [ ] **Step 2: Add a test that supporting context does not reorder primary results**

Add a two-row reader fixture where the lower scored result contains richer supporting context, then assert the rows stay ordered by `matched_chunk.score`:

```ts
it("does not promote graph supporting context over matched chunk ranking", async () => {
  const projectRoot = await makeRoot();
  const rows = [
    makeResultRow("high", 0.92, []),
    makeResultRow("low", 0.61, [{ file_id: "support", path: "support.md", title: "Support", chunk_id: "support_0", chunk_index: 0, text: "Support", reason: "related_concept:Support" }])
  ];

  const output = await recall(projectRoot, { query: "ranking", limit: 2 }, new LocalHashEmbedder(), {
    recallFromLadybug: async () => rows
  });

  expect(output.results.map((result) => result.matched_chunk.chunk_id)).toEqual(["high", "low"]);
});
```

Define `makeResultRow(...)` in the test file with non-empty metadata and direct concepts so the existing hard dependency validation remains satisfied.

- [ ] **Step 3: Run the unit test file**

Run:

```bash
npm test -- test/recall.test.ts
```

Expected: PASS because `recall()` is already a structured pass-through and these tests freeze the enriched contract before storage work begins.

- [ ] **Step 4: Commit the contract tests**

```bash
git add test/recall.test.ts
git commit -m "test: cover graph context enrichment contract"
```

## Task 2: Same-Document Chunk Enrichment

**Files:**
- Modify: `src/ladybug-store.ts`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Write a failing CLI test for same-document chunks**

Extend the current CLI recall test content so its indexed file is chunked into at least two chunks, then assert `same_document_chunks` is populated while the primary chunk is excluded:

```ts
const longContent = `${"Primary graph recall paragraph. ".repeat(18)}

${"Nearby supporting paragraph from the same document. ".repeat(18)}`;
await writeFile(filePath, longContent);

const result = JSON.parse(await runCli(["recall", "Primary graph recall", "--limit", "1"], projectRoot));
expect(result.results[0].document_context.same_document_chunks).toEqual(
  expect.arrayContaining([
    expect.objectContaining({
      text: expect.stringContaining("Nearby supporting paragraph"),
      reason: expect.stringMatching(/^same_document_/)
    })
  ])
);
expect(result.results[0].document_context.same_document_chunks).not.toEqual(
  expect.arrayContaining([expect.objectContaining({ chunk_id: result.results[0].matched_chunk.chunk_id })])
);
```

- [ ] **Step 2: Run the CLI test and verify RED**

Run:

```bash
npm test -- test/cli.test.ts
```

Expected: FAIL because `same_document_chunks` is currently always `[]`.

- [ ] **Step 3: Implement bounded nearby chunk loading**

Add a helper in `src/ladybug-store.ts`:

```ts
async function loadSameDocumentChunks(
  projectRoot: string,
  fileId: string,
  matchedChunkId: string,
  matchedChunkIndex: number
): Promise<LadybugContextChunk[]> {
  const rows = await queryLadybugRows(
    projectRoot,
    `
    MATCH (d:Document)-[:HAS_CHUNK]->(context:Chunk)
    WHERE d.file_id = $file_id AND context.id <> $chunk_id
    RETURN
      context.id AS chunk_id,
      context.chunk_index AS chunk_index,
      context.text AS text
    ORDER BY abs(context.chunk_index - $chunk_index) ASC, context.chunk_index ASC
    LIMIT 2
    `,
    { file_id: fileId, chunk_id: matchedChunkId, chunk_index: matchedChunkIndex }
  );

  return rows.map((row) => {
    const value = row as { chunk_id: string; chunk_index: number; text: string };
    const index = Number(value.chunk_index);
    return {
      chunk_id: value.chunk_id,
      chunk_index: index,
      text: value.text,
      reason: index < matchedChunkIndex ? "same_document_before" : "same_document_after"
    };
  });
}
```

Change `recallFromLadybug(...)` from `return rows.map(normalizeRecallRow);` to:

```ts
const primaryRows = rows.map(normalizeRecallRow);

for (const row of primaryRows) {
  row.document_context.same_document_chunks = await loadSameDocumentChunks(
    projectRoot,
    row.document_context.file_id,
    row.matched_chunk.chunk_id,
    row.matched_chunk.chunk_index
  );
}

return primaryRows;
```

- [ ] **Step 4: Run the CLI test and verify GREEN**

Run:

```bash
npm test -- test/cli.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit same-document enrichment**

```bash
git add src/ladybug-store.ts test/cli.test.ts
git commit -m "feat: add same-document recall context"
```

## Task 3: Typed One-Hop Graph Paths

**Files:**
- Modify: `src/ladybug-store.ts`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Write a failing CLI test for relationship paths**

Update the archived metadata used by the CLI test to contain two entities and a relationship:

```ts
entities: [
  { name: "CLI Recall", type: "concept", description: "Primary recall context." },
  { name: "LadybugDB", type: "tool", description: "Graph storage." }
],
relationships: [
  {
    from: "CLI Recall",
    to: "LadybugDB",
    type: "depends_on",
    description: "Recall graph is stored in LadybugDB."
  }
]
```

Then assert:

```ts
expect(recallResult.results[0].graph_context.paths).toEqual(
  expect.arrayContaining([
    {
      from: "CLI Recall",
      relationship: "DEPENDS_ON",
      to: "LadybugDB"
    }
  ])
);
```

- [ ] **Step 2: Run the CLI test and verify RED**

Run:

```bash
npm test -- test/cli.test.ts
```

Expected: FAIL because `graph_context.paths` is currently always `[]`.

- [ ] **Step 3: Implement one-hop typed path loading**

Add a helper in `src/ladybug-store.ts` that keeps the known relationship labels explicit:

```ts
async function loadGraphPaths(projectRoot: string, fileId: string): Promise<LadybugGraphPath[]> {
  const relationshipQueries = [
    ["DEPENDS_ON", "DEPENDS_ON"],
    ["RELATES_TO", "RELATES_TO"],
    ["IMPLEMENTS", "IMPLEMENTS"],
    ["REPLACES", "REPLACES"],
    ["DECIDES", "DECIDES"]
  ] as const;
  const paths: LadybugGraphPath[] = [];

  for (const [edge, label] of relationshipQueries) {
    const rows = await queryLadybugRows(
      projectRoot,
      `
      MATCH (d:Document)-[:MENTIONS]->(from:Concept)-[:${edge}]->(to:Concept)
      WHERE d.file_id = $file_id
      RETURN from.name AS from_name, to.name AS to_name
      LIMIT 5
      `,
      { file_id: fileId }
    );

    for (const row of rows) {
      const value = row as { from_name: string; to_name: string };
      paths.push({ from: value.from_name, relationship: label, to: value.to_name });
    }
  }

  return paths.slice(0, 5);
}
```

Populate each normalized result:

```ts
row.graph_context.paths = await loadGraphPaths(projectRoot, row.document_context.file_id);
```

- [ ] **Step 4: Run the CLI test and verify GREEN**

Run:

```bash
npm test -- test/cli.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit graph paths**

```bash
git add src/ladybug-store.ts test/cli.test.ts
git commit -m "feat: add typed one-hop recall paths"
```

## Task 4: Supporting Chunks From Related Documents

**Files:**
- Modify: `src/ladybug-store.ts`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Write a failing end-to-end CLI test for graph supporting chunks**

Create two archive records and index two documents:

```ts
const primaryRecord = await archiveRecord(projectRoot, {
  source: primaryText,
  document: primaryText,
  metadata: {
    title: "Recall",
    summary: "Recall routes structured graph context.",
    tags: ["recall"],
    entities: [
      { name: "Recall", type: "concept", description: "Recall workflow." },
      { name: "LadybugDB", type: "tool", description: "Graph store." }
    ],
    relationships: [
      { from: "Recall", to: "LadybugDB", type: "depends_on", description: "Storage dependency." }
    ]
  }
});

const supportingRecord = await archiveRecord(projectRoot, {
  source: supportingText,
  document: supportingText,
  metadata: {
    title: "Ladybug Store",
    summary: "LadybugDB stores project graph data.",
    tags: ["ladybug"],
    entities: [
      { name: "LadybugDB", type: "tool", description: "Graph store." }
    ],
    relationships: []
  }
});
```

Index both documents with their `record_id`, recall a query matching the primary document, and assert:

```ts
expect(recallResult.results[0].graph_context.supporting_chunks).toEqual(
  expect.arrayContaining([
    expect.objectContaining({
      path: "ladybug.md",
      title: "Ladybug Store",
      text: expect.stringContaining("LadybugDB stores"),
      reason: "related_concept:LadybugDB"
    })
  ])
);
```

- [ ] **Step 2: Run the CLI test and verify RED**

Run:

```bash
npm test -- test/cli.test.ts
```

Expected: FAIL because `supporting_chunks` is currently always `[]`.

- [ ] **Step 3: Implement supporting chunk loading**

Add a helper in `src/ladybug-store.ts`:

```ts
async function loadSupportingChunks(projectRoot: string, fileId: string, matchedChunkId: string): Promise<LadybugSupportingChunk[]> {
  const rows = await queryLadybugRows(
    projectRoot,
    `
    MATCH (matched:Document)-[:MENTIONS]->(:Concept)-[:DEPENDS_ON|RELATES_TO|IMPLEMENTS|REPLACES|DECIDES]->(related:Concept)
    MATCH (supporting:Document)-[:MENTIONS]->(related)
    MATCH (supporting)-[:HAS_CHUNK]->(chunk:Chunk)
    WHERE matched.file_id = $file_id
      AND chunk.id <> $chunk_id
      AND supporting.file_id <> $file_id
    RETURN
      supporting.file_id AS file_id,
      supporting.path AS path,
      supporting.title AS title,
      chunk.id AS chunk_id,
      chunk.chunk_index AS chunk_index,
      chunk.text AS text,
      related.name AS related_concept
    ORDER BY supporting.path ASC, chunk.chunk_index ASC
    LIMIT 3
    `,
    { file_id: fileId, chunk_id: matchedChunkId }
  );

  return rows.map((row) => {
    const value = row as {
      file_id: string;
      path: string;
      title: string;
      chunk_id: string;
      chunk_index: number;
      text: string;
      related_concept: string;
    };
    return {
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

Populate each result:

```ts
row.graph_context.supporting_chunks = await loadSupportingChunks(
  projectRoot,
  row.document_context.file_id,
  row.matched_chunk.chunk_id
);
```

- [ ] **Step 4: Run the CLI test and verify GREEN**

Run:

```bash
npm test -- test/cli.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit supporting chunks**

```bash
git add src/ladybug-store.ts test/cli.test.ts
git commit -m "feat: add graph supporting chunks to recall"
```

## Task 5: Guarded LadybugDB Coverage And User-Facing Documentation

**Files:**
- Modify: `test/ladybug-store.test.ts`
- Modify: `skills/docnexus-recall/SKILL.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/product-brief-docnexus-mvp.en.md`
- Modify: `docs/product-brief-docnexus-mvp.zh-CN.md`
- Modify: `docs/product-brief-docnexus-mvp.md`

- [ ] **Step 1: Add a guarded integration assertion for enrichment helpers**

Extend the existing LadybugDB integration tests only if the runtime can execute the scenario without the known mmap failure. Populate two metadata-linked document graphs, then assert `recallFromLadybug(...)` returns:

```ts
expect(result[0]).toMatchObject({
  document_context: {
    same_document_chunks: expect.arrayContaining([
      expect.objectContaining({ reason: expect.stringMatching(/^same_document_/) })
    ])
  },
  graph_context: {
    paths: expect.arrayContaining([
      { from: "Recall", relationship: "DEPENDS_ON", to: "LadybugDB" }
    ]),
    supporting_chunks: expect.arrayContaining([
      expect.objectContaining({ reason: "related_concept:LadybugDB" })
    ])
  }
});
```

If this test reproduces the existing LadybugDB mmap instability, keep end-to-end CLI test coverage as the executable acceptance proof and document the optional integration limitation in the delivery summary rather than masking it.

- [ ] **Step 2: Update skill guidance**

In `skills/docnexus-recall/SKILL.md`, explicitly prioritize context:

```markdown
- Treat `matched_chunk` as primary evidence.
- Use `same_document_chunks` to complete the local document meaning.
- Use `graph_context.paths` to explain typed relationships.
- Use `graph_context.supporting_chunks` only as one-hop support; do not treat it as a primary hit.
```

- [ ] **Step 3: Update README and product briefs**

Document that structured recall now fills:

```text
document_context.same_document_chunks
graph_context.paths
graph_context.supporting_chunks
```

State that supporting chunks are one-hop context only and do not alter primary relevance ordering.

- [ ] **Step 4: Run focused tests and docs scan**

Run:

```bash
npm test -- test/recall.test.ts test/cli.test.ts
rg -n "same_document_chunks|supporting_chunks|graph_context.paths|one-hop|一跳|主排序" README.md README.zh-CN.md docs/product-brief-docnexus-mvp*.md skills/docnexus-recall/SKILL.md
```

Expected: focused tests pass and docs mention the populated one-hop fields and relevance-first ordering.

- [ ] **Step 5: Commit coverage and documentation**

```bash
git add test/ladybug-store.test.ts skills/docnexus-recall/SKILL.md README.md README.zh-CN.md docs/product-brief-docnexus-mvp.en.md docs/product-brief-docnexus-mvp.zh-CN.md docs/product-brief-docnexus-mvp.md
git commit -m "docs: describe populated graph recall context"
```

## Task 6: Final Verification

**Files:**
- All changed production, test, skill, and documentation files.

- [ ] **Step 1: Run the full default test suite**

Run:

```bash
npm test
```

Expected: PASS with all default Vitest files green.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 4: Verify diff hygiene and workspace status**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only intended changes, or a clean worktree after the task commits.
