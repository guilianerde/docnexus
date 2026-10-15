# 真实智能体验收入口

这个入口检查智能体是否实际使用记忆、保留有效知识和处理过期草稿；与 `eval:knowledge` 的预置决策回放分别报告。它不在 CLI 内选择或调用外部 LLM。

以下命令在开发仓库运行，需要已安装开发依赖。

## 准备

```bash
npm run eval:agent -- prepare
```

命令构建代码，在系统临时目录生成独立项目、原生 AGENTS/skills 指引、随机校验标识、维护者修正及一个已过期草稿，返回 `run_root`、`prompt_file` 与 `answers_file`。它不会初始化或修改开发仓库的知识库，也不会自动启动模型。

把生成的 `prompt.txt` 交给已获授权、独立新上下文中的真实宿主智能体。任务内容不包含随机标识的答案；智能体从项目知识读取。先准备记忆再由新上下文召回，能够检查跨上下文使用持久知识，不能仅靠当前对话中的复述通过。

任务覆盖：主动读取发布约定并引用、合并新约定时保留旧事实和维护者修正、面对无供应商/价格证据的问题说明缺口、遇到过期草稿后复读合并再入库。

## 记录实际调用

```bash
node scripts/eval-agent.mjs call --run <run_root> --task recall -- search "Kestrel 发布"
node scripts/eval-agent.mjs call --run <run_root> --task recall -- document get --id <id> --include document,template,metadata,timeline
```

观测器实际执行构建后的 CLI，固定到该 run 的项目目录，删除远程数据库配置并使用默认离线模型；禁止命令覆盖项目根。它记录参数、起止时间、退出码、stdout/stderr 和调用后的文档状态到 `events.jsonl`。失败调用也保留；读取后置状态失败不会抹掉已经发生的调用。

`--` 后直接写 `status`、`search`、`document get` 等子命令及参数，不要再加 `docnexus` 或 `./node_modules/.bin/docnexus`。观测器已经选定可执行文件。

智能体按 `prompt.txt` 写出实际回答 `answers.json`。每题包含 `text`、实际阅读的 `citations[]` 和 `status`（supported 或 insufficient_evidence）。源问题、观察调用和模型回答均保留供审阅。

## 验证和审阅

```bash
node scripts/eval-agent.mjs verify --run <run_root>
```

生成 `report.json`。机械检查涵盖观测到的读取、未在题目中出现的随机值和引用、写入后的事实/维护者修正是否保留、过期写入的真实拒绝与后续复读、未知问题是否只读。缺少记录或失败检查会使进程非零退出；仅有流畅自述不能通过。

所有机械检查通过时结果仍为 `needs_review`、`model_quality.verdict: unreviewed`。审阅者必须逐项检查最终断言与引用、无答案题是否仍编造供应商/价格/采用时间、提议是否被误当决定，并记录实际判断与理由。声明 `insufficient_evidence` 本身不证明模型正确拒答。

一次实际运行只构成验收样例，不是总体准确率。checker 单元测试中的人工事件不能当作模型运行证据；安装 AGENTS/skills 文件也不能证明任何宿主的原生激活。保留 run 目录至审阅完成，再清理这个一次性目录；原仓库不受影响。
