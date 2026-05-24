# DocNexus 产品说明（MVP）

DocNexus 是面向 Codex、Claude 等智能体的本地项目记忆服务。Skills 负责智能提炼与回答生成；MCP 负责当前托管文档与派生召回状态；CLI 提供召回和维护命令。所有流程均由用户或智能体手动触发。

## 产品契约

- MCP 不调用 LLM。智能体先生成 `source`、提炼后的 Markdown `document` 与结构化 `metadata`。
- 一个项目相对 `file_path` 标识一份当前托管文档。
- `archive_record` 创建或覆盖该文档，并立即同步 chunks、本地 embeddings 与 LadybugDB 图谱/向量状态。
- 对同一托管路径再次写入会替换当前状态，不保留旧版本。
- `delete_document` 需要 `confirm: true`；CLI `docnexus document delete ... --force` 会物理删除托管文件与全部派生状态。
- `docnexus reset --force` 对当前格式清除托管文件和 `.docnexus/`；对旧格式或损坏数据域仅清除 `.docnexus/`。
- `docnexus index rebuild --force` 只维护现有当前托管文档，不承担导入入口。

## 部署与隔离

```bash
npm install -g @docnexus/docnexus
cd /path/to/project
docnexus init
docnexus skills install --target codex
```

全局注册一次 MCP：

```bash
codex mcp add docnexus -- docnexus mcp
```

每次 MCP tool 调用必须携带已初始化项目的绝对 `project_root`。不同项目分别在 `.docnexus/` 下保存 SQLite 与 LadybugDB 状态。

## 智能体工作流

1. `docnexus-capture` 准备 source、提炼文档、metadata 与托管 `file_path`。
2. Skill 校验 metadata，然后发出一次 `archive_record` 请求。
3. MCP 写入目标 Markdown、当前 sidecars、SQLite 文档/chunks、embeddings 和图谱数据。
4. `docnexus-recall` 运行 CLI recall，取得按向量排序的 `results[]` 与按文档归集的 `context_groups[]`。
5. Agent 结合归集 chunks 和受控图谱上下文回答，并引用托管文件路径。

## 存储结构

```text
<managed file_path>.md
.docnexus/
  project.json
  index.sqlite                  # documents + file_chunks
  store.lbug
  documents/<document_id>/
    source.md
    metadata.json
  schemas/metadata.schema.json
```

召回强依赖 metadata 与图谱状态。自动捕获、文件监听、模型供应商 LLM 接入、MCP 内回答生成以及更深层多跳推理不在当前 MVP 范围内。
