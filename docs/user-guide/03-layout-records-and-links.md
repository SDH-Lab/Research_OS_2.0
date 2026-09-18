# 目录、记录与链接

本章是 Research OS Core 2.0.0 的 canonical record 参考。项目恢复链固定为 `AGENTS.md → PROJECT.md → PROJECT.active_plan → domain records → sources`。`generated/` 只放可重建视图，永远不是 authority。

## Canonical 目录与创建类型

`record new` 的 `--type` 是创建 kind；写入 frontmatter 的 `type` 是 canonical type。`concern`、`response`、`manuscript-change`、`strategy` 和 `risk` 是需要注意的别名；别名对应的细分 kind 由机器写入，调用方不能伪造。

| 创建 kind | canonical type | canonical path | 首次创建启用模块 |
| --- | --- | --- | --- |
| `driver` | `driver` | `research/questions/<ID>.md` | `research` |
| `concern` | `driver` | `reviews/concerns/<ID>.md` | `reviews` |
| `action` | `action` | `plans/actions/<ID>.md` | 无；`plans/` 是核心目录 |
| `artifact` | `artifact` | `artifacts/<ID>.md` | 无 |
| `experiment` | `experiment` | `experiments/experiments/<ID>.md` | `experiments` |
| `manifest` | `manifest` | `experiments/manifests/<ID>.md` | `experiments` |
| `run` | `run` | `experiments/runs/<ID>.md` | `experiments` |
| `result` | `result` | `experiments/results/<ID>.md` | `experiments` |
| `evidence` | `evidence` | `evidence/packets/<ID>.md` | `evidence` |
| `claim` | `claim` | `evidence/claims/<ID>.md` | `evidence` |
| `writing` | `writing` | `writing/units/<ID>.md` | `writing` |
| `response` | `writing` | `writing/response/<ID>.md` | `writing` |
| `manuscript-change` | `writing` | `writing/changes/<ID>.md` | `writing` |
| `strategy` | `writing` | `writing/strategy/<ID>.md` | `writing` |
| `decision` | `decision` | `decisions/<ID>.md` | `decisions` |
| `incident` | `incident` | `incidents/incidents/<ID>.md` | `incidents` |
| `risk` | `risk` | `incidents/risks/<ID>.md` | `incidents` |

Project 只能在 `PROJECT.md`；ExecPlan 位于 `plans/*.md`，其中 `PROJECT.active_plan` 必须精确解析到唯一一个未关闭的 canonical `exec_plan`。ID 使用 `大写前缀-至少三位数字`，例如 `RQ-001`。创建器同时拒绝重复 ID 和既有目标 path，不会覆盖文件。

Public canonical discovery 只把带 YAML frontmatter 且含合法 `type`、`id` 的 Markdown 放入 catalog。Validator 使用更宽的 candidate discovery：带 frontmatter 但 YAML 损坏、缺 `type` 或缺 `id` 的 Markdown 仍计入 `checkedFiles` 并分别报告 `FRONTMATTER_INVALID` 或 `RECORD_IDENTITY_INVALID`，不会因第一个坏文件而停止。`reviews/concerns/`、`writing/response/`、`writing/changes/` 更严格：系统递归扫描三个 root 以下任意深度的 Markdown；即使完全缺 frontmatter，也会作为 path-specific invalid candidate 阻断 writing coverage/delivery。Nested parsed record 还会报告 noncanonical；重复 ID、wrong kind、schema 和 canonical location 不能因 catalog 丢弃而隐身。候选感知 CLI 使用私有 sidecar；普通 Map 无法知道磁盘上被省略的坏文件，但会按其实际包含的每个 RecordRef `path` 检查 reviewer-root type/kind。Public writing API 的 catalog 是严格的 path-keyed Map：每个 key 必须是 primitive string，并与对应 `RecordRef.path` 逐字符相等；非字符串 key、symbol key 或任意 key/path 分歧都会在记录进入索引前产生顶层 catalog issue，不能用 Map key 把 reviewer authority 重新分类。`.agents/`、`.codex/`、`.git/`、`.obsidian/`、`.superpowers/`、`.tmp/`、`generated/`、`node_modules/` 共用一套内部目录排除 contract，不进入 authority catalog 或 canonical source snapshot；validator 另行扫描 `generated/`，若发现 record-shaped Markdown，报告 `CANONICAL_RECORD_IN_GENERATED`。

