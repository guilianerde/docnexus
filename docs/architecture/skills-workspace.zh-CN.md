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

新增知识时，source 保留用户选择的原始材料。更新已有页面时，先读取已有当前知识、metadata 和时间线，产出合并后的完整文档；仍有效的约定不能因新材料只涉及部分内容而丢失。实体及关系可以为空。实体别名与可选事实来源、生效、到期、显式替代和撤回遵循 extract 的事实工作流；保留历史 fact id，在正文以独立一行 {{fact:fact_id}} 引用；解释写在生成块外，不复制可变事实值。`observed_at` 只对应当前来源明确给出的观察时间，新来源未知时移除旧值；事件日期、保存时间不代替观察时间，历史事实日期与出处保持独立。

`draft preview --id <id>` 校验封存产物、目标版本和当前事实展开结果，返回完整正文、正文哈希与封存 manifest 的规范 JSON 哈希 `sealed_version`；seal 和入库结果返回相同版本以供关联。事实草稿仍生成 `preview.md`，普通草稿直接返回封存正文。预览不改 manifest、不写审阅收据、不增加入库门禁。观测器可证明哪个版本正文被交付，不能证明理解或用户批准；重新封存后需重新读取。

`document get` 与 `document query` 返回各文档的 `record_version`。更新草稿使用提炼读取时的 `--base-version <record_version>` 封存；新路径可使用 `--base-version new`。封存与入库各校验一次，冲突后必须复读合并，不能只刷新版本。`draft seal` 写入产物哈希。审阅展示目标路径、标题、摘要、实体及实际内容，授权覆盖该版本后再入库。产物变化须重新封存，并判断既有授权是否仍覆盖新内容。

`document add --draft <id>` 在项目锁内通过持久化恢复日志保存文本、追加时间线、标记草稿 ingested 并刷新目录。中断后下一次 CLI 访问先完成保存或回滚。派生向量和图谱由下一次 `recall` 或显式 `index sync` 建立，不追加额外时间线事件。已有路径需要 `--replace`。入库返回 `id`、`library_path`、`operation` 和 `timeline_path`。

## 写入前判定

每次沉淀在分配草稿前必须执行 [capture resolution](../../skills/docnexus-extract/references/capture-resolution.md)：读取目录、关键词查找与语义召回、阅读全文及来源/时间线，比较主体、用途、事件/版本、知识增量和出处。目录有上限，查询失败或零条关键词命中不能直接作为“没有旧知识”的结论。显式分类先用于候选检索；除非用户限制范围，还需跨分类检查共享知识，但不自动改写其他分类的页面。

创建/更新还需提供 `impact_check`，记录查找范围、限制及相关页的 ID/路径、实际读取版本、update/no_change/conflict/unverified、证据和建议。未全文读取不能标为不受影响，历史事件报告通常保留原貌，事实引用联动后需核对周围解释。清单属于智能体交接信息，不进入 metadata 或 manifest，不保证全库覆盖；相关页分别封存、审阅和保存，版本变化后复读合并，不承诺多页原子性。

开发版通过 `impact save/list/get/set` 将交接登记到 `docnexus/impacts/<impact_id>.json`（记录 schema 1）。输入包含已保存主文档的 source id/record_version、scope/limitations 和相关页判断。草稿中的 `impact.json` 附件不参与知识封存；主文档入库后再填写实际 source 版本并登记，失败可通过保留的附件续办，两次操作不构成同一事务。清单 ID 按规范输入哈希生成，重复保存保留进度；每个单文件写入使用项目锁和 fsync 原子替换。

清单保留原始判断，状态核对追加历史及当时 source/target 的 record_version 和生成正文哈希。读取时从当前真源构建快照；身份、版本或有效事实造成的正文变化会派生 `needs_review`。`impact set` 的 revision 同时约束记录和关联正文上下文，拒绝并发旧核对；状态更新不编辑知识，不构成语义正确或授权证明。相关页独立保存后需要重新读取清单，再标记结果。清单随 Git/文本克隆，不进入向量或关键词索引，不放在可丢弃的 `.runtime/`；reset 按工作区清理它们。格式 6 工作区按需创建 impacts，无需 reset。

| 判定 | 后续 |
| --- | --- |
| update | 同主体同用途有新知识/出处，沿用旧路径，保留有效知识并合并完整正文 |
| create | 新主体或独立事件/报告，创建新路径并引用相关已有知识 |
| skip | 没有新知识、独立事件或有用出处，报告已有文档，不分配新草稿 |
| conflict | 无明确替代依据的矛盾或目标歧义，展示证据与待决点，不封存/入库 |

判定、理由、实际读取的候选 ID/路径/record_version 和拟写入路径属于工作流交接，随正文一起审阅；不增加 CLI 输出字段或草稿 manifest 字段。调用方给定分类不代表同分类必须合并；同模块不同提交的 code-review 报告应分别保留。更新关联长期知识页需要另一份草稿与对应的读取版本及授权。直接入库旧草稿若缺少判定交接，先对其 source/正文补做比较，不能绕过检查。

同路径的新内容修改仍走复读、编辑、重新封存与审阅；改换目标或捕获意图应新建草稿。这个流程约束智能体行为；CLI 继续只校验选定目标的版本、产物和事实，不保证全库语义唯一，也不会自动后台合并相似页面。真实模型是否遵守流程需独立行为验收。

## 主动读取

