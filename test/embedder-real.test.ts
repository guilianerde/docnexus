import { describe, expect, it } from "vitest";
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
          return async () => ({
            data: Array.from({ length: EMBEDDING_DIMENSION }, (_, index) => (index === 0 ? 1 : 0))
          });
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
});
