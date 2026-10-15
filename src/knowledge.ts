import { DocNexusError } from "./errors.js";
import { sha256, stableJson } from "./hash.js";
import { isTimestamp } from "./metadata.js";
import { entityTypes, type DocNexusMetadata, type EntityType, type MetadataEntity, type MetadataFact } from "./types.js";
import { factReferenceIds, renderFactDocument } from "./fact-renderer.js";

export const normalizeName = (value: string): string => value.normalize("NFKC").trim().toLowerCase();

export interface KnowledgeDocument {
  id: string;
  file_path: string;
  metadata: DocNexusMetadata;
  document?: string;
  document_hash?: string;
}

export type FactStatus = "active" | "scheduled" | "expired" | "superseded" | "withdrawn";
export interface ResolvedFact extends MetadataFact {
  status: FactStatus;
  replaced_by?: string;
  document_id: string;
  source_path: string;
}

/** Explicit aliases resolve to a canonical entity; ambiguous claims fail rather than silently merge. */
export function createEntityResolver(documents: KnowledgeDocument[]) {
  const declarations = documents.flatMap((document) => document.metadata.entities);
  const aliases = new Map<string, string>();
  const declared = new Map<string, MetadataEntity>();
  for (const entity of declarations) {
    const key = `${entity.type}:${normalizeName(entity.name)}`;
    const prior = declared.get(key);
    if (!prior) declared.set(key, entity);
    const local = new Set<string>();
    for (const alias of entity.aliases ?? []) {
      const aliasKey = normalizeName(alias);
      if (aliasKey === normalizeName(entity.name) || local.has(aliasKey)) throw new DocNexusError("knowledge_conflict", `duplicate entity alias: ${alias}`);
      local.add(aliasKey);
      if (aliases.has(aliasKey) && aliases.get(aliasKey) !== key) throw new DocNexusError("knowledge_conflict", `ambiguous entity alias: ${alias}`);
      aliases.set(aliasKey, key);
    }
  }
  const canonicalKey = (name: string, type: EntityType): string => {
    let key = `${type}:${normalizeName(name)}`;
    const seen = new Set<string>();
    while (aliases.has(key.slice(key.indexOf(":") + 1))) {
      if (seen.has(key)) throw new DocNexusError("knowledge_conflict", `cyclic entity aliases: ${name}`);
      seen.add(key);
      const target = aliases.get(key.slice(key.indexOf(":") + 1))!;
      if (!target.startsWith(`${type}:`)) throw new DocNexusError("knowledge_conflict", `alias entity type mismatch: ${name}`);
      key = target;
    }
    return key;
  };
  const entities = new Map<string, MetadataEntity>();
  for (const entity of declarations) {
    const key = canonicalKey(entity.name, entity.type);
    const canonical = declared.get(key)!;
    if (canonical.type !== entity.type) throw new DocNexusError("knowledge_conflict", `alias entity type mismatch: ${entity.name}`);
    if (!entities.has(key)) entities.set(key, { ...canonical, name: canonical.name.trim(), aliases: [] });
    const target = entities.get(key)!;
    for (const name of [entity.name, ...(entity.aliases ?? [])]) {
      if (normalizeName(name) !== normalizeName(target.name) && !target.aliases!.some((alias) => normalizeName(alias) === normalizeName(name))) target.aliases!.push(name.trim());
    }
  }
  const resolve = (name: string, type?: EntityType): MetadataEntity | undefined => {
    const candidates = new Map<string, MetadataEntity>();
    const aliasTarget = aliases.get(normalizeName(name));
    for (const candidateType of type ? [type] : aliasTarget ? [aliasTarget.slice(0, aliasTarget.indexOf(":")) as EntityType] : entityTypes) {
      const key = canonicalKey(name, candidateType);
      const entity = entities.get(key);
      if (entity) candidates.set(key, entity);
    }
    if (candidates.size > 1) throw new DocNexusError("knowledge_conflict", `ambiguous entity name: ${name}; use a distinct canonical name`);
    return [...candidates.values()][0];
  };
  const endpoint = (metadata: DocNexusMetadata, name: string): MetadataEntity | undefined => {
    const local = metadata.entities.find((entity) => [entity.name, ...(entity.aliases ?? [])].some((value) => normalizeName(value) === normalizeName(name)));
    return resolve(name, local?.type);
  };
  return {
    resolve,
    canonicalize: (metadata: DocNexusMetadata): DocNexusMetadata => {
      const mapped = new Map(metadata.entities.map((entity) => {
        const canonical = entities.get(canonicalKey(entity.name, entity.type))!;
        return [canonicalKey(entity.name, entity.type), canonical] as const;
      }));
      const relationships = metadata.relationships.map((edge) => {
        const from = endpoint(metadata, edge.from);
        const to = endpoint(metadata, edge.to);
        for (const entity of [from, to]) if (entity) mapped.set(canonicalKey(entity.name, entity.type), entity);
        return { ...edge, from: from?.name ?? edge.from, to: to?.name ?? edge.to };
      });
      return { ...metadata, entities: [...mapped.values()], relationships };
    }
  };
}

