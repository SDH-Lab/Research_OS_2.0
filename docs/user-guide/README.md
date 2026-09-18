---
core_version: 2.0.0
---
# Research OS 2.0.0 使用指南

本指南描述 Core 2.0.0 的真实命令和权威边界。项目事实只写入 Project Vault；Shared Core 提供规则和工具，不保存项目数据。

## 三条阅读路径

- 第一次使用：依次阅读 [01 安装与第一个项目](01-installation-and-first-project.md)、[02 心智模型](02-mental-model-and-authority.md)、[03 目录与记录](03-layout-records-and-links.md)。
- 日常研究：从 [04 日常、每周与中断](04-daily-weekly-and-disruption.md)、[05 Session 与 Agent](05-sessions-agents-and-handoffs.md) 开始，再按工作进入 [06 实验](06-experiment-workflow.md)、[07 写作](07-writing-and-response.md)、[09 Dashboard](09-dashboard-and-forecast.md)。
- 维护与升级：阅读 [08 Validation](08-validation-and-human-gates.md)、[10 维护与恢复](10-maintenance-troubleshooting-and-backup.md)、[11 Core 升级](11-core-upgrades-and-migrations.md) 和 [12 CLI/Schema 参考](12-cli-and-schema-reference.md)。可执行例子在 [13 Recipes](13-recipes.md)。

## 能力交付与最短启动链

Research OS 同时交付 CLI、Shared Core 和名为 `$research-os` 的 Codex Skill。Skill 不是插件；未来可以由插件打包，但当前直接安装 Skill。创建 Vault 后，它仍是**未配置骨架**：必须完成 `project setup-status` 所列的人类审核，不能把初始化成功理解为科学目标、资源或权限已经获批。

进入项目时按 `AGENTS.md → $research-os → doctor → project setup-status → session context` 恢复。随后只读取命令返回的 authority sources 与当前 Action 必需文件；修改 authority 后运行 `research-os record validate --project ./demo`，需要视图时再运行 `research-os view build --project ./demo`。启动只恢复当前工作所需 authority；执行历史保留在任务和检查点日志中，按需读取。2.0.0 使用新的计划与 Action 格式，不提供旧格式兼容层或自动迁移。
