import { sha256 } from "./hash.js";

export interface TextChunk {
  index: number;
  text: string;
  text_hash: string;
}

export interface ChunkTextOptions {
  targetSize?: number;
  tokenBudget?: TextTokenBudget;
}

const defaultTargetSize = 1000;
const tokenTargetSize = 256;
const headingTokenLimit = 64;
const overlapTokenLimit = 32;
const contextCharacterLimit = 128;
export const CHUNKING_SIGNATURE = `bounded-v1:${defaultTargetSize}:${tokenTargetSize}:${headingTokenLimit}:${overlapTokenLimit}:${contextCharacterLimit}`;

export interface TextTokenBudget {
  maxTokens: number;
  /** Includes the special tokens the embedding model will add. */
  countTokens(text: string): number;
}

export function chunkText(content: string, options: ChunkTextOptions = {}): TextChunk[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    throw new Error("file content is empty");
  }

  const targetSize = options.targetSize ?? defaultTargetSize;
  if (!Number.isSafeInteger(targetSize) || targetSize < 1) throw new Error("targetSize must be a positive safe integer");
  const budget = options.tokenBudget
    ? { ...options.tokenBudget, maxTokens: Math.min(tokenTargetSize, options.tokenBudget.maxTokens) }
    : { maxTokens: targetSize, countTokens: (text: string) => text.length };
  if (!Number.isSafeInteger(budget.maxTokens) || budget.maxTokens < 1) throw new Error("maxTokens must be a positive safe integer");
  const characters = Array.from(normalized);
  const headings = headingContexts(normalized);
  const chunks: string[] = [];
  let start = 0;
  let headingIndex = -1;
  while (start < characters.length) {
    while (headings[headingIndex + 1]?.offset <= start) headingIndex++;
    let context = headingIndex >= 0 ? Array.from(headings[headingIndex].text).slice(0, contextCharacterLimit).join("") : "";
    const contextLimit = Math.min(headingTokenLimit, Math.floor(budget.maxTokens / 4));
    while (context && budget.countTokens(`${context}\n\n`) > contextLimit) context = Array.from(context).slice(0, Math.floor(Array.from(context).length / 2)).join("");
    const prefix = context ? `${context}\n\n` : "";
    const textAt = (end: number) => prefix + characters.slice(start, end).join("");
    let low = start + 1;
    let high = Math.min(characters.length, start + targetSize);
    let end = start;
    // Keep only verified fitting candidates; tokenizer length need not be perfectly monotonic.
    if (budget.countTokens(textAt(high)) <= budget.maxTokens) end = high;
    else while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (budget.countTokens(textAt(middle)) <= budget.maxTokens) { end = middle; low = middle + 1; }
      else high = middle - 1;
    }
    if (end === start) throw new Error("token budget cannot fit a single character with model special tokens");
    if (end < characters.length) {
      // Prefer a line, sentence or word boundary in the latter half of the window.
      const lower = start + Math.floor((end - start) / 2);
      let boundary = end;
      boundarySearch: for (const pattern of [/\n/, /[。！？.!?；;]/, /\s/]) {
        for (let index = end; index > lower; index--) {
          if (pattern.test(characters[index - 1])) { boundary = index; break boundarySearch; }
        }
      }
      if (budget.countTokens(textAt(boundary)) <= budget.maxTokens) end = boundary;
    }
    chunks.push(textAt(end));
    if (end === characters.length) break;
    let overlap = Math.min(contextCharacterLimit, Math.floor((end - start) / 4));
    const overlapLimit = Math.min(overlapTokenLimit, Math.floor(budget.maxTokens / 8));
    while (overlap && budget.countTokens(characters.slice(end - overlap, end).join("")) > overlapLimit) overlap = Math.floor(overlap / 2);
    start = end - overlap;
  }

  return chunks.map((text, index) => ({
    index,
    text,
    text_hash: sha256(text)
  }));
}

function headingContexts(content: string): Array<{ offset: number; text: string }> {
  const contexts: Array<{ offset: number; text: string }> = [];
  const headings: string[] = [];
  let offset = 0;
  let fence: string | undefined;
  for (const line of content.split("\n")) {
    offset += Array.from(line).length + 1;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    const heading = /^ {0,3}(#{1,6})\s+\S/.exec(line);
    if (heading) {
      headings.length = heading[1].length;
      headings[heading[1].length - 1] = line;
      contexts.push({ offset, text: headings.filter(Boolean).join("\n") });
    }
  }
  return contexts;
}
