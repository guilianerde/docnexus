import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeProject } from "../src/project.js";
import { deleteManagedDocument, upsertManagedDocument } from "../src/managed-documents.js";
import { DocumentRevisionChangedError, queryDocuments } from "../src/document-query.js";
import { runCli } from "../src/cli.js";
import { validateMetadata } from "../src/metadata.js";
import { type DocNexusMetadata, type DocumentCategory } from "../src/types.js";

vi.mock("../src/embedder-default.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/embedder-default.js")>(),
  createDefaultEmbedder: () => { throw new Error("document query must not load an embedding model"); }
}));

const roots: string[] = [];
const metadata: DocNexusMetadata = { title: "Project knowledge", summary: "Document context", tags: ["project"], entities: [], relationships: [] };
async function root() {
  const path = await mkdtemp(join(tmpdir(), "docnexus-query-"));
  roots.push(path);
  await initializeProject(path);
  return path;
}
async function add(path: string, file: string, category?: DocumentCategory) {
  return upsertManagedDocument(path, { file_path: file, source: `Source for ${file}`, document: `# ${file}\n\nHuman-readable content.`, metadata: { ...metadata, ...(category ? { category } : {}) } });
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("orchestration document query", () => {
  it("returns complete current Markdown, category labels and deterministic full/page equivalence", async () => {
    const path = await root();
    await add(path, "z-note.md");
    await add(path, "a-design.md", "architecture");
    await add(path, "m-guide.md", "guide");
    const all = await queryDocuments(path, { all: true });
    expect(all.documents.map((document) => document.file_path)).toEqual(["a-design.md", "m-guide.md", "z-note.md"]);
    expect(all).toMatchObject({ schema_version: 1, total_documents: 3, total: 3, pagination: null });
    expect(all.documents[0]).toMatchObject({ category: "architecture", category_label: "架构设计", document: expect.stringContaining("Human-readable content"), library_path: "docnexus/library/a-design.md", facts: [], fact_references: [] });
    expect(all.documents[2].category).toBe("uncategorized");
    const first = await queryDocuments(path, { page: 1, page_size: 2 });
    const second = await queryDocuments(path, { page: 2, page_size: 2, revision: first.revision });
    expect([...first.documents, ...second.documents]).toEqual(all.documents);
    expect(first.pagination).toEqual({ page: 1, page_size: 2, total_pages: 2, has_more: true, next_page: 2 });
    expect(second.pagination).toEqual({ page: 2, page_size: 2, total_pages: 2, has_more: false, next_page: null });
    expect(first.revision).toBe(all.revision);
  });

  it("filters by category while retaining global counts for category navigation", async () => {
    const path = await root();
    await add(path, "one.md", "guide");
    await add(path, "two.md", "guide");
    await add(path, "three.md", "decision");
    const output = await queryDocuments(path, { category: "guide" });
    expect(output.total).toBe(2);
    expect(output.total_documents).toBe(3);
    expect(output.documents.every((document) => document.category === "guide")).toBe(true);
    expect(output.categories).toEqual(expect.arrayContaining([{ id: "guide", label: "操作指南", count: 2 }, { id: "decision", label: "决策记录", count: 1 }]));
    expect(output.categories).toHaveLength(2);
  });

  it("returns explicit empty pagination for empty, unmatched and out-of-range queries", async () => {
    const path = await root();
    expect(await queryDocuments(path)).toMatchObject({ total: 0, documents: [], pagination: { total_pages: 0, has_more: false, next_page: null } });
    await add(path, "one.md", "note");
    expect(await queryDocuments(path, { category: "reference", all: true })).toMatchObject({ total: 0, pagination: null, documents: [] });
    expect(await queryDocuments(path, { page: 2 })).toMatchObject({ total: 1, documents: [], pagination: { page: 2, total_pages: 1, has_more: false, next_page: null } });
  });

  it("rejects stale pagination after updates, reclassification or deletion", async () => {
    const path = await root();
    const added = await add(path, "one.md", "note");
    const before = await queryDocuments(path);
    await upsertManagedDocument(path, { file_path: "one.md", source: "Reclassified by orchestration", document: "# Updated guide", metadata: { ...metadata, category: "guide" } });
    await expect(queryDocuments(path, { page: 2, revision: before.revision })).rejects.toBeInstanceOf(DocumentRevisionChangedError);
    const after = await queryDocuments(path);
    expect(after.documents[0]).toMatchObject({ category: "guide", document: "# Updated guide" });
    await deleteManagedDocument(path, { id: added.id, confirm: true });
    await expect(queryDocuments(path, { revision: after.revision })).rejects.toMatchObject({ code: "document_revision_changed", current_revision: expect.any(String) });
  });

  it("renders effective facts at one snapshot time without changing source or materialized views", async () => {
    const path = await root();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const old = { id: "fact_query_old", text: "Daily rotation", provenance: "Initial decision", valid_from: "2020-01-01T00:00:00Z" };
    const next = { id: "fact_query_next", text: "Hourly rotation", provenance: "Revised decision", valid_from: "2030-01-01T00:00:00Z", valid_until: "2030-01-02T00:00:00Z", replaces: old.id };
    const owner = await upsertManagedDocument(path, { file_path: "policy.md", source: "User decisions", document: "# Policy registry", metadata: { ...metadata, category: "decision", facts: [old, next] } });
    const usage = await upsertManagedDocument(path, { file_path: "usage.md", source: "Implementation context", document: "# Usage\n\n{{fact:fact_query_old}}\n", metadata: { ...metadata, category: "guide" } });
    const viewFile = join(path, "docnexus/library/usage.md");
    const viewBefore = await readFile(viewFile, "utf8");
    const recordFile = join(path, "docnexus/records", usage.id, "record.json");
    const recordBefore = await readFile(recordFile, "utf8");
    const before = await queryDocuments(path, { all: true });
    vi.setSystemTime(new Date(next.valid_from));
    await expect(queryDocuments(path, { revision: before.revision })).rejects.toBeInstanceOf(DocumentRevisionChangedError);
    const after = await queryDocuments(path, { category: "guide", all: true });
    expect(after.documents[0].document).toContain("Hourly rotation");
    expect(after.documents[0].document).not.toContain("Daily rotation");
    expect(after.documents[0].facts).toContainEqual(expect.objectContaining({ id: next.id, status: "active", document_id: owner.id, source_path: "policy.md" }));
    expect(after.documents[0].fact_references).toContainEqual(expect.objectContaining({ reference_id: old.id, fact_id: next.id }));
    expect(await readFile(viewFile, "utf8")).toBe(viewBefore);
    expect(await readFile(recordFile, "utf8")).toBe(recordBefore);
    vi.setSystemTime(new Date(next.valid_until));
    const expired = await queryDocuments(path, { category: "guide" });
    expect(expired.revision).not.toBe(after.revision);
    expect(expired.documents[0].document).toContain("已到期");
    expect(expired.documents[0].document).not.toContain("Hourly rotation");
  });

  it("works without retrieval stores or model assets and isolates projects", async () => {
    const path = await root();
    await add(path, "offline.md", "reference");
    await rm(join(path, ".docnexus/store"), { recursive: true, force: true });
    expect((await queryDocuments(path, { all: true })).documents).toHaveLength(1);
    await expect(stat(join(path, ".docnexus/store"))).rejects.toThrow();
    expect((await queryDocuments(await root(), { all: true })).documents).toEqual([]);
  });

  it("refuses unadopted or corrupt text rather than exposing an inconsistent page", async () => {
    const path = await root();
    const added = await add(path, "one.md");
    await writeFile(join(path, "docnexus/library/one.md"), "Unadopted edit");
    await expect(queryDocuments(path)).rejects.toThrow("before querying");
    await writeFile(join(path, "docnexus/library/one.md"), "# one.md\n\nHuman-readable content.");
    await writeFile(join(path, "docnexus/records", added.id, "timeline.md"), "Tampered history");
    await expect(queryDocuments(path)).rejects.toThrow("before querying");
  });

  it("validates pagination, categories and CLI options", async () => {
    const path = await root();
    for (const input of [{ page: 0 }, { page_size: 101 }, { page: Number.MAX_SAFE_INTEGER, page_size: 100 }, { all: true, page: 1 }, { category: " " }, { revision: "bad" }]) {
      await expect(queryDocuments(path, input)).rejects.toThrow();
    }
    const output = JSON.parse(await runCli(["document", "query", "--all", "--category", "guide"], path));
    expect(output).toMatchObject({ schema_version: 1, pagination: null, total: 0 });
    await expect(runCli(["document", "query", "--all", "--page", "1"], path)).rejects.toThrow("cannot be combined");
    await expect(runCli(["document", "query", "--unknown", "x"], path)).rejects.toThrow("unknown document query option");
    await expect(runCli(["document", "query", "--all", "false"], path)).rejects.toThrow("unexpected");
    expect(validateMetadata({ ...metadata, category: "guide" }).valid).toBe(true);
    expect(validateMetadata({ ...metadata, category: "部署与运维", category_reason: "项目已有部署文档，本文说明发布流程" }).valid).toBe(true);
    expect(validateMetadata({ ...metadata, category: " " }).valid).toBe(false);
    expect(validateMetadata({ ...metadata, category_reason: "缺少分类" }).valid).toBe(false);
    expect(validateMetadata(metadata).valid).toBe(true);
  });

  it("derives navigation from model-chosen names rather than a fixed taxonomy", async () => {
    const path = await root();
    await add(path, "api.md", "接口契约");
    await add(path, "deploy.md", "部署与运维");
    await add(path, "special.md", "__proto__");
    const output = await queryDocuments(path, { category: "接口契约", all: true });
    expect(output.documents[0]).toMatchObject({ category: "接口契约", category_label: "接口契约", category_reason: null });
    expect(output.categories.map((category) => category.id)).toEqual(["__proto__", "接口契约", "部署与运维"]);
    expect((await queryDocuments(path, { category: "新增但尚未使用的分类" })).documents).toEqual([]);
  });
});
