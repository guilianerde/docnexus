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

## 目录配置（格式 7）

这是破坏性更新，不兼容旧工作区，不迁移旧数据；npm postinstall 强制删除识别出的旧版目录及其中知识、来源和历史。程序安装清单、依赖、skills、schema、草稿、检索索引和恢复日志统一放在项目根目录的 `.docnexus/`。

`docnexus init --output-dir docs/knowledge --agent codex` 将知识工作区创建在 `docs/knowledge/docnexus/`；`--output-dir` 指定父目录，固定追加 `docnexus/`。省略时父目录为项目根目录，工作区为 `docnexus/`。工作区保存 `library/`、`records/`、`impacts/`、`CONCEPTS.md`、`concepts/` 与可编辑的建议分类清单 `categories.md`。配置存于 `.docnexus/project.json`（`format_version: 7`、`output_dir`（父目录，默认为 `.`）、`initialized_at`）。不支持项目外目录、符号链接及内部或智能体目录；初始化后拒绝直接改换目录，需明确 reset 或换新项目。

`status` 提供实际 `workspace_path`、`library_path` 和 `internal_directory`。以下 `docnexus/` 知识路径均为默认值示例，智能体使用实际返回的路径。Claude 导入和 Codex 指引、导航文件、检索引用、影响记录和事务恢复均读取同一配置。保存知识时更新可读导航；下次 recall 或显式 index sync 才更新 `.docnexus/store/` 下的派生检索数据。

## 捕获

`draft new` 返回 source、document、metadata 的项目相对路径。智能体仅写这些路径，CLI 管理 manifest 与最终产出。

新增知识时，source 保留用户选择的原始材料。更新已有页面时，先读取已有当前知识、metadata 和时间线，产出合并后的完整文档；仍有效的约定不能因新材料只涉及部分内容而丢失。实体及关系可以为空。实体别名与可选事实来源、生效、到期、显式替代和撤回遵循 extract 的事实工作流；保留历史 fact id，在正文以独立一行 {{fact:fact_id}} 引用；解释写在生成块外，不复制可变事实值。`observed_at` 只对应当前来源明确给出的观察时间，新来源未知时移除旧值；事件日期、保存时间不代替观察时间，历史事实日期与出处保持独立。

每篇精炼正文最多 4000 个 Unicode 字符（按码点计算，含标题、代码和当前展开的事实块），不是 token 数。封存、预览、草稿入库和手改采纳检查当前完整展开结果；超限返回 document_too_long 与实际字符数、上限和目标路径。Agent 按理解维度拆为两篇自洽主题草稿，每篇单独判断、封存、审阅、入库；仍超限就递归拆分，不机械截断或丢弃来源。事实定义保留唯一归属和历史，跨页按引用依赖保存，分步结果不构成原子批次。既有长文读取和底层存储 API 保持兼容；时间变化导致事实再次展开时不自动拆分存量文件。详见[语义拆分](../../skills/docnexus-extract/references/document-length.md)。CLI document get 默认只返回当前正文，source、metadata、template、timeline 需显式指定 --include。

`draft preview --id <id>` 校验封存产物、目标版本和当前事实展开结果，返回完整正文、正文哈希与封存 manifest 的规范 JSON 哈希 `sealed_version`；seal 和入库结果返回相同版本以供关联。事实草稿仍生成 `preview.md`，普通草稿直接返回封存正文。预览不改 manifest、不写审阅收据、不增加入库门禁。观测器可证明哪个版本正文被交付，不能证明理解或用户批准；重新封存后需重新读取。

`document get` 与 `document query` 返回各文档的 `record_version`。更新草稿使用提炼读取时的 `--base-version <record_version>` 封存；新路径可使用 `--base-version new`。封存与入库各校验一次，冲突后必须复读合并，不能只刷新版本。`draft seal` 写入产物哈希。审阅展示目标路径、标题、摘要、实体及实际内容，授权覆盖该版本后再入库。产物变化须重新封存，并判断既有授权是否仍覆盖新内容。

