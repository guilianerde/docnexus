import { DocNexusError } from "./errors.js";
import { mkdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { sha256, stableJson } from "./hash.js";
import { createDocumentId } from "./ids.js";
import { internalPath, libraryPath, recordRelativePath, recordsPath, schemasPath, workspacePath } from "./layout.js";
import { assertValidMetadata, metadataSchema } from "./metadata.js";
import { documentCategoryLabel, type DocNexusMetadata, type ManagedDocument, type StoreStatus, type StoredRecordSummary } from "./types.js";
import { assertNoSymbolicLinks, atomicWrite, readIfExists } from "./workspace-io.js";
import { commitTextTransaction } from "./text-transaction.js";
import { withProjectLock } from "./project-lock.js";
import { resolveKnowledge } from "./knowledge.js";
import { loadKnowledgeDocuments, validateKnowledgeWrite } from "./knowledge-service.js";
import { loadWorkspaceSnapshot, DocumentRevisionChangedError, type WorkspaceSnapshot } from "./workspace-snapshot.js";
import { factDocumentTemplate, factReferenceIds, renderFactDocument, type RenderedFactReference } from "./fact-renderer.js";
import { assertDocumentId, listRecordFiles, normalizeManagedFilePath, readAssets, readRecordAsset, readRecordFile, readRecordMetadata, recordDirectory, resolveManagedTarget, type RecordFile } from "./workspace-reader.js";

export { assertNoSymbolicLinks } from "./workspace-io.js";
export { isManagedFilePath, listRecordFiles, normalizeManagedFilePath, readRecordMetadata, type RecordFile } from "./workspace-reader.js";

export interface ManagedDocumentWriteInput {
  file_path: string;
  source: string;
  document: string;
  metadata: DocNexusMetadata;
}

export interface ManagedDocumentWriteResult {
  id: string;
  file_path: string;
  operation: "created" | "updated";
  updated_at: string;
  timeline_path: string;
}

export interface RecordsState {
  record_count: number;
  edited: string[];
  missing_library: string[];
  invalid_records: Array<{ id: string; error: string }>;
  ok: boolean;
}

export type ManagedRecordAsset = "source" | "document" | "metadata" | "timeline" | "template";

function classificationEvent(previous: DocNexusMetadata | undefined, next: DocNexusMetadata): string {
  const from = previous?.category ?? "uncategorized";
  const to = next.category ?? "uncategorized";
  if (from === to && previous?.category_reason === next.category_reason) return "";
  return `### Classification\n\n${JSON.stringify({ from, to, reason: next.category_reason ?? null }, null, 2)}\n\n`;
}

export async function ensureManagedWorkspace(projectRoot: string): Promise<void> {
  return withProjectLock(projectRoot, async () => {
    const root = await realpath(projectRoot);
    for (const path of [recordsPath(root), libraryPath(root), schemasPath(root)]) {
      await assertNoSymbolicLinks(root, relative(root, path));
      await mkdir(path, { recursive: true });
    }
    const schemaPath = join(schemasPath(root), "metadata.schema.json");
    await assertNoSymbolicLinks(root, relative(root, schemaPath));
    await atomicWrite(schemaPath, `${stableJson(metadataSchema)}\n`);
  });
}

export async function upsertManagedDocument(
  projectRoot: string,
  input: ManagedDocumentWriteInput,
  options: { acceptLibraryEdit?: boolean; ingestion?: { documentId: string; receipt: { path: string; content: string }; renderedHash?: string } } = {}
): Promise<ManagedDocumentWriteResult> {
  return withProjectLock(projectRoot, async () => {
    if (typeof input.source !== "string" || !input.source.trim() || typeof input.document !== "string" || !input.document.trim()) {
      throw new DocNexusError("invalid_params", "non-empty source and document are required");
    }
    assertValidMetadata(input.metadata);
    const target = await resolveManagedTarget(projectRoot, input.file_path);
    await ensureManagedWorkspace(projectRoot);
    const prior = (await listRecordFiles(projectRoot)).find((record) => record.file_path === target.relativePath);
    const currentTarget = await readIfExists(target.absolutePath);
    if (!prior && currentTarget !== undefined) throw new DocNexusError("invalid_params", "unmanaged file already exists at file_path");
    const previous = prior ? await readAssets(projectRoot, prior, options.acceptLibraryEdit) : undefined;
    const metadataJson = stableJson(input.metadata);
    const template = factDocumentTemplate(input.document);
    const hashes = { source_hash: sha256(input.source), document_hash: sha256(template), metadata_hash: sha256(metadataJson) };
    const unchanged = prior !== undefined && prior.source_hash === hashes.source_hash && prior.document_hash === hashes.document_hash && prior.metadata_hash === hashes.metadata_hash;
    const now = new Date().toISOString();
    const id = prior?.id ?? options.ingestion?.documentId ?? createDocumentId();
    assertDocumentId(id);
    if (options.ingestion && options.ingestion.documentId !== id) throw new DocNexusError("internal_error", "ingestion document identity mismatch");
    const prospective = await validateKnowledgeWrite(projectRoot, { id, file_path: target.relativePath, metadata: input.metadata, document: template, document_hash: hashes.document_hash });
    const rendered = renderFactDocument(template, prospective.knowledge.facts).document;
    if (options.ingestion?.renderedHash !== undefined && options.ingestion.renderedHash !== sha256(rendered)) {
      throw new DocNexusError("preview_changed", "referenced facts changed after preview; seal the draft again and review its new preview");
    }
    const operation = prior ? "updated" : "created";
    const event = options.acceptLibraryEdit ? "adopted hand edit" : operation;
    const timeline = unchanged ? previous!.timeline : `${previous?.timeline ?? "# Timeline\n"}\n## ${now} — ${event}\n\n${input.metadata.title}\n\n${input.metadata.summary}\n\n${classificationEvent(previous?.metadata, input.metadata)}### Source\n\n${options.acceptLibraryEdit ? input.document : input.source}\n`;
    const record: RecordFile = {
      id, file_path: target.relativePath, title: input.metadata.title,
      created_at: prior?.created_at ?? now, updated_at: unchanged ? prior.updated_at : now,
      ...hashes, timeline_hash: sha256(timeline)
    };
    const directory = await recordDirectory(projectRoot, id);
    const files = new Map<string, string | null>([
      [target.absolutePath, rendered],
      [join(directory, "source.md"), input.source],
      [join(directory, "metadata.json"), `${metadataJson}\n`],
      [join(directory, "timeline.md"), timeline],
      [join(directory, "record.json"), `${JSON.stringify(record, null, 2)}\n`]
    ]);
    // Include dependent generated views in the same recoverable write, preserving their authored text.
    for (const document of prospective.documents) {
      if (document.id === id || document.document === undefined || !factReferenceIds(document.document).length) continue;
      const body = renderFactDocument(document.document, prospective.knowledge.facts).document;
      if (body !== document.document) {
        if (sha256(factDocumentTemplate(document.document)) !== document.document_hash) {
          throw new DocNexusError("text_integrity_error", `managed target was externally modified: ${document.file_path}; run "docnexus document sync" to adopt the edit`);
        }
        files.set((await resolveManagedTarget(projectRoot, document.file_path)).absolutePath, body);
      }
    }
    if (options.ingestion) files.set(options.ingestion.receipt.path, options.ingestion.receipt.content);
    await commitTextTransaction(projectRoot, files, { rollbackDirectories: prior ? [] : [directory] });
    return { id, file_path: record.file_path, operation, updated_at: record.updated_at, timeline_path: `${recordRelativePath(id, projectRoot)}/timeline.md` };
  });
}

export async function listManagedDocuments(projectRoot: string): Promise<ManagedDocument[]> {
  return withProjectLock(projectRoot, async () => {
    const documents: ManagedDocument[] = [];
    for (const record of await listRecordFiles(projectRoot)) {
      const metadata = await readRecordMetadata(projectRoot, record.id);
      if (sha256(stableJson(metadata)) !== record.metadata_hash) throw new DocNexusError("text_integrity_error", `record ${record.id} metadata.json does not match record.json`);
      documents.push({ ...record, summary: metadata.summary, tags: metadata.tags, sidecar_path: recordRelativePath(record.id, projectRoot) });
    }
    return documents.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.file_path.localeCompare(b.file_path));
  });
}

