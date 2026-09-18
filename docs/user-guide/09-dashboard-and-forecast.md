# Dashboard、Exception Inbox 与三档预测

本章说明如何把 canonical records 变成可删除、可重建、可下钻的项目视图。生成器不读取旧聊天、Git 活动、机器当前时间或旧 `generated/forecast.json`。它只读取已经通过 `record validate` 的项目 authority；因此同一 authority 连续 build，或 clean 后 rebuild，五个输出都应逐字节一致。

## 五个生成文件

```text
generated/
├── dashboard.md
├── exception-inbox.md
├── coverage.md
├── forecast.json
└── generation-manifest.json
```

- `dashboard.md`：唯一前台目标、exact next action、剩余 Action、在制任务、阻塞、handoff、重开、Scope 增量和三档日期。
- `exception-inbox.md`：需要人判断或下钻的差异；它不是新的任务清单 authority。
- `coverage.md`：启用 reviews 模块时显示 reviewer Concern coverage；未启用时明确为 `not_applicable`。
- `forecast.json`：给 Agent 或其他工具使用的稳定结构化预测。
- `generation-manifest.json`：列出五个已知输出、四个非 manifest 输出各自的 sha256、排序后的 canonical 输入 sha256、Core 版本和整体 source digest；不保存自身 hash。

任何摘要项都带 project-relative canonical path。要改结论，进入链接的原始记录修改并验证，再 build；不要直接维护生成文件。

## 固定命令

```bash
research-os record validate --project ./demo
research-os view build --project ./demo
research-os view show --project ./demo --name dashboard
research-os view show --project ./demo --name exception-inbox
research-os forecast calculate --project ./demo
research-os view clean --project ./demo
```

`view show` 只接受 `dashboard`、`exception-inbox`、`coverage`、`forecast`、`manifest`。读取视图时会验证完整 manifest、所选输出的 sha256，并在读取后复读 manifest；manifest 不存在、无效、读取期间变化，或目标 hash 不匹配时，命令都拒绝返回。`view clean` 先完整验证 manifest、全部目标和四个目标 hash，之后只删除 manifest 精确列出的五个 regular files，manifest 最后删除；它拒绝多余路径、目录、symlink、缺失文件和被篡改的 input/digest/output hash，并保留 `generated/` 下未登记的个人文件。若 authority validation 失败，`view build` 与 `forecast calculate` 返回 exit 3，build 在写入前停止。

`view build` 是以 manifest 为 terminal commit point 的五文件事务：先预检 `generated/` 和五个目标，并把旧五文件原始 bytes 保存于内存，只允许目标“缺失或 regular file”；随后写私有 staging files 并重扫 canonical inputs。发布前直接删除旧 manifest，使旧 generation 立即不可被 `view show` 接受；不创建需要稍后清理的 backup path。再发布四个带 hash 的视图，最后重扫 authority，原子发布新 manifest。新 manifest 出现才表示整代输出已经 commit；rename 之后没有可能触发 rollback 的文件系统清理，函数直接返回。commit 前任一步失败都由内存 originals 恢复旧五文件的精确 bytes，并清理 stage/rollback 文件。这样在构建窗口内，消费者只会得到旧代、新代或明确拒绝，不会接受混合代和随后被 rollback 的未提交代。

生成视图不持有跨进程写锁；最终 authority 重扫与 manifest 原子 rename 之间仍有一个极短的 residual mutation window。因此同一 Vault 的 canonical authority 和 generated transaction 必须遵守外层单写者规则：一个时刻只允许一个写入者；读者一律使用 `view show`，不要绕过 manifest 直接读取生成文件。

canonical snapshot 与 record catalog 共用同一内部目录排除规则：`.agents/`、`.codex/`、`.git/`、`.obsidian/`、`.superpowers/`、`.tmp/`、`generated/`、`node_modules/` 都是工具状态、harness 状态或派生输出，不是项目 authority。修改这些目录不会改变 `sourceDigest`；修改 `AGENTS.md`、`PROJECT.md`、Active Plan 或领域 records 会改变 digest。

## Action 为什么是唯一计数单位

