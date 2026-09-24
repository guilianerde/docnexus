# 项目 Skills 架构评估与迁移

## 评估

原架构的 SQLite、LadybugDB、草稿、托管文档和 sidecars 已在项目的 `.docnexus/` 内，数据格式无需迁移。跨项目依赖来自全局 MCP 注册、可选的用户级 skills 和全局 CLI 安装示例。提炼 skill 的 metadata 校验依赖 MCP；原 CLI 缺少文档列表、按 ID 读取和状态查询。

本次改造以项目目录为持久化边界：项目内 npm 依赖提供 CLI 和默认模型；`.agents/skills/` 或 `.claude/skills/` 提供项目 skills；`.docnexus/` 保存所有 DocNexus 数据和草稿。CLI 读取的文档输入、metadata 文件和模型导入源必须解析到当前项目目录内。CLI 支持读、校验、写、召回和维护，MCP 服务与用户级 skills 安装入口已移除。

代价是每个项目需安装一次 npm 依赖，模型与依赖会按项目占用磁盘。`.docnexus/` 和 `node_modules/` 通常不提交到 Git；仅克隆仓库不会恢复记忆数据或运行依赖。若需跨机器复制记忆，应连同 `.docnexus/` 备份，并在目标机器执行 `npm ci`。项目移动到新路径后，LadybugDB 的 Project 节点可能保留旧绝对路径；执行 `./node_modules/.bin/docnexus index rebuild --force` 可刷新它。

## 现有项目迁移

1. 备份整个项目目录，尤其是 `.docnexus/`；无需删除或重建现有数据库。
2. 在项目根目录运行 `npm install --save-dev @rowansenne/docnexus`，再运行 `./node_modules/.bin/docnexus skills install --target codex` 或 `--target claude`。
3. 将旧用户级 skill 目录与旧 MCP 注册从各自客户端配置中移除，以免智能体调用旧入口。该步骤不由 DocNexus 自动修改用户级配置。
4. 在项目目录执行 `./node_modules/.bin/docnexus doctor`、`./node_modules/.bin/docnexus status` 和 `./node_modules/.bin/docnexus index status`，确认现有文档数与数据库健康状态。
5. 后续提炼、校验、写入和召回使用项目 skills 和项目内 CLI；参考文件与草稿放在项目内。

`reset --force` 会删除项目记忆数据，不属于迁移步骤。
