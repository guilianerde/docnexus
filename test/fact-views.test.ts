import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeProject } from "../src/project.js";
import { deleteManagedDocument, getManagedRecord, inspectRecords, listManagedDocuments, refreshFactViews, syncManagedDocument, upsertManagedDocument } from "../src/managed-documents.js";
import { LocalHashEmbedder } from "../src/embedder.js";
import { inspectRetrievalIndex, listIndexedChunks, syncRetrievalIndex } from "../src/retrieval-index.js";
import { searchDocuments } from "../src/search.js";
import { recall } from "../src/recall.js";
import { runCli } from "../src/cli.js";
import { sha256 } from "../src/hash.js";
import type { DocNexusMetadata, MetadataFact } from "../src/types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const roots: string[] = [];
const metadata: DocNexusMetadata = { title: "Policy", summary: "Credential policy", tags: [], entities: [], relationships: [] };
const old: MetadataFact = { id: "fact_rotation_daily", text: "obsolete_fact_marker: tokens rotate daily.", provenance: "Initial user decision", valid_from: "2020-01-01T00:00:00Z" };
const next: MetadataFact = { id: "fact_rotation_hourly", text: "current_fact_marker: tokens rotate hourly.", provenance: "Revised user decision", valid_from: "2020-01-02T00:00:00Z", replaces: old.id };
const ownerInput = { file_path: "policy.md", source: "User confirmed credential policy", document: "# Policy\n\n{{fact:fact_rotation_daily}}\n", metadata: { ...metadata, facts: [old] } };
const usageInput = { file_path: "usage.md", source: "Implementation context", document: "# Implementation\n\n{{fact:fact_rotation_daily}}\n\nUse this policy when issuing credentials.\n", metadata };
const embedder = new LocalHashEmbedder();

