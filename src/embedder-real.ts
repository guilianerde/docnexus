import { EMBEDDING_DIMENSION } from "./embedding-config.js";
import type { Embedder } from "./embedder.js";

const DEFAULT_MODEL = "BAAI/bge-small-zh-v1.5";

type PipelineEnv = {
  allowRemoteModels?: boolean;
  allowLocalModels?: boolean;
};

type FeatureExtractionResult = {
  data?: Float32Array | number[];
};

type FeatureExtractionPipeline = (
  text: string,
  options?: { pooling?: "mean"; normalize?: boolean }
) => Promise<FeatureExtractionResult>;

type PipelineFactory = (
  task: "feature-extraction",
  model: string
) => Promise<FeatureExtractionPipeline>;

async function loadPipelineFactory(): Promise<{ pipeline: PipelineFactory; env?: PipelineEnv }> {
  const module = await import("@xenova/transformers");
  return module as unknown as { pipeline: PipelineFactory; env?: PipelineEnv };
}

let pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

async function getPipeline(model: string): Promise<FeatureExtractionPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await loadPipelineFactory();
      if (env) {
        env.allowLocalModels = true;
        env.allowRemoteModels = true;
      }
      return pipeline("feature-extraction", model);
    })();
  }
  return pipelinePromise;
}

export class RealEmbedder implements Embedder {
  readonly dimension: number;
  readonly model: string;

  constructor(options?: { dimension?: number; model?: string }) {
    const dimension = options?.dimension ?? EMBEDDING_DIMENSION;
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new Error("embedding dimension must be a positive integer");
    }
    this.dimension = dimension;
    this.model = options?.model ?? DEFAULT_MODEL;
  }

  async embed(text: string): Promise<number[]> {
    const normalized = text.trim();
    if (normalized.length === 0) {
      return Array.from({ length: this.dimension }, () => 0);
    }

    const extractor = await getPipeline(this.model);
    const result = await extractor(normalized, { pooling: "mean", normalize: true });
    const data = Array.from(result.data ?? []);

    if (data.length !== this.dimension) {
      throw new Error(`embedding dimension mismatch: expected ${this.dimension}, got ${data.length}`);
    }

    return data;
  }
}

