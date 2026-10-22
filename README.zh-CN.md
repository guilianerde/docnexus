# DocNexus

[English README](./README.md)

DocNexus 是面向 Codex、Claude 等编码智能体的本地项目记忆工具。受 [GBrain](https://github.com/garrytan/gbrain) 启发，它用 Markdown 保存当前知识，并维护带来源的时间线。skills 负责提炼、查找和引用知识；轻量 CLI 管理文本及可重建的 PostgreSQL＋pgvector 投影，默认使用嵌入式 PGLite，也支持连接独立 Postgres。

智能体按需读取项目记忆，所有写入都需要用户授权。关键词查找直接读取文本；默认 recall 融合关键词与本地向量排名，并补充一跳图谱证据。CLI 不调用外部 LLM，随包发布的量化 ONNX 模型可离线加载。

> **0.25.0 破坏性更新**：工作区格式 7 将 `.docnexus/` 程序文件与可配置的知识输出目录分开。安装时会清除识别出的旧工作区及其知识、来源和历史，不提供迁移；草稿格式 3、投影 schema 2 不变。

## 安装时清理旧版本

npm `postinstall` 会删除项目根目录中识别出的旧版 `docnexus/`（格式 1–6）以及 `.docnexus/` 下的旧数据，包括知识、来源和 Git 历史。npm 清单、锁文件和 `node_modules/` 会保留；无法识别的目录、外部符号链接目标、全局/npx 安装和源码仓库不受影响。该过程没有确认、迁移或备份。使用 `--ignore-scripts` 可跳过清理，但初始化仍会拒绝旧工作区。

## 快速开始

需要 Node.js 22.13.0 或更高版本及 npm。在目标项目中执行：

```bash
mkdir -p .docnexus
npm install --prefix ./.docnexus --save-exact @rowansenne/docnexus
./.docnexus/node_modules/.bin/docnexus init --output-dir docs/knowledge --agent codex  # 或 claude / all
./.docnexus/node_modules/.bin/docnexus doctor
```

`init --output-dir <父目录>` 会在 `<父目录>/docnexus/` 创建工作区；省略时使用 `docnexus/`。配置保存在 `.docnexus/project.json`，初始化后需显式 reset 才能更换。程序文件、skills、schema、草稿和检索索引都放在 `.docnexus/`。命令从项目根目录执行，其他位置使用 `--project-root <path>`；`status` 返回实际路径。升级使用 `...@latest`，恢复依赖使用 `npm ci --prefix ./.docnexus`。

让智能体记住一条决策、解释项目约定或列出已保存文档即可。`docnexus/CONCEPTS.md` 是一张简短的分类路由表，指向 `docnexus/concepts/` 下按领域划分的概念文件。

## 工作区

```text
.docnexus/
  package.json, package-lock.json  # isolated npm installation
  node_modules/                   # reinstallable runtime, Git-ignored
  project.json                    # format 7 + output_dir
  skills/                         # packaged skills and version, Git-ignored
  schemas/                        # generated metadata schema, Git-ignored
  drafts/<draft_id>/              # source, document, metadata, manifest; Git-ignored
  .runtime/                       # recovery journal and local usage; Git-ignored
  store/                          # rebuildable PGLite/pgvector index, optional models

docs/knowledge/docnexus/          # --output-dir docs/knowledge; 默认 docnexus/
  .gitattributes                  # preserve LF canonical text across Git clones
  CONCEPTS.md                     # generated readable category map (≤ 3 KB)
  concepts/                       # generated readable category navigation
  categories.md                   # editable starter category suggestions
  impacts/                        # related-page impact history
  library/                        # current knowledge Markdown
  records/<id>/                   # source.md, metadata.json, timeline.md, record.json
```

`library/` 保存当前知识；`records/<id>/` 保存每份文档的来源、metadata 和时间线。时间线日期是入库时间，不是事件发生时间；关键词和向量索引都不包含来源与历史正文。生成的导航有大小上限：`CONCEPTS.md` 不超过 3 KB，每个分类文件不超过 32 KB，超限时按实体类型分页。`categories.md` 是可编辑的建议清单，不是分类枚举，CLI 不会读取它。

每次捕获前，智能体先检索并完整阅读候选文档，再判断更新、新建、跳过或冲突，并把理由和读取版本带入审阅。这是 skill 工作流，不是 CLI 强制语义去重。详见[写入前判定](skills/docnexus-extract/references/capture-resolution.md)。

## 查找与回答

```bash
./.docnexus/node_modules/.bin/docnexus search "Refresh token" --limit 5
./.docnexus/node_modules/.bin/docnexus recall "刷新令牌在什么情况下需要轮换" --limit 5
./.docnexus/node_modules/.bin/docnexus document get --id <id> --include document,metadata
./.docnexus/node_modules/.bin/docnexus document get --id <id> --include document,timeline
```

`search` 对当前正文、路径、标题、摘要、标签、实体名称/别名和有效事实做字面匹配。`recall` 使用本地 `BAAI/bge-small-zh-v1.5` 生成 512 维向量并融合文档排名，返回代表片段、相邻片段和一跳图谱证据。`--category` 精确、区分大小写过滤；`uncategorized` 覆盖未分类文档。分数不是事实置信度。

回答前应阅读完整文档，并引用 `docnexus/library/<file_path>`。含生成事实块的文件先使用 `document get` 刷新有效时间变化；证据不足或与代码冲突时应明确说明。

事实只在所属 metadata 中定义一次，带稳定 id、来源和生效时间，正文用独立一行 `{{fact:fact_id}}` 引用。CLI 生成带来源的块，并跟随替代、到期和撤回；`document render` 刷新生成内容，没有后台定时器。

```bash
./.docnexus/node_modules/.bin/docnexus facts list --entity "<规范名或别名>" --include-inactive
./.docnexus/node_modules/.bin/docnexus facts list --at "2026-10-14T12:00:00+08:00" --include-inactive
```

生命周期细节见[事实工作流](skills/docnexus-extract/references/facts.md)。

## 文档浏览与查询

运行 `./.docnexus/node_modules/.bin/docnexus view`，打开输出的本机 URL，即可按分类、分页浏览文档、分类依据和事实来源。可用 `--port 4317` 指定端口，Ctrl+C 停止。浏览页只读，在打开、手动刷新或切换分类时加载，每次请求都校验真源与事实时间。

```bash
./.docnexus/node_modules/.bin/docnexus document query --all
./.docnexus/node_modules/.bin/docnexus document query --page 1 --page-size 20 --category architecture
node .docnexus/skills/docnexus-library/scripts/query-documents.mjs --all
```

`document query` 返回完整当前 Markdown、分类计数、判断依据和分页信息。后续页传 `--revision <hash>`；写入、重新分类、删除或事实状态变化会使旧版本失效。`document classify --id <id> --category <name> --reason <basis>` 只更新分类和审计历史。

分类优先级为：调用方显式指定、已有分类、建议清单、新建分类。`init` 会生成 `docnexus/categories.md`（例如 `pitfalls`、`templates`）；智能体只把它当作参考，不是白名单，修改它不会重分类已有文档。

精炼正文上限为 **4000 个 Unicode 字符**（含标题、代码和展开事实）。封存、预览、入库和手改采纳会以 `document_too_long` 拒绝超限正文，应按语义拆分而不是截断。`document get` 默认只返回当前正文，其他材料通过 `--include` 读取。详见[语义拆分规则](skills/docnexus-extract/references/document-length.md)。

## 捕获与 skills

| Skill | 职责 |
| --- | --- |
| `docnexus` | 预检、路由与捕获编排 |
| `docnexus-extract` | 提炼或合并知识，写入并封存草稿 |
| `docnexus-ingest` | 保存已授权的封存草稿并追加时间线 |
| `docnexus-recall` | 查找、阅读全文、回答与引用 |
| `docnexus-library` | 浏览、查看历史、采纳编辑、删除和草稿管理 |
| `docnexus-maintain` | 诊断文本完整性、刷新目录与 skills、重置 |

捕获流程：`draft new` → 写入三份产物 → `draft seal` → `draft preview --id <id>` → 用户审阅 → `document add --draft <id>`。预览返回封存正文、`document_hash` 和 `sealed_version`；事实、目标或产物变化后需合并、重新封存并重新预览。替换已有路径需要显式授权和 `--replace`。

更新草稿使用提炼读取时的 `--base-version <record_version>`；封存冲突后先复读合并再重新封存。封存会固定目标版本，入库会拒绝更新的正文、来源或分类变化。回归回放见[知识维护评估](docs/operations/knowledge-evaluation.zh-CN.md)。

`observed_at` 只取当前来源明确给出且带时区的观察时间，不继承旧值，也不用事件日期或保存时间代替。跨页影响清单随草稿交接，可持久化到 `docnexus/impacts/`：主文档入库后用 `impact save --file <输入文件>` 登记，通过 `impact list/get/set` 续办。两次操作相互独立，也不授权修改相关页。详见[影响清单](skills/docnexus-library/references/impacts.md)。

调用方可以显式指定分类，跳过模型分类：

```bash
./.docnexus/node_modules/.bin/docnexus draft seal --id <draft_id> --file reviews/report.md --base-version new \
  --category codeReview --category-reason "Produced by the code-review skill"
./.docnexus/node_modules/.bin/docnexus document add --draft <draft_id>
```

`init --agent` 会把 skills 链接到 `.agents/skills/` 或 `.claude/skills/`，并在 `AGENTS.md` 或 `CLAUDE.md` 写入带标记的指引区块；旧区块需重新运行以刷新。

## Git 与手动编辑

默认不创建 Git 仓库。可显式启用独立知识仓库：

```bash
./.docnexus/node_modules/.bin/docnexus init --agent codex --git-remote git@example.com:team/project-memory.git
git -C docnexus status
```

该命令初始化 `docnexus/.git/` 并固定一个分支；分支不符、detached HEAD 或存在额外本地分支时会阻止读取、写入和 reset。它不验证远程连通性，也不提交、拉取或推送。`reset --force` 保留 `.git`、远程配置和历史。

用户可以直接编辑 `library/` 中的人工正文和事实引用；生成的 `<!-- docnexus:fact ... -->` 块只读。`document sync` 会采纳编辑，保留原始 source，并把编辑内容追加到时间线。托管路径拒绝符号链接；写入共享项目锁并支持中断恢复，写入期间不要执行 Git 操作。

要启用兼容原生 Git 和编辑器的自动冲突恢复，先执行一次 `./.docnexus/node_modules/.bin/docnexus git hooks install`。之后**正常解决并暂存内容**，索引钩子记录冲突（含已解决条目），内容准备好后自动修复并暂存生成文件，提交前钩子统一校验暂存知识。等待就绪提示、审阅暂存 diff 后再提交。未暂存的知识编辑会被拒绝覆盖；已有原生钩子会保留并先执行，自定义 `core.hooksPath` 需显式接入。用 `docnexus git hooks status` 查看状态，`docnexus git hooks uninstall` 恢复原钩子；排队工作进程的带时间戳输出在 `.docnexus/.runtime/git-merge.log`，达到 64 KiB 时轮转为 `.log.1`。钩子只在本地生效，克隆后安装；新脚本按项目相对路径和 PATH 中的 Node 定位运行时，旧版绝对路径脚本需重装一次更新。普通代码提交跳过知识校验，普通知识编辑只核对受影响文档，语义变更保留依赖校验。运行时缺失时仅警告并跳过自动采集，只拦截涉及知识或待修复知识合并的提交，提示恢复 Node 和本地依赖；Git 提交和远程操作仍由用户执行。干净拉取无需采纳；rebase、同路径新建、改名和删除冲突需按文档单元人工恢复，详见 [Git 合并流程](skills/docnexus-library/references/git-merge.md)。

提交知识输出目录以及 `.docnexus/project.json` 和 npm 清单。草稿、运行时状态、skills、schema 和检索索引由 Git 忽略。恢复时先运行 `npm ci --prefix ./.docnexus` 和 `init --agent`，再执行 `recall` 或 `index sync`。

## 数据库引擎

PGLite 是零配置默认引擎，首次索引同步或语义召回时创建 `.docnexus/store/brain.pglite`。已有 Postgres＋pgvector 服务时，设置 `DOCNEXUS_DATABASE_URL` 后运行 `index sync`；凭据不写入项目文件。两种引擎共用 schema 和 SQL，文本仍是真源。投影可从文本重建，移动或克隆项目会得到独立 schema；`reset --force` 会先删除远程 schema。

## 本地使用记录

可选功能，默认关闭。记录命令耗时、错误码、匿名查询/文档标识、召回指标和 embedding 调用；不记录原始问题、正文、路径或凭据，也不上传网络。

```bash
./.docnexus/node_modules/.bin/docnexus usage enable
./.docnexus/node_modules/.bin/docnexus usage status
./.docnexus/node_modules/.bin/docnexus usage feedback --rating miss --reason needs_multihop
./.docnexus/node_modules/.bin/docnexus usage export > .docnexus/.runtime/usage-report.json
./.docnexus/node_modules/.bin/docnexus usage disable
```

详见[观测契约](docs/operations/usage-observation.zh-CN.md)。指标不能证明回答正确。

## CLI

所有命令均使用项目内 `./.docnexus/node_modules/.bin/docnexus`，也可在命令前指定 `--project-root <path>`。

```text
init [--output-dir <directory>] [--agent claude|codex|all] [--git-remote <url>]
doctor
status
skills sync
skills link --target claude|codex|all

draft new [--slug auth]
metadata validate --file .docnexus/drafts/<draft_id>/metadata.json
draft seal --id <draft_id> --file auth/rotation.md [--base-version <record_version|new>] [--category <name> [--category-reason <basis>]]
document add --draft <draft_id> [--replace]
draft list [--status open|ready|ingested|invalid]
draft discard --id <draft_id> --force

search "Refresh token" [--limit 5] [--category codeReview]
recall "Refresh token" [--limit 5] [--category codeReview]
concepts [--type component] [--query auth] [--category <name>] [--format json|md]
document list [--limit 50] [--tag auth]
document get --id <id> [--include source,document,metadata,timeline,template]
document render
facts list [--entity name] [--at ISO-timestamp] [--include-inactive]
document sync --id <id> [--metadata-file <path>]
git hooks install|status|uninstall
document delete --id <id> --force
document delete --file auth/rotation.md --force
index status
index sync
index rebuild --force
graph audit
graph repair --force
embeddings install --from <model_dir> [--replace]
reset --force
```

工作区命令会在包版本变化时刷新 skills；`doctor` 只报告偏差。`file_path` 相对 `docnexus/library/`。写入需要用户授权；`--force` 和 `--replace` 记录已获得的授权。`--json` 提供稳定错误码，`docnexus protocol` 查看契约。需要受限证据时使用 `recall "问题" --return-unit section --context-budget 4000`，详见[证据交付](docs/architecture/evidence-delivery.zh-CN.md)。

## 开发

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run eval:retrieval
npm run eval:retrieval:quality
npm run eval:knowledge
npm run eval:agent -- prepare
node scripts/tarball-smoke.mjs
```

普通测试使用确定性 hash embedding；real-runtime E2E 启用随包 ONNX 模型并禁止网络请求。安装包检查使用锁文件中的依赖版本。架构、skills、产品范围与发布检查见[文档中心](./docs/README.md)。