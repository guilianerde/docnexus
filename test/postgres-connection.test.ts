import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { initializeProject } from "../src/project.js";
import { deleteManagedDocument, upsertManagedDocument } from "../src/managed-documents.js";
import { LocalHashEmbedder } from "../src/embedder.js";
import { syncRetrievalIndex, inspectRetrievalIndex } from "../src/retrieval-index.js";
import { recall } from "../src/recall.js";
import { withRetrievalDatabase } from "../src/postgres-engine.js";
import { resetProjectData } from "../src/reset.js";
import { tables } from "../src/postgres-store.js";

const roots: string[] = [];
afterEach(async () => { delete process.env.DOCNEXUS_DATABASE_URL; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("uses Postgres wire connections, isolated project schemas and incremental index maintenance", async () => {
  // CI can point at native Postgres+pgvector. Locally use an actual PostgreSQL WASM kernel over the wire protocol.
  const pg = process.env.DOCNEXUS_TEST_DATABASE_URL ? undefined : await PGlite.create({ extensions: { vector } });
  const server = pg ? new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 }) : undefined;
  if (server) await server.start();
  process.env.DOCNEXUS_DATABASE_URL = process.env.DOCNEXUS_TEST_DATABASE_URL ?? `postgres://postgres:postgres@${server!.getServerConn()}/postgres`;
  const embedder = new LocalHashEmbedder();
  const metadata = { title: "Wire test", summary: "Postgres connection test", tags: [], entities: [], relationships: [] };
  try {
    for (let index = 0; index < 2; index++) { const root = await mkdtemp(join(tmpdir(), "docnexus-wire-")); roots.push(root); await initializeProject(root); }
    const saved = await upsertManagedDocument(roots[0], { file_path: "wire.md", source: "Test source", document: "# Wire\n\nRefresh tokens rotate hourly.", metadata });
    await syncRetrievalIndex(roots[0], {}, embedder);
    const oid = await withRetrievalDatabase(roots[0], async db => {
      expect(db.kind).toBe("postgres");
      await expect(db.transaction(async tx => {
        await tx.query(`UPDATE ${tables(tx).documents} SET title='rollback' WHERE id=$1`, [saved.id]);
        throw new Error("rollback probe");
      })).rejects.toThrow("rollback probe");
      expect((await db.query<{ title: string }>(`SELECT title FROM ${tables(db).documents} WHERE id=$1`, [saved.id]))[0].title).toBe(metadata.title);
      return (await db.query<{ oid: number; storage: string }>("SELECT oid::int AS oid,relfilenode::text AS storage FROM pg_class WHERE oid=to_regclass($1)", [`${db.schema}.chunks_embedding_idx`]))[0];
    });
    expect((await recall(roots[0], { query: "Refresh tokens", limit: 1 }, embedder)).results[0].document_ref.document_id).toBe(saved.id);
    expect((await recall(roots[1], { query: "Refresh tokens" }, embedder)).results).toEqual([]);
    await deleteManagedDocument(roots[0], { id: saved.id, confirm: true });
    await upsertManagedDocument(roots[0], { file_path: "wire.md", source: "New source", document: "# Wire\n\nRefresh tokens rotate on every use.", metadata });
    await syncRetrievalIndex(roots[0], {}, embedder);
    expect((await inspectRetrievalIndex(roots[0])).in_sync).toBe(true);
    expect(await withRetrievalDatabase(roots[0], async db => (await db.query<{ oid: number; storage: string }>("SELECT oid::int AS oid,relfilenode::text AS storage FROM pg_class WHERE oid=to_regclass($1)", [`${db.schema}.chunks_embedding_idx`]))[0])).toEqual(oid);
    await resetProjectData(roots[0], { force: true });
    expect(await withRetrievalDatabase(roots[0], async db => (await db.query<{ present: boolean }>("SELECT to_regnamespace($1) IS NOT NULL AS present", [db.schema]))[0].present)).toBe(false);
  } finally {
    for (const root of roots) await withRetrievalDatabase(root, db => db.exec(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`)).catch(() => {});
    delete process.env.DOCNEXUS_DATABASE_URL;
    if (server) await server.stop();
    if (pg) await pg.close();
  }
}, 60_000);
