import { entityTypes, relationshipTypes, type DocNexusMetadata, type ValidationResult } from "./types.js";

export const metadataSchema = {
  title: "DocNexus metadata schema",
  entityTypes,
  relationshipTypes
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateMetadata(value: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isRecord(value)) {
    return { valid: false, errors: ["metadata must be an object"] };
  }

  if (!isNonEmptyString(value.title)) {
    errors.push("title must be a non-empty string");
  }

  if (!isNonEmptyString(value.summary)) {
    errors.push("summary must be a non-empty string");
  }

  if (!Array.isArray(value.tags) || value.tags.some((tag) => !isNonEmptyString(tag))) {
    errors.push("tags must be an array of strings");
  }

  if (!Array.isArray(value.entities)) {
    errors.push("entities must be an array");
  } else {
    value.entities.forEach((entity, index) => {
      if (!isRecord(entity)) {
        errors.push(`entities[${index}] must be an object`);
        return;
      }
      if (!isNonEmptyString(entity.name)) {
        errors.push(`entities[${index}].name must be a non-empty string`);
      }
      if (!entityTypes.includes(entity.type as never)) {
        errors.push(`entities[${index}].type must be one of ${entityTypes.join(", ")}`);
      }
      if (!isNonEmptyString(entity.description)) {
        errors.push(`entities[${index}].description must be a non-empty string`);
      }
    });
  }

  if (!Array.isArray(value.relationships)) {
    errors.push("relationships must be an array");
  } else {
    value.relationships.forEach((relationship, index) => {
      if (!isRecord(relationship)) {
        errors.push(`relationships[${index}] must be an object`);
        return;
      }
      if (!isNonEmptyString(relationship.from)) {
        errors.push(`relationships[${index}].from must be a non-empty string`);
      }
      if (!isNonEmptyString(relationship.to)) {
        errors.push(`relationships[${index}].to must be a non-empty string`);
      }
      if (!relationshipTypes.includes(relationship.type as never)) {
        errors.push(`relationships[${index}].type must be one of ${relationshipTypes.join(", ")}`);
      }
      if (!isNonEmptyString(relationship.description)) {
        errors.push(`relationships[${index}].description must be a non-empty string`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

export function assertValidMetadata(value: unknown): asserts value is DocNexusMetadata {
  const result = validateMetadata(value);
  if (!result.valid) {
    throw new Error(`Invalid metadata: ${result.errors.join("; ")}`);
  }
}
