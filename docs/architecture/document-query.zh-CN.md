# 文档展示查询接口

唯一维护入口仍是文本：事实定义在所属文档的 `metadata.facts`，人工正文与事实 ID 引用保存在 library Markdown。数据库、生成块和查询结果均为派生表达。

编排层在提炼或更新文档时判断一项主分类，写入同一份 metadata 的可选 `category` 与 `category_reason`，项目分类名由大模型结合上下文决定，不限固定枚举。查询脚本只读源数据、生成当前展示结果，不保存第二份文档库、不调用 LLM 或 embedding，也不要求 PGLite/Postgres 检索存储存在。

## 调用

项目已初始化并安装对应版本的 DocNexus 后，从项目目录执行：

```bash
./node_modules/.bin/docnexus document query --all
./node_modules/.bin/docnexus document query --page 1 --page-size 20
./node_modules/.bin/docnexus document query --category architecture --page 1 --page-size 20
```

编排层提供的独立接口脚本使用相同参数，委托项目内安装的 CLI：

```bash
node docnexus/skills/docnexus-library/scripts/query-documents.mjs --all
node docnexus/skills/docnexus-library/scripts/query-documents.mjs --page 1 --page-size 20
node /path/to/query-documents.mjs --project-root /path/to/project --category guide --all
```

成功时 stdout 是一个 JSON 对象；失败时 stderr 给出错误，进程以非零状态退出。路径、源文件完整性、项目隔离和恢复锁沿用 CLI 规则。

Node 编排或可视化后端也可以直接调用：

```javascript
import { queryDocuments } from '@rowansenne/docnexus/dist/src/document-query.js';

const first = await queryDocuments(projectRoot, { page: 1, page_size: 20 });
const second = await queryDocuments(projectRoot, {
  page: 2,
  page_size: 20,
  revision: first.revision
});
```

## 本地只读浏览页

```bash
./node_modules/.bin/docnexus view
./node_modules/.bin/docnexus --project-root /path/to/project view --port 4317
```

命令启动固定项目的本地服务，仅绑定 `127.0.0.1`。默认自动选择空闲端口，打开终端输出的 URL；Ctrl+C 停止服务。目标项目必须先初始化，不会自动导入当前仓库文件。

浏览页展示实际分类及计数、10/20/50 篇分页列表、完整当前正文、分类依据、标签和事实来源/生命周期状态。分类由 skills 中的模型维护；浏览操作不触发重分类。页面可见时每 15 秒检查一次更新，重新切回页面或点击刷新也会检查。后续查询携带 revision，返回 409 时丢弃旧页并重新读取第一页；所选分类被合并、改名或删除时回到全部文档。读取失败时清除正文，显示错误与重试提示。事实面板保留历史状态，只有“有效”条目代表当前有效事实。

HTTP `GET /api/documents` 接收 `all=true`、`page`、`page_size`、`category`、`revision`，参数和查询接口一致；返回原查询对象，各文档增加 `html` 字段用于浏览。参数错误为 400，旧 revision 为 409，源文本不可用为 503。这个 HTTP 接口面向本地浏览页；其他编排调用继续使用 CLI/Node 查询契约。

服务不保持长期项目锁，每次查询独立获取锁，其他已授权写入可以同时继续。没有新的源数据或后台模型服务，不写入分类、正文或索引；项目锁仍沿用已有中断恢复机制。请求只支持 GET/HEAD，拒绝其他方法、跨源和非本机 Host，不开放 CORS，也不提供任意文件读取。HTML/JS/CSS 与 Markdown 依赖随 npm 包分发，无 CDN 或远程字体。

Markdown 禁用原始 HTML，只将 HTTP/HTTPS 链接显示为可点击外链；相对路径链接显示文本，图片显示替代文字而不自动加载。支持标题、列表、代码块和表格，不执行脚本、内嵌 HTML 或 Mermaid。页面另设严格 CSP 与禁止缓存的响应头。

分页仍需扫描并校验整个文本源；15 秒轮询不是文件监听或推送。大型知识库的查询增量化和性能测量留待后续验证。

## 返回约定

