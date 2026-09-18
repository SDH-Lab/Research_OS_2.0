# 验证、停止条件与人工验收

文件生成或程序运行完成只是执行事实。开始 Action 时写明什么算通过、检查当前候选版本的哪些部分，以及每项检查最多尝试几次。检查通过就停止；超过已约定次数时记录具体 blocker，决定修改、缩小范围或暂停，不无限追加审核。

## 按影响选择检查

| tier | 适用变化 | 必要证据 |
| --- | --- | --- |
| `scientific` | 数据、训练、指标、科学结论 | 相关语义、真实输入和结果来源 |
| `implementation` | 一般实现或转换 | 受影响行为与一个完整的小样本流程 |
| `presentation` | 文案或外观 | 相关内容或显示效果；改变数值含义时提高检查层级 |

检查列表由具体任务决定，不给所有任务设统一轮数。下面是已有 Action 的外观修订示例；次数及标准必须符合当前任务实际约定：

```bash
research-os action configure --project ./demo --id ACT-001 --definition '{"candidate_version":"report-v1","validation_plan":{"tier":"presentation","checks":[{"id":"render","description":"Inspect the rendered table for truncation and correct units.","max_attempts":2}]},"operation_scope":{"operations":["edit-report"],"paths":["writing/report.md"],"resources":[]}}'
research-os action approve --project ./demo --id ACT-001 --approval '{"grant_id":"GRANT-001","approver":"researcher","reason":"The researcher requested this report correction."}'
```

`approve` 记录实际用户授权。范围、批准者和原因不能由 Agent 编造；当前会话已有明确授权时直接记录并沿用，无需再次询问。相同 operations、paths、resources 集合继续复用批准；实质范围改变需要相应的新决定。它不替代操作系统、服务器或外部平台权限。

## 检查通过后停止，失败后有界修复

执行已约定的真实检查后记录证据：

```bash
research-os action check --project ./demo --id ACT-001 --check '{"check_id":"render","candidate_version":"report-v1","outcome":"pass","evidence":"Inspected the current rendered table; all columns and units are visible."}'
```

只在检查实际通过后记录 `pass`。失败写 `fail` 和具体证据；耗尽预算后系统建立 validation blocker，拒绝继续尝试。已通过的同一候选检查不能重复执行。新改动、新证据或标准变化通过带 `reason` 的配置修订记录；新候选使用新版本，检查列表只包含该变化需要重新验证的部分，旧证据仍保留。修改科学输入或协议不能通过缩减检查列表逃避对应语义检查。

其他 blocker 同样直接写入所属任务：

```bash
research-os action blocker --project ./demo --id ACT-001 --change '{"operation":"create","id":"BLOCK-001","category":"network","description":"The remote source is unreachable.","owner":"researcher","since":null,"next_unblock_action":"Restore the registered connection.","review_at":null,"root_cause":"Remote host unavailable.","critical_path":true}'
research-os action blocker --project ./demo --id ACT-001 --change '{"operation":"resolve","id":"BLOCK-001","resolved_at":null,"resolution":"Connection restored; historical resolution time is unknown."}'
```

类型包括 approval、network、resource、implementation、validation、dependency、other。稳定 ID 保留同一次问题的原因和解决记录；未知时间写 `null`，不要估算。解决旧问题后若再次发生，使用新 ID。

## 人工验收与收口

所有必要检查通过后，呈现候选及证据，记录实际验收者和理由。任务可以因可信负结果而完成；关闭并不要求得到正结果。对于已经执行中的 Action，真实验收后可使用：

```bash
research-os record status --project ./demo --id ACT-001 --to closed --accepted-by researcher --verified-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --reason "The researcher accepted the checked report and its stated limitations."
```

`--accepted-by` 不能充当虚构批准。机器绑定验收与当前候选版本，要求必要检查通过、授权匹配且没有活动 blocker。修改候选会撤销旧候选的验收。任务状态、产物版本验收、科学 Claim 批准和对外交付是各自明确的决定。

## 3. Official 与 diagnostic

Official 表示 provenance 链经过当前合同和 smoke 检查；它不表示结果必然为正，也不等于论文 Claim 已批准。Diagnostic Run 可用于排查 root、controller、evaluator 或性能问题，但不能直接进入正式 Evidence Packet。