Action 回答“下一件可验收工作是什么”，所以排程、剩余量和吞吐只数 canonical `type: action`。Run 说明一次真实执行，Result/Evidence 说明证据状态，Claim/Writing 说明科学和文字交付；把这些对象与 Action 相加会把同一工作链重复计数。Dashboard 即使发现一百个 Run，也不会把它们当作一百个排程单位。

Action 的两个预测字段必须人工确认或保留 sentinel：

| 字段 | 固定值 | 含义 |
| --- | --- | --- |
| `domain` | `experiment` / `analysis` / `writing` / `coordination` / `unclassified` | 让实验与写作分别校准，不把不同性质的关闭速度混在一起 |
| `size` | `small` / `medium` / `large` / `unestimated` | 相对大小；权重依次为 1 / 2 / 4 / 2 fallback |

`unclassified` 和 `unestimated` 会进入 Exception Inbox 并降低置信度。fallback 只是为了让计算不中断，不表示 Agent 已经替人估算。

## Dashboard 指标逐项解释

- **Remaining Actions / by domain / by size：**当前仍在计划内的 Action；已关闭、取消、替代及推迟的任务不计入当前剩余量。
- **In-progress Actions：**状态为 `in_progress`、`review`、`verified` 或 `reopened` 的 Action。`ready` 尚未开始，不计入在制任务数。
- **Blocker age：**只计算 `blockers.status: active`，从 `since` 到 `forecast_settings.as_of`，按项目 timezone 的日历日计算；resolved blocker 保留历史但不继续增长；未知 since 明确显示未知，不推断持续时间。
- **Closure velocity：**每个当前仍为 `closed` 的 Action只按最近一次有效 closed transition 计一次；重开且尚未重新关闭的 Action不算当前完成。完整 ISO 周从周一开始，零关闭周也进入分母。观察期从“最早相关 Action 创建周之后的第一个周一”开始：包含创建时刻的周永远不计入，即使 Action 恰好在周一创建；因此切换到 observed 前一定实际暴露过三个完整周。
- **Reopen：**来自 `closed -> reopened` 的真实 status history，不是只检查当前 status。rate 是 reopen transitions 除以曾经关闭过的 Action 数。
- **Current-week Scope additions：**本周创建的 Action；它提示日期变晚是否由新增或进一步拆分的 Scope 导致。
- **Result Acceptance → Evidence handoff：**`adopted`、`excluded`、`credible_negative`、`uncertain` 的 closed Result 都需要 closed Evidence Packet。只有 `Evidence.sources` 显式包含 Result ID 才算连接。参与 handoff 的 Result/Evidence 必须处于各自 canonical path，通过注册 schema 和完整 lifecycle validation；公共 API 也不会信任 archive 或最小伪造对象。计时使用当前生命周期中最新的有效 `to: closed` transition，不使用可能滞后的 `verified_at`。open packet、缺 packet、多个 closed packet、缺时间或负时间线都保持 pending，不进入 median；系统列出全部候选路径，不按文件名擅自选择。
- **Future capacity：**来自 Project 的相对 Action units；不是小时，也不从 Commit 数推断。

## Project 中的预测输入

```yaml
forecast_settings:
  as_of: 2026-08-03
  timezone: Asia/Shanghai
  integration_buffer: 0.2
  default_weekly_capacity: 5
  capacity_calendar:
    - week_start: 2026-08-10
      available_units: 2
      reason: Three days reserved for the confirmation review.
    - week_start: 2026-08-17
      available_units: 0
      reason: Moving week; no dependable deep-work capacity.
```

`as_of` 由本次人工审核推进；build 不使用 wall clock。它也是硬性的 authority 截止：任一 canonical record 的 `created`、`updated`、`verified_at`、status transition，或 Action blocker 的 `since`/`resolved_at` 在项目 timezone 中晚于 `as_of`，validation 都产生 `FORECAST_AS_OF_BEFORE_AUTHORITY` 并拒绝 build/calculate。`review_at` 是将来的复查约定，可以晚于 `as_of`。这样系统不会用“今天的状态”生成一个早于工作创建时间的历史预测。

`timezone` 必须是 IANA 名称。每个 `week_start` 是周一且不重复。未列出的周使用 `default_weekly_capacity`。`integration_buffer` 在 0–1 之间，默认 0.2。这里的 5、2、0 都是 Action size units 的相对容量，不是“每周五小时”。