| 字段 | 含义 |
| --- | --- |
| `schema_version` | 当前接口结构版本为 1 |
| `project_root` | 查询所属项目的真实路径 |
| `generated_at` | 这次正文和事实状态使用的 UTC 时间快照 |
| `revision` | 文本、分类与有效事实状态对应的 SHA-256 快照标识 |
| `total_documents` | 项目全部托管文档数量 |
| `total` | 分类筛选后的文档数量 |
| `categories[]` | 实际使用的分类 id、展示 label 和项目级 count；空分类不保留 |
| `pagination` | 分页状态；全量查询为 null |
| `documents[]` | 当前页或全部匹配文档的完整展示内容 |

每份文档返回 `id`、用于更新草稿 `--base-version` 的 `record_version`、路径、标题、摘要、分类、判断依据与标签、创建/更新时间，以及完整 Markdown `document`、已解析 `fact_references` 和带状态的 `facts`。可视化端可直接按 category 展示目录和筛选，再渲染 document。历史事实应显示其状态，不能把 inactive 事实作为当前结论。

正文使用本次时间快照重新解析事实引用。即使磁盘上的生成块还是旧快照，接口也返回当前有效的表达；查询本身不写回 library、来源、时间线或检索存储。Markdown 是展示数据，前端应禁用未处理的原始 HTML，或通过自己的消毒策略渲染。

默认 page 为 1、page_size 为 20，最大 page_size 为 100。`--all` 不能与分页参数并用。文档按 file_path 升序排列；空结果或越界页返回空数组，has_more 为 false。当前分页限制返回数据量与正文渲染量，完整性与快照校验仍会扫描全量文本。每次请求只读取一次各真源资产，并固定一个事实解析时间；revision 由完整 records 的哈希字段和事实状态生成，包含正文与生成表达的全部依赖，随后仅渲染当前页。

## 写入后的刷新与分页一致性

1. 编排层完成 `document add`、`document sync`、`document classify` 或 `document delete`。
2. 可视化端重新查询第一页或全量结果，并更新分类计数。
3. 继续翻页时同时传回 revision 和相同筛选条件。
4. 若期间有写入、重新分类、删除，或事实生效/到期/撤回改变展示结果，则旧 revision 被拒绝；丢弃已积累的页并重新查询第一页。

Node 异常的 code 为 `document_revision_changed`，current_revision 给出新版本；CLI/script 的错误消息含同一错误码。未传 revision 时，每次请求均读取最新快照。接口不保存历史快照用于回读。

## 模型驱动的动态分类

分类名由项目定义，长度为 1–80 字符，不能有首尾空白或控制字符。一份文档选择一项主分类，跨主题关联使用 tags。大模型先阅读项目 README/相关指引、query 返回的现有分类及相关文档；优先复用已有 id，在语义不匹配时创建有意义的新名称，并记录最多 2000 字符的 category_reason。

例如，项目可以使用“接口契约”“部署与运维”“用户研究”等分类。旧的 architecture、guide 等 id 仍保留中文显示名，仅为兼容；它们不是枚举约束。未设分类的文档显示 uncategorized。空项目的 categories 为空，分类计数只展示实际使用的名称。

项目方向、新知识或文档用途变化时，模型可以复核相关文档。分类重命名、合并或拆分通过修改受影响文档的 category 实现，文件和事实不必移动、复制或删除：

```bash
./node_modules/.bin/docnexus document classify --id <document_id> \
  --category "接口契约" \
  --reason "结合项目 API 规范与已有端点文档，本文定义请求响应约定" \
  --revision <query_revision>
```

该命令只更新分类和依据、record 的 metadata/timeline 哈希及更新时间，追加新旧分类与依据到时间线。来源、正文、事实、别名和关系保持不变；相同分类与依据为 no-op。普通提炼/更新同样记录分类变化与依据。连续调整多份文档时，每次写入后获取新 revision；过时上下文被拒绝后重新判断。

分类由执行 skills 的模型完成，使用既有提炼/更新/分类维护授权；查询脚本只读，不调用模型或自动修改分类。已有授权涵盖时无需反复询问。没有后台分类守护进程，也没有另一套分类真源。编排步骤见 [分类工作流](../../skills/docnexus-library/references/classification.md)。
