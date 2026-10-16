import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { appendFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { asDocNexusError, DocNexusError, errorDefinitions } from "./errors.js";
import { withProjectLock } from "./project-lock.js";
import { packageVersion } from "./skills.js";
import { atomicWrite, assertNoSymbolicLinks, ensureIgnoredEntries, readIfExists } from "./workspace-io.js";
import { usageMetrics, type UsageMetrics } from "./usage-metrics.js";

const directory = join("docnexus", ".runtime");
const configFile = join(directory, "usage-config.json");
const logFile = join(directory, "usage.jsonl");
export const USAGE_MAX_BYTES = 10 * 1024 * 1024;
export const usageRatings = ["useful", "partial", "miss"] as const;
export const usageReasons = ["needs_multihop", "missing_document", "irrelevant", "truncated", "stale", "slow", "other"] as const;
interface UsageConfig { enabled: boolean; key: string; full?: boolean }
type UsageEvent = Record<string, any>;

async function readConfig(root: string): Promise<UsageConfig | undefined> {
  await assertNoSymbolicLinks(root, configFile);
  const text = await readIfExists(join(root, configFile));
  if (text === undefined) return undefined;
  const config = JSON.parse(text);
  if (typeof config.enabled !== "boolean" || !/^[a-f0-9]{64}$/.test(config.key)) throw new DocNexusError("invalid_params", "invalid local usage configuration");
  return config;
}

export async function configureUsage(root: string, enabled: boolean) {
  return withProjectLock(root, async () => {
    const config = await readConfig(root) ?? { enabled: false, key: randomBytes(32).toString("hex") };
    await ensureIgnoredEntries(root, [".runtime/"]);
    await atomicWrite(join(root, configFile), JSON.stringify({ ...config, enabled }) + "\n");
    return usageStatus(root);
  });
}

async function readEvents(root: string) {
  await assertNoSymbolicLinks(root, logFile);
  const text = await readIfExists(join(root, logFile)) ?? "";
  const events: UsageEvent[] = [];
  let invalidLines = 0;
  for (const line of text.split("\n").filter(line => line.trim())) {
    try {
      const event = JSON.parse(line);
      if (event.schema_version !== 1 || !["command", "feedback"].includes(event.kind)) throw new Error("invalid event");
      events.push(event);
    } catch { invalidLines++; }
  }
  return { events, invalid_lines: invalidLines, bytes: Buffer.byteLength(text) };
}

export async function usageStatus(root: string) {
  return withProjectLock(root, async () => {
    const config = await readConfig(root);
    const log = await readEvents(root);
    return { enabled: config?.enabled ?? false, log_file: logFile, bytes: log.bytes, max_bytes: USAGE_MAX_BYTES,
      full: config?.full === true || log.bytes >= USAGE_MAX_BYTES, events: log.events.length, invalid_lines: log.invalid_lines,
      latest_query_event: log.events.findLast(event => event.kind === "command" && event.query_id)?.event_id ?? null };
  });
}

export async function exportUsage(root: string) {
  return withProjectLock(root, async () => {
    const log = await readEvents(root);
    const config = await readConfig(root);
    return { schema_version: 1, exported_at: new Date().toISOString(), ...runtime(),
      recording: { enabled: config?.enabled ?? false, full: config?.full === true || log.bytes >= USAGE_MAX_BYTES, bytes: log.bytes, max_bytes: USAGE_MAX_BYTES },
      invalid_lines: log.invalid_lines, events: log.events,
      limits: "Local CLI and viewer queries only; direct library calls, killed processes and failed log writes may be absent. Timing excludes recorder I/O. Ratings are explicit reports, not independently verified answer quality. No query text, document content, paths, credentials or anonymization key is exported." };
  });
}

async function appendEvent(root: string, event: UsageEvent): Promise<boolean> {
  return withProjectLock(root, async () => {
    // Recheck opt-out after long-running commands and serialize concurrent appends.
    const config = await readConfig(root);
    if (!config?.enabled) return false;
    if (config.full) return false;
    await assertNoSymbolicLinks(root, logFile);
    const size = await stat(join(root, logFile)).then(info => info.size).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return 0;
      throw error;
    });
    // The leading newline isolates an incomplete final line after a process crash.
    const line = "\n" + JSON.stringify(event) + "\n";
    if (size + Buffer.byteLength(line) > USAGE_MAX_BYTES) {
      await atomicWrite(join(root, configFile), JSON.stringify({ ...config, full: true }) + "\n");
      throw new DocNexusError("invalid_params", "usage log reached its 10 MiB limit; export it, then disable recording");
    }
    await appendFile(join(root, logFile), line, { mode: 0o600 });
    return true;
  }, 1000);
}

