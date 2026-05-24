# DocNexus 产品说明（MVP）

DocNexus 是面向 Codex、Claude 等智能体的本地项目记忆服务。当前架构为：**Skills 负责内容提炼和对话回答，MCP 负责当前托管文档存储及派生索引，CLI 提供召回与维护命令**。触发均由用户或智能体显式发起。

## 核心原则

- MCP 不调用 LLM；提炼后的 `document` 和 `metadata` 由 Agent/Skill 先生成。
- 一个项目相对 `file_path` 只对应一份当前托管文档。
- `archive_record` 在一次调用中创建或覆盖目标 Markdown，并立即更新 chunks、embedding 与图谱状态。
- 更新不保留历史版本，只保留当前 source 与 metadata sidecars。
- 删除是物理删除：移除目标 Markdown、sidecars、SQLite 当前状态/chunks 与 LadybugDB 派生状态。
- 不提供独立写入未托管文件索引的入口，也不提供旧格式迁移兼容层。

## 架构与隔离

- 分发包：`@docnexus/docnexus`，可执行命令为 `docnexus`。
- 初始化：每个项目运行 `docnexus init`，建立独立 `.docnexus/` 数据域。
- MCP：全局注册一份服务；每次 tool 调用通过绝对路径 `project_root` 指定项目。
- SQLite：`documents` 和 `file_chunks` 保存当前状态。
- LadybugDB：保存当前 Document / Chunk / Concept 图谱与向量召回状态。
- Embedding：默认在本地运行 `BAAI/bge-small-zh-v1.5`。

## 工作流

1. `docnexus-capture` 提炼用户指定内容，生成 `source`、Markdown `document` 和 `metadata`。
2. Skill 确定项目内相对路径 `file_path`，调用 `validate_metadata`。
3. Skill 调用 `archive_record`，MCP 将当前文档写到该路径并同步建立召回状态。
4. 用户调用 `docnexus-recall`；skill 运行 `docnexus recall "<query>"`。
5. CLI 返回按相关性排序的 `results[]` 与按当前文档归集的 `context_groups[]`；Agent 使用 chunks 与受控图谱上下文回答并列出参考文件。
6. 删除使用 `delete_document` 的 `confirm: true` 或 CLI `docnexus document delete ... --force`。
7. 运维使用 `docnexus index rebuild --force`、`docnexus graph audit`、`docnexus graph repair --force`；完整复位使用 `docnexus reset --force`。

## 数据结构

```text
<managed file_path>.md
.docnexus/
  project.json
  index.sqlite                 # documents + file_chunks
  store.lbug
  documents/<document_id>/
    source.md
    metadata.json
  schemas/metadata.schema.json
```

当前格式 reset 会删除登记过的托管目标文件与 `.docnexus/`。旧格式或损坏数据域 reset 只删除 `.docnexus/`，随后重新执行 `docnexus init`。

---

# DocNexus Product Brief (MVP)

DocNexus is a local project-memory service for agents such as Codex and Claude. The current architecture is: **Skills refine content and answer conversations; MCP persists current managed documents and derived retrieval state; CLI exposes recall and maintenance commands**. All workflows are explicitly triggered.

## Principles

- MCP does not invoke an LLM; the Agent/Skill produces refined `document` and `metadata` first.
- One project-relative `file_path` identifies one current managed document.
- One `archive_record` call creates or overwrites the target Markdown and immediately updates chunks, embeddings, and graph state.
- Updates retain no historical versions; only current source and metadata sidecars remain.
- Deletion physically removes the target Markdown, sidecars, SQLite current state/chunks, and LadybugDB-derived state.
- There is no entry point for independently ingesting unmanaged files and no compatibility migration layer for old stores.

## Architecture And Isolation

- Package: `@docnexus/docnexus`, executable `docnexus`.
- Initialization: each project runs `docnexus init` to create an isolated `.docnexus/` data domain.
- MCP: register one global service; every tool call selects an initialized project through absolute `project_root`.
- SQLite: current `documents` and `file_chunks` state.
- LadybugDB: current Document / Chunk / Concept graph and vector recall state.
- Embeddings: local `BAAI/bge-small-zh-v1.5` by default.

## Workflow

1. `docnexus-capture` refines selected material into `source`, Markdown `document`, and `metadata`.
2. The skill selects a project-relative `file_path` and calls `validate_metadata`.
3. The skill calls `archive_record`; MCP writes the current document at that path and builds recall state in the same operation.
4. The user invokes `docnexus-recall`; the skill runs `docnexus recall "<query>"`.
5. CLI returns relevance-ranked `results[]` and current-document `context_groups[]`; the Agent answers from chunks plus bounded graph context and cites files.
6. Deletion uses MCP `delete_document` with `confirm: true`, or CLI `docnexus document delete ... --force`.
7. Maintenance uses `docnexus index rebuild --force`, `docnexus graph audit`, and `docnexus graph repair --force`; full recovery uses `docnexus reset --force`.

## Storage

```text
<managed file_path>.md
.docnexus/
  project.json
  index.sqlite                 # documents + file_chunks
  store.lbug
  documents/<document_id>/
    source.md
    metadata.json
  schemas/metadata.schema.json
```

Reset on the current format removes registered managed target files and `.docnexus/`. Reset on old or damaged state removes `.docnexus/` only; then initialize again with `docnexus init`.
