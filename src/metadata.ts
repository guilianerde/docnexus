import { DocNexusError } from "./errors.js";
import { isDocumentCategory, entityTypes, relationshipTypes, type DocNexusMetadata, type ValidationResult } from "./types.js";

export const metadataSchema = {
  title: "DocNexus metadata schema",
  entityTypes,
  relationshipTypes,
  classification: "Project-defined category names; an explicit user or calling-skill category takes precedence over model classification. No fixed taxonomy. Seal caller overrides with draft seal --category before review.",
  documentReferences: {
    syntax: "{{fact:fact_id}} on a standalone Markdown line; code fences remain literal.",
    source: "Define each fact only once in its owner's metadata.facts. References follow effective replacements.",
    generated: "The CLI renders read-only <!-- docnexus:fact fact_id --> blocks with provenance and validity.",
    preview: "draft seal emits preview.md for fact references. draft preview returns the validated sealed document, hash and version for review; reading is not approval."
  },
  optionalFields: {
    observed_at: "Optional explicit ISO 8601 observation/statement timestamp with timezone from the current source. Omit when unknown on source replacement; never inherit a prior source date or infer from save time/event dates.",
    category: "One project-defined primary category; 1–80 characters, trimmed, no control characters. Omitted legacy values display as uncategorized.",
    category_reason: "Optional concise classification basis, grounded in project context and related documents; requires category.",
    "entities[].aliases": "Unique alternative names for this canonical entity; string[].",
    facts: "Optional facts array. Preserve historical entries and stable project-unique ids.",
    "facts[]": {
      id: "fact_<letters, digits, hyphens or underscores>; stable project-unique identity",
      text: "Claim text", provenance: "Mandatory source attribution", entity: "Optional declared entity name or alias",
      valid_from: "Required ISO 8601 timestamp with timezone; when the claim becomes true",
      valid_until: "Optional exclusive expiry timestamp", replaces: "Optional id of the earlier fact explicitly superseded",
      withdrawn_at: "Optional withdrawal timestamp", withdrawal_reason: "Required with withdrawn_at"
    }
  }
} as const;

export function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}

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

  if (value.observed_at !== undefined && !isTimestamp(value.observed_at)) errors.push("observed_at must be an ISO timestamp with timezone");

  if (value.category !== undefined && !isDocumentCategory(value.category)) errors.push("category must be a trimmed name of 1–80 characters without control characters");
  if (value.category_reason !== undefined && (!isNonEmptyString(value.category_reason) || value.category_reason.length > 2000 || value.category === undefined)) errors.push("category_reason must be non-empty, at most 2000 characters, and requires category");

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
      if (entity.aliases !== undefined && (!Array.isArray(entity.aliases) || entity.aliases.some((alias) => !isNonEmptyString(alias)))) {
        errors.push(`entities[${index}].aliases must be an array of non-empty strings`);
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

  if (value.facts !== undefined) {
    if (!Array.isArray(value.facts)) errors.push("facts must be an array");
    else {
      const ids = new Set<string>();
      value.facts.forEach((fact, index) => {
        const prefix = `facts[${index}]`;
        if (!isRecord(fact)) { errors.push(`${prefix} must be an object`); return; }
        if (typeof fact.id !== "string" || !/^fact_[A-Za-z0-9_-]{1,120}$/.test(fact.id)) errors.push(`${prefix}.id must be a stable fact_ identifier`);
        else if (ids.has(fact.id)) errors.push(`${prefix}.id is duplicated`);
        else ids.add(fact.id);
        for (const key of ["text", "provenance"] as const) if (!isNonEmptyString(fact[key])) errors.push(`${prefix}.${key} must be a non-empty string`);
        if (fact.entity !== undefined && !isNonEmptyString(fact.entity)) errors.push(`${prefix}.entity must be a non-empty string`);
        if (!isTimestamp(fact.valid_from)) errors.push(`${prefix}.valid_from must be an ISO timestamp with timezone`);
        for (const key of ["valid_until", "withdrawn_at"] as const) {
          if (fact[key] !== undefined && (!isTimestamp(fact[key]) || Date.parse(fact[key]) < Date.parse(String(fact.valid_from)))) errors.push(`${prefix}.${key} must be a timestamp at or after valid_from`);
        }
        if (fact.valid_until !== undefined && Date.parse(String(fact.valid_until)) === Date.parse(String(fact.valid_from))) errors.push(`${prefix}.valid_until must be after valid_from`);
        if (fact.replaces !== undefined && (typeof fact.replaces !== "string" || !/^fact_[A-Za-z0-9_-]{1,120}$/.test(fact.replaces))) errors.push(`${prefix}.replaces must name a fact_ identifier`);
        if (fact.withdrawn_at !== undefined && !isNonEmptyString(fact.withdrawal_reason)) errors.push(`${prefix}.withdrawal_reason is required`);
        if (fact.withdrawal_reason !== undefined && (fact.withdrawn_at === undefined || !isNonEmptyString(fact.withdrawal_reason))) errors.push(`${prefix}.withdrawal_reason requires withdrawn_at`);
      });
    }
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidMetadata(value: unknown): asserts value is DocNexusMetadata {
  const result = validateMetadata(value);
  if (!result.valid) {
    throw new DocNexusError("invalid_metadata", `Invalid metadata: ${result.errors.join("; ")}`);
  }
}
