import { DocNexusError } from "./errors.js";
import { factDocumentTemplate, type renderFactDocument } from "./fact-renderer.js";
import { sha256, stableJson } from "./hash.js";
import type { ResolvedFact } from "./knowledge.js";
import type { WorkspaceSnapshot } from "./workspace-snapshot.js";

export type SourceAnchor = { document_id: string; record_version: string } & (
  { kind: "document"; start: number; end: number; template_hash: string; fact_ids: string[] }
  | { kind: "fact"; fact_id: string; status: ResolvedFact["status"] }
  | { kind: "metadata"; field: "title" | "path" | "entity" | "tag" | "summary"; value: string }
);

function unicodeBoundary(text: string, offset: number): boolean {
  return offset <= 0 || offset >= text.length || !(text.charCodeAt(offset - 1) >= 0xD800 && text.charCodeAt(offset - 1) <= 0xDBFF
    && text.charCodeAt(offset) >= 0xDC00 && text.charCodeAt(offset) <= 0xDFFF);
}

/** Offsets address UTF-16 in CRLF-normalized, trimmed text, without heading prefixes. */
export function createSourceView(document: string, view: ReturnType<typeof renderFactDocument>) {
  const template = factDocumentTemplate(document);
  const normalize = (text: string) => {
    const crlf = text.includes("\r\n"), normalized = crlf ? text.replace(/\r\n/g, "\n") : text;
    const leading = normalized.length - normalized.trimStart().length, body = normalized.trim();
    return { body, offset: (position: number) => Math.max(0, Math.min(body.length, (crlf ? text.slice(0, position).replace(/\r\n/g, "\n").length : position) - leading)) };
  };
  const rendered = normalize(view.document), authored = normalize(template);
  return { template: authored.body, rendered: rendered.body, renderedOffset: rendered.offset,
    template_hash: sha256(authored.body), spans: view.fact_spans.map(span => ({ ...span,
      start: rendered.offset(span.start), end: rendered.offset(span.end), template_start: authored.offset(span.template_start), template_end: authored.offset(span.template_end) })) };
}

export function documentAnchor(snapshot: WorkspaceSnapshot, id: string, start: number, end: number): SourceAnchor {
  const view = snapshot.sourceDocument(id);
  if (!unicodeBoundary(view.rendered, start)) start--;
  if (!unicodeBoundary(view.rendered, end)) end++;
  const position = (offset: number, ending: boolean) => {
    let delta = 0;
    for (const span of view.spans) {
      if (offset <= span.start) break;
      if (offset < span.end) return ending ? span.template_end : span.template_start;
      delta += span.template_end - span.template_start - (span.end - span.start);
    }
    return offset + delta;
  };
  return { kind: "document", document_id: id, record_version: recordVersion(snapshot, id),
    start: position(start, false), end: position(end, true), template_hash: view.template_hash,
    fact_ids: [...new Set(view.spans.filter(span => span.start < end && span.end > start).map(span => span.fact_id))] };
}

export function factAnchor(snapshot: WorkspaceSnapshot, fact: ResolvedFact): SourceAnchor {
  return { kind: "fact", document_id: fact.document_id, record_version: recordVersion(snapshot, fact.document_id), fact_id: fact.id, status: fact.status };
}

export function recordVersion(snapshot: WorkspaceSnapshot, id: string): string {
  return snapshot.recordVersion(id);
}

/** Fail closed on stale/malformed projected locations rather than citing unrelated text. */
export function validateSourceAnchor(snapshot: WorkspaceSnapshot, anchor: SourceAnchor): void {
  const record = snapshot.records.find(record => record.id === anchor.document_id);
  let valid = Boolean(record && recordVersion(snapshot, anchor.document_id) === anchor.record_version);
  if (valid && anchor.kind === "document") {
    const view = snapshot.sourceDocument(anchor.document_id);
    const ids = [...new Set(view.spans.filter(span => span.template_start < anchor.end && span.template_end > anchor.start).map(span => span.fact_id))];
    valid = anchor.template_hash === view.template_hash && Number.isSafeInteger(anchor.start) && Number.isSafeInteger(anchor.end)
      && anchor.start >= 0 && anchor.end > anchor.start && anchor.end <= view.template.length
      && unicodeBoundary(view.template, anchor.start) && unicodeBoundary(view.template, anchor.end)
      && Array.isArray(anchor.fact_ids) && stableJson([...anchor.fact_ids].sort()) === stableJson(ids.sort());
  } else if (valid && anchor.kind === "fact") {
    const fact = snapshot.knowledge.facts.find(fact => fact.id === anchor.fact_id);
    valid = Boolean(fact && fact.document_id === anchor.document_id && fact.status === anchor.status);
  } else if (valid && anchor.kind === "metadata") {
    const metadata = snapshot.projectDocument(anchor.document_id).metadata;
    const values = { title: [metadata.title], path: [record!.file_path], summary: [metadata.summary], tag: metadata.tags,
      entity: metadata.entities.flatMap(entity => [entity.name, ...(entity.aliases ?? [])]) };
    valid = Object.hasOwn(values, anchor.field) && values[anchor.field].includes(anchor.value);
  } else valid = false;
  if (!valid) throw new DocNexusError("index_outdated", "retrieval source anchor is stale or invalid; synchronize the projection before delivering evidence");
}
