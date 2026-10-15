import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initializeProject } from "../src/project.js";
import { getManagedRecord, upsertManagedDocument } from "../src/managed-documents.js";
import { chunkText } from "../src/chunker.js";
import { documentAnchor, validateSourceAnchor } from "../src/source-anchor.js";
import { loadWorkspaceSnapshot } from "../src/workspace-snapshot.js";
import { buildGroupedRecall } from "../src/recall-groups.js";
import { assembleEvidence } from "../src/evidence.js";
import { recall } from "../src/recall.js";
import { recallEvidence } from "../src/recall-evidence.js";
import { listIndexedChunks, syncRetrievalIndex } from "../src/retrieval-index.js";
import { LocalHashEmbedder } from "../src/embedder.js";

const roots: string[] = [];
const metadata = { title: "Guide", summary: "Project conventions", tags: [], entities: [], relationships: [] };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const root = await mkdtemp(join(tmpdir(), "docnexus-source-anchor-")); roots.push(root); await initializeProject(root); return root; }

it("maps Unicode/CRLF chunk offsets and generated facts back to the authored template", async () => {
  const path = await root();
  const saved = await upsertManagedDocument(path, { file_path: "guide.md", source: "Decision", document: "\r\n# Guide 🧠\r\n\r\nBefore.\r\n\r\n  {{fact:fact_span}}\r\n\r\nAfter 🧠.\r\n", metadata: { ...metadata,
    facts: [{ id: "fact_span", text: "Current rule.", provenance: "Owner", valid_from: "2000-01-01T00:00:00Z" }] } });
  const snapshot = await loadWorkspaceSnapshot(path), view = snapshot.sourceDocument(saved.id);
  const anchors = chunkText(view.rendered, { targetSize: 90 }).map(chunk => {
    expect(chunk.text.endsWith(view.rendered.slice(chunk.source_start, chunk.source_end))).toBe(true);
    const anchor = documentAnchor(snapshot, saved.id, chunk.source_start, chunk.source_end);
    expect(() => validateSourceAnchor(snapshot, anchor)).not.toThrow();
    return anchor;
  });
  expect(anchors.some(anchor => anchor.kind === "document" && anchor.fact_ids.includes("fact_span"))).toBe(true);
  expect(view.template).toContain("{{fact:fact_span}}");
  expect(view.template).not.toContain("Current rule.");
  expect(() => validateSourceAnchor(snapshot, { ...anchors[0], record_version: "0".repeat(64) })).toThrow("stale or invalid");
  const emoji = view.rendered.indexOf("🧠"), unicode = documentAnchor(snapshot, saved.id, emoji, emoji + 2);
  expect(unicode.kind).toBe("document");
  if (unicode.kind === "document") expect(() => validateSourceAnchor(snapshot, { ...unicode, start: unicode.start + 1 })).toThrow("stale or invalid");
});

it("locates the second identical paragraph from its anchor rather than the first text match", async () => {
  const path = await root();
  const saved = await upsertManagedDocument(path, { file_path: "guide.md", source: "Decision", document: "# Guide\n\n## Earlier\nRepeated assertion.\n\n## Target\nRepeated assertion.", metadata });
  const snapshot = await loadWorkspaceSnapshot(path), view = snapshot.sourceDocument(saved.id);
  const start = view.rendered.lastIndexOf("Repeated assertion.");
  const grouped = buildGroupedRecall([{ document: { document_id: saved.id, path: "guide.md", title: "Guide", summary: metadata.summary },
    matched_chunk: { chunk_id: "second", chunk_index: 1, text: "Repeated assertion.", score: 1, source_anchor: documentAnchor(snapshot, saved.id, start, start + 19) },
    concepts: [], related_concepts: [], same_document_chunks: [] }], [], []);
  const packet = assembleEvidence(snapshot, "assertion", grouped, { return_unit: "section" });
  expect(packet.evidence[0].text).toContain("## Target");
  expect(packet.evidence[0].text).not.toContain("## Earlier");
  grouped.context_groups[0].matches![0].anchor.record_version = "0".repeat(64);
  expect(() => assembleEvidence(snapshot, "assertion", grouped)).toThrow("stale or invalid");
});