Public discovery 的 value 固定为只读 `{id, type, path, attributes}`，Map 及嵌套 attributes 都不可变；正文只在内部读写，不属于 `RecordRef`。`record new` 的 `--values` 只接受所选 Core schema 的人工领域字段，拒绝 lifecycle、identity、`kind` 和未知字段。`--id`/`--title` 必须走独立 options，title 必须是单行；科学字段可保留多行 frontmatter 值，但模板正文会安全折叠并转义 Markdown 控制字符。

## 何时嵌入，何时独立成文件

一个逻辑对象在以下条件全部成立时保持为父 record 的内嵌字段：没有独立状态；没有独立 owner/writer；不被其他记录稳定引用；不需要单独验收、批准、重开或 provenance。例如 Experiment 的 `variables`、Result 的 `numeric_checks`、Decision 的 `options` 通常保持内嵌。

满足任一条件就提升为独立 record：需要稳定 ID；有自己的生命周期或验收；会被多个对象复用；需要独立 writer；会独立批准、关闭、重开或 supersede；需要从 Claim 下钻到来源。例如一次真实执行必须是 Run，能够支撑表述的整理必须是 Evidence Packet，可交付表述必须是 Claim。不要为每个列表项创建文件，也不要把有独立 authority 的对象埋在正文。

## 完整 frontmatter 示例

以下均为可解析的 Core 2.0.0 完整最小示例。日期必须是 RFC 3339 date-time。Markdown 正文承载解释与人工判断，不替代这些可检查字段。

### Project — `PROJECT.md`

```yaml
---
schema_version: 1
type: project
id: PRJ-001
status: defined
created: 2026-08-03T00:00:00Z
updated: 2026-08-03T00:00:00Z
status_history: []
project_id: demo
title: Demo project
stage: research
foreground_objective: Define the primary endpoint.
active_plan: plans/active.md
core_version: 2.0.0
modules: [research]
resources: {}
approved_code_roots: []
canonical_writing_sources: {}
forecast_settings:
  as_of: 2026-08-03
  timezone: UTC
  integration_buffer: 0.2
  default_weekly_capacity: 5
  capacity_calendar: []
---
```

`forecast_settings` 是日期预测的 canonical 输入，不是生成视图。`as_of` 是本次审核使用的项目日期；生成器不会读取机器当前时间。`default_weekly_capacity` 和 `available_units` 使用相对 Action units，不是工时。已知旅行、答辩或搬家周才在 `capacity_calendar` 增加 override；同一 `week_start` 只能出现一次，且必须是周一。

### Active ExecPlan — `plans/active.md`

```yaml
---
schema_version: 1
type: exec_plan
id: PLN-001
status: defined
created: 2026-08-03T00:00:00Z
updated: 2026-08-03T00:00:00Z
status_history: []
completion_conditions: [ACT-001 is closed with reviewed evidence.]
scope: [RQ-001 and its registered endpoint.]
out_of_scope: [No new cohort.]
risks: []
blockers: []
dependencies: []
background_register: []
writable_paths: [plans/actions/ACT-001.md]
resume_point:
  last_verified_point: RQ-001 scope reviewed.
  next_action: Claim ACT-001 and inspect its inputs.
  next_command_or_edit: Prepare the exact session preflight claim described in chapter 5.
  required_files: [PROJECT.md, plans/active.md, plans/actions/ACT-001.md]
  risks: []
  reforecast_trigger: null
disruption_mode: null
latest_checkpoint: null
---
```

`resume_point` 是结构化恢复包，不是自由文本。持久化字段使用 snake_case；`session checkpoint` 和 `session disruption` 的 JSON 输入使用相应 camelCase 字段。`background_register`、`updated`、登记 ID 与机器时间由 Session Controller 更新，不应靠 Agent 从聊天记录猜测。完整操作见第 4、5 章。