`document add --draft <id>` 在项目锁内通过持久化恢复日志保存文本、追加时间线、标记草稿 ingested 并刷新目录。中断后下一次 CLI 访问先完成保存或回滚。派生向量和图谱由下一次 `recall` 或显式 `index sync` 建立，不追加额外时间线事件。已有路径需要 `--replace`。入库返回 `id`、`library_path`、`operation` 和 `timeline_path`。

## 写入前判定

每次沉淀在分配草稿前必须执行 [capture resolution](../../skills/docnexus-extract/references/capture-resolution.md)：读取目录、关键词查找与语义召回、阅读全文及来源/时间线，比较主体、用途、事件/版本、知识增量和出处。目录有上限，查询失败或零条关键词命中不能直接作为“没有旧知识”的结论。显式分类先用于候选检索；除非用户限制范围，还需跨分类检查共享知识，但不自动改写其他分类的页面。

创建/更新还需提供 `impact_check`，记录查找范围、限制及相关页的 ID/路径、实际读取版本、update/no_change/conflict/unverified、证据和建议。未全文读取不能标为不受影响，历史事件报告通常保留原貌，事实引用联动后需核对周围解释。清单属于智能体交接信息，不进入 metadata 或 manifest，不保证全库覆盖；相关页分别封存、审阅和保存，版本变化后复读合并，不承诺多页原子性。

开发版通过 `impact save/list/get/set` 将交接登记到 `docnexus/impacts/<impact_id>.json`（记录 schema 1）。输入包含已保存主文档的 source id/record_version、scope/limitations 和相关页判断。草稿中的 `impact.json` 附件不参与知识封存；主文档入库后再填写实际 source 版本并登记，失败可通过保留的附件续办，两次操作不构成同一事务。清单 ID 按规范输入哈希生成，重复保存保留进度；`impact save` 只返回摘要（ID、路径、revision 及每页的判定、状态和是否需要复查），证据、建议和核对历史通过 `impact get` 读取；每个单文件写入使用项目锁和 fsync 原子替换。

清单保留原始判断，状态核对追加历史及当时 source/target 的 record_version 和生成正文哈希。读取时从当前真源构建快照；身份、版本或有效事实造成的正文变化会派生 `needs_review`。`impact set` 的 revision 同时约束记录和关联正文上下文，拒绝并发旧核对；状态更新不编辑知识，不构成语义正确或授权证明。相关页独立保存后需要重新读取清单，再标记结果。清单随 Git/文本克隆，不进入向量或关键词索引，不放在可丢弃的 `.runtime/`；reset 按工作区清理它们。格式 7 工作区按需创建 impacts。

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

删除同时移除当前知识、来源、metadata、记录、整个时间线和派生数据库条目。reset 删除知识数据及指向它的 skills 链接、带标记的智能体指令区块；保留 `.docnexus/` 内的 package.json、package-lock.json、node_modules 及其 .gitignore，避免删除正在执行的 CLI。保留安装文件时返回 preserved_installation: true；没有安装文件时 `.docnexus/` 整体移除。

## 独立安装目录

在项目根目录执行 `npm install --prefix ./.docnexus --save-exact @rowansenne/docnexus`，通过 `./.docnexus/node_modules/.bin/docnexus` 调用；不要进入 `.docnexus/` 执行 init。安装时通过 postinstall 识别并删除根目录旧版 docnexus/ 及旧格式 .docnexus/ 数据，清理旧 skills 链接与指引；隐藏目录保留当前 npm 安装文件，格式 7 数据保持不变。识别仅限合法的旧格式标记或旧 docnexus/ npm 安装清单，不递归搜索项目，不跟随符号链接。旧 --prefix ./docnexus 位置拒绝安装；全局、npx、传递依赖和源码仓库跳过清理。禁用生命周期脚本会跳过自动清理，init 仍拒绝旧格式。

首次初始化允许内部目录仅包含声明 DocNexus 依赖的 npm 清单、锁文件、依赖和可选 `.gitignore`；父目录下的 `docnexus/` 必须为空或仅包含有效 Git 元数据，父目录中的其他文件保留。

## 分发与 Git

skills 源文件随包分发，初始化复制到 `.docnexus/skills/`，再从 `.agents/skills/` 或 `.claude/skills/` 链接。六个官方副本、版本标记、生成 metadata schema、依赖、草稿、store 和 runtime 由 `.docnexus/.gitignore` 忽略。其他名称的自定义 skills 和 schema 仍可提交；升级替换官方副本，不在其中保存定制。