export async function listManagedRecords(projectRoot: string, input: { limit?: number; tag?: string } = {}): Promise<{ records: StoredRecordSummary[] }> {
  return withProjectLock(projectRoot, async () => {
    const records = (await listManagedDocuments(projectRoot))
      .filter((document) => !input.tag || document.tags.includes(input.tag))
      .slice(0, input.limit ?? 50)
      .map(({ id, file_path, title, summary, tags, updated_at }) => ({ id, file_path, title, summary, tags, updated_at }));
    return { records };
  });
}

export async function getManagedRecord(projectRoot: string, id: string, include: ManagedRecordAsset[] = ["source", "document", "metadata", "timeline"]): Promise<{
  id: string; record_version: string; file_path: string; source?: string; document?: string; metadata?: DocNexusMetadata; timeline?: string; template?: string; fact_references?: RenderedFactReference[];
}> {
  return withProjectLock(projectRoot, async () => {
    assertDocumentId(id);
    const record = await readRecordFile(projectRoot, id);
    const assets = await readAssets(projectRoot, record);
    const template = factDocumentTemplate(assets.document);
    let references: RenderedFactReference[] = [];
    if (factReferenceIds(template).length) {
      const knowledge = resolveKnowledge(await loadKnowledgeDocuments(projectRoot));
      const rendered = renderFactDocument(template, knowledge.facts);
      references = rendered.references;
      if (rendered.document !== assets.document) {
        await commitTextTransaction(projectRoot, new Map([[(await resolveManagedTarget(projectRoot, record.file_path)).absolutePath, rendered.document]]));
        assets.document = rendered.document;
      }
    }
    const output: { id: string; record_version: string; file_path: string; source?: string; document?: string; metadata?: DocNexusMetadata; timeline?: string; template?: string; fact_references?: RenderedFactReference[] } = { id, record_version: sha256(stableJson(record)), file_path: record.file_path };
    for (const name of include) Object.assign(output, { [name]: name === "template" ? template : assets[name] });
    if (references.length && include.includes("document")) output.fact_references = references;
    return output;
  });
}

