import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { initializeProject } from "../src/project.js";
import { getManagedRecord, inspectRecords, listManagedDocuments, upsertManagedDocument } from "../src/managed-documents.js";
import { createDraft, sealDraft, listDrafts } from "../src/drafts.js";

const roots: string[] = [];
const children = new Set<ChildProcess>();
let runtime: string;
const metadata = { title: "Memory", summary: "Project convention", tags: [], entities: [], relationships: [] };
const input = { file_path: "memory.md", source: "original source", document: "Original convention", metadata };

beforeAll(async () => {
  runtime = await mkdtemp(join(tmpdir(), "docnexus-crash-runtime-"));
  await writeFile(join(runtime, "package.json"), '{"type":"module"}');
  await symlink(resolve("node_modules"), join(runtime, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  for (const file of (await readdir(resolve("src"))).filter((name) => name.endsWith(".ts"))) {
    const code = ts.transpileModule(await readFile(resolve("src", file), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
    await writeFile(join(runtime, file.replace(/\.ts$/, ".js")), code);
  }
  await writeFile(join(runtime, "worker.mjs"), `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { upsertManagedDocument, deleteManagedDocument } from './managed-documents.js';
    import { ingestDraft } from './document-service.js';
    import { withProjectLock } from './project-lock.js';
    process.on('message', () => {}); // Keep the IPC channel alive while paused at a crash checkpoint.
    const { root, input, stopAt, rollback, deletion, draftId, hold } = JSON.parse(process.argv[2]);
    const pause = async () => { process.send('checkpoint'); await new Promise(() => {}); };
    if (hold) await withProjectLock(root, pause);
    const rename = fs.rename;
    let failing = false;
    fs.rename = async (from, to) => {
      if (rollback && !failing && String(to).endsWith('timeline.md')) { failing = true; throw new Error('injected failure'); }
      await rename(from, to);
      if ((rollback && failing && String(to).endsWith('library/memory.md')) || (!rollback && stopAt && String(to).endsWith(stopAt))) await pause();
    };
    const rm = fs.rm;
    fs.rm = async (path, options) => { await rm(path, options); if (deletion && String(path).endsWith(deletion)) await pause(); };
    syncBuiltinESMExports();
    if (deletion) await deleteManagedDocument(root, { id: deletion, confirm: true });
    else if (draftId) await ingestDraft(root, { draftId, replace: true });
    else await upsertManagedDocument(root, input);
    process.send('done');
    process.disconnect();
  `);
});

afterAll(async () => { await rm(runtime, { recursive: true, force: true }); });
afterEach(async () => {
  for (const child of children) { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; } }
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root() {
  const path = await mkdtemp(join(tmpdir(), "docnexus-crash-"));
  roots.push(path);
  await initializeProject(path);
  return path;
}

function worker(options: Record<string, unknown>, env = process.env) {
  const child = fork(join(runtime, "worker.mjs"), [JSON.stringify(options)], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [], env });
  children.add(child);
  let errors = "";
  child.stderr!.on("data", (data) => { errors += data; });
  const message = new Promise<string>((accept, reject) => {
    child.once("message", (value) => accept(String(value)));
    child.once("error", reject);
    child.once("exit", (code) => { if (code !== 0) reject(new Error(`worker exited ${code}: ${errors}`)); });
  });
  return { child, message };
}

async function crash(options: Record<string, unknown>) {
  const { child, message } = worker(options);
  expect(await message).toBe("checkpoint");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

describe("serialized writes and durable text recovery", () => {
  it("preserves both concurrent updates and one document identity", async () => {
    const path = await root();
    const original = await upsertManagedDocument(path, input);
    const a = worker({ root: path, input: { ...input, source: "first concurrent source", document: "First convention" } });
    const b = worker({ root: path, input: { ...input, source: "second concurrent source", document: "Second convention" } });
    expect(await Promise.all([a.message, b.message])).toEqual(["done", "done"]);
    const saved = await getManagedRecord(path, original.id);
    expect(saved.timeline).toContain("first concurrent source");
    expect(saved.timeline).toContain("second concurrent source");
    expect(await listManagedDocuments(path)).toHaveLength(1);
    expect((await inspectRecords(path)).ok).toBe(true);
  });

  it("shares the lock across TMPDIR settings, blocks readers and releases it after a process is killed", async () => {
    const path = await root();
    const saved = await upsertManagedDocument(path, input);
    const holder = worker({ root: path, hold: true }, { ...process.env, TMPDIR: path });
    expect(await holder.message).toBe("checkpoint");
    let read = false;
    const reading = getManagedRecord(path, saved.id).then((value) => { read = true; return value; });
    await new Promise((accept) => setTimeout(accept, 100));
    expect(read).toBe(false);
    const exited = once(holder.child, "exit");
    holder.child.kill("SIGKILL");
    await exited;
    expect((await reading).document).toBe(input.document);
  });

  it.each([false, true])("replays an interrupted %s-existing document save before reading", async (existing) => {
    const path = await root();
    if (existing) await upsertManagedDocument(path, input);
    const next = { ...input, source: "crash source", document: "Recovered convention" };
    await crash({ root: path, input: next, stopAt: "library/memory.md" });
    const documents = await listManagedDocuments(path);
    const saved = await getManagedRecord(path, documents[0].id);
    expect(saved).toMatchObject({ source: next.source, document: next.document });
    expect(saved.timeline!.split("crash source")).toHaveLength(2);
    expect((await inspectRecords(path)).ok).toBe(true);
    expect(await readFile(join(path, "docnexus/concepts/uncategorized.md"), "utf8")).toContain("**Memory**");
  });

  it("finishes an interrupted rollback to the previous complete document", async () => {
    const path = await root();
    const saved = await upsertManagedDocument(path, input);
    const before = await getManagedRecord(path, saved.id);
    await crash({ root: path, input: { ...input, source: "failed source", document: "Failed convention" }, rollback: true });
    expect(await getManagedRecord(path, saved.id)).toEqual(before);
    expect((await inspectRecords(path)).ok).toBe(true);
  });

  it("recovers deletion after its record directory has already disappeared", async () => {
    const path = await root();
    const saved = await upsertManagedDocument(path, input);
    await crash({ root: path, deletion: saved.id });
    expect(await listManagedDocuments(path)).toEqual([]);
    expect(await readFile(join(path, "docnexus/CONCEPTS.md"), "utf8")).toContain("No project memory yet");
    await expect(readFile(join(path, "docnexus/concepts/uncategorized.md"), "utf8")).rejects.toThrow();
  });

  it("commits the draft receipt together with memory after an ingestion crash", async () => {
    const path = await root();
    const draft = await createDraft(path);
    for (const [name, content] of [["source", input.source], ["document", input.document], ["metadata", JSON.stringify(metadata)]] as const) await writeFile(join(path, draft.artifacts[name]), content);
    await sealDraft(path, { draftId: draft.draft_id, filePath: input.file_path });
    await crash({ root: path, input, draftId: draft.draft_id, stopAt: "record.json" });
    const documents = await listManagedDocuments(path);
    expect(documents).toHaveLength(1);
    expect((await listDrafts(path)).drafts[0]).toMatchObject({ status: "ingested", document_id: documents[0].id });
  });

  it("refuses journal paths outside managed memory before applying any entry", async () => {
    const path = await root();
    const saved = await upsertManagedDocument(path, input);
    const before = await readFile(join(path, "docnexus/library/memory.md"), "utf8");
    await writeFile(join(path, "docnexus/.runtime/transaction.json"), JSON.stringify({ version: 1, phase: "apply", entries: [{ path: "docnexus/library/memory.md", before, after: "tamper" }, { path: "../escape.md", before: null, after: "escape" }], remove_directories: [], rollback_directories: [] }));
    await expect(getManagedRecord(path, saved.id)).rejects.toThrow("transaction path");
    expect(await readFile(join(path, "docnexus/library/memory.md"), "utf8")).toBe(before);
  });

  it("rejects a recovery directory redirected outside the project", async () => {
    const path = await root();
    const other = await root();
    const saved = await upsertManagedDocument(path, input);
    await rm(join(path, "docnexus/.runtime"), { recursive: true });
    await symlink(other, join(path, "docnexus/.runtime"), process.platform === "win32" ? "junction" : "dir");
    await expect(getManagedRecord(path, saved.id)).rejects.toThrow("symbolic");
  });

  it("recovers a fact replacement and dependent generated pages in the same transaction", async () => {
    const path = await root();
    const old = { id: "fact_crash_old", text: "Original fact value", provenance: "Initial source", valid_from: "2020-01-01T00:00:00Z" };
    const next = { id: "fact_crash_next", text: "Recovered fact value", provenance: "Revised source", valid_from: "2020-01-02T00:00:00Z", replaces: old.id };
    const owner = { ...input, document: "# Canonical registry", metadata: { ...metadata, facts: [old] } };
    await upsertManagedDocument(path, owner);
    const usage = await upsertManagedDocument(path, { ...input, file_path: "usage.md", document: "# Usage\n\n{{fact:fact_crash_old}}\n" });
    const timeline = (await getManagedRecord(path, usage.id)).timeline;
    await crash({ root: path, input: { ...owner, metadata: { ...metadata, facts: [old, next] } }, stopAt: "record.json" });
    const recovered = await getManagedRecord(path, usage.id);
    expect(recovered.document).toContain("Recovered fact value");
    expect(recovered.document).not.toContain("Original fact value");
    expect(recovered.timeline).toBe(timeline);
    expect((await inspectRecords(path)).ok).toBe(true);
  });
});
