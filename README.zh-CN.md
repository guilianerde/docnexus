# DocNexus

[English README](./README.md)

DocNexus 是一款面向 Codex、Claude 等编码智能体的本地项目记忆服务。智能体先提炼用户选定的原始内容；DocNexus 再按项目路径保存一份当前托管 Markdown 文档，并召回带引用文件的结构化 Graph RAG 上下文。

本项目参考 [GitNexus](https://github.com/abhigyanpatwari/GitNexus) 的智能体工作流风格，当前聚焦手动触发、项目本地存储、一份全局注册的 MCP 服务以及随包提供的 skills。

## 能力

- `docnexus-capture` 在单次 MCP 写入前完成 source、document 和 metadata 提炼。
- `docnexus-recall` 通过 CLI 检索归集后的上下文，并基于参考文件回答。
- MCP 向智能体提供存储、metadata 校验、物理删除和状态查询 tools。
- CLI 提供项目初始化、skills 安装、召回、索引维护、图谱审计/修复、删除和 reset。
- 默认使用本地 embedding 模型 `BAAI/bge-small-zh-v1.5`。
- SQLite 保存当前托管文档/chunks，LadybugDB 保存当前图谱和向量状态。

DocNexus 不调用外部 LLM 提供商。提炼和最终回答始终由智能体完成。

## 架构

```text
Agent / User
  |
  | 手动调用 capture 或 recall skill
  v
Skills
  - 提炼 source -> 当前 document + metadata
  - 基于归集召回上下文回答
  |
  v
全局 MCP 服务                      CLI
  - 每次显式传 project_root        - recall / 维护 / reset
  - 当前文档读写与删除             |
  |                                |
  +---------------+----------------+
                  v
项目本地 .docnexus/
  - SQLite documents + file_chunks
  - LadybugDB 图谱/向量状态
  - 当前 source 与 metadata sidecars
```

## 安装与初始化

需要支持 `node:sqlite` 的 Node.js 与 npm。

只安装一次可执行程序：

```bash
npm install -g @docnexus/docnexus
```

在每个需要独立记忆空间的项目中初始化并按需安装 skills：

```bash
cd /path/to/your-project
docnexus init
docnexus skills install --target codex
docnexus skills install --target claude
```

不进行全局安装时：

```bash
npx -y @docnexus/docnexus init
npx -y @docnexus/docnexus skills install --target codex
```

每个已初始化项目都拥有独立的 `.docnexus/` 数据域，文档、embedding 和图谱状态不会跨项目共享。

## 一次注册 MCP

客户端按需启动 MCP 进程。每次 tool 调用必须提供已初始化项目的绝对路径 `project_root`。

Codex：

```bash
codex mcp add docnexus -- docnexus mcp
```

```toml
[mcp_servers.docnexus]
command = "docnexus"
args = ["mcp"]
```

Claude Code：

```bash
claude mcp add --transport stdio docnexus -- docnexus mcp
```

```json
{
  "mcpServers": {
    "docnexus": {
      "command": "docnexus",
      "args": ["mcp"]
    }
  }
}
```

## MCP Tools

| Tool | 用途 |
| --- | --- |
| `archive_record` | 创建或覆盖一份当前托管 Markdown 文档，并立即建立索引。 |
| `list_records` | 按 tag 可选过滤，列出当前托管文档。 |
| `get_record` | 读取当前文档的 source、Markdown 和/或 metadata。 |
| `status` | 返回当前托管文档存储状态。 |
| `validate_metadata` | 写入前校验 metadata。 |
| `delete_document` | 物理删除托管文件及派生状态；必须传 `confirm: true`。 |
| `index_status` | 返回当前文档数和 chunk 数。 |

保留的 `archive_record`、`list_records` 和 `get_record` 名称仅表示当前状态，不会留存旧版本。

创建或覆盖示例：

```json
{
  "project_root": "/absolute/path/to/your-project",
  "file_path": "docs/memory/auth.md",
  "source": "原始选定内容",
  "document": "# 认证\n\n当前提炼结论。",
  "metadata": {
    "title": "认证",
    "summary": "当前认证方案决策。",
    "tags": ["auth"],
    "entities": [],
    "relationships": []
  }
}
```

再次写入同一个托管 `file_path` 时，当前 source、document、metadata、chunks、embeddings 和图谱状态会一起被覆盖。

## 捕获与召回工作流

捕获由用户手动触发：

1. 智能体使用 `docnexus-capture` 准备 `source`、提炼后的 `document` 和结构化 `metadata`。
2. 智能体选择项目内相对路径 `file_path`。
3. 通过 MCP 校验 metadata。
4. 一次 `archive_record` 调用写入当前目标文档、当前 sidecars、chunks、embeddings 与 LadybugDB 图谱状态。

召回由用户手动触发：

```bash
docnexus recall "本地 embedding 和 LadybugDB 的关系" --limit 5
```

召回返回按向量相关性排序的 `results[]` 与按文档归集的 `context_groups[]`。每组通过当前 `document_id` 标识并引用其托管路径，可包含有界的邻近 chunks 与一跳图谱支持证据。metadata 和 graph context 是强依赖；系统不会返回缺失这些内容的降级结果。

## CLI 命令

除 reset 外，以下命令在已初始化项目中执行：

```bash
docnexus index status
docnexus index rebuild --force
docnexus graph audit
docnexus graph repair --force
docnexus recall "query" --limit 5
```

`index rebuild --force` 仅用于维护：它从已注册的当前托管文档及当前 sidecars 重建派生状态，不会导入未托管文件。

按路径或 ID 物理删除当前托管文档：

```bash
docnexus document delete --file docs/memory/auth.md --force
docnexus document delete --id doc_0000000000000000 --force
```

删除会移除项目内托管 Markdown 文件、当前 sidecars、SQLite 行/chunks 以及 LadybugDB 文档/chunk 状态，不保留单文档删除记录。

重置 DocNexus 数据域：

```bash
docnexus reset --force
docnexus init
```

对于当前格式项目，reset 删除所有已登记的托管目标文件以及完整 `.docnexus/` 目录。对于旧格式或无法读取的数据域，reset 只删除 `.docnexus/`，因为系统无法安全判断外部目标文件的归属。

## 存储结构

```text
docs/memory/auth.md                  # 当前托管 Markdown 示例
.docnexus/
  project.json                       # 格式版本标记
  index.sqlite                       # documents + file_chunks
  store.lbug                         # 当前图谱/向量状态
  documents/
    <document_id>/
      source.md                      # 仅当前 source
      metadata.json                  # 仅当前 metadata
  schemas/
    metadata.schema.json
```

一个 `file_path` 只标识一份当前文档；更新会原位覆盖状态，不提供历史留存、独立索引写入或旧格式兼容层。

## Embeddings 与图谱维护

默认本地模型：

```text
BAAI/bge-small-zh-v1.5
```

确定性测试可设置：

```bash
DOCNEXUS_EMBEDDER=hash npm test
```

`docnexus graph audit` 检查当前 SQLite 文档与 LadybugDB 状态的偏离。`docnexus graph repair --force` 删除陈旧图文档和孤立概念并重建向量索引。缺失或 chunk 数不一致的当前文档状态由 `docnexus index rebuild --force` 重建。

## 开发

```bash
npm install
npm test
npm run typecheck
npm run build
node dist/src/cli.js mcp
```

## 当前范围

已实现：

- Scoped npm 分发与逐项目初始化。
- 一份全局 MCP 注册，每次调用显式传入 `project_root`。
- Skills 驱动的提炼与对话召回。
- 单版本当前托管文档存储、物理删除和 reset。
- 本地 embeddings、LadybugDB 向量/图谱召回与归集 Graph RAG 上下文。
- CLI rebuild、图谱审计和图谱修复维护。

暂未实现：

- 自动捕获或文件监听。
- 外部模型供应商接入。
- MCP 内部生成最终答案。
- 更深层多跳图推理。
