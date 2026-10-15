import { join } from "node:path";
import { sha256, stableJson } from "./hash.js";
import { libraryPath } from "./layout.js";
import { readIfExists } from "./workspace-io.js";
import { listRecordFiles, readRecordMetadata } from "./workspace-reader.js";
import { withProjectLock } from "./project-lock.js";
import { resolveKnowledge, validateKnowledgeUpdate, type KnowledgeDocument, type ResolvedFact } from "./knowledge.js";

export async function loadKnowledgeDocuments(projectRoot: string): Promise<KnowledgeDocument[]> {
  return withProjectLock(projectRoot, async () => {
    const documents: KnowledgeDocument[] = [];
    const records = (await listRecordFiles(projectRoot)).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.file_path.localeCompare(b.file_path));
    for (const record of records) {
      const metadata = await readRecordMetadata(projectRoot, record.id);
      if (sha256(stableJson(metadata)) !== record.metadata_hash) throw new Error(`record ${record.id} metadata.json does not match record.json`);
      documents.push({ id: record.id, file_path: record.file_path, metadata, document_hash: record.document_hash,
        document: await readIfExists(join(libraryPath(projectRoot), record.file_path)) });
    }
    return documents;
  });
}

export async function validateKnowledgeWrite(projectRoot: string, document: KnowledgeDocument) {
  return withProjectLock(projectRoot, async () => validateKnowledgeUpdate(await loadKnowledgeDocuments(projectRoot), document));
}

export async function listFacts(projectRoot: string, input: { entity?: string; at?: string; includeInactive?: boolean } = {}): Promise<{ at: string; facts: ResolvedFact[] }> {
  return withProjectLock(projectRoot, async () => {
    const knowledge = resolveKnowledge(await loadKnowledgeDocuments(projectRoot), input.at);
    const entity = input.entity ? knowledge.resolver.resolve(input.entity)?.name : undefined;
    return {
      at: knowledge.at,
      facts: knowledge.facts.filter((fact) => (!input.entity || (entity !== undefined && fact.entity === entity)) && (input.includeInactive || fact.status === "active"))
        .sort((a, b) => Date.parse(b.valid_from) - Date.parse(a.valid_from) || a.id.localeCompare(b.id))
    };
  });
}
