# 日常工作、目标调整与中断恢复

当前目标只保存在 `PROJECT.md.foreground_objective`。Active Plan 保存完成条件、范围、当前阻断、后台登记和下一步；执行历史由检查点写入 `plans/logs/`。不在计划里不断追加日报，也不复制目标。

## 开始并结束一项任务

先恢复当前状态，再查看可以推进的 Action：

```bash
research-os session context --project ./demo
research-os action ready --project ./demo
```

`context` 返回当前目标、活动 Action 摘要、attention、blockers、恢复点、写入范围、authority 路径和 `latestCheckpoint`。默认不读取检查点历史；只有需要追溯来源时，才沿 `latestCheckpoint` 及日志中的 `previous` 查找。

开始前，在 Action 中定义候选版本、检查标准、各检查的最大尝试次数和操作范围。记录当前用户实际给出的授权；同一范围已有授权时沿用。具体命令见 [08 验证与人工关口](08-validation-and-human-gates.md)。随后预检并认领：

```bash
research-os session preflight --project ./demo --claim '{"actionId":"ACT-001","dependencies":[],"resources":[],"writablePaths":["writing/report.md"],"unknowns":[]}'
research-os action claim --project ./demo --id ACT-001
```

此例要求已完成项目配置，Action 已处于可认领状态，写入范围同时满足 Active Plan 和 Action 授权。运行资源任务还需要当前资源观察，见 [05 执行与交接](05-sessions-agents-and-handoffs.md)。`preflight` 是只读检查；`action claim` 才持久化执行状态。

执行时记录真实产物和来源。必要检查通过后停止重复检查，转入验收。明确验收后立即更新任务状态和下一步；可信负结果也可以完成任务。程序退出成功不代表科学结论已被接受。

## 保存检查点

```bash
research-os session checkpoint --project ./demo --update '{
  "progress":["ACT-001 report rendered and inspected."],
  "artifacts":["writing/report.md"],
  "discoveries":[],
  "decisions":[],
  "resumePoint":{
    "lastVerifiedPoint":"ACT-001 required checks passed; acceptance is pending.",
    "nextAction":"Present the checked report for acceptance.",
    "nextCommandOrEdit":null,
    "requiredFiles":["plans/actions/ACT-001.md","writing/report.md"],
    "risks":[],
    "reforecastTrigger":null
  }
}'
```

这些示例陈述只可在对应工作真实发生后使用。`progress`、`artifacts`、`discoveries` 和 `decisions` 写入新的 JSON 日志，不追加到 Active Plan。计划只更新 `latest_checkpoint` 和 `resume_point`；已结束的后台登记也移入日志。`resumePoint.nextAction` 是唯一下一步，不再接收第二个 `currentStep`。

交接前检查项目记录是否还有未提交修改，并准确说明哪些已保存、哪些尚未提交。保存检查点不会自动提交 Git，也不替代科学验收。

## 目标改变时同步任务取舍

研究者确认新方向后，使用 `project rebaseline` 同步目标、研究问题、完成条件、计划范围和每项未结束 Action 的去留：

```bash
research-os project rebaseline --project ./demo --change "$(cat rebaseline.json)"
```

`rebaseline.json` 必须记录实际批准者 `approvedBy`、`reason`、新 `foregroundObjective`、`driver:{id,question,closureConditions}`、`plan:{completionConditions,scope,outOfScope,resumePoint}` 和 `actions`。这里 `plan.resumePoint` 使用保存格式的 snake_case 字段，如 `next_action`。每个未结束任务都要显式选择 `keep`、`defer`、`cancel` 或 `supersede`；替代还需要 `replacement` 指向本次保留的任务。保留、推迟、取消和替代不会被伪记为成功实验。

系统保留旧状态及决定，并一致地发布相关文件。中途失败且无法自动恢复时，会阻断后续 authority 操作；使用以下命令恢复中断更新，再读取状态：

```bash
research-os project recover --project ./demo
research-os session context --project ./demo
```

恢复不会覆盖外部另行修改的文件，也不会停止仍在运行的合法写入者。出现冲突时保留现场并核对来源。

## 每周审核与干扰模式

每周只检查影响下一步的事项：当前目标是否仍有效、任务是否已验收却未关闭、哪些 blocker 影响主线、剩余 Action 是否过大，以及实际容量是否变化。把新的决定写回所属记录，再生成视图；不要在 generated 页面维护另一份状态。

旅行、答辩或健康问题影响容量时保存明确恢复点：

```bash
research-os session disruption --project ./demo --update '{"status":"active","capacityReduction":"Research time reduced during travel.","pausedActions":["ACT-002"],"resumePoint":{"lastVerifiedPoint":"ACT-001 inputs reviewed.","nextAction":"Inspect ACT-001 current blockers before continuing.","nextCommandOrEdit":null,"requiredFiles":["plans/actions/ACT-001.md"],"risks":["Remote network may be unavailable."],"reforecastTrigger":"Normal capacity returns."}}'
```

暂停范围和容量来自实际情况，不按 commit 数猜测工时。返回后重新运行 `session context`，核对资源、依赖和阻断，把 disruption 更新为 `recovered`，并按真实容量更新预测。恢复控制面不会自动恢复每个暂停任务或批准原来的预测。
