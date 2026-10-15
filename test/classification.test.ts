import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeProject } from "../src/project.js";
import { classifyManagedDocument, getManagedRecord, inspectRecords, upsertManagedDocument } from "../src/managed-documents.js";
import { queryDocuments } from "../src/document-query.js";
import { runCli } from "../src/cli.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const roots: string[] = [];
const input = { file_path: "api.md", source: "User confirmed API behavior", document: "# API\n\n{{fact:fact_api}}\n", metadata: {
  title: "API behavior", summary: "API contract", tags: ["api"], entities: [], relationships: [], category: "笔记",
  facts: [{ id: "fact_api", text: "The API returns JSON.", provenance: "User decision", valid_from: "2020-01-01T00:00:00Z" }]
} };
async function root() {
  const path = await mkdtemp(join(tmpdir(), "docnexus-classify-"));
  roots.push(path);
  await initializeProject(path);
  return path;
}
afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("contextual category maintenance", () => {
  it("changes only classification metadata and audit history, preserving facts, source and Markdown", async () => {
    const path = await root();
    const saved = await upsertManagedDocument(path, input);
    const before = await getManagedRecord(path, saved.id);
    const snapshot = await queryDocuments(path);
    const result = await classifyManagedDocument(path, { id: saved.id, category: "接口契约", reason: "结合项目 API 规范及现有端点文档，这篇内容定义响应约定", revision: snapshot.revision });
    expect(result).toMatchObject({ operation: "reclassified", previous_category: "笔记", category: "接口契约" });
    const after = await getManagedRecord(path, saved.id);
    expect(after.document).toBe(before.document);
    expect(after.source).toBe(before.source);
    expect(after.metadata).toEqual({ ...before.metadata, category: "接口契约", category_reason: result.category_reason });
    expect(after.timeline).toContain('"from": "笔记"');
    expect(after.timeline).toContain('"to": "接口契约"');
    expect(after.timeline).toContain(result.category_reason);
    const output = await queryDocuments(path);
    expect(output.revision).not.toBe(snapshot.revision);
    expect(output.categories).toEqual([{ id: "接口契约", label: "接口契约", count: 1 }]);
    expect(output.documents[0].category_reason).toBe(result.category_reason);
    const timeline = after.timeline;
    expect((await classifyManagedDocument(path, { id: saved.id, category: "接口契约", reason: result.category_reason })).operation).toBe("unchanged");
    expect((await getManagedRecord(path, saved.id)).timeline).toBe(timeline);
  });

  it("records category and basis changes in normal capture/update history too", async () => {
    const path = await root();
    const saved = await upsertManagedDocument(path, input);
    await upsertManagedDocument(path, { ...input, metadata: { ...input.metadata, category: "接口契约", category_reason: "与现有接口规格统一组织" } });
    const current = await getManagedRecord(path, saved.id);
    expect(current.timeline).toContain('"from": "笔记"');
    expect(current.timeline).toContain('"to": "接口契约"');
    expect(current.timeline).toContain("与现有接口规格统一组织");
    expect(current.metadata!.facts).toEqual(input.metadata.facts);
  });

  it("refuses stale context, missing reasons and invalid category names", async () => {
    const path = await root();
    const saved = await upsertManagedDocument(path, input);
    const snapshot = await queryDocuments(path);
    await classifyManagedDocument(path, { id: saved.id, category: "接口契约", reason: "项目已有 API 合约" });
    await expect(classifyManagedDocument(path, { id: saved.id, category: "开发指南", reason: "旧上下文判断", revision: snapshot.revision })).rejects.toMatchObject({ code: "document_revision_changed" });
    await expect(classifyManagedDocument(path, { id: saved.id, category: "开发指南", reason: " " })).rejects.toThrow("reason");
    await expect(classifyManagedDocument(path, { id: saved.id, category: " bad ", reason: "判断依据" })).rejects.toThrow("category");
    await expect(runCli(["document", "classify", "--id", saved.id, "--category", "接口契约"], path)).rejects.toThrow("--reason");
    await expect(runCli(["document", "classify", "--id", saved.id, "--category", "错误改类", "--reason", "测试", "--dry-run", "true"], path)).rejects.toThrow("unknown document classify option");
    expect((await getManagedRecord(path, saved.id)).metadata!.category).toBe("接口契约");
    const changed = JSON.parse(await runCli(["document", "classify", "--id", saved.id, "--category", "开发指南", "--reason", "项目重组后该文档侧重使用流程"], path));
    expect(changed).toMatchObject({ operation: "reclassified", category: "开发指南" });
  });

  it("rolls back classification metadata when the timeline write fails", async () => {
    const path = await root();
    const saved = await upsertManagedDocument(path, input);
    const before = await getManagedRecord(path, saved.id);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let failed = false;
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (!failed && String(to).endsWith("timeline.md")) { failed = true; throw new Error("classification timeline failure"); }
      return actual.rename(from, to);
    });
    await expect(classifyManagedDocument(path, { id: saved.id, category: "接口契约", reason: "项目上下文" })).rejects.toThrow("classification timeline failure");
    expect(failed).toBe(true);
    expect(await getManagedRecord(path, saved.id)).toEqual(before);
    expect((await inspectRecords(path)).ok).toBe(true);
  });
});
