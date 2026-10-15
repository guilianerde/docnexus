#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { initializeProject } from "../dist/src/project.js";
import { upsertManagedDocument, getManagedRecord } from "../dist/src/managed-documents.js";
import { createDraft, sealDraft } from "../dist/src/drafts.js";
import { queryDocuments } from "../dist/src/document-query.js";
import { evaluateAgentRun } from "../dist/src/agent-evaluation.js";

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
  const saved = await upsertManagedDocument(project, { file_path: "release/policy.md", source: "评估种子来源：发布会议与模型职责决定", document, metadata });
  await upsertManagedDocument(project, { file_path: "research/open-questions.md", source: "评估种子来源：待决提议", document: "# 待决提议\n\n远程 embedding 只是以后可以评估的提议，尚未选定供应商、启用时间或报价。", metadata: { title: "待决提议", summary: "远程 embedding 尚未决策", tags: [], entities: [], relationships: [] } });
  const base = await getManagedRecord(project, saved.id);
  const draft = await createDraft(project, { slug: "rollback" });
  for (const [name, content] of Object.entries({ source: "评估任务：回滚后应再次验证校验标识。", document: document + "\n回滚后应再次验证校验标识。\n", metadata: JSON.stringify(metadata) })) await writeFile(join(project, draft.artifacts[name]), content);
  await sealDraft(project, { draftId: draft.draft_id, filePath: "release/policy.md", baseRecordHash: base.record_version });
  await upsertManagedDocument(project, { file_path: "release/policy.md", source: "评估种子来源：维护者最新复核与分类修正", document: document + `\n维护者复核编号：${correction}。\n`, metadata: { ...metadata, category: "发布与运维", category_reason: "维护者修正：发布流程与故障恢复资料统一归类。" } });
  const tasks = [
    { id: "recall", prompt: "开始 Kestrel 项目的发布工作前，有哪些已确定的校验约定？给出项目知识出处。" },
    { id: "update", prompt: "新增已确认约定：发布失败时保留故障日志。将它合并到已有发布文档，保留其他有效约定和维护者修正；完成草稿审阅并入库。" },
    { id: "unsupported", prompt: "本项目已经选定的远程 embedding 供应商是什么，下个月的报价是多少？只根据项目知识作答。" },
    { id: "stale", prompt: `继续保存现有草稿 ${draft.draft_id} 的回滚补充。若目标已更新，处理冲突、合并最新知识和分类，审阅后再入库。` }
  ];
  const run = { schema_version: 1, run_id: randomUUID(), project_root: project, created_at: new Date().toISOString(), document_id: saved.id,
    guard, correction, stale_draft_id: draft.draft_id, tasks };
  await writeFile(join(runRoot, "run.json"), json(run));
  await writeFile(join(runRoot, "events.jsonl"), "");
  const prompt = `这是一次隔离的真实智能体验收。项目目录：${project}。先按项目 AGENTS.md 和 skills 正常工作，不要读取项目之外的 run.json、期望值或评估实现。\n此一次性项目内的草稿审阅与写入均已授权，不操作原仓库或外部服务。所有记忆 CLI 调用通过以下观测器执行，以记录实际结果：\nnode ${fileURLToPath(import.meta.url)} call --run ${runRoot} --task <task_id> -- <子命令及参数，不含 docnexus 或可执行文件路径>\n例如：node ${fileURLToPath(import.meta.url)} call --run ${runRoot} --task recall -- search "Kestrel 发布" --limit 5\n观测器已经选择 CLI 可执行文件，-- 后直接写 status、search、document get 等子命令。\n按顺序完成以下任务：\n${tasks.map(task => `[${task.id}] ${task.prompt}`).join("\n")}\n最终仅将实际回答写到 ${join(runRoot, "answers.json")}，格式为 {"answers":{"recall":{"text":"...","citations":["实际读过的项目相对路径"],"status":"supported"},...}}。每项任务均需 text、citations、status（supported 或 insufficient_evidence）。不要自行声称评估通过。`;
  await writeFile(join(runRoot, "prompt.txt"), prompt + "\n");
  return { run_root: runRoot, project_root: project, prompt_file: join(runRoot, "prompt.txt"), answers_file: join(runRoot, "answers.json"),
    next: "Give prompt.txt to a separately authorized agent in a fresh context, then run verify. Preparing fixtures does not run a model." };
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
  let after, after_error;
  try { after = await queryDocuments(run.project_root, { all: true }); } catch (error) { after_error = error.message; }
  await appendFile(join(runRoot, "events.jsonl"), JSON.stringify({ run_id: run.run_id, task, argv, exit_code, stdout, stderr, started_at, finished_at: new Date().toISOString(), after, after_error }) + "\n");
  process.stdout.write(stdout); process.stderr.write(stderr); process.exitCode = exit_code;
}

try {
  if (command === "prepare") process.stdout.write(json(await prepare()));
  else {
    const runRoot = value("--run");
    if (!runRoot) throw new Error("--run is required");
    if (command === "call") await observedCall(resolve(runRoot));
    else if (command === "verify") {
      const run = JSON.parse(await readFile(join(runRoot, "run.json"), "utf8"));
      const events = (await readFile(join(runRoot, "events.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
      const answers = JSON.parse(await readFile(join(runRoot, "answers.json"), "utf8"));
      const report = evaluateAgentRun(run, events, answers);
      await writeFile(join(runRoot, "report.json"), json(report));
      process.stdout.write(json(report));
      if (report.checks.failed) process.exitCode = 1;
    } else throw new Error("Usage: eval-agent.mjs prepare | call --run <dir> --task <id> -- <command> | verify --run <dir>");
  }
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