### Driver / Concern

`driver` 与 `concern` 的 frontmatter 相同，差别只有 authority path 和语义来源。

```yaml
---
schema_version: 1
type: driver
id: RQ-001
driver_kind: research_question
status: inbox
created: 2026-08-03T00:00:00Z
updated: 2026-08-03T00:00:00Z
status_history: []
source: research brief
source_comment_id: null
source_ref: null
question: Does the intervention improve the registered endpoint?
importance: It determines whether the method is retained.
scope: Registered cohort and metric only.
priority: high
closure_conditions: [Evidence reviewed and Claim bounded.]
actions: [ACT-001]
---
```

`concern` 使用 `driver_kind: concern`，并要求非空 `source_comment_id` 与已登记的安全 `source_ref`；它的 canonical path 是 `reviews/concerns/<ID>.md`。完整拆分和 Response 规则见第 07 章。

### Action

```yaml
---
schema_version: 1
type: action
id: ACT-001
status: inbox
created: 2026-08-03T00:00:00Z
updated: 2026-08-03T00:00:00Z
status_history: []
driver: RQ-001
purpose: Reanalyse the existing result without a new run.
inputs: [RES-001]
outputs: [EVD-001]
dependencies: []
acceptance: EVD-001 records checks, interpretation, and limitations.
risks: [Selection bias may remain.]
writer: foreground-session
next_step: Review EVD-001.
domain: analysis
size: small
blockers: []
---
```

草稿可以尚未配置 workflow；执行前必须通过 action configure 定义候选版本、必要检查、任务预算和操作范围，并记录真实授权。验收记录由状态命令写入，不通过 record new 伪造。详见第 08 章。

Action 是唯一的排程与吞吐统计单位。`domain` 只能是 `experiment`、`analysis`、`writing`、`coordination`、`unclassified`；`size` 只能是 `small`、`medium`、`large`、`unestimated`。初始化时使用两个 sentinel 值，不允许 Agent 猜测分类。预测权重固定为 small=1、medium=2、large=4；unestimated 暂按 2 计算，但会进入 Exception Inbox 并降低置信度。

`Blocked` 不是生命周期状态。每个阻塞项保留自己的 active/resolved 历史：

```yaml
blockers:
  - id: BLOCK-001
    category: dependency
    critical_path: true
    root_cause: The data owner has not published the frozen checksum.
    resolution: null
    description: Awaiting the frozen split manifest.
    owner: Researcher
    since: 2026-08-03T00:00:00Z
    next_unblock_action: Ask the data owner to publish the checksum.
    review_at: 2026-08-05T09:00:00Z
    status: active
    resolved_at: null
```

通过 action blocker 命令解决后保留 `status: resolved`、解决理由与 `resolved_at`；未知历史时间明确写 `null`，不要删除旧 blocker。这样系统能计算 active blocker age，同时保留“曾经被什么阻塞”的复盘证据。

### Artifact

Artifact 记录一份可供下游使用的具体文件版本，位于 `artifacts/<ID>.md`。人工字段是 `producer_action` 和项目相对精确路径 `file`；`sha256` 与 `{actor,at,evidence}` 形式的 `acceptance` 由 artifact accept 写入。只有真实验收且文件仍匹配该哈希，依赖才满足。修改文件需要新 Artifact；生产 Action 无需整体关闭。完整命令见第 13 章。

### Experiment

```yaml
---
schema_version: 1
type: experiment
id: EXP-001
status: inbox
created: 2026-08-03T00:00:00Z
updated: 2026-08-03T00:00:00Z
status_history: []
scientific_question: Does the intervention improve the registered endpoint?
variables: [intervention]
fixed_conditions: [dataset-v1, split-v1]
data_model_boundary: Registered cohort only.
priors_and_bias: [Expected small effect.]
forbidden_shortcuts: [No test-set tuning.]
outcome_definitions: {primary: auroc}
stopping_conditions: [One registered run completed.]
acceptance: Protocol checks pass before interpretation.
---
```

### Manifest

