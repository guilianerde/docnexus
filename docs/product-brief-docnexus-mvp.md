# DocNexus 产品说明（MVP）

DocNexus 是面向 Codex、Claude 等智能体的本地项目记忆服务。当前架构为：**Skills 负责内容提炼和对话回答，CLI 负责当前托管文档变更、召回与维护，MCP 提供读取、校验与状态 tools**。触发均由用户或智能体显式发起。

## 核心原则

- MCP 不调用 LLM；提炼后的 `document` 和 `metadata` 由 Agent/Skill 先生成。
- 一个项目相对 `file_path` 只对应一份当前托管文档。
- `docnexus document add` 在一次调用中创建或覆盖目标 Markdown，并立即更新 chunks、embedding 与图谱状态。
- 更新不保留历史版本，只保留当前 source 与 metadata sidecars。
- 更新已有托管路径时，skill 先获取用户确认，再由 CLI 显式传 `--replace`。
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

1. `/docnexus-document-extract` 提炼用户指定内容，生成 `source`、Markdown `document`、`metadata` 与建议路径，但不写入状态。
2. `/docnexus-document-add` 确定项目内相对路径 `file_path`，可调用 `validate_metadata`，随后运行 CLI 写入并同步建立召回状态；覆盖时必须确认并传 `--replace`。
4. 用户调用 `docnexus-recall`；skill 运行 `docnexus recall "<query>"`。
5. CLI 返回按相关性排序的 `results[]` 与按当前文档归集的 `context_groups[]`；Agent 使用 chunks 与受控图谱上下文回答并列出参考文件。
6. `/docnexus-document-delete` 在用户确认后运行 `docnexus document delete ... --force`。
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

DocNexus is a local project-memory service for agents such as Codex and Claude. The current architecture is: **Skills refine content and answer conversations; CLI mutates current managed documents and exposes recall and maintenance commands; MCP supplies read, validation, and status tools**. All workflows are explicitly triggered.

## Principles

- MCP does not invoke an LLM; the Agent/Skill produces refined `document` and `metadata` first.
- One project-relative `file_path` identifies one current managed document.
- One `docnexus document add` command creates or overwrites the target Markdown and immediately updates chunks, embeddings, and graph state.
- Updates retain no historical versions; only current source and metadata sidecars remain.
- Updating an existing managed path requires skill-side user confirmation and CLI `--replace`.
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

1. `/docnexus-document-extract` refines selected material into `source`, Markdown `document`, `metadata`, and a proposed path without persisting it.
2. `/docnexus-document-add` selects a project-relative `file_path`, may call `validate_metadata`, and runs CLI persistence; replacement requires confirmation and `--replace`.
4. The user invokes `docnexus-recall`; the skill runs `docnexus recall "<query>"`.
5. CLI returns relevance-ranked `results[]` and current-document `context_groups[]`; the Agent answers from chunks plus bounded graph context and cites files.
6. `/docnexus-document-delete` runs `docnexus document delete ... --force` only after user confirmation.
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
