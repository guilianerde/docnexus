# 智能体操作协议 v1

`docnexus protocol` 从运行时代码返回 `protocol_version: 1` 和错误定义。CLI、核心异常与 doctor 使用同一份错误注册表，不从报错文字推断类别。已有成功输出保持原形状；新增字段为可选兼容扩展。

## 调用与错误

```bash
docnexus --project-root /absolute/project --json recall "发布约定"
docnexus doctor --json
docnexus protocol
```

`--json` 使失败在 stdout 返回一份 JSON，退出码仍为 1；stderr 可有运行提示。无此标志时错误为面向人的文本。Node 调用者仍收到带 `code` 的 `DocNexusError`。未知内部异常统一为 `internal_error`，不猜测是否可以重试。

```json
{
  "protocol_version": 1,
  "status": "error",
  "code": "project_busy",
  "message": "DocNexus project is busy; retry after the current operation completes",
  "retryable": true,
  "retry_after_ms": 1000,
  "next_action": {
    "kind": "retry",
    "message": "Wait for the current operation, then retry the same request."
  },
  "verify": { "argv": ["docnexus", "--project-root", "/absolute/project", "doctor"] }
}
```

`next_action.argv` 是参数数组，不能拼接后作为 shell 文本执行。`kind: review` 的参数只是读取/检查入口，不授权写入；`repair` 或 `configure` 也不扩大用户既有授权。`verify` 是诊断入口，doctor 的 `result` 和 `issues` 用于确认状态，而不是仅看退出码。

| 错误 | 处理 |
| --- | --- |
| `project_busy` / `concurrent_update` | 等待后重试相同请求；重复冲突先检查其他写入 |
| `target_changed` | 复读正文、模板、metadata 与时间线，合并后再使用该次读取的版本封存；禁止只刷新版本。`next_action.argv` 直接给出该目标页的完整读取命令（`document get --id <目标> --include document,template,metadata,timeline`）；目标已不存在时退回 `document query --all` |
| `document_revision_changed` | 丢弃旧分页，从第一页重新读取 |
| `draft_changed` / `preview_changed` | 重新检查实际产物或引用事实，封存并审阅新内容 |
| `text_integrity_error` | doctor 检查；审阅后采纳人工正文或从备份恢复损坏文件 |
| `index_outdated` | 从已验证文本同步派生索引 |
| `index_schema_incompatible` | 使用与该投影版本兼容的 DocNexus；仍可直接查找和读取文本 |
| `index_unavailable` / `embedding_failed` | 检查数据库/离线模型；可使用独立文本 search |
| `embedding_input_too_long` | 缩短查询或拆分输入 |
| `knowledge_conflict` / `invalid_metadata` | 按实体、事实与格式规则审阅修正；事实链问题一次性列在 `details.issues[]`（`fact_id`、`field`、`problem`、`message`、`fix`、`source_path`），按每条 `fix` 全部修正后再封存 |
| `internal_error` | 检查实际持久状态并报告；错误不证明写入未提交 |

doctor 保留原有 `checks` 和 `recommendations`，新增 `protocol_version`、结构化 `issues[]`。发现真源损坏时，机器清单优先要求审阅真源，不建议先用索引重建掩盖问题。完整错误枚举以 `docnexus protocol` 为准。

CLI 访问仍会执行既有的未完成事务恢复；“诊断/读取”不表示绕过恢复机制。

## 可选知识 Git 仓库

`init --git-remote <url>` 对应 Node `initializeProject` 的可选 `gitRemote`，可用于新工作区或更新已有工作区的独立 `origin`。成功输出增加可选 `git: { repository, remote, branch }`，默认成功输出不变；未启用 Git 的工作区无需 Git，已有配置保持不变。Git 缺失返回 `git_unavailable`；宿主已跟踪工作区、仓库边界不符或 Git 操作失败返回 `git_operation_failed`。均不自动重试；初始化和 Git 配置可能部分完成，检查实际状态后再处理。该选项不执行提交或网络同步。`reset --force` 在保留 `.git` 时增加 `preserved_git: true`，历史及远程配置保留，当前知识被清空。

新独立仓库固定 `main`，已有仓库固定配置时的当前分支；多本地分支或 detached HEAD 会拒绝配置。约束保存在 `.git/docnexus-branch.json`，每次顶层项目锁内先检查再恢复文本事务。分支不符、detached HEAD 或额外本地分支返回 `git_branch_mismatch`，`details` 包含 `allowed_branch`、`actual_branch`（detached 为 null）、`local_branches`；不自动切换、删除或重新固定分支。约束保留于 reset，克隆后需在本机重新执行 `init --git-remote`。这不是 Git 命令拦截或远程分支保护，不能替代服务端规则，也不协调外部 Git 的并发操作。

## 调用方显式分类

用户或调用方 skill 已确定文档类型时，可在封存阶段指定分类，跳过本次写入的模型分类。例如 code-review skill 已准备好三份草稿产物：

```bash
./.docnexus/node_modules/.bin/docnexus draft seal --id <draft_id> --file reviews/report.md \
  --base-version new --category codeReview \
  --category-reason "Produced by the code-review skill"
# 审阅最终 metadata 和文档；含事实引用时同时审阅 preview_file。
./.docnexus/node_modules/.bin/docnexus document add --draft <draft_id>
```

| CLI 参数 | Node `sealDraft` 输入 | 含义 |
| --- | --- | --- |
| `--category` | `category` | 可选；本次写入的分类，按原样采用，覆盖草稿已有分类。1–80 字符，无首尾空白或控制字符 |
| `--category-reason` | `categoryReason` | 可选；非空且不超过 2000 字符，必须同时指定分类；写入 `metadata.category_reason` |

未提供依据时记录 `Explicit category supplied by caller.`，不会继承旧分类的模型依据。未提供分类时保留原有 metadata 和编排分类流程。显式指定成功后，seal 的 JSON 额外返回可选 `category`、`category_reason`；其余成功字段和协议版本 1 不变，草稿 manifest 仍为格式 3。

分类在封存时写入 `metadata.json`，其最终字节纳入 `manifest.hashes.metadata`；入库消费这一已审阅版本，时间线记录分类与依据。`document add` 不接受分类覆盖参数，传入会返回 `invalid_params`，应回到 seal 后重新审阅。封存后修改分类或依据会返回 `draft_changed`；更新已有文档仍需要提炼读取时的 `--base-version <record_version>` 和已授权的 `--replace`，版本变化返回 `target_changed`。

同次捕获后的分类维护保留调用方选择；后续可显式调整，不构成永久分类锁。详细编排规则见 [调用方分类工作流](../../skills/docnexus-library/references/classification.md#caller-selected-category)。

## 按分类查找

```bash
docnexus search "并发问题" --category codeReview --limit 5
docnexus recall "哪些评审问题尚未解决？" --category codeReview
docnexus recall "并发约定" --mode vector --category codeReview
docnexus recall "评审结论" --category codeReview --return-unit section --context-budget 4000
```

Node API 的 `searchDocuments`、`recall`、`recallEvidence` 输入均接受 `category?: string`。分类名精确、区分大小写，使用与写入/文档查询相同的 1–80 字符校验，非法值返回 `invalid_params`；`uncategorized` 包含没有分类的旧文档，未知分类正常返回空结果。不传参数时保持全项目检索。

过滤在关键词匹配、向量候选限额和 RRF 融合前生效，图谱支持文档和关系声明者也受分类约束；文内事实引用继续保留跨分类定义者及其生命周期。分类取当前文本快照，不依赖旧数据库分类缓存。指定分类无结果时，不自动退回所有分类。
