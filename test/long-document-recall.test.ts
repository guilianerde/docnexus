import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeProject } from "../src/project.js";
import { getManagedRecord, upsertManagedDocument } from "../src/managed-documents.js";
import { RealEmbedder } from "../src/embedder-real.js";
import { bundledEmbeddingModelsPath } from "../src/embedding-models.js";
import { listIndexedChunks, syncRetrievalIndex } from "../src/retrieval-index.js";
import { recall } from "../src/recall.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("offline long-document retrieval", () => {
  it("embeds complete bounded chunks and finds paragraph, code and fact conclusions near the end", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("long-document test forbids network")));
    const root = await mkdtemp(join(tmpdir(), "docnexus-long-recall-")); roots.push(root);
    await initializeProject(root);
    const metadata = { title: "Project notes", summary: "Evaluation context", tags: [], entities: [], relationships: [] };
    const documents = [
      { file_path: "paragraph.md", source: "Long paragraph fixture", document: "# 操作说明\n\n" + "本项目在每次迭代中记录文档，并检查发布流程中的常规步骤。".repeat(60) + "事故恢复后必须先清空死信队列，再重新投递失败任务。", metadata },
      { file_path: "code.md", source: "Long code fixture", document: '# Implementation\n\n```js\n' + Array.from({ length: 70 }, (_, index) => `const theme_${index} = { background: "white", foreground: "black" };`).join("\n") + '\nfunction reconcileLedger() { return flush_pending_payments(); }\n```', metadata },
      { file_path: "facts.md", source: "Long canonical fact fixture", document: "# 会话恢复\n\n{{fact:fact_long_recovery}}\n", metadata: { ...metadata, facts: [{ id: "fact_long_recovery", text: "审计时应记录常规运行状态与检查结果。".repeat(65) + "回滚之后先刷新授权缓存，再重新建立会话。", provenance: "Offline long-fact fixture", valid_from: "2020-01-01T00:00:00Z" }] } }
    ];
    const records: Awaited<ReturnType<typeof upsertManagedDocument>>[] = [];
    for (const document of documents) records.push(await upsertManagedDocument(root, document));
    const before = await Promise.all(records.map((record) => getManagedRecord(root, record.id)));
    const embedder = new RealEmbedder({ localModelPath: bundledEmbeddingModelsPath() });
    const budget = await embedder.tokenBudget();
    expect(budget.maxTokens).toBe(512);
    await syncRetrievalIndex(root, {}, embedder);
    for (const record of records) {
      const chunks = await listIndexedChunks(root, record.id);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => budget.countTokens(chunk.text) <= Math.min(256, budget.maxTokens))).toBe(true);
      expect(chunks.every((chunk) => chunk.embedding.every(Number.isFinite))).toBe(true);
    }
    for (const [index, query, answer] of [
      [0, "事故恢复后如何清空死信队列并重新投递失败任务", "死信队列"],
      [1, "flush pending payments when reconciling the ledger", "flush_pending_payments"],
      [2, "回滚之后刷新授权缓存再重新建立会话", "授权缓存"]
    ] as const) {
      // Pure vector search prevents lexical fallback from concealing a truncated embedding.
      const output = await recall(root, { query, mode: "vector", limit: 3 }, embedder);
      const diagnostic = JSON.stringify(output.results.map((result) => ({ path: result.document_ref.path, score: result.matched_chunk.score, end: result.matched_chunk.text.slice(-160) })));
      const match = output.results.find((result) => result.document_ref.document_id === records[index].id && result.matched_chunk.text.includes(answer));
      expect(match, `${query}: ${diagnostic}`).toBeDefined();
      expect(match!.matched_chunk.chunk_index).toBeGreaterThan(0);
    }
    await expect(embedder.embed("知识".repeat(300))).rejects.toThrow("exceeds model token limit");
    await expect(recall(root, { query: "知识".repeat(300), mode: "vector" }, embedder)).rejects.toThrow("exceeds model token limit");
    expect(await Promise.all(records.map((record) => getManagedRecord(root, record.id)))).toEqual(before);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  }, 60_000);
});
