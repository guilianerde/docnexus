import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeProject } from "../src/project.js";
import { deleteManagedDocument, getManagedRecord, upsertManagedDocument } from "../src/managed-documents.js";
import { resolveKnowledge, type KnowledgeDocument } from "../src/knowledge.js";
import { listFacts } from "../src/knowledge-service.js";
import { validateMetadata } from "../src/metadata.js";
import { searchDocuments } from "../src/search.js";
import { buildConceptIndex } from "../src/concepts.js";
import { syncRetrievalIndex, listIndexedChunks, inspectRetrievalIndex } from "../src/retrieval-index.js";
import { LocalHashEmbedder } from "../src/embedder.js";
import { withRetrievalDatabase } from "../src/postgres-engine.js";
import { tables } from "../src/postgres-store.js";
import { recall } from "../src/recall.js";
import { runCli } from "../src/cli.js";
import type { DocNexusMetadata, MetadataFact } from "../src/types.js";

const roots: string[] = [];
const metadata: DocNexusMetadata = { title: "Authentication", summary: "Current credential policy", tags: [], entities: [{ name: "Auth service", type: "component", description: "Authentication", aliases: ["认证服务", "AuthSvc"] }], relationships: [] };
const input = { file_path: "auth.md", source: "Approved by user", document: "Current policy is managed by Auth service.", metadata };
const old: MetadataFact = { id: "fact_rotation_old", text: "obsolete_fact_marker: tokens rotate daily", provenance: "Meeting 2026-01-01", entity: "AuthSvc", valid_from: "2026-01-01T00:00:00Z" };
const next: MetadataFact = { id: "fact_rotation_new", text: "current_fact_marker: tokens rotate hourly", provenance: "User decision 2026-10-14", entity: "认证服务", valid_from: "2026-10-14T12:00:00Z", replaces: old.id };
const at = "2026-10-14T13:00:00Z";
const embedder = new LocalHashEmbedder();

