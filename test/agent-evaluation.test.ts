import { expect, it } from "vitest";
import { evaluateAgentRun, type AgentEvalRun, type AgentEvalEvent, type AgentEvalAnswers } from "../src/agent-evaluation.js";
import { sha256 } from "../src/hash.js";

// Checker unit fixtures. They are not captured model runs or model-quality evidence.
const run: AgentEvalRun = { schema_version: 1, run_id: "unit-fixture", project_root: "/tmp/unit-fixture/project", created_at: "2026-10-15T00:00:00Z",
  document_id: "doc_fixture", guard: "GUARD-test", correction: "REVIEW-test", stale_draft_id: "draft_fixture",
  tasks: ["recall", "update", "unsupported", "stale"].map(id => ({ id: id as AgentEvalRun["tasks"][number]["id"], prompt: "Unit fixture" })) };
const answers: AgentEvalAnswers = { answers: Object.fromEntries(run.tasks.map(task => [task.id, { text: "GUARD-test", citations: ["release/policy.md"], status: task.id === "unsupported" ? "insufficient_evidence" : "supported" }])) };
function receipt(task: AgentEvalEvent["task"], argv: string[], output: object, exit_code = 0): AgentEvalEvent {
  return { run_id: run.run_id, task, argv, stdout: JSON.stringify(output), stderr: "", exit_code,
    started_at: run.created_at, finished_at: run.created_at };
}
function complete() {
  const state = { documents: [{ id: run.document_id, category: "发布与运维", document: "GUARD-test REVIEW-test 故障日志 回滚后", facts: [{ id: "fact_eval_local_embedding", status: "active" }] }] };
  return [
    receipt("recall", ["document", "get", "--id", run.document_id], { id: run.document_id, document: "GUARD-test" }),
    { ...receipt("update", ["document", "add", "--draft", "update"], { id: run.document_id }), after: state },
    receipt("unsupported", ["search", "远程供应商报价"], { results: [] }),
    receipt("stale", ["document", "add", "--draft", run.stale_draft_id], { code: "target_changed" }, 1),
    receipt("stale", ["document", "get", "--id", run.document_id], { id: run.document_id, document: "Latest" }),
    { ...receipt("stale", ["document", "add", "--draft", run.stale_draft_id], { id: run.document_id }), after: state }
  ];
}

it("does not accept a fluent self-report without actual call receipts", () => {
  const report = evaluateAgentRun(run, [], answers);
  expect(report.result).toBe("failed");
  expect(report.rows.find(row => row.name === "recall observed actual memory evidence")?.passed).toBe(false);
});

it("checks observable outcomes while leaving semantic answer quality for explicit review", () => {
  const report = evaluateAgentRun(run, complete(), answers);
  expect(report.checks.failed).toBe(0);
  expect(report.result).toBe("needs_review");
  expect(report.model_quality.verdict).toBe("unreviewed");
});

it("rejects stale merges that skipped the actual reread or discarded newer content", () => {
  const events = complete();
  events.splice(4, 1);
  events.at(-1)!.after!.documents[0].document = "Old knowledge only";
  const report = evaluateAgentRun(run, events, answers);
  expect(report.result).toBe("failed");
  expect(report.rows.find(row => row.name === "reviewed merge preserved all newer knowledge")?.passed).toBe(false);
});

it("rejects receipts from another run and missing final answers", () => {
  const events = complete(); events[0].run_id = "different-run";
  const report = evaluateAgentRun(run, events, { answers: {} });
  expect(report.result).toBe("failed");
  expect(report.rows.find(row => row.name === "receipts belong to this run")?.passed).toBe(false);
  expect(report.rows.find(row => row.name === "all task answers are available for review")?.passed).toBe(false);
});

