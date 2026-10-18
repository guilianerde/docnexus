#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { initializeProject } from "../dist/src/project.js";
import { upsertManagedDocument, getManagedRecord } from "../dist/src/managed-documents.js";
import { createDraft, sealDraft } from "../dist/src/drafts.js";
import { queryDocuments } from "../dist/src/document-query.js";
import { AGENT_EVAL_ARCHIVE_FILES, buildAgentEvalArchive, checkAgentEvalArchive, evaluateAgentRun, evaluateRetrievalRun } from "../dist/src/agent-evaluation.js";
import { prepareRetrieval } from "./eval-agent-retrieval.mjs";

const cli = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
const execute = promisify(execFile);
const environment = { ...process.env };
delete environment.DOCNEXUS_DATABASE_URL;
delete environment.DOCNEXUS_EMBEDDER;
const [command, ...args] = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const json = value => JSON.stringify(value, null, 2) + "\n";

async function prepare() {
  const runRoot = await mkdtemp(join(tmpdir(), "docnexus-agent-eval-"));
  const project = join(runRoot, "project");
  await mkdir(project);
  await initializeProject(project, { agents: ["codex"] });
  const guard = `GUARD-${randomBytes(6).toString("hex")}`;
  const correction = `REVIEW-${randomBytes(6).toString("hex")}`;
  const metadata = { title: "发布约定", summary: "Kestrel 项目的发布校验和模型职责", category: "发布流程", tags: ["Kestrel", "发布"], entities: [], relationships: [],
    observed_at: "2026-10-10T08:00:00Z", facts: [
      { id: "fact_eval_release_guard", text: `Kestrel 发布前必须双人复核，并核对校验标识 ${guard}。`, provenance: "评估种子来源：发布会议", valid_from: "2026-10-10T08:00:00Z" },
      { id: "fact_eval_local_embedding", text: "当前 embedding 使用本地离线模型。", provenance: "评估种子来源：模型职责决定", valid_from: "2026-10-10T08:00:00Z" }
    ] };
  const document = "# Kestrel 发布约定\n\n{{fact:fact_eval_release_guard}}\n\n{{fact:fact_eval_local_embedding}}\n";
  const initialSource = "评估种子来源：发布会议与模型职责决定。记录于 2026-10-10T08:00:00Z。";
  const saved = await upsertManagedDocument(project, { file_path: "release/policy.md", source: initialSource, document, metadata });
  await upsertManagedDocument(project, { file_path: "research/open-questions.md", source: "评估种子来源：待决提议", document: "# 待决提议\n\n远程 embedding 只是以后可以评估的提议，尚未选定供应商、启用时间或报价。", metadata: { title: "待决提议", summary: "远程 embedding 尚未决策", tags: [], entities: [], relationships: [] } });
  const base = await getManagedRecord(project, saved.id);
  const draft = await createDraft(project, { slug: "rollback" });
  for (const [name, content] of Object.entries({ source: "评估任务：回滚后应再次验证校验标识。", document: document + "\n回滚后应再次验证校验标识。\n", metadata: JSON.stringify(metadata) })) await writeFile(join(project, draft.artifacts[name]), content);
  await sealDraft(project, { draftId: draft.draft_id, filePath: "release/policy.md", baseRecordHash: base.record_version });
  await upsertManagedDocument(project, { file_path: "release/policy.md", source: "评估种子来源：维护者最新复核与分类修正。记录于 2026-10-10T08:00:00Z。", document: document + `\n维护者复核编号：${correction}。\n`, metadata: { ...metadata, category: "发布与运维", category_reason: "维护者修正：发布流程与故障恢复资料统一归类。" } });
  const tokenFact = { id: "fact_eval_token_ttl", text: "刷新令牌有效期为 7 天。", provenance: "评估种子：鉴权约定", valid_from: "2026-01-01T00:00:00Z" };
  const authMetadata = { title: "鉴权约定", summary: "刷新令牌有效期", tags: ["鉴权", "刷新令牌"],
    entities: [{ name: "刷新令牌", type: "concept", description: "客户端的认证凭据" }], relationships: [], facts: [tokenFact] };
  const owner = await upsertManagedDocument(project, { file_path: "auth/policy.md", source: "评估种子：鉴权约定", document: "# 鉴权约定\n\n{{fact:fact_eval_token_ttl}}\n", metadata: authMetadata });
  const related = [
    ["auth/client-guide.md", "客户端指南", "# 客户端指南\n\n{{fact:fact_eval_token_ttl}}\n\n客户端每 6 天执行一次令牌刷新，以免过期。\n"],
    ["auth/security-rationale.md", "安全设计理由", "# 安全设计理由\n\n选择 7 天有效期是为了支持一周离线使用。离线一周仍能恢复登录是已确认的产品要求；没有授权撤销这一要求。\n"],
    ["reviews/auth-commit-a.md", "鉴权历史评审", "# 鉴权历史评审\n\n这份评审仅描述提交 a1b2c3 当时的实现：刷新令牌有效期 7 天，客户端每 6 天刷新。不是当前操作指南。\n"]
  ];
  const relatedIds = [];
  for (const [file_path, title, document] of related) {
    const row = await upsertManagedDocument(project, { file_path, source: `评估种子：${title}`, document,
      metadata: { ...authMetadata, title, summary: title, facts: [] } });
    relatedIds.push(row.id);
  }
  const datedAt = `2026-09-${String(1 + randomBytes(1)[0] % 28).padStart(2, "0")}T09:17:00+08:00`;
  const replacementId = `fact_eval_ttl_${randomBytes(4).toString("hex")}`;
  const impactSource = `已确认：刷新令牌有效期改为 24 小时，从 2026-10-01T00:00:00Z 生效，明确替代原 7 天有效期。替代事实 ID 使用 ${replacementId}。本次仅授权保存 auth/policy.md；核对相关页面并提交影响清单，其他页面先不写入。`;
  const tasks = [
    { id: "recall", prompt: "开始 Kestrel 项目的发布工作前，有哪些已确定的校验约定？给出项目知识出处。" },
    { id: "update", prompt: "新增已确认约定：发布失败时保留故障日志。将它合并到已有发布文档，保留其他有效约定和维护者修正；完成草稿审阅并入库。" },
    { id: "unsupported", prompt: "本项目已经选定的远程 embedding 供应商是什么，下个月的报价是多少？只根据项目知识作答。" },
    { id: "stale", prompt: `继续保存现有草稿 ${draft.draft_id} 的回滚补充。若目标已更新，处理冲突、合并最新知识和分类，审阅后再入库。` },
    { id: "dated", prompt: `收到发布会议记录，明确记录时间为 ${datedAt}：发布完成后保留校验摘要。将其合并到 release/policy.md，保留已有知识，审阅后入库。` },
    { id: "event_date", prompt: "新增材料：计划在 2026-08-12 演练发布回退；演练后归档检查结果。材料没有提供记录或观察时间。将这项安排合并到 release/policy.md，保留旧知识，审阅后入库。" },
    { id: "impact", prompt: impactSource }
  ];
  const run = { schema_version: 1, run_id: randomUUID(), project_root: project, created_at: new Date().toISOString(), document_id: saved.id,
    guard, correction, stale_draft_id: draft.draft_id, tasks,
    maintenance: { dated_at: datedAt, initial_source: initialSource, preserved_facts: metadata.facts,
      impact: { owner_id: owner.id, guide_id: relatedIds[0], rationale_id: relatedIds[1], history_id: relatedIds[2], replacement_id: replacementId, source: impactSource,
        protected_records: await Promise.all(relatedIds.map(id => getManagedRecord(project, id, ["source", "template", "metadata", "timeline"]))) } } };
  await writeFile(join(runRoot, "run.json"), json(run));
  await writeFile(join(runRoot, "events.jsonl"), "");
  const prompt = `这是一次隔离的真实智能体验收。项目目录：${project}。先按项目 AGENTS.md 和 skills 正常工作，不要读取项目之外的 run.json、期望值或评估实现。\n此一次性项目内的草稿审阅与写入均已授权，不操作原仓库或外部服务。所有记忆 CLI 调用通过以下观测器执行，以记录实际结果：\nnode ${fileURLToPath(import.meta.url)} call --run ${runRoot} --task <task_id> -- <子命令及参数，不含 docnexus 或可执行文件路径>\n例如：node ${fileURLToPath(import.meta.url)} call --run ${runRoot} --task recall -- search "Kestrel 发布" --limit 5\n观测器已经选择 CLI 可执行文件，-- 后直接写 status、search、document get 等子命令。\n按顺序完成以下任务，每项只做一次：开始下一项后不再回到已完成的任务补做或重做；写完 answers.json 即结束，不接受审阅后的补做。\n${tasks.map(task => `[${task.id}] ${task.prompt}`).join("\n")}\n最终仅将实际回答写到 ${join(runRoot, "answers.json")}，格式为 {"answers":{"recall":{"text":"...","citations":["实际读过的项目相对路径"],"status":"supported"},...}}。每项任务均需 text、citations、status（supported 或 insufficient_evidence）。不要自行声称评估通过。`;
  const maintenanceOutput = "\n每个写入任务的回答还需 reviewed_previews: [{draft_id, sealed_version}]，只列出实际读取并审阅的版本。impact 回答另需 impact_check: {scope, limitations, pages: [{id, file_path, record_version, decision, evidence, proposed_action}]}，decision 使用 skill 定义的 update/no_change/conflict/unverified；未完整读取不得声明已核对。按 skill 正常判断，不读取评估期望或自行宣布通过。\n";
  await writeFile(join(runRoot, "prompt.txt"), prompt + maintenanceOutput);
  return { run_root: runRoot, project_root: project, prompt_file: join(runRoot, "prompt.txt"), answers_file: join(runRoot, "answers.json"),
    next: "Give prompt.txt to a separately authorized agent in a fresh context, then run verify. Preparing fixtures does not run a model." };
}

