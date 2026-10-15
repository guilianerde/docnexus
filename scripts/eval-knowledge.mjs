import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runCli } from "../dist/src/cli.js";
import { queryDocuments } from "../dist/src/document-query.js";
import { getManagedRecord } from "../dist/src/managed-documents.js";
import { searchDocuments } from "../dist/src/search.js";
import { renderViewerMarkdown } from "../dist/src/viewer.js";

const fixture = JSON.parse(await readFile(new URL("../test/fixtures/knowledge-eval.json", import.meta.url), "utf8"));
delete process.env.DOCNEXUS_DATABASE_URL; // This evaluation owns only its temporary local projection.
const root = await mkdtemp(join(tmpdir(), "docnexus-knowledge-eval-"));
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("knowledge evaluation forbids network access"); };
const rows = [];
const sources = [];
const records = new Map();
function check(name, actual, expected) {
  try { assert.deepEqual(actual, expected); rows.push({ name, passed: true }); }
  catch (error) { rows.push({ name, passed: false, message: error.message }); }
}
async function refused(name, operation, pattern) {
  try { await operation(); rows.push({ name, passed: false, message: "Operation was unexpectedly accepted" }); }
  catch (error) { check(name, pattern.test(error.message), true); }
}
async function cli(...args) { return JSON.parse(await runCli(args, root)); }
async function prepare(input) {
  const base = (await queryDocuments(root, { all: true })).documents.find(document => document.file_path === input.file_path);
  const draft = await cli("draft", "new", "--slug", "knowledge-eval");
  for (const [key, value] of Object.entries({ source: input.source, document: input.document, metadata: JSON.stringify(input.metadata) })) {
    await writeFile(join(root, draft.artifacts[key]), value);
  }
  await cli("draft", "seal", "--id", draft.draft_id, "--file", input.file_path, "--base-version", base?.record_version ?? "new");
  return draft;
}
async function save(input, replace = false) {
  const draft = await prepare(input);
  return cli("document", "add", "--draft", draft.draft_id, ...(replace ? ["--replace"] : []));
}
try {
  await cli("init");
  for (const document of fixture.documents) {
    const source = await readFile(new URL(`../${document.source_path}`, import.meta.url), "utf8");
    // Fail if the recorded extraction no longer has its original evidence.
    assert(document.evidence.every((quote) => source.includes(quote)), `Source drift: ${document.source_path}; reread and review the fixture`);
    sources.push({ path: document.source_path, sha256: createHash("sha256").update(source).digest("hex") });
    const result = await save({ file_path: document.path, source, document: document.body, metadata: {
      title: document.title, summary: document.summary, category: document.category, category_reason: document.category_reason,
      tags: [], entities: [], relationships: [], facts: document.facts
    } });
    records.set(document.path, result.id);
  }
  let snapshot = await queryDocuments(root, { all: true });
  check("capture complete real-source corpus", snapshot.total, fixture.documents.length);
  check("reuse an existing category across related documents", snapshot.categories.find((category) => category.id === "文档展示")?.count, 2);
  check("every initial category has a recorded basis", snapshot.documents.every((document) => Boolean(document.category_reason)), true);
  const first = await queryDocuments(root, { page: 1, page_size: 2 });
  const pages = [...first.documents];
  for (let page = 2; page <= first.pagination.total_pages; page++) pages.push(...(await queryDocuments(root, { page, page_size: 2, revision: first.revision })).documents);
  check("full and paginated views agree", pages, snapshot.documents);
  for (const change of fixture.classification_changes) {
    const id = records.get(change.path);
    const before = await getManagedRecord(root, id);
    const revision = (await queryDocuments(root)).revision;
    await cli("document", "classify", "--id", id, "--category", change.category, "--reason", change.reason, "--revision", revision);
    const after = await getManagedRecord(root, id);
    check(`classification preserves content: ${change.path}`, [after.source, after.document, after.metadata.facts], [before.source, before.document, before.metadata.facts]);
    check(`classification retains its basis: ${change.path}`, after.metadata.category_reason, change.reason);
    check(`classification is audited: ${change.path}`, after.timeline.includes(change.reason), true);
  }
  snapshot = await queryDocuments(root, { all: true });
  check("unused category disappears after splitting", snapshot.categories.some((category) => category.id === "验证与发布"), false);
  await refused("old page is rejected after classification", () => queryDocuments(root, { page: 2, revision: first.revision }), /document_revision_changed/);

  const queryId = records.get("documents/query.md");
  const readerId = records.get("documents/browser.md");
  const owner = await getManagedRecord(root, queryId, ["source", "document", "template", "metadata", "timeline"]);
  const reader = await getManagedRecord(root, readerId);
  const beforeFactRevision = snapshot.revision;
  const update = fixture.simulated_update;
  await save({ file_path: "documents/query.md", source: update.source, document: owner.template, metadata: { ...owner.metadata, facts: [...owner.metadata.facts, update.fact] } }, true);
  snapshot = await queryDocuments(root, { all: true });
  const currentQuery = snapshot.documents.find((document) => document.id === queryId);
  const currentReader = snapshot.documents.find((document) => document.id === readerId);
  const oldText = owner.metadata.facts[0].text;
  for (const document of [currentQuery, currentReader]) {
    const html = renderViewerMarkdown(document.document);
    check(`replacement reaches current view: ${document.file_path}`, html.includes(update.fact.text) && !html.includes(oldText), true);
    check(`replacement provenance resolves to owner: ${document.file_path}`, document.fact_references.find((reference) => reference.reference_id === update.fact.replaces), { reference_id: update.fact.replaces, fact_id: update.fact.id, status: "active", source_document_id: queryId });
  }
  const afterReader = await getManagedRecord(root, readerId);
  check("dependent source, metadata and history stay unchanged", [afterReader.source, afterReader.metadata, afterReader.timeline], [reader.source, reader.metadata, reader.timeline]);
  check("old fact is retained as history", currentQuery.facts.find((fact) => fact.id === update.fact.replaces)?.status, "superseded");
  check("unrelated valid fact survives update", currentQuery.facts.find((fact) => fact.id === "fact_eval_text_source")?.status, "active");
  const definitions = (await Promise.all(snapshot.documents.map((document) => getManagedRecord(root, document.id, ["metadata"])))).flatMap((document) => document.metadata.facts ?? []);
  check("one canonical definition per fact", new Set(definitions.map((fact) => fact.id)).size, definitions.length);
  await refused("old page is rejected after fact replacement", () => queryDocuments(root, { revision: beforeFactRevision }), /document_revision_changed/);

  const releaseId = records.get("operations/release.md");
  const release = await getManagedRecord(root, releaseId);
  const staged = await prepare({ file_path: "operations/release.md", source: "评估模拟：补充发布说明", document: `${release.document}\n\n补充发布说明。`, metadata: release.metadata });
  const newer = { file_path: "operations/release.md", source: "评估模拟：另一条已确认的新知识", document: `${release.document}\n\n保留新的离线验证结果。`, metadata: release.metadata };
  await save(newer, true);
  await refused("stale draft cannot discard newer knowledge", () => cli("document", "add", "--draft", staged.draft_id, "--replace"), /target changed since sealing/);
  const preserved = await getManagedRecord(root, releaseId);
  check("rejection preserves latest knowledge", preserved.document, newer.document);
  await writeFile(join(root, staged.artifacts.document), `${preserved.document}\n\n补充发布说明。`);
  await cli("draft", "seal", "--id", staged.draft_id, "--file", "operations/release.md", "--base-version", preserved.record_version);
  await cli("document", "add", "--draft", staged.draft_id, "--replace");
  const merged = await getManagedRecord(root, releaseId);
  check("reviewed merge keeps both changes", merged.document.includes("保留新的离线验证结果") && merged.document.includes("补充发布说明"), true);
  check("merge preserves earlier source history", merged.timeline.includes(newer.source) && merged.timeline.includes(release.source), true);

  const found = await searchDocuments(root, { query: "page_size", limit: 10 });
  check("literal lookup finds both fact expressions", [queryId, readerId].every((id) => found.results.some((result) => result.id === id)), true);
  check("lookup does not expose old assertion as a current snippet", found.results.every((result) => !renderViewerMarkdown(result.snippet).includes(oldText)), true);
  const lookupOwner = found.results.find((result) => result.id === readerId)?.facts?.find((fact) => fact.id === update.fact.id);
  check("lookup carries canonical owner citation", lookupOwner?.source_path, "documents/query.md");
  const unsupported = await searchDocuments(root, { query: "UNSUPPORTED_VENDOR_PRICE_2050" });
  check("unsupported literal identifier has no evidence", unsupported.results.length, 0);
  const failed = rows.filter((row) => !row.passed);
  console.log(JSON.stringify({
    kind: fixture.kind, sources, documents: fixture.documents.length,
    checks: { total: rows.length, passed: rows.length - failed.length, failed: failed.length }, rows,
    model_quality: { measured: false, review_tasks: fixture.model_review_tasks },
    limits: "Replays reviewed extraction/classification decisions against real repository sources, with explicitly simulated updates in a disposable workspace. Does not measure live model classification, proactive reads, conflict detection, answer quality or abstention."
  }, null, 2));
  if (failed.length) process.exitCode = 1;
} finally {
  globalThis.fetch = previousFetch;
  await rm(root, { recursive: true, force: true });
}
