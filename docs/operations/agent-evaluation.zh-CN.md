# 真实智能体验收入口

这个入口检查智能体是否实际使用记忆、保留有效知识和处理过期草稿；与 `eval:knowledge` 的预置决策回放分别报告。它不在 CLI 内选择或调用外部 LLM。

以下命令在开发仓库运行，需要已安装开发依赖。

## 准备

```bash
npm run eval:agent -- prepare
```

命令构建代码，在系统临时目录生成独立项目、原生 AGENTS/skills 指引、随机校验标识、维护者修正及一个已过期草稿，返回 `run_root`、`prompt_file` 与 `answers_file`。它不会初始化或修改开发仓库的知识库，也不会自动启动模型。

把生成的 `prompt.txt` 交给已获授权、独立新上下文中的真实宿主智能体。任务内容不包含随机标识的答案；智能体从项目知识读取。先准备记忆再由新上下文召回，能够检查跨上下文使用持久知识，不能仅靠当前对话中的复述通过。

执行规则：七项任务在同一新上下文中按顺序各做一次，开始下一项后不回到已完成的任务补做或重做；`answers.json` 写完即结束。审阅者（包括派发任务的父智能体）不得向执行者发送追问、提醒或修正，也不得让其在审阅后补做。审阅发现的问题如实记为该次运行的失败；要再试，用 `prepare` 重新生成一次运行。

任务覆盖：主动读取发布约定并引用、合并新约定时保留旧事实和维护者修正、面对无供应商/价格证据的问题说明缺口、遇到过期草稿后复读合并再入库。新增维护任务包含来源无日期、明确观察时间和只有事件日期的更新，以及刷新令牌有效期改变后对操作指南、设计理由和历史评审的影响检查；后者仅授权保存主页面。

## 记录实际调用

```bash
node scripts/eval-agent.mjs call --run <run_root> --task recall -- search "Kestrel 发布"
node scripts/eval-agent.mjs call --run <run_root> --task recall -- document get --id <id> --include document,template,metadata,timeline
node scripts/eval-agent.mjs call --run <run_root> --task update -- draft preview --id <draft_id>
```

观测器实际执行构建后的 CLI，固定到该 run 的项目目录，删除远程数据库配置并使用默认离线模型；禁止命令覆盖项目根。它记录参数、起止时间、退出码、stdout/stderr 和调用后的文档状态到 `events.jsonl`。失败调用也保留；读取后置状态失败不会抹掉已经发生的调用。

`--` 后直接写 `status`、`search`、`document get` 等子命令及参数，不要再加 `docnexus` 或 `./docnexus/node_modules/.bin/docnexus`。观测器已经选定可执行文件。

智能体按 `prompt.txt` 写出实际回答 `answers.json`。每题包含 `text`、实际阅读的 `citations[]` 和 `status`（supported 或 insufficient_evidence）。写入题另附 `reviewed_previews[]`（draft_id、sealed_version），只声明实际审阅的版本；impact 题另附 skill 定义的 `impact_check`（scope、limitations、pages）。源问题、观察调用和模型回答均保留供审阅。

`draft preview` 成功返回的完整正文及哈希属于“已交付内容”的观测；seal 的输出只能证明“已生成”。检查器关联同一任务、草稿及 `sealed_version`，拒绝正文哈希不符、缺少预览或重新封存之前的旧读取。读取和 `reviewed_previews` 声明分别检查，均不证明理解或用户授权。草稿及知识格式不变，生产入库不强制要求读取回执。

新运行的观测器还保留每次调用后的来源、metadata、模板与时间线，用于检查 `observed_at` 是否对应当前来源，历史事实与原材料是否保留，以及只授权主页面时相关页的解释/来源/历史是否保持。生成事实块可以随规范事实自动更新。旧 run 没有 maintenance 配置时仍沿用原检查；它不构成新场景的验收。

## 验证和审阅

```bash
node scripts/eval-agent.mjs verify --run <run_root>
```

生成 `report.json`。机械检查涵盖观测到的读取、未在题目中出现的随机值和引用、写入后的事实/维护者修正是否保留、过期写入的真实拒绝与后续复读、未知问题是否只读。维护场景另查最终状态：调用记录的任务顺序不能回退（发现补做即失败）；最后一次调用后，发布页仍含每个写入任务的成果（校验约定、维护者修正、故障日志、回滚补充、校验摘要、演练安排）、维护者分类与历史事实，鉴权页旧事实已被替代且替代事实有效；所有页面的时间线中同一来源只出现一次。每题写入时的即时状态检查不能代替这一项，后续写入可能覆盖或重复先前成果。缺少记录或失败检查会使进程非零退出；仅有流畅自述不能通过。

