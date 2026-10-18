/** Checks observed tool use and durable outcomes, not the agent's self-reported success. */
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { sha256, stableJson } from "./hash.js";
import type { DocNexusMetadata, MetadataFact } from "./types.js";

export interface AgentEvalTask { id: "recall" | "update" | "unsupported" | "stale" | "dated" | "event_date" | "impact"; prompt: string }
export interface AgentEvalRun {
  schema_version: 1;
  run_id: string;
  project_root: string;
  created_at: string;
  document_id: string;
  guard: string;
  correction: string;
  stale_draft_id: string;
  tasks: AgentEvalTask[];
  maintenance?: {
    dated_at: string;
    initial_source: string;
    preserved_facts: MetadataFact[];
    impact: { owner_id: string; guide_id: string; rationale_id: string; history_id: string; replacement_id: string; source: string;
      protected_records: Array<{ id: string; source: string; timeline: string; template: string; metadata: DocNexusMetadata }> };
  };
}
export interface AgentEvalEvent {
  run_id: string;
  task: AgentEvalTask["id"];
  argv: string[];
  exit_code: number;
  stdout: string;
  stderr: string;
  started_at: string;
  finished_at: string;
  after?: { documents: Array<{ id: string; document: string; category: string; observed_at?: string | null; facts: Array<{ id: string; status: string }> }> };
  after_records?: Array<{ id: string; file_path: string; record_version: string; source: string; timeline: string; template: string; metadata: DocNexusMetadata }>;
}
export interface AgentEvalAnswers { answers: Record<string, {
  text: string; citations: string[]; status: "supported" | "insufficient_evidence";
  reviewed_previews?: Array<{ draft_id: string; sealed_version: string }>;
  impact_check?: { scope: string; limitations: string; pages: Array<{
    id: string; file_path: string; record_version: string | null;
    decision: "update" | "no_change" | "conflict" | "unverified"; evidence: string; proposed_action: string;
  }> };
}> }

