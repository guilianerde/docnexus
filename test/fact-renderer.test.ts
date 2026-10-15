import { describe, expect, it } from "vitest";
import { factDocumentTemplate, factReferenceIds, renderFactDocument } from "../src/fact-renderer.js";
import type { ResolvedFact } from "../src/knowledge.js";

const old: ResolvedFact = { id: "fact_daily", text: "Tokens rotate daily.", provenance: "User decision", valid_from: "2026-01-01T00:00:00Z", document_id: "doc_old", source_path: "auth.md", status: "active" };
const next: ResolvedFact = { ...old, id: "fact_hourly", text: "Tokens rotate hourly.", replaces: old.id, document_id: "doc_new", source_path: "policy.md" };
const document = "# Policy\n\n{{fact:fact_daily}}\n\nExplanation stays authored.\n";

describe("single-source fact rendering", () => {
  it("generates attributed prose while preserving the author-owned reference template", () => {
    const output = renderFactDocument(document, [old]);
    expect(output.document).toContain(old.text);
    expect(output.document).toContain("来源：User decision");
    expect(output.document).toContain("<!-- docnexus:fact fact_daily -->");
    expect(factDocumentTemplate(output.document)).toBe(document);
    expect(renderFactDocument(output.document, [old]).document).toBe(output.document);
    expect(factReferenceIds(output.document)).toEqual([old.id]);
  });

  it("follows cross-document replacements and removes stale generated values", () => {
    const initial = renderFactDocument(document, [old]).document;
    const output = renderFactDocument(initial, [{ ...old, status: "superseded", replaced_by: next.id }, next]);
    expect(output.document).toContain(next.text);
    expect(output.document).not.toContain(old.text);
    expect(output.references).toEqual([{ reference_id: old.id, fact_id: next.id, status: "active", source_document_id: next.document_id }]);
  });

  it.each(["expired", "withdrawn", "scheduled"] as const)("does not render %s claims as current facts", (status) => {
    const output = renderFactDocument(document, [{ ...old, status }]);
    expect(output.document).not.toContain(old.text);
    expect(output.document).toContain("当前无有效结论");
    expect(factDocumentTemplate(output.document)).toBe(document);
  });

  it("keeps code examples literal and preserves CRLF, indentation and missing final newlines", () => {
    const example = "```md\n{{fact:fact_unknown}}\n<!-- docnexus:fact fact_unknown -->\n```\n";
    expect(renderFactDocument(example, []).document).toBe(example);
    for (const input of ["  {{fact:fact_daily}}\r\n", "{{fact:fact_daily}}", "{{fact:fact_daily}}\r\n\r\nText.", "Before\r{{fact:fact_daily}}\rAfter"]) {
      const output = renderFactDocument(input, [old]);
      expect(factDocumentTemplate(output.document)).toBe(input);
    }
    expect(factDocumentTemplate("Legacy\rparagraph\r")).toBe("Legacy\rparagraph\r");
  });

  it("rejects malformed or missing references and escapes control syntax in generated content", () => {
    expect(() => renderFactDocument(document, [])).toThrow("unknown fact reference");
    expect(() => factDocumentTemplate("<!-- docnexus:fact fact_daily -->\nMissing close")).toThrow("unclosed");
    expect(() => factDocumentTemplate("<!-- /docnexus:fact -->")).toThrow("invalid fact reference");
    expect(() => factDocumentTemplate("{{fact:bad}}\n")).toThrow("invalid fact reference");
    const injected = { ...old, text: "<!-- /docnexus:fact --> {{fact:fact_other}}\n# Heading", provenance: "Untrusted <script>" };
    const output = renderFactDocument(document, [injected]);
    expect(factDocumentTemplate(output.document)).toBe(document);
    expect(output.document).toContain("&lt;script&gt;");
  });
});
