import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeProject } from "../src/project.js";
import { upsertManagedDocument } from "../src/managed-documents.js";
import { searchDocuments } from "../src/search.js";
import type { DocNexusMetadata } from "../src/types.js";

const roots: string[] = [];
const metadata: DocNexusMetadata = { title: "项目说明", summary: "运行约定", tags: [], entities: [], relationships: [] };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "docnexus-search-")); roots.push(root);
  await initializeProject(root);
  return root;
}
async function add(root: string, path: string, document: string, values: Partial<DocNexusMetadata> = {}) {
  return upsertManagedDocument(root, { file_path: path, source: "Search regression source", document, metadata: { ...metadata, ...values } });
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("English query terms and exact names", () => {
  it("ignores standalone English filler without admitting filler-only documents", async () => {
    const root = await setup();
    await add(root, "noise.md", "what appears here; is discussed elsewhere; the examples follow.");
    const relevant = await add(root, "policy.md", "Refresh token rotation.");
    for (const query of ["what is the refresh token", "What IS the refresh token?"]) {
      const output = await searchDocuments(root, { query });
      expect(output.results.map(hit => hit.id)).toEqual([relevant.id]);
      expect(output.results[0].matched_terms).toEqual(["refresh", "token"]);
    }
    expect((await searchDocuments(root, { query: "what is zyqvnonexistent" })).results).toEqual([]);
  });

  it("filters question words around an intact code identifier", async () => {
    const root = await setup();
    await add(root, "noise.md", "what appears here; is discussed elsewhere.");
    const relevant = await add(root, "implementation.md", "Call rotate_refresh_token().");
    const output = await searchDocuments(root, { query: "what is rotate_refresh_token" });
    expect(output.results.map(hit => hit.id)).toEqual([relevant.id]);
    expect(output.results[0].matched_terms).toEqual(["rotate_refresh_token"]);
  });

  it("keeps literal stop-word queries, paths, identifiers and all-filler phrases", async () => {
    const root = await setup();
    const saved = await add(root, "auth/is/the guide.md", "is the to be is_ready to_string");
    for (const query of ["is", "the", "to be", "to be?", "is to", "auth/is/the guide.md", "is_ready", "to_string"]) {
      expect((await searchDocuments(root, { query })).results[0]?.id, query).toBe(saved.id);
    }
    const terms = (await searchDocuments(root, { query: "auth/is/the guide.md" })).results[0].matched_terms;
    expect(terms).toContain("is");
  });

  it("preserves negation and the original phrase when filtering query terms", async () => {
    const root = await setup();
    const negative = await add(root, "negative.md", "not enabled; without cache; no retry; never shared");
    const negation = await searchDocuments(root, { query: "is not enabled without cache no retry never shared" });
    expect(negation.results[0].id).toBe(negative.id);
    expect(negation.results[0].matched_terms).toEqual(expect.arrayContaining(["not", "without", "no", "never"]));
    await add(root, "reversed.md", "token refresh", { title: "Refresh token", summary: "Refresh token" });
    const phrase = await add(root, "question.md", "what is the refresh token");
    expect((await searchDocuments(root, { query: "what is the refresh token" })).results[0].id).toBe(phrase.id);
  });

  it.each(["auth/token.md", "auth/token", "token.md", "token", "ＴＯＫＥＮ", "Token policy"])("prefers an exact name for %s and cites that name", async (query) => {
    const root = await setup();
    await add(root, "a.md", `${query} ${query}`, { title: `${query} examples`, summary: query });
    const saved = await add(root, "auth/token.md", "Current rules.", { title: "Token policy" });
    const hit = (await searchDocuments(root, { query })).results[0];
    expect(hit.id).toBe(saved.id);
    const field = query === "Token policy" ? "title" : "path";
    expect(hit.source_anchor).toMatchObject({ kind: "metadata", field, value: field === "title" ? "Token policy" : "auth/token.md" });
    expect(hit.snippet).toBe(field === "title" ? "Token policy" : "auth/token.md");
    expect(hit.line).toBeUndefined();
  });
});

describe("Chinese literal search precision", () => {
  it("finds 长文 without admitting a generic 文 match from a stronger field", async () => {
    const root = await setup();
    await add(root, "generic.md", "保存当前知识与来源。", { title: "文档管理", summary: "项目文档说明", tags: ["文档"] });
    const relevant = await add(root, "relevant.md", "长文回归检查末尾结论。", { title: "检索评估" });
    const output = await searchDocuments(root, { query: "长文" });
    expect(output.results.map((result) => result.id)).toEqual([relevant.id]);
    expect(output.results[0].matched_terms).toContain("长文");
    expect(output.results[0].snippet).toContain("长文");
  });

  it("does not assemble a Chinese short phrase across gaps or metadata fields", async () => {
    const root = await setup();
    await add(root, "split.md", "长。文", { title: "长", tags: ["文"] });
    const relevant = await add(root, "term.md", "这里使用谱仓一词。", { title: "术语" });
    expect((await searchDocuments(root, { query: "长文" })).results).toEqual([]);
    expect((await searchDocuments(root, { query: "谱仓" })).results[0].id).toBe(relevant.id);
  });

  it("ranks a complete body phrase ahead of partial title and tag matches", async () => {
    const root = await setup();
    await add(root, "partial.md", "说明资料。", { title: "中文 检索 质量", tags: ["中文", "检索", "质量"] });
    const exact = await add(root, "exact.md", "改进中文检索质量。", { title: "记录" });
    const output = await searchDocuments(root, { query: "中文检索质量" });
    expect(output.results[0].id).toBe(exact.id);
    expect(output.results[0].score).toBeGreaterThan(output.results[1].score);
  });

  it("uses query coverage before field weights when no complete phrase exists", async () => {
    const root = await setup();
    await add(root, "partial.md", "处理向量检索。", { title: "向量检索", tags: ["向量", "检索"] });
    const complete = await add(root, "complete.md", "向量检索和文档分页需要共同验证。", { title: "记录" });
    expect((await searchDocuments(root, { query: "向量检索 文档分页" })).results[0].id).toBe(complete.id);
  });

  it("selects the phrase-bearing line instead of an earlier weak match", async () => {
    const root = await setup();
    await add(root, "snippet.md", "# 中文\n\n讨论质量。\n\n改进中文检索质量。");
    const hit = (await searchDocuments(root, { query: "中文检索质量" })).results[0];
    expect(hit.line).toBe(5);
    expect(hit.snippet).toContain("中文检索质量");
  });

  it("keeps the full phrase visible when an earlier term occurs on the same long line", async () => {
    const root = await setup();
    await add(root, "long-line.md", `中文 ${"背景说明。".repeat(100)}改进中文检索质量。`);
    const hit = (await searchDocuments(root, { query: "中文检索质量" })).results[0];
    expect(hit.line).toBe(1);
    expect(hit.snippet).toContain("中文检索质量");
  });

  it("shows an exact entity alias when body evidence is only partial", async () => {
    const root = await setup();
    await add(root, "alias.md", "平台运行状态摘要。", { entities: [{ name: "Project memory", type: "component", description: "本地记忆", aliases: ["运行记忆"] }] });
    const hit = (await searchDocuments(root, { query: "运行记忆" })).results[0];
    expect(hit.snippet).toContain("运行记忆");
    expect(hit.line).toBeUndefined();
  });

  it("preserves English, literal identifiers, paths and normalization", async () => {
    const root = await setup();
    const saved = await add(root, "auth/token.md", "调用 rotate_refresh_token；NodeJS 使用 CacheTTL。", { title: "Token rotation", entities: [{ name: "Token rotation", type: "concept", description: "轮换", aliases: ["RefreshPolicy"] }] });
    for (const query of ["Token rotation", "rotate_refresh_token", "auth/token.md", "RefreshPolicy", "CacheTTL", "ＮｏｄｅＪＳ"]) {
      expect((await searchDocuments(root, { query })).results[0].id, query).toBe(saved.id);
    }
  });

  it("retains intentional one-character queries and rejects punctuation-only queries", async () => {
    const root = await setup();
    const saved = await add(root, "graph.md", "图谱记录来源。");
    expect((await searchDocuments(root, { query: "图" })).results[0].id).toBe(saved.id);
    expect((await searchDocuments(root, { query: "!!!" })).results).toEqual([]);
    expect((await searchDocuments(root, { query: "NONEXISTENT_IDENTIFIER_905" })).results).toEqual([]);
  });

  it("uses current facts as literal evidence and excludes inactive facts", async () => {
    const root = await setup();
    const saved = await add(root, "facts.md", "# 当前约定", { facts: [
      { id: "fact_search_queue", text: "死信队列必须清空。", provenance: "Fixture decision", valid_from: "2020-01-01T00:00:00Z" },
      { id: "fact_search_old", text: "旧式缓存已经到期。", provenance: "Fixture history", valid_from: "2020-01-01T00:00:00Z", valid_until: "2020-01-02T00:00:00Z" }
    ] });
    const hit = (await searchDocuments(root, { query: "队列" })).results[0];
    expect(hit.id).toBe(saved.id);
    expect(hit.snippet).toContain("死信队列");
    expect(hit.line).toBeUndefined();
    expect((await searchDocuments(root, { query: "旧式缓存" })).results).toEqual([]);
  });
});
