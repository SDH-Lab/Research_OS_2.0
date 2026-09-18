# 心智模型与权威关系

Research OS 是本地、文件化的研究控制平面，不是训练框架或中央数据库。它把每个项目分为三层：全局项目索引只帮助定位和切换；版本化 Shared Core 提供跨项目复用的 Schema、模板、规则和检查器；独立 Project Vault 保存该项目的事实与控制面。Shared Core 不保存某个项目的研究问题、实验或审稿数据，Project Vault 固定其 `core_version`，不能被 Core 的更新静默改变。

每次恢复工作都从同一条入口链开始：`AGENTS.md` → `PROJECT.md` → 唯一 Active ExecPlan → 当前相关领域记录 → 原始或生成证据。`AGENTS.md` 是短而稳定的入口和禁止事项；`PROJECT.md` 是身份、阶段、前台目标、Active Plan、资源注册和 canonical writing source 的唯一位置；Active ExecPlan 保存完成条件、范围、当前风险和阻断、尚未结束的后台工作及恢复点。检查点历史保存在 `plans/logs/`，计划只保留 `latest_checkpoint` 引用；不再重复保存目标与历史工作列表。

领域记录保存科学意图、验收、provenance、Evidence、Claim、Decision 和 Incident/Risk。`generated/` 的 Dashboard、索引、Base、日历、覆盖率、预测和检查报告都是派生视图：删除后必须能由 canonical records 重建，不能反过来修改或替代权威事实。任何摘要应链接回其 authority，而不是复制为第二套真相。

一份 canonical record 同时只能有一个当前写入者。多个 Session 可以读取，或在不重叠范围产生候选 Artifact；候选只有被当前前台写入者接收后才进入 authority。需要时，在 Active ExecPlan 中登记 owner、写入范围、交付物和接收条件。

人工决定科学语义、优先级、范围、实验有效性、Claim 边界、canonical writing source 和对外交付；Agent 可以起草、提取 Manifest、运行机械检查和生成候选视图。批准不是永久真理：新证据、范围变化、实现偏差、来源失效或下游检查失败可以使记录从 `closed` 变为 `reopened`。保留旧判断和 status history，并记录 reason 与 affected objects。

Action 的候选版本、必要检查、预算和授权保存在任务记录中。检查通过后停止，真实验收后关闭。已批准操作范围在会话之间沿用；范围改变才需要新的决定。产物可按文件版本单独验收，下游依赖该产物时无需等待生产任务整体关闭。
