import { type Embedder, LocalHashEmbedder } from "./embedder.js";
import { RealEmbedder } from "./embedder-real.js";

export function createDefaultEmbedder(): Embedder {
  if (process.env.DOCNEXUS_EMBEDDER === "hash") {
    return new LocalHashEmbedder();
  }
  return new RealEmbedder();
}

