import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializeProject } from "../src/project.js";
import { upsertManagedDocument } from "../src/managed-documents.js";
import { createDraft } from "../src/drafts.js";
import { queryDocuments } from "../src/document-query.js";
import { runDoctor } from "../src/doctor.js";
import { LocalHashEmbedder } from "../src/embedder.js";
import { inspectRetrievalIndex, syncRetrievalIndex } from "../src/retrieval-index.js";
import { withRetrievalDatabase } from "../src/postgres-engine.js";
import { ensurePostgresStore, inspectProjectionSchema, PROJECTION_SCHEMA_VERSION, tables, writeIndexState } from "../src/postgres-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "docnexus-schema-")); roots.push(root);
  await initializeProject(root);
  const saved = await upsertManagedDocument(root, { file_path: "guide.md", source: "Decision", document: "# Guide\n\nCurrent knowledge.", metadata: { title: "Guide", summary: "Guide", tags: [], entities: [], relationships: [] } });
  const draft = await createDraft(root);
  await syncRetrievalIndex(root, {}, new LocalHashEmbedder());
  const files = ["docnexus/library/guide.md", ...["record.json", "source.md", "metadata.json", "timeline.md"].map(name => `docnexus/records/${saved.id}/${name}`)];
  return { root, draft, files, contents: await Promise.all(files.map(file => readFile(join(root, file), "utf8"))) };
}

it.each(["unversioned", "old", "partial"])("diagnoses and rebuilds a %s projection without changing canonical text or drafts", async kind => {
  const { root, draft, files, contents } = await setup();
  await withRetrievalDatabase(root, async db => {
    if (kind === "unversioned") await db.query(`DELETE FROM ${tables(db).state} WHERE key='projection_schema_version'`);
    else if (kind === "old") await writeIndexState(db, "projection_schema_version", "1");
    else await db.exec(`ALTER TABLE ${tables(db).chunks} DROP COLUMN source_anchor`);
  });
  expect(await inspectRetrievalIndex(root)).toMatchObject({ in_sync: false, schema_status: "legacy" });
  expect((await runDoctor(root)).issues.some(issue => issue.code === "index_outdated")).toBe(true);
  expect((await queryDocuments(root)).total).toBe(1);
  expect((await syncRetrievalIndex(root, {}, new LocalHashEmbedder())).processed_documents).toBe(1);
  expect(await inspectRetrievalIndex(root)).toMatchObject({ in_sync: true, schema_status: "current", expected_schema_version: PROJECTION_SCHEMA_VERSION });
  expect(await Promise.all(files.map(file => readFile(join(root, file), "utf8")))).toEqual(contents);
  expect(await readFile(join(root, ".docnexus/skills/.docnexus-skills.json"), "utf8")).toBeTruthy();
  expect(draft.draft_id).toBeTruthy();
  await expect((await import("node:fs/promises")).stat(join(root, draft.draft_directory))).resolves.toBeDefined();
});

it("refuses an unknown projection version while keeping text reads available", async () => {
  const { root } = await setup();
  await withRetrievalDatabase(root, db => writeIndexState(db, "projection_schema_version", "999"));
  expect(await inspectRetrievalIndex(root)).toMatchObject({ schema_status: "unsupported", schema_version: "999", in_sync: false });
  await expect(syncRetrievalIndex(root, {}, new LocalHashEmbedder())).rejects.toMatchObject({ code: "index_schema_incompatible" });
  expect((await queryDocuments(root)).total).toBe(1);
  const doctor = await runDoctor(root);
  expect(doctor.issues.some(issue => issue.code === "index_schema_incompatible")).toBe(true);
});

it("rolls back a failed schema upgrade and retries it safely", async () => {
  const { root } = await setup();
  await withRetrievalDatabase(root, async db => {
    await writeIndexState(db, "projection_schema_version", "1");
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementation(callback => transaction(async tx => {
      const exec = tx.exec.bind(tx);
      vi.spyOn(tx, "exec").mockImplementation(async sql => { if (sql.includes("CREATE EXTENSION")) throw new Error("schema creation interrupted"); return exec(sql); });
      return callback(tx);
    }));
    await expect(ensurePostgresStore(db)).rejects.toThrow("schema creation interrupted");
    expect(await inspectProjectionSchema(db)).toMatchObject({ status: "legacy", version: "1" });
    expect((await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${tables(db).documents}`))[0].count).toBe(1);
  });
  expect((await syncRetrievalIndex(root, {}, new LocalHashEmbedder())).processed_documents).toBe(1);
});
