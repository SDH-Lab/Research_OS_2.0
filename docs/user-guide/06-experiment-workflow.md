# 06 — 实验工作流：从意图到可用证据

本章适用于新研究项目和 rebuttal 实验。固定的是验证链，不是某个 TMI 项目的方法细节。

## 1. 一条实验的完成链

```text
Experiment Package
  → Implementation Manifest
  → Contract Diff
  → Mechanical + Semantic Smoke
  → Official Receipt
  → Run
  → Result Acceptance
  → Evidence Packet
```

GPU 停止不等于实验完成。只有结果经过验收并进入 Evidence Packet，才成为 Claim 和写作可以消费的证据。

## 2. 先固定意图：Experiment Package

开始写代码或派 Agent 前，至少记录：

- 用户原始任务和 Agent 的结构化复述，两者并列保留；
- 科学问题、为什么重要、变量和固定条件；
- 数据、split、模型、checkpoint、训练边界和 evaluator；
- Context & Bias：已有实现、默认假设、你特别在意的语义和容易忽略的限制；
- 看似相似但不等价的实现；
- 成功、可信负结果、无效结果和停止条件；
- 预期 Artifact，以及它准备支持哪个 Claim 或写作位置。

给 Agent 的 Context & Bias 提示可以直接使用：

```text
请先复述科学意图、不可妥协条件和未知项。列出至少两种“代码能跑但不等价”的实现。
在我确认前不要把未知项推断为默认值；实现后必须从实际代码和已解析配置生成 Manifest。
```

“不等价”不是语法差异。例如：控制器名字相似但更新顺序不同、使用了另一个 code root、evaluator 名称相同但处于 train 状态、split 文件名相同但样本身份不同。这些都需要精确检查。

## 3. Implementation Manifest：记录实际实现

Manifest 不是 Agent 的承诺，而是从实际 code root、commit、已解析配置和运行环境提取的快照。调用方只能提供以下 14 个字段；哈希、时间、解析后的输出和 Project authority 都由系统生成，不能由调用方伪造：

```json
{
  "code_root": "sample_code",
  "resolved_code_root": {
    "resource": "sample_code",
    "uri": "ssh://research.example.org/worktrees/sample_code",
    "identity": "sample-v1"
  },
  "entrypoint": "train.py",
  "commit": "abc1234",
  "resolved_config": {"batch_size": 16, "seed": 7},
  "data_and_split": {"dataset_root": "data:sample-v1", "manifest": "data:manifest.json", "split_function": "heldout-v1", "seed": 7, "class_or_domain_order": ["healthy", "disease"]},
  "model_and_checkpoint": {"model_class": "ExampleModel", "checkpoint": "models:base-v1.ckpt"},
  "training_boundary": {"trainable_parameters": ["adapter"], "loss": "cross_entropy", "sampler": "balanced", "gradient_accumulation": 1},
  "optimizer_scheduler": {"optimizer": {"name": "AdamW", "parameters": {"learning_rate": 0.001}}, "scheduler": {"name": "cosine", "parameters": {}}, "checkpoint_selection": "best-auroc", "early_stopping": {"mode": "enabled", "monitor": "auroc", "patience": 5}},
  "evaluator": {"implementation": "macro-auroc", "metrics": ["auroc"], "aggregation": "macro", "state": "eval"},
  "command": "python train.py --config configs/baseline.yaml",
  "environment": {"runtime": "python-3.11", "packages": {"torch": "2.5.0"}, "hardware": "cuda-12.1"},
  "output_location": "experiment_results:EXP-001",
  "expected_artifacts": ["experiment_results:EXP-001/metrics.json", "experiment_results:EXP-001/run.log"]
}
```

`commit` 是 Git object identity，必须是 7–64 位十六进制字符，例如 `abc1234`；不要把分支名、标签或 `synthetic-` 前缀写进该字段。运行前还要按第 01 章由人把 `code_root` 的资源名加入 `PROJECT.md.approved_code_roots`；注册资源本身不会自动批准它。

