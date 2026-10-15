import { randomBytes } from "node:crypto";

export function createDocumentId(): string {
  return `doc_${randomHex()}`;
}



function randomHex(): string {
  return randomBytes(8).toString("hex");
}

export function createChunkId(): string {
  return `chunk_${randomHex()}`;
}
