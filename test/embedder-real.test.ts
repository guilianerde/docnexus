import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EMBEDDING_MODEL,
  RealEmbedder,
  configureEmbeddingEnvironment
} from "../src/embedder-real.js";
import { EMBEDDING_DIMENSION } from "../src/embedding-config.js";

describe("RealEmbedder", () => {
  it("configures transformers for local-only model loading", () => {
    const env = {
      allowLocalModels: false,
      allowRemoteModels: true,
      localModelPath: "/old-models/",
      cacheDir: "/old-cache/"
    };

    const config = configureEmbeddingEnvironment(env, {
      localModelPath: "/docnexus-models/",
      cacheDir: "/docnexus-cache/"
    });

    expect(env).toEqual({
      allowLocalModels: true,
      allowRemoteModels: false,
      localModelPath: "/docnexus-models/",
      cacheDir: "/docnexus-cache/"
    });
    expect(config).toMatchObject({
      provider: "local-transformers",
      model: DEFAULT_EMBEDDING_MODEL,
      dimension: EMBEDDING_DIMENSION,
      local_only: true,
      remote_allowed: false,
      local_model_path: "/docnexus-models/",
      cache_dir: "/docnexus-cache/"
    });
  });

  it("passes local_files_only when loading the feature extraction pipeline", async () => {
    const calls: unknown[][] = [];
    const env = {};
    const embedder = new RealEmbedder({
      loadPipelineFactory: async () => ({
        env,
        pipeline: async (...args) => {
          calls.push(args);
          return Object.assign(async () => ({
            data: Array.from({ length: EMBEDDING_DIMENSION }, (_, index) => (index === 0 ? 1 : 0))
          }), { tokenizer: { model_max_length: 512, encode: () => [101, 42, 102] } });
        }
      })
    });

    const vector = await embedder.embed("DocNexus local embedding probe");

    expect(vector).toHaveLength(EMBEDDING_DIMENSION);
    expect(calls).toEqual([
      [
        "feature-extraction",
        DEFAULT_EMBEDDING_MODEL,
        {
          local_files_only: true,
          dtype: "q8"
        }
      ]
    ]);
    expect(env).toMatchObject({
      allowLocalModels: true,
      allowRemoteModels: false
    });
  });

  it("counts special tokens, uses the lower model limit and refuses silent truncation", async () => {
    const extract = vi.fn().mockResolvedValue({ data: Array(512).fill(0) });
    const encode = vi.fn((text: string) => [101, ...Array.from(text).map(() => 42), 102]);
    const pipeline = vi.fn().mockResolvedValue(Object.assign(extract, {
      tokenizer: { model_max_length: 12, encode }, model: { config: { max_position_embeddings: 10 } }
    }));
    const embedder = new RealEmbedder({ loadPipelineFactory: async () => ({ pipeline }) });
    const budget = await embedder.tokenBudget();
    expect(budget.maxTokens).toBe(10);
    expect(budget.countTokens("中文")).toBe(4);
    await expect(embedder.embed("字".repeat(9))).rejects.toThrow("11 > 10");
    expect(extract).not.toHaveBeenCalled();
    await embedder.embed("字".repeat(8));
    expect(extract).toHaveBeenCalledOnce();
    expect(pipeline).toHaveBeenCalledOnce();
    expect(encode).toHaveBeenCalledWith("中文", { add_special_tokens: true });
    const withoutTokenizerLimit = new RealEmbedder({ loadPipelineFactory: async () => ({ pipeline: async () => Object.assign(extract, {
      tokenizer: { encode }, model: { config: { max_position_embeddings: 10 } }
    }) }) });
    expect((await withoutTokenizerLimit.tokenBudget()).maxTokens).toBe(10);
  });
});
