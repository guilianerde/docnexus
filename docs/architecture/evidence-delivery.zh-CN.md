# 有预算的召回证据

```bash
docnexus recall "发布前需要遵守哪些约定" --return-unit section --context-budget 4000
```

只要指定 `--return-unit` 或 `--context-budget`，CLI 返回独立的证据包，包含 `protocol_version`、`query`、`as_of`、`snapshot_revision`、`delivery` 与 `evidence[]`；不再重复返回完整 `results/context_groups`。未指定时仍返回原召回形状，并附带当前快照时间与版本。

Node 入口为 `recallEvidence(projectRoot, input, embedder?)`。检索完成后，在项目锁内重新读取并验证相同快照，再组织真源证据；变化时重试，连续三次冲突返回 `concurrent_update`。模型推理仍在锁外完成。

## 范围与预算

| 参数 | 行为 |
| --- | --- |
| `return_unit: window` | 默认；合并定位到正文中的命中与相邻片段，重叠区域只返回一次 |
| `return_unit: section` | 返回包含命中的 Markdown 章节；忽略代码围栏中的伪标题；无章节时回退 window |
| `return_unit: page` | 返回当前文档的人工正文与事实引用结构 |
| `context_budget` | 默认 4000，512–1000000 的整数；标题、引用、状态及 JSON 字段均计入估算 |

`delivery.token_counter` 为 `utf8_bytes_conservative_estimate`，`estimated_tokens` 等于完整缩进 JSON 加末尾换行的 UTF-8 字节数。它是一种明确标注的保守估算，不是宿主大模型 tokenizer 的精确计数，也不使用 BGE tokenizer 冒充回答模型。`estimated_tokens <= budget_tokens` 约束整个 CLI JSON；模型的实际上下文上限及消息包装仍由宿主负责。

主文档、归属事实、关系声明与支持正文按确定次序装入预算。正文超限时围绕已定位命中截取并保留 Unicode 字符，附截断标记；定位失败返回 page 并标明 `anchor_not_located`。事实作为完整来源/状态单元装入或省略，不截断出处后把半条事实当完整结论。预算无法容纳任何有效证据与引用时返回 `invalid_params`，不能把它当作无答案。

## 事实与时间

正文中的派生事实块还原为 `{{fact:id}}` 引用，事实只在 `kind: fact` 的证据块中表达一次。active 事实包含完整断言及 provenance、有效日期和所属文档；inactive 事实只提供状态、替代关系及出处，不把旧断言重新交付为当前事实。未能装入的块计入 `omitted_blocks`，`truncated` 标明不完整交付；要解释未交付的引用，须扩大预算或读取完整文档。

每个证据块携带 `document_id`、`path` 和 `record_version`。关系声明引用其实际所属文档。`as_of` 是整次事实解析时间；文档块的 `observed_at` 来自该文档可选的同名 metadata 字段，表示来源内容被观察或说出的时间，必须为带时区的 ISO 时间戳。未提供时为 null，不能以 record 的保存时间填充。事实和关系缺少独立来源观察日期，保留 null；不能把所属文档的观察时间套到历史保留的逐条声明上。

事实 `valid_from` 表示何时生效，来源观察时间与写入时间各有不同含义。该入口返回当前快照，不实现历史索引重放或自然语言日期推断。普通人工叙述仍按原文返回，智能体需检查它与结构化事实的冲突。

合并时若 `source.md` 换成新材料，需按新材料重新审阅文档的 `observed_at`。未知时省略该字段，不能机械继承旧来源日期；历史事实的生效日期和 provenance 独立保留。CLI 只验证时间格式，不能判断自然语言材料与日期是否语义一致。