所有机械检查通过时结果仍为 `needs_review`、`model_quality.verdict: unreviewed`。审阅者必须逐项检查最终断言与引用、无答案题是否仍编造供应商/价格/采用时间、提议是否被误当决定，并记录实际判断与理由。声明 `insufficient_evidence` 本身不证明模型正确拒答。

维护场景还需人工核对新 source 中日期的语义，不能仅凭 metadata 值相等判断归因正确。跨页清单必须引用真实全文读取版本，区分需要修改的指南、未决的设计理由和历史事件；程序核对这些观测条件，证据是否足够及候选是否遗漏仍需语义审阅。知识状态或候选版本变化后重新判定，不把独立草稿保存宣称为多页事务。

## 归档

```bash
node scripts/eval-agent.mjs archive --run <run_root> --out docs/operations/baselines/<name>.raw.json.gz
node scripts/eval-agent.mjs check-archive --baseline docs/operations/baselines/<name>.json
```

`archive` 读取 run 目录中原样的 run.json、prompt.txt、events.jsonl、answers.json、report.json，以文件名到原文的 JSON 映射压缩，写入后自检并输出 `artifact_archive` 清单（压缩包和各文件的 SHA-256 与字节数），原样填入基线记录。不要解析后重新序列化，也不要手写哈希。`check-archive` 按基线记录逐项核对；提交基线前必须通过。归档使用审阅时的原始 `report.json`，之后用新检查器复查的结果另行记录，不覆盖原报告。

一次实际运行只构成验收样例，不是总体准确率。checker 单元测试中的人工事件不能当作模型运行证据；安装 AGENTS/skills 文件也不能证明任何宿主的原生激活。保留 run 目录至审阅完成，再清理这个一次性目录；原仓库不受影响。

## 本轮运行记录

2026-10-17 的[维护验收基线](baselines/maintenance-agent-2026-10-17.json)保留七项任务、实际回答、五次写入的来源观察、最终文本记录、29 项机械检查和父智能体逐题语义审阅。独立执行智能体只获得生成的任务提示和项目资料，未提供期望值或检查器。七题在一个新上下文中顺序执行，共 41 次 CLI 调用，不是七个独立试验；一次 `target_changed` 来自过期草稿预览，随后复读合并成功。机械报告保持 `needs_review/unreviewed`，另外记录该运行的语义审阅结论，不把程序通过改写成模型质量结论。

同目录的 `maintenance-agent-2026-10-17.raw.json.gz` 保存原始 run.json、prompt.txt、events.jsonl、answers.json、report.json 的完整 UTF-8 内容；解压后是文件名到内容的 JSON 映射，基线记录各文件和压缩包的 SHA-256。临时项目可清理，原始观测仍可核对。缺失时区、多页并发修订和原生宿主自动激活未在这次模型运行中验证。

## 影响清单持久化与跨会话续办

0.21.0 另做了一次范围限定的[双新上下文验收](baselines/impact-persistence-2026-10-17.json)。第一段只执行上述维护任务中的 impact 场景，使用新版项目 skills 完成主文档入库、草稿附件和 `impact save`。随后在同一临时项目模拟维护者修改客户端指南；第二段新上下文只获得项目路径与续办任务，未提供原会话、记录 ID、旧答案或检查器期望。它通过 `impact list/get` 找回原记录、完整读取当前来源及相关页，使用 `impact set` 在原记录追加核对，其他冲突保留 pending。

这次共观察到 21 次登记阶段调用和 11 次续办调用，10 项结果条件通过并经父智能体语义核对。一次 `--status pending,needs_review` 被拒绝，随后分别查询恢复；错误保留在原始归档中，之后文档补充了单状态参数说明。第一段还自述过周边文件工具错误，不混同为 CLI 接口故障。完整运行资料、前后清单和两个回答保存在同目录 `impact-persistence-2026-10-17.raw.json.gz`，映射与哈希格式同前。

这是两个上下文中的一个合成持久化场景，不是全套七任务重跑、真实用户流量或原生宿主自动激活测试；未调用通用 `verify` 来宣称整套评估通过。主文档已入库后登记失败的附件续办、状态竞争、删除/重建及事实时间变化由定向回归覆盖，语义正确和修改授权仍需审阅。