function observerLines(runRoot, task) {
  const self = fileURLToPath(import.meta.url);
  return `如需调用记忆 CLI，必须通过以下观测器执行，以记录实际结果：\nnode ${self} call --run ${runRoot} --task ${task} -- <子命令及参数，不含 docnexus 或可执行文件路径>\n例如：node ${self} call --run ${runRoot} --task ${task} -- status\n观测器已经选择 CLI 可执行文件，-- 后直接写 status、search、document get 等子命令。`;
}

async function prepareRetrievalRun() {
  const runRoot = await mkdtemp(join(tmpdir(), "docnexus-agent-eval-"));
  const project = join(runRoot, "project");
  await mkdir(project);
  await initializeProject(project, { agents: ["codex"] });
  const { targets, trivial } = await prepareRetrieval(project);
  const tasks = [...targets, trivial].map(({ id, prompt }) => ({ id, prompt }));
  const run = { schema_version: 1, scenario: "retrieval", run_id: randomUUID(), project_root: project, created_at: new Date().toISOString(), tasks, targets, trivial };
  await writeFile(join(runRoot, "run.json"), json(run));
  await writeFile(join(runRoot, "events.jsonl"), "");
  await mkdir(join(runRoot, "prompts"));
  await mkdir(join(runRoot, "answers"));
  for (const task of tasks) {
    const answerFile = join(runRoot, "answers", `${task.id}.json`);
    await writeFile(join(runRoot, "prompts", `${task.id}.txt`), `你在项目 ${project} 中工作。先按项目 AGENTS.md 和 skills 正常工作，不要读取项目之外的 run.json、其他任务、期望值或评估实现。此一次性项目内的读写均已授权，不操作其他仓库或外部服务。\n${observerLines(runRoot, task.id)}\n任务：${task.prompt}\n完成后只把实际回答写到 ${answerFile}，格式为 {"text":"...","citations":["实际读过的项目相对路径"],"status":"supported 或 insufficient_evidence"}。任务只做一次，写完回答即结束；不要自行声称评估通过。\n`);
  }
  return { run_root: runRoot, project_root: project, prompt_files: tasks.map(task => join(runRoot, "prompts", `${task.id}.txt`)),
    next: "Give each prompt file to its own separately authorized agent in a fresh context (one context per task), then run verify. Preparing fixtures does not run a model." };
}

