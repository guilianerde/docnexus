import { type Embedder, LocalHashEmbedder } from "./embedder.js";
import { resolveEmbeddingModelsRoot } from "./embedding-models.js";
import {
  DEFAULT_EMBEDDING_MODEL,
  checkRealEmbeddingRuntime,
  type EmbeddingRuntimeCheck,
  RealEmbedder
} from "./embedder-real.js";

export interface HashEmbeddingRuntimeCheck {
  ok: true;
  provider: "local-hash";
  model: "LocalHashEmbedder";
  dimension: number;
  local_only: true;
  remote_allowed: false;
}

export type DefaultEmbeddingRuntimeCheck = EmbeddingRuntimeCheck | HashEmbeddingRuntimeCheck;

export function createDefaultEmbedder(projectRoot?: string): Embedder {
  if (process.env.DOCNEXUS_EMBEDDER === "hash") {
    return new LocalHashEmbedder();
  }
  return new RealEmbedder({ localModelPath: resolveEmbeddingModelsRoot(projectRoot) });
}

export async function checkEmbeddingRuntime(projectRoot?: string): Promise<DefaultEmbeddingRuntimeCheck> {
  if (process.env.DOCNEXUS_EMBEDDER === "hash") {
    const embedder = new LocalHashEmbedder();
    await embedder.embed("DocNexus local hash embedding health check");
    return {
      ok: true,
      provider: "local-hash",
      model: "LocalHashEmbedder",
      dimension: embedder.dimension,
      local_only: true,
      remote_allowed: false
    };
  }
  const result = await checkRealEmbeddingRuntime({ localModelPath: resolveEmbeddingModelsRoot(projectRoot) });
  if (!result.ok && /local_files_only|allowRemoteModels=false|not found locally|fetch failed/i.test(result.message ?? "")) {
    return {
      ...result,
      message: `Local embedding model ${DEFAULT_EMBEDDING_MODEL} is unavailable. ${result.message}`
    };
  }
  return result;
}