```yaml
---
schema_version: 1
type: manifest
id: MAN-001
status: defined
created: 2026-08-03T00:00:00Z
updated: 2026-08-03T00:00:00Z
status_history: []
code_root: code
resolved_code_root: {resource: code, uri: "ssh://research.example.org/worktrees/code", identity: code-v1}
entrypoint: train.py
commit: abc1234
resolved_config: {seed: 7}
resolved_config_hash: null
data_and_split: {dataset_root: "data:dataset-v1", manifest: "data:manifest.json", split_function: split-v1, seed: 7, class_or_domain_order: [healthy, disease]}
model_and_checkpoint: {model_class: baseline, checkpoint: "models:base.ckpt"}
training_boundary: {trainable_parameters: [adapter], loss: cross_entropy, sampler: balanced, gradient_accumulation: 1}
optimizer_scheduler: {optimizer: {name: AdamW, parameters: {learning_rate: 0.001}}, scheduler: {name: cosine, parameters: {}}, checkpoint_selection: best-auroc, early_stopping: {mode: enabled, monitor: auroc, patience: 5}}
evaluator: {implementation: macro-auroc, metrics: [auroc], aggregation: macro, state: eval}
command: python train.py --config registered.yaml
environment: {runtime: python-3.12, packages: {torch: 2.5.0}, hardware: cuda-12.1}
output_location: results:EXP-001/RUN-001
expected_artifacts: [results:EXP-001/RUN-001/metrics.json, results:EXP-001/RUN-001/run.log]
normalized_hash: null
resolved_at: null
project_authority: null
project_authority_hash: null
resolved_outputs: null
manifest_complete: false
---
```

这是 `defined` 阶段的 progressive card 示例，所以 7 个机器字段仍是 `null`/`false`；它不能进入 `ready`。实际 Project 的 resource URI、identity 和路径必须来自当前 `PROJECT.md`，不能照抄示例。完整 snapshot 由第 06 章的 `manifest-check` 生成。

### Run

```yaml
---
schema_version: 1
type: run
id: RUN-001
status: inbox
created: 2026-08-03T00:00:00Z
updated: 2026-08-03T01:00:00Z
status_history: []
experiment: EXP-001
manifest: MAN-001
started_at: 2026-08-03T00:05:00Z
ended_at: 2026-08-03T00:55:00Z
run_status: completed
logs: [results:EXP-001/RUN-001/train.log]
artifacts: [results:EXP-001/RUN-001/metrics.json]
failure_details: none
official: true
---
```

### Result

```yaml
---
schema_version: 1
type: result
id: RES-001
status: inbox
created: 2026-08-03T01:05:00Z
updated: 2026-08-03T01:30:00Z
status_history: []
run: RUN-001
protocol_checks: [Registered split confirmed.]
numeric_checks: [AUROC reproduced from metrics.json.]
classification: credible_negative
adoption_reason: Valid protocol; no practically meaningful improvement.
limitations: [Single registered seed.]
follow_up: [ACT-002]
---
```

### Evidence Packet

```yaml
---
schema_version: 1
type: evidence
id: EVD-001
status: inbox
created: 2026-08-03T01:35:00Z
updated: 2026-08-03T02:00:00Z
status_history: []
sources: [RES-001, RQ-001]
figures_and_numbers: [AUROC delta was below the registered threshold.]
interpretation: The registered run does not support improvement.
counterevidence: []
limitations: [One seed and one cohort.]
supported_claims: [CLM-001]
unsupported_claims: [The method is ineffective in every setting.]
writing_destinations: [WRT-001]
---
```

非实验来源写成已注册资源引用，例如 `sources: [papers:article.pdf, RQ-001]`。其左侧资源名必须存在于 `PROJECT.resources`；绝对路径、`..` 和未注册资源不会成为可批准来源。

### Claim

```yaml
---
schema_version: 1
type: claim
id: CLM-001
status: inbox
created: 2026-08-03T02:05:00Z
updated: 2026-08-03T02:20:00Z
status_history: []
statement: The registered run did not show a meaningful improvement.
evidence: [EVD-001]
conditions: [Registered cohort and endpoint.]
prohibited_expansion: [Do not generalize to all cohorts.]
confidence_and_limitations: Credible negative with one registered seed.
use_locations: [WRT-001]
approval_status: approved
reopen_conditions: [A corrected run or changed endpoint.]
---
```

