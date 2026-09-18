# Sessions、执行资源与交接

Session 是临时执行者；Project Vault 保存长期事实。新会话只需要当前目标、活动任务、阻断、必要来源和下一步，历史按需要追溯。

## 恢复当前状态

```bash
research-os doctor --project ./demo
research-os project setup-status --project ./demo
research-os session context --project ./demo
```

读取 `authoritativeSources` 与当前 Action 必需的 `resumePoint.requiredFiles`。不默认加载所有日志、已结束任务、完整指南或所有 schemas。缺少 authority 时说明具体缺项；已有有效授权在原范围内继续适用，换 Session 不构成重新审批的理由。

维护 Research OS Core 源码本身不要求存在研究 Vault。该场景遵循源码仓库规则、用户范围和开发检查，不创建虚假的 Project，也不因找不到 `PROJECT.md` 而阻断已授权的代码工作。

## 预检与资源认领

`session preflight` 的 claim 恰好包含 `actionId`、`dependencies`、`resources`、`writablePaths`、`unknowns`。它检查任务、依赖、授权范围、计划写域和 writer 冲突；高影响未知项需要实际来源或研究者决定。

```bash
research-os session preflight --project ./demo --claim '{"actionId":"ACT-001","dependencies":["ART-001"],"resources":["gpu0"],"writablePaths":["results/ACT-001/**"],"unknowns":[]}'
```

普通 record 依赖需要有效且已关闭。Artifact 依赖需要显式验收，且实际文件 SHA-256 仍与验收版本一致；生产该 Artifact 的整个 Action 可以仍在执行。未验收、缺失或已变化的产物不能作为已满足输入。

Action 的 `execution` 声明实际需要的已登记资源名和写入范围，例如：

```yaml
execution:
  resources: [gpu0]
  writable_paths: [results/ACT-001/**]
  resource_observation: null
```

资源名对应 `PROJECT.resources` 中具体资源；GPU 任务只需其获准使用的设备可用，不要求整台服务器空闲。先用现有服务器工具取得观察，再提交真实结果：

```bash
research-os action claim --project ./demo --id ACT-001 --observation '{"observed_at":"2026-09-18T09:00:00Z","source":"Current server resource inspection recorded in ACT-001.","available":["gpu0"]}'
```

示例时间和来源必须替换为当前真实观察。观察不能来自未来，认领时也不能早于当前 Action 更新。资源和写入范围不冲突的 Action 可以并行。唯一执行状态保存在 Action 的 `status: in_progress`，不另维护 running/ready/waiting 清单。CLI 认领不等于启动远程训练，仍由项目已有 launcher 执行。

## 登记有界后台任务

后台 Session 或 subagent 开始前登记精确用途、Action、输入、写入范围、产物和接收条件。不要把项目目标再复制到 registration。

```bash
research-os session background --project ./demo --registration '{
  "kind":"subagent",
  "task_id":"AUDIT-ACT-001",
  "purpose":"Inspect the candidate report sources.",
  "action_id":"ACT-001",
  "readable_paths":["PROJECT.md","plans/actions/ACT-001.md","writing/report.md"],
  "writable_paths":["generated/audit/ACT-001/**"],
  "forbidden_changes":["Do not change scientific scope or Claims."],
  "expected_artifacts":["generated/audit/ACT-001/report.md"],
  "acceptance":"Check source identities and report concrete discrepancies.",
  "owner":"report-auditor",
  "status":"running",
  "blockers":[],
  "receiver":"foreground-session"
}'
```

系统生成登记 ID 和时间。相同 `task_id` 重提完整 registration 仅用于改变 `status`、`blockers`；其用途、Action、owner、范围和接收条件不得被悄悄替换。状态通常经过 `running → candidate_ready → accepted → closed`，也可按规则进入 `blocked` 或 `cancelled`。`blocked` 必须写明实际阻断。

`registered`、`running`、`blocked`、`candidate_ready` 占用写域；`accepted`、`closed`、`cancelled` 释放写域。范围只能使用安全的项目相对路径和受支持的 `*`、`**`；敏感的 `PROJECT.md` 和 Active Plan 必须通过 exact path 授权，不能用宽泛 glob 获得控制面写权限。

交给后台的说明应包含登记 ID、authority 路径、已有批准的 grant ID/批准者/原因、写入范围、禁止修改项、预期产物和必要检查。授权记录反映用户实际决定，不替代平台权限。收到平台拒绝时如实记录 blocker。

## 接收、关闭与交接

先核对候选 diff 是否越界：

```bash
research-os session check-diff --registration '{"writablePaths":["generated/audit/ACT-001/**"],"controlPaths":["PROJECT.md","plans/active.md"]}' --changed-paths '["generated/audit/ACT-001/report.md"]'
```

通过范围检查后，执行 Action 已约定的必要检查，保留真实证据。后台标为 `candidate_ready` 只说明候选已完成；`accepted` 是后台交付接收，不能替代科学结论验收。作为下游依赖的 Artifact 使用独立命令接受当前文件版本：

```bash
research-os artifact accept --project ./demo --id ART-001 --acceptance '{"actor":"researcher","evidence":"Reviewed the current model file and the linked validation results."}'
```

此命令要求 Artifact 已处于 `review`，并记录当前文件哈希。示例批准者及理由必须来自真实验收，不能直接照抄。

交接时更新 Action、尚未结束的后台登记和 `resume_point`，再保存检查点。已结束登记与工作历史进入日志，Active Plan 保持简短。新 Session 从当前状态继续；只有追溯某项发现或决定时才加载对应历史。
