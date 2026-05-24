import { describe, expect, it } from "vitest";
import { validateMetadata } from "../src/metadata.js";

const validMetadata = {
  title: "DocNexus MVP",
  summary: "DocNexus v0 archives Agent-refined source, Markdown, and metadata in a local project store for later retrieval.",
  tags: ["agent-memory", "mcp"],
  entities: [
    {
      name: "DocNexus",
      type: "component",
      description: "Local project memory archive used by coding agents."
    }
  ],
  relationships: [
    {
      from: "docnexus-document-add",
      to: "document add",
      type: "depends_on",
      description: "The skill calls the CLI document add command after producing content."
    }
  ]
};

describe("validateMetadata", () => {
  it("accepts valid metadata", () => {
    expect(validateMetadata(validMetadata)).toEqual({ valid: true, errors: [] });
  });

  it("rejects missing required fields", () => {
    const result = validateMetadata({ title: "Missing summary" });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("summary must be a non-empty string");
    expect(result.errors).toContain("tags must be an array of strings");
    expect(result.errors).toContain("entities must be an array");
    expect(result.errors).toContain("relationships must be an array");
  });

  it("rejects invalid enum values", () => {
    const result = validateMetadata({
      ...validMetadata,
      entities: [{ name: "X", type: "service", description: "bad enum" }],
      relationships: [{ from: "A", to: "B", type: "calls", description: "bad enum" }]
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("entities[0].type must be one of component, concept, protocol, decision, file, tool, other");
    expect(result.errors).toContain("relationships[0].type must be one of depends_on, mentions, implements, replaces, relates_to, decides");
  });
});
