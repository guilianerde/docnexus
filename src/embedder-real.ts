import { DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIMENSION } from "./embedding-config.js";
import type { Embedder } from "./embedder.js";

export { DEFAULT_EMBEDDING_MODEL };

type PipelineEnv = {
  allowRemoteModels?: boolean;
  allowLocalModels?: boolean;
  localModelPath?: string;
  cacheDir?: string;
};

type FeatureExtractionResult = {
  data?: Float32Array | number[];
};

type FeatureExtractionPipeline = (
  text: string,
  options?: { pooling?: "mean"; normalize?: boolean }
) => Promise<FeatureExtractionResult>;

type PipelineOptions = {
  local_files_only?: boolean;
  cache_dir?: string;
  dtype?: "q8";
};

type PipelineFactory = (
  task: "feature-extraction",
  model: string,
  options?: PipelineOptions
) => Promise<FeatureExtractionPipeline>;

type PipelineModuleLoader = () => Promise<{ pipeline: PipelineFactory; env?: PipelineEnv }>;

async function loadPipelineFactory(): Promise<{ pipeline: PipelineFactory; env?: PipelineEnv }> {
  const module = await import("@huggingface/transformers");
  return module as unknown as { pipeline: PipelineFactory; env?: PipelineEnv };
}

export interface EmbeddingRuntimeConfig {
  provider: "local-transformers";
  model: string;
  dimension: number;
  local_only: true;
  remote_allowed: false;
  local_model_path?: string;
  cache_dir?: string;
}

export interface EmbeddingRuntimeCheck extends EmbeddingRuntimeConfig {
  ok: boolean;
  message?: string;
}

export function configureEmbeddingEnvironment(
  env: PipelineEnv | undefined,
  options: { model?: string; dimension?: number; localModelPath?: string; cacheDir?: string } = {}
): EmbeddingRuntimeConfig {
  if (env) {
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    if (options.localModelPath) {
      env.localModelPath = options.localModelPath;
    }
    if (options.cacheDir) {
      env.cacheDir = options.cacheDir;
    }
  }
  return {
    provider: "local-transformers",
    model: options.model ?? DEFAULT_EMBEDDING_MODEL,
    dimension: options.dimension ?? EMBEDDING_DIMENSION,
    local_only: true,
    remote_allowed: false,
    local_model_path: options.localModelPath,
    cache_dir: options.cacheDir
  };
}

const pipelinePromises = new Map<string, Promise<FeatureExtractionPipeline>>();

interface ResolvedRealEmbedderOptions {
  dimension: number;
  model: string;
  localModelPath?: string;
  cacheDir?: string;
  loadPipelineFactory: PipelineModuleLoader;
}

async function loadFeatureExtractionPipeline(options: ResolvedRealEmbedderOptions): Promise<FeatureExtractionPipeline> {
  const load = async () => {
    const { pipeline, env } = await options.loadPipelineFactory();
    configureEmbeddingEnvironment(env, options);
    const pipelineOptions: PipelineOptions = { local_files_only: true, dtype: "q8" };
    if (options.cacheDir) {
      pipelineOptions.cache_dir = options.cacheDir;
    }
    return pipeline("feature-extraction", options.model, pipelineOptions);
  };

  if (options.loadPipelineFactory !== loadPipelineFactory) {
    return load();
  }

  const cacheKey = `${options.model}\u0000${options.localModelPath ?? ""}\u0000${options.cacheDir ?? ""}`;
  let promise = pipelinePromises.get(cacheKey);
  if (!promise) {
    promise = load();
    pipelinePromises.set(cacheKey, promise);
  }
  return promise;
}

export interface RealEmbedderOptions {
  dimension?: number;
  model?: string;
  localModelPath?: string;
  cacheDir?: string;
  loadPipelineFactory?: PipelineModuleLoader;
}

export class RealEmbedder implements Embedder {
  readonly dimension: number;
  readonly model: string;
  private readonly localModelPath?: string;
  private readonly cacheDir?: string;
  private readonly loadPipelineFactory: PipelineModuleLoader;

  constructor(options: RealEmbedderOptions = {}) {
    const dimension = options?.dimension ?? EMBEDDING_DIMENSION;
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new Error("embedding dimension must be a positive integer");
    }
    this.dimension = dimension;
    this.model = options?.model ?? DEFAULT_EMBEDDING_MODEL;
    this.localModelPath = options.localModelPath;
    this.cacheDir = options.cacheDir;
    this.loadPipelineFactory = options.loadPipelineFactory ?? loadPipelineFactory;
  }

  async embed(text: string): Promise<number[]> {
    const normalized = text.trim();
    if (normalized.length === 0) {
      return Array.from({ length: this.dimension }, () => 0);
    }

    const extractor = await loadFeatureExtractionPipeline({
      dimension: this.dimension,
      model: this.model,
      localModelPath: this.localModelPath,
      cacheDir: this.cacheDir,
      loadPipelineFactory: this.loadPipelineFactory
    });
    const result = await extractor(normalized, { pooling: "mean", normalize: true });
    const data = Array.from(result.data ?? []);

    if (data.length !== this.dimension) {
      throw new Error(`embedding dimension mismatch: expected ${this.dimension}, got ${data.length}`);
    }

    return data;
  }
}

export async function checkRealEmbeddingRuntime(options: RealEmbedderOptions = {}): Promise<EmbeddingRuntimeCheck> {
  const embedder = new RealEmbedder(options);
  const base = configureEmbeddingEnvironment(undefined, {
    model: embedder.model,
    dimension: embedder.dimension,
    localModelPath: options.localModelPath,
    cacheDir: options.cacheDir
  });

  try {
    await embedder.embed("DocNexus local embedding health check");
    return { ...base, ok: true };
  } catch (error) {
    return {
      ...base,
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}
