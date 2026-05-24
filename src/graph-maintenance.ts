import {
  checkLadybugVectorIndex,
  deleteLadybugConceptsByIds,
  deleteLadybugDocumentsByIds,
  listLadybugDocumentSummaries,
  listLadybugOrphanConcepts,
  rebuildLadybugVectorIndex
} from "./ladybug-store.js";
import { ensureManagedStore, openManagedDatabase } from "./managed-documents.js";

export interface GraphDocumentSummary {
  document_id: string;
  file_path: string;
  chunk_count: number;
}

export interface GraphOrphanConcept {
  concept_id: string;
  name: string;
  type: string;
}

export interface GraphVectorIndexHealth {
  ok: boolean;
  message?: string;
}

export interface GraphMaintenanceStore {
  listDocumentSummaries: (projectRoot: string) => Promise<GraphDocumentSummary[]>;
  listOrphanConcepts: (projectRoot: string) => Promise<GraphOrphanConcept[]>;
  checkVectorIndex: (projectRoot: string) => Promise<GraphVectorIndexHealth>;
  deleteDocumentsByIds: (projectRoot: string, documentIds: string[]) => Promise<void>;
  deleteConceptsByIds: (projectRoot: string, conceptIds: string[]) => Promise<void>;
  rebuildVectorIndex: (projectRoot: string) => Promise<void>;
}

export interface GraphAuditOutput {
  result: "clean" | "issues_found";
  summary: {
    documents: number;
    ladybug_documents: number;
    ladybug_chunks: number;
    missing_documents: number;
    stale_documents: number;
    chunk_count_mismatches: number;
    orphan_concepts: number;
    vector_index_ok: boolean;
  };
  issues: {
    missing_documents: Array<{ document_id: string; file_path: string }>;
    stale_documents: Array<{ document_id: string; file_path: string }>;
    chunk_count_mismatches: Array<{
      document_id: string;
      file_path: string;
      sqlite_chunks: number;
      ladybug_chunks: number;
    }>;
    orphan_concepts: GraphOrphanConcept[];
    vector_index: Array<{ message: string }>;
  };
  checked_at: string;
}

export interface GraphRepairOutput {
  result: "completed" | "completed_with_remaining_issues";
  actions: {
    deleted_stale_documents: number;
    deleted_orphan_concepts: number;
    rebuilt_vector_index: boolean;
  };
  before: { total_issues: number };
  after: {
    total_issues: number;
    remaining_issue_types: string[];
  };
  recommendations: string[];
  started_at: string;
  finished_at: string;
}

interface DocumentAuditRow {
  id: string;
  file_path: string;
  chunk_count: number;
}

const defaultGraphStore: GraphMaintenanceStore = {
  listDocumentSummaries: listLadybugDocumentSummaries,
  listOrphanConcepts: listLadybugOrphanConcepts,
  checkVectorIndex: checkLadybugVectorIndex,
  deleteDocumentsByIds: deleteLadybugDocumentsByIds,
  deleteConceptsByIds: deleteLadybugConceptsByIds,
  rebuildVectorIndex: rebuildLadybugVectorIndex
};

