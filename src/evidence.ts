import { DocNexusError, PROTOCOL_VERSION } from "./errors.js";
import { renderFactDocument } from "./fact-renderer.js";
import { sha256, stableJson } from "./hash.js";
import { factsForDocuments } from "./knowledge.js";
import type { GroupedRecallData, RecallContextGroup } from "./recall-groups.js";
import type { WorkspaceSnapshot } from "./workspace-snapshot.js";
import { validateSourceAnchor, type SourceAnchor } from "./source-anchor.js";

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

type Span = { start: number; end: number };
const OMITTED = "\n\n[… omitted …]\n\n";

function documentText(body: string, group: RecallContextGroup, unit: EvidenceUnit, locations?: Span[], neighbors?: Span[]) {
  const primary = locations ?? group.matched_chunks.flatMap(chunk => { const span = locate(body, chunk.text); return span ? [span] : []; });
  const focus = primary[0]?.start ?? 0;
  if (unit === "page") return { text: body, unit, focus };
  if (!primary.length) return { text: body, unit: "page" as const, fallback_reason: "anchor_not_located" as const, focus: 0 };
  let ranges = [...primary, ...(neighbors ?? group.same_document_chunks.flatMap(chunk => { const span = locate(body, chunk.text); return span ? [span] : []; }))];
  let fallback = unit === "section";
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
    const sections = primary.map(anchor => {
      const heading = headings.filter(value => value.start <= anchor.start).at(-1);
      return heading ? { start: heading.start, end: headings.find(value => value.start >= anchor.end && value.level <= heading.level)?.start ?? body.length } : undefined;
    });
    if (sections.every(Boolean)) { ranges = sections as Span[]; fallback = false; }
  }
  const merged: Span[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const prior = merged.at(-1);
    if (prior && range.start <= prior.end) prior.end = Math.max(prior.end, range.end);
    else merged.push({ ...range });
  }
  let selectedFocus = 0, length = 0;
  for (const range of merged) {
    if (focus >= range.start && focus < range.end) selectedFocus = length + focus - range.start;
    length += range.end - range.start + OMITTED.length;
  }
  return { text: merged.map(range => body.slice(range.start, range.end)).join(OMITTED), unit: unit === "section" && !fallback ? "section" as const : "window" as const,
    focus: selectedFocus, ...(fallback ? { fallback_reason: "no_section" as const } : {}) };
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
  const matchedFacts = new Map<string, number>();
  const cores = new Map<EvidenceBlock, { text: string; focus: number }>();
  const factIds = (anchor: SourceAnchor) => anchor.kind === "fact" ? [anchor.fact_id] : anchor.kind === "document" ? anchor.fact_ids : [];
  const factBlock = (id: string, role: EvidenceBlock["role"]): EvidenceBlock => {
    const fact = snapshot.knowledge.facts.find(fact => fact.id === id)!;
    return { kind: "fact", ...citation(fact.document_id), role, truncated: false, observed_at: null,
      text: fact.status === "active" ? fact.text : `Historical or future fact: ${fact.status}; not a current assertion.`,
      fact: { id: fact.id, status: fact.status, provenance: fact.provenance, valid_from: fact.valid_from,
        ...(fact.valid_until ? { valid_until: fact.valid_until } : {}), ...(fact.replaces ? { replaces: fact.replaces } : {}),
        ...(fact.replaced_by ? { replaced_by: fact.replaced_by } : {}), ...(fact.withdrawn_at ? { withdrawn_at: fact.withdrawn_at } : {}) } };
  };
  for (const group of grouped.context_groups) {
    const id = group.document.document_id;
    const facts = factsForDocuments(snapshot.knowledge.facts, [id], snapshot.documents);
    const allowedFacts = new Set(facts.map(fact => fact.id));
    const matches = group.matches ?? group.matched_chunks.flatMap(chunk => chunk.source_anchor ? [{ source: "vector" as const, anchor: chunk.source_anchor }] : []);
    for (const match of matches) {
      validateSourceAnchor(snapshot, match.anchor);
      if (match.anchor.kind !== "fact" && match.anchor.document_id !== id) throw new DocNexusError("index_outdated", "retrieval anchor belongs to another document");
      for (const factId of factIds(match.anchor)) {
        if (!allowedFacts.has(factId)) throw new DocNexusError("index_outdated", "retrieval anchor names an unrelated fact");
        const fact = snapshot.knowledge.facts.find(fact => fact.id === factId)!;
        const priority = (match.source === "keyword" ? 3 : 1) + Number(fact.status === "active");
        matchedFacts.set(factId, Math.max(matchedFacts.get(factId) ?? 0, priority));
      }
    }
    const body = snapshot.sourceDocument(id).template;
    const locations = matches.length ? [...matches].sort((a, b) => Number(b.source === "keyword") - Number(a.source === "keyword"))
      .flatMap(match => match.anchor.kind === "document" ? [{ start: match.anchor.start, end: match.anchor.end }] : []) : undefined;
    const neighbors = matches.length ? group.same_document_chunks.flatMap(chunk => {
      if (!chunk.source_anchor) return [];
      validateSourceAnchor(snapshot, chunk.source_anchor);
      if (chunk.source_anchor.kind !== "document") return [];
      if (chunk.source_anchor.document_id !== id) throw new DocNexusError("index_outdated", "neighbor anchor belongs to another document");
      return [{ start: chunk.source_anchor.start, end: chunk.source_anchor.end }];
    }) : undefined;
    const { focus: selectedFocus, ...selected } = documentText(body, group, unit, locations, neighbors);
    const primary: EvidenceBlock = { kind: "document", ...citation(id), role: "primary", ...selected, truncated: false };
    candidates.push(primary);
    focus.set(primary, selectedFocus);
    const coreLocations = locations ?? group.matched_chunks.flatMap(chunk => { const span = locate(body, chunk.text); return span ? [span] : []; });
    const compact = coreLocations.map(span => ({ start: span.start,
      end: span.start + Array.from(body.slice(span.start, span.end)).slice(0, 240).join("").length }));
    const core = documentText(body, group, "window", compact, []);
    // Metadata-only hits have no body location; do not reserve an entire fallback page.
    if (!compact.length) core.text = Array.from(core.text).slice(0, 240).join("");
    cores.set(primary, core);
    for (const fact of facts) {
      // Keep legacy callers without structured anchors compatible.
      if (!matches.length) {
        const indexed = `[${fact.id}] ${fact.text}\nSource: ${fact.provenance}\nValid from: ${fact.valid_from}`;
        const rendered = fact.status === "active" ? renderFactDocument(`{{fact:${fact.id}}}`, [fact]).document : undefined;
        if (group.matched_chunks.some(chunk => chunk.text.includes(`[${fact.id}]`) || chunk.text.includes(`<!-- docnexus:fact ${fact.id} -->`)
          || chunk.text.includes(`事实：\`${fact.id}\``) || locate(indexed, chunk.text) || (rendered && locate(rendered, chunk.text))
          || (fact.status === "active" && chunk.text.includes(fact.text)))) matchedFacts.set(fact.id, 1 + Number(fact.status === "active"));
      }
      if (seenFacts.has(fact.id)) continue;
      seenFacts.add(fact.id);
      candidates.push(factBlock(fact.id, "primary"));
    }
  }
  for (const group of grouped.context_groups) {
    for (const path of group.graph_context.paths) if (path.source_document_id && records.has(path.source_document_id)) {
      candidates.push({ kind: "relationship", ...citation(path.source_document_id), role: "supporting", truncated: false,
        observed_at: null,
        text: `${path.from} ${path.relationship} ${path.to}: ${path.description ?? ""}` });
    }
    for (const chunk of group.graph_context.supporting_chunks) if (records.has(chunk.document_id)) {
      const body = snapshot.sourceDocument(chunk.document_id).template;
      let span;
      if (chunk.source_anchor) {
        validateSourceAnchor(snapshot, chunk.source_anchor);
        if (chunk.source_anchor.kind === "document") {
          if (chunk.source_anchor.document_id !== chunk.document_id) throw new DocNexusError("index_outdated", "support anchor belongs to another document");
          span = { start: chunk.source_anchor.start, end: chunk.source_anchor.end };
        }
        for (const factId of factIds(chunk.source_anchor)) if (!seenFacts.has(factId)) {
          seenFacts.add(factId); candidates.push(factBlock(factId, "supporting"));
        }
      } else span = locate(body, chunk.text);
      if (span) candidates.push({ kind: "document", ...citation(chunk.document_id), role: "supporting", unit: "window", truncated: false, text: body.slice(span.start, span.end) });
    }
  }
  // Reserve room for final omission counters/flags before packing any evidence.
  const byEvidence = new Map<string, EvidenceBlock>();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.kind, candidate.document_id, candidate.fact?.id ?? candidate.text]);
    if (!byEvidence.has(key)) byEvidence.set(key, candidate);
  }
  const priority = (block: EvidenceBlock) => matchedFacts.get(block.fact?.id ?? "") ?? 0;
  const unique = [...byEvidence.values()].sort((a, b) => priority(b) - priority(a));
  packet.delivery.omitted_blocks = unique.length;
  packet.delivery.truncated = false;
  const fitDocument = (candidate: EvidenceBlock, original: string, anchor: number, limit: number) => {
    if (cost() <= limit) return original;
    const characters = Array.from(original);
    const center = Array.from(original.slice(0, anchor)).length;
    candidate.truncated = true;
    let low = 1, high = characters.length, fitted = "", payload = "";
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const start = Math.min(Math.max(0, center - Math.floor(middle / 3)), characters.length - middle);
      const part = characters.slice(start, start + middle).join("");
      candidate.text = (start > 0 ? "[… omitted …]\n" : "") + part + "\n[… truncated; read the cited source …]";
      if (cost() <= limit) { fitted = candidate.text; payload = part; low = middle + 1; } else high = middle - 1;
    }
    candidate.text = fitted;
    return payload;
  };
  // Admit direct atomic facts, then reserve a compact hit for each primary document.
  const direct = unique.filter(candidate => priority(candidate) > 0);
  for (const candidate of direct) { packet.evidence.push(candidate); if (cost() > budget) packet.evidence.pop(); }
  const primary = unique.filter(candidate => candidate.kind === "document" && candidate.role === "primary");
  const secondaryFacts = unique.filter(candidate => candidate.kind === "fact" && candidate.role === "primary" && priority(candidate) === 0)
    .sort((a, b) => Number(b.fact?.status === "active") - Number(a.fact?.status === "active"));
  const expansions = new Map<EvidenceBlock, { full: string; payload: string }>();
  for (const [index, candidate] of primary.entries()) {
    const full = candidate.text, core = cores.get(candidate)!;
    const before = cost();
    candidate.truncated = core.text !== full;
    candidate.text = core.text + (candidate.truncated ? "\n[… truncated; read the cited source …]" : "");
    packet.evidence.push(candidate);
    const share = before + Math.floor((budget - before) / (primary.length - index));
    let payload = fitDocument(candidate, core.text, core.focus, share);
    if (!payload) { candidate.text = core.text + (candidate.truncated ? "\n[… truncated; read the cited source …]" : ""); payload = fitDocument(candidate, core.text, core.focus, budget); }
    if (!payload) packet.evidence.pop();
    else expansions.set(candidate, { full, payload });
  }
  // Complete primary atomic assertions/statuses before spending spare space on prose.
  for (const candidate of secondaryFacts) { packet.evidence.push(candidate); if (cost() > budget) packet.evidence.pop(); }
  // Complete units that fit before a partial long unit can consume the remaining space.
  const partial: Array<[EvidenceBlock, { full: string; payload: string }]> = [];
  const growth = (candidate: EvidenceBlock, full: string) => Buffer.byteLength(JSON.stringify(full), "utf8") - Buffer.byteLength(JSON.stringify(candidate.text), "utf8");
  const complete = [...expansions].sort(([a, x], [b, y]) => growth(a, x.full) - growth(b, y.full));
  for (const [candidate, expansion] of complete) {
    const prior = { text: candidate.text, truncated: candidate.truncated };
    candidate.text = expansion.full; candidate.truncated = false;
    if (cost() > budget) { Object.assign(candidate, prior); partial.push([candidate, expansion]); }
  }
  partial.sort(([a], [b]) => primary.indexOf(a) - primary.indexOf(b));
  // Expand only after other primary hits have space, and never discard admitted hits.
  for (const [candidate, { full, payload }] of partial) {
    const prior = { text: candidate.text, truncated: candidate.truncated };
    candidate.text = full; candidate.truncated = false;
    const fitted = fitDocument(candidate, full, focus.get(candidate) ?? 0, budget);
    if (!fitted || !payload.split(OMITTED).every(part => fitted.includes(part))) Object.assign(candidate, prior);
  }
  for (const candidate of unique.filter(candidate => priority(candidate) === 0 && !primary.includes(candidate) && !secondaryFacts.includes(candidate))) {
    packet.evidence.push(candidate);
    if (cost() > budget && (candidate.kind !== "document" || !fitDocument(candidate, candidate.text, 0, budget))) packet.evidence.pop();
  }
  packet.delivery.omitted_blocks = unique.length - packet.evidence.length;
  packet.delivery.truncated = packet.delivery.omitted_blocks > 0 || packet.evidence.some(block => block.truncated);
  if (cost() > budget || (candidates.length > 0 && packet.evidence.length === 0)) {
    throw new DocNexusError("invalid_params", "context budget cannot fit the evidence and citations; increase --context-budget");
  }
  return packet;
}

export type EvidencePacket = ReturnType<typeof assembleEvidence>;
