import { asDocNexusError, DocNexusError } from "./errors.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import postgres from "postgres";
import { sha256 } from "./hash.js";
import { storePath } from "./layout.js";
import { assertNoSymbolicLinks, ensureIgnoredEntries } from "./workspace-io.js";
import { withProjectLock } from "./project-lock.js";

export interface RetrievalDatabase {
  kind: "pglite" | "postgres";
  schema: string;
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<T[]>;
  exec(text: string): Promise<void>;
  transaction<T>(operation: (tx: RetrievalDatabase) => Promise<T>): Promise<T>;
}

const sessions = new AsyncLocalStorage<{ root: string; db: RetrievalDatabase }>();

export function pglitePath(root: string): string { return join(storePath(root), "brain.pglite"); }

/** A database lease is scoped to one CLI operation; no idle pool or WASM instance remains. */
export async function withRetrievalDatabase<T>(root: string, operation: (db: RetrievalDatabase) => Promise<T>, create = true): Promise<T | undefined> {
  return withProjectLock(root, () => openRetrievalDatabase(root, operation, create)).catch(error => { throw asDocNexusError(error, "index_unavailable"); });
}

async function openRetrievalDatabase<T>(root: string, operation: (db: RetrievalDatabase) => Promise<T>, create: boolean): Promise<T | undefined> {
  root = await realpath(root);
  const held = sessions.getStore();
  if (held?.root === root) return operation(held.db);
  const url = process.env.DOCNEXUS_DATABASE_URL;
  const schema = `docnexus_${sha256(root).slice(0, 24)}`;
  let db: RetrievalDatabase;
  let close: () => Promise<void>;
  if (url) {
    if (!/^postgres(?:ql)?:\/\//.test(url)) throw new DocNexusError("index_unavailable", "DOCNEXUS_DATABASE_URL must be a PostgreSQL connection URL");
    const sql = postgres(url, { max: 1, connect_timeout: 10, idle_timeout: 5, connection: { application_name: "docnexus" }, onnotice: () => {} });
    const adapt = (client: { unsafe: Function }, transactional = false): RetrievalDatabase => ({
      kind: "postgres", schema,
      query: async <R>(text: string, values: unknown[] = []) => Array.from(await client.unsafe(text, values)) as R[],
      exec: async (text) => { await client.unsafe(text); },
      transaction: async <R>(callback: (tx: RetrievalDatabase) => Promise<R>): Promise<R> => {
        if (transactional) return callback(adapt(client, true));
        let value!: R;
        await sql.begin(async tx => { value = await callback(adapt(tx, true)); });
        return value;
      }
    });
    db = adapt(sql);
    close = () => sql.end({ timeout: 5 });
  } else {
    await assertNoSymbolicLinks(root, "docnexus/store");
    await assertNoSymbolicLinks(root, "docnexus/store/brain.pglite");
    if (!create && !await stat(pglitePath(root)).then(() => true).catch(() => false)) return undefined;
    await mkdir(storePath(root), { recursive: true });
    await ensureIgnoredEntries(root, ["store/", ".runtime/"]);
    const pg = await PGlite.create(pglitePath(root), { extensions: { vector } });
    const adapt = (client: { query: Function; exec: Function }, transactional = false): RetrievalDatabase => ({
      kind: "pglite", schema,
      query: async <R>(text: string, values: unknown[] = []) => (await client.query(text, values)).rows as R[],
      exec: async (text) => { await client.exec(text); },
      transaction: async (callback) => transactional ? callback(adapt(client, true)) : pg.transaction(async (tx) => callback(adapt(tx, true)))
    });
    db = adapt(pg);
    close = () => pg.close();
  }
  try { return await sessions.run({ root, db }, () => operation(db)); }
  catch (error) {
    // Do not expose credentials embedded in driver connection errors.
    if (url) throw new DocNexusError(error instanceof DocNexusError ? error.code : "index_unavailable", `Postgres retrieval operation failed: ${String((error as Error).message).replaceAll(url, "[database URL]").replace(/postgres(?:ql)?:\/\/[^\s]+/g, "[database URL]")}`);
    throw error;
  } finally { await close(); }
}
