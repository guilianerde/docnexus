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

/** One fact-chain problem with the field to change and a field-specific repair. */
export interface FactIssue {
  fact_id: string;
  field: "id" | "entity" | "replaces" | "valid_from" | "text" | "provenance" | "valid_until" | "withdrawn_at" | "withdrawal_reason";
  problem: string;
  message: string;
  fix: string;
  source_path?: string;
  /** The other fact this issue depends on, such as the fact being replaced. */
  related_fact_id?: string;
}

const immutableFixes: Record<"text" | "provenance" | "entity" | "valid_from" | "replaces", (id: string) => string> = {
  text: (id) => `Restore the stored text of ${id}. To correct the claim, add a new fact with the same entity and "replaces": "${id}"; to retract it, set withdrawn_at and withdrawal_reason on ${id}.`,
  provenance: (id) => `Restore the stored provenance of ${id}. Record the new source on a new fact with the same entity and "replaces": "${id}".`,
  entity: (id) => `Restore the stored entity of ${id}; a fact never moves to another entity. If the entity was only renamed, keep the old name on the fact and add the new name to that entity's aliases. If the claim belongs to a different entity, withdraw ${id} (withdrawn_at, withdrawal_reason) and add a new fact for that entity without "replaces".`,
  valid_from: (id) => `Restore the stored valid_from of ${id}. For a later effective time, add a new fact with "replaces": "${id}"; if ${id} itself took effect at a different time, withdraw ${id} and add a corrected fact without "replaces".`,
  replaces: (id) => `Restore the stored replaces of ${id}. To restructure the chain, withdraw ${id} and add a new fact that replaces the newest fact in the intended chain.`
};

function issue(fact: { id: string; source_path?: string }, field: FactIssue["field"], problem: string, message: string, fix: string, related?: string): FactIssue {
  return { fact_id: fact.id, field, problem, message, fix, ...(fact.source_path ? { source_path: fact.source_path } : {}), ...(related ? { related_fact_id: related } : {}) };
}

/** Thrown with every collected issue so one seal reports the whole fact chain at once. */
export function factIssuesError(issues: FactIssue[]): DocNexusError {
  const lines = issues.map((value, index) => `${index + 1}. ${value.message} Fix: ${value.fix}`);
  return new DocNexusError("knowledge_conflict", `${issues.length} fact issue(s):\n${lines.join("\n")}`, { issues });
}

/** Resolves facts and their lifecycle, collecting every chain problem instead of stopping at the first. */
export function analyzeKnowledge(documents: KnowledgeDocument[], at = new Date().toISOString()) {
  if (!isTimestamp(at)) throw new DocNexusError("invalid_params", "--at must be an ISO timestamp with timezone");
  const resolver = createEntityResolver(documents);
  const issues: FactIssue[] = [];
  const facts = new Map<string, ResolvedFact>();
  for (const document of documents) {
    for (const fact of document.metadata.facts ?? []) {
      const located = { id: fact.id, source_path: document.file_path };
      const existing = facts.get(fact.id);
      if (existing) {
        issues.push(issue(located, "id", "duplicate_id", `duplicate project fact id: ${fact.id} (also in ${existing.source_path}).`,
          `Fact ids are project-wide. Keep ${fact.id} in one document and give the other fact a new unique id.`));
        continue;
      }
      let entity: MetadataEntity | undefined;
      if (fact.entity) {
        let ambiguous = false;
        try {
          entity = resolver.resolve(fact.entity);
        } catch (error) {
          if (!(error instanceof DocNexusError)) throw error;
          ambiguous = true;
          issues.push(issue(located, "entity", "ambiguous_entity", `fact ${fact.id} entity is ambiguous: ${fact.entity}.`,
            "Use a canonical entity name that matches exactly one entity; check candidates with `docnexus concepts --query`."));
        }
        if (!entity && !ambiguous) {
          issues.push(issue(located, "entity", "undeclared_entity", `fact ${fact.id} names an undeclared entity: ${fact.entity}.`,
            `Declare "${fact.entity}" in this document's entities, or use an existing canonical name or alias (check with \`docnexus concepts --query "${fact.entity}"\`).`));
        }
      }
      facts.set(fact.id, { ...fact, entity: entity?.name ?? fact.entity, document_id: document.id, source_path: document.file_path, status: "active" });
    }
  }
  const successors = new Map<string, ResolvedFact>();
  for (const fact of facts.values()) {
    if (!fact.replaces) continue;
    const previous = facts.get(fact.replaces);
    if (!previous) {
      issues.push(issue(fact, "replaces", "replaces_unknown", `fact ${fact.id} replaces unknown fact: ${fact.replaces}.`,
        `Point replaces at an existing fact id (\`docnexus facts list --include-inactive\`), or restore ${fact.replaces} if this update removed it.`));
      continue;
    }
    if (previous.id === fact.id) {
      issues.push(issue(fact, "replaces", "replaces_self", `fact cannot replace itself: ${fact.id}.`, `Remove replaces from ${fact.id} or point it at the earlier fact it supersedes.`));
      continue;
    }
    if (previous.entity !== fact.entity) {
      issues.push(issue(fact, "entity", "replacement_entity_mismatch",
        `replacement entity mismatch: ${fact.id} has entity ${fact.entity ?? "(none)"} but replaces ${previous.id} with entity ${previous.entity ?? "(none)"}.`,
        `A replacement keeps the entity of the fact it replaces. If ${fact.entity ?? "the new entity"} is a new name for ${previous.entity ?? "the old entity"}, set entity to "${previous.entity ?? ""}" and add the new name to its aliases. If the claim is about a different entity, remove replaces from ${fact.id} and withdraw ${previous.id} (withdrawn_at, withdrawal_reason).`, previous.id));
    }
    if (Date.parse(previous.valid_from) > Date.parse(fact.valid_from)) {
      issues.push(issue(fact, "valid_from", "replacement_predates", `replacement predates earlier fact: ${fact.id} (${fact.valid_from}) is earlier than ${previous.id} (${previous.valid_from}).`,
        `Set valid_from of ${fact.id} to ${previous.valid_from} or later. If ${previous.id} was recorded with the wrong effective time, withdraw it and add ${fact.id} without replaces.`, previous.id));
    }
    if (previous.withdrawn_at && Date.parse(previous.withdrawn_at) <= Date.parse(fact.valid_from)) {
      issues.push(issue(fact, "replaces", "replaces_withdrawn", `cannot replace withdrawn fact: ${previous.id} (withdrawn ${previous.withdrawn_at}).`,
        `Remove replaces from ${fact.id}; a withdrawn fact has no successor, so the new claim stands on its own.`, previous.id));
    }
    const sibling = successors.get(previous.id);
    if (sibling) {
      issues.push(issue(fact, "replaces", "replacement_fork", `fact already has a replacement: ${previous.id} is replaced by ${sibling.id} and ${fact.id}.`,
        `Keep one chain: point replaces of ${fact.id} at the newest fact in the chain (starting from ${sibling.id}), or merge it into ${sibling.id}.`));
      continue;
    }
    successors.set(previous.id, fact);
  }
  const cyclic = new Set<string>();
  const time = Date.parse(at);
  for (const fact of facts.values()) {
    const seen = new Set<string>();
    let current: ResolvedFact | undefined = fact;
    while (current) {
      if (seen.has(current.id)) {
        const members = [...seen].sort();
        if (!members.some((id) => cyclic.has(id))) {
          members.forEach((id) => cyclic.add(id));
          issues.push(issue(fact, "replaces", "cyclic_replacements", `cyclic fact replacements: ${members.join(" → ")}.`,
            "Break the cycle: each fact's replaces must point to an earlier fact, and the oldest fact in a chain has no replaces."));
        }
        break;
      }
      seen.add(current.id);
      current = current.replaces ? facts.get(current.replaces) : undefined;
    }
    const successor = successors.get(fact.id);
    if (Date.parse(fact.valid_from) > time) fact.status = "scheduled";
    else if (fact.withdrawn_at && Date.parse(fact.withdrawn_at) <= time) fact.status = "withdrawn";
    else if (successor && Date.parse(successor.valid_from) <= time) { fact.status = "superseded"; fact.replaced_by = successor.id; }
    else if (fact.valid_until && Date.parse(fact.valid_until) <= time) fact.status = "expired";
  }
  return { resolver, facts: [...facts.values()], at, issues };
}