export function evaluateAgentRun(run: AgentEvalRun, events: AgentEvalEvent[], answer: AgentEvalAnswers) {
  const rows: Array<{ name: string; passed: boolean }> = [];
  const check = (name: string, passed: boolean) => rows.push({ name, passed });
  const parsed = (event: AgentEvalEvent) => { try { return JSON.parse(event.stdout); } catch { return undefined; } };
  const reads = (task: string) => events.filter(event => event.task === task && event.exit_code === 0 &&
    (["search", "recall", "concepts", "facts"].includes(event.argv[0]) || (event.argv[0] === "document" && ["get", "query"].includes(event.argv[1]))));
  check("receipts belong to this run", events.length > 0 && events.every(event => event.run_id === run.run_id && run.tasks.some(task => task.id === event.task)));
  check("all task answers are available for review", run.tasks.every(task => {
    const result = answer.answers?.[task.id];
    return Boolean(result && typeof result.text === "string" && result.text.trim() && Array.isArray(result.citations) &&
      result.citations.every(path => typeof path === "string") && ["supported", "insufficient_evidence"].includes(result.status));
  }));
  const recall = answer.answers?.recall;
  check("recall observed actual memory evidence", reads("recall").some(event => event.stdout.includes(run.guard)));
  check("recall answer contains the unseen stored value and its citation", Boolean(recall?.text.includes(run.guard) && recall.citations?.some(path => ["release/policy.md", "docnexus/library/release/policy.md"].includes(path))));
  const updated = events.filter(event => event.task === "update" && event.argv[0] === "document" && event.argv[1] === "add" && event.exit_code === 0);
  check("update reached durable memory", updated.length > 0);
  check("update preserved current facts, correction and new knowledge", updated.some(event => {
    const document = event.after?.documents.find(document => document.id === run.document_id);
    return Boolean(document?.document.includes(run.guard) && document.document.includes(run.correction) && document.document.includes("故障日志") &&
      document.facts.some(fact => fact.id === "fact_eval_local_embedding" && fact.status === "active"));
  }));
  check("unsupported answer followed actual memory reads", reads("unsupported").length > 0);
  check("unsupported question did not mutate canonical memory", !events.some(event => event.task === "unsupported" && event.exit_code === 0 &&
    (["reset", "init"].includes(event.argv[0]) || (event.argv[0] === "document" && ["add", "classify", "sync", "delete"].includes(event.argv[1])))));
  check("unsupported outcome is explicitly declared for review", answer.answers?.unsupported?.status === "insufficient_evidence");
  const refused = events.findIndex(event => event.task === "stale" && event.exit_code !== 0 && parsed(event)?.code === "target_changed");
  const reread = events.findIndex((event, index) => index > refused && event.task === "stale" && event.exit_code === 0 && event.argv[0] === "document" && event.argv[1] === "get" && parsed(event)?.id === run.document_id);
  check("stale target access was refused and the current target was reread", refused >= 0 && reread > refused);
  const merged = events.filter((event, index) => index > reread && event.task === "stale" && event.exit_code === 0 && event.argv[0] === "document" && event.argv[1] === "add");
  check("reviewed merge preserved all newer knowledge", merged.some(event => {
    const document = event.after?.documents.find(document => document.id === run.document_id);
    return Boolean(document?.document.includes(run.guard) && document.document.includes(run.correction) && document.document.includes("故障日志") &&
      document.document.includes("回滚后") && document.category === "发布与运维" && document.facts.some(fact => fact.id === "fact_eval_local_embedding" && fact.status === "active"));
  }));
  if (run.maintenance) {
    const maintenance = run.maintenance;
    const writes = events.filter(event => event.exit_code === 0 && event.argv[0] === "document" && event.argv[1] === "add");
    check("each ingested version had its full sealed preview delivered after its last seal", writes.length > 0 && writes.every(write => {
      const saved = parsed(write);
      const preceding = events.slice(0, events.indexOf(write));
      const lastSeal = preceding.findLastIndex(event => event.exit_code === 0 && event.argv[0] === "draft" && event.argv[1] === "seal" && parsed(event)?.draft_id === saved?.draft_id);
      return typeof saved?.sealed_version === "string" && preceding.some((event, index) => {
        const preview = parsed(event);
        return index > lastSeal && event.task === write.task && event.exit_code === 0 && event.argv[0] === "draft" && event.argv[1] === "preview" &&
          preview?.draft_id === saved.draft_id && preview.sealed_version === saved.sealed_version &&
          typeof preview.document === "string" && preview.document_hash === sha256(preview.document);
      });
    }));
    check("review declarations identify the ingested sealed versions", writes.every(write => {
      const saved = parsed(write);
      return answer.answers[write.task]?.reviewed_previews?.some(preview => preview.draft_id === saved?.draft_id && preview.sealed_version === saved?.sealed_version) ?? false;
    }));
    for (const [task, expected] of [["update", null], ["stale", null], ["dated", maintenance.dated_at], ["event_date", null]] as const) {
      const saved = writes.findLast(event => event.task === task && parsed(event)?.id === run.document_id);
      const record = saved?.after_records?.find(record => record.id === run.document_id);
      check(`${task}: observation time belongs to the replacement source`, Boolean(record && (record.metadata.observed_at ?? null) === expected));
      check(`${task}: historical fact dates and provenance survive`, Boolean(record && maintenance.preserved_facts.every(fact =>
        stableJson(record.metadata.facts?.find(current => current.id === fact.id)) === stableJson(fact))));
      check(`${task}: initial and current sources remain in history`, Boolean(record && record.timeline.includes(maintenance.initial_source) && record.timeline.includes(record.source)));
    }
    const impact = answer.answers.impact?.impact_check;
    const expected = [[maintenance.impact.guide_id, "update"], [maintenance.impact.rationale_id, "conflict"], [maintenance.impact.history_id, "no_change"]] as const;
    check("impact handoff includes scope, limitations and versioned full reads", Boolean(impact && impact.scope.trim() && typeof impact.limitations === "string" &&
      expected.every(([id, decision]) => impact.pages.some(page => page.id === id && page.decision === decision && page.evidence.trim() && page.proposed_action.trim() &&
        events.some(event => {
          const read = parsed(event);
          return event.task === "impact" && event.exit_code === 0 && event.argv[0] === "document" && event.argv[1] === "get" && read?.id === id &&
            typeof read.document === "string" && read.metadata && read.file_path === page.file_path && read.record_version === page.record_version;
        })))));
    const impactWrites = writes.filter(event => event.task === "impact");
    check("impact scenario only saves the authorized primary page", impactWrites.length > 0 && impactWrites.every(event => parsed(event)?.id === maintenance.impact.owner_id) &&
      !events.some(event => event.task === "impact" && event.exit_code === 0 &&
        (["reset", "init"].includes(event.argv[0]) || (event.argv[0] === "document" && ["sync", "classify", "delete"].includes(event.argv[1])))));
    check("impact primary update preserves the old fact and introduces an active replacement", impactWrites.some(event => {
      const owner = event.after?.documents.find(document => document.id === maintenance.impact.owner_id);
      return owner?.facts.some(fact => fact.id === "fact_eval_token_ttl" && fact.status === "superseded") &&
        owner.facts.some(fact => fact.id === maintenance.impact.replacement_id && fact.status === "active");
    }));
    const finalImpact = events.findLast(event => event.task === "impact" && event.after_records);
    check("impact related explanations, metadata and history are preserved", maintenance.impact.protected_records.every(before => {
      const after = finalImpact?.after_records?.find(record => record.id === before.id);
      return Boolean(after && stableJson([after.source, after.template, after.metadata, after.timeline]) ===
        stableJson([before.source, before.template, before.metadata, before.timeline]));
    }));
    // A finished task stays finished: rework after a later task (for example after review) is a new run, not a correction.
    const order = run.tasks.map(task => task.id);
    check("tasks ran once in order without later rework", events.every((event, index) => index === 0 || order.indexOf(event.task) >= order.indexOf(events[index - 1].task)));
    const final = events.findLast(event => event.after && event.after_records);
    const policy = final?.after?.documents.find(document => document.id === run.document_id);
    const policyRecord = final?.after_records?.find(record => record.id === run.document_id);
    const owner = final?.after?.documents.find(document => document.id === maintenance.impact.owner_id);
    check("final state keeps every write task's knowledge", Boolean(policy && policyRecord && owner &&
      [run.guard, run.correction, "故障日志", "回滚后", "校验摘要", "2026-08-12"].every(text => policy.document.includes(text)) && policy.category === "发布与运维" &&
      maintenance.preserved_facts.every(fact => stableJson(policyRecord.metadata.facts?.find(current => current.id === fact.id)) === stableJson(fact)) &&
      owner.facts.some(fact => fact.id === "fact_eval_token_ttl" && fact.status === "superseded") &&
      owner.facts.some(fact => fact.id === maintenance.impact.replacement_id && fact.status === "active")));
    check("final timelines record each source once", Boolean(final?.after_records?.length && final.after_records.every(record => {
      const sources = timelineSources(record.timeline);
      return new Set(sources).size === sources.length;
    })));
  }
  const failed = rows.filter(row => !row.passed);
  return { schema_version: 1, run_id: run.run_id, result: failed.length ? "failed" : "needs_review",
    checks: { total: rows.length, passed: rows.length - failed.length, failed: failed.length }, rows,
    model_quality: { verdict: "unreviewed", review_required: ["Check every final claim against its cited document.", "Check the unsupported answer contains no invented provider, price or adoption date.", "Check proposals were not turned into decisions.",
      ...(run.maintenance ? ["Check observation timestamps against the actual replacement source, independently of fact effective dates.", "Preview delivery and review declarations do not prove understanding or user approval.", "Check impact evidence, historical-page treatment and unresolved rationale conflicts; candidate coverage is bounded by the reported lookup."] : [])] },
    limits: "Observed CLI receipts and state assertions establish these narrow outcomes. Self-reported success, a fixture replay and one run do not establish general model quality or native harness activation." };
}