async function observedCall(runRoot) {
  const run = JSON.parse(await readFile(join(runRoot, "run.json"), "utf8"));
  if (await realpath(run.project_root) !== join(await realpath(runRoot), "project")) throw new Error("evaluation target must be this run's isolated project directory");
  const task = value("--task");
  const separator = args.indexOf("--");
  const argv = args.slice(separator + 1);
  if (separator < 0 || !run.tasks.some(item => item.id === task) || !argv.length || argv.includes("--project-root")) throw new Error("call requires --task <id> -- <command>; project overrides are forbidden");
  const started_at = new Date().toISOString();
  let stdout = "", stderr = "", exit_code = 0;
  try { ({ stdout, stderr } = await execute(process.execPath, [cli, "--project-root", run.project_root, "--json", ...argv], { cwd: run.project_root, env: environment, maxBuffer: 16 * 1024 * 1024 })); }
  catch (error) { if (typeof error.code !== "number") throw error; ({ stdout, stderr } = error); exit_code = error.code; }
  let after, after_records, after_error;
  try {
    if (run.scenario !== "retrieval") after = await queryDocuments(run.project_root, { all: true });
    if (run.maintenance) after_records = await Promise.all(after.documents.map(document =>
      getManagedRecord(run.project_root, document.id, ["source", "template", "metadata", "timeline"])));
  } catch (error) { after_error = error.message; }
  await appendFile(join(runRoot, "events.jsonl"), JSON.stringify({ run_id: run.run_id, task, argv, exit_code, stdout, stderr, started_at, finished_at: new Date().toISOString(), after, after_records, after_error }) + "\n");
  process.stdout.write(stdout); process.stderr.write(stderr); process.exitCode = exit_code;
}