export async function recordUsageFeedback(root: string, input: { event?: string; rating?: string; reason?: string }) {
  if (!(usageRatings as readonly (string | undefined)[]).includes(input.rating) ||
      (input.reason !== undefined && !(usageReasons as readonly string[]).includes(input.reason))) {
    throw new DocNexusError("invalid_params", `feedback requires --rating ${usageRatings.join("|")} and optional --reason ${usageReasons.join("|")}`);
  }
  return withProjectLock(root, async () => {
    if (!(await readConfig(root))?.enabled) throw new DocNexusError("invalid_params", "enable usage recording before adding feedback");
    const { events } = await readEvents(root);
    const target = events.findLast(event => event.kind === "command" && event.query_id && (input.event === undefined || event.event_id === input.event));
    if (!target) throw new DocNexusError("invalid_params", "no recorded search/recall event matches this feedback");
    const event = { schema_version: 1, kind: "feedback", event_id: randomUUID(), at: new Date().toISOString(),
      target_event_id: target.event_id, rating: input.rating, ...(input.reason ? { reason: input.reason } : {}) };
    if (!await appendEvent(root, event)) throw new DocNexusError("invalid_params", "usage recording is disabled or full; feedback was not saved");
    return event;
  });
}

const actions: Record<string, readonly string[]> = {
  search: [], recall: [], doctor: [], status: [], concepts: [],
  document: ["list", "query", "get", "render", "classify", "sync", "delete", "add"],
  draft: ["new", "seal", "list", "discard"], facts: ["list"], index: ["status", "sync", "rebuild"],
  graph: ["audit", "repair"], embeddings: ["install"], metadata: ["validate"], skills: ["sync", "link"]
};

/** Explicit allow-lists prevent arguments, text and native error messages from entering the log. */
export async function observeUsage<T>(root: string, argv: string[], operation: () => Promise<T>, surface: "cli" | "viewer" = "cli"): Promise<T> {
  const command = argv[0];
  if (!Object.hasOwn(actions, command)) return operation();
  let config: UsageConfig | undefined;
  try { config = await readConfig(root); } catch { warn(); }
  if (!config?.enabled) return operation();
  const digest = (value: string) => createHmac("sha256", config!.key).update(value).digest("hex");
  const query = ["search", "recall"].includes(command) ? argv[1] : undefined;
  const option = (name: string) => { const index = argv.indexOf(`--${name}`, query === undefined ? 1 : 2); return index >= 0 ? argv[index + 1] : undefined; };
  const numeric = (name: string) => { const value = Number(option(name)); return Number.isSafeInteger(value) && value > 0 ? value : undefined; };
  const event: UsageEvent = { schema_version: 1, kind: "command", event_id: randomUUID(), at: new Date().toISOString(),
    ...runtime(), surface, command, ...(actions[command].includes(argv[1]) ? { action: argv[1] } : {}),
    configured_engine: process.env.DOCNEXUS_DATABASE_URL ? "postgres" : "pglite", configured_embedder: process.env.DOCNEXUS_EMBEDDER === "hash" ? "hash" : "local_transformers",
    ...(query !== undefined ? { query_id: digest(query.normalize("NFKC").trim().toLowerCase()), query_chars: Array.from(query).length,
      query_bytes: Buffer.byteLength(query), has_han: /\p{Script=Han}/u.test(query), has_latin: /[A-Za-z]/.test(query) } : {}),
    ...(option("category") !== undefined ? { category_id: digest(option("category")!) } : {}),
    options: { limit: numeric("limit"), context_budget: numeric("context-budget"), page: numeric("page"), page_size: numeric("page-size"),
      ...(command === "recall" ? { mode: option("mode") === "vector" ? "vector" : "hybrid",
        return_unit: ["window", "section", "page"].includes(option("return-unit")!) ? option("return-unit") : undefined } : {}) } };
  const metrics: UsageMetrics = {};
  const start = performance.now();
  try {
    return await usageMetrics.run(metrics, async () => {
      const result = await operation();
      event.status = "ok";
      try {
        event.output_bytes = Buffer.byteLength(typeof result === "string" ? result : JSON.stringify(result));
        summarize(event, typeof result === "string" ? JSON.parse(result) : result, digest);
      } catch {}
      return result;
    });
  } catch (error) {
    event.status = "error";
    event.error_code = asDocNexusError(error).code;
    throw error;
  } finally {
    event.duration_ms = performance.now() - start;
    event.rss_bytes = process.memoryUsage().rss;
    event.metrics = metrics;
    try { await appendEvent(root, event); } catch { warn(); }
  }
}

