import type { ResolvedFact } from "./knowledge.js";

type Segment = { text: string } | { id: string; indent: string; ending: string };
const ID = "fact_[A-Za-z0-9_-]{1,120}";
const TOKEN = new RegExp(`^([ \\t]*)\\{\\{fact:(${ID})\\}\\}[ \\t]*$`);
const OPEN = new RegExp(`^([ \\t]*)<!-- docnexus:fact (${ID}) -->[ \\t]*$`);
const CLOSE = "<!-- /docnexus:fact -->";

/** Keep author-owned text and reference ids; discard generated block contents. */
function parse(document: string): Segment[] {
  const lines = document.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)!.filter((line) => line !== "");
  const segments: Segment[] = [];
  let fence: { character: string; length: number } | undefined;
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const line = raw.replace(/(?:\r\n|\n|\r)$/, "");
    const ending = raw.slice(line.length);
    const fenced = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      segments.push({ text: raw });
      if (fenced && fenced[1][0] === fence.character && fenced[1].length >= fence.length && !fenced[2].trim()) fence = undefined;
      continue;
    }
    if (fenced) {
      fence = { character: fenced[1][0], length: fenced[1].length };
      segments.push({ text: raw });
      continue;
    }
    const token = TOKEN.exec(line);
    if (token) { segments.push({ id: token[2], indent: token[1], ending }); continue; }
    const open = OPEN.exec(line);
    if (open) {
      let closed = false;
      while (++index < lines.length) {
        const content = lines[index].replace(/(?:\r\n|\n|\r)$/, "");
        if (content.trim() === CLOSE) {
          segments.push({ id: open[2], indent: open[1], ending: lines[index].slice(content.length) });
          closed = true;
          break;
        }
        if (content.trim().startsWith("<!-- docnexus:fact")) throw new Error("nested generated fact block");
      }
      if (!closed) throw new Error(`unclosed generated fact block: ${open[2]}`);
      continue;
    }
    if (line.trim().startsWith("<!-- docnexus:fact") || line.trim() === CLOSE || line.trim().startsWith("{{fact:")) {
      throw new Error("invalid fact reference; use {{fact:fact_id}} on a standalone line");
    }
    segments.push({ text: raw });
  }
  return segments;
}

export function factDocumentTemplate(document: string): string {
  return parse(document).map((segment) => "text" in segment ? segment.text : `${segment.indent}{{fact:${segment.id}}}${segment.ending}`).join("");
}

export function factReferenceIds(document: string): string[] {
  return [...new Set(parse(document).flatMap((segment) => "id" in segment ? [segment.id] : []))];
}

function escapeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_\[\]{}#|~]/g, "\\$&");
}

export interface RenderedFactReference {
  reference_id: string;
  fact_id: string;
  status: ResolvedFact["status"];
  source_document_id: string;
}

export interface RenderedFactSpan {
  start: number; end: number; template_start: number; template_end: number; fact_id: string;
}

export function renderFactDocument(document: string, facts: ResolvedFact[]): { document: string; references: RenderedFactReference[]; fact_spans: RenderedFactSpan[] } {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const references: RenderedFactReference[] = [];
  const spans: RenderedFactSpan[] = [];
  let offset = 0, templateOffset = 0;
  const rendered = parse(document).map((segment) => {
    if ("text" in segment) { offset += segment.text.length; templateOffset += segment.text.length; return segment.text; }
    let fact = byId.get(segment.id);
    if (!fact) throw new Error(`unknown fact reference: ${segment.id}`);
    const seen = new Set<string>();
    while (fact.status === "superseded" && fact.replaced_by) {
      if (seen.has(fact.id)) throw new Error(`cyclic fact reference: ${segment.id}`);
      seen.add(fact.id);
      const successor = byId.get(fact.replaced_by);
      if (!successor) throw new Error(`unknown replacement fact: ${fact.replaced_by}`);
      fact = successor;
    }
    references.push({ reference_id: segment.id, fact_id: fact.id, status: fact.status, source_document_id: fact.document_id });
    const status = { scheduled: "尚未生效", expired: "已到期", withdrawn: "已撤回", superseded: "已被替代" };
    const body = fact.status === "active" ? escapeText(fact.text) : `*此事实${status[fact.status]}，当前无有效结论。*`;
    const attribution = `> 来源：${escapeText(fact.provenance)}；生效：${escapeText(fact.valid_from)}；出处：${escapeText(fact.source_path)}；事实：\`${fact.id}\`；状态：${fact.status}`;
    const newline = segment.ending || "\n";
    const block = [`<!-- docnexus:fact ${segment.id} -->`, body, "", attribution, CLOSE]
      .map((line) => `${segment.indent}${line}`).join(newline) + segment.ending;
    const template = `${segment.indent}{{fact:${segment.id}}}${segment.ending}`;
    spans.push({ start: offset, end: offset + block.length, template_start: templateOffset, template_end: templateOffset + template.length, fact_id: fact.id });
    offset += block.length; templateOffset += template.length;
    return block;
  }).join("");
  return { document: rendered, references, fact_spans: spans };
}