知识输出目录与 `.docnexus/project.json`、npm manifest/lockfile 一同提交、备份。恢复时保持项目相对结构，从项目根目录运行 `npm ci --prefix ./.docnexus` 和 `init --agent codex|claude|all`；检索索引由 recall 或 index sync 重建。

普通双亲 Git merge 的冲突由人工或获得授权的 Agent 合并 `library/`、metadata、source 和 timeline。可通过 `docnexus git hooks install` 一次启用本地原生钩子，之后继续使用 Git 命令或编辑器暂存内容：`post-index-change` 采集未解决阶段与匹配双方父提交的 resolve-undo 条目，持久保存 `.docnexus/.runtime/git-merge.json`，内容冲突全部暂存后自动 sync。记录本身可以仍有冲突，无需人工计算哈希。自动流程读取暂存快照，确认双方是相同 ID、路径及创建时间的文档，保留双方不可改写的事实历史，校验全库与 4000 字符正文限制，再通过文本事务重建 record、事实视图、合并时间线事件与导航。修复前拒绝覆盖未暂存知识和未跟踪记录/导航；仅修复产物、依赖视图和生成导航进入私有 Git 索引，通过校验后原子替换正式索引，其他暂存内容保留。

索引忙时排队短时工作进程，等待期间不持项目锁；带 ISO 时间戳的输出写入 `.docnexus/.runtime/git-merge.log`，超过 64 KiB 轮转为单份 `.log.1`。`pre-commit` 跳过普通代码提交，普通知识编辑只读取变更单元的 record 并核对受影响单元的哈希，只有 library-only 变更才回退全量 record；事实/实体或文档增删仍进行必要的跨文档依赖校验；已修复 merge 复用绑定双方提交的暂存对象签名，拒绝尚未修复或已变更的版本，不重复读取全库正文；record 仍未解决时 Git 可能先于该钩子拒绝提交，因此需先完成内容暂存并等待就绪。内部 Git 操作屏蔽递归回调，重复通知不追加相同的采纳事件。已有原生钩子备份后先执行，`docnexus git hooks uninstall` 恢复；自定义 hooksPath 管理器需显式接入，克隆后安装，旧版绝对路径脚本需重装更新。新脚本按当前 Git 工作树的相对布局寻找项目、本地 CLI 和 PATH 中的 Node，不把操作重定向到其他工作树；运行时缺失时警告并跳过采集，仅拦截需要知识校验的提交并提示恢复依赖，普通代码提交不受影响；Git 提交和远程操作仍由用户执行。合并冲突恢复统一由钩子读取暂存快照执行，见 [操作说明](../../skills/docnexus-library/references/git-merge.md)。

同路径不同 ID 新建、改名、删除和不兼容的不可变事实历史需按文档单元人工恢复。rebase/am、cherry-pick、revert 立即返回 git_merge_unsupported，不排队也不遗留无 theirs 的清单；普通 merge 的 MERGE_HEAD 发布窗口保留短暂等待，超时会准确报告缺失上下文。干净拉取无需采纳。钩子被绕过且索引历史已清理时，不能承诺事后还原原冲突集合。存在未完成事务时，在重放之前拒绝恢复模式，需先保全现场并检查中断写入。

默认不要求 Git。`init --git-remote <url>` 仅为配置的知识输出目录创建独立仓库、设置 origin 和单分支约束；不提交或访问远程。配置和安装清单位于知识仓库之外，需单独备份恢复。宿主仓库已跟踪输出内容时拒绝配置，命令不更改宿主索引；成功配置后在宿主 `.gitignore` 排除实际输出路径。分支约束在恢复事务前检查，reset 保留知识仓库 `.git` 与历史；克隆后需重新执行带远程参数的 init 安装本机分支约束。

reset 删除配置的知识输出和 `.docnexus/` 内部数据，保留 npm 安装及输出目录的 Git 元数据。源码项目原有 npm 文件和其他项目目录不受影响。没有旧格式自动迁移、存量搬运或兼容路径。
