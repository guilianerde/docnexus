import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializeProject } from "../src/project.js";
import { upsertManagedDocument } from "../src/managed-documents.js";
import { queryDocuments } from "../src/document-query.js";
import { inspectRetrievalIndex, listIndexedChunks, syncRetrievalIndex } from "../src/retrieval-index.js";
import { LocalHashEmbedder } from "../src/embedder.js";
import * as defaultEmbedding from "../src/embedder-default.js";
import { runCli } from "../src/cli.js";
import { recall } from "../src/recall.js";
import { usageMetrics, type UsageMetrics } from "../src/usage-metrics.js";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const input = { file_path: "memory.md", source: "Decision", document: "Original convention", metadata: { title: "Memory", summary: "Project convention", tags: [], entities: [], relationships: [] } };

async function within<T>(promise: Promise<T>, timeoutMs = 5000, message = "model inference held the project lock"): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally { clearTimeout(timer!); }
}

it.each(["core", "cli-index", "cli-recall", "vector"])("allows reads and writes during %s inference and retries the stale projection", async (entry) => {
  const root = await mkdtemp(join(tmpdir(), "docnexus-index-concurrency-")); roots.push(root);
  await initializeProject(root);
  const saved = await upsertManagedDocument(root, input);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let paused = false;
  const hash = new LocalHashEmbedder();
  const embedder = { dimension: hash.dimension, embed: async (text: string) => {
    if (!paused && text === input.document) { paused = true; entered.resolve(); await resume.promise; }
    return hash.embed(text);
  } };
  vi.spyOn(defaultEmbedding, "createDefaultEmbedder").mockReturnValue(embedder);
  const pending = entry === "core" ? syncRetrievalIndex(root, {}, embedder)
    : entry === "vector" ? recall(root, { query: "Find current convention", mode: "vector" }, embedder)
    : runCli(entry === "cli-index" ? ["index", "sync"] : ["recall", "Find current convention"], root);
  try {
    // Cold database startup precedes inference; retain the shorter lock check once it is paused.
    await within(entered.promise, 30_000, "model inference did not start");
    expect((await within(queryDocuments(root))).documents[0].document).toBe(input.document);
    await within(upsertManagedDocument(root, { ...input, source: "New decision", document: "Updated convention to preserve" }));
  } finally { resume.resolve(); await pending; }
  expect((await inspectRetrievalIndex(root)).in_sync).toBe(true);
  const chunks = await listIndexedChunks(root, saved.id);
  expect(chunks.map(chunk => chunk.text).join("\n")).toContain("Updated convention to preserve");
  expect(chunks.some(chunk => chunk.text === input.document)).toBe(false);
});

it("rechecks fact effective time before committing embeddings", async () => {
  const root = await mkdtemp(join(tmpdir(), "docnexus-index-time-")); roots.push(root);
  await initializeProject(root);
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const saved = await upsertManagedDocument(root, { ...input, metadata: { ...input.metadata, facts: [
    { id: "fact_expiring", text: "Temporary assertion", provenance: "Decision", valid_from: "2020-01-01T00:00:00Z", valid_until: "2026-01-02T00:00:00Z" }
  ] } });
  const hash = new LocalHashEmbedder();
  let advanced = false;
  await syncRetrievalIndex(root, {}, { dimension: hash.dimension, embed: async text => {
    if (!advanced && text.includes("Temporary assertion")) { advanced = true; vi.setSystemTime(new Date("2026-01-03T00:00:00Z")); }
    return hash.embed(text);
  } });
  expect(advanced).toBe(true);
  expect((await listIndexedChunks(root, saved.id)).some(chunk => chunk.text.includes("Temporary assertion"))).toBe(false);
  expect((await inspectRetrievalIndex(root)).in_sync).toBe(true);
});

