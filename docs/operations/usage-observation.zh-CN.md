# 本地使用观察

从 0.18.0 起可用。目标是在实际使用一段时间后，导出一份文件，分析查询开销、检索与证据交付问题，以及多跳检索的实际需求。

## 启用与导出

默认关闭，按项目启用。已安装包含该功能的版本后，在项目根目录运行：

```bash
./.docnexus/node_modules/.bin/docnexus usage enable
./.docnexus/node_modules/.bin/docnexus usage status
# 正常使用 DocNexus，之后导出：
./.docnexus/node_modules/.bin/docnexus usage export > .docnexus/.runtime/usage-report.json
./.docnexus/node_modules/.bin/docnexus usage disable
```

开发仓库运行 `npm run build` 后，可使用 `node /path/to/docnexus/dist/src/cli.js --project-root /path/to/host-project` 替代上述可执行文件。宿主项目必须已初始化；启用记录不会创建知识或导入文件。后续使用也必须经过包含该功能的 CLI；旧 npm CLI 的操作不会被新版旁观记录。

分享 `usage-report.json` 即可，不需要提供整个项目、数据库或配置文件。导出文件包含 schema 版本、导出环境、采集开关/容量状态、事件及限制说明；每条命令事件也带运行环境，便于区分使用期间的版本变化。没有联网上传或后台采集。

## 文件与数据边界

| 文件 | 内容 |
| --- | --- |
| `.docnexus/.runtime/usage-config.json` | 开关与项目专用的随机密钥，不导出、不分享 |
| `.docnexus/.runtime/usage.jsonl` | 逐条追加的本地事件 |
| `.docnexus/.runtime/usage-report.json` | 用户显式重定向生成的单文件导出 |

这些文件位于 Git 忽略的 `.runtime/` 中。配置和新建日志按 `0600` 创建。查询以 NFKC、去除首尾空白及小写归一化后，使用项目密钥做 HMAC；同一项目内可关联重复问题，不同项目的标识不同。文档和分类也只保留带密钥的标识。导出不包含密钥、原始查询、路径、文档标题/摘要/正文、来源、命令原始参数、数据库 URL 或原生错误消息。时间、平台和行为模式仍属于使用信息，分享由用户决定。

日志上限为 10 MiB，满后停止追加并通过 `usage status`/导出中的 `full` 报告；不会轮换或删除旧记录。关闭记录保留现有数据，并阻止仍在执行的长命令结束后继续追加。`reset --force` 会删除配置和记录，重置前先导出。不要删除整个 `.runtime/`，它还可能包含未完成文本事务的恢复日志。

## 收集的指标

命令记录覆盖主要 CLI 命令及浏览页 `/api/documents` 的查询；跳过 `init`、`reset`、`protocol` 和采集管理命令本身。查询适配脚本转调 CLI，因此也被记录。直接使用 Node 库函数、智能体直接读文件、其他程序的操作不在覆盖范围内。

开发版的 `impact save/list/get/set` 也接入同一可选采集器，仅增加 `impact_id`（项目密钥 HMAC）、`impact_count`、`impact_pages`、`impact_needs_review` 等匿名标识和数量。影响清单的路径、来源、文档/清单版本、scope、证据、行动建议、处理理由和历史内容不进入导出。原始影响记录保存在可备份的 `impacts/`，与匿名使用日志用途不同。

