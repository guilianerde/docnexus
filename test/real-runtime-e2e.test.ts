import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EMBEDDING_DIMENSION } from "../src/embedding-config.js";
import {
  DEFAULT_EMBEDDING_MODEL,
  bundledEmbeddingModelsPath,
  resolveEmbeddingModelsRoot
} from "../src/embedding-models.js";
import { listManagedChunks } from "../src/managed-documents.js";

const tempRoots: string[] = [];
const previousEmbedder = process.env.DOCNEXUS_EMBEDDER;
const previousFetch = globalThis.fetch;
const networkAttempts: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-real-runtime-"));
  tempRoots.push(root);
  return root;
}

beforeAll(() => {
  delete process.env.DOCNEXUS_EMBEDDER;
  globalThis.fetch = (async (input: string | URL | Request) => {
    networkAttempts.push(String(input));
    throw new Error(`real runtime E2E forbids network access: ${String(input)}`);
  }) as typeof globalThis.fetch;
});

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

afterAll(() => {
  globalThis.fetch = previousFetch;
  if (previousEmbedder === undefined) {
    delete process.env.DOCNEXUS_EMBEDDER;
  } else {
    process.env.DOCNEXUS_EMBEDDER = previousEmbedder;
  }
});

describe("real local ONNX runtime", () => {
  it("initializes, embeds, stores, recalls, and serves a document without network access", async () => {
    const projectRoot = await makeRoot();
    const bundledModelsRoot = bundledEmbeddingModelsPath();
    const modelRoot = join(bundledModelsRoot, ...DEFAULT_EMBEDDING_MODEL.split("/"));

    expect(process.env.DOCNEXUS_EMBEDDER).toBeUndefined();
    const bundledOnnx = await stat(join(modelRoot, "onnx", "model_quantized.onnx"));
    expect(bundledOnnx.isFile()).toBe(true);
    expect(bundledOnnx.size).toBeGreaterThan(1_000_000);
    expect(resolveEmbeddingModelsRoot(projectRoot)).toBe(bundledModelsRoot);

    const initialized = JSON.parse(await runCli(["init"], projectRoot));
    expect(initialized).toMatchObject({ project_root: projectRoot, initialized: true });
    await expect(stat(join(projectRoot, "docnexus", "store", "models"))).rejects.toThrow();

    const draft = JSON.parse(await runCli(["draft", "new", "--slug", "onnx"], projectRoot));
    const sourcePath = join(projectRoot, draft.artifacts.source);
    const documentPath = join(projectRoot, draft.artifacts.document);
    const metadataPath = join(projectRoot, draft.artifacts.metadata);
    const source = "DocNexus must load its bundled ONNX model locally. DocNexus 必须离线加载随包 ONNX 模型。";
    const document = [
      "# DocNexus 本地检索",
      "",
      "DocNexus uses its bundled ONNX embedding model for local semantic recall.",
      "DocNexus 使用随包的 ONNX 嵌入模型执行离线语义检索。"
    ].join("\n");
    const metadata = {
      title: "DocNexus Local ONNX Runtime",
      summary: "DocNexus uses a bundled local ONNX model for offline semantic recall.",
      tags: ["onnx", "local-only"],
      entities: [
        {
          name: "DocNexus",
          type: "tool",
          description: "The local project-memory service under end-to-end test."
        },
        {
          name: "ONNX Embedding",
          type: "component",
          description: "The bundled local embedding runtime used by DocNexus."
        }
      ],
      relationships: [
        {
          from: "DocNexus",
          to: "ONNX Embedding",
          type: "depends_on",
          description: "DocNexus uses the bundled model for semantic retrieval."
        }
      ]
    };
    await writeFile(sourcePath, source);
    await writeFile(documentPath, document);
    await writeFile(metadataPath, JSON.stringify(metadata));

    await runCli(["draft", "seal", "--id", draft.draft_id, "--file", "docs/memory/local-onnx.md"], projectRoot);
    const record = JSON.parse(await runCli(["document", "add", "--draft", draft.draft_id], projectRoot));

    expect(record).toMatchObject({
      file_path: "docs/memory/local-onnx.md",
      operation: "created",
      chunk_count: 1
    });
    expect(await readFile(join(projectRoot, "docnexus", "library", record.file_path), "utf8")).toBe(document);

    const chunks = await listManagedChunks(projectRoot, record.id);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].embedding).toHaveLength(EMBEDDING_DIMENSION);
    expect(chunks[0].embedding.every(Number.isFinite)).toBe(true);
    expect(chunks[0].embedding.filter((value) => Math.abs(value) > 1e-8).length).toBeGreaterThan(400);
    const magnitude = Math.sqrt(chunks[0].embedding.reduce((sum, value) => sum + value * value, 0));
    expect(magnitude).toBeCloseTo(1, 4);

    const recalled = JSON.parse(
      await runCli(["recall", "bundled ONNX 离线语义检索", "--limit", "1"], projectRoot)
    );
    expect(recalled.results).toHaveLength(1);
    expect(recalled.results[0]).toMatchObject({
      matched_chunk: { text: expect.stringContaining("bundled ONNX embedding model") },
      document_ref: { document_id: record.id, path: "docs/memory/local-onnx.md" }
    });
    expect(recalled.context_groups[0]).toMatchObject({
      document: { document_id: record.id, path: "docs/memory/local-onnx.md" },
      graph_context: {
        concepts: expect.arrayContaining(["DocNexus", "ONNX Embedding"])
      }
    });

    expect(JSON.parse(await runCli(["status"], projectRoot))).toMatchObject({
      initialized: true,
      document_count: 1
    });
    expect(JSON.parse(await runCli(["document", "get", "--id", record.id, "--include", "document,metadata"], projectRoot))).toMatchObject({
      id: record.id,
      file_path: "docs/memory/local-onnx.md",
      document,
      metadata: {
        entities: expect.arrayContaining([expect.objectContaining({ name: "DocNexus" })])
      }
    });

    const { env } = await import("@huggingface/transformers");
    expect(env.allowLocalModels).toBe(true);
    expect(env.allowRemoteModels).toBe(false);
    expect(env.localModelPath).toBe(bundledModelsRoot);
    expect(networkAttempts).toEqual([]);
  }, 120_000);
});
