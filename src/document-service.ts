import { DocNexusError } from "./errors.js";
import { loadSealedDraft, ingestionManifestFile } from "./drafts.js";
import { factDocumentTemplate, factReferenceIds } from "./fact-renderer.js";
import { createDocumentId } from "./ids.js";
import { upsertManagedDocument } from "./managed-documents.js";
import { withProjectLock } from "./project-lock.js";
import { listRecordFiles } from "./workspace-reader.js";
import { sha256, stableJson } from "./hash.js";

/** Coordinate reviewed drafts with document writes; the receipt shares the text transaction. */
export async function ingestDraft(projectRoot: string, input: { draftId: string; replace: boolean }) {
  return withProjectLock(projectRoot, async () => {
    const draft = await loadSealedDraft(projectRoot, input.draftId);
    const prior = (await listRecordFiles(projectRoot)).find(record => record.file_path === draft.manifest.file_path);
    if (prior && !input.replace) throw new DocNexusError("confirmation_required", "document add requires --replace for an existing managed document");
    const id = prior?.id ?? createDocumentId();
    const template = factDocumentTemplate(draft.document);
    if (factReferenceIds(template).length && draft.manifest.rendered_hash === undefined) {
      throw new DocNexusError("preview_changed", "fact-backed draft requires a sealed preview; seal the draft again before ingestion");
    }
    const result = await upsertManagedDocument(projectRoot, { file_path: draft.manifest.file_path,
      source: draft.source, document: draft.document, metadata: draft.metadata }, {
      ingestion: { documentId: id, receipt: await ingestionManifestFile(projectRoot, input.draftId, id), renderedHash: draft.manifest.rendered_hash }
    });
    return { ...result, sealed_version: sha256(stableJson(draft.manifest)) };
  });
}
