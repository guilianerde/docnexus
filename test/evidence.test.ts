import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initializeProject } from "../src/project.js";
import { upsertManagedDocument } from "../src/managed-documents.js";
import { loadWorkspaceSnapshot } from "../src/workspace-snapshot.js";
import { assembleEvidence } from "../src/evidence.js";
import { buildGroupedRecall } from "../src/recall-groups.js";
import { recallEvidence } from "../src/recall-evidence.js";
import { LocalHashEmbedder } from "../src/embedder.js";
import { runCli } from "../src/cli.js";

const roots: string[] = [];
const metadata = { title: "Evidence", summary: "Project conventions", tags: [], entities: [], relationships: [] };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup(document: string, fields = {}) {
  const root = await mkdtemp(join(tmpdir(), "docnexus-evidence-")); roots.push(root);
  await initializeProject(root);
  const saved = await upsertManagedDocument(root, { file_path: "notes.md", source: "Source", document, metadata: { ...metadata, ...fields } });
  const snapshot = await loadWorkspaceSnapshot(root);
  return { root, id: saved.id, snapshot };
}
function grouped(id: string, text: string, neighbors: string[] = []) {
  return buildGroupedRecall([{ document: { document_id: id, path: "notes.md", title: "Evidence", summary: "Conventions" },
    matched_chunk: { chunk_id: "anchor", chunk_index: 1, text, score: 0.9 }, concepts: [], related_concepts: [],
    same_document_chunks: neighbors.map((text, index) => ({ chunk_id: `neighbor-${index}`, chunk_index: index, text })) }], [], []);
}

it("merges overlapping windows without duplicating source text", async () => {
  const body = "# Guide\n\nFirst paragraph.\n\nShared paragraph.\n\nLast paragraph.";
  const { id, snapshot } = await setup(body);
  const packet = assembleEvidence(snapshot, "Shared", grouped(id, "First paragraph.\n\nShared paragraph.", ["Shared paragraph.\n\nLast paragraph."]));
  expect(packet.evidence[0].text).toBe("First paragraph.\n\nShared paragraph.\n\nLast paragraph.");
  expect(packet.evidence[0]).toMatchObject({ unit: "window", observed_at: null, record_version: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(packet.as_of).toBe(snapshot.at);
});

it("returns the enclosing section while ignoring headings inside code fences", async () => {
  const body = "# Guide\n\n## Earlier\nOther text.\n\n## Target\nNeedle details.\n```md\n## Fake boundary\n```\nStill relevant.\n\n## Later\nUnrelated.";
  const { id, snapshot } = await setup(body);
  const packet = assembleEvidence(snapshot, "Needle", grouped(id, "Needle details."), { return_unit: "section" });
  expect(packet.evidence[0].text).toContain("Still relevant.");
  expect(packet.evidence[0].text).not.toContain("Unrelated.");
  expect(packet.evidence[0].unit).toBe("section");
});

it("caps the complete JSON estimate and retains a late match across Unicode truncation", async () => {
  const body = `# Guide\n\n${"背景文字😀 ".repeat(800)}\n\nLATE_NEEDLE important conclusion.\n\n${"后续 ".repeat(100)}`;
  const { id, snapshot } = await setup(body);
  for (const budget of [1200, 1600, 2200, 4000]) {
    const packet = assembleEvidence(snapshot, "LATE_NEEDLE", grouped(id, "LATE_NEEDLE important conclusion."), { return_unit: "page", context_budget: budget });
    expect(packet.delivery.estimated_tokens).toBe(Buffer.byteLength(JSON.stringify(packet, null, 2) + "\n"));
    expect(packet.delivery.estimated_tokens).toBeLessThanOrEqual(budget);
    expect(packet.evidence[0].text).toContain("LATE_NEEDLE");
    expect(packet.evidence[0].text.isWellFormed()).toBe(true);
    expect(packet.delivery.truncated).toBe(true);
  }
});

it("keeps attributed facts atomic, marks inactive claims, and never substitutes save time for observation time", async () => {
  const { id, snapshot } = await setup("# Facts\n\n{{fact:fact_current}}\n\n{{fact:fact_expired}}", { observed_at: "2020-02-03T00:00:00Z", facts: [
    { id: "fact_current", text: "Current assertion", provenance: "Dated source", valid_from: "2020-01-01T00:00:00Z" },
    { id: "fact_expired", text: "OBSOLETE_ASSERTION", provenance: "Older source", valid_from: "2020-01-01T00:00:00Z", valid_until: "2020-01-02T00:00:00Z" }
  ] });
  const packet = assembleEvidence(snapshot, "Facts", grouped(id, "# Facts"), { return_unit: "page", context_budget: 8000 });
  expect(packet.evidence[0].observed_at).toBe("2020-02-03T00:00:00Z");
  expect(packet.evidence.filter(block => block.kind === "fact").every(block => block.observed_at === null)).toBe(true);
  expect(packet.evidence).toContainEqual(expect.objectContaining({ kind: "fact", text: "Current assertion", fact: expect.objectContaining({ id: "fact_current", status: "active", provenance: "Dated source" }) }));
  expect(packet.evidence).toContainEqual(expect.objectContaining({ kind: "fact", fact: expect.objectContaining({ id: "fact_expired", status: "expired" }) }));
  expect(JSON.stringify(packet)).not.toContain("OBSOLETE_ASSERTION");
  const small = assembleEvidence(snapshot, "Facts", grouped(id, "# Facts"), { context_budget: 1200 });
  expect(small.delivery.omitted_blocks).toBeGreaterThan(0);
  expect(small.evidence.every(block => block.kind !== "fact" || (!block.truncated && Boolean(block.fact?.provenance)))).toBe(true);
});

it("delivers a versioned packet through the real retrieval and CLI paths without duplicate raw contexts", async () => {
  const { root, snapshot } = await setup("# Guide\n\nUNIQUE_RULE must be followed.");
  const packet = await recallEvidence(root, { query: "UNIQUE_RULE", context_budget: 4000, return_unit: "section" }, new LocalHashEmbedder());
  expect(packet.snapshot_revision).toBe(snapshot.revision);
  expect(packet.evidence[0].text).toContain("UNIQUE_RULE");
  const cli = JSON.parse(await runCli(["recall", "UNIQUE_RULE", "--context-budget", "4000", "--return-unit", "page"], root));
  expect(cli.delivery.estimated_tokens).toBeLessThanOrEqual(4000);
  expect(cli).not.toHaveProperty("context_groups");
  expect(cli).not.toHaveProperty("results");
  await expect(runCli(["search", "UNIQUE_RULE", "--context-budget", "4000"], root)).rejects.toMatchObject({ code: "invalid_params" });
});

it("refuses invalid budgets and units before loading a model or workspace", async () => {
  await expect(recallEvidence("/missing", { query: "x", context_budget: 0 })).rejects.toMatchObject({ code: "invalid_params" });
  await expect(recallEvidence("/missing", { query: "x", return_unit: "invalid" as "page" })).rejects.toMatchObject({ code: "invalid_params" });
});
