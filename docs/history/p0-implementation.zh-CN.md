# DocNexus P0 实现方案

更新日期：2026-07-18

## 目标

在不扩大 MVP 功能范围的前提下，使当前 `0.1.0` 具备可重复构建、可审计、可离线验证的公开发布基础。P0 只处理发布阻塞项：生产依赖安全、CI/发布门禁、真实本地模型端到端验证。

## 执行状态

- [x] 生产依赖安全：迁移到 `@huggingface/transformers` v3，生产及完整依赖审计均为 0 vulnerabilities。
- [x] CI 与发布门禁：Node 22/24 矩阵、生产依赖审计、构建/打包检查和实际 tarball 安装 smoke 已配置。
- [x] 真实 ONNX E2E：在禁止网络请求且不使用 hash/mock 的条件下，`init -> add -> recall -> MCP read/status` 已通过。
- [ ] 维护者发布元数据：LICENSE、公开仓库 URL、issue tracker 和 security contact 仍需项目所有者提供。

## 工作流 A：生产依赖安全

### 当前问题

- 生产依赖审计存在 critical/high 告警，主要集中在 Transformers/ONNX/protobuf 链路及部分传递依赖。
- 自动 `audit fix --force` 可能降级直接依赖或破坏本地模型功能，不作为解决方案。
- `package.json` 尚未明确声明支持的 Node.js 版本。

### 实现步骤

1. 记录 `npm audit --omit=dev` 基线，确认每个告警的直接来源和运行时可达性。
2. 优先采用兼容升级；兼容升级不可行时，再评估维护中的替代包或精确 override。
3. 每次依赖变更后验证真实 ONNX 加载、embedding 维度、LadybugDB 写入与 recall。
4. 更新 lockfile，声明满足 `node:sqlite` 和当前依赖要求的 `engines.node`。
5. 为 CI 增加生产依赖审计门槛；无法立即修复的告警必须有逐项风险说明和跟踪入口。

### 验收标准

- 不存在未处置的 production critical/high 告警。
- `npm ci`、测试、类型检查、构建和真实 embedding health check 全部通过。
- 依赖修复不启用远程模型下载，不改变 512 维 embedding 契约。

## 工作流 B：CI 与发布门禁

### 实现步骤

1. 建立 GitHub Actions，Node 矩阵以 `engines.node` 的最低支持版本和当前主要版本为准。
2. 每个变更运行 `npm ci`、测试、类型检查和构建。
3. 生成实际 npm tarball，并在隔离临时目录安装该 tarball。
4. 从安装产物验证：
   - `docnexus init`
   - `docnexus doctor`
   - `docnexus document add`
   - `docnexus recall`
   - README、skills、默认 models、当前 `docs/` 文档均在包内
5. CI smoke 可使用 hash embedder控制耗时；真实 ONNX 能力由工作流 C 单独覆盖。
6. 发布前检查包名、版本、bin 可执行权限、tarball 内容和生产依赖审计结果。

### 验收标准

- 全新环境只依赖 tarball 即可完成主流程，不读取仓库源码或仓库内 `node_modules`。
- 任一测试、构建、打包、安装或 smoke 失败都会阻止合并/发布。
- smoke 测试使用临时目录并可靠清理，不污染工作区。

## 工作流 C：真实 ONNX 端到端验证

### 实现步骤

1. 禁用 hash embedder 和 pipeline mock，直接加载随包 `BAAI/bge-small-zh-v1.5` 模型。
2. 在临时项目中执行 `init -> document add -> recall`。
3. 测试 metadata 至少包含一个实体，并断言 recall 返回命中文档、chunk 和实体图谱上下文。
4. 验证运行时配置为 local-only、远程加载关闭；测试不得依赖网络缓存下载。
5. 覆盖 MCP 的读取/状态契约，但避免依赖难以稳定关闭的长驻 stdio 子进程。

### 验收标准

- 冷启动和后续调用均能生成 512 维向量。
- 离线状态下 add/recall 成功，且结果包含预期文档和 graph context。
- 测试在失败和成功时都清理临时项目，不改变全局环境变量。

## 集成顺序

1. 合入依赖安全变更并锁定 Node 支持范围。
2. 在该依赖基线上运行真实 ONNX E2E。
3. 让 CI 矩阵和 tarball smoke 使用最终 `package.json`/lockfile。
4. 主分支执行完整发布验证：

```bash
npm ci
npm test
npm run typecheck
npm run build
npm audit --omit=dev
npm pack --dry-run
```

5. 同步 README、产品简报、当前路线图和本方案中的完成状态。

## 并行执行边界

- 依赖安全：拥有 `package.json`、`package-lock.json` 以及依赖迁移直接涉及的源代码。
- CI/发布门禁：拥有 `.github/workflows/`、tarball smoke 脚本和发布检查文档。
- 真实 E2E：拥有真实运行时测试及为可测试性必需的最小源代码改动。
- 主集成：处理冲突、补文档、执行全量验证，不覆盖其他执行线的有效结果。

## 外部决策项

LICENSE 类型和公开仓库 URL 属于项目所有者决策，不能从代码推断。若发布前仍未提供，这两项保持明确的发布阻塞状态，不自动填入占位或猜测值。
