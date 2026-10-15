import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { createDraft, sealDraft } from "../src/drafts.js";
import { classifyManagedDocument, getManagedRecord, upsertManagedDocument } from "../src/managed-documents.js";
import { queryDocuments } from "../src/document-query.js";
import { sha256 } from "../src/hash.js";

const roots: string[] = [];
const metadata = { title: "Code review", summary: "Review findings", category: "note", category_reason: "Previous model classification", tags: ["review"], entities: [], relationships: [],
  facts: [{ id: "fact_review", text: "Changes require review.", provenance: "Project owner", valid_from: "2020-01-01T00:00:00Z" }] };
const document = "# Code review\n\n{{fact:fact_review}}";
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "docnexus-explicit-category-")); roots.push(root);
  await runCli(["init"], root);
  const draft = await createDraft(root);
  await writeFile(join(root, draft.artifacts.source), "Code-review skill output");
  await writeFile(join(root, draft.artifacts.document), document);
  await writeFile(join(root, draft.artifacts.metadata), JSON.stringify(metadata));
  return { root, draft };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("seals and ingests the caller's exact category with its reason, facts, preview and audit history", async () => {
  const { root, draft } = await setup();
  const reason = "The code-review skill explicitly groups its reports.";
  const sealed = JSON.parse(await runCli(["draft", "seal", "--id", draft.draft_id, "--file", "reviews/report.md", "--category", "codeReview", "--category-reason", reason], root));
  expect(sealed).toMatchObject({ category: "codeReview", category_reason: reason, preview_file: expect.any(String) });
  const text = await readFile(join(root, draft.artifacts.metadata), "utf8");
  expect(JSON.parse(text)).toEqual({ ...metadata, category: "codeReview", category_reason: reason });
  const manifest = JSON.parse(await readFile(join(root, sealed.manifest_file), "utf8"));
  expect(manifest.hashes.metadata).toBe(sha256(text));
  expect(await readFile(join(root, sealed.preview_file), "utf8")).toContain(metadata.facts[0].text);
  const saved = JSON.parse(await runCli(["document", "add", "--draft", draft.draft_id], root));
  const current = await getManagedRecord(root, saved.id);
  expect(current.metadata).toEqual({ ...metadata, category: "codeReview", category_reason: reason });
  expect(current.source).toBe("Code-review skill output");
  expect(current.timeline).toContain('"to": "codeReview"');
  expect(current.timeline).toContain(reason);
  expect((await queryDocuments(root)).categories).toEqual([{ id: "codeReview", label: "codeReview", count: 1 }]);
});

it("uses a deterministic caller-supplied basis when the reason is omitted", async () => {
  const { root, draft } = await setup();
  const sealed = await sealDraft(root, { draftId: draft.draft_id, filePath: "review.md", category: "codeReview" });
  expect(sealed).toMatchObject({ category: "codeReview", category_reason: "Explicit category supplied by caller." });
  const current = JSON.parse(await readFile(join(root, draft.artifacts.metadata), "utf8"));
  expect(current.category_reason).not.toBe(metadata.category_reason);
});

it("keeps the ordinary metadata category and bytes when no category override is supplied", async () => {
  const { root, draft } = await setup();
  const before = await readFile(join(root, draft.artifacts.metadata), "utf8");
  await sealDraft(root, { draftId: draft.draft_id, filePath: "review.md" });
  expect(await readFile(join(root, draft.artifacts.metadata), "utf8")).toBe(before);
  const saved = JSON.parse(await runCli(["document", "add", "--draft", draft.draft_id], root));
  expect((await getManagedRecord(root, saved.id)).metadata).toEqual(metadata);
});

it("rejects invalid explicit categories or reasons without changing the draft", async () => {
  const { root, draft } = await setup();
  const before = await readFile(join(root, draft.artifacts.metadata), "utf8");
  for (const override of [{ category: " bad " }, { category: "" }, { category: "x".repeat(81) }, { category: "bad\nname" },
    { categoryReason: "No category" }, { category: "codeReview", categoryReason: " " }, { category: "codeReview", categoryReason: "x".repeat(2001) }]) {
    await expect(sealDraft(root, { draftId: draft.draft_id, filePath: "review.md", ...override })).rejects.toMatchObject({ code: "invalid_params" });
  }
  expect(await readFile(join(root, draft.artifacts.metadata), "utf8")).toBe(before);
  await writeFile(join(root, draft.artifacts.metadata), JSON.stringify({ ...metadata, title: "" }));
  await expect(sealDraft(root, { draftId: draft.draft_id, filePath: "review.md", category: "codeReview" })).rejects.toMatchObject({ code: "draft_invalid" });
});

it("applies an explicit category when replacing a reviewed current document", async () => {
  const { root, draft } = await setup();
  const saved = await upsertManagedDocument(root, { file_path: "review.md", source: "Previous review", document, metadata });
  const before = await getManagedRecord(root, saved.id);
  await sealDraft(root, { draftId: draft.draft_id, filePath: "review.md", baseRecordHash: before.record_version, category: "codeReview" });
  await expect(runCli(["document", "add", "--draft", draft.draft_id], root)).rejects.toMatchObject({ code: "confirmation_required" });
  await runCli(["document", "add", "--draft", draft.draft_id, "--replace"], root);
  const current = await getManagedRecord(root, saved.id);
  expect(current.metadata).toEqual({ ...metadata, category: "codeReview", category_reason: "Explicit category supplied by caller." });
  expect(current.timeline).toContain('"from": "note"');
  expect(current.timeline).toContain('"to": "codeReview"');
});

it("rejects category changes after sealing and category overrides supplied only at ingestion", async () => {
  const { root, draft } = await setup();
  await sealDraft(root, { draftId: draft.draft_id, filePath: "review.md", category: "codeReview" });
  await expect(runCli(["document", "add", "--draft", draft.draft_id, "--category", "other"], root)).rejects.toMatchObject({ code: "invalid_params" });
  await writeFile(join(root, draft.artifacts.metadata), JSON.stringify({ ...metadata, category: "other" }));
  await expect(runCli(["document", "add", "--draft", draft.draft_id], root)).rejects.toMatchObject({ code: "draft_changed" });
  expect((await queryDocuments(root)).total).toBe(0);
});

it("does not bypass stale-target protection when overriding classification", async () => {
  const { root, draft } = await setup();
  const saved = await upsertManagedDocument(root, { file_path: "review.md", source: "Previous review", document, metadata });
  const before = await getManagedRecord(root, saved.id);
  await classifyManagedDocument(root, { id: saved.id, category: "userCorrection", reason: "User regrouped this report" });
  const metadataBefore = await readFile(join(root, draft.artifacts.metadata), "utf8");
  await expect(sealDraft(root, { draftId: draft.draft_id, filePath: "review.md", baseRecordHash: before.record_version, category: "codeReview" })).rejects.toMatchObject({ code: "target_changed" });
  expect(await readFile(join(root, draft.artifacts.metadata), "utf8")).toBe(metadataBefore);
  const current = await getManagedRecord(root, saved.id);
  await sealDraft(root, { draftId: draft.draft_id, filePath: "review.md", baseRecordHash: current.record_version, category: "codeReview" });
  await classifyManagedDocument(root, { id: saved.id, category: "newerCorrection", reason: "Later user decision" });
  await expect(runCli(["document", "add", "--draft", draft.draft_id, "--replace"], root)).rejects.toMatchObject({ code: "target_changed" });
  expect((await getManagedRecord(root, saved.id)).metadata!.category).toBe("newerCorrection");
});