export async function getManagedStatus(projectRoot: string): Promise<StoreStatus> {
  return withProjectLock(projectRoot, async () => {
    return { project_root: projectRoot, workspace_path: workspacePath(projectRoot), internal_directory: internalPath(projectRoot), library_path: libraryPath(projectRoot), initialized: true, document_count: (await listRecordFiles(projectRoot)).length };
  });
}

/** Apply the model's category judgment without rewriting facts, source or authored Markdown. */
export async function classifyManagedDocument(projectRoot: string, input: { id: string; category: string; reason: string; revision?: string }) {
  return withProjectLock(projectRoot, async () => {
    if (typeof input.reason !== "string" || !input.reason.trim()) throw new DocNexusError("invalid_params", "classification requires a non-empty reason");
    if (input.revision !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(input.revision)) throw new DocNexusError("invalid_params", "revision must be a SHA-256 snapshot identifier");
      const snapshot = await loadWorkspaceSnapshot(projectRoot);
      if (snapshot.revision !== input.revision) throw new DocumentRevisionChangedError(snapshot.revision);
    }
    const record = await readRecordFile(projectRoot, input.id);
    const assets = await readAssets(projectRoot, record);
    const metadata = { ...assets.metadata, category: input.category, category_reason: input.reason.trim() };
    assertValidMetadata(metadata);
    const previousCategory = assets.metadata.category ?? "uncategorized";
    const changed = assets.metadata.category !== metadata.category || assets.metadata.category_reason !== metadata.category_reason;
    const now = changed ? new Date().toISOString() : record.updated_at;
    if (changed) {
      const timeline = `${assets.timeline}\n## ${now} — reclassified\n\n${classificationEvent(assets.metadata, metadata)}`;
      const nextRecord: RecordFile = { ...record, updated_at: now, metadata_hash: sha256(stableJson(metadata)), timeline_hash: sha256(timeline) };
      const directory = await recordDirectory(projectRoot, record.id);
      await commitTextTransaction(projectRoot, new Map([
        [join(directory, "metadata.json"), `${stableJson(metadata)}\n`],
        [join(directory, "timeline.md"), timeline],
        [join(directory, "record.json"), `${JSON.stringify(nextRecord, null, 2)}\n`]
      ]));
    }
    return { id: record.id, file_path: record.file_path, operation: changed ? "reclassified" : "unchanged", previous_category: previousCategory,
      category: metadata.category, category_label: documentCategoryLabel(metadata.category), category_reason: metadata.category_reason, updated_at: now };
  });
}

/** Regenerate derived fact blocks without adopting authored edits or appending history. */
export async function refreshFactViews(projectRoot: string, snapshot?: WorkspaceSnapshot): Promise<{ rendered_documents: number }> {
  return withProjectLock(projectRoot, async () => {
    const documents = snapshot?.documents ?? await loadKnowledgeDocuments(projectRoot);
    const knowledge = snapshot?.knowledge ?? resolveKnowledge(documents);
    const files = new Map<string, string | null>();
    for (const document of documents) {
      if (document.document === undefined || !factReferenceIds(document.document).length) continue;
      if (sha256(factDocumentTemplate(document.document)) !== document.document_hash) {
        throw new DocNexusError("text_integrity_error", `managed target was externally modified: ${document.file_path}; run "docnexus document sync" to adopt the edit`);
      }
      const rendered = snapshot?.renderDocument(document.id).document ?? renderFactDocument(document.document, knowledge.facts).document;
      if (rendered !== document.document) files.set((await resolveManagedTarget(projectRoot, document.file_path)).absolutePath, rendered);
    }
    if (files.size) await commitTextTransaction(projectRoot, files);
    return { rendered_documents: files.size };
  });
}