`available_units` 表示整周总容量，不是从 `as_of` 开始仍可用的余额。当前周剩余容量固定按下式计算：

```text
currentRemaining = max(0, min(
  wholeWeekUnits - currentWeekClosedUnits,
  wholeWeekUnits × remainingCalendarDaysIncludingAsOf / 7
))
```

其中 `currentWeekClosedUnits` 只数目前有效 closed、且最新 close 落在本周并不晚于 `as_of` 的 Action size units。第一项防止已完成工作重复消费容量，第二项去掉已经过去的日历日；未来周才使用完整周容量。日期按 Project timezone 计算，因此 UTC 边界和夏令时不会按固定 24 小时误算。

已知答辩、搬家或旅行时，先降低相应周容量，再停止新开大型 Action、保存恢复包并重新预测。旅行期间有 Commit 只能说明发生过活动，不能反推容量或完整工作日。

## 早期三档预测

少于三个完整观察周时，方法是 `scenario`，不会把情景假设包装成个人真实吞吐：

- **Optimistic range：**协议一次通过、Scope 不增加、按已声明容量推进。
- **Median range：**加入一次常规重跑或叙事修订，以及 integration buffer。
- **Conservative range：**加入关键重跑、Claim 调整、记录风险/active blocker 的放大和集成缓冲。

三档始终是 `{earliest, latest}`，不是一个精确日期。Action dependency 可以指向 canonical Action、Driver、Experiment、Manifest、Result 或 Run：closed 的合法目标视为已满足；open/reopened、缺失、错误类型、非 canonical、schema/history 无效的目标分别产生明确诊断并 withholding dates。只有仍未关闭的 Action→Action 边进入 DAG；cycle issue 分别链接到每张 involved Action card。所有 Action 已 closed 时，三档都明确等于 canonical `as_of`。若 520 周内没有足够正容量，系统返回 `FORECAST_HORIZON_EXCEEDED`、`confidence: low` 和补充容量的具体动作，而不是无解释的 `null`。

## 有历史后的校准

达到三个完整观察周后，方法切换为 `observed`。创建周不属于完整观察周；系统从下一周一开始计数。系统按 domain 汇总 closed Action size units，并用“完整周数”作分母，所以零关闭周不能被删掉。experiment 与 writing 分开校准；analysis/coordination 也按自己的历史计算。某个仍有剩余工作的 domain 没有关闭历史时，只对该组使用 scenario capacity fallback，并降低 confidence。

这不是个人工时追踪。系统不知道每天工作了几小时，也不会把 Git commit 当成完成的 Action。它只利用人工定义的 Action、可验证关闭历史和明确容量。

## Confidence 与 change reasons

`confidence` 是预测输入质量的摘要，不是论文 Claim 的置信度：

- `high`：有足够完整周、所有剩余 domain 有观察速度、无 sentinel 或显著风险；
- `medium`：仍在早期、存在少量风险，或有个别 domain 需要 fallback；
- `low`：分类/大小未知、多个风险/active blockers，或依赖使日期无法诚实计算。

`confidenceActions` 是固定顺序、只读的“怎样提高本次预测可信度”列表。它会针对缺失/成环依赖、未来 authority、少于三个完整周、domain fallback、sentinel、风险/blocker 或容量 horizon 给出对应动作；Dashboard 直接呈现它，避免只显示 high/medium/low 却不告诉人下一步。

`changeReasons` 只解释当前 canonical 输入。v1 不把旧 generated forecast 当 authority，因此第一次或没有 canonical baseline 时会写明 initial/no baseline；同时列出真实的容量 override、风险/blocker 和 sentinel 影响。若未来需要比较“上次预测”，应先设计 canonical forecast decision record，而不是悄悄读取上次 JSON。

## Exception Inbox 的来源边界

Inbox 只派生已存在的 authority：active Action blockers；真实 reopened transitions；open Incident/Risk；closed qualifying Result 缺 closed Evidence Packet；Action 的 sentinel；Active ExecPlan blockers；启用 reviews 后的 candidate/coverage issues。它不会凭空制造“合同 UNKNOWN”或“smoke 未运行”。这些状态只有在相应 canonical record 已经持久化时才有资格出现。

