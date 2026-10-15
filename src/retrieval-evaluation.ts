import type { EvidencePacket } from "./evidence.js";
import { sha256, stableJson } from "./hash.js";
import type { DocNexusMetadata } from "./types.js";
import type { WorkspaceSnapshot } from "./workspace-snapshot.js";

export interface RetrievalQuestion {
  id: string;
  split: "dev" | "holdout";
  origin: "repository" | "simulated";
  kind: string;
  query: string;
  expected_paths: string[];
  evidence: Array<{ path: string; text?: string; fact_id?: string; status?: string }>;
  rationale?: string;
}

export interface RetrievalCorpus {
  schema_version: 1;
  documents: Array<{
    path: string; split: RetrievalQuestion["split"]; title: string;
    source_path?: string; excerpts?: string[]; body?: string;
    entities?: DocNexusMetadata["entities"]; relationships?: DocNexusMetadata["relationships"]; facts?: DocNexusMetadata["facts"];
  }>;
  questions: RetrievalQuestion[];
}

/** Freeze labels before retrieval; malformed or leaking fixtures must not become metrics. */
export function validateRetrievalCorpus(corpus: RetrievalCorpus): void {
  const documents = new Map(corpus.documents.map(document => [document.path, document]));
  if (documents.size !== corpus.documents.length) throw new Error("duplicate corpus document path");
  const ids = new Set<string>();
  for (const question of corpus.questions) {
    if (ids.has(question.id)) throw new Error(`duplicate question: ${question.id}`);
    ids.add(question.id);
    if (!["dev", "holdout"].includes(question.split) || !question.query.trim()) throw new Error(`invalid question: ${question.id}`);
    if (!question.expected_paths.length && (!question.rationale || question.evidence.length)) throw new Error(`unsupported question needs a rationale and no answer labels: ${question.id}`);
    if (question.expected_paths.length && !question.evidence.length) throw new Error(`missing answer evidence: ${question.id}`);
    for (const path of question.expected_paths) {
      const document = documents.get(path);
      if (!document || document.split !== question.split) throw new Error(`unknown document or split leakage: ${question.id}: ${path}`);
      if (question.origin === "repository" && !document.source_path) throw new Error(`repository question has a simulated target: ${question.id}`);
    }
    for (const evidence of question.evidence) {
      const document = documents.get(evidence.path);
      if (!question.expected_paths.includes(evidence.path) || (!evidence.text && !evidence.fact_id)) throw new Error(`invalid evidence label: ${question.id}`);
      if (evidence.text && ![...(document?.excerpts ?? []), document?.body ?? "", ...(document?.facts ?? []).map(fact => fact.text)].some(text => text.includes(evidence.text!))) throw new Error(`answer is absent from canonical target: ${question.id}`);
      if (evidence.fact_id && !corpus.documents.some(entry => entry.facts?.some(fact => fact.id === evidence.fact_id))) throw new Error(`unknown fact label: ${question.id}`);
    }
  }
}

/** Evaluate document ranks without allowing duplicate chunks to improve rank or recall. */
export function scoreRetrieval(paths: string[], expected: string[]) {
  const unique = [...new Set(paths)].slice(0, 3);
  const relevant = new Set(expected);
  const index = unique.findIndex(path => relevant.has(path));
  const covered = unique.filter(path => relevant.has(path)).length;
  return {
    answerable: relevant.size > 0, candidate_documents: unique.length,
    rank: index < 0 ? null : index + 1,
    hit_at_1: relevant.size ? Number(relevant.has(unique[0])) : null,
    hit_at_3: relevant.size ? Number(covered > 0) : null,
    document_recall_at_3: relevant.size ? covered / relevant.size : null,
    all_documents_at_3: relevant.size ? Number(covered === relevant.size) : null,
    mrr_at_3: relevant.size ? (index < 0 ? 0 : 1 / (index + 1)) : null
  };
}

/** Exact attributed coverage is mechanical evidence retention, not semantic answer quality. */
export function scoreEvidence(snapshot: WorkspaceSnapshot, packet: EvidencePacket, question: RetrievalQuestion) {
  const records = new Map(snapshot.records.map(record => [record.id, record]));
  const facts = new Map(snapshot.knowledge.facts.map(fact => [fact.id, fact]));
  let citationErrors = 0, factErrors = 0;
  const valid = packet.evidence.filter(block => {
    const record = records.get(block.document_id);
    const cited = record && block.path === record.file_path && block.record_version === sha256(stableJson(record));
    if (!cited) citationErrors++;
    let factual = true;
    if (block.kind === "fact") {
      const fact = block.fact && facts.get(block.fact.id);
      factual = Boolean(fact && block.document_id === fact.document_id
        && (["id", "status", "provenance", "valid_from", "valid_until", "replaces", "replaced_by", "withdrawn_at"] as const).every(key => block.fact![key] === fact[key])
        && (fact.status === "active" ? block.text === fact.text : block.text === `Historical or future fact: ${fact.status}; not a current assertion.`));
      if (!factual) factErrors++;
    }
    return cited && factual;
  });
  const missing = question.evidence.filter(required => !valid.some(block => block.path === required.path
    && (!required.text || block.text.includes(required.text))
    && (!required.fact_id || block.fact?.id === required.fact_id)
    && (!required.status || block.fact?.status === required.status)));
  const bytes = Buffer.byteLength(JSON.stringify(packet, null, 2) + "\n");
  return {
    required: question.evidence.length, covered: question.evidence.length - missing.length,
    coverage: question.evidence.length ? 1 - missing.length / question.evidence.length : null,
    missing, citation_errors: citationErrors, fact_errors: factErrors,
    budget_ok: bytes <= packet.delivery.budget_tokens && bytes === packet.delivery.estimated_tokens,
    bytes, truncated: packet.delivery.truncated, omitted_blocks: packet.delivery.omitted_blocks
  };
}
