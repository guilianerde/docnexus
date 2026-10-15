export const entityTypes = ["component", "concept", "protocol", "decision", "file", "tool", "other"] as const;
export const relationshipTypes = ["depends_on", "mentions", "implements", "replaces", "relates_to", "decides"] as const;
/** Legacy display labels, not an allow-list for model-chosen project categories. */
export const documentCategories = {
  requirements: "需求与规格",
  architecture: "架构设计",
  decision: "决策记录",
  guide: "操作指南",
  reference: "参考资料",
  note: "笔记",
  uncategorized: "未分类"
} as const;

export type DocumentCategory = string;

export function isDocumentCategory(value: unknown): value is DocumentCategory {
  return typeof value === "string" && value.length > 0 && value.length <= 80 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

export function documentCategoryLabel(category: DocumentCategory): string {
  return Object.hasOwn(documentCategories, category) ? documentCategories[category as keyof typeof documentCategories] : category;
}

export type EntityType = (typeof entityTypes)[number];
export type RelationshipType = (typeof relationshipTypes)[number];

export interface MetadataEntity {
  name: string;
  type: EntityType;
  description: string;
  aliases?: string[];
}

export interface MetadataFact {
  id: string;
  text: string;
  provenance: string;
  entity?: string;
  valid_from: string;
  valid_until?: string;
  replaces?: string;
  withdrawn_at?: string;
  withdrawal_reason?: string;
}

export interface MetadataRelationship {
  from: string;
  to: string;
  type: RelationshipType;
  description: string;
}

export interface DocNexusMetadata {
  observed_at?: string;
  title: string;
  summary: string;
  tags: string[];
  entities: MetadataEntity[];
  relationships: MetadataRelationship[];
  facts?: MetadataFact[];
  category?: DocumentCategory;
  category_reason?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ManagedDocument {
  id: string;
  file_path: string;
  title: string;
  summary: string;
  tags: string[];
  source_hash: string;
  document_hash: string;
  metadata_hash: string;
  timeline_hash: string;
  created_at: string;
  updated_at: string;
  sidecar_path: string;
}

export interface StoredRecordSummary {
  id: string;
  file_path: string;
  title: string;
  summary: string;
  tags: string[];
  updated_at: string;
}

export interface StoreStatus {
  project_root: string;
  workspace_path: string;
  library_path: string;
  initialized: boolean;
  document_count: number;
}

export interface ManagedChunk {
  id: string;
  document_id: string;
  chunk_index: number;
  text: string;
  text_hash: string;
  embedding: number[];
  created_at: string;
}