function maintenanceFixture() {
  const fact = { id: "fact_eval_local_embedding", text: "Offline", provenance: "Original source", valid_from: "2026-01-01T00:00:00Z" };
  const meta = { title: "Policy", summary: "Policy", tags: [], entities: [], relationships: [], facts: [fact] };
  const protectedRecords = ["guide", "rationale", "history"].map(id => ({ id, file_path: `${id}.md`, record_version: sha256(id),
    source: `Source ${id}`, timeline: `History ${id}`, template: `# ${id}`, metadata: meta }));
  const extended: AgentEvalRun = { ...run, tasks: [...run.tasks, ...["dated", "event_date", "impact"].map(id => ({ id: id as AgentEvalRun["tasks"][number]["id"], prompt: "Fixture" }))],
    maintenance: { dated_at: "2026-09-12T09:17:00+08:00", initial_source: "Initial source", preserved_facts: [fact],
      impact: { owner_id: "owner", guide_id: "guide", rationale_id: "rationale", history_id: "history", replacement_id: "fact_new", source: "New source", protected_records: protectedRecords } } };
  const events = complete();
  const result: AgentEvalAnswers = structuredClone(answers);
  for (const task of ["dated", "event_date"] as const) {
    events.push({ ...receipt(task, ["document", "add", "--draft", task], { id: run.document_id }), after: events[1].after });
    result.answers[task] = { text: "Updated", citations: ["release/policy.md"], status: "supported" };
  }
  for (const record of protectedRecords) events.push(receipt("impact", ["document", "get", "--id", record.id], { ...record, document: record.template }));
  events.push({ ...receipt("impact", ["document", "add", "--draft", "impact"], { id: "owner" }), after_records: protectedRecords,
    after: { documents: [{ id: "owner", document: "Updated", category: "auth", facts: [{ id: "fact_eval_token_ttl", status: "superseded" }, { id: "fact_new", status: "active" }] }] } });
  result.answers.impact = { text: "Impact", citations: [], status: "supported", impact_check: { scope: "Auth pages", limitations: "Subject-scoped lookup",
    pages: protectedRecords.map((record, index) => ({ id: record.id, file_path: record.file_path, record_version: record.record_version,
      decision: (["update", "conflict", "no_change"] as const)[index], evidence: "Read the current source", proposed_action: "Keep within scope" })) } };
  const delivered = events.flatMap(event => {
    if (event.argv[0] !== "document" || event.argv[1] !== "add" || event.exit_code !== 0) return [event];
    const draft_id = event.argv[3];
    const sealed_version = sha256(draft_id);
    const saved = JSON.parse(event.stdout);
    event.stdout = JSON.stringify({ ...saved, draft_id, sealed_version });
    if (event.task !== "impact") event.after_records = [{ id: run.document_id, file_path: "release/policy.md", record_version: sha256(event.task), source: "Current source",
      timeline: "Initial source\nCurrent source", template: "# Policy", metadata: { ...meta, ...(event.task === "dated" ? { observed_at: extended.maintenance!.dated_at } : {}) } }];
    result.answers[event.task].reviewed_previews = [{ draft_id, sealed_version }];
    return [receipt(event.task, ["draft", "seal", "--id", draft_id], { draft_id, sealed_version }),
      receipt(event.task, ["draft", "preview", "--id", draft_id], { draft_id, sealed_version, document: "Preview body", document_hash: sha256("Preview body") }), event];
  });
  return { run: extended, events: delivered, answers: result };
}

it("keeps preview delivery, review declarations and semantic review separate", () => {
  const fixture = maintenanceFixture();
  const report = evaluateAgentRun(fixture.run, fixture.events, fixture.answers);
  expect(report.rows.filter(row => !row.passed)).toEqual([]);
  expect(report.model_quality.verdict).toBe("unreviewed");
  delete fixture.answers.answers.update.reviewed_previews;
  expect(evaluateAgentRun(fixture.run, fixture.events, fixture.answers).rows.find(row => row.name === "review declarations identify the ingested sealed versions")?.passed).toBe(false);
});

it.each(["missing", "old_version", "resealed", "wrong_hash"])("rejects %s preview evidence", kind => {
  const fixture = maintenanceFixture();
  const index = fixture.events.findIndex(event => event.task === "update" && event.argv[1] === "preview");
  const preview = fixture.events[index];
  if (kind === "missing") fixture.events.splice(index, 1);
  if (kind === "old_version") preview.stdout = JSON.stringify({ ...JSON.parse(preview.stdout), sealed_version: sha256("old") });
  if (kind === "resealed") fixture.events.splice(index + 1, 0, receipt("update", ["draft", "seal", "--id", "update"], { draft_id: "update", sealed_version: sha256("update") }));
  if (kind === "wrong_hash") preview.stdout = JSON.stringify({ ...JSON.parse(preview.stdout), document_hash: sha256("different content") });
  expect(evaluateAgentRun(fixture.run, fixture.events, fixture.answers).rows.find(row => row.name === "each ingested version had its full sealed preview delivered after its last seal")?.passed).toBe(false);
});

it.each(["inherited_date", "missing_explicit_date", "changed_provenance", "lost_history"])("rejects source attribution failure: %s", kind => {
  const fixture = maintenanceFixture();
  const task = kind === "missing_explicit_date" ? "dated" : "update";
  const record = fixture.events.find(event => event.task === task && event.argv[0] === "document" && event.argv[1] === "add")!.after_records![0];
  if (kind === "inherited_date") record.metadata.observed_at = "2026-01-01T00:00:00Z";
  if (kind === "missing_explicit_date") delete record.metadata.observed_at;
  if (kind === "changed_provenance") record.metadata.facts = [{ ...record.metadata.facts![0], provenance: "Reattributed" }];
  if (kind === "lost_history") record.timeline = record.source;
  const report = evaluateAgentRun(fixture.run, fixture.events, fixture.answers);
  expect(report.rows.some(row => row.name.startsWith(`${task}:`) && !row.passed)).toBe(true);
});

it.each(["missing_read", "wrong_version", "rewritten_history"])("rejects ungrounded impact evidence: %s", kind => {
  const fixture = maintenanceFixture();
  if (kind === "missing_read") fixture.events = fixture.events.filter(event => !(event.task === "impact" && event.argv[1] === "get"));
  if (kind === "wrong_version") fixture.answers.answers.impact.impact_check!.pages[0].record_version = sha256("unread");
  if (kind === "rewritten_history") fixture.events.at(-1)!.after_records = fixture.events.at(-1)!.after_records!.map(record => ({ ...record, timeline: "Overwritten" }));
  const report = evaluateAgentRun(fixture.run, fixture.events, fixture.answers);
  expect(report.rows.some(row => row.name.startsWith("impact ") && !row.passed)).toBe(true);
});
