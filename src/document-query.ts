import { asDocNexusError, DocNexusError } from "./errors.js";
import { sha256, stableJson } from "./hash.js";
import { realpath } from "node:fs/promises";
import { type RenderedFactReference } from "./fact-renderer.js";
import { factsForDocuments, type ResolvedFact } from "./knowledge.js";
import { libraryRelativePath } from "./layout.js";
import { loadWorkspaceSnapshot, DocumentRevisionChangedError } from "./workspace-snapshot.js";
import { requireInitializedProject } from "./project.js";
import { withProjectLock } from "./project-lock.js";
import { documentCategoryLabel, isDocumentCategory, type DocumentCategory } from "./types.js";

export interface DocumentQueryInput {
  all?: boolean;
  page?: number;
  page_size?: number;
  category?: DocumentCategory;
  revision?: string;
}

export interface DocumentView {
  id: string;
  record_version: string;
  observed_at: string | null;
  file_path: string;
  library_path: string;
  title: string;
  summary: string;
  category: DocumentCategory;
  category_label: string;
  category_reason: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  document: string;
  fact_references: RenderedFactReference[];
  facts: ResolvedFact[];
}

export interface DocumentQueryOutput {
  schema_version: 1;
  project_root: string;
  generated_at: string;
  revision: string;
  total_documents: number;
  total: number;
  categories: Array<{ id: DocumentCategory; label: string; count: number }>;
  pagination: { page: number; page_size: number; total_pages: number; has_more: boolean; next_page: number | null } | null;
  documents: DocumentView[];
}

export { DocumentRevisionChangedError } from "./workspace-snapshot.js";

/** Human-facing Markdown snapshots from canonical text; no model or retrieval store required. */
export async function queryDocuments(projectRoot: string, input: DocumentQueryInput = {}): Promise<DocumentQueryOutput> {
  if (input.all !== undefined && typeof input.all !== "boolean") throw new DocNexusError("invalid_params", "all must be a boolean");
  if (input.all && (input.page !== undefined || input.page_size !== undefined)) throw new DocNexusError("invalid_params", "--all cannot be combined with --page or --page-size");
  const page = input.page ?? 1;
  const size = input.page_size ?? 20;
  if (!Number.isSafeInteger(page) || page < 1) throw new DocNexusError("invalid_params", "page must be a positive safe integer");
  if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw new DocNexusError("invalid_params", "page_size must be between 1 and 100");
  const offset = (page - 1) * size;
  if (!Number.isSafeInteger(offset)) throw new DocNexusError("invalid_params", "page offset exceeds the safe integer range");
  if (input.category !== undefined && !isDocumentCategory(input.category)) throw new DocNexusError("invalid_params", "category must be a trimmed name of 1–80 characters without control characters");
  if (input.revision !== undefined && (typeof input.revision !== "string" || !/^[a-f0-9]{64}$/.test(input.revision))) throw new DocNexusError("invalid_params", "revision must be a SHA-256 snapshot identifier");

  return withProjectLock(projectRoot, async () => {
    const root = await realpath(projectRoot);
    await requireInitializedProject(root);
    const snapshot = await loadWorkspaceSnapshot(root).catch((error: Error) => {
      const failure = asDocNexusError(error, "text_integrity_error");
      if (failure.code !== "text_integrity_error") throw failure;
      throw new DocNexusError("text_integrity_error", `memory text is missing, invalid or externally modified; run doctor and document sync before querying: ${failure.message}`);
    });
    const { at, records, documents, knowledge, renderDocument, revision } = snapshot;
    const byId = new Map(documents.map((document) => [document.id, document]));
    if (input.revision !== undefined && input.revision !== revision) throw new DocumentRevisionChangedError(revision);
    const categoryFor = (id: string): DocumentCategory => byId.get(id)!.metadata.category ?? "uncategorized";
    const counts = new Map<string, number>();
    for (const record of records) { const category = categoryFor(record.id); counts.set(category, (counts.get(category) ?? 0) + 1); }
    const categories = [...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([id, count]) => ({ id, label: documentCategoryLabel(id), count }));
    const filtered = records.filter((record) => input.category === undefined || categoryFor(record.id) === input.category);
    const selected = input.all ? filtered : filtered.slice(offset, offset + size);
    const totalPages = Math.ceil(filtered.length / size);
    return {
      schema_version: 1, project_root: root, generated_at: at, revision,
      total_documents: records.length, total: filtered.length, categories,
      pagination: input.all ? null : { page, page_size: size, total_pages: totalPages, has_more: page < totalPages, next_page: page < totalPages ? page + 1 : null },
      documents: selected.map((record) => {
        const metadata = byId.get(record.id)!.metadata;
        const category = categoryFor(record.id);
        const view = renderDocument(record.id);
        return {
          id: record.id, record_version: sha256(stableJson(record)), file_path: record.file_path, library_path: libraryRelativePath(record.file_path),
          observed_at: metadata.observed_at ?? null, title: metadata.title, summary: metadata.summary, category, category_label: documentCategoryLabel(category), category_reason: metadata.category_reason ?? null, tags: metadata.tags,
          created_at: record.created_at, updated_at: record.updated_at, document: view.document,
          fact_references: view.references, facts: factsForDocuments(knowledge.facts, [record.id], documents)
        };
      })
    };
  });
}
