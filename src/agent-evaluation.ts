/** Checks observed tool use and durable outcomes, not the agent's self-reported success. */
export interface AgentEvalTask { id: "recall" | "update" | "unsupported" | "stale"; prompt: string }
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
  after?: { documents: Array<{ id: string; document: string; category: string; facts: Array<{ id: string; status: string }> }> };
}
export interface AgentEvalAnswers { answers: Record<string, { text: string; citations: string[]; status: "supported" | "insufficient_evidence" }> }

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
  check("stale write was refused and the current target was reread", refused >= 0 && reread > refused);
  const merged = events.filter((event, index) => index > reread && event.task === "stale" && event.exit_code === 0 && event.argv[0] === "document" && event.argv[1] === "add");
  check("reviewed merge preserved all newer knowledge", merged.some(event => {
    const document = event.after?.documents.find(document => document.id === run.document_id);
    return Boolean(document?.document.includes(run.guard) && document.document.includes(run.correction) && document.document.includes("故障日志") &&
      document.document.includes("回滚后") && document.category === "发布与运维" && document.facts.some(fact => fact.id === "fact_eval_local_embedding" && fact.status === "active"));
  }));
  const failed = rows.filter(row => !row.passed);
  return { schema_version: 1, run_id: run.run_id, result: failed.length ? "failed" : "needs_review",
    checks: { total: rows.length, passed: rows.length - failed.length, failed: failed.length }, rows,
    model_quality: { verdict: "unreviewed", review_required: ["Check every final claim against its cited document.", "Check the unsupported answer contains no invented provider, price or adoption date.", "Check proposals were not turned into decisions."] },
    limits: "Observed CLI receipts and state assertions establish these narrow outcomes. Self-reported success, a fixture replay and one run do not establish general model quality or native harness activation." };
}