export function resolveKnowledge(documents: KnowledgeDocument[], at = new Date().toISOString()) {
  const { issues, ...knowledge } = analyzeKnowledge(documents, at);
  if (issues.length > 0) throw factIssuesError(issues);
  return knowledge;
}

/** Changes an update makes to facts that are already stored. */
export function factUpdateIssues(previous: KnowledgeDocument | undefined, document: KnowledgeDocument): FactIssue[] {
  const issues: FactIssue[] = [];
  for (const old of previous?.metadata.facts ?? []) {
    const located = { id: old.id, source_path: document.file_path };
    const next = document.metadata.facts?.find((fact) => fact.id === old.id);
    if (!next) {
      issues.push(issue(located, "id", "historical_fact_removed", `preserve historical fact ${old.id}; replace or withdraw it explicitly.`,
        `Restore ${old.id} exactly as stored (\`docnexus document get --id ${previous!.id} --include metadata\`). To retire it, add a fact that replaces it or set withdrawn_at and withdrawal_reason.`));
      continue;
    }
    for (const key of ["text", "provenance", "entity", "valid_from", "replaces"] as const) {
      if (next[key] !== old[key]) {
        issues.push(issue(located, key, "immutable_field", `fact ${old.id} ${key} is immutable (stored ${JSON.stringify(old[key] ?? null)}, draft ${JSON.stringify(next[key] ?? null)}).`, immutableFixes[key](old.id)));
      }
    }
    for (const key of ["valid_until", "withdrawn_at", "withdrawal_reason"] as const) {
      if (old[key] !== undefined && old[key] !== next[key]) {
        issues.push(issue(located, key, "irreversible_field", `fact ${old.id} ${key} cannot be undone (stored ${JSON.stringify(old[key])}).`,
          `Restore ${key} of ${old.id} to ${JSON.stringify(old[key])}. To state the claim as current again, add a new fact without replaces.`));
      }
    }
  }
  return issues;
}

/** Validate the entire prospective project before a text intent is persisted, reporting every fact issue together. */
export function validateKnowledgeUpdate(documents: KnowledgeDocument[], document: KnowledgeDocument, at?: string) {
  const previous = documents.find((value) => value.id === document.id);
  const prospective = [...documents.filter((value) => value.id !== document.id), document];
  const updateIssues = factUpdateIssues(previous, document);
  const { issues: chainIssues, ...knowledge } = analyzeKnowledge(prospective, at);
  // Report each problem once: an update issue on a fact already explains chain issues it causes on that field,
  // whether on the fact itself or on a fact that replaces it.
  const explained = (chain: FactIssue) => updateIssues.some((value) => value.field === chain.field &&
    (value.fact_id === chain.fact_id || value.fact_id === chain.related_fact_id));
  const issues = [...updateIssues, ...chainIssues.filter((chain) => !explained(chain))];
  if (issues.length > 0) throw factIssuesError(issues);
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
