import { DocNexusError, PROTOCOL_VERSION } from "./errors.js";
import { factDocumentTemplate } from "./fact-renderer.js";
import { sha256, stableJson } from "./hash.js";
import { factsForDocuments } from "./knowledge.js";
import type { GroupedRecallData, RecallContextGroup } from "./recall-groups.js";
import type { WorkspaceSnapshot } from "./workspace-snapshot.js";

export type EvidenceUnit = "window" | "section" | "page";
export interface EvidenceOptions { return_unit?: EvidenceUnit; context_budget?: number }
export interface EvidenceBlock {
  kind: "document" | "fact" | "relationship";
  document_id: string;
  path: string;
  record_version: string;
  observed_at: string | null;
  text: string;
  truncated: boolean;
  role: "primary" | "supporting";
  unit?: EvidenceUnit;
  fallback_reason?: "anchor_not_located" | "no_section";
  fact?: { id: string; status: string; provenance: string; valid_from: string; valid_until?: string; replaces?: string; replaced_by?: string; withdrawn_at?: string };
}

export function validateEvidenceOptions(options: EvidenceOptions) {
  const unit = options.return_unit ?? "window";
  const budget = options.context_budget ?? 4000;
  if (!["window", "section", "page"].includes(unit)) throw new DocNexusError("invalid_params", "return_unit must be window, section or page");
  if (!Number.isSafeInteger(budget) || budget < 512 || budget > 1_000_000) throw new DocNexusError("invalid_params", "context_budget must be an integer between 512 and 1000000");
  return { unit, budget };
}

