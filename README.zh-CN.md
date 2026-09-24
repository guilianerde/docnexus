# DocNexus

[English README](./README.md)

DocNexus 是一款面向 Codex、Claude 等编码智能体的本地项目记忆服务。智能体先提炼用户选定的原始内容；DocNexus 再按项目路径保存一份当前托管 Markdown 文档，并召回带引用文件的结构化 Graph RAG 上下文。

本项目参考 [GitNexus](https://github.com/abhigyanpatwari/GitNexus) 的智能体工作流风格，当前聚焦手动触发、项目本地存储、项目内安装的 skills 与 CLI。

## 能力

- `docnexus-document-extract` 在 `.docnexus/drafts/` 下写入并校验 source/document/metadata 草稿包与完成 manifest，但不建立索引。
- `docnexus-document-add` 通过 CLI 新增或更新可召回的托管文档，覆盖前向用户确认。
- `docnexus-document-delete` 在用户确认后通过 CLI 物理删除托管文档。
- `docnexus-recall` 通过 CLI 检索归集后的上下文，并基于参考文件回答。
- CLI 提供项目初始化、运行诊断、skills 安装、文档变更、召回、索引维护、图谱审计/修复和 reset。
- 默认使用本地 embedding 模型 `BAAI/bge-small-zh-v1.5`，并以 local-only 模式加载。
- SQLite 保存当前托管文档/chunks，LadybugDB 保存当前图谱和向量状态。

DocNexus 不调用外部 LLM 提供商。提炼和最终回答始终由智能体完成。

## 架构与部署

每个项目在自己的目录中保存 skills、运行依赖、参考材料、草稿、产出、SQLite 数据库与 LadybugDB 图谱。无需 MCP 注册，也不安装用户级 skills。需要 Node.js 22.13.0 或更高版本及 npm。

```text
<project>/
  node_modules/@rowansenne/docnexus/   # 项目内 CLI 和随包模型
  .agents/skills/docnexus-*/          # Codex skills（按需）
  .claude/skills/docnexus-*/          # Claude skills（按需）
  .docnexus/                          # DocNexus 持久化数据
    drafts/                           # source、提炼文档、metadata、manifest
    index.sqlite                      # 文档与 chunk 账本
    store.lbug                        # 图谱与向量状态
    documents/                        # 当前 source 与 metadata sidecars
    models/                           # 可选的项目模型覆盖
```

在每个目标项目目录执行：

```bash
npm install --save-dev @rowansenne/docnexus
./node_modules/.bin/docnexus init
./node_modules/.bin/docnexus skills install --target codex
./node_modules/.bin/docnexus skills install --target claude
./node_modules/.bin/docnexus doctor
```

只安装实际使用的 skill 目标。已有 `.docnexus/` 项目保留原数据，安装项目本地依赖和 skills 即可，无需 reset。旧的全局 DocNexus MCP 注册需在智能体客户端配置中另行移除。

迁移前的评估与步骤见[项目 Skills 架构评估与迁移](./docs/architecture/project-skills-migration.zh-CN.md)。

## 文档与召回工作流

文档提炼与存储由用户手动触发：

1. `/docnexus-document-extract` 校验 metadata，并在唯一的 `.docnexus/drafts/<draft_id>/` 目录中写入 `source.md`、`document.md`、`metadata.json` 和完成标志 `manifest.json`。
2. 只有回读并验证全部四个文件后，提炼流程才会报告 `draft_created`；建议的托管 `file_path` 保存在 manifest 中。
3. `/docnexus-document-add` 调用 CLI 写入并建立索引；metadata 必须包含至少一个基于来源的实体；如果路径已托管，必须先询问用户确认后再传 `--replace`。
4. `/docnexus-document-delete` 在取得破坏性删除确认后调用 CLI 物理删除。

召回由用户手动触发：

```bash
./node_modules/.bin/docnexus recall "本地 embedding 和 LadybugDB 的关系" --limit 5
```

召回返回按向量相关性排序的 `results[]` 与按文档归集的 `context_groups[]`。每组通过当前 `document_id` 标识并引用其托管路径，可包含有界的邻近 chunks 与一跳图谱支持证据。metadata 和 graph context 是强依赖；每份写入文档必须声明至少一个实体，系统不会返回缺失这些内容的降级结果。

## CLI 命令

在已初始化的项目目录使用本地 CLI；文档输入文件必须位于项目内：

```bash
./node_modules/.bin/docnexus document add --file docs/memory/auth.md --source-file .docnexus/drafts/example/source.md --document-file .docnexus/drafts/example/document.md --metadata-file .docnexus/drafts/example/metadata.json
./node_modules/.bin/docnexus document add --file docs/memory/auth.md --source-file .docnexus/drafts/example/source.md --document-file .docnexus/drafts/example/document.md --metadata-file .docnexus/drafts/example/metadata.json --replace
./node_modules/.bin/docnexus doctor
./node_modules/.bin/docnexus metadata validate --file .docnexus/drafts/example/metadata.json
./node_modules/.bin/docnexus document list
./node_modules/.bin/docnexus document get --id <document_id> --include source,document,metadata
./node_modules/.bin/docnexus status
./node_modules/.bin/docnexus embeddings install --from models/BAAI/bge-small-zh-v1.5
./node_modules/.bin/docnexus embeddings install --from models/BAAI/bge-small-zh-v1.5 --replace
./node_modules/.bin/docnexus index status
./node_modules/.bin/docnexus index rebuild --force
./node_modules/.bin/docnexus graph audit
./node_modules/.bin/docnexus graph repair --force
./node_modules/.bin/docnexus recall "query" --limit 5
```

`index rebuild --force` 仅用于维护：它从已注册的当前托管文档及当前 sidecars 重建派生状态，不会导入未托管文件。

已有托管路径必须在用户确认覆盖后使用 `--replace`。在用户确认删除后，按路径或 ID 物理删除当前托管文档：

```bash
./node_modules/.bin/docnexus document delete --file docs/memory/auth.md --force
./node_modules/.bin/docnexus document delete --id doc_0000000000000000 --force
```

删除会移除 `.docnexus/` 内的托管 Markdown 文件、当前 sidecars、SQLite 行/chunks 以及 LadybugDB 文档/chunk 状态，不保留单文档删除记录。

重置 DocNexus 数据域：

```bash
./node_modules/.bin/docnexus reset --force
./node_modules/.bin/docnexus init
```

对于当前格式项目，reset 删除完整 `.docnexus/` 目录，其中包含所有已登记的托管目标文件。对于旧格式或无法读取的数据域，reset 同样只删除 `.docnexus/`。

为防止路径逃逸，文档新增、删除和当前格式 reset 都拒绝包含符号链接的托管目标路径，并以项目的 `.docnexus/` 目录为边界进行校验。

## 存储结构

```text
.docnexus/
  docs/memory/auth.md                # 当前托管 Markdown 示例（逻辑 file_path 不含 .docnexus/）
  drafts/
    <draft_id>/
      source.md                      # 提炼的来源产物
      document.md                    # 提炼后的 Markdown 产物
      metadata.json                  # 已校验的 metadata 产物
      manifest.json                  # 最后写入，标志草稿完整
  project.json                       # 格式版本标记
  index.sqlite                       # documents + file_chunks
  store.lbug                         # 当前图谱/向量状态
  models/                            # 可选的项目本地模型覆盖资产
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

DocNexus 会将 Transformers.js 配置为 `local_files_only`，并禁用远程模型加载。npm 包会包含 `models/BAAI/bge-small-zh-v1.5/` 下的量化 ONNX 模型资产，所以用户安装包时会同时下载默认模型。运行时 DocNexus 优先读取当前项目 `.docnexus/models/` 中的覆盖模型，再回退到包内 `models/` 目录。正常安装不需要执行 `./node_modules/.bin/docnexus embeddings install`。

如果需要覆盖随包模型，可将已准备好的 Transformers.js 本地模型目录安装到当前项目：

```bash
./node_modules/.bin/docnexus embeddings install --from models/BAAI/bge-small-zh-v1.5
```

来源目录必须包含 `config.json`、`tokenizer.json` 以及 q8 资产 `onnx/model_quantized.onnx`。覆盖已有项目模型必须显式传 `--replace`。

确定性测试可设置：

```bash
DOCNEXUS_EMBEDDER=hash npm test
```

`./node_modules/.bin/docnexus graph audit` 检查当前 SQLite 文档与 LadybugDB 状态的偏离。`./node_modules/.bin/docnexus graph repair --force` 删除陈旧图文档和孤立概念并重建向量索引。缺失或 chunk 数不一致的当前文档状态由 `./node_modules/.bin/docnexus index rebuild --force` 重建。

## 开发

```bash
npm install
npm test
npm run typecheck
npm run build
```

## 当前范围

已实现：

- Scoped npm 分发与逐项目初始化。
- 项目内安装的 skills 与 CLI，不依赖 MCP 注册。
- `./node_modules/.bin/docnexus doctor` 运行环境诊断。
- 项目本地 embedding 模型资产安装。
- Skills 驱动的提炼与对话召回。
- 单版本当前托管文档存储、物理删除和 reset。
- 本地 embeddings、LadybugDB 向量/图谱召回与归集 Graph RAG 上下文。
- CLI rebuild、图谱审计和图谱修复维护。

暂未实现：

- 自动捕获或文件监听。
- 外部模型供应商接入。
- CLI 内部生成最终答案。
- 更深层多跳图推理。

架构、产品说明、发布指南和后续优先级统一收录在[文档中心](./docs/README.md)，其中[当前路线图](./docs/roadmap/current.zh-CN.md)持续维护实现状态。
