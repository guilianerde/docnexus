# DocNexus 文档中心

当前文档描述工作区格式 7 的架构：`.docnexus/` 程序文件与可配置的知识输出目录分离，`init --output-dir` 指定知识工作区，npm postinstall 清理识别出的旧格式安装；精炼正文限 4000 Unicode 字符并由智能体语义拆分；可选原生 Git hooks 接入普通 merge，持久化冲突、自动重建受影响记录并按提交范围校验知识；`CONCEPTS.md` 为不超过 3 KB 的分类路由表，分类文件不超过 32 KB，另有可编辑的 `categories.md` 建议清单。文本知识、持久化恢复、混合检索、事实生命周期、可选独立知识 Git 仓库与 skills 编排等既有设计不变；检索投影采用 PGLite/Postgres＋pgvector，保留本地 embedding。版本变更见 [Changelog](../CHANGELOG.md#0260--2026-10-22)。

| 主题 | 文档 |
| --- | --- |
| 产品 | [中文产品说明](./product/mvp.zh-CN.md) / [English Product Brief](./product/mvp.en.md) |
| 架构 | [文本存储、时间线与查找](./architecture/overview.zh-CN.md) |
| 检索链路 | [投影版本、结构化命中出处与预算规划](./architecture/retrieval-pipeline.zh-CN.md) |
| 编排 | [Skills 工作区与功能编排](./architecture/skills-workspace.zh-CN.md) |
| 分类接入 | [调用方显式分类参数与封存契约](./operations/agent-protocol.zh-CN.md#调用方显式分类) |
| 规划 | [当前状态与路线图](./roadmap/current.zh-CN.md) |
| 发布 | [Release Checklist](./operations/release-checklist.md) |
| 评估 | [Retrieval Evaluation](./operations/retrieval-evaluation.md) |
| 质量基线 | [开发集、保留集与首次结果](./operations/retrieval-evaluation.md#source-based-quality-baseline) |
| 知识维护评估 | [真实文档回放与模型审阅任务](./operations/knowledge-evaluation.zh-CN.md) |
| 智能体协议 | [结构化错误与诊断契约](./operations/agent-protocol.zh-CN.md) |
| 证据交付 | [范围、预算、事实与时间](./architecture/evidence-delivery.zh-CN.md) |
| 智能体验收 | [独立上下文、调用观测与结果审阅](./operations/agent-evaluation.zh-CN.md) |
| 验收记录 | [各轮回归、实测数字与结论边界](./operations/validation-history.zh-CN.md) |
| 影响清单 | [持久化、待办续办与复核状态](../skills/docnexus-library/references/impacts.md) |
| Git 合并 | [原生钩子、冲突持久化与自动修复](../skills/docnexus-library/references/git-merge.md) |
| 使用观察 | [本地记录、匿名指标、显式反馈与单文件导出](./operations/usage-observation.zh-CN.md) |
| 展示接口 | [全量/分页文档查询、分类与本地浏览页](./architecture/document-query.zh-CN.md) |

安装与日常命令见根目录 README。产品行为变更时同步当前文档，避免保留已被替代的实现说明。
