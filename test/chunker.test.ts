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

  it("bounds long paragraphs by tokenizer length including special tokens", () => {
    const tokenBudget = { maxTokens: 96, countTokens: (text: string) => Array.from(text).reduce((sum, character) => sum + (/[\u4e00-\u9fff]/.test(character) ? 2 : 1), 2) };
    const content = "# 部署\n\n" + "这是一段没有空行的部署说明。".repeat(80) + "最终结论：故障恢复后检查队列。";
    const chunks = chunkText(content, { tokenBudget });
    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.every((chunk) => tokenBudget.countTokens(chunk.text) <= tokenBudget.maxTokens)).toBe(true);
    expect(chunks.at(-1)!.text).toContain("最终结论：故障恢复后检查队列。");
    expect(chunks.at(-1)!.text).toContain("# 部署");
    expect(chunkText(content, { tokenBudget })).toEqual(chunks);
  });

  it("splits long code while retaining lines and ignoring headings inside fences", () => {
    const lines = Array.from({ length: 50 }, (_, index) => `const setting_${index} = "release_value_${index}";`);
    const content = `# Runtime\n\n\`\`\`js\n# fake heading\n${lines.join("\n")}\n\`\`\`\n\nEnd of runtime policy.`;
    const tokenBudget = { maxTokens: 128, countTokens: (text: string) => Array.from(text).length + 2 };
    const chunks = chunkText(content, { tokenBudget });
    expect(chunks.every((chunk) => tokenBudget.countTokens(chunk.text) <= 128)).toBe(true);
    expect(lines.every((line) => chunks.some((chunk) => chunk.text.includes(line)))).toBe(true);
    expect(chunks.at(-1)!.text).toContain("# Runtime");
    expect(chunks.at(-1)!.text).not.toContain("# fake heading");
    expect(chunks.at(-1)!.text).toContain("End of runtime policy.");
  });

  it("also bounds a single oversized paragraph without a tokenizer", () => {
    const chunks = chunkText("字".repeat(3000), { targetSize: 200 });
    expect(chunks.every((chunk) => chunk.text.length <= 200)).toBe(true);
    expect(chunks.length).toBeGreaterThan(10);
  });

  it("does not cut a Unicode surrogate pair at a hard boundary", () => {
    const chunks = chunkText("🧠".repeat(300), { targetSize: 31 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(chunk.text))).toBe(true);
  });

  it("covers every original character in order despite overlaps", () => {
    const content = Array.from({ length: 1800 }, (_, index) => String.fromCodePoint(0x4e00 + index)).join("");
    const chunks = chunkText(content, { tokenBudget: { maxTokens: 96, countTokens: (text) => Array.from(text).length + 2 } });
    let covered = 0;
    for (const chunk of chunks) {
      const start = content.indexOf(chunk.text);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start).toBeLessThanOrEqual(covered);
      expect(start + chunk.text.length).toBeGreaterThan(covered);
      covered = start + chunk.text.length;
    }
    expect(covered).toBe(content.length);
  });
});
