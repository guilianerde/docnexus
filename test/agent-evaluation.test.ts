import { expect, it } from "vitest";
import { evaluateAgentRun, type AgentEvalRun, type AgentEvalEvent, type AgentEvalAnswers } from "../src/agent-evaluation.js";

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