async function root() {
  const path = await mkdtemp(join(tmpdir(), "docnexus-knowledge-"));
  roots.push(path);
  await initializeProject(path);
  return path;
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function document(facts: MetadataFact[]): KnowledgeDocument {
  return { id: "doc_fixture", file_path: input.file_path, metadata: { ...metadata, facts } };
}

describe("entity identity and fact lifecycle", () => {
  it("validates aliases, attribution, timezone timestamps and withdrawal reasons", () => {
    expect(validateMetadata({ ...metadata, facts: [old, next] }).valid).toBe(true);
    for (const fact of [{ ...old, provenance: "" }, { ...old, valid_from: "2026-10-14" }, { ...old, valid_until: "2025-01-01T00:00:00Z" }, { ...old, withdrawn_at: at }]) expect(validateMetadata({ ...metadata, facts: [fact] }).valid).toBe(false);
    expect(validateMetadata({ ...metadata, entities: [{ ...metadata.entities[0], aliases: [42] }] }).valid).toBe(false);
  });

  it("keeps the earlier fact current until its explicit replacement becomes effective", () => {
    const documents = [document([old, next])];
    expect(resolveKnowledge(documents, "2026-10-14T11:59:59Z").facts.map((fact) => fact.status)).toEqual(["active", "scheduled"]);
    expect(resolveKnowledge(documents, next.valid_from).facts.map((fact) => fact.status)).toEqual(["superseded", "active"]);
    expect(resolveKnowledge(documents, at).facts[0]).toMatchObject({ entity: "Auth service", replaced_by: next.id, provenance: old.provenance, source_path: "auth.md" });
  });

  it("expires and withdraws facts without resurrecting their predecessors", () => {
    const expired = { ...next, valid_until: at };
    expect(resolveKnowledge([document([old, expired])], at).facts.map((fact) => fact.status)).toEqual(["superseded", "expired"]);
    const withdrawn = { ...next, withdrawn_at: at, withdrawal_reason: "Incorrect decision" };
    expect(resolveKnowledge([document([old, withdrawn])], at).facts.map((fact) => fact.status)).toEqual(["superseded", "withdrawn"]);
  });

  it("preserves distinct legacy entity types when no alias claims to merge them", () => {
    const record = document([]);
    record.metadata.entities.push({ name: "Auth service", type: "concept", description: "Different concept" });
    expect(resolveKnowledge([record], at).resolver.canonicalize(record.metadata).entities).toHaveLength(2);
  });

  it("rejects dangling, cyclic, ambiguous and cross-entity replacements", () => {
    expect(() => resolveKnowledge([document([next])], at)).toThrow("unknown fact");
    expect(() => resolveKnowledge([document([old, { ...next, id: old.id }])], at)).toThrow("duplicate project fact");
    expect(() => resolveKnowledge([document([{ ...old, replaces: next.id, valid_from: next.valid_from }, next])], at)).toThrow("cyclic fact");
    expect(() => resolveKnowledge([document([old, next, { ...next, id: "fact_fork" }])], at)).toThrow("already has a replacement");
    expect(() => resolveKnowledge([document([old, { ...next, entity: undefined }])], at)).toThrow("entity mismatch");
    expect(() => resolveKnowledge([document([old, { ...next, valid_from: "2025-01-01T00:00:00Z" }])], at)).toThrow("predates");
  });

  it("resolves aliases across documents, search, concept listings and graph endpoints", async () => {
    const path = await root();
    await upsertManagedDocument(path, input);
    const other = await upsertManagedDocument(path, { ...input, file_path: "implementation.md", metadata: { ...metadata, title: "Implementation", entities: [{ name: "AuthSvc", type: "component", description: "Auth implementation" }, { name: "Token", type: "concept", description: "Credential" }], relationships: [{ from: "认证服务", to: "Token", type: "implements", description: "Issues credentials" }] } });
    expect((await searchDocuments(path, { query: "认证服务" })).results.map((result) => result.id)).toContain(other.id);
    expect((await buildConceptIndex(path, { query: "AuthSvc" })).concepts).toEqual([expect.objectContaining({ name: "Auth service", aliases: expect.arrayContaining(["AuthSvc", "认证服务"]), documents: ["auth.md", "implementation.md"] })]);
    await syncRetrievalIndex(path, {}, embedder);
    expect(await withRetrievalDatabase(path, db => db.query(`SELECT name FROM ${tables(db).concepts} WHERE type='component'`))).toEqual([{ name: "Auth service" }]);
    expect(await withRetrievalDatabase(path, db => db.query(`SELECT c.name FROM ${tables(db).edges} e JOIN ${tables(db).concepts} c ON c.id=e.from_id WHERE e.label='IMPLEMENTS'`))).toEqual([{ name: "Auth service" }]);
    await expect(upsertManagedDocument(path, { ...input, file_path: "ambiguous.md", metadata: { ...metadata, entities: [{ name: "Other service", type: "component", description: "Other", aliases: ["AuthSvc"] }] } })).rejects.toThrow("ambiguous entity alias");
  });

  it("preserves fact identity, resolves cross-document replacements and prevents dangling deletion", async () => {
    const path = await root();
    const original = await upsertManagedDocument(path, { ...input, metadata: { ...metadata, facts: [old] } });
    await expect(upsertManagedDocument(path, input)).rejects.toThrow("preserve historical fact");
    await expect(upsertManagedDocument(path, { ...input, metadata: { ...metadata, facts: [{ ...old, text: "rewritten" }] } })).rejects.toThrow("immutable");
    const replacement = await upsertManagedDocument(path, { ...input, file_path: "new-policy.md", metadata: { ...metadata, facts: [next] } });
    expect((await listFacts(path, { entity: "AuthSvc", at })).facts).toEqual([expect.objectContaining({ id: next.id, entity: "Auth service", status: "active" })]);
    expect((await listFacts(path, { at, includeInactive: true })).facts).toHaveLength(2);
    await expect(deleteManagedDocument(path, { id: original.id, confirm: true })).rejects.toThrow("unknown fact");
    await expect(deleteManagedDocument(path, { id: replacement.id, confirm: true })).rejects.toThrow("replacement history");
    expect((await getManagedRecord(path, original.id)).metadata!.facts).toEqual([old]);
  });

  it("persists withdrawal and refuses restoring the old claim by removing its withdrawal", async () => {
    const path = await root();
    vi.setSystemTime(new Date(at));
    const saved = await upsertManagedDocument(path, { ...input, metadata: { ...metadata, facts: [old] } });
    await syncRetrievalIndex(path, {}, embedder);
    const withdrawn = { ...old, withdrawn_at: at, withdrawal_reason: "Incorrect source" };
    await upsertManagedDocument(path, { ...input, metadata: { ...metadata, facts: [withdrawn] } });
    expect((await listFacts(path)).facts).toEqual([]);
    expect((await listFacts(path, { includeInactive: true })).facts[0]).toMatchObject({ status: "withdrawn", withdrawal_reason: "Incorrect source" });
    await syncRetrievalIndex(path, {}, embedder);
    expect((await listIndexedChunks(path, saved.id)).map((chunk) => chunk.text).join("\n")).not.toContain("obsolete_fact_marker");
    await expect(upsertManagedDocument(path, { ...input, metadata: { ...metadata, facts: [old] } })).rejects.toThrow("cannot be undone");
  });

  it("refreshes fact chunks on effective-time changes without rewriting text or timeline", async () => {
    const path = await root();
    vi.setSystemTime(new Date("2026-10-14T11:59:00Z"));
    const saved = await upsertManagedDocument(path, { ...input, metadata: { ...metadata, facts: [old, { ...next, valid_until: at }] } });
    const before = await getManagedRecord(path, saved.id);
    await syncRetrievalIndex(path, {}, embedder);
    expect((await listIndexedChunks(path, saved.id)).map((chunk) => chunk.text).join("\n")).toContain("obsolete_fact_marker");
    vi.setSystemTime(new Date(next.valid_from));
    expect((await inspectRetrievalIndex(path)).outdated).toEqual([saved.id]);
    const recalled = await recall(path, { query: "current_fact_marker", limit: 1 }, embedder);
    expect(recalled.context_groups[0].facts).toEqual(expect.arrayContaining([expect.objectContaining({ id: old.id, status: "superseded" }), expect.objectContaining({ id: next.id, status: "active" })]));
    const chunks = (await listIndexedChunks(path, saved.id)).map((chunk) => chunk.text).join("\n");
    expect(chunks).toContain("current_fact_marker");
    expect(chunks).not.toContain("obsolete_fact_marker");
    expect((await searchDocuments(path, { query: "obsolete_fact_marker" })).results).toEqual([]);
    vi.setSystemTime(new Date(at));
    await syncRetrievalIndex(path, {}, embedder);
    expect((await listIndexedChunks(path, saved.id)).map((chunk) => chunk.text).join("\n")).not.toContain("current_fact_marker");
    expect(await getManagedRecord(path, saved.id)).toEqual(before);
  });

  it("invalidates an earlier document projection when another document supersedes its fact", async () => {
    const path = await root();
    vi.setSystemTime(new Date(at));
    const saved = await upsertManagedDocument(path, { ...input, metadata: { ...metadata, facts: [old] } });
    await syncRetrievalIndex(path, {}, embedder);
    await upsertManagedDocument(path, { ...input, file_path: "replacement.md", metadata: { ...metadata, facts: [next] } });
    expect((await inspectRetrievalIndex(path)).outdated).toContain(saved.id);
    await syncRetrievalIndex(path, {}, embedder);
    expect((await listIndexedChunks(path, saved.id)).map((chunk) => chunk.text).join("\n")).not.toContain("obsolete_fact_marker");
  });

  it("lists facts through the CLI using aliases and an explicit historical timestamp", async () => {
    const path = await root();
    await upsertManagedDocument(path, { ...input, metadata: { ...metadata, facts: [old, next] } });
    const output = JSON.parse(await runCli(["facts", "list", "--entity", "认证服务", "--at", at, "--include-inactive"], path));
    expect(output.facts.map((fact: { status: string }) => fact.status)).toEqual(["active", "superseded"]);
    await expect(runCli(["facts", "list", "--at", "yesterday"], path)).rejects.toThrow("ISO timestamp");
    await expect(runCli(["recall", "tokens", "--mode", "unknown"], path)).rejects.toThrow("mode");
  });
});