默认审核方式是先看 Inbox，再沿链接下钻。无需每周逐页重读所有卡片；但任何系统结论都能回到原始 path，避免 Agent 黑盒总结。

## 每周 20–30 分钟审核

建议固定顺序：

1. 更新 `forecast_settings.as_of` 与未来容量；运行 validation 和 build。
2. 处理 schema/authority 错误，再处理 sentinel 与长期 blocker。
3. 审核剩余 Action、domain/size、在制任务数和关键依赖。
4. 审核 Result→Evidence pending、reopen 和本周新增 Scope。
5. 对照实验/写作关闭速度，查看三档 range、confidence、assumptions 和 change reasons。
6. 人决定唯一前台目标、Scope 增减、长期 blocker 取舍、科学 Claim 与交付；Agent 把决定写回 authority 后重建视图。

若 Agent 或脚本直接调用 `summarizeActions` / `forecastCompletion`，输入必须是以 project-relative path 为 key、值为完整 `RecordRef` 的 `Map` 或 `ReadonlyMap`。`forecastCompletion` 的顶层 wrapper 只允许 enumerable own data properties：必需的 `actions`、`throughputHistory`、`capacityCalendar`，以及可选的 `integrationBuffer`；额外、non-enumerable、symbol、accessor、Proxy 或缺失必需字段都稳定 `VALIDATION`，且不会执行 getter。公共 API 与 CLI 使用同一边界：Action 必须位于 `plans/actions/<ID>.md`、ID 唯一、key 等于 `RecordRef.path`；Result/Evidence handoff authority 也必须 canonical、schema-valid、lifecycle-valid。array、archive Action、重复 ID、accessor、Proxy、循环对象、sparse array、额外或 non-enumerable property、`undefined`、non-finite number 和其他非 JSON 值都会以稳定 `VALIDATION` 拒绝。`Action.dependencies` 是 unique ID set：重复依赖在 schema validation 时拒绝，图计算还会防御性去重；其他 ID arrays 未统一改成 set，因为部分字段的顺序或多角色语义仍可能是领域信息。

外部 `throughputHistory` 必须只含 `completeWeeks` 与 `weeks`，最后一周必须恰好是当前周之前的一周；各周必须连续且字段精确为 `weekStart`、`closed`、`closedByDomain`、`closedBySize`、`closedUnitsByDomain`。closure count 与 domain units 都是非负整数，domain/size key 只能来自 Core 枚举，两类 count 分别等于 `closed`，size 权重总和必须等于 domain units 总和。每个 domain 还单独受约束：0 次 closure 只能对应 0 units；`n > 0` 时 units 必须可由 `n` 个 `{1,2,4}` size 权重相加得到，不能把另一个 domain 的 units 转移过来制造观察速度。系统不从两个边际统计伪造 domain×size cross-tab；若未来算法需要确切组成，必须先把该交叉表持久化为新的 canonical aggregate。

## 教学示例（不是 TMI 项目实测）

假设一个教学项目在 `as_of: 2026-08-03` 仍有三项 Action：large experiment=4 units、medium analysis=2 units、small writing=1 unit；默认容量 5 units/week，但下一周因答辩只有 2 units；还没有三个完整观察周。系统会使用 scenario，而不是声称已经测得个人吞吐。Optimistic 采用一次通过假设，Median 加入常规重跑/修订和 20% buffer，Conservative 再加入关键重跑与 Claim 调整。输出是三个日期范围，并解释“答辩周容量下降”和“早期无观察 baseline”。

这组数字仅展示字段如何影响预测，不是对任何 TMI response 的回算，也不应复制成新项目承诺。真实项目必须从自己的 canonical Action、状态历史和容量生成。

## 字段维护与退役

每周审核时只人工维护会改变决策的 authority；统计与视图由生成器重建。若一个字段连续两个项目未被用于取舍、validation、handoff、prediction 或 provenance，应提出退役：先记录其消费者为零，更新 Shared Core schema、模板、指南和迁移说明，再显式升级项目。不要只停止填写仍为 required 的字段，也不要让 Agent静默删除字段。

执行就绪与等待原因还可通过 `research-os action ready --project ./demo` 读取。它从当前 Action、已验收产物、写域、资源和授权生成结果，不维护另一份任务状态。