/** Source texts of a record timeline, one per entry, split on the entry headings written by managed-documents. */
export function timelineSources(timeline: string): string[] {
  return timeline.split(/\n## \d{4}-\d{2}-\d{2}T[^\n]* — [^\n]*\n/).slice(1).flatMap(entry => {
    const index = entry.indexOf("### Source\n\n");
    return index < 0 ? [] : [entry.slice(index + "### Source\n\n".length).trim()];
  });
}

export const AGENT_EVAL_ARCHIVE_FILES = ["run.json", "prompt.txt", "events.jsonl", "answers.json", "report.json"] as const;
const ARCHIVE_ENCODING = "gzip of JSON mapping original filenames to their exact UTF-8 contents";
export interface AgentEvalArchiveManifest { path: string; sha256: string; encoding: string; files: Array<{ path: string; bytes: number; sha256: string }> }

/** Packs the run files byte for byte so a baseline can be checked against the original observations. */
export function buildAgentEvalArchive(contents: Record<string, string>, path: string): { gzip: Buffer; manifest: AgentEvalArchiveManifest } {
  const missing = AGENT_EVAL_ARCHIVE_FILES.filter(name => typeof contents[name] !== "string");
  if (missing.length) throw new Error(`archive is missing ${missing.join(", ")}`);
  const mapping = Object.fromEntries(AGENT_EVAL_ARCHIVE_FILES.map(name => [name, contents[name]]));
  const gzip = gzipSync(Buffer.from(JSON.stringify(mapping), "utf8"));
  return { gzip, manifest: { path, sha256: createHash("sha256").update(gzip).digest("hex"), encoding: ARCHIVE_ENCODING,
    files: AGENT_EVAL_ARCHIVE_FILES.map(name => ({ path: name, bytes: Buffer.byteLength(contents[name], "utf8"), sha256: sha256(contents[name]) })) } };
}

