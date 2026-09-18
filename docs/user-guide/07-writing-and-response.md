# 07 — 写作、Response 与交付闭环

本章适用于 revision、rebuttal 和 response。固定的是“问题—行动—证据—文字—稿件—交付”的可追溯结构，不固定具体套话，也不让 Agent 自动批准科学结论或对外交付。

## 1. 写作开始前的输入合同

正式起草 reviewer-facing Response 前，项目至少应具备：

1. Decision Letter、完整 Reviewer Comments 和补充编辑要求都已登记为 `PROJECT.resources`；
2. 每条 Comment 已拆成一个或多个 Concern；
3. 每个 Concern 的 Action、完成定义和依赖已明确；
4. 实验结果已经过 Result Acceptance，并形成关闭的 Evidence Packet；
5. 要使用的 Claim 已由人设为 `approval_status: approved`，且 Claim 到 Evidence 的链接没有断裂；
6. response、clean manuscript、marked manuscript 的 canonical source 已登记。

缺少其中一项时不能把 Concern 标为可关闭，也不能通过 delivery check。

## 2. 权威链和目录

固定主链是：

```text
Reviewer Comment
  → Concern
  → Action(s)
  → Evidence / Decision
  → approved Claim
  → Response Block
  → Manuscript Change
  → text + visual receipts
  → Concern closed
```

对应的 canonical 位置是：

```text
reviews/concerns/CON-001.md
plans/actions/ACT-001.md
evidence/packets/EVD-001.md
evidence/claims/CLM-001.md
writing/response/WRT-001.md
writing/changes/WRT-002.md
```

Reviewer Comment 不强制复制成另一张卡片。Concern 用 `source_comment_id` 标出原 Comment 编号，用 `source_ref` 指回已登记的 Decision Letter 或 review source。多个 Concern 可以有相同的 `source_comment_id`，这表示它们来自同一条复合 Comment。

## 3. Concern：先拆最小问题，再创建 Action

Concern 是 `driver_kind: concern` 的 Driver。必需的 review 定位字段是：

```yaml
driver_kind: concern
source: Reviewer 1, Comment 3
source_comment_id: R1-C3
source_ref: review:decision-letter.txt
question: Does the method remain effective under the registered endpoint?
actions:
  - ACT-031
  - ACT-032
```

`source_ref` 必须是已登记 resource reference，不允许绝对路径、`..` 或未登记资源。`actions` 必须列出关闭这个 Concern 所需的全部 Action；Response Block 的 `covered_actions` 要精确覆盖这组 ID，不能漏掉一个，也不能塞入另一个 Concern 的 Action。

拆分复合 Comment 时使用以下规则：

- 一个子问题可以独立验证、独立关闭或独立影响稿件，就拆成一个 Concern；
- 同一实验同时支持两个子问题，不代表它们必须合并；两个 Concern 可以引用同一 Evidence；
- 只需一个共同回答、不能独立判定的句子保留为一个 Concern；
- 进度统计用 Action，不用 Comment 字数或 Response 段落长度。

## 4. Response Block 的固定六部分

一个 `response_block` 使用固定信息结构，不使用固定套话：

| 逻辑部分 | authority 字段 | 检查重点 |
| --- | --- | --- |
| 1. 定位问题 | `concern` | 指向一个 canonical Concern |
| 2. 直接回答 | `direct_answer` | 单行、先给结论、无占位符 |
| 3. 证据或理由 | `evidence_or_reason`、`claims` | 关闭的 Evidence/Decision；Claim 已批准且 Evidence 不断链 |
| 4. 承认限制 | `limitations` | 写明边界；确实没有已识别限制时精确写 `none_identified` |
| 5. 稿件修改 | `manuscript_changes` | 指向 canonical Manuscript Change |
| 6. 覆盖确认 | `covered_actions` | 精确覆盖 Concern 的全部 Action |

另外保留 Writing Unit 的共同字段：`purpose`、`target_location`、`draft`、`synchronization_status`、`verification_result`。`target_location` 使用 `response:<comment-or-anchor>` 指向 response canonical source 中的位置；anchor 必须非空、单行、相对且有意义，不能含 `.`/`..` 路径段、绝对路径、反斜杠或 raw/encoded traversal。`R1-C1`、`sec:results` 都是有效 anchor。`draft` 是 reviewer-facing 完整候选块，`direct_answer` 是其中最先让 Reviewer 看见的结论。