| 字段 | 含义与用途 |
| --- | --- |
| `command`、`action`、`surface` | 固定白名单的命令/子命令及 CLI/浏览页入口 |
| `duration_ms`、`status`、`error_code` | 操作耗时与稳定错误码；耗时不含采集配置读取及最终日志写入 |
| `package_version`、`node_version`、`platform`、`arch` | 该次调用的运行环境 |
| `configured_engine`、`configured_embedder` | 配置选择，不代表该命令实际打开数据库或调用模型 |
| `query_id`、`query_chars`、`query_bytes`、`has_han`、`has_latin` | 匿名查询关联、长度及字符类别；不保存问题含义 |
| `category_id`、`options` | 匿名分类、请求的 limit/预算/范围/分页参数；实际 limit 可能受 CLI 上限约束 |
| `result_count`、`results` | search/普通 recall 的结果数及前 10 条匿名文档与关键词/向量名次；结果非空不表示问题有答案 |
| `document_id`、`document_ids`、`returned_documents` | 全文读取、写入和分页返回的匿名身份；文档列表最多保留前 10 个身份 |
| `evidence` | 交付块数、主文档数、事实/关系块数、完整 JSON 保守预算、截断及省略数 |
| `metrics.snapshot_loads`、`document_count` | 调用内工作区快照加载次数与最近一次快照的文档数，不额外读取真源 |
| `metrics.relationship_declarations` | 最近一次快照中 metadata 关系声明总数，包含重复声明，不是去重图边数 |
| `metrics.embedding_calls`、`embedding_ms` | 经过公共 embedding 入口的调用次数与耗时，包含模型加载和签名探针；token-budget 预加载时间可能计入总耗时但不计入此字段 |
| `metrics.database_opens`、`database_open_ms`、`database_close_ms` | 新租约数量与创建/关闭耗时；Postgres 延迟建立连接，首次 SQL 的连接等待仍在总耗时中 |
| `metrics.project_lock_wait_ms` | 非嵌套锁的累计 SQLite 获取等待；成功获取才计入，不含创建锁目录/文件开销 |
| `metrics.sync_*` | 同步规划尝试数、已提交的文档/片段增量与复用数；重试或失败的模型工作可能出现在 embedding 指标中而不在提交数中 |
| `metrics.keyword_candidates`、`vector_candidates`、`keyword_top1_retained`、`keyword_top3_retained` | 混合召回的候选数及关键词前三被最终融合保留的数量，帮助识别融合挤掉强词法候选；不衡量相关性 |
| `metrics.recall_result_count`、`graph_paths`、`graph_supporting_chunks` | 最后一轮召回结果数及一跳图谱上下文数量；预算交付前后的数量可分别分析 |
| `output_bytes`、`rss_bytes` | 返回值序列化大小及命令结束时进程 RSS；浏览页大小不含后续 HTML 渲染，RSS 不是峰值或该次调用独占的内存 |

未调用某个阶段时，相应 metrics 字段可以缺省，不能一律当作零。采集不增加模型调用或工作区快照，但会增加少量配置文件读取、计时和日志追加开销。自动追加最多等待项目锁 1 秒，争用时可丢失该条记录；显式采集管理命令沿用普通锁等待。它不会改变现有 stdout 契约；采集失败仅发出不带路径/原文的 stderr 提示，不替换原操作的结果或错误。

## 显式反馈

对于确实观察到的问题，可关联最近一次 search/recall：

```bash
./.docnexus/node_modules/.bin/docnexus usage feedback --rating useful
./.docnexus/node_modules/.bin/docnexus usage feedback --rating partial --reason truncated
./.docnexus/node_modules/.bin/docnexus usage feedback --rating miss --reason needs_multihop
```

`rating` 支持 `useful`、`partial`、`miss`。可选 `reason` 支持 `needs_multihop`、`missing_document`、`irrelevant`、`truncated`、`stale`、`slow`、`other`，不收集自由文本。反馈必须在启用且日志未满时写入。默认关联最后一个已记录的搜索/召回事件；并发使用或反馈早先查询时，用 `usage status`/导出中的事件 ID 加 `--event <event_id>`。多次反馈按时间保留，不覆盖旧判断。

反馈是显式报告，未独立核实。不要让智能体因“结果非空”自动标记有用，也不要将所有查找失败都标记为需要多跳。

## 后续如何分析

拿到导出文件后，先区分版本、入口、检索模式和知识库规模，再比较命令 p50/p95、错误类型、embedding/数据库/快照开销、增量复用、融合保留和紧预算截断。用匿名查询标识关联重复查找、重试及显式反馈，用匿名文档身份观察检索后的全文读取行为。

`needs_multihop` 反馈结合关系声明数与现有图谱交付量，可帮助决定是否投入两跳试验。它不能单独证明多跳会改善回答。因为不保存原始问题和答案，无法从日志独立判断语义相关性、引用正确性或用户满意度；需要时再由用户提供经过选择的失败案例。

该文件也不是完整审计记录：SIGKILL、中断前尚未完成的命令、磁盘故障及超出上限的事件可能缺失。导出报告 `invalid_lines`，忽略中断遗留的不完整行；后续追加先换行，避免污染下一条有效事件。观察日志不参与知识真源和数据库重建。
