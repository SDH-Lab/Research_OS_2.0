# 常用操作示例

以下命令适用于 Core 2.0.0，使用已完成首次配置的 `./demo`。示例 ID、范围、时间、批准者和检查证据必须来自当前项目；这些示例本身不是实验结果或审批记录。

## 1. 建立问题和可验收任务

```bash
research-os record new --project ./demo --type driver --id RQ-101 --title "Report clarity" --values '{"source":"Researcher request","question":"Does the report present the agreed results clearly?","closure_conditions":["The researcher accepts the report presentation."],"actions":[]}'
research-os record new --project ./demo --type action --id ACT-101 --title "Correct report layout" --values '{"driver":"RQ-101","purpose":"Correct the layout without changing scientific claims.","acceptance":"The researcher accepts the rendered layout.","domain":"writing","size":"small","execution":{"resources":[],"writable_paths":["writing/report.md"],"resource_observation":null}}'
research-os record status --project ./demo --id ACT-101 --to defined --reason "Task boundary and acceptance are recorded."
research-os record status --project ./demo --id ACT-101 --to ready --reason "Required inputs are available."
research-os action configure --project ./demo --id ACT-101 --definition '{"candidate_version":"report-v1","validation_plan":{"tier":"presentation","checks":[{"id":"layout","description":"Inspect the rendered page for truncation.","max_attempts":2}]},"operation_scope":{"operations":["edit-report"],"paths":["writing/report.md"],"resources":[]}}'
```

在 Driver 的 `actions` 中加入 `ACT-101`，并使计划的写入范围覆盖已批准操作。把当前真实授权写入任务：

```bash
research-os action approve --project ./demo --id ACT-101 --approval '{"grant_id":"GRANT-101","approver":"researcher","reason":"The researcher requested this layout correction."}'
research-os session preflight --project ./demo --claim '{"actionId":"ACT-101","dependencies":[],"resources":[],"writablePaths":["writing/report.md"],"unknowns":[]}'
research-os action claim --project ./demo --id ACT-101
```

现在执行实际修改与检查。通过后记录检查证据；只有真实验收发生后才关闭：

```bash
research-os action check --project ./demo --id ACT-101 --check '{"check_id":"layout","candidate_version":"report-v1","outcome":"pass","evidence":"Inspected the current rendered page; no text is truncated."}'
research-os record status --project ./demo --id ACT-101 --to closed --accepted-by researcher --verified-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --reason "The researcher accepted the checked layout."
```

## 2. 检查失败后明确下一次尝试

失败时使用 `outcome: fail` 并保留实际证据。达到约定次数会产生 blocker。确认新修订或新的预算后，再配置候选并说明原因：

```bash
research-os action configure --project ./demo --id ACT-102 --definition '{"candidate_version":"report-v2","reason":"The truncated column was traced to an incorrect width and corrected.","validation_plan":{"tier":"presentation","checks":[{"id":"layout","description":"Inspect the corrected column in the rendered page.","max_attempts":1}]},"operation_scope":{"operations":["edit-report"],"paths":["writing/report.md"],"resources":[]}}'
```

此例针对已有未关闭的 `ACT-102`。不因失败删除历史，也不为所有任务套同一轮数。只重新检查本次修改影响的部分；科学含义发生变化时必须包含对应的科学检查。

## 3. 接受可供下游使用的具体产物

先确认生产 Action 和实际文件存在，且文件位于生产任务授权的写域：

```bash
research-os record new --project ./demo --type artifact --id ART-101 --title "Reviewed model checkpoint" --values '{"producer_action":"ACT-201","file":"results/model.pt"}'
research-os record status --project ./demo --id ART-101 --to defined --reason "Producer and file are identified."
research-os record status --project ./demo --id ART-101 --to ready --reason "The candidate file is available."
research-os record status --project ./demo --id ART-101 --to in_progress --reason "Inspecting the candidate."
research-os record status --project ./demo --id ART-101 --to review --reason "Candidate checks are available for acceptance."
research-os artifact accept --project ./demo --id ART-101 --acceptance '{"actor":"researcher","evidence":"Reviewed this model version and its linked validation results."}'
```

在下游 Action 的 `dependencies` 引用 `ART-101`。系统核对验收和实际文件哈希，不要求 `ACT-201` 整体已关闭。文件改变后创建新 Artifact 并重新验收；旧验收不自动适用于新版本。

## 4. 目标转向

先和研究者明确新目标、完成条件，以及每个未结束 Action 的去留。把真实决定保存成输入文件，然后执行：

```bash
research-os project rebaseline --project ./demo --change "$(cat rebaseline.json)"
research-os session context --project ./demo
research-os action ready --project ./demo
```

输入字段见 [日常与目标调整](04-daily-weekly-and-disruption.md)。取消旧方法任务不代表该方法成功或失败。历史实验和证据仍保留其当时上下文。

## 5. 实验、写作和交接

正式实验沿 [实验流程](06-experiment-workflow.md) 固定关键参数、检查实际 Manifest 和运行来源。审稿回复沿 [写作与回复](07-writing-and-response.md) 检查 Claim、证据、修改位置和渲染交付。两者都使用本版 Action 的必要检查、授权和验收流程。

```bash
research-os record validate --project ./demo
research-os session context --project ./demo
research-os view build --project ./demo
```

最后按 [检查点示例](04-daily-weekly-and-disruption.md) 保存真实进展与下一步。日志保存历史，Active Plan 保留当前工作；不要用复制整段对话代替项目记录。