/** Returns every mismatch between an archive and its recorded manifest; an empty list means it verifies. */
export function checkAgentEvalArchive(gzip: Buffer, manifest: AgentEvalArchiveManifest): string[] {
  const problems: string[] = [];
  const actual = createHash("sha256").update(gzip).digest("hex");
  if (actual !== manifest.sha256) problems.push(`archive sha256 is ${actual}, manifest records ${manifest.sha256}`);
  if (manifest.encoding !== ARCHIVE_ENCODING) problems.push(`unexpected encoding: ${manifest.encoding}`);
  let mapping: Record<string, unknown>;
  try { mapping = JSON.parse(gunzipSync(gzip).toString("utf8")); } catch (error) { return [...problems, `archive is not gzip JSON: ${(error as Error).message}`]; }
  for (const file of manifest.files) {
    const content = mapping[file.path];
    if (typeof content !== "string") { problems.push(`${file.path} is not stored as its original text`); continue; }
    if (Buffer.byteLength(content, "utf8") !== file.bytes) problems.push(`${file.path} has ${Buffer.byteLength(content, "utf8")} bytes, manifest records ${file.bytes}`);
    if (sha256(content) !== file.sha256) problems.push(`${file.path} sha256 differs from the manifest`);
  }
  const listed = new Set(manifest.files.map(file => file.path));
  for (const name of AGENT_EVAL_ARCHIVE_FILES) if (!listed.has(name)) problems.push(`manifest does not list ${name}`);
  return problems;
}
