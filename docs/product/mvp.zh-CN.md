# DocNexus 产品说明（MVP）

DocNexus 是面向 Codex、Claude 等智能体的本地项目记忆工具，以 skills 为唯一交互入口。Skills 负责判断与生成（提炼、审阅、回答）；项目内 CLI 负责可校验的契约（草稿封存、入库、召回、维护）。所有流程均由用户手动触发。

## 产品契约

- CLI 不调用 LLM。智能体生成 `source`、提炼后的 Markdown `document` 与结构化 `metadata`。
- 项目的全部 DocNexus 内容位于 `docnexus/`：`skills/`、`drafts/`、`library/`、`schemas/`、`store/`。智能体只写入 `draft new` 分配的草稿目录。
- metadata 必须包含至少一个基于来源的实体；`metadata validate`、`draft seal` 与写入使用同一规则。
- `draft seal` 校验三个产物非空与 metadata 合法，记录哈希并写入 manifest；封存后修改会使入库被拒绝。
- `document add --draft <id>` 只接受 `ready` 草稿，入库后草稿变为 `ingested`，同时同步 chunks、本地 embeddings 与 LadybugDB 图谱/向量。
- 一个 `file_path`（相对 `docnexus/library/`）标识一份当前文档，更新原位覆盖，不保留旧版本；覆盖须经用户确认后传 `--replace`。
- 托管路径与草稿目录必须位于 `docnexus/` 内且不得包含符号链接。
- `document delete ... --force` 经确认后物理删除 library 文件与全部派生状态。
- `reset --force` 删除整个 `docnexus/` 与指向它的 skill 链接；无 DocNexus 标记的同名目录会被拒绝。
- `index rebuild --force` 只维护已登记的托管文档，不承担导入。
- `doctor` 检查 Node/SQLite、项目初始化、skills 与链接、SQLite schema、LadybugDB 向量索引和本地 embedding。

## 部署

```bash
npm install --save-dev @rowansenne/docnexus
./node_modules/.bin/docnexus init --agent claude
```

`init` 建立工作区并同步 skills；`--agent` 在 `.claude/skills/` 或 `.agents/skills/` 中链接到 `docnexus/skills/`。无需 MCP 或用户级安装。

## 智能体工作流

1. `/docnexus` 预检 `status`，按意图路由。
2. 捕获：`docnexus-extract`（`draft new` → 写产物 → `draft seal`）→ 用户审阅 → `docnexus-ingest`（`document add --draft`）。
3. 召回：`docnexus-recall` 运行 `recall`，基于 `context_groups[]` 回答并引用 `docnexus/library/<path>`。
4. 管理：`docnexus-library` 列出、查看、删除文档与草稿。
5. 维护：`docnexus-maintain` 诊断后按需修复、重建或重置。

召回强依赖 metadata 与图谱状态。Embedding 默认以 local-only 方式加载随包的 `BAAI/bge-small-zh-v1.5` 量化 ONNX 资产，优先使用 `docnexus/store/models/` 中的项目覆盖。自动捕获、文件监听、外部 LLM、CLI 内回答生成以及更深层多跳推理不在当前 MVP 范围内。
