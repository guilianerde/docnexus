import { sha256 } from "./hash.js";

export interface TextChunk {
  index: number;
  text: string;
  text_hash: string;
}

export interface ChunkTextOptions {
  targetSize?: number;
}

const defaultTargetSize = 1000;

export function chunkText(content: string, options: ChunkTextOptions = {}): TextChunk[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    throw new Error("file content is empty");
  }

  const targetSize = options.targetSize ?? defaultTargetSize;
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }

    const next = `${current}\n\n${paragraph}`;
    if (next.length <= targetSize) {
      current = next;
      continue;
    }

    chunks.push(current);
    current = paragraph;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.map((text, index) => ({
    index,
    text,
    text_hash: sha256(text)
  }));
}
