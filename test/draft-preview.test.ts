import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { getManagedRecord, upsertManagedDocument } from "../src/managed-documents.js";
import { sha256 } from "../src/hash.js";
import type { DocNexusMetadata } from "../src/types.js";

const roots: string[] = [];
const metadata: DocNexusMetadata = { title: "Policy", summary: "Policy", tags: [], entities: [], relationships: [] };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "docnexus-preview-")); roots.push(root);
  await runCli(["init"], root);
  return root;
}
async function draft(root: string, document = "# Policy\n\nKeep the release log.\n", file = "policy.md", base = "new", meta = metadata) {
  const created = JSON.parse(await runCli(["draft", "new"], root));
  for (const [name, content] of Object.entries({ source: "New policy", document, metadata: JSON.stringify(meta) })) {
    await writeFile(join(root, created.artifacts[name]), content);
  }
  const args = ["draft", "seal", "--id", created.draft_id, "--file", file, "--base-version", base];
  const sealed = JSON.parse(await runCli(args, root));
  return { ...created, sealed, args };
}
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("delivers a plain sealed document without changing the manifest or requiring a read to ingest", async () => {
  const root = await setup();
  const staged = await draft(root);
  const before = await readFile(join(root, staged.sealed.manifest_file), "utf8");
  const preview = JSON.parse(await runCli(["draft", "preview", "--id", staged.draft_id], root));
  expect(preview).toMatchObject({ result: "draft_preview", draft_id: staged.draft_id, file_path: "policy.md",
    sealed_version: staged.sealed.sealed_version, document: "# Policy\n\nKeep the release log.\n" });
  expect(preview.document_hash).toBe(sha256(preview.document));
  expect(await readFile(join(root, staged.sealed.manifest_file), "utf8")).toBe(before);
  const added = JSON.parse(await runCli(["document", "add", "--draft", staged.draft_id], root));
  expect(added.sealed_version).toBe(preview.sealed_version);
  const unread = await draft(root, "# Another", "another.md");
  await expect(runCli(["document", "add", "--draft", unread.draft_id], root)).resolves.toContain('"operation": "created"');
});

it("rejects unsealed drafts, changed artifacts and changed targets", async () => {
  const root = await setup();
  await expect(runCli(["draft", "preview"], root)).rejects.toMatchObject({ code: "invalid_params" });
  const open = JSON.parse(await runCli(["draft", "new"], root));
  await expect(runCli(["draft", "preview", "--id", open.draft_id], root)).rejects.toMatchObject({ code: "draft_invalid" });
  const staged = await draft(root);
  await writeFile(join(root, staged.artifacts.document), "Changed after sealing");
  await expect(runCli(["draft", "preview", "--id", staged.draft_id], root)).rejects.toMatchObject({ code: "draft_changed" });
  const saved = await upsertManagedDocument(root, { file_path: "existing.md", source: "Old", document: "# Old", metadata });
  const current = await getManagedRecord(root, saved.id);
  const update = await draft(root, "# Merged", "existing.md", current.record_version);
  await writeFile(join(root, "docnexus/library/existing.md"), "Unadopted user edit");
  await expect(runCli(["draft", "preview", "--id", update.draft_id], root)).rejects.toMatchObject({ code: "text_integrity_error" });
  await writeFile(join(root, "docnexus/library/existing.md"), "# Old");
  await upsertManagedDocument(root, { file_path: "existing.md", source: "New", document: "# New", metadata });
  await expect(runCli(["draft", "preview", "--id", update.draft_id], root)).rejects.toMatchObject({ code: "target_changed" });
});

it("checks current fact rendering, preview tampering and resealed versions", async () => {
  const root = await setup();
  const fact = { id: "fact_window", text: "Seven days", provenance: "Original decision", valid_from: "2020-01-01T00:00:00Z" };
  const owner = { file_path: "owner.md", source: "Owner", document: "# Owner\n\n{{fact:fact_window}}\n", metadata: { ...metadata, facts: [fact] } };
  await upsertManagedDocument(root, owner);
  const staged = await draft(root, "# Guide\n\n{{fact:fact_window}}\n", "guide.md");
  const first = JSON.parse(await runCli(["draft", "preview", "--id", staged.draft_id], root));
  expect(first.document).toContain("Seven days");
  expect(first.document).toBe(await readFile(join(root, staged.sealed.preview_file), "utf8"));
  await upsertManagedDocument(root, { ...owner, metadata: { ...metadata, facts: [fact, {
    id: "fact_window_next", text: "One day", provenance: "New decision", valid_from: "2020-01-02T00:00:00Z", replaces: fact.id
  }] } });
  await expect(runCli(["draft", "preview", "--id", staged.draft_id], root)).rejects.toMatchObject({ code: "preview_changed" });
  const resealed = JSON.parse(await runCli(staged.args, root));
  const current = JSON.parse(await runCli(["draft", "preview", "--id", staged.draft_id], root));
  expect(current.sealed_version).toBe(resealed.sealed_version);
  expect(current.sealed_version).not.toBe(first.sealed_version);
  expect(current.document).toContain("One day");
  await writeFile(join(root, resealed.preview_file), "Tampered");
  await expect(runCli(["draft", "preview", "--id", staged.draft_id], root)).rejects.toMatchObject({ code: "draft_changed" });
});

it("refuses a preview whose effective fact expires after sealing", async () => {
  const root = await setup();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
  const meta = { ...metadata, facts: [{ id: "fact_expiry", text: "Temporary", provenance: "Decision", valid_from: "2020-01-01T00:00:00Z", valid_until: "2026-10-18T00:00:00Z" }] };
  const staged = await draft(root, "# Policy\n\n{{fact:fact_expiry}}\n", "expiry.md", "new", meta);
  vi.setSystemTime(new Date("2026-10-19T00:00:00Z"));
  await expect(runCli(["draft", "preview", "--id", staged.draft_id], root)).rejects.toMatchObject({ code: "preview_changed" });
  await runCli(staged.args, root);
  const current = JSON.parse(await runCli(["draft", "preview", "--id", staged.draft_id], root));
  expect(current.document).toContain("已到期");
});