保存为 `manifest-input.json` 后运行：

```bash
research-os experiment manifest-check \
  --project ./demo \
  --manifest "$(jq -c . manifest-input.json)" \
  > manifest-normalized.json
```

命令从该项目的 `PROJECT.md` 核对 `approved_code_roots` 和所有资源引用；root、URI、identity 或输出资源不一致都会失败。`output_location` 必须指向 `access: read-write` 的 Project resource，而且每个 `expected_artifacts` 都必须位于该输出目录内。

四种可扩展结构仍有不可省略的语义核心：optimizer 和 scheduler 都要有非空 `name` 与 object 类型的 `parameters`；early stopping 使用 `{mode, monitor, patience}`，`enabled` 时 monitor 非空且 patience 为正整数，`disabled` 时后二者都为 `null`；结构化 metric 至少有非空 `name` 和 `definition`。框架特有字段可以作为额外 key 保留，但 `{x: true}` 之类的壳不能成为 runnable Manifest。

输出会增加配置/Manifest/Project authority 哈希、`resolved_at`、`resolved_outputs`、`project_authority` 和 `manifest_complete`。对象 key 顺序不影响哈希，数组顺序会影响哈希。此输出是 detached JSON；它不会自动写入 canonical Manifest 卡片。

## 4. Contract 与四种 Diff 状态

实验合同只有六个顶层字段。`requirements` 必须精确覆盖 Manifest 的全部 14 个调用方字段，不能只挑容易通过的字段。`semantic_checks` 可以在父字段要求一致的前提下增加叶级检查。下面的命令从已审核的输入生成一份完整合同：

```bash
jq '{
  id: "EXP-CONTRACT-001",
  version: "1.0.0",
  approved_use: "official baseline evidence",
  requirements: {
    code_root, resolved_code_root, entrypoint, commit, resolved_config,
    data_and_split, model_and_checkpoint, training_boundary,
    optimizer_scheduler, evaluator, command, environment,
    output_location, expected_artifacts
  },
  semantic_checks: [{
    name: "split identity",
    field: "data_and_split.split_function",
    required: .data_and_split.split_function,
    evidence: "Approved Experiment Package",
    risk: "A different split may leak evaluation data."
  }],
  allowed_deviations: []
}' manifest-input.json > contract.json
```

保存为 `contract.json` 后运行：

```bash
research-os experiment contract-diff \
  --project ./demo \
  --contract "$(jq -c . contract.json)" \
  --manifest "$(jq -c . manifest-normalized.json)" \
  > contract-diff.json
```

成功的 Diff 没有一个含糊的顶层 `status`；读取顶层 `summary`。上面的 14 个 mandatory fields 加一个 semantic check 全部通过时，关键形状是：

```json
{"manifestComplete":true,"summary":{"PASS":15,"BLOCK":0,"UNKNOWN":0,"ALLOWED_DEVIATION":0}}
```

只有 `manifestComplete:true`、`summary.BLOCK:0`，并且每个 `UNKNOWN`/`ALLOWED_DEVIATION` 都有精确有效 waiver，才可能继续 Official Gate；最终仍要通过两层 smoke。

- `PASS`：精确相等；字符串和数字不互相转换。
- `BLOCK`：已确认不一致，不可 waiver。
- `UNKNOWN`：声明的事实缺失。在完整 Manifest 中，它可以表示额外叶级事实未记录；在 partial 诊断中，它也可以表示整个字段缺失。前者可补查或由人提供一次性 waiver，后者不能绕过 Manifest 完整性规则。
- `ALLOWED_DEVIATION`：合同提前列明了精确实际值、风险、证据和 waiver ID；仍需提交对应 waiver。

每个 item 还带 `actualPresent`，因此“字段存在且值为 JSON `null`”与“字段不存在”不会混为一谈。Diff 内嵌 canonical Contract/Manifest snapshots、content hashes 和 Project authority identity；Gate 会重新计算全部 items，而不是只相信 `diffHash`。