it("retains a keyword-matched withdrawal even when the vector representative is unrelated prose", async () => {
  const path = await root();
  const saved = await upsertManagedDocument(path, { file_path: "registry.md", source: "Decision", document: `# Registry\n\nVector favorite. ${"Ordinary background. ".repeat(200)}\n\n{{fact:fact_anchor_withdrawn}}`, metadata: { ...metadata,
    facts: [{ id: "fact_anchor_withdrawn", text: "OBSOLETE_ASSERTION", provenance: "Owner decision", valid_from: "2000-01-01T00:00:00Z", withdrawn_at: "2001-01-01T00:00:00Z", withdrawal_reason: "Withdrawn" }] } });
  const model = { dimension: 512, embed: async (text: string) => text === "fact_anchor_withdrawn" || text.includes("Vector favorite.") ? [1, 0, ...Array(510).fill(0)] : [0, 1, ...Array(510).fill(0)] };
  const recalled = await recall(path, { query: "fact_anchor_withdrawn", limit: 1 }, model);
  const group = recalled.context_groups.find(group => group.document.document_id === saved.id)!;
  expect(group.matches!.map(match => match.source)).toEqual(["vector", "keyword"]);
  expect(group.matches![0].anchor).toMatchObject({ kind: "document", fact_ids: [] });
  expect(group.matches![1].anchor).toMatchObject({ kind: "document", fact_ids: ["fact_anchor_withdrawn"] });
  const packet = await recallEvidence(path, { query: "fact_anchor_withdrawn", limit: 1, context_budget: 1200 }, model);
  expect(packet.evidence[0]).toMatchObject({ kind: "fact", fact: { id: "fact_anchor_withdrawn", status: "withdrawn" }, truncated: false });
  expect(JSON.stringify(packet)).not.toContain("OBSOLETE_ASSERTION");
});

it("refreshes cross-document fact owner versions on source-only updates while reusing vectors", async () => {
  const path = await root();
  const input = { file_path: "owner.md", source: "Original source", document: "{{fact:fact_anchor_owner}}", metadata: { ...metadata,
    facts: [{ id: "fact_anchor_owner", text: "Shared rule.", provenance: "Decision", valid_from: "2000-01-01T00:00:00Z" }] } };
  const owner = await upsertManagedDocument(path, input);
  const reader = await upsertManagedDocument(path, { file_path: "reader.md", source: "Context", document: "{{fact:fact_anchor_owner}}", metadata });
  const embedder = new LocalHashEmbedder();
  await syncRetrievalIndex(path, {}, embedder);
  const before = await listIndexedChunks(path, reader.id);
  await upsertManagedDocument(path, { ...input, source: "New source, unchanged assertion" });
  expect(await syncRetrievalIndex(path, {}, embedder)).toMatchObject({ processed_documents: 2, embedded_chunks: 0 });
  const snapshot = await loadWorkspaceSnapshot(path), after = await listIndexedChunks(path, reader.id);
  expect(after.map(chunk => chunk.embedding)).toEqual(before.map(chunk => chunk.embedding));
  for (const chunk of after) validateSourceAnchor(snapshot, chunk.source_anchor!);
  expect(after.find(chunk => chunk.source_anchor?.kind === "fact")!.source_anchor).toMatchObject({ document_id: owner.id, record_version: (await getManagedRecord(path, owner.id)).record_version });
});

it("retains current primary facts before expanding a long prose section", async () => {
  const path = await root();
  const saved = await upsertManagedDocument(path, { file_path: "guide.md", source: "Decision", document: "# Guide\n\nANCHOR.\n\n" + "Background detail. ".repeat(500) + "\n\n{{fact:fact_context}}", metadata: { ...metadata,
    facts: [{ id: "fact_context", text: "CURRENT_CONTEXT_RULE", provenance: "Owner decision", valid_from: "2000-01-01T00:00:00Z" }] } });
  const snapshot = await loadWorkspaceSnapshot(path), start = snapshot.sourceDocument(saved.id).rendered.indexOf("ANCHOR.");
  const grouped = buildGroupedRecall([{ document: { document_id: saved.id, path: "guide.md", title: "Guide", summary: metadata.summary },
    matched_chunk: { chunk_id: "anchor", chunk_index: 0, text: "ANCHOR.", score: 1, source_anchor: documentAnchor(snapshot, saved.id, start, start + 7) },
    concepts: [], related_concepts: [], same_document_chunks: [] }], [], []);
  const packet = assembleEvidence(snapshot, "context", grouped, { return_unit: "section", context_budget: 4000 });
  expect(packet.evidence).toContainEqual(expect.objectContaining({ kind: "fact", text: "CURRENT_CONTEXT_RULE", truncated: false, fact: expect.objectContaining({ status: "active" }) }));
  expect(packet.evidence[0].text).toContain("ANCHOR.");
  expect(packet.delivery.estimated_tokens).toBeLessThanOrEqual(4000);
});
