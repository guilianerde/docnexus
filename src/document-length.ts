import { DocNexusError } from "./errors.js";

export const MAX_REFINED_DOCUMENT_CHARACTERS = 4000;

/** Count the complete rendered Markdown, not UTF-16 units or model tokens. */
export function assertRefinedDocumentLength(document: string, filePath: string): void {
  const characters = [...document].length;
  if (characters > MAX_REFINED_DOCUMENT_CHARACTERS) {
    throw new DocNexusError("document_too_long",
      `refined document ${filePath} has ${characters} Unicode characters (limit ${MAX_REFINED_DOCUMENT_CHARACTERS}); ask the agent to split it into two self-contained topic drafts, then seal and ingest each; split again if needed. Do not truncate knowledge or source material.`,
      { file_path: filePath, characters, max_characters: MAX_REFINED_DOCUMENT_CHARACTERS });
  }
}