Core 2.0.0 只使用 `approval_status`; 不要添加竞争字段 `approval`。`approval_status: approved` 的 Claim 必须有无断裂的 typed provenance，抵达 Driver，并抵达 Run 或 Evidence 中已注册的非实验 source。Response closure/delivery 还会检查 trace 中每个传递节点的 schema、canonical location、status/history 与接受状态。pre-close Coverage 只允许当前 Response 精确链接的 Concern 暂处于 schema/history-valid 的 `review` 或 `verified`；所有其他传递 Driver，包括 Research Question 和另一 Concern，都必须实际 `closed`。实验分支的 `Result → Run → Experiment + Manifest` 任一层缺失、歧义、wrong type、noncanonical、open/reopened 或无效都会阻断。

### Writing Unit

```yaml
---
schema_version: 1
type: writing
id: WRT-001
writing_kind: general
status: inbox
created: 2026-08-03T02:25:00Z
updated: 2026-08-03T02:25:00Z
status_history: []
purpose: Report the registered negative result.
claims: [CLM-001]
target_location: paper:results.tex
draft: The registered run did not show a meaningful improvement.
synchronization_status: pending
verification_result: pending
---
```

`general` 位于 `writing/units/`；`internal_strategy`、`response_block` 和 `manuscript_change` 分别位于 `writing/strategy/`、`writing/response/` 和 `writing/changes/`。后两者有额外 conditional fields、数字来源和同步约束，详见第 07 章。

Reviewer-facing prose 与正式 Claim/Evidence/Decision authority 的显式未完成标记只认独立大写 `TODO|TBD|FIXME|UNKNOWN|PENDING|PLACEHOLDER`、`??`、`{{...}}`，并递归检查选定字段中的所有 string leaf。小写科学术语不属于 marker；ID、resource ref、locator、`target_location`、`location_anchor` 只按结构合同验证。

### Decision

```yaml
---
schema_version: 1
type: decision
id: DEC-001
status: inbox
created: 2026-08-03T02:30:00Z
updated: 2026-08-03T02:45:00Z
status_history: []
question: Should CLM-001 be used in the manuscript?
options: [use with limits, omit]
selected_option: use with limits
rationale: Protocol is valid and limitations are explicit.
impact: [CLM-001, WRT-001]
approver: principal-investigator
decision_date: 2026-08-03T02:45:00Z
reopen_conditions: [Source correction or scope change.]
---
```

### Incident

```yaml
---
schema_version: 1
type: incident
id: INC-001
status: inbox
created: 2026-08-03T03:00:00Z
updated: 2026-08-03T03:00:00Z
status_history: []
kind: incident
fact_or_risk: RUN-001 used the wrong checkpoint.
evidence: [RUN-001]
impact_scope: [RES-001, EVD-001, CLM-001]
root_cause_status: confirmed
remediation: [Create a corrected Manifest and Run.]
reverification: Re-run validation and reopen affected records.
guardrail_candidate: Compare checkpoint identity before launch.
---
```

### Risk

```yaml
---
schema_version: 1
type: risk
id: RSK-001
status: inbox
created: 2026-08-03T03:05:00Z
updated: 2026-08-03T03:05:00Z
status_history: []
kind: risk
fact_or_risk: The external source may be superseded.
evidence: [EVD-001]
impact_scope: [CLM-001]
root_cause_status: unverified
remediation: [Check the source version before delivery.]
reverification: Confirm resource identity.
guardrail_candidate: Pin source identity in PROJECT.resources.
---
```

## Provenance link-field 语义

`record trace` 只沿下表 frontmatter 字段中的 ID-shaped 值遍历；它故意忽略正文 wikilink。这样解释性正文不会偷偷改变 Claim provenance。

