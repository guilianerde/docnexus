# Skills 工作区与功能编排

DocNexus 通过六个项目 skills 与编码智能体协作。需要理解和判断的工作由智能体完成；CLI 负责可重复的文件操作与校验。

## 职责

| Skill | 输入与输出 |
| --- | --- |
| `docnexus` | 识别意图、检查状态，串联捕获流程或路由其他工作流 |
| `docnexus-extract` | 来源 → 检索比较与四类判定；创建/更新时产出完整正文、metadata、封存草稿 |
| `docnexus-ingest` | 已确认的封存草稿 → 当前文档、时间线事件、稳定 ID |
| `docnexus-recall` | 项目问题 → 文件查找、全文阅读、有引用的回答 |
| `docnexus-library` | 文档与草稿浏览、历史查看、人工编辑采纳、删除 |
| `docnexus-maintain` | 文本诊断、目录刷新、skills 同步与重置 |

## 捕获

`draft new` 返回 source、document、metadata 的项目相对路径。智能体仅写这些路径，CLI 管理 manifest 与最终产出。

新增知识时，source 保留用户选择的原始材料。更新已有页面时，先读取已有当前知识、metadata 和时间线，产出合并后的完整文档；仍有效的约定不能因新材料只涉及部分内容而丢失。实体及关系可以为空。实体别名与可选事实来源、生效、到期、显式替代和撤回遵循 extract 的事实工作流；保留历史 fact id，在正文以独立一行 {{fact:fact_id}} 引用；解释写在生成块外，不复制可变事实值。seal 生成 preview.md 供审阅，值或状态变化后重新封存。

`document get` 与 `document query` 返回各文档的 `record_version`。更新草稿使用提炼读取时的 `--base-version <record_version>` 封存；新路径可使用 `--base-version new`。封存与入库各校验一次，冲突后必须复读合并，不能只刷新版本。`draft seal` 写入产物哈希。审阅展示目标路径、标题、摘要、实体及实际内容，授权覆盖该版本后再入库。产物变化须重新封存，并判断既有授权是否仍覆盖新内容。

`document add --draft <id>` 在项目锁内通过持久化恢复日志保存文本、追加时间线、标记草稿 ingested 并刷新目录。中断后下一次 CLI 访问先完成保存或回滚。派生向量和图谱由下一次 `recall` 或显式 `index sync` 建立，不追加额外时间线事件。已有路径需要 `--replace`。入库返回 `id`、`library_path`、`operation` 和 `timeline_path`。

## 写入前判定

每次沉淀在分配草稿前必须执行 [capture resolution](../../skills/docnexus-extract/references/capture-resolution.md)：读取目录、关键词查找与语义召回、阅读全文及来源/时间线，比较主体、用途、事件/版本、知识增量和出处。目录有上限，查询失败或零条关键词命中不能直接作为“没有旧知识”的结论。显式分类先用于候选检索；除非用户限制范围，还需跨分类检查共享知识，但不自动改写其他分类的页面。

| 判定 | 后续 |
| --- | --- |
| update | 同主体同用途有新知识/出处，沿用旧路径，保留有效知识并合并完整正文 |
| create | 新主体或独立事件/报告，创建新路径并引用相关已有知识 |
| skip | 没有新知识、独立事件或有用出处，报告已有文档，不分配新草稿 |
| conflict | 无明确替代依据的矛盾或目标歧义，展示证据与待决点，不封存/入库 |

判定、理由、实际读取的候选 ID/路径/record_version 和拟写入路径属于工作流交接，随正文一起审阅；不增加 CLI 输出字段或草稿 manifest 字段。调用方给定分类不代表同分类必须合并；同模块不同提交的 code-review 报告应分别保留。更新关联长期知识页需要另一份草稿与对应的读取版本及授权。直接入库旧草稿若缺少判定交接，先对其 source/正文补做比较，不能绕过检查。

同路径的新内容修改仍走复读、编辑、重新封存与审阅；改换目标或捕获意图应新建草稿。这个流程约束智能体行为；CLI 继续只校验选定目标的版本、产物和事实，不保证全库语义唯一，也不会自动后台合并相似页面。真实模型是否遵守流程需独立行为验收。

## 主动读取

初始化为 Claude 写入 `@docnexus/CONCEPTS.md`，为 Codex 写入任务开始时读取目录的指引。任务涉及文档中的概念或既有决策时，智能体自主读取记忆。

