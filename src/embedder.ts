import { createHash } from "node:crypto";
import { EMBEDDING_DIMENSION } from "./embedding-config.js";

export interface Embedder {
  dimension: number;
  embed(text: string): Promise<number[]>;
}

export class LocalHashEmbedder implements Embedder {
  readonly dimension: number;

  constructor(dimension = EMBEDDING_DIMENSION) {
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new Error("embedding dimension must be a positive integer");
    }
    this.dimension = dimension;
  }

  async embed(text: string): Promise<number[]> {
    const tokens = tokenize(text);
    const vector = Array.from({ length: this.dimension }, () => 0);

    for (const token of tokens) {
      const hash = createHash("sha256").update(token, "utf8").digest();
      const index = hash.readUInt32BE(0) % this.dimension;
      const sign = hash[4] % 2 === 0 ? 1 : -1;
      vector[index] += sign;
    }

    return normalize(vector);
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    throw new Error("embedding dimension mismatch");
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function tokenize(text: string): string[] {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu);
  return tokens && tokens.length > 0 ? tokens : [text];
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }
  return vector.map((value) => value / magnitude);
}