| canonical type | 字段 | 允许的 canonical target type |
| --- | --- | --- |
| Claim | `evidence` | Evidence |
| Evidence | `sources` | Driver、Result；非 ID 值必须是已注册 resource ref |
| Evidence | `counterevidence` / `supported_claims` / `writing_destinations` | Evidence / Claim / Writing |
| Result | `run` / `follow_up` | Run / Action |
| Run | `experiment` / `manifest` | Experiment / Manifest |
| Driver | `actions` | Action |
| Action | `driver` | Driver |
| Action | `inputs`, `dependencies` | 代码中声明的领域对象集合；不接受任意类型 |
| Action | `outputs` | Action、Claim、Decision、Evidence、Result、Writing |
| Writing | `claims` / `concern` / `evidence_or_reason` | Claim / Driver / Evidence 或 Decision |
| Writing | `manuscript_changes` / `covered_actions` / `response_blocks` | Writing / Action / Writing |
| Incident / Risk | `evidence` | Evidence、Result、Run |
| Decision | `impact` | domain records，不含 Project/ExecPlan |
| Project / ExecPlan / Experiment / Manifest | 无 | 无 |

Evidence `sources` 的每一项都必须是 string，且只能是允许类型的 ID 或 `resource_name:relative/path`。resource ref 不作为 record edge，而是通过 `PROJECT.resources` 解析为 `externalSources`；绝对路径、普通文件名、畸形/未注册 ref 和非 string 值进入 `brokenSources`，并由 validator 报 `EVIDENCE_SOURCE_INVALID`/schema issue。不存在、重复或类型错误的 ID 进入 `brokenLinks`，其中类型错误带 `WRONG_LINK_TYPE`，validator 同时报 `PROVENANCE_LINK_INVALID`。无效项即使与有效来源混合也会阻断 approved Claim。

除 `Evidence.sources` 的 ID/resource-ref 双形态外，所有 typed provenance 都只接受 canonical ID：`Result.run`、`Run.experiment`、`Run.manifest`、`Action.driver` 是单个 ID string，其余上表字段是 flat ID string array。普通字符串、number/object、嵌套数组，以及把 scalar 包成数组都会产生 `INVALID_LINK_VALUE` broken link 和 `PROVENANCE_LINK_INVALID`；validator 不会递归展开或静默丢弃它们。

只有类型合法的 edge 才会继续遍历。因此 approved Claim 的有效结构必须从 `Claim.evidence → Evidence` 开始，再经合法分支抵达 Driver，并抵达 Run 或该 Evidence 中已注册的非实验 source；把 Driver/Run 直接塞进 `Claim.evidence` 不能绕过 Evidence Packet。循环进入 `cycles`，终点路径进入 `paths`；cycle 会确定性报告，但 cycle **本身**不阻断 otherwise complete approval。所有输出都确定性排序，只读 `types` Set 不能被调用方修改；CLI 会把 Set/Map 归一化为 JSON。

正文 wikilink 仍有独立结构检查。只有形如 `[[RQ-001]]`、`[[RQ-001|label]]` 或 `[[RQ-001#section]]` 的 ID-shaped target 才是 canonical-link candidate；`[[ordinary note]]` 不要求对应 record。正文断链报告 `BROKEN_WIKILINK`，但不会成为 provenance edge，也不能用 `[[RUN-001]]` 修复缺失的 `Result.run`。

Response Concern closure 对 Action 再加一层 artifact reachability：每个关闭 Action 的 `outputs` 必须非空、全部 unique-resolvable、schema/history 有效、canonical 且关闭，并且至少一个 output 进入该 Concern 的 Evidence/Decision、Claim、Response 或 Manuscript Change dependency graph。Result output 只有在相关 Evidence `sources` 明确接受该 Result 时才算到达；Action→Action 中间节点必须同样关闭、canonical、由同一 Concern 拥有且列在其权威 `actions` 中。`covered_actions` 本身不是产物被消费的证据。

Writing coverage 输出固定形状 `{comments, concerns, issues, openActions, unapprovedClaims, missingChanges, closable}`。顶层 `issues` 深冻结、确定性排序，专门承载 candidate/global catalog 问题，包括 path-keyed Map 的 key/path 不一致；即使没有任何有效 Concern 也保留无效文件路径，这些问题不复制到每个 Concern。`closable` 是 pre-close gate：只有当前 Response 精确链接的 Concern 可处于 `review`/`verified`，`reopened` 和任何未关闭的非当前 Driver 都会阻断；最终 delivery 仍要求当前 Concern 实际 `closed`。

