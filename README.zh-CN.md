# DocNexus

[English README](./README.md)

DocNexus 是面向 Codex、Claude 等编码智能体的本地项目记忆工具。借鉴 [GBrain](https://github.com/garrytan/gbrain) 的当前知识、时间线与 skills 编排思路：Markdown 保存当前知识与来源时间线，skills 负责提炼和回答，CLI 管理文本及可重建的 PostgreSQL＋pgvector 检索投影，默认使用嵌入式 PGLite，也支持连接独立 Postgres。

智能体按需读取已记录的项目约定；写入始终经用户确认。关键词查找直接读取文本；默认 recall 融合关键词与本地向量排名，并提供一跳图谱上下文。不在 CLI 内调用外部 LLM，默认模型随包发布并离线加载。

> 0.14.0 保持工作区格式 6。已有格式 6 文本只需 `index sync` 补建新投影，无需 reset；更早格式不支持迁移，需要清空时先保存所需文本再明确 reset。

## 快速开始

需要 Node.js 22.13.0 或更高版本及 npm。在目标项目根目录执行：

```bash
npm install --save-dev @rowansenne/docnexus
./node_modules/.bin/docnexus init --agent codex   # 或 claude / all
./node_modules/.bin/docnexus doctor
```

然后正常工作。智能体读取 `docnexus/CONCEPTS.md`，任务涉及项目记忆时自行查找并阅读相关文档。也可以说“记住这段设计说明”“鉴权为什么这样设计”“列出 DocNexus 文档”。

## 工作区与知识更新

```text
docnexus/
  project.json          # 工作区格式标记
  CONCEPTS.md           # 自动生成的文档与概念目录
  skills/               # 入口 skill 与五个工作流 skill
  drafts/<draft_id>/    # source.md、document.md、metadata.json、manifest.json
  library/              # 整理后的当前知识，可人工阅读
  records/<id>/
    source.md           # 最近一次提供的原始材料
    metadata.json       # 标题、摘要、标签、实体和文字关系
    timeline.md         # 按时间追加的已确认更新、摘要及来源
    record.json         # 稳定 ID、时间戳与内容哈希
  schemas/              # metadata 格式说明
  .runtime/             # Git 忽略的未完成文本事务恢复日志
  store/                # Git 忽略的派生数据
    brain.pglite/       # 文档、chunks、pgvector HNSW、实体、关系与同步状态
    models/             # 可选的项目模型覆盖
```

`library/` 保存当前知识；`timeline.md` 保存来源与更新轨迹。更新文档时，智能体先阅读已有知识与时间线，再合并新材料，保留仍有效的约定、替换明确失效的结论，并说明未解决的冲突。CLI 不推断自然语言矛盾；可选 facts 字段显式记录来源、生效、到期、替代和撤回，由代码计算有效状态。解释正文由智能体维护，结构化事实通过 ID 引用自动生成；人工正文或 metadata 变化时追加时间线，纯视图刷新不追加事件。重复提交相同内容不会新增事件。

时间线中的日期是入库时间，不等同于来源所描述事件的发生时间。关键词查找和向量索引都不包含原始材料或历史时间线，历史问题可通过 `document get --include timeline` 查看。

实体用于概念目录并投影为图节点，关系投影为带声明文档和描述的图边；两个数组允许为空，没有实体的文档仍可语义召回。没有实体的文档也会列在 `CONCEPTS.md` 的文档目录中。目录最多展示 300 份文档和 300 个概念；完整信息通过 `document list` 与 `concepts` 查看。

## 查找与回答

```bash
./node_modules/.bin/docnexus search "Refresh token" --limit 5
./node_modules/.bin/docnexus recall "刷新令牌在什么情况下需要轮换" --limit 5
./node_modules/.bin/docnexus document get --id <document_id> --include document,metadata
./node_modules/.bin/docnexus document get --id <document_id> --include document,timeline
```

`search` 对当前正文、路径、标题、摘要、标签、实体名称及别名、有效事实进行字面匹配，支持中英文和代码标识符。`recall` 使用本地 `BAAI/bge-small-zh-v1.5` q8 ONNX 模型生成 512 维向量，以文档级 RRF 融合关键词与向量名次，每份文档返回一个代表片段，并补充相邻片段和一跳图谱证据。`ranking.rrf_score` 排序，`source_ranks` 和 `keyword_match` 解释命中；`matched_chunk.score` 仅为向量相似度，关键词独有候选为 0。`--mode vector` 可单独查看原有向量结果。图谱不参与主排序，所有分数都不是事实置信度。关系引用使用实际声明文档 `source_path`。

智能体找到文件后阅读完整 Markdown，基于文档回答并引用 `docnexus/library/<file_path>`。普通正文可直接读取；含生成事实块时先使用 document get 刷新有效时间变化，再读取并引用。证据不足、记忆冲突或与代码不一致时，应明确说明。

中文关键词查找在通用分词之外补充连续汉字对，多词查询不再仅凭孤立单字命中；单独查询一个汉字仍可使用。排序依次优先完整短语、查询覆盖度和字段权重，摘录选择最强证据；只命中名称、别名或结构化事实时可能没有正文行号。英文、代码标识符和路径继续保留字面匹配。多词查询仍允许部分匹配，语义改写通过 recall 的向量路补充；词法分数不是置信度。

长文和有效事实使用实际本地 tokenizer 切块，每片最多 256 tokens（包含标题上下文和特殊 token），优先按行、句子或词边界拆分，保留少量重叠；超长段落和代码也会拆开。embedding 前再次检查模型上限，超限查询会报错并提示缩短输入。升级后，下一次 `recall` 或 `index sync` 自动重建旧切块策略的派生索引，正文和时间线保持不变。真实离线模型验证及限制见 [长文检索回归](docs/operations/retrieval-evaluation.md#long-document-regression)。

可选实体别名与事实生命周期保存在 metadata 中。事实使用稳定 id、来源和带时区的 `valid_from`；通过 `replaces` 显式替代旧事实，通过 `valid_until` 或 `withdrawn_at` 到期或撤回。仅 active 事实生成额外检索片段，历史记录保留。每个事实只在所属 metadata 中定义一次，正文用独立一行 `{{fact:fact_id}}` 引用，CLI 生成带来源与状态的内容。其他页面可引用同一 id；有效替代、到期或撤回会刷新派生内容，无需手工改写多个页面。自由叙述中的重复值仍需一次性换为引用。示例见 [事实工作流](skills/docnexus-extract/references/facts.md)。`document get --include template,metadata` 返回可编辑结构；`document render` 刷新所有生成块。没有后台刷新定时器；正文读取、搜索和索引同步会刷新时间变化。

```bash
./node_modules/.bin/docnexus facts list --entity "<规范名或别名>" --include-inactive
./node_modules/.bin/docnexus facts list --at "2026-10-14T12:00:00+08:00" --include-inactive
```

## 文档展示接口

在已初始化的项目中运行 `./node_modules/.bin/docnexus view`，打开终端输出的本机 URL，即可按分类、分页阅读文档、分类依据和事实来源。可用 `--port 4317` 指定端口，Ctrl+C 停止。浏览页打开时每 15 秒检查更新，也可手动刷新；数据版本变化后回到第一页。页面只读，直接从同一文本源派生展示，不产生文档副本。详见 [本地浏览页](docs/architecture/document-query.zh-CN.md#本地只读浏览页)。

运行 skills 的大模型结合项目说明、已有分类与相关文档，自主选择 `metadata.category` 并记录 `category_reason`。分类名称由项目需要决定，可复用、新建或调整，不限制为固定七类。旧文档缺少分类时归入未分类，模型阅读后可补齐；标签继续用于跨主题关联。

```bash
./node_modules/.bin/docnexus document query --all
./node_modules/.bin/docnexus document query --page 1 --page-size 20 --category architecture
node docnexus/skills/docnexus-library/scripts/query-documents.mjs --all
```

接口返回完整当前 Markdown、实际使用的分类计数、判断依据和分页信息。后续页携带首次查询的 `--revision <hash>`；写入、重新分类、删除或事实有效状态变化后，旧版本会被拒绝，应重新加载第一页。展示正文在内存中生成，不另存展示文档库，不依赖向量模型或检索数据库。分类维护使用 `document classify --id <id> --category "接口契约" --reason "基于项目 API 规范与相关端点文档" [--revision <hash>]`，只改分类、依据和审计历史，保留事实与正文。分类工作在编排流程运行时完成；查询本身不触发模型重分类。详见 [查询接口](docs/architecture/document-query.zh-CN.md)。

## 捕获与 skills

封存草稿会记录目标文档版本。封存后若正文、来源、分类等发生更新，或路径被占用、删除或重建，旧草稿入库会被拒绝；先读取并合并当前知识，再重新封存和审阅，`--replace` 不绕过检查。旧格式 1 的待入库草稿需重新封存为格式 2，已存文档仍为工作区格式 6。真实文档程序回放与独立模型审阅任务见 [知识维护评估](docs/operations/knowledge-evaluation.zh-CN.md)。

| Skill | 职责 |
| --- | --- |
| `docnexus` | 预检、意图路由、捕获流水线 |
| `docnexus-extract` | 提炼或合并当前知识，写入并封存草稿 |
| `docnexus-ingest` | 保存已确认的封存草稿，追加时间线 |
| `docnexus-recall` | 主动查找、阅读全文、回答和引用 |
| `docnexus-library` | 浏览、查看历史、采纳人工编辑、删除和草稿管理 |
| `docnexus-maintain` | 诊断文本完整性、刷新目录和 skills、重置 |

捕获流程：`draft new` → 智能体写入三份产物 → `draft seal` → 用户审阅 → `document add --draft <id>`。有事实引用时 seal 会生成 `preview.md`；审阅该预览，引用事实变化后需重新封存与审阅。已有路径需要显式授权并使用 `--replace`。封存后的产物发生变化时，必须重新封存并确认授权仍覆盖新内容。

更新草稿须传入提炼所依据的 `document get` 或 `document query` 返回的 `--base-version <record_version>`。封存冲突后须复读合并，再使用该次读取的版本；新路径可用 `--base-version new`。旧 manifest 格式 1/2 的待入库草稿需复读合并后重新封存。

`init --agent` 将 `.agents/skills/` 或 `.claude/skills/` 链接到项目 skills，并在 `AGENTS.md` 或 `CLAUDE.md` 写入带标记的指引区块。Claude 通过 `@docnexus/CONCEPTS.md` 加载目录，Codex 按指引读取。`reset` 清理这些链接和区块。

## Git、手动编辑与完整性

除 `store/` 和 `.runtime/` 外，工作区都是文本，可随 Git 提交。克隆、拉取或切换分支后，关键词查找和全文读取直接使用当前文本；`recall` 自动同步派生索引。`index sync` 根据当前文档恢复 PostgreSQL/pgvector 与概念目录，只处理新增、变化或缺失的投影，复用未变化的 chunks 和向量；普通写入不会重建 HNSW。不导入未托管文件，不修改 source 或时间线。模型探针输出变化时会重新嵌入所有当前文档。

## 数据库引擎

默认零配置使用 PGLite，在首次 `index sync` 或语义召回时创建 `docnexus/store/brain.pglite`。使用已有 Postgres＋pgvector 服务时，在 CLI 环境设置 `DOCNEXUS_DATABASE_URL` 后执行 `docnexus index sync`。连接凭据不写入项目文件。两种引擎共用 schema 和 SQL，每份文档的文档、chunk 与关系投影在同一个数据库事务中提交；文本仍是真源，通过同步与数据库协调。

远程角色需要创建项目 schema 和表的权限；无扩展安装权限时，由管理员预先在 `public` 安装 `vector`。各项目按规范化真实路径隔离 schema，移动或克隆会建立独立投影；这不是跨机器共同写入协议或数据库权限隔离。`reset --force` 先删除当前项目的远程 schema 再删除本地工作区，服务不可用时 reset 会停止。

关键词检索与文档浏览仍直接读文本，不要求数据库或模型。本轮对齐 GBrain 的 PGLite/Postgres 双引擎与 pgvector 增量维护，保留本项目的文本检索、本地 embedding 和一跳图谱召回。PGLite 在进程内运行，大规模数据或服务端并发应使用 Postgres。本机进程锁仍使用系统临时目录中的 SQLite 文件，仅用于协调。

旧 `index.sqlite`、`graph.lbug` 缓存不再读取。确认新索引正常后可删除这些旧缓存；自定义 `store/models/` 资产需保留。

写入文档先保存文本，向量与图谱在下次召回或显式 `index sync` 时建立。可以删除派生数据库后重建；`store/models/` 中的自定义模型需要另行保存，新机器没有覆盖时使用随包模型。操作只影响当前项目，不修改其他工作树。

用户可以编辑 `library/` 的人工正文和事实引用。生成的 `<!-- docnexus:fact ... -->` 块内容只读，应修改所属 metadata 的事实而非派生文字。`status` 的 `records.edited` 列出未采纳的编辑；关键词查找、语义召回和 CLI 文档读取会报告这些差异。审阅后执行 `document sync` 采纳编辑，保留原始 source，并将编辑内容追加到时间线。缺失或损坏的文本可从 Git 或备份恢复，`doctor` 不会自动改写它们。

写入、删除和 reset 需要用户授权。删除同时移除当前文档及其来源、metadata、时间线和派生数据库记录；若会留下悬空事实引用则拒绝。正常完成后不保留恢复副本。托管路径和记录文件拒绝符号链接，并限制在项目工作区内。写入采用逐文件原子替换及持久化失败补偿；本机进程共享项目锁；持久化恢复日志在中断后完成保存/删除或回滚，并覆盖草稿入库收据。下一次 CLI 访问先恢复再读取。Git、外部编辑器和其他机器不参与锁；操作未完成时不要编辑或切换分支。Windows 跳过目录 fsync，目前验证了进程中断，没有模拟硬件断电。

## CLI

所有命令均使用项目内 `./node_modules/.bin/docnexus`。也支持在命令前指定 `--project-root <path>`。

```bash
# 设置与诊断
./node_modules/.bin/docnexus init [--agent claude|codex|all]
./node_modules/.bin/docnexus doctor
./node_modules/.bin/docnexus status
./node_modules/.bin/docnexus skills sync
./node_modules/.bin/docnexus skills link --target claude|codex|all

# 捕获
./node_modules/.bin/docnexus draft new --slug auth
./node_modules/.bin/docnexus metadata validate --file docnexus/drafts/<draft_id>/metadata.json
./node_modules/.bin/docnexus draft seal --id <draft_id> --file auth/rotation.md
./node_modules/.bin/docnexus document add --draft <draft_id> [--replace]
./node_modules/.bin/docnexus draft list [--status open|ready|ingested|invalid]
./node_modules/.bin/docnexus draft discard --id <draft_id> --force

# 查找与阅读
./node_modules/.bin/docnexus search "令牌轮换" --limit 5
./node_modules/.bin/docnexus concepts [--type component] [--query auth] [--format json|md]
./node_modules/.bin/docnexus document list [--limit 50] [--tag auth]
./node_modules/.bin/docnexus document get --id <id> [--include source,document,metadata,timeline,template]
./node_modules/.bin/docnexus document render
./node_modules/.bin/docnexus facts list [--entity name] [--at ISO-timestamp] [--include-inactive]

# 维护
./node_modules/.bin/docnexus document sync --id <id> [--metadata-file <path>]
./node_modules/.bin/docnexus document delete --id <id> --force
./node_modules/.bin/docnexus document delete --file auth/rotation.md --force
./node_modules/.bin/docnexus index status
./node_modules/.bin/docnexus index sync
./node_modules/.bin/docnexus index rebuild --force
./node_modules/.bin/docnexus graph audit
./node_modules/.bin/docnexus graph repair --force
./node_modules/.bin/docnexus embeddings install --from <model_dir> [--replace]
./node_modules/.bin/docnexus reset --force
```

工作区命令会按包版本刷新 skills；`doctor` 只报告版本偏差。`file_path` 相对于 `docnexus/library/`，CLI 输入文件必须在项目内。

智能体可用 `--json` 获取稳定错误码，用 `docnexus protocol` 查看契约；doctor 增加结构化 `issues[]`。`docnexus recall "问题" --return-unit section --context-budget 4000` 返回独立证据包，包含来源版本、事实状态和观察时间，并明确按保守 UTF-8 字节估算约束预算。参见[证据交付](./docs/architecture/evidence-delivery.zh-CN.md)与[真实智能体验收](./docs/operations/agent-evaluation.zh-CN.md)。验收需另行授权的独立新上下文实际运行；仅准备样例不能衡量模型质量。

## 开发

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run eval:retrieval
npm run eval:knowledge
npm run eval:agent -- prepare
node scripts/tarball-smoke.mjs
```

普通测试使用确定性 hash embedding；`real-runtime-e2e.test.ts` 单独启用真实随包 ONNX 模型并禁止网络请求。安装包检查使用锁文件中的依赖版本；离线执行前需有相应 npm 缓存，在线准备可先运行 `npm ci`。

[文档中心](./docs/README.md)提供当前架构、skills 编排、产品说明与发布检查。
