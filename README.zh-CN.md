# DocNexus

[English README](./README.md)

DocNexus 是一款面向 Codex、Claude 等编码智能体的本地项目记忆工具，以 **skills 为唯一交互入口**。智能体提炼用户选定的内容；DocNexus 把它保存为项目 `docnexus/` 工作区中的托管 Markdown，并召回带引用文件的 Graph RAG 上下文。

本项目参考 [GitNexus](https://github.com/abhigyanpatwari/GitNexus) 的智能体工作流风格，聚焦手动触发与项目本地存储。

> 0.4.0 是破坏性更新：数据目录由 `.docnexus/` 改为 `docnexus/`，skills 重新编排，不兼容旧项目。见[Skills 工作区与功能编排](./docs/architecture/skills-workspace.zh-CN.md#4-破坏性变更与升级)。

## 快速开始

需要 Node.js 22.13.0 或更高版本及 npm。在目标项目根目录执行：

```bash
npm install --save-dev @rowansenne/docnexus
./node_modules/.bin/docnexus init --agent claude   # 或 --agent codex / --agent all
./node_modules/.bin/docnexus doctor
```

然后在智能体中使用 `/docnexus`：“记住这段设计说明”“DocNexus 里关于鉴权的结论是什么”“列出 DocNexus 文档”。

## 工作区

`init` 在项目中建立 `docnexus/`，DocNexus 的 skills、草稿、产出与派生数据全部位于其中：

```text
docnexus/
  project.json          # 格式标记
  skills/               # 项目 skills（唯一真源）
  drafts/<draft_id>/    # 提炼草稿：source.md、document.md、metadata.json、manifest.json
  library/              # 托管文档（可读产出）
  schemas/              # metadata.schema.json
  store/                # index.sqlite、graph.lbug、sidecars、可选 models/
```

`--agent` 会在 `.claude/skills/` 或 `.agents/skills/` 中创建指向 `docnexus/skills/` 的链接，这是工作区之外唯一的 DocNexus 条目。

## Skills 编排

| Skill | 何时使用 |
| --- | --- |
| `docnexus` | 入口：预检、按意图路由、串联捕获流水线 |
| `docnexus-extract` | 把原始内容提炼为草稿并封存 |
| `docnexus-ingest` | 把已封存草稿写入 library 并建立索引 |
| `docnexus-recall` | 基于召回上下文回答并引用 `docnexus/library/` 文件 |
| `docnexus-library` | 列出/查看/删除文档，查看/丢弃草稿 |
| `docnexus-maintain` | 诊断、修复、重建、重置 |

“记住”类请求走捕获流水线：

1. **提炼**：`draft new` 分配草稿目录 → 智能体写三个产物 → `draft seal` 校验 metadata、记录哈希并写 manifest。
2. **审阅**：向用户展示 `file_path`、标题与实体。
3. **入库**：`document add --draft <id>`；路径已托管时先确认，再加 `--replace`。
4. **报告**：返回 `id`、`library_path` 与 chunk 数；草稿标记为 `ingested`。

所有破坏性操作（`--replace`、删除、丢弃草稿、重建、修复、reset）都需要本次对话中的明确确认。详见[Skills 工作区与功能编排](./docs/architecture/skills-workspace.zh-CN.md)。

DocNexus 不调用外部 LLM；提炼与最终回答始终由智能体完成。

## CLI 命令

skills 调用项目内 CLI；输入文件必须位于项目内。

```bash
# 设置
./node_modules/.bin/docnexus init [--agent claude|codex|all]
./node_modules/.bin/docnexus skills sync
./node_modules/.bin/docnexus skills link --target claude|codex|all
./node_modules/.bin/docnexus doctor
./node_modules/.bin/docnexus status

# 捕获
./node_modules/.bin/docnexus draft new --slug auth
./node_modules/.bin/docnexus metadata validate --file docnexus/drafts/<draft_id>/metadata.json
./node_modules/.bin/docnexus draft seal --id <draft_id> --file auth/token-rotation.md
./node_modules/.bin/docnexus document add --draft <draft_id> [--replace]
./node_modules/.bin/docnexus draft list [--status open|ready|ingested|invalid]
./node_modules/.bin/docnexus draft discard --id <draft_id> --force

# 召回
./node_modules/.bin/docnexus recall "本地 embedding 和 LadybugDB 的关系" --limit 5

# Library
./node_modules/.bin/docnexus document list [--limit 50] [--tag tag]
./node_modules/.bin/docnexus document get --id <document_id> --include source,document,metadata
./node_modules/.bin/docnexus document delete --file auth/token-rotation.md --force
./node_modules/.bin/docnexus document delete --id doc_0000000000000000 --force

# 维护
./node_modules/.bin/docnexus index status
./node_modules/.bin/docnexus index rebuild --force
./node_modules/.bin/docnexus graph audit
./node_modules/.bin/docnexus graph repair --force
./node_modules/.bin/docnexus embeddings install --from <model_dir> [--replace]
./node_modules/.bin/docnexus reset --force
```

- `file_path` 是相对 `docnexus/library/` 的 Markdown 路径；一个路径只对应一份当前文档，更新原位覆盖，不保留历史。
- 召回返回按向量相关性排序的 `results[]` 与按文档归集的 `context_groups[]`（邻近 chunks 与一跳图谱证据）。每份文档必须声明至少一个实体，召回不提供降级结果。
- `index rebuild --force` 只重建已登记的托管文档，不导入未托管文件。
- 删除会移除 library 文件、sidecars、SQLite 行/chunks 与 LadybugDB 状态。
- `reset --force` 删除整个 `docnexus/` 及指向它的 skill 链接；缺少 DocNexus 标记的同名目录会被拒绝。
- 托管路径、草稿目录都拒绝符号链接，防止越过 `docnexus/` 边界。

## Embeddings

默认本地模型 `BAAI/bge-small-zh-v1.5`，以 `local_files_only` 模式加载并禁用远程下载。量化 ONNX 资产随 npm 包发布；运行时先读 `docnexus/store/models/` 中的项目覆盖，再回退到包内 `models/`。覆盖模型需包含 `config.json`、`tokenizer.json` 与 `onnx/model_quantized.onnx`。

确定性测试：

```bash
DOCNEXUS_EMBEDDER=hash npm test
```

## 开发

```bash
npm install
npm test
npm run typecheck
npm run build
```

## 当前范围

已实现：项目内 `docnexus/` 工作区；入口编排 skill 与 5 个工作流 skill；CLI 管理的草稿封存与入库；单版本托管文档、物理删除与 reset；本地 embeddings、LadybugDB 向量/图谱召回与归集上下文；doctor、重建、图谱审计与修复。

暂未实现：自动捕获或文件监听、外部模型供应商、CLI 内生成答案、更深层多跳图推理。

架构、产品说明、发布指南与路线图见[文档中心](./docs/README.md)。