## 状态、验证与恢复

状态按 Core 的 transition rules 前进。每次 `record status` 都保留正文、`created` 和无关属性，严格推进 `updated`，并追加 `{from, to, at, reason}`。写入前会验证完整既有历史：第一条必须从该 type 的初始状态开始，事件必须连续、合法、严格按时间递增，不能早于 `created` 或晚于 `updated`，最后一条必须等于当前 `status`；非法历史不会被新事件掩盖，原文件保持逐字节不变。任何历史曾进入 `closed` 都要求有效 `verified_at`；任何历史曾进入 `reopened` 都要求保留非空 reason 和合法非空 `affected_ids`。

```bash
research-os record status --project ./demo --id ACT-001 --to defined --reason "Scope recorded"
research-os record status --project ./demo --id ACT-001 --to ready --reason "Acceptance is reviewable"
research-os action claim --project ./demo --id ACT-001
research-os record status --project ./demo --id ACT-001 --to review --reason "Artifact ready"
research-os record status --project ./demo --id ACT-001 --to verified --reason "Acceptance checked"
research-os record status --project ./demo --id ACT-001 --to closed --reason "Acceptance satisfied" --verified-at 2026-08-03T04:00:00Z
research-os record status --project ./demo --id ACT-001 --to reopened --reason "Source corrected" --affected-ids '["EVD-001","CLM-001"]'
research-os record validate --project ./demo
research-os record trace --project ./demo --id CLM-001
```

`record validate` 输出固定形状 `{ok, checkedFiles, issues}`，issues 含 `{severity, code, path, message, relatedIds}` 并按 path、code 排序。常见恢复方式：

| code | 含义 | 恢复动作 |
| --- | --- | --- |
| `DUPLICATE_RECORD_ID` | 两个 canonical 文件共用 ID | 保留 authority 文件；为另一对象分配新 ID 并更新引用 |
| `CANONICAL_LOCATION` | type/ID 与 path 不匹配 | 移到上表 exact path；不要改 type 来迎合目录 |
| `SCHEMA_INVALID` | 必填字段、类型或日期错误 | 按对应完整示例修 frontmatter |
| `BROKEN_WIKILINK` | 正文 ID link 无目标 | 修正 ID、创建缺失 record，或删除过期链接 |
| `PROVENANCE_LINK_INVALID` | frontmatter link 缺失、歧义或 target type 错误 | 按 link-field target contract 修正；不要靠正文补链 |
| `EVIDENCE_SOURCE_INVALID` | Evidence source 不是合法 ID/ref | 注册资源并使用 `name:relative/path`，移除绝对/普通路径 |
| `CANONICAL_RECORD_IN_GENERATED` | authority 被放进派生目录 | 移至 canonical path；重建 generated view |
| `ILLEGAL_STATUS_TRANSITION` / `INVALID_STATUS_HISTORY` | 历史边非法或不连续 | 从备份恢复历史；不要清空或改写过去事件 |
| `CLOSED_WITHOUT_VERIFICATION` | closed 缺有效 `verified_at` | 恢复正确验证时间；若未验证则保持未关闭状态 |
| `REOPENED_WITHOUT_CONTEXT` | reopened 缺 reason/affected IDs | 恢复重开事件原因和 `affected_ids` |
| `MISSING_ACTIVE_PLAN` / `MULTIPLE_ACTIVE_PLANS` | Active Plan 无法唯一解析 | 修正 `PROJECT.active_plan`；关闭或归档其他 open ExecPlan |
| `APPROVED_CLAIM_PROVENANCE` | approved Claim 来源不完整 | 修复 typed links/资源注册，或将 `approval_status` 撤回 `draft` |

不要通过移动 authority 到 `generated/`、删除 `status_history`、添加 `approval` 或复制绝对资源路径来“消除”错误；这些操作会制造第二套真相。