`evidence_or_reason` 可以包含 Evidence 或 Decision：补实验用 Evidence；明确的范围取舍、无法执行但经人批准的理由可用关闭的 Decision。它只能引用 Evidence 或 Decision 记录。

## 5. 六类 Comment 的回应策略

下面固定的是顺序和检查点，不是英文句式模板：

| Comment 类型 | 推荐逻辑 |
| --- | --- |
| 澄清或表达不清 | 承认歧义 → 直接澄清 → 给出修订后的准确表述 → 标明修改位置 |
| 要求补实验或分析 | 重述最小 Concern → 说明已批准的协议和边界 → 报告已验收结果 → 解释与限制 → 标明稿件变化 |
| Reviewer 指出错误 | 明确认错 → 给出纠正 → 说明对主要结论的影响 → 列出位置和跨文件一致性检查 |
| 合理但超出范围 | 承认目标价值 → 说明经批准的边界/约束 → 给出可行替代证据或 Decision → 在限制或未来工作中落地 |
| 有依据的不同意 | 先承认 concern 背后的目标 → 给出定义和证据 → 尊重地限定不同意范围 → 修改文稿以减少误解 |
| 多子问题混合 Comment | 拆成多个编号 Concern → 每项先直接回答 → 最后汇总共同稿件修改 |

Agent 可以根据类型生成候选结构，但不能在没有 Evidence Packet 或 Decision 时补出结论，也不能把“听起来合理”当成 Claim approval。

## 6. Evidence-to-Writing Packet

实验链的真正写作交接物是 Evidence Packet，而不是一组散落的日志或表格截图。交接前至少检查：

- adopted/excluded Run 及其理由；
- 每个要进入文字的数字、表格和图的 locator；
- 解释、反证、限制和协议偏差；
- 可以支持与不能支持的 Claim；
- response-ready/manuscript-ready 候选文字；
- 目标 Response Block 和 Manuscript Change ID。

Response Block 的 `claims` 只能使用人工批准的 Claim。Claim 的 `evidence` 必须指向关闭的 Evidence；Evidence 的 source 必须继续下钻到 canonical record 或已登记 resource。pre-close 时只有该 Response 的 `concern` 所精确指向的当前 Concern 可暂处于 schema/history-valid 的 `review` 或 `verified`；所有其他传递 Driver——包括 Research Question 和另一 Concern——都必须 `closed`，不能共享这个例外。若走实验链，系统继续检查 `Result → Run → Experiment + Manifest` 的每个 frontmatter edge、schema、canonical location、status/history 与接受状态；正文 `[[RUN-001]]` 不能补上缺失的 `Result.run`。

进入 reviewer-facing graph 的 Claim、Evidence、Decision 正式字段也不能保留这些未完成标记：`UNKNOWN`、`TBD`、`FIXME`、`PENDING`、`PLACEHOLDER`、`??` 或 `{{...}}`。

## 7. 数字来源的机械检查

Response Block 和 Manuscript Change 使用：

```yaml
numeric_sources:
  - literal: 91.2%
    evidence: EVD-031
    locator: results:EXP-031/metrics.json
```

每项必须恰好有 `literal`、`evidence`、`locator` 三个字段：

- Response Block 的机械扫描字段恰好是 `direct_answer`、`draft`、`limitations`；Manuscript Change 的机械扫描字段是 `draft`；
- `literal` 必须逐字符出现在对应的上述 reviewer-facing 字段中；
- `evidence` 必须是关闭的 canonical Evidence；
- `locator` 必须是安全、已登记的 resource reference，并同时出现在该 Evidence 的 `sources` 中；
- 同一 literal 不能重复声明；没有出现在文字中的旧声明会被视为 stale；
- 出现在文字中的 decimal、percent 或 scientific-notation literal 若未声明会阻断。

机械扫描覆盖 `91.2`、`91.2%`、`2e-3`、`2E+3` 等字面量。纯整数（例如“3 cohorts”）、数字的语义是否正确、四舍五入是否合理、表格中的隐含数值和 Claim 是否过宽，仍需人工审核。不要为了通过扫描而把数字改成文字或删除 source；应该修正 Evidence 与 locator。

## 8. 一个逻辑 Manuscript Change，同步两个 source

`writing_kind: manuscript_change` 表示一次逻辑修改，不为 clean/marked 各建一张重复卡片：

