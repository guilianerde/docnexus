import { describe, expect, it } from "vitest";
import { chunkText } from "../src/chunker.js";

describe("chunkText", () => {
  it("rejects empty content", () => {
    expect(() => chunkText(" \n\t ")).toThrow("file content is empty");
  });

  it("returns one chunk for short content", () => {
    const chunks = chunkText("# Title\n\nA short paragraph.");

    expect(chunks).toEqual([
      {
        index: 0,
        text: "# Title\n\nA short paragraph.",
        text_hash: expect.stringMatching(/^[0-9a-f]{64}$/)
      }
    ]);
  });

  it("splits long content into stable ordered chunks", () => {
    const paragraph = "DocNexus keeps local project memory for agents. ".repeat(12).trim();
    const content = Array.from({ length: 8 }, (_, index) => `${paragraph} Section ${index}.`).join("\n\n");

    const chunks = chunkText(content, { targetSize: 500 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index));
    expect(chunks.every((chunk) => chunk.text.trim().length > 0)).toBe(true);
    expect(new Set(chunks.map((chunk) => chunk.text_hash)).size).toBe(chunks.length);
  });
});
