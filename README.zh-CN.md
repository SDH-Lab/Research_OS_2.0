# Research OS

[English](README.md) | 简体中文

**让研究目标、实验依据和下一步工作，在不同会话之间保持一致。**

Research OS 是一个基于本地文件的研究项目管理工具。它通过 Markdown/YAML 记录、命令行工具和 Codex Skill，帮助研究者与 AI Agent 持续推进项目，并保留可检查的证据与决策。

当前版本：**2.0.0**。无需数据库或独立服务；项目文件可以用文本编辑器、VS Code 或 Obsidian 打开。

## 为什么使用

一个持续数周或数月的研究项目，需要不断回答：

- 当前要解决什么问题？目标是否已经改变？
- 哪些工作已经完成，哪些只是运行结束、尚未验收？
- 某项结论对应哪个实验、结果或文件版本？
- 现在卡在哪里，下一次会话应该从哪里继续？

Research OS 将这些信息保存在项目文件中，并用程序检查记录、依赖和文件版本的一致性。它适合跨会话、需要追溯实验依据或交接工作的研究项目。对于一次性的脚本修改和短任务，直接使用 Code Agent 通常更简单。

## 与 Codex 如何配合

Research OS 通过 `$research-os` Skill 和 CLI 接入 Codex，分工如下：

| 职责 | 负责方 |
| --- | --- |
| 理解需求、拆解操作、写代码、运行和排错 | Codex / Code Agent |
| 保存研究目标、重要任务、实验依据和决策 | Research OS 项目文件 |
| 检查状态、依赖、文件版本与写入范围 | Research OS CLI |
| 确定研究方向、接受科学结论和交付结果 | 研究者 |

Agent 在开始工作时读取当前项目状态，完成重要工作后更新结果与下一步。临时操作和逐步排错可以留在原生会话中，不需要为每一步建立研究任务。

当前没有将 Codex 会话列表与 Research OS 的任务自动双向同步。CLI 可由脚本或其他 Agent 调用；现成的技能与标准恢复流程面向 Codex。标准 `doctor` 仍会检查配套技能文件，因此采用其他执行方式时，也需完成下面的技能安装步骤。

## 核心功能

| 功能 | 解决的问题 |
| --- | --- |
| **目标同步调整** | 一次更新目标、研究问题、计划和旧任务的去留，保留调整依据 |
| **明确检查与停止条件** | 任务开始前声明必要检查和尝试次数；通过后停止重复检查，失败保留证据 |
| **已验收产物依赖** | 下游可使用已验收的具体文件版本，无需等待整个上游任务关闭 |
| **执行范围与资源检查** | 检查授权范围、所需资源和活动任务冲突，支持互不冲突的工作并行推进 |
| **阻断与授权记录** | 在所属任务中记录阻断原因和解决历史，在原范围内复用已有授权 |
| **简短恢复与历史追溯** | 当前计划保存当前状态，工作历史写入独立日志，恢复时按需读取 |

产物验收绑定文件摘要；文件发生变化后，原验收不能继续满足下游依赖。取消、推迟或替代的任务也不会被统计为成功完成。

## 快速开始

### 1. 安装并检查

需要 **Node.js 20 或更高版本**及 npm。克隆或下载本仓库，进入仓库根目录，执行：

```bash
npm ci
npm run check
npm link
```

`npm run check` 运行自动化测试和使用文档检查。`npm link` 将当前源码目录链接为本机的 `research-os` 命令；链接后应保留该目录。

如果只想在仓库内运行，可以使用：

```bash
node bin/research-os.js --help
```

后文的 `research-os` 命令均可替换为 `node bin/research-os.js`，并从仓库根目录执行。

### 2. 安装 Codex Skill

以下命令使用 Bash / Zsh 语法，优先使用 `CODEX_HOME` 指定的目录，未设置时使用默认目录：

```bash
research-os skill install --target "${CODEX_HOME:-$HOME/.codex}/skills"
research-os skill verify --target "${CODEX_HOME:-$HOME/.codex}/skills"
research-os guide locate
```

`skill verify` 应返回 `ok: true`，且已安装技能与打包技能的摘要一致。若该目录已有不同版本或自行修改的同名技能，安装器会报告冲突；先比较并保留需要的自定义内容，再明确替换。

安装后，在新的 Codex 会话中使用 `$research-os`。CLI 负责确定性的文件操作与检查，Skill 负责指导 Agent 如何恢复项目、调用命令和保存结果。

### 3. 先运行合成演示

```bash
node scripts/demo-workflow.js
```

脚本会创建独立的临时项目，运行完整流程，并输出结果摘要与项目路径：

