# DocNexus 当前状态与实现路线图

更新日期：2026-07-18

## 当前定位

DocNexus 是面向 Codex、Claude 等编码智能体的本地项目记忆服务。当前版本以手动触发为边界：Skills 负责内容提炼与最终回答，CLI 负责文档写入、召回和维护，MCP 提供读取、metadata 校验与状态查询。系统不调用外部 LLM，默认 embedding 和图谱数据均保存在本地。

## 已实现基线

- npm 包 `@rowansenne/docnexus` 与 `docnexus` CLI。
- 每个项目独立的 `.docnexus/` 数据域，以及一次全局注册、每次显式传 `project_root` 的 MCP 服务。
- `init`、`doctor`、skills 安装、embedding 模型覆盖安装、文档新增/替换/删除、recall、索引重建、图谱审计/修复和 reset。
- `.docnexus/` 内的单版本托管 Markdown、已校验 extract 草稿包、当前 source/metadata sidecars、SQLite 文档/chunks 与 LadybugDB 图谱/向量状态。
- 随 npm 包发布并以 local-only 模式加载的 `BAAI/bge-small-zh-v1.5` 量化 ONNX 模型。
- 按 chunk 向量相关性排序、按文档归集、包含相邻 chunk 与一跳图谱证据的召回结果。
- 写入前 metadata 强校验：每份文档至少包含一个基于来源的实体，以保证图谱召回前提成立。
- 托管路径安全校验：逻辑目标必须是相对于 `.docnexus/` 的 Markdown 路径，实际路径不得越过该目录且不得包含符号链接；add、delete 和 reset 使用相同规则。
- 文件、SQLite 与 LadybugDB 变更失败时的补偿恢复，以及外部修改检测。

当前验证基线：19 个测试文件、104 个测试通过；类型检查和构建通过。

## 当前明确边界

- 不自动捕获对话，不监听文件变化。
- 不保留托管文档历史版本；替换和删除只维护当前状态。
- 不在 MCP 内调用 LLM 或生成最终答案。
- 不支持外部 embedding/LLM 供应商。
- 图谱上下文限定为受控的一跳证据，不提供任意深度图推理。
- `index rebuild` 只重建已登记的托管文档，不导入普通 Markdown 文件。

## 下一步实现优先级

### P0：技术门禁已完成，发布元数据待维护者确认

1. 依赖安全治理
   - 处理生产依赖审计中的 critical/high 告警，重点评估 Transformers/ONNX/protobuf 依赖链。
   - 不使用破坏功能的强制降级方案；升级、替换或明确隔离后重新执行生产依赖审计。
   - 验收：生产依赖无未处置的 critical/high 告警，或每项均有可复核的风险接受记录。
   - 状态：已完成。已迁移到 `@huggingface/transformers` v3，生产及完整依赖审计均为 0 vulnerabilities。

2. CI 与发布门禁
   - 增加受支持 Node.js 版本矩阵，运行 test、typecheck、build、`npm pack` 和安装后 CLI smoke test。
   - 在 `package.json` 声明 `engines`，补齐 LICENSE、repository、issue/security 联系信息和发布检查清单。
   - 验收：干净环境可从 tarball 完成 `init -> doctor -> add -> recall`，失败会阻止发布。
   - 状态：已完成。Node 22/24 CI、审计门禁和实际 tarball 安装 smoke 已配置；MIT License、公开 repository/issue 信息与安全联系邮箱均已补齐。

3. 真实运行时端到端测试
   - 使用随包 ONNX 模型，而不是 hash 或 mock pipeline，覆盖首次加载、中文/英文输入、文档写入和召回。
   - 覆盖 npm 全局安装或 tarball 安装后的 MCP 启动与 tool 调用。
   - 验收：离线环境下完整主流程稳定通过，且不会尝试网络下载模型。
   - 状态：已完成。真实 q8 ONNX E2E 覆盖 add、recall、图谱上下文和 MCP 读取，网络请求哨兵为零。

### P1：稳定性与规模能力

4. 崩溃一致性与并发控制
   - 为同一项目的写入、删除、重建和修复增加互斥锁或操作日志。
   - 启动或 doctor 时识别未完成操作，并给出可自动恢复的处理路径。
   - 验收：在文件、SQLite、LadybugDB 任一阶段模拟中断后，可恢复到一致状态。

5. 切块和输入边界
   - 超长段落必须继续按句子或 token 拆分，增加适量 overlap，并限制单文档大小和 chunk 数量。
   - 为中文、英文、Markdown 标题、代码块和无空行长文本增加测试。
   - 验收：任何合法输入都不会生成超过模型上限的 chunk，召回仍能保留必要上下文。

6. 图谱写入和向量索引性能
   - 避免每次单文档变更都重建整个向量索引；评估批量事务或增量维护能力。
   - 建立不同文档数、chunk 数下的写入、重建和 recall 基准。
   - 验收：规模增长时写入和召回延迟有明确预算，不出现非预期的全量工作。

### P2：检索质量与产品能力

7. 检索评估集
   - 建立真实项目 query、期望文档与引用的中英文评估集，跟踪 Recall@K、引用正确率和无结果行为。
   - 基于结果决定是否增加多语 embedding 模型或可配置模型方案。

8. 数据恢复能力
   - 评估软删除、版本快照、导出/导入与项目迁移，优先解决误删和跨机器恢复。

9. 扩展能力
   - 在核心稳定后再评估文件监听、自动捕获、更深多跳推理和外部模型供应商；这些能力不作为当前 MVP 发布门槛。

## 推荐执行顺序

维护者补齐发布元数据 -> 崩溃一致性 -> 切块边界 -> 索引性能 -> 检索评估 -> 恢复与扩展能力。

每一项都应先补能复现风险或定义成功标准的测试，再做最小实现，并在完成后同步 README、产品简报和本路线图。