it("replans after another model changes the index while embeddings are being prepared", async () => {
  const root = await mkdtemp(join(tmpdir(), "docnexus-index-generation-")); roots.push(root);
  await initializeProject(root);
  const saved = await upsertManagedDocument(root, input);
  const hash = new LocalHashEmbedder();
  await syncRetrievalIndex(root, {}, hash);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let bodyCalls = 0;
  const model = { dimension: hash.dimension, embed: async (text: string) => {
    if (text === input.document && ++bodyCalls === 1) { entered.resolve(); await resume.promise; }
    return (await hash.embed(text)).map(value => -value);
  } };
  const pending = syncRetrievalIndex(root, {}, model);
  try {
    // Cold database startup precedes inference; retain the shorter lock check once it is paused.
    await within(entered.promise, 30_000, "model inference did not start");
    await within(syncRetrievalIndex(root, {}, { dimension: hash.dimension, embed: async text => {
      const vector = await hash.embed(text); return [...vector.slice(1), vector[0]];
    } }));
  } finally { resume.resolve(); await pending; }
  expect(bodyCalls).toBe(2);
  const expected = (await hash.embed(input.document)).map(value => -value);
  (await listIndexedChunks(root, saved.id))[0].embedding.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 6));
});

it.each(["tokenizer", "signature"])("allows a write during %s preparation before checking the fast path", async stage => {
  const root = await mkdtemp(join(tmpdir(), "docnexus-index-probe-")); roots.push(root);
  await initializeProject(root);
  const saved = await upsertManagedDocument(root, input);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let pause = false;
  const wait = async () => { if (pause) { pause = false; entered.resolve(); await resume.promise; } };
  const hash = new LocalHashEmbedder();
  const model = { dimension: hash.dimension,
    tokenBudget: async () => {
      if (stage === "tokenizer") await wait();
      return { maxTokens: 4096, countTokens: (text: string) => text.length };
    },
    embed: async (text: string) => {
      if (stage === "signature" && text === "DocNexus embedding model signature") await wait();
      return hash.embed(text);
    }
  };
  await syncRetrievalIndex(root, {}, model);
  pause = true;
  const pending = recall(root, { query: "Updated convention" }, model);
  try {
    await within(entered.promise);
    await within(upsertManagedDocument(root, { ...input, document: "Updated convention" }));
  } finally { resume.resolve(); await pending; }
  expect((await listIndexedChunks(root, saved.id)).map(chunk => chunk.text)).toContain("Updated convention");
  expect((await inspectRetrievalIndex(root)).in_sync).toBe(true);
});

it("synchronizes an empty workspace without loading a model", async () => {
  const root = await mkdtemp(join(tmpdir(), "docnexus-index-empty-")); roots.push(root);
  await initializeProject(root);
  const unavailable = vi.fn(async (): Promise<never> => { throw new Error("model must not load"); });
  const model = { dimension: 512, tokenBudget: unavailable, embed: unavailable };
  for (let attempt = 0; attempt < 2; attempt++) expect(await syncRetrievalIndex(root, {}, model)).toMatchObject({ processed_documents: 0, embedded_chunks: 0 });
  expect(unavailable).not.toHaveBeenCalled();
});

it("detects fact expiry during the signature probe before taking the fast path", async () => {
  const root = await mkdtemp(join(tmpdir(), "docnexus-index-probe-expiry-")); roots.push(root);
  await initializeProject(root);
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const saved = await upsertManagedDocument(root, { ...input, document: "{{fact:fact_probe_expiry}}", metadata: { ...input.metadata, facts: [
    { id: "fact_probe_expiry", text: "Temporary assertion", provenance: "Decision", valid_from: "2020-01-01T00:00:00Z", valid_until: "2026-01-02T00:00:00Z" }
  ] } });
  const hash = new LocalHashEmbedder();
  let expire = false;
  const model = { dimension: hash.dimension, embed: async (text: string) => {
    if (expire && text === "DocNexus embedding model signature") vi.setSystemTime(new Date("2026-01-03T00:00:00Z"));
    return hash.embed(text);
  } };
  await syncRetrievalIndex(root, {}, model);
  expire = true;
  const metrics: UsageMetrics = {};
  const result = await usageMetrics.run(metrics, () => recall(root, { query: "Temporary assertion" }, model));
  expect(result.as_of).toBe("2026-01-03T00:00:00.000Z");
  expect(metrics.sync_processed_documents).toBe(1);
  expect((await listIndexedChunks(root, saved.id)).some(chunk => chunk.text.includes("Temporary assertion"))).toBe(false);
  expect((await inspectRetrievalIndex(root)).in_sync).toBe(true);
});
