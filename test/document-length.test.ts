import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { sha256 } from "../src/hash.js";
import { upsertManagedDocument } from "../src/managed-documents.js";
import type { DocNexusMetadata } from "../src/types.js";

const roots: string[] = [];
const metadata: DocNexusMetadata = { title: "Knowledge", summary: "Current knowledge", tags: [], entities: [], relationships: [] };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "docnexus-document-length-")); roots.push(root);
  await runCli(["init"], root);
  return root;
}
async function stage(root: string, document: string, meta = metadata, source = "Original source") {
  const draft = JSON.parse(await runCli(["draft", "new"], root));
  for (const [name, content] of Object.entries({ source, document, metadata: JSON.stringify(meta) })) {
    await writeFile(join(root, draft.artifacts[name]), content);
  }
  return draft;
}
const seal = (root: string, draft: { draft_id: string }, file = "knowledge.md") => runCli(["draft", "seal", "--id", draft.draft_id, "--file", file, "--base-version", "new"], root);

it("accepts exactly 4000 Unicode characters and keeps long provenance out of default CLI reads", async () => {
  const root = await setup();
  const heading = "# Knowledge\n\n";
  const document = heading + "🙂".repeat(4000 - heading.length);
  const source = "Original evidence. ".repeat(1000);
  const draft = await stage(root, document, metadata, source);
  await seal(root, draft);
  expect(JSON.parse(await runCli(["draft", "preview", "--id", draft.draft_id], root)).document).toBe(document);
  const added = JSON.parse(await runCli(["document", "add", "--draft", draft.draft_id], root));
  const current = JSON.parse(await runCli(["document", "get", "--id", added.id], root));
  expect(current.document).toBe(document);
  for (const field of ["source", "metadata", "timeline"]) expect(current).not.toHaveProperty(field);
  const full = JSON.parse(await runCli(["document", "get", "--id", added.id, "--include", "source,metadata,timeline"], root));
  expect(full.source).toBe(source);
  expect(full.timeline).toContain(source);
  expect(full.metadata).toEqual(metadata);
});

it("refuses an oversized refined body before writing a ready manifest", async () => {
  const root = await setup();
  const draft = await stage(root, "文".repeat(4001));
  await expect(seal(root, draft)).rejects.toMatchObject({ code: "document_too_long", details: { characters: 4001, max_characters: 4000 } });
  await expect(readFile(join(root, draft.draft_directory, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("counts expanded facts instead of accepting a short reference template", async () => {
  const root = await setup();
  const draft = await stage(root, "# Policy\n\n{{fact:fact_large}}", { ...metadata, facts: [{
    id: "fact_large", text: "文".repeat(4100), provenance: "Original evidence", valid_from: "2020-01-01T00:00:00Z"
  }] });
  await expect(seal(root, draft)).rejects.toMatchObject({ code: "document_too_long" });
});

it("also rejects a previously sealed oversized draft at preview and ingestion", async () => {
  const root = await setup();
  const draft = await stage(root, "# Small");
  const sealed = JSON.parse(await seal(root, draft));
  const oversized = "文".repeat(4001);
  await writeFile(join(root, draft.artifacts.document), oversized);
  const manifest = JSON.parse(await readFile(join(root, sealed.manifest_file), "utf8"));
  manifest.hashes.document = sha256(oversized);
  await writeFile(join(root, sealed.manifest_file), JSON.stringify(manifest));
  await expect(runCli(["draft", "preview", "--id", draft.draft_id], root)).rejects.toMatchObject({ code: "document_too_long" });
  await expect(runCli(["document", "add", "--draft", draft.draft_id], root)).rejects.toMatchObject({ code: "document_too_long" });
  expect(JSON.parse(await readFile(join(root, sealed.manifest_file), "utf8")).status).toBe("ready");
  await expect(readFile(join(root, "docnexus/library/knowledge.md"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("accepts two independently prepared topic drafts without truncating their source", async () => {
  const root = await setup();
  const source = "Architecture and operations source. ".repeat(300);
  for (const [file, document] of [["architecture.md", "# Architecture\n\n" + "架构约定。".repeat(650)], ["operations.md", "# Operations\n\n" + "运维约定。".repeat(650)]]) {
    const draft = await stage(root, document, metadata, source);
    await seal(root, draft, file);
    const added = JSON.parse(await runCli(["document", "add", "--draft", draft.draft_id], root));
    expect(JSON.parse(await runCli(["document", "get", "--id", added.id], root)).document).toBe(document);
  }
  expect(JSON.parse(await runCli(["document", "list"], root)).records).toHaveLength(2);
});

it("refuses adopting an oversized hand edit while retaining the prior record", async () => {
  const root = await setup();
  const saved = await upsertManagedDocument(root, { file_path: "knowledge.md", source: "Original", document: "# Existing", metadata });
  const recordFile = join(root, "docnexus/records", saved.id, "record.json");
  const before = await readFile(recordFile, "utf8");
  await writeFile(join(root, "docnexus/library/knowledge.md"), "文".repeat(4001));
  await expect(runCli(["document", "sync", "--id", saved.id], root)).rejects.toMatchObject({ code: "document_too_long" });
  expect(await readFile(recordFile, "utf8")).toBe(before);
});

it("refuses an ingestion that would expand a dependent page beyond the limit", async () => {
  const root = await setup();
  const fact = { id: "fact_policy", text: "Short policy", provenance: "Original", valid_from: "2020-01-01T00:00:00Z" };
  const owner = await upsertManagedDocument(root, { file_path: "owner.md", source: "Original", document: "# Owner", metadata: { ...metadata, facts: [fact] } });
  await upsertManagedDocument(root, { file_path: "reader.md", source: "Original", document: "文".repeat(3500) + "\n\n{{fact:fact_policy}}", metadata });
  const readerBefore = await readFile(join(root, "docnexus/library/reader.md"), "utf8");
  const ownerRecord = join(root, "docnexus/records", owner.id, "record.json");
  const ownerBefore = await readFile(ownerRecord, "utf8");
  const version = JSON.parse(await runCli(["document", "get", "--id", owner.id], root)).record_version;
  const draft = await stage(root, "# Owner", { ...metadata, facts: [fact, { ...fact, id: "fact_policy_next", text: "文".repeat(1000), valid_from: "2020-01-02T00:00:00Z", replaces: fact.id }] });
  await runCli(["draft", "seal", "--id", draft.draft_id, "--file", "owner.md", "--base-version", version], root);
  await expect(runCli(["document", "add", "--draft", draft.draft_id, "--replace"], root)).rejects.toMatchObject({ code: "document_too_long", details: { file_path: "reader.md" } });
  expect(await readFile(ownerRecord, "utf8")).toBe(ownerBefore);
  expect(await readFile(join(root, "docnexus/library/reader.md"), "utf8")).toBe(readerBefore);
});

it("keeps existing long stored documents readable without truncation", async () => {
  const root = await setup();
  const document = "文".repeat(5000);
  const saved = await upsertManagedDocument(root, { file_path: "legacy.md", source: "Original", document, metadata });
  expect(JSON.parse(await runCli(["document", "get", "--id", saved.id], root)).document).toBe(document);
});
