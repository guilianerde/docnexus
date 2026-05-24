import { randomBytes } from "node:crypto";

export function createDocumentId(): string {
  return `doc_${randomHex()}`;
}

export function createChunkId(): string {
  return `chunk_${randomHex()}`;
}

function randomHex(): string {
  return randomBytes(8).toString("hex");
}
