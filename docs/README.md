# DocNexus 文档中心

当前文档描述 0.16.0 的文本知识、持久化恢复、混合检索、事实生命周期与 skills 架构，以及新增的调用方显式分类、分类搜索/召回、投影版本、结构化出处、预算规划、ETag 轮询和扩展检索评估。版本变更见 [Changelog](../CHANGELOG.md#0160--2026-10-15)。检索投影采用 PGLite/Postgres＋pgvector，保留本地 embedding。

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
| 展示接口 | [全量/分页文档查询、分类与本地浏览页](./architecture/document-query.zh-CN.md) |

安装与日常命令见根目录 README。产品行为变更时同步当前文档，避免保留已被替代的实现说明。