export async function deleteManagedDocument(projectRoot: string, input: { id?: string; file_path?: string; confirm: boolean }): Promise<{ id: string; file_path: string; deleted: true }> {
  return withProjectLock(projectRoot, async () => {
    if (!input.confirm) throw new DocNexusError("confirmation_required", "document deletion requires explicit confirmation");
    if (Number(Boolean(input.id)) + Number(Boolean(input.file_path)) !== 1) throw new DocNexusError("invalid_params", "provide exactly one of id or file_path");
    if (input.id) assertDocumentId(input.id);
    const filePath = input.file_path === undefined ? undefined : await normalizeManagedFilePath(projectRoot, input.file_path);
    const record = (await listRecordFiles(projectRoot)).find((value) => value.id === input.id || value.file_path === filePath);
    if (!record) throw new DocNexusError("document_not_found", "managed document not found");
    // Keep replacement history referentially valid when deleting its owner.
    const knowledgeDocuments = await loadKnowledgeDocuments(projectRoot);
    const remaining = knowledgeDocuments.filter((value) => value.id !== record.id);
    const remainingFacts = new Set(remaining.flatMap((value) => (value.metadata.facts ?? []).map((fact) => fact.id)));
    const deletingFacts = knowledgeDocuments.find((value) => value.id === record.id)!.metadata.facts ?? [];
    if (deletingFacts.some((fact) => fact.replaces && remainingFacts.has(fact.replaces))) {
      throw new DocNexusError("knowledge_conflict", "cannot delete cross-document replacement history while its predecessor remains; withdraw the fact instead");
    }
    const knowledge = resolveKnowledge(remaining);
    for (const document of remaining) if (document.document !== undefined) renderFactDocument(document.document, knowledge.facts);
    await readAssets(projectRoot, record);
    const directory = await recordDirectory(projectRoot, record.id);
    const target = (await resolveManagedTarget(projectRoot, record.file_path)).absolutePath;
    const files = new Map<string, string | null>([[target, null]]);
    for (const name of ["source.md", "metadata.json", "timeline.md", "record.json"]) files.set(join(directory, name), null);
    await commitTextTransaction(projectRoot, files, { removeDirectories: [directory], removeIndexedDocument: record.id });
    return { id: record.id, file_path: record.file_path, deleted: true };
  });
}

export async function inspectRecords(projectRoot: string): Promise<RecordsState> {
  return withProjectLock(projectRoot, async () => {
    const records = await listRecordFiles(projectRoot);
    const state: RecordsState = { record_count: records.length, edited: [], missing_library: [], invalid_records: [], ok: true };
    for (const record of records) {
      const target = await resolveManagedTarget(projectRoot, record.file_path);
      const document = await readIfExists(target.absolutePath);
      if (document === undefined) state.missing_library.push(record.id);
      else if (sha256(factDocumentTemplate(document)) !== record.document_hash) state.edited.push(record.id);
      try {
        if (document !== undefined) await readAssets(projectRoot, record, true);
        else {
          const source = await readRecordAsset(projectRoot, record.id, "source.md");
          const metadata = await readRecordMetadata(projectRoot, record.id);
          const timeline = await readRecordAsset(projectRoot, record.id, "timeline.md");
          if (sha256(source) !== record.source_hash || sha256(stableJson(metadata)) !== record.metadata_hash || sha256(timeline) !== record.timeline_hash) throw new DocNexusError("text_integrity_error", "record assets do not match record.json");
        }
      } catch (error) {
        state.invalid_records.push({ id: record.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    state.ok = state.edited.length + state.missing_library.length + state.invalid_records.length === 0;
    return state;
  });
}

export async function syncManagedDocument(projectRoot: string, input: { id?: string; file_path?: string; metadata?: DocNexusMetadata }): Promise<ManagedDocumentWriteResult & { metadata_updated: boolean }> {
  return withProjectLock(projectRoot, async () => {
    if (Number(Boolean(input.id)) + Number(Boolean(input.file_path)) !== 1) throw new DocNexusError("invalid_params", "provide exactly one of id or file_path");
    if (input.id) assertDocumentId(input.id);
    const filePath = input.file_path === undefined ? undefined : await normalizeManagedFilePath(projectRoot, input.file_path);
    const record = (await listRecordFiles(projectRoot)).find((value) => value.id === input.id || value.file_path === filePath);
    if (!record) throw new DocNexusError("document_not_found", "managed document not found");
    const assets = await readAssets(projectRoot, record, true);
    const result = await upsertManagedDocument(projectRoot, { file_path: record.file_path, source: assets.source, document: assets.document, metadata: input.metadata ?? assets.metadata }, { acceptLibraryEdit: true });
    return { ...result, metadata_updated: input.metadata !== undefined };
  });
}
