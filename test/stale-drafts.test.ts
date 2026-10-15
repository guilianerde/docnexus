import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { createDraft, sealDraft } from "../src/drafts.js";
import { classifyManagedDocument, deleteManagedDocument, getManagedRecord, listRecordFiles, upsertManagedDocument } from "../src/managed-documents.js";

const roots: string[] = [];
const input = { file_path: "query.md", source: "Initial decision", document: "# Query\n\nOriginal knowledge.", metadata: { title: "Query", summary: "Query contract", tags: [], entities: [], relationships: [], category: "接口契约" } };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "docnexus-stale-draft-")); roots.push(root);
  await runCli(["init"], root);
  return root;
}
async function draft(root: string) {
  const record = (await listRecordFiles(root)).find(record => record.file_path === input.file_path);
  const version = record ? (await getManagedRecord(root, record.id)).record_version : null;
  const draft = await createDraft(root);
  await writeFile(join(root, draft.artifacts.source), "Add pagination");
  await writeFile(join(root, draft.artifacts.document), `${input.document}\n\nPagination details.`);
  await writeFile(join(root, draft.artifacts.metadata), JSON.stringify(input.metadata));
  await sealDraft(root, { draftId: draft.draft_id, filePath: input.file_path, baseRecordHash: version });
  return draft;
}
async function ingest(root: string, id: string) {
  return runCli(["document", "add", "--draft", id, "--replace"], root);
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("sealed draft target versions", () => {
  it("rejects changes between extraction and sealing and requires the extraction version", async () => {
    const root = await setup();
    const saved = await upsertManagedDocument(root, input);
    const read = await getManagedRecord(root, saved.id);
    const staged = await createDraft(root);
    await writeFile(join(root, staged.artifacts.source), "Draft from the old read");
    await writeFile(join(root, staged.artifacts.document), `${read.document}\n\nDraft addition.`);
    await writeFile(join(root, staged.artifacts.metadata), JSON.stringify(read.metadata));
    await upsertManagedDocument(root, { ...input, document: "New knowledge to preserve" });
    await expect(sealDraft(root, { draftId: staged.draft_id, filePath: input.file_path, baseRecordHash: read.record_version })).rejects.toThrow("target changed since reading");
    await expect(sealDraft(root, { draftId: staged.draft_id, filePath: input.file_path })).rejects.toThrow("requires --base-version");
    expect((await getManagedRecord(root, saved.id)).document).toBe("New knowledge to preserve");
    const latest = await getManagedRecord(root, saved.id);
    await writeFile(join(root, staged.artifacts.document), `${latest.document}\n\nDraft addition.`);
    await sealDraft(root, { draftId: staged.draft_id, filePath: input.file_path, baseRecordHash: latest.record_version });
    await ingest(root, staged.draft_id);
    expect((await getManagedRecord(root, saved.id)).document).toContain("New knowledge to preserve");
  });

  it("refuses a path occupied after an explicit new-path read", async () => {
    const root = await setup();
    const staged = await draft(root);
    await upsertManagedDocument(root, input);
    await expect(sealDraft(root, { draftId: staged.draft_id, filePath: input.file_path, baseRecordHash: null })).rejects.toThrow("target changed since reading");
  });

  it("refuses to overwrite newer prose, then allows a reviewed merge and reseal", async () => {
    const root = await setup();
    const saved = await upsertManagedDocument(root, input);
    const staged = await draft(root);
    await upsertManagedDocument(root, { ...input, source: "New decision", document: `${input.document}\n\nKeep error messages visible.` });
    const before = await getManagedRecord(root, saved.id);
    await expect(ingest(root, staged.draft_id)).rejects.toThrow("target changed since sealing");
    expect(await getManagedRecord(root, saved.id)).toEqual(before);
    expect(JSON.parse(await readFile(join(root, staged.draft_directory, "manifest.json"), "utf8")).status).toBe("ready");
    await writeFile(join(root, staged.artifacts.document), `${before.document}\n\nPagination details.`);
    await sealDraft(root, { draftId: staged.draft_id, filePath: input.file_path, baseRecordHash: before.record_version });
    await ingest(root, staged.draft_id);
    const after = await getManagedRecord(root, saved.id);
    expect(after.document).toContain("Keep error messages visible.");
    expect(after.document).toContain("Pagination details.");
  });

  it.each(["classification", "source"])("preserves a newer %s update", async (kind) => {
    const root = await setup();
    const saved = await upsertManagedDocument(root, input);
    const staged = await draft(root);
    if (kind === "classification") await classifyManagedDocument(root, { id: saved.id, category: "文档展示", reason: "User corrected the grouping" });
    else await upsertManagedDocument(root, { ...input, source: "Additional evidence with unchanged prose" });
    const before = await getManagedRecord(root, saved.id);
    await expect(ingest(root, staged.draft_id)).rejects.toThrow("target changed since sealing");
    expect(await getManagedRecord(root, saved.id)).toEqual(before);
  });

  it("refuses a newly occupied path and a deleted/recreated target", async () => {
    const root = await setup();
    const newDraft = await draft(root);
    const saved = await upsertManagedDocument(root, input);
    await expect(ingest(root, newDraft.draft_id)).rejects.toThrow("target changed since sealing");
    const update = await draft(root);
    await deleteManagedDocument(root, { id: saved.id, confirm: true });
    await expect(ingest(root, update.draft_id)).rejects.toThrow("target changed since sealing");
    const recreated = await upsertManagedDocument(root, input);
    expect(recreated.id).not.toBe(saved.id);
    await expect(ingest(root, update.draft_id)).rejects.toThrow("target changed since sealing");
  });

  it("allows unrelated writes and no-op classifications without invalidating the target", async () => {
    const root = await setup();
    const saved = await upsertManagedDocument(root, input);
    await classifyManagedDocument(root, { id: saved.id, category: "接口契约", reason: "Query contract" });
    const staged = await draft(root);
    await upsertManagedDocument(root, { ...input, file_path: "unrelated.md" });
    await classifyManagedDocument(root, { id: saved.id, category: "接口契约", reason: "Query contract" });
    await ingest(root, staged.draft_id);
    expect((await getManagedRecord(root, saved.id)).document).toContain("Pagination details.");
  });

  it("requires old or missing version guards to be resealed", async () => {
    const root = await setup();
    const staged = await draft(root);
    const path = join(root, staged.draft_directory, "manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...manifest, schema_version: 1 }));
    await expect(ingest(root, staged.draft_id)).rejects.toThrow("seal it again");
    delete manifest.base_record_hash;
    await writeFile(path, JSON.stringify(manifest));
    await expect(ingest(root, staged.draft_id)).rejects.toThrow("seal it again");
  });
});