初始化为 Claude 写入 `@docnexus/CONCEPTS.md`，为 Codex 写入需要时读取路由表的指引。`CONCEPTS.md` 只是不超过 3 KB 的分类路由表，每个分类一行，列出文档数、概念数、几个关键概念和对应的 `concepts/<分类>.md`。智能体根据用户问题、当前代码和任务目标判断是否检索：修改既有模块、行为、接口或约定，或依赖既有决策时主动 `recall`；路由表未列出某主题不构成跳过检索的理由。

分类文件是 `recall` 之外的浏览路径：需要完整列出某领域、查找标准名称和别名以改写查询，或检索结果不足时再读，并可用 `--category` 缩小检索范围。每个生成文件硬性不超过 32 KB：超出时分类文件只保留文档和分页链接，概念按实体类型分页，单条概念的文档与关系列表截断并给出 `concepts --query` 指引。保存前先 search/recall，并用 `concepts --query` 精确核对名称；只在需要消歧或结果不足时浏览分类文件。分类应按领域而非文档体裁划分，体裁由实体类型表达。

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

首次 init 允许 docnexus/ 仅包含上述 npm 安装条目与可选的 .gitignore，且 manifest 必须声明 @rowansenne/docnexus 依赖；也允许有效的独立 Git 仓库元数据与这些安装条目组合，其他非空无标记目录仍拒绝接管。node_modules/ 与 store/、.runtime/ 一同忽略，manifest/lockfile 可随知识文本提交；克隆后通过 `npm ci --prefix ./docnexus` 恢复依赖。

原来的根目录安装仍兼容；skills 在新路径不存在时使用根目录 CLI，文档查询脚本先从 docnexus/package.json 位置解析，再按 Node 父目录查找兼容根目录安装。升级现有根安装可以先在 docnexus/ 新装后执行 init/skills sync，确认后再自行移除旧 DocNexus 依赖，不能删除宿主应用其他依赖或清单。

## 分发与 Git

默认不创建 Git 仓库或配置远程。`init --git-remote <url>` 可为新旧工作区配置独立 `origin`，固定新仓库的 `main` 或已有仓库的当前分支；拒绝额外本地分支和 detached HEAD，检查在文本事务恢复之前执行，不自动切换或删除分支。配置和约束保存在 `.git`，reset 保留它们，每位成员克隆后需重新运行带远程参数的初始化。该选项不提交或访问远程，不限制终端 Git 命令或远程分支。

从外层目录工作时显式使用本项目可执行文件与 `--project-root <工作区根目录>`。工作区根目录是 `docnexus/` 的直接父目录，不自动递归发现子项目或生成外层项目路由；外层 agent 指引由用户配置。

skills 源文件随包发布，初始化复制到 `docnexus/skills/`，再链接到 `.agents/skills/` 或 `.claude/skills/`。六个官方副本、`skills/.docnexus-skills.json` 和自动生成的 `schemas/metadata.schema.json` 仅保留本地，初始化、skills 同步及普通工作区命令补齐精确的 Git 忽略规则；其他名称的自定义 skill 和其他 schema 文件仍可提交。不要在官方副本中保存项目定制，升级会覆盖它们。源码仓库和 npm 包仍包含官方 skills；这里只忽略消费项目中的副本。包版本变化或 skills 缺失后，工作区命令自动刷新副本；`doctor` 只报告偏差。

Git 保存完整知识真源（`library/`、`records/`、`impacts/` 等）、工作区配置和安装 manifest/lockfile。克隆后从项目根目录执行 `npm ci --prefix ./docnexus`，再执行 `./docnexus/node_modules/.bin/docnexus init --agent codex`（或 `claude` / `all`），重建 skills、schema 和 agent 链接；独立知识仓库同时传入 `--git-remote <url>` 恢复本地分支约束。安装遵循锁文件，不自动升级到 latest；恢复不改变已保存的知识。

知识真源为文本，`node_modules/` 是可重装运行依赖；`store/` 为 Git 忽略的派生状态，`.runtime/` 为 Git 忽略的本机恢复日志。未完成写入或恢复时不要手动编辑、拉取或切换分支。克隆后关键词查找和全文阅读可直接运行；`index sync` 或 `recall` 补建 PGLite/Postgres＋pgvector 投影，普通变更复用未变片段并增量维护 HNSW，模型签名变化时重新嵌入。默认模型随包发布，自定义覆盖需单独备份。切换分支只同步当前工作目录。

### 已有仓库迁移

新增忽略规则不会取消已跟踪的文件。先确认官方副本内没有需要保留的定制（如有，先转存为不同名称的自定义 skill），再运行 `init` 或 `skills sync` 更新规则。命令不会自动修改 Git 索引。

随宿主项目管理知识时，从项目根目录执行下面的命令，仅取消官方副本的跟踪，保留本地文件：

```bash
git rm -r --cached --ignore-unmatch -- \
  docnexus/skills/docnexus \
  docnexus/skills/docnexus-extract \
  docnexus/skills/docnexus-ingest \
  docnexus/skills/docnexus-recall \
  docnexus/skills/docnexus-library \
  docnexus/skills/docnexus-maintain \
  docnexus/skills/.docnexus-skills.json \
  docnexus/schemas/metadata.schema.json
```

独立知识仓库使用 `git -C docnexus rm`，并去掉上述路径前的 `docnexus/`。核对 `git diff --cached`，将这些删除记录与更新后的 `docnexus/.gitignore` 一起提交（独立仓库中为 `.gitignore`）。后续克隆按上文安装并初始化即可恢复，无需重置知识。拉取这次取消跟踪的提交后，也需重新初始化本地副本。
