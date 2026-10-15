import { DocNexusError } from "./errors.js";
import { withProjectLock } from "./project-lock.js";
import { libraryRelativePath } from "./layout.js";
import { refreshFactViews } from "./managed-documents.js";
import { loadWorkspaceSnapshot, type WorkspaceSnapshot } from "./workspace-snapshot.js";
import { factsForDocuments, type ResolvedFact } from "./knowledge.js";

export interface SearchResult {
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
  input: { query: string; limit?: number }
): Promise<{ query: string; results: SearchResult[] }> {
  validateSearchInput(input);
  return withProjectLock(projectRoot, async () => {
    const snapshot = await loadWorkspaceSnapshot(projectRoot);
    await refreshFactViews(projectRoot, snapshot);
    return searchSnapshot(snapshot, input);
  });
}

export function searchSnapshot(snapshot: WorkspaceSnapshot, input: { query: string; limit?: number }): { query: string; results: SearchResult[] } {
  const { query, limit } = validateSearchInput(input);
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
  for (const document of snapshot.records) {
    const body = snapshot.renderDocument(document.id).document;
    const projection = snapshot.projectDocument(document.id);
    const metadata = projection.metadata;
    const names = [
      document.title,
      document.file_path,
      ...metadata.entities.flatMap((entity) => [entity.name, ...(entity.aliases ?? [])]),
      ...metadata.tags
    ];
    const headings = normalize(names.join("\n"));
    const summary = normalize(metadata.summary);
    const factText = projection.facts.map((fact) => fact.text).join("\n");
    const text = normalize(`${body}\n${factText}`);
    const matched = terms.filter((term) => headings.includes(term) || summary.includes(term) || text.includes(term));
    if (matched.length === 0) {
      continue;
    }
    const candidates: Array<{ text: string; line?: number }> = [
      ...body.split("\n").map((text, index) => ({ text, line: index + 1 })),
      ...projection.facts.map((fact) => ({ text: fact.text })),
      ...names.map((text) => ({ text })),
      { text: metadata.summary }
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
      library_path: libraryRelativePath(document.file_path),
      title: document.title,
      summary: metadata.summary,
      matched_terms: matched,
      line: evidence.line,
      snippet,
      score,
      ...(facts.length ? { facts } : {})
    });
  }
  results.sort((a, b) => b.score - a.score || a.file_path.localeCompare(b.file_path));
  return { query, results: results.slice(0, Math.min(limit, 100)) };
}

function validateSearchInput(input: { query: string; limit?: number }) {
  const query = input.query?.trim();
  if (!query) {
    throw new DocNexusError("invalid_params", "query must be a non-empty string");
  }
  const limit = input.limit ?? 5;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new DocNexusError("invalid_params", "limit must be a positive integer");
  }
  return { query, limit };
}