export async function auditGraph(
  projectRoot: string,
  graphStore: GraphMaintenanceStore = defaultGraphStore
): Promise<GraphAuditOutput> {
  await ensureManagedStore(projectRoot);
  const sqliteRows = readDocumentAuditRows(projectRoot);
  const graphDocuments = await graphStore.listDocumentSummaries(projectRoot);
  const orphanConcepts = await graphStore.listOrphanConcepts(projectRoot);
  const vectorIndex = await graphStore.checkVectorIndex(projectRoot);
  const sqliteById = new Map(sqliteRows.map((row) => [row.id, row]));
  const graphById = new Map(graphDocuments.map((document) => [document.document_id, document]));

  const missingDocuments = sqliteRows
    .filter((row) => !graphById.has(row.id))
    .map((row) => ({ document_id: row.id, file_path: row.file_path }));
  const staleDocuments = graphDocuments
    .filter((document) => !sqliteById.has(document.document_id))
    .map((document) => ({ document_id: document.document_id, file_path: document.file_path }));
  const chunkCountMismatches = graphDocuments.flatMap((document) => {
    const sqliteRow = sqliteById.get(document.document_id);
    if (!sqliteRow || sqliteRow.chunk_count === document.chunk_count) {
      return [];
    }
    return [{
      document_id: document.document_id,
      file_path: sqliteRow.file_path,
      sqlite_chunks: sqliteRow.chunk_count,
      ladybug_chunks: document.chunk_count
    }];
  });
  const issues = {
    missing_documents: missingDocuments,
    stale_documents: staleDocuments,
    chunk_count_mismatches: chunkCountMismatches,
    orphan_concepts: orphanConcepts,
    vector_index: vectorIndex.ok ? [] : [{ message: vectorIndex.message ?? "vector index check failed" }]
  };
  return {
    result: totalIssueCount(issues) === 0 ? "clean" : "issues_found",
    summary: {
      documents: sqliteRows.length,
      ladybug_documents: graphDocuments.length,
      ladybug_chunks: graphDocuments.reduce((sum, document) => sum + document.chunk_count, 0),
      missing_documents: missingDocuments.length,
      stale_documents: staleDocuments.length,
      chunk_count_mismatches: chunkCountMismatches.length,
      orphan_concepts: orphanConcepts.length,
      vector_index_ok: vectorIndex.ok
    },
    issues,
    checked_at: new Date().toISOString()
  };
}

export async function repairGraph(
  projectRoot: string,
  options: { force: boolean },
  graphStoreOrFactory: GraphMaintenanceStore | (() => GraphMaintenanceStore) = defaultGraphStore
): Promise<GraphRepairOutput> {
  if (!options.force) {
    throw new Error("graph repair requires --force");
  }
  const startedAt = new Date().toISOString();
  const firstStore = resolveGraphStore(graphStoreOrFactory);
  const before = await auditGraph(projectRoot, firstStore);
  const staleIds = before.issues.stale_documents.map((document) => document.document_id);
  const orphanIds = before.issues.orphan_concepts.map((concept) => concept.concept_id);

  if (staleIds.length > 0) {
    await firstStore.deleteDocumentsByIds(projectRoot, staleIds);
  }
  if (orphanIds.length > 0) {
    await firstStore.deleteConceptsByIds(projectRoot, orphanIds);
  }
  await firstStore.rebuildVectorIndex(projectRoot);
  const after = await auditGraph(projectRoot, resolveGraphStore(graphStoreOrFactory));
  const remaining = issueTypes(after);
  return {
    result: remaining.length === 0 ? "completed" : "completed_with_remaining_issues",
    actions: {
      deleted_stale_documents: staleIds.length,
      deleted_orphan_concepts: orphanIds.length,
      rebuilt_vector_index: true
    },
    before: { total_issues: totalIssueCount(before.issues) },
    after: { total_issues: totalIssueCount(after.issues), remaining_issue_types: remaining },
    recommendations: remaining.some((type) => type === "missing_documents" || type === "chunk_count_mismatches")
      ? ["Run docnexus index rebuild --force to recreate missing documents or chunk-count mismatches."]
      : [],
    started_at: startedAt,
    finished_at: new Date().toISOString()
  };
}

function readDocumentAuditRows(projectRoot: string): DocumentAuditRow[] {
  const db = openManagedDatabase(projectRoot);
  try {
    return db.prepare(`
      SELECT documents.id, documents.file_path, COUNT(file_chunks.id) AS chunk_count
      FROM documents
      LEFT JOIN file_chunks ON file_chunks.document_id = documents.id
      GROUP BY documents.id, documents.file_path
      ORDER BY documents.file_path ASC
    `).all() as unknown as DocumentAuditRow[];
  } finally {
    db.close();
  }
}

function resolveGraphStore(storeOrFactory: GraphMaintenanceStore | (() => GraphMaintenanceStore)): GraphMaintenanceStore {
  return typeof storeOrFactory === "function" ? storeOrFactory() : storeOrFactory;
}

function issueTypes(audit: GraphAuditOutput): string[] {
  return Object.entries(audit.issues).filter(([, values]) => values.length > 0).map(([type]) => type);
}

function totalIssueCount(issues: GraphAuditOutput["issues"]): number {
  return Object.values(issues).reduce((sum, values) => sum + values.length, 0);
}