async function root() {
  const path = await mkdtemp(join(tmpdir(), "docnexus-fact-views-"));
  roots.push(path);
  await initializeProject(path);
  return path;
}
async function recordText(path: string, id: string, name: string) {
  return readFile(join(path, "docnexus/records", id, name), "utf8");
}
afterEach(async () => {
  vi.useRealTimers();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("fact-backed Markdown views", () => {
  it("stores a readable generated view and exposes the editable reference template", async () => {
    const path = await root();
    const saved = await upsertManagedDocument(path, ownerInput);
    const current = await getManagedRecord(path, saved.id, ["document", "template", "metadata"]);
    expect(current.template).toBe(ownerInput.document);
    expect(current.document).toContain("tokens rotate daily.");
    expect(current.document).toContain("Initial user decision");
    expect(current.fact_references).toEqual([{ reference_id: old.id, fact_id: old.id, status: "active", source_document_id: saved.id }]);
    expect(JSON.parse(await recordText(path, saved.id, "record.json")).document_hash).toBe(sha256(ownerInput.document));
    expect(await readFile(join(path, "docnexus/library/policy.md"), "utf8")).toBe(current.document);
    expect((await inspectRecords(path)).ok).toBe(true);
  });

  it("updates every referencing document in the fact write without changing dependent history", async () => {
    const path = await root();
    const owner = await upsertManagedDocument(path, ownerInput);
    const usage = await upsertManagedDocument(path, usageInput);
    const before = await getManagedRecord(path, usage.id);
    const beforeRecord = await recordText(path, usage.id, "record.json");
    await syncRetrievalIndex(path, {}, embedder);
    await upsertManagedDocument(path, { ...ownerInput, source: "User changed rotation to hourly", metadata: { ...metadata, facts: [old, next] } });
    expect(await readFile(join(path, "docnexus/library/usage.md"), "utf8")).toContain("tokens rotate hourly.");
    const after = await getManagedRecord(path, usage.id, ["document", "source", "metadata", "timeline", "template"]);
    expect(after.document).not.toContain("tokens rotate daily.");
    expect(after.template).toBe(usageInput.document);
    expect(after.source).toBe(before.source);
    expect(after.timeline).toBe(before.timeline);
    expect(after.metadata).toEqual(metadata);
    expect(await recordText(path, usage.id, "record.json")).toBe(beforeRecord);
    expect((await inspectRetrievalIndex(path)).outdated).toEqual(expect.arrayContaining([owner.id, usage.id]));
    const search = await searchDocuments(path, { query: "current_fact_marker", limit: 10 });
    expect(search.results.map((result) => result.id)).toContain(usage.id);
    expect((await searchDocuments(path, { query: "obsolete_fact_marker" })).results).toEqual([]);
    const recalled = await recall(path, { query: "current_fact_marker", limit: 10 }, embedder);
    expect(recalled.context_groups.find((group) => group.group_id === usage.id)!.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: next.id, status: "active", document_id: owner.id, source_path: "policy.md" })
    ]));
    const chunks = (await listIndexedChunks(path, usage.id)).map((chunk) => chunk.text).join("\n");
    expect(chunks).toContain("tokens rotate hourly");
    expect(chunks).not.toContain("tokens rotate daily");
    expect((await getManagedRecord(path, usage.id)).metadata!.facts).toBeUndefined();
  });

  it("refreshes future activation and expiry on access without appending source events", async () => {
    const path = await root();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await upsertManagedDocument(path, { ...ownerInput, metadata: { ...metadata, facts: [old, { ...next, valid_from: "2030-01-01T00:00:00Z", valid_until: "2030-01-02T00:00:00Z" }] } });
    const usage = await upsertManagedDocument(path, usageInput);
    const timeline = await recordText(path, usage.id, "timeline.md");
    expect((await getManagedRecord(path, usage.id)).document).toContain("tokens rotate daily");
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    expect((await getManagedRecord(path, usage.id)).document).toContain("tokens rotate hourly");
    vi.setSystemTime(new Date("2030-01-02T00:00:00Z"));
    const refreshed = JSON.parse(await runCli(["document", "render"], path));
    expect(refreshed.rendered_documents).toBe(2);
    const expired = await getManagedRecord(path, usage.id);
    expect(expired.document).toContain("已到期");
    expect(expired.document).not.toContain("tokens rotate");
    expect(await recordText(path, usage.id, "timeline.md")).toBe(timeline);
    expect((await refreshFactViews(path)).rendered_documents).toBe(0);
  });

  it("removes withdrawn assertions from generated prose immediately", async () => {
    const path = await root();
    const saved = await upsertManagedDocument(path, ownerInput);
    await upsertManagedDocument(path, { ...ownerInput, metadata: { ...metadata, facts: [{ ...old, withdrawn_at: "2020-01-02T00:00:00Z", withdrawal_reason: "Incorrect source" }] } });
    const current = await getManagedRecord(path, saved.id);
    expect(current.document).toContain("已撤回");
    expect(current.document).not.toContain("tokens rotate daily");
  });

  it("repairs edits inside generated blocks but protects and adopts author-owned edits", async () => {
    const path = await root();
    const saved = await upsertManagedDocument(path, ownerInput);
    const before = await getManagedRecord(path, saved.id);
    const file = join(path, "docnexus/library/policy.md");
    await writeFile(file, before.document!.replace("tokens rotate daily", "tokens never rotate"));
    expect((await inspectRecords(path)).ok).toBe(true);
    expect((await getManagedRecord(path, saved.id)).document).toBe(before.document);
    expect((await getManagedRecord(path, saved.id)).timeline).toBe(before.timeline);
    await writeFile(file, before.document!.replace("# Policy", "# Reviewed explanation"));
    await expect(refreshFactViews(path)).rejects.toThrow("externally modified");
    await expect(getManagedRecord(path, saved.id)).rejects.toThrow("document sync");
    await syncManagedDocument(path, { id: saved.id });
    expect((await getManagedRecord(path, saved.id)).document).toContain("# Reviewed explanation");
  });

  it("rejects missing fact references and deletion that would leave references unresolved", async () => {
    const path = await root();
    await expect(upsertManagedDocument(path, usageInput)).rejects.toThrow("unknown fact reference");
    expect(await listManagedDocuments(path)).toEqual([]);
    const owner = await upsertManagedDocument(path, ownerInput);
    await upsertManagedDocument(path, usageInput);
    await expect(deleteManagedDocument(path, { id: owner.id, confirm: true })).rejects.toThrow("unknown fact reference");
    expect((await getManagedRecord(path, owner.id)).metadata!.facts).toEqual([old]);
  });

  it("rolls back a fact write and all dependent views when a later replacement fails", async () => {
    const path = await root();
    const owner = await upsertManagedDocument(path, ownerInput);
    const usage = await upsertManagedDocument(path, usageInput);
    const beforeOwner = await getManagedRecord(path, owner.id);
    const beforeUsage = await getManagedRecord(path, usage.id);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let failed = false;
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (!failed && String(to).split(sep).join("/").endsWith("library/usage.md")) { failed = true; throw new Error("dependent view write failed"); }
      return actual.rename(from, to);
    });
    await expect(upsertManagedDocument(path, { ...ownerInput, metadata: { ...metadata, facts: [old, next] } })).rejects.toThrow("dependent view write failed");
    expect(failed).toBe(true);
    expect(await getManagedRecord(path, owner.id)).toEqual(beforeOwner);
    expect(await getManagedRecord(path, usage.id)).toEqual(beforeUsage);
    expect((await inspectRecords(path)).ok).toBe(true);
  });

  it("preserves unadopted explanatory edits when a fact update would refresh that page", async () => {
    const path = await root();
    const owner = await upsertManagedDocument(path, ownerInput);
    const usage = await upsertManagedDocument(path, usageInput);
    const file = join(path, "docnexus/library/usage.md");
    const edited = (await readFile(file, "utf8")).replace("# Implementation", "# User-authored explanation");
    await writeFile(file, edited);
    const update = { ...ownerInput, metadata: { ...metadata, facts: [old, next] } };
    await expect(upsertManagedDocument(path, update)).rejects.toThrow("externally modified");
    expect((await getManagedRecord(path, owner.id)).metadata!.facts).toEqual([old]);
    expect(await readFile(file, "utf8")).toBe(edited);
    await syncManagedDocument(path, { id: usage.id });
    await upsertManagedDocument(path, update);
    const current = await readFile(file, "utf8");
    expect(current).toContain("# User-authored explanation");
    expect(current).toContain("tokens rotate hourly");
  });

  it("produces a sealed preview and refuses fact changes until the new preview is reviewed", async () => {
    const path = await root();
    await upsertManagedDocument(path, ownerInput);
    const draft = JSON.parse(await runCli(["draft", "new"], path));
    for (const [name, value] of [["source", usageInput.source], ["document", usageInput.document], ["metadata", JSON.stringify(metadata)]] as const) await writeFile(join(path, draft.artifacts[name]), value);
    const sealed = JSON.parse(await runCli(["draft", "seal", "--id", draft.draft_id, "--file", "usage.md"], path));
    expect(await readFile(join(path, sealed.preview_file), "utf8")).toContain("tokens rotate daily");
    await upsertManagedDocument(path, { ...ownerInput, metadata: { ...metadata, facts: [old, next] } });
    await expect(runCli(["document", "add", "--draft", draft.draft_id], path)).rejects.toThrow("referenced facts changed after preview");
    await expect(stat(join(path, "docnexus/library/usage.md"))).rejects.toThrow();
    await runCli(["draft", "seal", "--id", draft.draft_id, "--file", "usage.md"], path);
    expect(await readFile(join(path, sealed.preview_file), "utf8")).toContain("tokens rotate hourly");
    const ingested = JSON.parse(await runCli(["document", "add", "--draft", draft.draft_id], path));
    const current = JSON.parse(await runCli(["document", "get", "--id", ingested.id, "--include", "template,document"], path));
    expect(current.template).toBe(usageInput.document);
    expect(current.document).toContain("tokens rotate hourly");
  });

  it("rejects preview tampering before ingesting a fact-backed draft", async () => {
    const path = await root();
    const draft = JSON.parse(await runCli(["draft", "new"], path));
    for (const [name, value] of [["source", ownerInput.source], ["document", ownerInput.document], ["metadata", JSON.stringify(ownerInput.metadata)]] as const) await writeFile(join(path, draft.artifacts[name]), value);
    const sealed = JSON.parse(await runCli(["draft", "seal", "--id", draft.draft_id, "--file", "policy.md"], path));
    await writeFile(join(path, sealed.preview_file), "Tampered review preview");
    await expect(runCli(["document", "add", "--draft", draft.draft_id], path)).rejects.toThrow("preview changed");
    const manifestFile = join(path, sealed.manifest_file);
    const legacyManifest = JSON.parse(await readFile(manifestFile, "utf8"));
    delete legacyManifest.rendered_hash;
    await writeFile(manifestFile, JSON.stringify(legacyManifest));
    await expect(runCli(["document", "add", "--draft", draft.draft_id], path)).rejects.toThrow("requires a sealed preview");
    expect(await listManagedDocuments(path)).toEqual([]);
  });
});