`contract-diff` 也能读取防御性的 partial 外部 Manifest，便于诊断缺了什么；partial 中已经存在的字段仍会执行同样的语义、资源、输出可写性和 Artifact containment 检查。但只要 `manifestComplete:false`，它就永远不能生成 Official Receipt，waiver 也不能绕过完整性要求。可 waiver 的 `UNKNOWN` 必须来自一份已完整验证的 normalized Manifest，例如 Contract 额外声明了 `resolved_config.human_release_review`，而 Manifest 没有记录这个叶级事实；Contract 对整个 `resolved_config` 的 mandatory requirement 仍必须与 Manifest 精确一致。

诊断实验可以显式声明偏差，但不能把“差不多”写成 `PASS`。例如另一个 controller 只能记录为精确 deviation；`controller-v2` 与 `controller_v2` 不会被模糊匹配。

## 5. 两层 Smoke 和授权

Mechanical smoke 检查程序启动、前向/反向和预期 Artifact。Semantic smoke 检查模型类别、可训练参数、split、loss、evaluator 状态和数值锚点。程序退出码为零不能替代 semantic smoke。

两层都确认为 `pass` 后运行：

```bash
research-os experiment authorize \
  --project ./demo \
  --diff "$(jq -c . contract-diff.json)" \
  --mechanical-smoke pass \
  --semantic-smoke pass \
  --waivers '[]' \
  > official-receipt.json
```

收据只授权“把后续 Run 的 provenance 候选身份提升为 official 的下一步操作”。该命令不会执行 Manifest 的 `command`，也不会自己把任何 Run 改成 `official: true`。绕过门直接运行的结果只能登记为 diagnostic/candidate。

若 `manifestComplete:false`，授权会在处理 smoke 和 waiver 前直接阻断。这条完整性规则不可 waiver。

## 6. Result Acceptance 的五类

每个准备使用的 Run 必须落入一类：

1. 运行失败：没有完整输出；
2. 结果无效：协议、实现、缓存、来源或 evaluator 错误；
3. 有效正结果：可信且支持一个边界明确的 Claim；
4. 有效负结果（credible negative）：协议正确但不支持原假设，可用于缩小 Claim 或决定停止；
5. 不确定：证据不足，不能强行归因。

“可信负结果”不是失败。例如预注册的 controller 在正确 split、正确 evaluator、足够重复下没有改善，仍可能是有效信息。若实际跑错 root，即使数值很好也属于意图偏差，不能升为正式证据。

## 7. Evidence Packet：真正的实验交付物

Packet 至少包括：采用和排除的 Run；每个数字、表格和图的 provenance；解释和反证；限制和 protocol deviation；可以说/不能说的 Claim；response-ready 或 manuscript-ready 候选文字；写作目的地与同步要求。

常见事故的定位：

- wrong root：Contract Diff 的 `code_root` 为 `BLOCK`；
- controller 不等价：精确值不匹配，除非合同预先声明 deviation，否则为 `BLOCK`；
- evaluator 名称存在但状态缺失：相关路径为 `UNKNOWN`；
- evaluator 处于 train 状态：若合同要求 `eval`，则为 `BLOCK`；
- 结果数值正确但找不到输入 Run/Manifest：不能形成正式 Evidence Packet。

这些例子是通用检查思路，不自动成为某个 TMI 项目的共享 Guardrail。只有复现过、边界明确且经人批准的事故规则，才进入长期 Guardrail。

实验所属 Action 在执行前配置 scientific 检查计划、候选版本与任务预算，并沿用实际获批范围。正式训练前固定 epoch、学习率计划、划分和 evaluator；后续改变只重新检查受影响语义。Run 完成后及时形成 Result、安排真实验收，再更新 Action 状态，不能把退出码视为科学批准。具体操作见 [验证与验收](08-validation-and-human-gates.md)。