/** Locate exact source text, including chunks with the chunker's heading prefix. */
function locate(body: string, chunk: string): { start: number; end: number } | undefined {
  for (const candidate of [chunk, chunk.replace(/^(?:#{1,6}[^\n]*\n)+\n?/, "")]) {
    const text = candidate.trim();
    const start = text ? body.indexOf(text) : -1;
    if (start >= 0) return { start, end: start + text.length };
  }
  return undefined;
}

function documentText(body: string, group: RecallContextGroup, unit: EvidenceUnit) {
  const anchor = locate(body, group.matched_chunks[0].text);
  if (unit === "page") return { text: body, unit };
  if (!anchor) return { text: body, unit: "page" as const, fallback_reason: "anchor_not_located" as const };
  if (unit === "section") {
    const headings: Array<{ start: number; level: number }> = [];
    let offset = 0, fence: { char: string; length: number } | undefined;
    for (const line of body.split("\n")) {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) { if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined; }
      else if (marker) fence = { char: marker[1][0], length: marker[1].length };
      else { const match = /^ {0,3}(#{1,6})\s+\S/.exec(line); if (match) headings.push({ start: offset, level: match[1].length }); }
      offset += line.length + 1;
    }
    const heading = headings.filter(value => value.start <= anchor.start).at(-1);
    if (heading) {
      const end = headings.find(value => value.start >= anchor.end && value.level <= heading.level)?.start ?? body.length;
      return { text: body.slice(heading.start, end), unit };
    }
  }
  const ranges = [...group.matched_chunks, ...group.same_document_chunks].flatMap(chunk => {
    const span = locate(body, chunk.text); return span ? [span] : [];
  }).sort((a, b) => a.start - b.start);
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const prior = merged.at(-1);
    if (prior && range.start <= prior.end) prior.end = Math.max(prior.end, range.end);
    else merged.push({ ...range });
  }
  return { text: merged.map(range => body.slice(range.start, range.end)).join("\n\n[… omitted …]\n\n"), unit: "window" as const,
    ...(unit === "section" ? { fallback_reason: "no_section" as const } : {}) };
}

/** Budget the complete pretty-printed JSON, using a conservative, explicitly named estimate. */
export function assembleEvidence(snapshot: WorkspaceSnapshot, query: string, grouped: GroupedRecallData, options: EvidenceOptions = {}) {
  const { unit, budget } = validateEvidenceOptions(options);
  const packet = {
    protocol_version: PROTOCOL_VERSION, query, as_of: snapshot.at, snapshot_revision: snapshot.revision,
    delivery: { requested_unit: unit, budget_tokens: budget, estimated_tokens: 0,
      token_counter: "utf8_bytes_conservative_estimate", scope: "complete_json_response", truncated: false, omitted_blocks: 0 },
    evidence: [] as EvidenceBlock[]
  };
  const cost = () => {
    for (let pass = 0; pass < 4; pass++) {
      const size = Buffer.byteLength(JSON.stringify(packet, null, 2) + "\n", "utf8");
      if (size === packet.delivery.estimated_tokens) break;
      packet.delivery.estimated_tokens = size;
    }
    return packet.delivery.estimated_tokens;
  };
  const records = new Map(snapshot.records.map(record => [record.id, record]));
  const documents = new Map(snapshot.documents.map(document => [document.id, document]));
  const citation = (id: string) => {
    const record = records.get(id)!;
    return { document_id: id, path: record.file_path, record_version: sha256(stableJson(record)),
      observed_at: documents.get(id)!.metadata.observed_at ?? null };
  };
  const candidates: EvidenceBlock[] = [];
  const focus = new Map<EvidenceBlock, number>();
  const seenFacts = new Set<string>();
  for (const group of grouped.context_groups) {
    const id = group.document.document_id;
    // Rendered fact blocks are represented once, as atomic attributed fact evidence.
    const body = factDocumentTemplate(snapshot.renderDocument(id).document).replace(/\r\n/g, "\n").trim();
    const selected = documentText(body, group, unit);
    const primary: EvidenceBlock = { kind: "document", ...citation(id), role: "primary", ...selected, truncated: false };
    candidates.push(primary);
    focus.set(primary, locate(selected.text, group.matched_chunks[0].text)?.start ?? 0);
    for (const fact of factsForDocuments(snapshot.knowledge.facts, [id], snapshot.documents)) {
      if (seenFacts.has(fact.id)) continue;
      seenFacts.add(fact.id);
      candidates.push({ kind: "fact", ...citation(fact.document_id), role: "primary", truncated: false,
        observed_at: null,
        text: fact.status === "active" ? fact.text : `Historical or future fact: ${fact.status}; not a current assertion.`,
        fact: { id: fact.id, status: fact.status, provenance: fact.provenance, valid_from: fact.valid_from,
          ...(fact.valid_until ? { valid_until: fact.valid_until } : {}), ...(fact.replaces ? { replaces: fact.replaces } : {}),
          ...(fact.replaced_by ? { replaced_by: fact.replaced_by } : {}), ...(fact.withdrawn_at ? { withdrawn_at: fact.withdrawn_at } : {}) } });
    }
  }
  for (const group of grouped.context_groups) {
    for (const path of group.graph_context.paths) if (path.source_document_id && records.has(path.source_document_id)) {
      candidates.push({ kind: "relationship", ...citation(path.source_document_id), role: "supporting", truncated: false,
        observed_at: null,
        text: `${path.from} ${path.relationship} ${path.to}: ${path.description ?? ""}` });
    }
    for (const chunk of group.graph_context.supporting_chunks) if (records.has(chunk.document_id)) {
      // Use canonical authored text, never materialized fact fragments from the index.
      const body = factDocumentTemplate(snapshot.renderDocument(chunk.document_id).document);
      const span = locate(body, chunk.text);
      if (span) candidates.push({ kind: "document", ...citation(chunk.document_id), role: "supporting", unit: "window", truncated: false, text: body.slice(span.start, span.end) });
    }
  }
  // Reserve room for final omission counters/flags before packing any evidence.
  const byEvidence = new Map<string, EvidenceBlock>();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.kind, candidate.document_id, candidate.fact?.id ?? candidate.text]);
    if (!byEvidence.has(key)) byEvidence.set(key, candidate);
  }
  const unique = [...byEvidence.values()];
  packet.delivery.omitted_blocks = unique.length;
  packet.delivery.truncated = false;
  for (const candidate of unique) {
    packet.evidence.push(candidate);
    if (cost() > budget) {
      if (candidate.kind !== "document") { packet.evidence.pop(); continue; }
      const original = candidate.text;
      const characters = Array.from(original);
      const anchor = Array.from(original.slice(0, focus.get(candidate) ?? 0)).length;
      candidate.truncated = true;
      let low = 1, high = characters.length, fitted = "";
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const start = Math.min(Math.max(0, anchor - Math.floor(middle / 3)), characters.length - middle);
        candidate.text = (start > 0 ? "[… omitted …]\n" : "") + characters.slice(start, start + middle).join("") + "\n[… truncated; read the cited source …]";
        if (cost() <= budget) { fitted = candidate.text; low = middle + 1; } else high = middle - 1;
      }
      if (!fitted) { packet.evidence.pop(); continue; }
      candidate.text = fitted;
    }
    packet.delivery.omitted_blocks--;
  }
  packet.delivery.truncated = packet.delivery.omitted_blocks > 0 || packet.evidence.some(block => block.truncated);
  if (cost() > budget || (candidates.length > 0 && packet.evidence.length === 0)) {
    throw new DocNexusError("invalid_params", "context budget cannot fit the evidence and citations; increase --context-budget");
  }
  return packet;
}

export type EvidencePacket = ReturnType<typeof assembleEvidence>;
