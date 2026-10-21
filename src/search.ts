import { isDocumentCategory } from "./types.js";
import { DocNexusError } from "./errors.js";
import { withProjectLock } from "./project-lock.js";
import { libraryRelativePath } from "./layout.js";
import { refreshFactViews } from "./managed-documents.js";
import { loadWorkspaceSnapshot, type WorkspaceSnapshot } from "./workspace-snapshot.js";
import { factsForDocuments, type ResolvedFact } from "./knowledge.js";
import { documentAnchor, factAnchor, recordVersion, type SourceAnchor } from "./source-anchor.js";

export interface SearchInput {
  query: string;
  limit?: number;
  category?: string;
}

export interface SearchResult {
  source_anchor?: SourceAnchor;
  id: string;
  file_path: string;
  library_path: string;
  title: string;
  summary: string;
  matched_terms: string[];
  line?: number;
  snippet: string;
  score: number;
  facts?: ResolvedFact[];
}

/** Literal word/name lookup. Results point to documents for the agent to read in full. */
export async function searchDocuments(
  projectRoot: string,
  input: SearchInput
): Promise<{ query: string; results: SearchResult[] }> {
  validateSearchInput(input);
  return withProjectLock(projectRoot, async () => {
    const snapshot = await loadWorkspaceSnapshot(projectRoot);
    await refreshFactViews(projectRoot, snapshot);
    return searchSnapshot(snapshot, input);
  });
}

export function searchSnapshot(snapshot: WorkspaceSnapshot, input: SearchInput): { query: string; results: SearchResult[] } {
  const { query, limit, category } = validateSearchInput(input);
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase();
  const normalizedQuery = normalize(query);
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  const words = [...segmenter.segment(normalizedQuery)].filter((part) => part.isWordLike).map((part) => part.segment);
  // ICU can split a short term such as 长文 into single characters. Adjacent Han
  // pairs retain literal evidence without admitting every document containing 文.
  const pairs = [...normalizedQuery.matchAll(/\p{Script=Han}{2,}/gu)].flatMap(([run]) => {
    const characters = Array.from(run);
    return characters.slice(1).map((character, index) => characters[index] + character);
  });
  const terms = [...new Set([...words.filter((word) => words.length === 1 || !/^\p{Script=Han}$/u.test(word)), ...pairs])];
  if (terms.length === 0) {
    return { query, results: [] };
  }
  const results: SearchResult[] = [];
  const { documents: knowledgeDocuments, knowledge } = snapshot;
  const categoryIds = category === undefined ? undefined : new Set(snapshot.documents.filter(document => (document.metadata.category ?? "uncategorized") === category).map(document => document.id));
  for (const document of snapshot.records) {
    if (categoryIds !== undefined && !categoryIds.has(document.id)) continue;
    const projection = snapshot.projectDocument(document.id);
    const metadata = projection.metadata;
    const body = snapshot.renderDocument(document.id).document;
    const named: Array<{ text: string; field: Extract<SourceAnchor, { kind: "metadata" }>["field"] }> = [
      { text: document.title, field: "title" },
      { text: document.file_path, field: "path" },
      ...metadata.entities.flatMap((entity) => [entity.name, ...(entity.aliases ?? [])].map(text => ({ text, field: "entity" as const }))),
      ...metadata.tags.map(text => ({ text, field: "tag" as const }))
    ];
    const names = named.map(value => value.text);
    const headings = normalize(names.join("\n"));
    const summary = normalize(metadata.summary);
    const factText = projection.facts.map((fact) => fact.text).join("\n");
    const text = normalize(`${body}\n${factText}`);
    const matched = terms.filter((term) => headings.includes(term) || summary.includes(term) || text.includes(term));
    if (matched.length === 0) {
      continue;
    }
    const version = recordVersion(snapshot, document.id);
    let bodyOffset = 0;
    const candidates: Array<{ text: string; line?: number; start?: number; source_anchor?: SourceAnchor }> = [
      ...body.split("\n").map((text, index) => { const start = bodyOffset; bodyOffset += text.length + 1; return { text, line: index + 1, start }; }),
      ...projection.facts.map((fact) => ({ text: fact.text, source_anchor: factAnchor(snapshot, fact) })),
      ...[...named, { text: metadata.summary, field: "summary" as const }].map(({ text, field }) => ({ text,
        source_anchor: { kind: "metadata" as const, document_id: document.id, record_version: version, field, value: text } }))
    ];
    let evidence = candidates[0];
    let evidenceScore = -1;
    for (const candidate of candidates) {
      const value = normalize(candidate.text);
      const strength = (value.includes(normalizedQuery) ? terms.length + 1 : 0) + matched.filter((term) => value.includes(term)).length;
      if (strength > evidenceScore) { evidence = candidate; evidenceScore = strength; }
    }
    let snippet = evidence.text;
    // Keep the literal match visible even when it occurs in a very long line.
    const phraseOffset = normalize(snippet).indexOf(normalizedQuery);
    const offset = phraseOffset >= 0 ? phraseOffset : Math.min(...matched.map((term) => normalize(snippet).indexOf(term)).filter((value) => value >= 0));
    const start = Number.isFinite(offset) ? Math.max(0, offset - 60) : 0;
    const source = snapshot.sourceDocument(document.id);
    const anchor = evidence.source_anchor ?? documentAnchor(snapshot, document.id,
      source.renderedOffset(evidence.start! + start), source.renderedOffset(evidence.start! + Math.min(evidence.text.length, start + 240)));
    snippet = `${start > 0 ? "…" : ""}${snippet.slice(start, start + 240)}${snippet.length > start + 240 ? "…" : ""}`;
    const fieldScore = matched.reduce((sum, term) => sum
      + (headings.includes(term) ? 5 : 0)
      + (summary.includes(term) ? 2 : 0)
      + (text.includes(term) ? 1 : 0), 0);
    const exact = [...names, metadata.summary, body, factText].some((value) => normalize(value).includes(normalizedQuery));
    // Complete phrases outrank partial evidence, then coverage outranks field
    // weights. The fractional field term cannot overturn either ordering.
    const score = (exact ? terms.length + 1 : 0) + matched.length + fieldScore / (8 * (terms.length + 1));
    const facts = factsForDocuments(knowledge.facts, [document.id], knowledgeDocuments);
    results.push({
      id: document.id,
      file_path: document.file_path,
      library_path: libraryRelativePath(document.file_path, snapshot.root),
      title: document.title,
      summary: metadata.summary,
      matched_terms: matched,
      line: evidence.line,
      snippet,
      score,
      source_anchor: anchor,
      ...(facts.length ? { facts } : {})
    });
  }
  results.sort((a, b) => b.score - a.score || a.file_path.localeCompare(b.file_path));
  return { query, results: results.slice(0, Math.min(limit, 100)) };
}

function validateSearchInput(input: SearchInput) {
  const query = input.query?.trim();
  if (!query) {
    throw new DocNexusError("invalid_params", "query must be a non-empty string");
  }
  const limit = input.limit ?? 5;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new DocNexusError("invalid_params", "limit must be a positive integer");
  }
  if (input.category !== undefined && !isDocumentCategory(input.category)) throw new DocNexusError("invalid_params", "category must be a trimmed name of 1–80 characters without control characters");
  return { query, limit, category: input.category };
}
