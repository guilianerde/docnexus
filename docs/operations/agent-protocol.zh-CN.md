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
| `target_changed` | 复读正文、模板、metadata 与时间线，合并后再使用该次读取的版本封存；禁止只刷新版本 |
| `document_revision_changed` | 丢弃旧分页，从第一页重新读取 |
| `draft_changed` / `preview_changed` | 重新检查实际产物或引用事实，封存并审阅新内容 |
| `text_integrity_error` | doctor 检查；审阅后采纳人工正文或从备份恢复损坏文件 |
| `index_outdated` | 从已验证文本同步派生索引 |
| `index_unavailable` / `embedding_failed` | 检查数据库/离线模型；可使用独立文本 search |
| `embedding_input_too_long` | 缩短查询或拆分输入 |
| `knowledge_conflict` / `invalid_metadata` | 按实体、事实与格式规则审阅修正 |
| `internal_error` | 检查实际持久状态并报告；错误不证明写入未提交 |

doctor 保留原有 `checks` 和 `recommendations`，新增 `protocol_version`、结构化 `issues[]`。发现真源损坏时，机器清单优先要求审阅真源，不建议先用索引重建掩盖问题。完整错误枚举以 `docnexus protocol` 为准。

CLI 访问仍会执行既有的未完成事务恢复；“诊断/读取”不表示绕过恢复机制。
