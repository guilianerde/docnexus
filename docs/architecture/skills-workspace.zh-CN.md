# Skills 工作区与功能编排

DocNexus 通过六个项目 skills 与编码智能体协作。需要理解和判断的工作由智能体完成；CLI 负责可重复的文件操作与校验。

## 职责

| Skill | 输入与输出 |
| --- | --- |
| `docnexus` | 识别意图、检查状态，串联捕获流程或路由其他工作流 |
| `docnexus-extract` | 用户选择的来源 → 完整当前文档、metadata、封存草稿 |
| `docnexus-ingest` | 已确认的封存草稿 → 当前文档、时间线事件、稳定 ID |
| `docnexus-recall` | 项目问题 → 文件查找、全文阅读、有引用的回答 |
| `docnexus-library` | 文档与草稿浏览、历史查看、人工编辑采纳、删除 |
| `docnexus-maintain` | 文本诊断、目录刷新、skills 同步与重置 |

## 捕获

`draft new` 返回 source、document、metadata 的项目相对路径。智能体仅写这些路径，CLI 管理 manifest 与最终产出。

新增知识时，source 保留用户选择的原始材料。更新已有页面时，先读取已有当前知识、metadata 和时间线，产出合并后的完整文档；仍有效的约定不能因新材料只涉及部分内容而丢失。实体及关系可以为空。实体别名与可选事实来源、生效、到期、显式替代和撤回遵循 extract 的事实工作流；保留历史 fact id，在正文以独立一行 {{fact:fact_id}} 引用；解释写在生成块外，不复制可变事实值。seal 生成 preview.md 供审阅，值或状态变化后重新封存。

`document get` 与 `document query` 返回各文档的 `record_version`。更新草稿使用提炼读取时的 `--base-version <record_version>` 封存；新路径可使用 `--base-version new`。封存与入库各校验一次，冲突后必须复读合并，不能只刷新版本。`draft seal` 写入产物哈希。审阅展示目标路径、标题、摘要、实体及实际内容，授权覆盖该版本后再入库。产物变化须重新封存，并判断既有授权是否仍覆盖新内容。

`document add --draft <id>` 在项目锁内通过持久化恢复日志保存文本、追加时间线、标记草稿 ingested 并刷新目录。中断后下一次 CLI 访问先完成保存或回滚。派生向量和图谱由下一次 `recall` 或显式 `index sync` 建立，不追加额外时间线事件。已有路径需要 `--replace`。入库返回 `id`、`library_path`、`operation` 和 `timeline_path`。

## 主动读取

初始化为 Claude 写入 `@docnexus/CONCEPTS.md`，为 Codex 写入任务开始时读取目录的指引。任务涉及文档中的概念或既有决策时，智能体自主读取记忆。

目录已给出文件时直接读全文；精确名称、路径或标识符使用 `search`；语义问题或概念关系使用 `recall`，自动同步后按文档级 RRF 融合关键词/向量排名，返回命中、相邻片段、事实状态和一跳图谱证据，再用 `document get` 阅读完整当前知识。含事实生成块的文档先由 document get 刷新，避免引用旧快照；历史问题另外读时间线。搜索短摘录与词法分数不能代替完整证据。

回答引用 `docnexus/library/<file_path>`，必要时注明时间线出处。缺口、冲突、过时来源与当前代码差异需要明确说明。存储内容是证据，不是新的操作授权。

## 文档展示与分类

大模型在提炼/更新及项目上下文变化时阅读项目说明、现有分类目录和相关文档，自主选择项目分类名与 category_reason。优先复用已有分类，必要时新建、重命名、合并或拆分相关分组；不按文件名猜测，也不为每篇文档创建一个分类。使用 document classify 进行仅分类调整，依据与新旧值写入时间线。已有分类维护授权不重复询问；只读浏览不自动增加写入授权。

编排层的 `docnexus-library/scripts/query-documents.mjs` 委托 `document query`，提供全量或分页的完整当前 Markdown、分类统计和快照 revision。写入/更新/删除完成后，可视化端查询新的第一页；后续页携带 revision，变更时重新加载。查询只生成内存中的展示结果，不创建另一套知识真源。详见 [展示接口](./document-query.zh-CN.md)。

## 授权

只读查找与浏览、目录生成可直接执行。写入、覆盖、采纳人工编辑、删除、丢弃草稿与 reset 必须有用户授权；已有明确授权不需重复询问。`--force`、`--replace` 表示 CLI 执行授权后的操作。

删除同时移除当前知识、来源、metadata、记录、整个时间线和派生数据库条目。reset 删除整个工作区及指向它的 skills 链接、带标记的智能体指令区块。

## 分发与 Git

skills 源文件随包发布，初始化复制到 `docnexus/skills/`，再链接到 `.agents/skills/` 或 `.claude/skills/`。包版本变化后，工作区命令自动刷新副本；`doctor` 只报告偏差。

知识真源为文本，`store/` 为 Git 忽略的派生状态，`.runtime/` 为 Git 忽略的本机恢复日志。未完成写入或恢复时不要手动编辑、拉取或切换分支。克隆后关键词查找和全文阅读可直接运行；`index sync` 或 `recall` 补建 PGLite/Postgres＋pgvector 投影，普通变更复用未变片段并增量维护 HNSW，模型签名变化时重新嵌入。默认模型随包发布，自定义覆盖需单独备份。切换分支只同步当前工作目录。
