import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initializeProject } from "../src/project.js";
import { upsertManagedDocument } from "../src/managed-documents.js";
import { loadWorkspaceSnapshot } from "../src/workspace-snapshot.js";
import { documentAnchor } from "../src/source-anchor.js";
import { assembleEvidence } from "../src/evidence.js";
import { buildGroupedRecall, type RecallPrimaryMatch } from "../src/recall-groups.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup(bodies: string[]) {
  const root = await mkdtemp(join(tmpdir(), "docnexus-evidence-plan-")); roots.push(root); await initializeProject(root);
  const saved = [];
  for (const [index, document] of bodies.entries()) saved.push(await upsertManagedDocument(root, { file_path: `${index}.md`, source: "Decision", document,
    metadata: { title: `Guide ${index}`, summary: "Conventions", tags: [], entities: [], relationships: [] } }));
  return { snapshot: await loadWorkspaceSnapshot(root), saved };
}

it.each(["window", "section", "page"] as const)("reserves later answer evidence before expanding an earlier long %s", async unit => {
  const { snapshot, saved } = await setup(["# Long guide\n\nFIRST_HIT.\n\n" + "Background detail. ".repeat(600), "# Answer\n\nSECOND_HIT contains the actual answer."]);
  const rows: RecallPrimaryMatch[] = saved.map((record, index) => {
    const view = snapshot.sourceDocument(record.id), text = index === 0 ? "FIRST_HIT." : "SECOND_HIT contains the actual answer.";
    const start = view.rendered.indexOf(text);
    return { document: { document_id: record.id, path: record.file_path, title: "Guide", summary: "Conventions" },
      matched_chunk: { chunk_id: record.id, chunk_index: 0, text, score: 1, source_anchor: documentAnchor(snapshot, record.id, start, start + text.length) },
      same_document_chunks: index === 0 ? [{ chunk_id: "long", chunk_index: 1, text: view.rendered, source_anchor: documentAnchor(snapshot, record.id, 0, view.rendered.length) }] : [], concepts: [], related_concepts: [] };
  });
  const packet = assembleEvidence(snapshot, "answer", buildGroupedRecall(rows, [], []), { return_unit: unit, context_budget: 4000 });
  expect(packet.evidence.some(block => block.document_id === saved[0].id && block.text.includes("FIRST_HIT."))).toBe(true);
  expect(packet.evidence.some(block => block.document_id === saved[1].id && block.text.includes("SECOND_HIT contains the actual answer."))).toBe(true);
  expect(packet.delivery.estimated_tokens).toBe(Buffer.byteLength(JSON.stringify(packet, null, 2) + "\n"));
  expect(packet.delivery.estimated_tokens).toBeLessThanOrEqual(4000);
});

it("keeps two distant primary hits when a page cannot fit and preserves omission accounting", async () => {
  const { snapshot, saved } = await setup(["# Guide\n\nFIRST_ASSERTION.\n\n" + "背景文字😀 ".repeat(1000) + "\n\nLAST_ASSERTION."]);
  const view = snapshot.sourceDocument(saved[0].id);
  const rows = ["FIRST_ASSERTION.", "LAST_ASSERTION."].map((text, index): RecallPrimaryMatch => {
    const start = view.rendered.indexOf(text);
    return { document: { document_id: saved[0].id, path: saved[0].file_path, title: "Guide", summary: "Conventions" },
      matched_chunk: { chunk_id: String(index), chunk_index: index, text, score: 1, source_anchor: documentAnchor(snapshot, saved[0].id, start, start + text.length) },
      same_document_chunks: [], concepts: [], related_concepts: [] };
  });
  const packet = assembleEvidence(snapshot, "assertions", buildGroupedRecall(rows, [], []), { return_unit: "page", context_budget: 1200 });
  expect(packet.evidence[0].text).toContain("FIRST_ASSERTION.");
  expect(packet.evidence[0].text).toContain("LAST_ASSERTION.");
  expect(packet.evidence[0].text.isWellFormed()).toBe(true);
  expect(packet.delivery).toMatchObject({ truncated: true, omitted_blocks: 0 });
  expect(packet.delivery.estimated_tokens).toBeLessThanOrEqual(1200);
});

it("does not let a metadata-only fallback page crowd out the primary section's conclusion", async () => {
  const { snapshot, saved } = await setup(["# Primary\n\nPRIMARY_MATCH.\n\n" + "Context detail. ".repeat(60) + "\n\nANSWER_END.", "# Secondary\n\n" + "Background. ".repeat(1000)]);
  const view = snapshot.sourceDocument(saved[0].id), start = view.rendered.indexOf("PRIMARY_MATCH.");
  const rows: RecallPrimaryMatch[] = saved.map((record, index) => ({
    document: { document_id: record.id, path: record.file_path, title: `Guide ${index}`, summary: "Conventions" },
    matched_chunk: { chunk_id: record.id, chunk_index: 0, score: 1, text: index === 0 ? "PRIMARY_MATCH." : "Guide 1",
      source_anchor: index === 0 ? documentAnchor(snapshot, record.id, start, start + 14) : {
        kind: "metadata", document_id: record.id, record_version: snapshot.recordVersion(record.id), field: "title", value: "Guide 1" } },
    same_document_chunks: [], concepts: [], related_concepts: []
  }));
  const packet = assembleEvidence(snapshot, "primary", buildGroupedRecall(rows, [], []), { return_unit: "section", context_budget: 4000 });
  expect(packet.evidence.find(block => block.document_id === saved[0].id)!.text).toContain("ANSWER_END.");
  expect(packet.evidence.some(block => block.document_id === saved[1].id)).toBe(true);
  expect(packet.delivery.estimated_tokens).toBeLessThanOrEqual(4000);
});

it("completes smaller later sections before spending the remaining space on a larger section", async () => {
  const { snapshot, saved } = await setup(["# Big\n\nFIRST_HIT.\n\n" + "Background. ".repeat(170),
    "# Smaller\n\nSECOND_HIT.\n\n" + "Supporting detail. ".repeat(35) + "\n\nSECOND_CONCLUSION.",
    "# Third\n\nTHIRD_HIT.\n\n" + "Other detail. ".repeat(35) + "\n\nTHIRD_CONCLUSION."]);
  const rows: RecallPrimaryMatch[] = saved.map((record, index) => {
    const text = ["FIRST_HIT.", "SECOND_HIT.", "THIRD_HIT."][index], start = snapshot.sourceDocument(record.id).rendered.indexOf(text);
    return { document: { document_id: record.id, path: record.file_path, title: "Guide", summary: "Conventions" },
      matched_chunk: { chunk_id: record.id, chunk_index: 0, text, score: 1, source_anchor: documentAnchor(snapshot, record.id, start, start + text.length) },
      same_document_chunks: [], concepts: [], related_concepts: [] };
  });
  const packet = assembleEvidence(snapshot, "conclusion", buildGroupedRecall(rows, [], []), { return_unit: "section", context_budget: 4000 });
  const later = packet.evidence.find(block => block.document_id === saved[1].id)!;
  expect(later.text).toContain("SECOND_CONCLUSION.");
  expect(later.truncated).toBe(false);
  const third = packet.evidence.find(block => block.document_id === saved[2].id)!;
  expect(third.text).toContain("THIRD_CONCLUSION.");
  expect(third.truncated).toBe(false);
  expect(packet.delivery.estimated_tokens).toBeLessThanOrEqual(4000);
});
