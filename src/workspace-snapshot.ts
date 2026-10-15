import { DocNexusError } from "./errors.js";
import { realpath } from "node:fs/promises";
import { factReferenceIds, renderFactDocument } from "./fact-renderer.js";
import { sha256, stableJson } from "./hash.js";
import { projectionKnowledge, resolveKnowledge, type KnowledgeDocument } from "./knowledge.js";
import { listRecordFiles, readAssets } from "./workspace-reader.js";
import { withProjectLock } from "./project-lock.js";
import { createSourceView } from "./source-anchor.js";

/** An operation-owned, validated view. Revalidate its revision before committing work prepared outside the lock. */
export async function loadWorkspaceSnapshot(projectRoot: string, at?: string) {
  return withProjectLock(projectRoot, async () => {
    at ??= new Date().toISOString();
    const root = await realpath(projectRoot);
    const records = (await listRecordFiles(root)).sort((a, b) => a.file_path < b.file_path ? -1 : a.file_path > b.file_path ? 1 : 0);
    const documents: KnowledgeDocument[] = [];
    for (const record of [...records].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.file_path.localeCompare(b.file_path))) {
      // Validate source/history hashes, but do not retain their growing contents.
      const { metadata, document } = await readAssets(root, record);
      documents.push({ id: record.id, file_path: record.file_path, document_hash: record.document_hash, metadata, document });
    }
    const knowledge = resolveKnowledge(documents, at);
    const factIds = new Set(knowledge.facts.map(fact => fact.id));
    for (const document of documents) for (const id of factReferenceIds(document.document!)) {
      if (!factIds.has(id)) throw new DocNexusError("knowledge_conflict", `unknown fact reference: ${id}`);
    }
    const byId = new Map(documents.map(document => [document.id, document]));
    const versions = new Map(records.map(record => [record.id, sha256(stableJson(record))]));
    const rendered = new Map<string, ReturnType<typeof renderFactDocument>>();
    const projections = new Map<string, ReturnType<typeof projectionKnowledge>>();
    const sources = new Map<string, ReturnType<typeof createSourceView>>();
    const renderDocument = (id: string) => {
      if (!rendered.has(id)) rendered.set(id, renderFactDocument(byId.get(id)!.document!, knowledge.facts));
      return rendered.get(id)!;
    };
    const projectDocument = (id: string) => {
      if (!projections.has(id)) projections.set(id, projectionKnowledge(knowledge, byId.get(id)!, renderDocument(id)));
      return projections.get(id)!;
    };
    const sourceDocument = (id: string) => {
      if (!sources.has(id)) sources.set(id, createSourceView(byId.get(id)!.document!, renderDocument(id)));
      return sources.get(id)!;
    };
    const revision = sha256(stableJson({
      records,
      facts: knowledge.facts.map((fact) => [fact.id, fact.status, fact.replaced_by ?? null, fact.entity ?? null])
    }));
    return { root, at, records, documents, knowledge, renderDocument, projectDocument, sourceDocument, recordVersion: (id: string) => versions.get(id)!, revision };
  });
}

export type WorkspaceSnapshot = Awaited<ReturnType<typeof loadWorkspaceSnapshot>>;

export class DocumentRevisionChangedError extends DocNexusError {
  constructor(readonly current_revision: string) {
    super("document_revision_changed", `document_revision_changed: memory changed; restart from page 1 (current revision: ${current_revision})`, { current_revision });
  }
}
