import { describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSION } from "../src/embedding-config.js";
import { LocalHashEmbedder, cosineSimilarity } from "../src/embedder.js";

describe("LocalHashEmbedder", () => {
  it("creates stable vectors with a fixed dimension", async () => {
    const embedder = new LocalHashEmbedder(32);

    const first = await embedder.embed("DocNexus local recall");
    const second = await embedder.embed("DocNexus local recall");

    expect(first).toHaveLength(32);
    expect(second).toEqual(first);
  });

  it("creates different vectors for different text", async () => {
    const embedder = new LocalHashEmbedder(32);

    expect(await embedder.embed("archive record")).not.toEqual(await embedder.embed("delete index"));
  });

  it("computes cosine similarity", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("rejects dimension mismatches", () => {
    expect(() => cosineSimilarity([1, 0], [1])).toThrow("embedding dimension mismatch");
  });

  it("uses the shared embedding dimension by default", async () => {
    const embedder = new LocalHashEmbedder();

    expect(embedder.dimension).toBe(EMBEDDING_DIMENSION);
    expect(await embedder.embed("dimension check")).toHaveLength(EMBEDDING_DIMENSION);
  });
});