```yaml
target_source_keys:
  - manuscript_clean
  - manuscript_marked
source_identities:
  manuscript_clean: clean-src-v7
  manuscript_marked: marked-src-v7
location_anchor: sec:results
change_summary: Added the accepted registered-endpoint result and its limitation.
response_blocks:
  - WRT-031
synchronization_status: synchronized
verification_result: passed
```

`target_source_keys` 必须恰好覆盖 clean 和 marked。`source_identities` 绑定两个实际 source snapshot，可不同，因为它们是两个文件；但 delivery 时两者的 `content_identity` 必须相同，证明去掉 marked 展示差异后，逻辑内容一致。

只有 `synchronization_status: synchronized`、`verification_result: passed` 且 record 已关闭，才可支持 Concern closure。位置锚点必须足以让人打开 canonical source 后定位变化。独立验证 Manuscript Change 时，其 pre-close Concern authority 只从 `response_blocks` 中全部 unique、canonical、有效的 Response Block 链接派生；任一链接缺失、无效、歧义或 noncanonical 都不会授予 open-Driver 例外。由某个 Response Block 验证该 Change 时，即使 `response_blocks` 还列出其他 Response，也只允许调用方 Response 的精确 Concern 使用例外。

## 9. 三个 canonical writing sources

`PROJECT.md` 中的每个 source snapshot 都有且只有三个字段：

```yaml
canonical_writing_sources:
  response:
    resource_ref: writing:response.tex
    source_identity: response-git-abc123
    content_identity: response-content-sha256
  manuscript_clean:
    resource_ref: writing:manuscript-clean.tex
    source_identity: clean-git-def456
    content_identity: manuscript-content-sha256
  manuscript_marked:
    resource_ref: writing:manuscript-marked.tex
    source_identity: marked-git-ghi789
    content_identity: manuscript-content-sha256
```

- `resource_ref` 回答“文件在哪里”；
- `source_identity` 回答“具体是哪一个 source snapshot”，两个 manuscript 文件可以不同；
- `content_identity` 回答“规范化逻辑内容是什么”，clean/marked 必须相同。

项目初期允许 `canonical_writing_sources: {}`；开始 delivery check 时必须恰好具备 `response`、`manuscript_clean`、`manuscript_marked`。

## 10. Coverage：哪些 Concern 真的可关闭

运行：

```bash
research-os writing validate-block --project ./demo --id WRT-031
research-os writing coverage --project ./demo
```

Coverage 按 `source_comment_id` 聚合 Concern，并为每个 Concern 列出 Action、Evidence/Decision、Claim、Response Block 和 Manuscript Change。报告顶层固定包含 `issues`，承载 candidate/catalog 的全局 path-specific 问题，包括 catalog Map key 与 `RecordRef.path` 不完全一致，不会把它们复制到每个 Concern。`closable:true` 表示当前 Response 精确链接的 Concern 在 `review` 或 `verified` 阶段已经具备关闭条件，不等于 record 已经关闭；其他传递 Driver 仍必须 `closed`，最终 delivery 也仍要求当前 Concern 实际 `closed`。可关闭要求：

CLI 在 `closable:false` 时返回 validation exit 3，同时仍把完整 JSON 报告写到 stdout。这与 schema-valid 不矛盾：例如 draft Claim、open Action、pending synchronization 都可以是合法 canonical records，却仍停在必须由人审批或核验的关口。Agent 应报告这些 blocker，不能为了获得 exit 0 自行把 Claim 改为 approved，或伪造 closed/synchronized/verified。

- 所有声明 Action canonical、有效且关闭；
- Action inputs/outputs/dependencies 类型正确且可解析；每个关闭 Action 的 `outputs` 非空、全部合法 canonical，且至少一个 output 被本 Concern 的 Evidence/Decision、Claim、Response 或 Manuscript Change closure graph 消费；Result output 必须由相关 Evidence `sources` 接纳；Action→Action 中间节点还必须关闭、canonical、属于同一 Concern，并出现在该 Concern 权威 `actions` 列表中，不能跨 Concern 借路；
- 至少一个有效 Response Block 精确覆盖所有 Action；
- Evidence/Decision 路径存在且关闭；
- 所有使用的 Claim 已批准且 Claim→Evidence 没有断裂；只有当前 Response Concern 可使用 `review`/`verified` 的 pre-close 例外，所有非当前 Driver 必须关闭；
- 所有引用的 Manuscript Change 已关闭、同步并核验；
- 没有 blocking issue。