```text
明确新目标 → 处理旧任务 → 验收产物 → 下游执行 → 检查与关闭 → 保存下一步
```

演示还会验证：忙碌资源不能被认领、未验收产物不能用于下游，以及已通过的检查不会重复执行。

所有数据、授权者与资源观察都是合成示例。演示不会连接计算服务器或运行真实模型训练。参见 [演示说明](docs/demo.md)。

### 4. 创建自己的研究项目

建议将研究项目放在源码仓库之外。以下命令在相邻目录创建一个项目文件夹（Vault）：

```bash
research-os project init \
  --target ../my-research-vault \
  --id my-research \
  --title "My Research Project" \
  --stage research

research-os doctor --project ../my-research-vault
research-os project setup-status --project ../my-research-vault
research-os session context --project ../my-research-vault
```

初始化创建的是**未配置的项目骨架**。返回 `setupRequired: true` 是预期行为，不表示已经可以开展正式实验。

接下来，在该项目中让 Agent 使用 `$research-os`，结合你的实际需求明确目标、完成条件、范围、资源与权限。完成配置并记录实际审核后，`setup-status` 应返回 `configured: true`。完整操作见 [安装与第一个项目](docs/user-guide/01-installation-and-first-project.md)。

## 日常使用

可以直接向 Codex 描述要做的工作，例如：

> 使用 $research-os 恢复当前项目，说明下一项可以推进的工作，并在已有授权范围内继续。

> 项目目标已经调整。先列出受影响的任务和建议取舍，根据我的决定同步更新项目记录。

> 检查这次结果的来源和验收条件，保存已完成的工作以及下一次会话的恢复点。

也可以通过 CLI 查看项目：

```bash
# 当前目标、活动任务、阻断与下一步
research-os session context --project ../my-research-vault

# 可以开始、正在执行和等待条件的任务
research-os action ready --project ../my-research-vault

# 检查项目记录并重建派生看板
research-os record validate --project ../my-research-vault
research-os view build --project ../my-research-vault
research-os view show --project ../my-research-vault --name dashboard
```

## 记录如何组织

以下为逐步开展工作后的示意结构，目录和记录按需创建：

```text
my-research-vault/
├── AGENTS.md                 # Agent 的项目入口
├── PROJECT.md                # 项目身份、唯一目标和资源配置
├── plans/
│   ├── active.md             # 当前计划与恢复点
│   ├── actions/              # 任务、检查、授权与阻断
│   └── logs/                 # 历史检查点
├── research/                 # 研究问题
├── experiments/              # 实验设计、实现记录与运行
├── artifacts/                # 可验收的具体文件版本
├── evidence/                 # 证据与结论记录
├── decisions/                # 重要决策与依据
└── generated/                # 可重新生成的看板与报告
```

项目文件是正式记录，`generated/` 是派生视图。原始数据、模型和大型结果文件可通过项目资源配置引用，无需复制进每份记录。

## 功能边界

- **运行完成、检查通过与科学结论被接受分别记录。** 系统检查不能代替研究判断。
- **资源认领依赖执行者提供的当次观察。** 系统不会自动查询远程 GPU，也不是训练调度服务。
- **已有授权仅在对应范围内复用。** 记录不能绕过操作系统或执行平台的权限。
- **检查点不是 Git 提交。** 保存检查点时会提示尚未提交的项目记录。
- **2.0.0 使用新的计划与任务格式。** 不提供旧格式兼容层或自动转换；旧项目采用新版时需明确整理范围。

本公开源码包只包含通用代码和合成示例。实际使用时生成的项目文件和命令输出可能包含你填写的路径、研究内容与结果，应与公开源码分开保存。详见 [公开发布说明](PUBLIC-RELEASE.md)。

## 文档

- [使用指南目录](docs/user-guide/README.md)
- [安装与第一个项目](docs/user-guide/01-installation-and-first-project.md)
- [任务检查、授权与验收](docs/action-workflow.md)
- [调整项目目标](docs/rebaseline.md)
- [产物依赖与资源认领](docs/execution.md)
- [合成演示](docs/demo.md)
- [CLI 与数据格式参考](docs/user-guide/12-cli-and-schema-reference.md)

## 开发与验证

```bash
npm ci
npm run check
```

2.0.0 公开包在发布前通过了 **442 项自动化测试**、文档检查与完整合成演示。这些检查验证系统行为，不代表某个真实研究结果已经通过科学验收。

源码集中在 `src/`，数据格式、规则和模板在 `core/`，Codex 技能在 `skills/research-os/`，测试在 `test/`。
