# DocNexus 文档中心

这里集中维护 DocNexus 的当前产品、架构、路线图与发布文档。首次了解项目建议按以下顺序阅读：

1. [产品说明（中文）](./product/mvp.zh-CN.md)：了解产品定位、使用边界和主要工作流。
2. [当前架构](./architecture/overview.zh-CN.md)：了解组件关系、数据存储和写入/召回流程。
3. [项目 Skills 迁移](./architecture/project-skills-migration.zh-CN.md)：了解改造边界、代价与旧项目迁移步骤。
4. [当前路线图](./roadmap/current.zh-CN.md)：查看已实现能力和下一步优先级。
5. [发布检查清单](./operations/release-checklist.md)：执行发布前验证。

## 按主题浏览

| 主题 | 文档 | 状态 |
| --- | --- | --- |
| 产品 | [MVP 产品说明（中文）](./product/mvp.zh-CN.md) | 当前 |
| Product | [MVP Product Brief (English)](./product/mvp.en.md) | Current |
| 架构 | [整体架构与数据流](./architecture/overview.zh-CN.md) | 当前 |
| 迁移 | [项目 Skills 架构评估与迁移](./architecture/project-skills-migration.zh-CN.md) | 当前 |
| 规划 | [当前状态与实现路线图](./roadmap/current.zh-CN.md) | 当前 |
| 运维 | [Release Checklist](./operations/release-checklist.md) | 当前 |
| 历史 | [历史设计与实施记录](./history/README.md) | 归档 |

## 维护约定

- 根目录 `README.md` 和 `README.zh-CN.md` 面向安装与日常使用；详细说明放在本目录。
- 当前文档按主题归类，中文文件使用 `.zh-CN.md`，英文文件使用 `.en.md`。
- 已完成或被取代的方案移入 `history/`，不再作为当前行为依据。
- 产品行为变更时，至少同步产品说明、架构说明和路线图中受影响的部分。
