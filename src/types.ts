export const entityTypes = ["component", "concept", "protocol", "decision", "file", "tool", "other"] as const;
export const relationshipTypes = ["depends_on", "mentions", "implements", "replaces", "relates_to", "decides"] as const;

export type EntityType = (typeof entityTypes)[number];
export type RelationshipType = (typeof relationshipTypes)[number];

export interface MetadataEntity {
  name: string;
  type: EntityType;
  description: string;
}

export interface MetadataRelationship {
  from: string;
  to: string;
  type: RelationshipType;
  description: string;
}

export interface DocNexusMetadata {
  title: string;
  summary: string;
  tags: string[];
  entities: MetadataEntity[];
  relationships: MetadataRelationship[];
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
  created_at: string;
  updated_at: string;
  sidecar_path: string;
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

export interface ArchiveRecordInput {
  file_path: string;
  source: string;
  document: string;
  metadata: DocNexusMetadata;
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
  store_path: string;
  initialized: boolean;
  document_count: number;
}