function summarize(event: UsageEvent, output: any, digest: (value: string) => string): void {
  if (!output || typeof output !== "object") return;
  if (Array.isArray(output.results)) {
    event.result_count = output.results.length;
    event.results = output.results.slice(0, 10).map((result: any) => ({ document_id: digest(result.document_ref?.document_id ?? result.id),
      keyword_rank: result.ranking?.source_ranks?.keyword, vector_rank: result.ranking?.source_ranks?.vector }));
  }
  if (Array.isArray(output.context_groups)) {
    event.graph_paths = output.context_groups.reduce((sum: number, group: any) => sum + group.graph_context.paths.length, 0);
    event.graph_supporting_chunks = output.context_groups.reduce((sum: number, group: any) => sum + group.graph_context.supporting_chunks.length, 0);
  }
  if (Array.isArray(output.evidence)) {
    event.evidence = { blocks: output.evidence.length, facts: output.evidence.filter((block: any) => block.kind === "fact").length,
      primary_documents: new Set(output.evidence.filter((block: any) => block.role === "primary").map((block: any) => block.document_id)).size,
      relationships: output.evidence.filter((block: any) => block.kind === "relationship").length,
      truncated: output.delivery.truncated, omitted_blocks: output.delivery.omitted_blocks,
      budget: output.delivery.budget_tokens, estimated_tokens: output.delivery.estimated_tokens };
  }
  if (typeof output.id === "string" && /^doc_[a-f0-9]{16}$/.test(output.id)) event.document_id = digest(output.id);
  if (["created", "updated"].includes(output.operation)) event.operation = output.operation;
  if (Array.isArray(output.documents)) {
    event.returned_documents = output.documents.length;
    event.document_ids = output.documents.slice(0, 10).map((document: any) => digest(document.id));
  }
  for (const key of ["record_count", "indexed_count", "chunk_count", "processed_documents", "embedded_chunks", "reused_chunks", "removed_documents", "total_documents", "total"] as const) {
    if (typeof output[key] === "number") event[key] = output[key];
  }
  for (const key of ["unindexed", "outdated", "orphaned"] as const) if (Array.isArray(output[key])) event[`${key}_count`] = output[key].length;
  if (typeof output.in_sync === "boolean") event.in_sync = output.in_sync;
  if (Array.isArray(output.issues)) event.issue_codes = output.issues.map((issue: any) => issue.code).filter((code: any) => Object.hasOwn(errorDefinitions, code));
  if (output.index && typeof output.index === "object") summarize(event, output.index, digest);
}

function runtime() { return { package_version: packageVersion(), node_version: process.version, platform: process.platform, arch: process.arch }; }
function warn() { process.stderr.write("docnexus: usage recording unavailable or full; inspect docnexus usage status\n"); }