export function resolveKnowledge(documents: KnowledgeDocument[], at = new Date().toISOString()) {
  if (!isTimestamp(at)) throw new DocNexusError("invalid_params", "--at must be an ISO timestamp with timezone");
  const resolver = createEntityResolver(documents);
  const facts = new Map<string, ResolvedFact>();
  for (const document of documents) {
    for (const fact of document.metadata.facts ?? []) {
      if (facts.has(fact.id)) throw new DocNexusError("knowledge_conflict", `duplicate project fact id: ${fact.id}`);
      const entity = fact.entity ? resolver.resolve(fact.entity) : undefined;
      if (fact.entity && !entity) throw new DocNexusError("knowledge_conflict", `fact ${fact.id} names an undeclared entity: ${fact.entity}`);
      facts.set(fact.id, { ...fact, entity: entity?.name, document_id: document.id, source_path: document.file_path, status: "active" });
    }
  }
  const successors = new Map<string, ResolvedFact>();
  for (const fact of facts.values()) {
    if (!fact.replaces) continue;
    const previous = facts.get(fact.replaces);
    if (!previous) throw new DocNexusError("knowledge_conflict", `fact ${fact.id} replaces unknown fact: ${fact.replaces}`);
    if (previous.id === fact.id) throw new DocNexusError("knowledge_conflict", `fact cannot replace itself: ${fact.id}`);
    if (previous.entity !== fact.entity) throw new DocNexusError("knowledge_conflict", `replacement entity mismatch: ${fact.id}`);
    if (Date.parse(previous.valid_from) > Date.parse(fact.valid_from)) throw new DocNexusError("knowledge_conflict", `replacement predates earlier fact: ${fact.id}`);
    if (previous.withdrawn_at && Date.parse(previous.withdrawn_at) <= Date.parse(fact.valid_from)) throw new DocNexusError("knowledge_conflict", `cannot replace withdrawn fact: ${previous.id}`);
    if (successors.has(previous.id)) throw new DocNexusError("knowledge_conflict", `fact already has a replacement: ${previous.id}`);
    successors.set(previous.id, fact);
  }
  for (const fact of facts.values()) {
    const seen = new Set<string>();
    let current: ResolvedFact | undefined = fact;
    while (current) {
      if (seen.has(current.id)) throw new DocNexusError("knowledge_conflict", `cyclic fact replacements: ${fact.id}`);
      seen.add(current.id);
      current = current.replaces ? facts.get(current.replaces) : undefined;
    }
    const time = Date.parse(at);
    const successor = successors.get(fact.id);
    if (Date.parse(fact.valid_from) > time) fact.status = "scheduled";
    else if (fact.withdrawn_at && Date.parse(fact.withdrawn_at) <= time) fact.status = "withdrawn";
    else if (successor && Date.parse(successor.valid_from) <= time) { fact.status = "superseded"; fact.replaced_by = successor.id; }
    else if (fact.valid_until && Date.parse(fact.valid_until) <= time) fact.status = "expired";
  }
  return { resolver, facts: [...facts.values()], at };
}

/** Validate the entire prospective project before a text intent is persisted. */
export function validateKnowledgeUpdate(documents: KnowledgeDocument[], document: KnowledgeDocument, at?: string) {
  const previous = documents.find((value) => value.id === document.id);
  for (const old of previous?.metadata.facts ?? []) {
    const next = document.metadata.facts?.find((fact) => fact.id === old.id);
    if (!next) throw new DocNexusError("knowledge_conflict", `preserve historical fact ${old.id}; replace or withdraw it explicitly`);
    for (const key of ["text", "provenance", "entity", "valid_from", "replaces"] as const) {
      if (next[key] !== old[key]) throw new DocNexusError("knowledge_conflict", `fact ${old.id} ${key} is immutable; create a new fact with replaces`);
    }
    for (const key of ["valid_until", "withdrawn_at", "withdrawal_reason"] as const) {
      if (old[key] !== undefined && old[key] !== next[key]) throw new DocNexusError("knowledge_conflict", `fact ${old.id} ${key} cannot be undone; create a new fact`);
    }
  }
  const prospective = [...documents.filter((value) => value.id !== document.id), document];
  const knowledge = resolveKnowledge(prospective, at);
  for (const entry of prospective) if (entry.document !== undefined) renderFactDocument(entry.document, knowledge.facts);
  return { documents: prospective, knowledge };
}

export function factsForDocuments(facts: ResolvedFact[], documentIds: string[], knowledgeDocuments: KnowledgeDocument[] = []): ResolvedFact[] {
  const documents = new Set(documentIds);
  const included = new Set(facts.filter((fact) => documents.has(fact.document_id)).map((fact) => fact.id));
  for (const document of knowledgeDocuments) if (documents.has(document.id) && document.document !== undefined) {
    for (const id of factReferenceIds(document.document)) included.add(id);
  }
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  for (const id of included) {
    const successor = byId.get(id)?.replaced_by;
    if (successor) included.add(successor);
  }
  return facts.filter((fact) => included.has(fact.id));
}

export function projectionKnowledge(knowledge: ReturnType<typeof resolveKnowledge>, document: KnowledgeDocument, rendered = renderFactDocument(document.document ?? "", knowledge.facts)) {
  const metadata = knowledge.resolver.canonicalize(document.metadata);
  const referenced = new Set(rendered.references.filter((reference) => reference.status === "active").map((reference) => reference.fact_id));
  const facts = knowledge.facts.filter((fact) => (fact.document_id === document.id || referenced.has(fact.id)) && fact.status === "active");
  return {
    metadata,
    facts,
    signature: sha256(stableJson({ entities: metadata.entities, relationships: metadata.relationships, facts,
      rendered_document_hash: sha256(rendered.document) }))
  };
}
