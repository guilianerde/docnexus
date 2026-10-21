import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { upsertManagedDocument } from "../src/managed-documents.js";
import { startDocumentViewer } from "../src/viewer.js";
import { observeUsage, USAGE_MAX_BYTES } from "../src/usage.js";
import { withProjectLock } from "../src/project-lock.js";

const roots: string[] = [];
const query = "PRIVATE_QUERY_CANARY";
const metadata = { title: "PRIVATE_TITLE_CANARY", summary: "PRIVATE_SUMMARY_CANARY", category: "PRIVATE_CATEGORY_CANARY", tags: [], entities: [], relationships: [] };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() {
  const path = await mkdtemp(join(tmpdir(), "docnexus-usage-"));
  roots.push(path);
  await runCli(["init"], path);
  return path;
}
async function command(path: string, args: string[]) { return JSON.parse(await runCli(args, path)); }
async function seed(path: string) {
  return upsertManagedDocument(path, { file_path: "PRIVATE_PATH_CANARY.md", source: "PRIVATE_SOURCE_CANARY", document: `${query}\nPRIVATE_BODY_CANARY`, metadata });
}
async function events(path: string) { return (await command(path, ["usage", "export"])).events; }

it("is opt-in and disabling preserves records without changing command output", async () => {
  const path = await root(); await seed(path);
  const before = await runCli(["search", query], path);
  expect(await command(path, ["usage", "status"])).toMatchObject({ enabled: false, events: 0 });
  await expect(stat(join(path, ".docnexus/.runtime/usage.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  await command(path, ["usage", "enable"]);
  expect(await runCli(["search", query], path)).toBe(before);
  expect(await command(path, ["usage", "status"])).toMatchObject({ enabled: true, events: 1 });
  await command(path, ["usage", "disable"]);
  expect(await runCli(["search", query], path)).toBe(before);
  expect(await command(path, ["usage", "status"])).toMatchObject({ enabled: false, events: 1 });
  expect(await readFile(join(path, ".docnexus/.gitignore"), "utf8")).toContain(".runtime/");
});

it("exports correlated pseudonyms without query text, document text, names, paths, credentials or the key", async () => {
  const path = await root(); const saved = await seed(path);
  await command(path, ["usage", "enable"]);
  await command(path, ["search", query, "--category", metadata.category]);
  await command(path, ["search", query, "--category", metadata.category]);
  await command(path, ["document", "get", "--id", saved.id]);
  await expect(runCli(["doctor"], path, { doctor: async () => { throw new Error("postgres://SECRET_CREDENTIAL_CANARY@host/db"); } })).rejects.toThrow("SECRET_CREDENTIAL_CANARY");
  const exported = await command(path, ["usage", "export"]);
  const text = JSON.stringify(exported);
  const config = JSON.parse(await readFile(join(path, ".docnexus/.runtime/usage-config.json"), "utf8"));
  for (const secret of [query, path, saved.id, config.key, ...Object.values(metadata).filter(value => typeof value === "string"),
    "PRIVATE_PATH_CANARY", "PRIVATE_SOURCE_CANARY", "PRIVATE_BODY_CANARY", "SECRET_CREDENTIAL_CANARY"]) expect(text).not.toContain(secret);
  expect(exported.events[0].query_id).toMatch(/^[a-f0-9]{64}$/);
  expect(exported.events[0].query_id).toBe(exported.events[1].query_id);
  expect(exported.events[0].results[0].document_id).toBe(exported.events[2].document_id);
  expect(exported.events[3]).toMatchObject({ status: "error", error_code: "internal_error" });
  const other = await root(); await seed(other); await command(other, ["usage", "enable"]); await command(other, ["search", query]);
  expect((await events(other))[0].query_id).not.toBe(exported.events[0].query_id);
});

it("measures retrieval work and evidence delivery without another index or snapshot scan", async () => {
  const path = await root(); await seed(path); await command(path, ["usage", "enable"]);
  await command(path, ["recall", query, "--limit", "1"]);
  await command(path, ["recall", query, "--limit", "1", "--return-unit", "section", "--context-budget", "2000"]);
  const [first, second] = await events(path);
  expect(first).toMatchObject({ status: "ok", result_count: 1, metrics: { document_count: 1, relationship_declarations: 0,
    snapshot_loads: 2, database_opens: 2, sync_attempts: 1, keyword_candidates: 1, vector_candidates: 1, keyword_top1_retained: 1 } });
  expect(first.metrics.sync_embedded_chunks).toBeGreaterThan(0);
  expect(first.metrics.embedding_calls).toBeGreaterThan(2);
  expect(second).toMatchObject({ metrics: { snapshot_loads: 3, embedding_calls: 2, sync_embedded_chunks: 0, sync_processed_documents: 0, recall_result_count: 1 },
    evidence: { primary_documents: 1, budget: 2000 } });
  expect(second.evidence.estimated_tokens).toBeLessThanOrEqual(2000);
  expect(first.duration_ms).toBeGreaterThan(0);
  expect(first.metrics.embedding_ms).toBeGreaterThan(0);
  expect(first.metrics.database_open_ms).toBeGreaterThan(0);
});

it("links explicit feedback to the selected query without treating hits as useful answers", async () => {
  const path = await root(); await command(path, ["usage", "enable"]);
  await command(path, ["search", query]);
  const [event] = await events(path);
  expect(event).toMatchObject({ result_count: 0, status: "ok" });
  expect(event.rating).toBeUndefined();
  await command(path, ["usage", "feedback", "--rating", "miss", "--reason", "needs_multihop"]);
  await command(path, ["usage", "feedback", "--event", event.event_id, "--rating", "partial", "--reason", "truncated"]);
  expect((await events(path)).slice(1)).toEqual([
    expect.objectContaining({ kind: "feedback", target_event_id: event.event_id, rating: "miss", reason: "needs_multihop" }),
    expect.objectContaining({ kind: "feedback", target_event_id: event.event_id, rating: "partial", reason: "truncated" })
  ]);
  await expect(command(path, ["usage", "feedback", "--rating", "miss", "--reason", "SECRET"])).rejects.toMatchObject({ code: "invalid_params" });
  await expect(command(path, ["usage", "feedback", "--event", "unknown", "--rating", "miss"])).rejects.toMatchObject({ code: "invalid_params" });
  await command(path, ["usage", "disable"]);
  await expect(command(path, ["usage", "feedback", "--rating", "miss"])).rejects.toMatchObject({ code: "invalid_params" });
});

it("serializes concurrent events and isolates a partial line left by an interrupted writer", async () => {
  const path = await root(); await command(path, ["usage", "enable"]);
  await appendFile(join(path, ".docnexus/.runtime/usage.jsonl"), '{"schema_version":');
  await Promise.all(Array.from({ length: 8 }, () => command(path, ["search", query])));
  const report = await command(path, ["usage", "export"]);
  expect(report.invalid_lines).toBe(1);
  expect(report.events).toHaveLength(8);
  expect(new Set(report.events.map((event: any) => event.event_id)).size).toBe(8);
});

it("does not follow log symlinks or replace a successful command with a recorder failure", async () => {
  const path = await root(); await command(path, ["usage", "enable"]);
  const target = join(path, "outside.log"); await writeFile(target, "untouched");
  await symlink(target, join(path, ".docnexus/.runtime/usage.jsonl"));
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(await command(path, ["search", query])).toMatchObject({ results: [] });
  expect(await readFile(target, "utf8")).toBe("untouched");
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining("usage recording unavailable"));
  await rm(join(path, ".docnexus/.runtime/usage.jsonl"));
  await mkdir(join(path, ".docnexus/.runtime/usage.jsonl"));
  await expect(command(path, ["document", "get", "--id", "invalid"])).rejects.toMatchObject({ code: "invalid_params" });
});

it("bounds disk usage and reports a full log without failing retrieval", async () => {
  const path = await root(); await command(path, ["usage", "enable"]);
  const log = join(path, ".docnexus/.runtime/usage.jsonl"); await writeFile(log, ""); await truncate(log, USAGE_MAX_BYTES);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(await command(path, ["search", query])).toMatchObject({ results: [] });
  expect((await stat(log)).size).toBe(USAGE_MAX_BYTES);
  expect(await command(path, ["usage", "status"])).toMatchObject({ full: true, events: 0, invalid_lines: 1 });
});

it("does not hold up a completed operation for the normal project-lock timeout", async () => {
  const path = await root(); await command(path, ["usage", "enable"]);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  let acquired!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const holder = withProjectLock(path, async () => { acquired(); await held; });
  await ready;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("recorder blocked the completed operation")), 2500); });
    expect(await Promise.race([observeUsage(path, ["search", query], async () => "original result"), deadline])).toBe("original result");
  } finally { clearTimeout(timer); release(); await holder; }
  expect(await events(path)).toHaveLength(0);
});

it("records viewer document queries with the same local collector", async () => {
  const path = await root(); await seed(path); await command(path, ["usage", "enable"]);
  const viewer = await startDocumentViewer(path);
  try {
    expect((await fetch(`${viewer.url}/api/documents?page=1&page_size=10`)).status).toBe(200);
    expect((await events(path))[0]).toMatchObject({ surface: "viewer", command: "document", action: "query", returned_documents: 1,
      options: { page: 1, page_size: 10 }, metrics: { snapshot_loads: 1 } });
  } finally { await viewer.close(); }
});