Official Gate 的收据绑定 `contractHash`、已验证的 `manifestHash`、`projectId`、`projectAuthorityHash` 和 `codeRoot`，并明确写出：只允许 provenance promotion；不执行命令、不设置 Run official、不批准科学 Claim。Gate 每次都用当前 `PROJECT.md` 和 Diff 内快照重算完整比较；Project 资源改变后，旧 Diff 不能继续授权。

## 4. Waiver 的边界

Waiver 只能覆盖一个 `UNKNOWN`，或合同中已列明的一个 `ALLOWED_DEVIATION`。它必须绑定：

- waiver ID；
- contract ID 和 version；
- 完整 diff hash；
- 单一 field 和原状态；
- exact approved use；
- reason、approver；
- `approved_at` 和 `expires_at`。

因此 waiver 有用途范围、有时间窗口、不能复用到另一个 Diff、field、状态或用途。一个 waiver 不能覆盖多个 item，重复和多余 waiver 也会阻断。`BLOCK` 不可通过 waiver 绕过。

partial Manifest 只用于诊断，不能授权：即使缺失整个 evaluator 只产生一个 `UNKNOWN`，提供 waiver 也仍会因为 `manifestComplete:false` 而阻断。下面展示的是可授权的另一种情况：Manifest 本身完整且验证通过，但 Contract 额外要求一个没有被 Manifest 记录的叶级人工事实 `resolved_config.human_release_review`：

```json
[
  {
    "id": "WVR-001",
    "contract_id": "EXP-CONTRACT-001",
    "contract_version": "1.0.0",
    "diff_hash": "从当前 contract-diff.json 复制的 64 位哈希",
    "field": "resolved_config.human_release_review",
    "status": "UNKNOWN",
    "approved_use": "official baseline evidence",
    "reason": "PI completed and signed the release checklist outside the runtime config.",
    "approved_by": "PI",
    "approved_at": "2026-08-03T11:00:00.000Z",
    "expires_at": "2026-08-04T11:00:00.000Z"
  }
]
```

保存为 `waivers.json`，再把它作为 `experiment authorize --project ./demo --waivers "$(jq -c . waivers.json)"` 的参数。过期、尚未生效、用途不同、字段不同、状态不同或 Diff 不同都会失败。

`record new --type manifest` 只创建可逐步填写的 Defined 卡片；机器字段是 `null`，调用方不能通过 `--values` 伪造。`manifest-check` 返回 detached normalized JSON，不会声称已经写回卡片。把 detached snapshot 的 14 个调用方字段和 7 个机器字段复制进 canonical 卡片时，必须保留卡片自己的 ID、type、status、时间和 status history；这些 lifecycle 字段不属于 normalized Manifest snapshot。

`record status --to ready` 不是只看 JSON Schema。系统会从卡片精确抽取上述 21 个 snapshot 字段，重新计算 config、Project authority、输出和 normalized hashes，并与当前 `PROJECT.md` 比较。任何手工伪造、漏字段、语义壳、只读输出或 Project 漂移都会在写盘前失败，原卡片保持不变。同样的验证会在 `ready` 之后每次进入 `in_progress`、`review`、`verified`、`closed` 或 `reopened` 时重做，因此早先有效的卡片不能绕过后来的 Project 变化。

## 5. 人工审核的最小界面

日常不必通读所有卡片。优先查看 Exception Inbox：高影响 unknown；`BLOCK`/`UNKNOWN`；semantic smoke 失败；Scope、数据、方法或 Claim 变化；重开对象；Incident/Guardrail 候选；即将交付的 Claim。

摘要必须能下钻到原始 Contract、Manifest、Diff、Run、Result Acceptance 和 Evidence Packet。这样 Agent 可以维护机器信息，人仍能像 debug 代码一样检查每一个最小单元。

## 6. 何时停止并重开

遇到下列情况不要“补一个看起来合理的默认值”：实际 code root 不在批准列表；同名 controller 语义不等价；evaluator 状态无法证明；Manifest 与运行日志 commit 不一致；Artifact 来自旧缓存；Result Acceptance 无法解释异常；Claim 超出 Evidence Packet。

正确动作是记录 `UNKNOWN`/`BLOCK`、保留证据、要求修改或独立复核，并在修改后生成新的 Manifest 和 Diff。旧收据因 Diff 绑定而不能重放。
