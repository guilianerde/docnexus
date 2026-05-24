import { createHash } from "node:crypto";
import type { DocNexusMetadata, EntityType, MetadataEntity, RelationshipType } from "./types.js";

export type LadybugRelationshipLabel = "DEPENDS_ON" | "RELATES_TO" | "IMPLEMENTS" | "REPLACES" | "DECIDES";

export interface GraphConcept extends MetadataEntity {
  id: string;
}

export interface GraphEdge {
  label: LadybugRelationshipLabel;
  from: string;
  to: string;
  description: string;
}

export interface GraphMapping {
  concepts: GraphConcept[];
  edges: GraphEdge[];
}

export function normalizeConceptKey(name: string, type: EntityType): string {
  return `${type}:${name.trim().toLowerCase()}`;
}

export function createConceptId(name: string, type: EntityType): string {
  const hash = createHash("sha256").update(normalizeConceptKey(name, type), "utf8").digest("hex").slice(0, 16);
  return `concept_${hash}`;
}

export function mapRelationshipTypeToEdge(type: RelationshipType): LadybugRelationshipLabel {
  switch (type) {
    case "depends_on":
      return "DEPENDS_ON";
    case "implements":
      return "IMPLEMENTS";
    case "replaces":
      return "REPLACES";
    case "decides":
      return "DECIDES";
    case "mentions":
    case "relates_to":
      return "RELATES_TO";
  }
}

export function relationshipsToEdges(metadata: DocNexusMetadata): GraphMapping {
  const conceptsByName = new Map<string, GraphConcept>();

  for (const entity of metadata.entities) {
    const concept: GraphConcept = {
      ...entity,
      id: createConceptId(entity.name, entity.type)
    };
    conceptsByName.set(entity.name.trim().toLowerCase(), concept);
  }

  for (const relationship of metadata.relationships) {
    ensureConcept(conceptsByName, relationship.from);
    ensureConcept(conceptsByName, relationship.to);
  }

  const edges = metadata.relationships.map((relationship) => ({
    label: mapRelationshipTypeToEdge(relationship.type),
    from: conceptsByName.get(relationship.from.trim().toLowerCase())!.id,
    to: conceptsByName.get(relationship.to.trim().toLowerCase())!.id,
    description: relationship.description
  }));

  return {
    concepts: Array.from(conceptsByName.values()),
    edges
  };
}

function ensureConcept(conceptsByName: Map<string, GraphConcept>, name: string): void {
  const key = name.trim().toLowerCase();
  if (conceptsByName.has(key)) {
    return;
  }

  conceptsByName.set(key, {
    id: createConceptId(name, "other"),
    name,
    type: "other",
    description: "Referenced by metadata relationship."
  });
}