如果 Concern 已被手工关闭但图仍不满足这些条件，系统报告 `CLOSED_CONCERN_NOT_CLOSABLE`，不会把历史状态当成事实正确性的替代品。

## 11. Delivery：检查元数据与收据，不冒充看过 PDF

交付需要恰好三个 rendered artifact：`response_pdf`、`manuscript_clean_pdf`、`manuscript_marked_pdf`。每个 artifact 都绑定 source identity、artifact reference、artifact identity，以及两张独立收据：

```json
{
  "kind": "response_pdf",
  "source_key": "response",
  "source_identity": "response-git-abc123",
  "artifact_ref": "artifacts:response.pdf",
  "artifact_identity": "response-pdf-sha256",
  "text_check": {
    "receipt_id": "TXT-031",
    "status": "pass",
    "artifact_identity": "response-pdf-sha256",
    "checked_at": "2026-08-04T10:00:00Z"
  },
  "visual_check": {
    "receipt_id": "VIS-031",
    "status": "pass",
    "artifact_identity": "response-pdf-sha256",
    "checked_at": "2026-08-04T10:10:00Z"
  }
}
```

系统只验证收据形状、状态、时间和 artifact identity 绑定。三个 artifact 的 `artifact_ref` 和 `artifact_identity` 必须分别全局唯一；六张 text/visual receipt 的 `receipt_id` 也必须全局唯一，同一 PDF 的 text 与 visual 检查不能复用一个 receipt。系统不会读取 PDF，也不会声称自动完成视觉检查。`visual_check` 必须来自一次真实的视觉审核流程；换了 PDF identity 后旧收据不能复用。

Delivery 还会阻断：coverage 不可关闭；相关 Concern/Action/Writing/Evidence 尚未实际关闭或已 reopened；Claim 未批准或传递 provenance 断链；reviewer-facing 正文字段或正式 Claim/Evidence/Decision authority 的任意嵌套 string leaf 含上述显式大写 marker；数字来源不完整；source identity 过时；clean/marked content identity 不同；缺 PDF 或独立 text/visual receipt。

Writing CLI 会递归检查 `reviews/concerns/`、`writing/response/`、`writing/changes/` 以下任意层级的 Markdown candidate。YAML 解析失败、缺 id/type、重复 ID、wrong kind、schema 错误、nested/noncanonical 文件名，以及没有被任何 Concern 引用的孤立 Response/Change 都是顶层 `issues` 中的 path-specific blocker；文件不会因为 catalog 无法解析就“消失”。`validate-block` 也合并 sibling candidate issues；请求 canonical 路径上损坏的 block 时返回结构化 validation exit 3，而不是误报 NOT_FOUND。

## 12. 完整例子：一个 Concern、两个 Action、一个实验 Claim

假设 Reviewer 要求补充注册 endpoint 的实验和写作解释：

```text
R1-C3
  CON-031  “注册 endpoint 是否改善？”
    ACT-031  执行已批准实验并形成 EVD-031
    ACT-032  把证据同步进 Response 和 manuscript
      EVD-031 ← RES-031 ← RUN-031 ← MAN-031 + EXP-031
      CLM-031 (approved) ← EVD-031
      WRT-031 response_block covers ACT-031, ACT-032
      WRT-032 manuscript_change ← WRT-031 + CLM-031
```

Response Block 的关键字段：

```yaml
writing_kind: response_block
concern: CON-031
direct_answer: Yes. The registered endpoint reached 91.2%, an improvement of 2.3 percentage points.
evidence_or_reason:
  - EVD-031
claims:
  - CLM-031
limitations: The accepted evidence covers one registered cohort and does not establish external-cohort generalization.
manuscript_changes:
  - WRT-032
covered_actions:
  - ACT-031
  - ACT-032
numeric_sources:
  - literal: 91.2%
    evidence: EVD-031
    locator: results:EXP-031/RUN-031/metrics.json
  - literal: "2.3"
    evidence: EVD-031
    locator: results:EXP-031/RUN-031/metrics.json
```

这里 `CLM-031` 只能表达已批准的注册 cohort/endpoint 结论。若 Reviewer 的问题还要求 external validation，应新增 Concern/Action，或用经人批准的 Decision 明确范围；不能让 Agent 扩张 `CLM-031`。

最终顺序是：验证 Response Block → 查看 coverage 中的阻断项 → 人工核对 Claim 和 diff → 生成三份 PDF → 分别完成 text/visual check → 用 delivery-check 验证绑定 → 人决定是否正式提交。
