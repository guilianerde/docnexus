# DocNexus 产品说明（MVP）

DocNexus 是面向 Codex、Claude 等智能体的本地项目记忆服务。Skills 负责智能提炼与回答生成；CLI 负责托管文档写入、召回和维护；CLI 提供读取、校验和状态命令。所有流程均由用户或智能体手动触发。

## 产品契约

- CLI 不调用 LLM。智能体先生成 `source`、提炼后的 Markdown `document` 与结构化 `metadata`。
- metadata 必须包含至少一个基于来源的实体；CLI 校验与写入使用同一规则。
- 一个项目相对 `file_path` 标识一份当前托管文档。
- 托管目标必须位于项目的 `.docnexus/` 目录内且路径中不得包含符号链接；新增、删除和 reset 使用同一安全边界。
- `docnexus document add` 创建或覆盖该文档，并立即同步 chunks、本地 embeddings 与 LadybugDB 图谱/向量状态。
- 对同一托管路径再次写入会替换当前状态，不保留旧版本。
- 更新已有托管路径时，`/docnexus-document-add` 必须先获取用户确认，CLI 再显式传 `--replace`。
- `/docnexus-document-delete` 确认删除后调用 `docnexus document delete ... --force`，物理删除托管文件与全部派生状态。
- `docnexus reset --force` 对当前格式清除托管文件和 `.docnexus/`；对旧格式或损坏数据域仅清除 `.docnexus/`。
- `docnexus index rebuild --force` 只维护现有当前托管文档，不承担导入入口。
- `docnexus doctor` 检查 Node/SQLite、项目初始化、SQLite schema、LadybugDB 向量索引和本地 embedding 可用性。
- `docnexus embeddings install --from <model-dir>` 是可选覆盖入口，可将已准备好的 Transformers.js 模型资产复制到当前项目 `.docnexus/models/`。

## 部署与隔离

在每个目标项目中安装 npm 依赖和 skills：

```bash
npm install --save-dev @rowansenne/docnexus
./node_modules/.bin/docnexus init
./node_modules/.bin/docnexus skills install --target codex
```

项目内的 `.docnexus/` 保存 SQLite、LadybugDB、草稿、托管文档与 sidecars；`.agents/skills/` 或 `.claude/skills/` 保存项目 skills。无需 MCP 注册。

## 智能体工作流

1. `/docnexus-document-extract` 校验 metadata 并在 `.docnexus/drafts/<draft_id>/` 写入完整草稿包；只有验证 `source.md`、`document.md`、`metadata.json` 和 `manifest.json` 后才报告成功。
2. `/docnexus-document-add` 读取已校验的草稿 manifest 并运行 `docnexus document add`；已有托管路径仅在确认后使用 `--replace`。
3. CLI 写入目标 Markdown、当前 sidecars、SQLite 文档/chunks、embeddings 和图谱数据。
4. `docnexus-recall` 运行 CLI recall，取得按向量排序的 `results[]` 与按文档归集的 `context_groups[]`。
5. Agent 结合归集 chunks 和受控图谱上下文回答，并引用托管文件路径。

## 存储结构

```text
.docnexus/
  <managed file_path>.md
  drafts/<draft_id>/
    source.md
    document.md
    metadata.json
    manifest.json
  project.json
  index.sqlite                  # documents + file_chunks
  store.lbug
  models/
  documents/<document_id>/
    source.md
    metadata.json
  schemas/metadata.schema.json
```

召回强依赖 metadata 与图谱状态。Embedding 默认以 local-only 方式加载随 npm 包发布的 `BAAI/bge-small-zh-v1.5` 量化 ONNX 资产；运行时优先读取项目 `.docnexus/models/` 覆盖模型，再读取包内 `models/`。自动捕获、文件监听、模型供应商 LLM 接入、CLI 内回答生成以及更深层多跳推理不在当前 MVP 范围内。
