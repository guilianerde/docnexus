# DocNexus 当前架构

DocNexus 0.24.2 采用分层项目记忆：Markdown 当前知识与来源时间线是文本真源，PostgreSQL＋pgvector 是可重建的检索投影，skills 负责提炼、更新与综合回答。本地模型负责 embedding，CLI 不调用外部 LLM。对齐 GBrain 的双引擎模式，默认零配置 PGLite，设置 `DOCNEXUS_DATABASE_URL` 后使用独立 Postgres；两者共用 SQL。

```text
智能体与项目 skills
  ├─ 提炼 / 合并 / 审阅 → 文本存储：library + records + timeline
  ├─ 写入 / CLI 读取   → 本机项目锁 → 持久化文本事务与中断恢复
  ├─ 精确查找          → search：关键词、名称、实体别名、有效事实
  └─ 统一召回          → 索引同步 → 关键词 + 本地向量 → 文档级 RRF + 一跳关系
                                       PostgreSQL：文档、chunks、向量、实体与关系
                                       默认本地 PGLite / 可选独立 Postgres
```

## 模块职责

- `drafts.ts` 校验 `draft seal` 的可选调用方分类 `--category` 与依据 `--category-reason`，优先于编排模型分类。最终分类写入草稿 metadata 并封存哈希，审阅后由入库链路原样保存；不创建单独分类真源或永久分类锁。接口见 [显式分类契约](../operations/agent-protocol.zh-CN.md#调用方显式分类)。
- `workspace-reader.ts` 负责路径边界、record/asset 读取和完整性校验。
- `knowledge.ts` 仅处理实体、事实生命周期、替代链与投影规则，不访问文件或项目锁；`knowledge-service.ts` 负责加载工作区并调用这些规则。
- `workspace-snapshot.ts` 在一次操作内复用 records、资产、事实解析及时间。正文和知识投影按需计算并缓存；快照 revision 由完整 records 与有效事实状态生成，分页只渲染实际返回的正文，不维持跨请求缓存。
- `document-service.ts` 协调草稿版本校验、预览约束和入库；`managed-documents.ts` 提交文档与收据的同一文本事务，不反向加载草稿或查询接口。
- `retrieval-index.ts` 协调锁外 embedding 准备和锁内提交；`postgres-store.ts` 分离轻量候选与有界上下文加载，CLI 负责参数与输出。

## 数据边界

知识路径相对于工作区：`init --output-dir <父目录>` 固定创建 `<父目录>/docnexus/`，省略时为项目根目录下的 `docnexus/`；程序文件固定在项目根目录的 `.docnexus/`。格式 7 不兼容或迁移旧工作区，配置位于 `.docnexus/project.json`。

| 路径 | 内容 | 属性 |
| --- | --- | --- |
| `library/<file_path>` | 人工正文、事实 ID 引用及生成的当前事实内容 | 正文与引用为真源；标记内事实为派生 |
| `records/<id>/source.md` | 最近一次提交的原始材料 | 文本真源 |
| `records/<id>/metadata.json` | 标题、摘要、标签、实体别名、关系及可选事实生命周期 | 文本真源 |
| `records/<id>/timeline.md` | 按时间追加的更新摘要与来源 | 文本真源 |
| `records/<id>/record.json` | 稳定身份、时间戳、source/正文模板/metadata/时间线哈希 | 文本真源；正文哈希不包含生成块内容 |
| `CONCEPTS.md` | 简短分类路由表（≤ 3 KB） | 由 metadata 再生成 |
| `concepts/<分类>.md` | 按分类的文档、概念、别名与关系；每个文件不超过 32 KB，过大时按实体类型分页 | 由 metadata 再生成 |
| `.docnexus/drafts/<id>/` | 待审阅产物与封存 manifest | 草稿文本 |
| `.docnexus/skills/`、`.docnexus/schemas/` | 工作流与格式说明 | 官方副本与生成 schema 仅本地，Git 忽略 |
| `.docnexus/store/brain.pglite/` 或远程项目 schema | 文档投影、chunks、embedding、HNSW、实体、关系与同步签名 | 派生，本地 Git 忽略 |
| `.docnexus/store/models/` | 可选本地模型覆盖 | 非派生资产，需要另行备份 |
| `.docnexus/.runtime/transaction.json` | 未完成文本事务的前后镜像、恢复方向及入库收据 | 临时恢复状态，Git 忽略，不能随意删除 |

默认模型 `BAAI/bge-small-zh-v1.5` 的 q8 ONNX 文件随 npm 包发布；覆盖完整时优先使用项目模型。运行时禁用远程模型下载。实体与关系数组可以为空，实体为空的文档仍可进行关键词与语义召回。

## 当前知识与时间线

智能体先读已有全文和时间线，再合并新材料、保留有效约定、替换明确失效的结论。CLI 不推断自然语言矛盾；显式事实的有效状态由代码判定。

新增或内容变化时追加保存时间、操作、标题、摘要和新 source。采纳人工编辑时将编辑后的全文作为该事件的来源，原始 `source.md` 不变。相同提交不改变时间线或 `updated_at`。

时间线记录来源和更新摘要，不是每次编译产出的完整版本库。保存日期不等同于事件发生日期。历史来源和时间线不进入向量索引，完整旧正文可查 Git 历史。

## 写入与索引同步

1. 智能体写草稿，CLI 封存并校验哈希，用户审阅并授权。
2. `document add` 在持久化日志中记录当前知识、来源、metadata、时间线、`record.json` 与草稿 ingested 收据的前后镜像，再逐文件落盘并刷新目录。
3. `index sync` 或下一次 `recall` 校验文本完整性，按需创建 PGLite 或连接 Postgres。
4. 比较当前文档路径、正文、metadata 与知识投影签名，处理新增、变化或缺失的投影，删除已无文本记录的投影。按片段文本哈希、完整文本和模型签名复用已有 chunk ID 与向量，仅计算新片段或变化片段。
5. 本地模型探针的输出签名变化时，重新嵌入全部当前文档。实体规范化或事实生效、到期、撤回、跨文档替代导致知识投影签名变化时，只更新受影响文档。普通同步可刷新正文中的派生事实块，不改写人工正文、metadata、来源或时间线。

每份文档的文档行、chunks、实体提及与关系声明在同一数据库事务提交，失败全部回滚。普通 INSERT/UPDATE/DELETE 由 pgvector 增量维护已有 HNSW，不执行 DROP/CREATE 或 REINDEX。分类或关系单独变化不重新计算未变文本的向量。失败后下次同步会重试，召回不会在同步失败后继续返回旧索引。模型签名只在整轮同步成功后更新。

PGLite 在首次索引操作时创建，纯文本 init、search 和 document query 不要求数据库可用。设置 `DOCNEXUS_DATABASE_URL` 切换引擎后，运行同步从文本重建投影，不复制另一引擎的缓存。远程 schema 名按项目真实路径哈希生成；路径移动或克隆形成独立投影，不提供跨机器共同写入或数据库角色权限隔离。扩展应安装在 `public`，无安装权限时由管理员预装。连接 URL 只从环境读取。旧 `index.sqlite`、`graph.lbug` 不再使用，确认新索引后可删除旧缓存，保留自定义模型。

## 长文切块与模型输入

真实 embedder 从已离线加载的 pipeline 取得 tokenizer，使用不截断的 `encode` 计算长度，包含 CLS/SEP 等特殊 token。模型硬上限取 tokenizer 与模型位置长度限制的较小值；随包 BGE 为 512 tokens。切块预算取模型上限与 256 的较小值，减少短结论混在过长片段中的信号稀释。

切块扫描规范化后的全文，正文窗口最多 1000 个 Unicode 字符，使用实际 token 数验证并缩小窗口。优先在窗口后半段选择换行、句末或空白边界；单个超长段落、代码块和无空格长行均可硬拆，不切断 Unicode surrogate pair。保留少量尾部重叠（最多 32 tokens，并受片段长度限制），并为后续块补上最近的 Markdown 标题层级（最多 64 tokens、128 字符；标题识别忽略围栏代码内部内容）。标题和重叠均计入总预算。特别长的标题会缩短；拆开的代码片段不保证各自构成完整的 Markdown 围栏。全部当前有效事实的额外检索片段也经过同一切块流程。

`RealEmbedder.embed` 在推理前再次计数，超出模型上限就报错，避免 pipeline 自动截掉尾部。普通查询支持模型硬上限，而不是索引片段的较小预算；过长查询需要用户或智能体缩短。开发用 hash/custom embedder 未提供 `tokenBudget()` 时，使用 1000 字符硬限制，不加载模型；自定义模型实现可提供该接口使用自己的实际 tokenizer。

数据库 `index_state.chunking_signature` 记录策略版本与参数，缺失或变化会使现有投影过期。embedding 签名另包含模型 token 上限；同步成功后才提交新签名，失败会保留旧签名以便重试。升级后的首次 `recall` / `index sync` 从格式 7 文本补建新引擎投影，保持来源、事实定义和时间线不变。重切块后仍复用文本和模型签名完全一致的片段；模型变化会重新计算全部向量，但仍不重建 HNSW 对象。

数据库内部投影现在共用事务；文本与数据库仍不是跨存储原子事务，采用文本先落盘、下次召回前协调的方式。数据库不可用时，文本读取、可视化查询和写入仍可运行；删除的派生清理失败会报告待同步，下次同步清除残留后才允许召回。文本的持久化恢复日志独立于 `store/`，删除或重建检索数据库不会丢失恢复意图。

核心文本读取/写入、事务恢复与数据库租约共用可重入项目锁。本机进程以项目真实路径为键，在系统临时目录的专用 SQLite 文件上持有写锁；进程退出（包括强制终止）由操作系统释放锁。等待超过 30 秒返回 busy，调用者可重试。锁文件在工作区外，reset 不会让另一个进程绕过仍持有的锁。

索引同步分为快照、准备和提交阶段。tokenizer 加载、模型探针、查询与片段 embedding 在锁外运行；准备阶段读取旧向量后关闭数据库，提交阶段重新获取锁和数据库租约。提交前复核完整文本快照（包括事实生效/到期状态）和 `index_generation`；若期间发生文本或索引更新，丢弃旧计划并重试，连续三次冲突时报错。索引代次在首份文档提交前更新，使其他准备中的计划也能发现部分提交或失败；模型和切块签名仍只在整轮成功后更新。最终检索在提交阶段同一锁和数据库租约内完成，不能在同步与查询之间混入另一版本。PGLite 的创建、访问和关闭都在项目锁内，模型运行期间不持有实例。

文本写入先持久化 `apply` 意图，再逐文件原子替换；文件和目录在支持的平台上执行 fsync。普通异常先持久化 `rollback` 方向，再恢复前镜像。中断后的下一次 CLI 或核心文本访问先重放日志，完成保存/删除或回滚，刷新目录后才返回知识。文档与草稿入库收据在同一个恢复单元内；这是可恢复事务，不是所有文件同时可见的文件系统快照。

外部编辑器、Git 和其他机器不参与本机锁。写入或恢复未完成时不要手动编辑、拉取或切换分支。Windows 跳过目录 fsync；当前验证覆盖本机进程中断，没有模拟硬件断电。

## 图谱

图结构通过关系表表达：`chunks.document_id` 关联文档，`chunk_index` 表达片段顺序，`document_concepts` 表达实体提及，`edges` 保存概念之间的 `DEPENDS_ON`、`RELATES_TO`、`IMPLEMENTS`、`REPLACES`、`DECIDES`。不再维护单独的图数据库或重复向量副本。

每条概念关系携带声明它的 `document_id` 和 `description`。替换或删除文档只移除该文档声明的关系，其他文档的同类关系仍保留。召回中的关系路径返回 `source_document_id`、`source_path` 与描述，便于引用真实依据。

`REPLACES` 仍是概念关系；事实失效使用独立的 `facts[].replaces` 协议。图谱上下文限定一跳，不提供任意深度多跳推理。

## 查找与回答

`search` 对当前正文、路径、标题、摘要、标签、规范实体名称与别名、有效结构化事实进行 NFKC 归一化、大小写折叠后的字面匹配，不依赖模型。通用分词之外补充同一连续汉字串的相邻字对，例如“长文”即使被 ICU 分为“长”和“文”，仍用“长文”匹配。多词查询移除孤立汉字，显式单字查询保留；不跨标点、空白或 metadata 字段拼接汉字对，英文标识符与路径沿用原有分词。

多词查询仅过滤按空白分隔、可带首尾引号或句末标点的独立英文虚词，不拆除路径、文件名或代码标识符内部成分；保留原始查询用于完整短语与名称等值匹配。单词查询、过滤后没有有效词的全虚词查询仍按原词查找，not、no、never、without 等否定词不在停用词表中。

词法排序首先考虑标题、相对路径、文件名是否与归一化后的完整查询相等（路径与文件名均可省略 .md），其次考虑完整查询短语是否在某个名称、摘要、正文或有效事实中出现，覆盖多少查询项，再用名称 5、摘要 2、正文/事实 1 的字段权重打破同级排序。字段得分作为小于 1 的分数部分，不能压过查询覆盖度或完整短语。`score` 用于同一次查询排序，不是置信度，也不保证与旧版本或其他查询可比。多词部分匹配仍允许；同义改写、否定和无答案判断属于语义召回及智能体阅读。

名称等值命中时摘录优先引用对应标题或完整相对路径，携带 metadata anchor，不附正文行号。其他命中在正文行、有效事实和名称/摘要中选择完整短语或覆盖更多项的证据，同级优先给出可定位的正文行；只命中别名、metadata 或未引用到正文的事实时不伪造正文行号。长行围绕完整短语截取，避免早期弱匹配遮住真正命中。结果契约保持 `matched_terms`、`snippet`、可选 `line` 和 `score`；`matched_terms` 可能包含汉字对。排名变化直接作用于下一次 search 和 hybrid recall 的关键词路，不需要重新 embedding 或重建索引。

`recall` 默认统一检索：自动同步后，文本关键词和 pgvector 余弦向量检索分别取候选，以文档去重的名次执行等权 RRF：每路贡献 `1 / (60 + rank)`。每路文档候选窗口为 `min(100, max(20, limit * 5))`。向量路先取该窗口五倍的轻量 chunk 候选，每文档保留最佳片段；若长文挤满窗口导致文档不足，补查其余文档各自的最佳片段，避免重复 chunks 排挤其他文档。返回最多 `limit` 个唯一文档，每个选择一个代表 chunk。小表、指定候选及补查时，Postgres 优化器可能选择精确扫描，HNSW 存在不意味着每次查询都采用近似扫描。

候选阶段只读取 chunk ID、所属文档和相似度，不加载图谱或相邻正文。融合选定最终文档后，再批量补充正文、相邻片段和一跳图谱上下文。图谱 SQL 对每个主文档最多返回 5 条关系路径、3 个支持片段；相邻片段批量查询，避免逐候选往返。关键词独有候选在这些文档内选择代表片段，不读取向量。

`results[].ranking.rrf_score` 是融合分数，`source_ranks` 保留关键词和向量两路名次，`keyword_match` 保留字面证据。`matched_chunk.score` 仅为向量相似度；关键词独有候选为 0。`context_groups[]` 提供相邻片段、一跳图谱证据，以及主结果、图谱证据来源的事实状态和替代链。图谱不参与主结果融合。`recall --mode vector` 保留原有片段级向量检索用于对照。

模型或索引同步失败时，recall 报错；仍可使用不依赖模型的 search。相似度、词法和 RRF 分数均不表示事实置信度。无答案问题仍可能返回近邻，是否有足够证据作答由智能体判断。

有预算的召回通过独立证据包交付，支持 window/section/page，附带当前快照时间、来源观察时间、record_version、原子事实状态与省略信息；完整 JSON 按明确标注的保守估算限制大小，不重复旧上下文。详见 [证据交付](evidence-delivery.zh-CN.md)。失败使用共享 [智能体操作协议](../operations/agent-protocol.zh-CN.md)，真实模型行为由 [独立上下文验收](../operations/agent-evaluation.zh-CN.md) 观察，不与预置知识回放混算。

证据组装优先放入直接命中的完整事实，其中当前有效替代先于历史状态，再分配正文预算；未交付块仍明确计数。首批扩展检索评估冻结开发/保留集，固定候选对照三种证据范围及两档预算，逐题保留未召回或答案省略的案例，见 [来源型质量基线](../operations/retrieval-evaluation.md#source-based-quality-baseline)。

## 实体与事实生命周期

`entities[].aliases` 是显式的别名声明。同一实体的规范名称、类型和别名参与跨文档查找、概念目录与图端点规范化。歧义别名、别名循环和别名所声明的实体类型不一致会被拒绝；无别名的旧文档仍可保留按类型区分的同名实体，事实需使用无歧义的实体名称；程序不进行模糊实体合并。

可选 `metadata.facts[]` 保存稳定项目唯一 `id`、`text`、`provenance`、`valid_from`，以及可选 `entity`、`valid_until`、`replaces`、`withdrawn_at`、`withdrawal_reason`。旧文档无需补 facts。有效日期必须有时区；`valid_until` 是排他上界。

同一 id 的正文、来源、实体、生效日期和替代目标不可改写；更新保留历史事实，新增事实显式替代旧 id。跨文档替代要求同一规范实体，禁止未知目标、循环、分叉和早于旧事实的替代。已有到期和撤回记录不能撤销。删除文档不能留下悬空替代或实体引用，也不能通过删除跨文档替代历史使旧事实复活。

`draft seal` 对预期写入后的整个项目做事实链聚合校验，不再遇到第一个问题就停止：已存事实的不可变字段、不可撤销的到期与撤回、删除历史事实、未声明或有歧义的实体、未知目标、自我替代、替代实体不一致、早于旧事实、替代已撤回事实、分叉和循环，一次性报告为同一个 `knowledge_conflict`。`details.issues[]` 中每条问题带 `fact_id`、`field`、`problem` 和针对该字段的修复建议 `fix`；同一事实同一字段只报告一次。例如修改事实的 `entity` 时，建议是"改名用别名；换实体就撤回旧事实并新建不带 `replaces` 的事实"，而不是笼统地"用 replaces 替代"。

状态为 active、scheduled、expired、superseded、withdrawn。未来事实生效前不取代旧事实；后继到期或撤回不恢复前驱。`facts list [--entity name-or-alias] [--at ISO-timestamp] [--include-inactive]` 可检查当前或指定有效时间的状态。历史查询使用目前已存的事实链，不重建“当时已知什么”的 Git 快照。

仅 active 事实生成额外检索 chunks。历史事实留在 metadata，来源留在时间线。通过事实引用生成的正文自动跟随有效状态；自由叙述仍由 skills 维护，并需报告与结构化事实的冲突。

## 事实维护一次，正文自动生成

每个事实 id 只在所属文档的 `metadata.facts` 中定义一次。正文使用独立一行 `{{fact:fact_id}}`，可在同一项目的其他文档引用，无需复制事实定义。原 id 的引用沿有效 `replaces` 链跟随后继；未来替代生效前继续显示原事实，后继到期或撤回不复活前驱。

CLI 在现有 Markdown 内生成 `<!-- docnexus:fact fact_id -->` 与 `<!-- /docnexus:fact -->` 包围的块，显示有效事实、来源、生效时间、所属文档和状态。inactive 事实显示状态提示而非旧断言。解释文字写在块外；代码围栏中的引用示例保持字面内容，当前不支持行内引用。

`document_hash` 校验人工正文与事实占位符组成的规范模板，忽略派生块内部内容。无需新增模板文件；`document get --include template,metadata` 返回可编辑结构，`--include document` 返回当前生成结果及 `fact_references`。修改生成内容不会修改事实，访问时会恢复 metadata 所定义的值；人工正文或引用 id 的变更仍需审阅后 `document sync`。

保存事实时，同一个持久化事务更新主文档、metadata、时间线及所有受影响的正文视图。引用方的 `record.json`、来源和时间线不变。读取正文、search、index sync/recall 会刷新时间生效变化；`document render` 可显式刷新全部视图。没有后台计时刷新，直接打开未访问的 Markdown 可能看到上次渲染的快照。引用改变后的生成正文哈希参与知识投影签名，自动使依赖文档的向量索引失效。

带事实引用的草稿在 seal 时生成 `preview.md`，封存其哈希。入库验证预览未被改动，并要求它与当前有效事实生成的结果一致；引用值或状态变化时需重新 seal 和审阅。未解析引用、被引用事实的删除会被拒绝。

草稿 manifest 格式 3 保存 `base_record_hash`。`document get` 和 `document query` 返回各文档的 `record_version`；更新草稿封存必须通过 `--base-version <record_version>` 提交提炼读取时的版本，新路径可用 `--base-version new`。封存和入库均在项目锁内复核完整 record 的规范哈希，覆盖读取、提炼、封存到入库的变更窗口。冲突后必须复读并合并正文、metadata 和历史，再使用该次读取的版本；仅刷新版本不构成合并。目标的正文、来源、metadata/分类、时间线或身份变化，以及原先空路径被占用，都会拒绝旧草稿；`--replace` 不绕过检查。无关文档更新和只刷新生成块不会改变目标版本。旧格式 1/2 的待入库草稿需复读合并后重新封存，已存文档和工作区格式 7 不变。

这一保证适用于显式事实引用。旧正文中的同义句或手写重复值不能可靠自动识别，需一次性审阅后换为引用。摘要和解释应描述主题与原因，避免再次手工维护可变事实值。示例与操作见 [事实工作流](../../skills/docnexus-extract/references/facts.md)。

## 可视化查询与粗分类

运行编排层 skills 的大模型阅读项目说明、已有分类和相关文档后，自主填写 metadata.category 与 category_reason，按项目变化复核相关文档。名称由项目定义，可复用、新建、重命名、合并或拆分分类；CLI 只校验名称格式，不设置固定分类枚举。分类仍只存于各文档 metadata，目录从实际使用的名称聚合，没有另一份分类数据库。旧文档缺少分类时显示未分类，跨主题关联使用 tags。

`document classify --id <id> --category <name> --reason <basis> [--revision <snapshot>]` 仅更新分类 metadata、记录哈希/时间和审计历史，保留正文、来源、事实与关系。普通提炼更新也将分类新旧值和依据追加到时间线。分类名可为 1–80 个字符，去除首尾空白且不含控制字符；依据最多 2000 字符。旧分类 id 的中文显示名仅作兼容，不是允许列表。

`document query --all` 或 `--page 1 --page-size 20 [--category ...]` 输出完整当前 Markdown、分类统计、事实来源与状态。独立脚本位于 `skills/docnexus-library/scripts/query-documents.mjs`，委托项目安装的 CLI；Node 后端可以直接调用 `src/document-query.ts` 导出的 queryDocuments。

查询在项目锁内读取文本、校验完整性并按同一时间生成展示快照，不调用模型或查询检索数据库，不写回源数据或生成块。结果只存在于响应中，不是另一处知识源。按路径稳定排序，后续页可携带 revision 防止混用不同快照；写入、改类、删除和有效事实状态变化都可使 revision 失效。写入后可视化端重新查询第一页。详见 [接口约定](./document-query.zh-CN.md)。

## Git、诊断与维护

Git 默认不参与初始化或同步。显式 `init --git-remote <url>` 预检 Git 可用性、独立仓库边界及宿主跟踪状态，再初始化 `docnexus/.git/`、设置 `origin` 并在有宿主仓库时追加项目内的 `/docnexus/` 忽略规则。已有宿主跟踪会被拒绝，不自动改动暂存区；不执行网络访问或提交。普通 init 保留配置。初始化允许只含有效 Git 元数据及可选安装文件的目录，不接管无关正文。reset 保留 `.git`、配置和历史，返回可选 `preserved_git: true`；当前知识仍会清空。独立仓库配置不改变文本真源或检索投影模型，也不提供跨机器写入协调。

可选 Git 配置同时固定单一本地分支：新建时为 `main`，已有时为当前分支。`.git/docnexus-branch.json` 在工作树之外保存约束，避免旧提交或 reset 移除检查。顶层项目锁内先校验分支及本地分支集合，再恢复文本事务；分支不符、detached HEAD 或额外本地分支时拒绝 DocNexus 操作。默认无 Git 模式不启动 Git 子进程。克隆需重新配置以安装本地约束；检查不能阻止外部 Git 命令、并发切换或人工移除约束，不限制远程分支。

Git 保存完整知识、工作区配置和安装 manifest/lockfile，忽略 `node_modules/`、`store/`、`.runtime/`、六个官方 skills 副本及版本标记、`schemas/metadata.schema.json`；其他名称的自定义 skill 仍可提交。克隆后安装锁定依赖并运行 `init --agent <target>`，恢复 skills、schema 和链接；独立知识仓库同时传入 `--git-remote <url>`。已跟踪副本需显式取消跟踪，详见[恢复与迁移](./skills-workspace.zh-CN.md#已有仓库迁移)。之后关键词查找与全文读取直接使用当前文本；默认宿主仓库模式可跟随业务分支，独立知识仓库受固定分支检查约束；语义召回自动同步派生索引。`index sync` 也刷新最多 300 份文档和 300 个概念的目录，不导入未托管文件。

`doctor` 在恢复未完成事务后检查文本、索引、数据库、本地模型和 skills，不修复缺失投影。新建空工作区尚无检索库是正常状态。`graph audit` 检查已存在的文档/关系投影、孤立概念与 HNSW；缺失存储先运行同步。

`graph repair --force` 重同步图谱声明、清理残留，保留未变向量与健康 HNSW，仅修复异常向量索引。`index rebuild --force` 重新核对全部文档投影，仍复用同模型的未变片段。删除文档先提交文本，再清除数据库记录；服务故障时派生删除延后同步。`reset --force` 若配置远程服务，先删除当前项目 schema，失败则保留本地工作区。项目路径、记录文件与本地派生存储拒绝符号链接越界。

## 主要代码

- `src/managed-documents.ts`：当前知识、时间线、哈希与文件管理。
- `src/project-lock.ts`、`src/text-transaction.ts`、`src/workspace-io.ts`：项目锁、持久化事务与原子落盘。
- `src/workspace-git.ts`：可选独立知识仓库预检、远程配置与宿主忽略规则。
- `src/knowledge.ts`：实体别名、事实生命周期、引用依赖与投影签名。
- `src/fact-renderer.ts`：事实引用、受控生成块、有效状态与模板规范化。
- `src/hybrid-recall.ts`：文档去重与 RRF 融合。
- `src/document-query.ts`：供文档可视化使用的全量/分页快照、分类计数与版本校验。
- `src/retrieval-index.ts`：片段复用、增量同步与模型/切块签名。
- `src/postgres-engine.ts`：PGLite 与 Postgres 连接、项目 schema 与数据库事务适配。
- `src/postgres-store.ts`、`src/graph-mapping.ts`：统一 SQL、pgvector 与关系投影。
- `src/search.ts`、`src/recall.ts`、`src/recall-groups.ts`：关键词和向量/图谱召回。
- `src/embedder-real.ts`、`src/embedding-models.ts`：离线 ONNX 模型与覆盖管理。
- `src/drafts.ts`、`src/concepts.ts`、`src/skills.ts`：草稿、目录与工作流分发。

小型检索基线见 [检索评估](../operations/retrieval-evaluation.md)。

工作区格式为 7，程序文件在 `.docnexus/`，知识输出目录通过 `init --output-dir` 指定；不兼容或迁移任何旧格式。旧历史方案文档保持删除。