async function archive(runRoot) {
  const out = value("--out");
  if (!out?.endsWith(".raw.json.gz")) throw new Error("archive requires --out <name>.raw.json.gz");
  const run = JSON.parse(await readFile(join(runRoot, "run.json"), "utf8"));
  const names = run.scenario === "retrieval"
    ? ["run.json", "events.jsonl", "report.json", ...run.tasks.flatMap(task => [`prompts/${task.id}.txt`, `answers/${task.id}.json`])]
    : AGENT_EVAL_ARCHIVE_FILES;
  const contents = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(join(runRoot, name), "utf8")])));
  const { gzip, manifest } = buildAgentEvalArchive(contents, basename(out), names);
  await writeFile(out, gzip);
  const problems = checkAgentEvalArchive(await readFile(out), manifest);
  if (problems.length) throw new Error(`written archive does not verify: ${problems.join("; ")}`);
  return manifest;
}

async function checkArchive() {
  const baseline = value("--baseline");
  if (!baseline) throw new Error("check-archive requires --baseline <baseline.json>");
  const manifest = JSON.parse(await readFile(baseline, "utf8")).artifact_archive;
  const problems = checkAgentEvalArchive(await readFile(join(resolve(baseline, ".."), manifest.path)), manifest);
  return { baseline, archive: manifest.path, verified: problems.length === 0, problems };
}

try {
  if (command === "prepare") process.stdout.write(json(await (value("--scenario") === "retrieval" ? prepareRetrievalRun() : prepare())));
  else if (command === "check-archive") {
    const result = await checkArchive();
    process.stdout.write(json(result));
    if (!result.verified) process.exitCode = 1;
  } else {
    const runRoot = value("--run");
    if (!runRoot) throw new Error("--run is required");
    if (command === "call") await observedCall(resolve(runRoot));
    else if (command === "archive") process.stdout.write(json(await archive(resolve(runRoot))));
    else if (command === "verify") {
      const run = JSON.parse(await readFile(join(runRoot, "run.json"), "utf8"));
      const events = (await readFile(join(runRoot, "events.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
      let report;
      if (run.scenario === "retrieval") {
        const answers = { answers: {} };
        for (const task of run.tasks) {
          try { answers.answers[task.id] = JSON.parse(await readFile(join(runRoot, "answers", `${task.id}.json`), "utf8")); } catch {}
        }
        const trivial = await readFile(join(run.project_root, run.trivial.file), "utf8").catch(() => null);
        report = evaluateRetrievalRun(run, events, answers, trivial);
      } else report = evaluateAgentRun(run, events, JSON.parse(await readFile(join(runRoot, "answers.json"), "utf8")));
      await writeFile(join(runRoot, "report.json"), json(report));
      process.stdout.write(json(report));
      if (report.checks.failed) process.exitCode = 1;
    } else throw new Error("Usage: eval-agent.mjs prepare [--scenario retrieval] | call --run <dir> --task <id> -- <command> | verify --run <dir> | archive --run <dir> --out <name>.raw.json.gz | check-archive --baseline <baseline.json>");
  }
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