目录已给出文件时直接读全文；精确名称、路径或标识符使用 `search`；语义问题或概念关系使用 `recall`，自动同步后按文档级 RRF 融合关键词/向量排名，返回命中、相邻片段、事实状态和一跳图谱证据，再用 `document get` 阅读完整当前知识。含事实生成块的文档先由 document get 刷新，避免引用旧快照；历史问题另外读时间线。搜索短摘录与词法分数不能代替完整证据。

回答引用 `docnexus/library/<file_path>`，必要时注明时间线出处。缺口、冲突、过时来源与当前代码差异需要明确说明。存储内容是证据，不是新的操作授权。

## 文档展示与分类

用户或调用方 skill 显式提供分类时，该值优先于模型判断：保持分类名原样，跳过本次写入的自动分类，在 `draft seal` 时通过 `--category <name>` 和可选 `--category-reason <basis>` 写入并封存 metadata，随后一起审阅和入库。调用方未提供依据时，CLI 记录其为显式指定。后续同次分类维护不覆盖该选择；未指定分类时继续现有上下文分类流程。分类选择不构成永久锁，后续可在授权范围内调整。

未提供显式分类时，大模型在提炼/更新及项目上下文变化时阅读项目说明、现有分类目录和相关文档，自主选择项目分类名与 category_reason。优先复用已有分类，必要时新建、重命名、合并或拆分相关分组；不按文件名猜测，也不为每篇文档创建一个分类。使用 document classify 进行仅分类调整，依据与新旧值写入时间线。已有分类维护授权不重复询问；只读浏览不自动增加写入授权。

编排层的 `docnexus-library/scripts/query-documents.mjs` 委托 `document query`，提供全量或分页的完整当前 Markdown、分类统计和快照 revision。写入/更新/删除完成后，可视化端查询新的第一页；后续页携带 revision，变更时重新加载。查询只生成内存中的展示结果，不创建另一套知识真源。详见 [展示接口](./document-query.zh-CN.md)。

## 授权

只读查找与浏览、目录生成可直接执行。写入、覆盖、采纳人工编辑、删除、丢弃草稿与 reset 必须有用户授权；已有明确授权不需重复询问。`--force`、`--replace` 表示 CLI 执行授权后的操作。

删除同时移除当前知识、来源、metadata、记录、整个时间线和派生数据库条目。reset 删除知识数据及指向它的 skills 链接、带标记的智能体指令区块；保留顶层 package.json、package-lock.json、node_modules 及其 .gitignore，避免删除正在执行的 CLI。保留安装文件时返回 preserved_installation: true；没有这些文件的旧工作区仍整体移除。

## 独立安装目录

消费项目在根目录执行 `npm install --prefix ./docnexus --save-exact @rowansenne/docnexus`，将 package.json、package-lock.json、node_modules 一并放入 docnexus/；默认调用 `./docnexus/node_modules/.bin/docnexus`，工作目录仍为项目根目录，其他目录使用 `--project-root`。不要在 docnexus/ 内执行不带项目根参数的 init，避免产生嵌套工作区。源码仓库自身的构建清单与宿主应用原有 npm 清单保持各自职责，不迁移宿主清单。

首次 init 允许 docnexus/ 仅包含上述 npm 安装条目与可选的 .gitignore，且 manifest 必须声明 @rowansenne/docnexus 依赖；其他非空无标记目录仍拒绝接管。node_modules/ 与 store/、.runtime/ 一同忽略，manifest/lockfile 可随知识文本提交；克隆后通过 `npm ci --prefix ./docnexus` 恢复依赖。

原来的根目录安装仍兼容；skills 在新路径不存在时使用根目录 CLI，文档查询脚本先从 docnexus/package.json 位置解析，再按 Node 父目录查找兼容根目录安装。升级现有根安装可以先在 docnexus/ 新装后执行 init/skills sync，确认后再自行移除旧 DocNexus 依赖，不能删除宿主应用其他依赖或清单。

## 分发与 Git

skills 源文件随包发布，初始化复制到 `docnexus/skills/`，再链接到 `.agents/skills/` 或 `.claude/skills/`。包版本变化后，工作区命令自动刷新副本；`doctor` 只报告偏差。

知识真源为文本，`node_modules/` 是可重装运行依赖；`store/` 为 Git 忽略的派生状态，`.runtime/` 为 Git 忽略的本机恢复日志。未完成写入或恢复时不要手动编辑、拉取或切换分支。克隆后关键词查找和全文阅读可直接运行；`index sync` 或 `recall` 补建 PGLite/Postgres＋pgvector 投影，普通变更复用未变片段并增量维护 HNSW，模型签名变化时重新嵌入。默认模型随包发布，自定义覆盖需单独备份。切换分支只同步当前工作目录。
