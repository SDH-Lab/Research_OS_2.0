# 安装与第一个项目

## 前置条件

需要 Node.js 20 或更高版本，以及一个可写的工作目录。Obsidian 和 VS Code 不是初始化所必需的，但分别适合浏览 Vault 和编辑 Markdown。

在 Research OS 仓库根目录依次安装依赖、链接 CLI、安装并校验 Codex Skill：

```bash
npm install
npm link
research-os skill install --target "$HOME/.codex/skills"
research-os skill verify --target "$HOME/.codex/skills"
research-os guide locate
```

`skill verify` 的 `ok` 必须为 `true`，且 `packagedDigest` 与 `installedDigest` 相同。`guide locate` 返回当前运行包的 Core 版本、指南入口与 packaged Skill 路径；这是一条可发现路线，不要把返回的机器绝对路径写进 Project Vault。

`$research-os` 是 Codex Skill 的稳定名称，不需要把它安装成插件。Skill 负责告诉新 Session 如何调用 CLI、恢复 authority 和按任务定位指南；CLI 执行确定性检查与受限写入。新安装的 Skill 从新的 Codex Session 开始作为可发现能力使用。

不创建全局链接时，可在仓库根目录用正式 launcher `node bin/research-os.js` 替换示例中的 `research-os`。`src/cli.js` 是供测试和代码导入的 controller，不是命令行入口。

安装后先做一次诊断：

```bash
node bin/research-os.js --help
```

## 初始化一个研究项目

请选择一个尚不存在或为空的目录；初始化不会覆盖已有文件。下面的命令创建最小、**未配置**的研究 Vault 骨架：

```bash
research-os project init --target ./demo --id demo --title "Demo project" --stage research
```

输出中的 `setupRequired: true` 表示目录和 schema 已建立，但 objective、scope、capacity、resources、modules 和权限尚未被人确认。紧接着运行：

```bash
research-os doctor --project ./demo
research-os project setup-status --project ./demo
research-os session context --project ./demo
```

若 Doctor 报 Skill 缺失、digest 不一致或 Core 版本冲突，先按第 10 章恢复，不要继续写项目。`setup-status` 是只读报告：`missingAuthority` 列出必须补充或对齐的字段，`humanReview` 列出即使为空也必须由人确认其合理性的六类 authority，`nextAction` 给出下一项安全动作。`context` 可以定位文件，但未配置项目不能认领正式 Action。

查看已写入的项目控制面：

```bash
research-os project show --project ./demo
```

该命令输出一行稳定的 JSON，便于 shell 或其他工具读取；它展示当前记录，不代表默认值已经审核。

## 完成首次配置握手

人需要在 `PROJECT.md` 与 `plans/active.md` 审核并明确：唯一前台目标、完成条件、范围与非范围、resume next action、可写路径、时区与容量、资源与 access、适用模块、批准代码根和 canonical writing sources。空 resources/modules/code roots/writing sources 在某些阶段可以合理，但必须是有意识的审核结果，不能由 Agent 把“没发现”解释为“无需提供”。

先让 Agent 根据可引用的项目文件提出最小 diff，再由人补充遗漏的研究语义和 bias。批准后先验证，再按固定顺序记录审核状态：

```bash
research-os record validate --project ./demo
research-os doctor --project ./demo
research-os record status --project ./demo --id PLN-001 --to ready --reason "Human reviewed initial plan authority."
research-os record status --project ./demo --id PRJ-001 --to ready --reason "Human reviewed initial project authority."
research-os record validate --project ./demo
research-os doctor --project ./demo
research-os project setup-status --project ./demo
research-os session context --project ./demo
```

只有最后一次 `setup-status` 返回 `configured: true` 才完成控制面的首次配置。这个布尔值表示所需 authority 存在并记录了人工审核，不表示实验设计、Claim 或对外交付自动获批。

## 注册可迁移资源

Research OS Core 2.0.0 将资源根目录集中保存在 `PROJECT.md` 的 `resources` 注册表中。领域 records 只写可移植引用 `resource_name:relative/path`，例如 `experiment_results:EXP-001/run-01/metrics.json`，绝不复制本机绝对路径。注册表的每一项只有 `uri`、`role`、`access` 和可选的 `identity`；`access` 必须是 `read-only` 或 `read-write`。`role` 在 2.0.0 是非空描述性 string，不是隐藏枚举；使用团队稳定词汇，例如 `implementation`、`experiment-results`、`canonical-writing`，并由 access 决定能否作为输出。

下面三种 URI 都是合法的定位方式：

```bash
# 本机绝对目录
research-os project resource add --project ./demo --name experiment_results --uri /data/results --role experiment-results --access read-only
# 相对于当前 Vault 的迁移友好目录
research-os project resource add --project ./demo --name shared_data --uri ../shared-data --role input-data --access read-only
# 不会连接远端、只保存定位符的 SSH URI
research-os project resource add --project ./demo --name code --uri ssh://operator@compute.example.org/worktrees/demo --role implementation --access read-write --identity demo-main
```

可使用以下命令检查注册表和纯字符串解析结果；`resolve` 不会访问 SSH 主机或读取任何资源：

```bash
research-os project resource list --project ./demo
research-os project resource resolve --project ./demo --ref experiment_results:EXP-001/run-01/metrics.json
```

只有 `approved_code_roots` 中**完全相同的资源名**可被当作批准的代码根，例如 `code`。它不把 `/data/code` 之类绝对路径作子字符串匹配，也不会隐式批准 `code_backup`。当磁盘、挂载点或远端主机迁移时，只编辑 `PROJECT.md` 中该资源的一条 `uri`，既有领域 records 无需逐条改写。

系统没有自动批准代码根的 CLI，因为这一步是人的 authority 决定。确认 `code` 注册项确实对应本项目允许执行的实现后，在 `PROJECT.md` frontmatter 中把它加入精确列表；不要改 lifecycle 字段：

```yaml
approved_code_roots:
  - code
```

保存后立即运行 `research-os record validate --project ./demo`。若换成另一个实现资源，先由人审核，再修改这一处 allowlist；资源注册成功本身不等于代码已获批准。

若 `resolve` 报 `RESOURCE_NOT_FOUND`，先用 `resource list` 检查引用左侧的资源名是否拼写一致，再补回或更正该注册项；不要把临时绝对路径写进各个 domain record。`RESOURCE_PATH_ESCAPE` 表示引用带有绝对路径、`..` 或编码后的 traversal，应该改为资源根以内的相对路径。

## 打开 Vault

在 Obsidian 中选择 **Open folder as vault**，然后选取 `demo/`。在 VS Code 中则使用 `code ./demo` 或 “Open Folder”。两个工具都直接打开同一组本地文件；不要把科学事实复制到编辑器配置中。

初始化只创建未配置骨架中的四个核心入口：

- `AGENTS.md`：恢复工作的短入口、稳定规则与阅读顺序。
- `PROJECT.md`：项目身份、阶段、前台目标、Active Plan、模块和权威 source 槽位；其 record ID 是 `PRJ-001`，业务 project ID 仍是你提供的 `demo`。
- `plans/active.md`：唯一 Active ExecPlan；目标由 `PROJECT.md` 唯一保存；结构化 `resume_point` 保存最后验证点、exact next action、下一条命令/修改、必需文件、风险和重新预测触发条件。
- `.obsidian/app.json`：Obsidian 的最小配置；不保存研究事实。

随后按上述首次配置握手定义前台目标、完成条件、范围、可写路径和下一步，再创建与该工作实际相关的 records。初始化后的 Active Plan 只达到 Session Controller 可解析的 schema 结构，仍未达到人类审核后的可执行状态；不要把 `resume_point` 改回自由文本。

## 只在需要时启用模块

目录不会预先全部创建。比如开始管理实验时才启用 `experiments`：

```bash
research-os module enable --project ./demo --name experiments
```

这会创建 `experiments/README.md`，在 `PROJECT.md` 的 frontmatter 中加入排序后的模块名，并在正文的 `## Modules` 段加入链接。重复运行同一命令不会创建重复文件或重复链接。

允许的模块是 `research`、`experiments`、`evidence`、`writing`、`reviews`、`decisions`、`incidents`、`generated` 和 `archive`。

## 安全回滚

若你只新建了 `demo/` 但尚未初始化、且它仍为空，可以在其父目录执行：

```bash
rmdir demo
```

这条回滚建议仅适用于这个刚创建且为空的演示目录。不要据此删除已有或非空的 Vault；初始化会拒绝非空目标，以保护其中的文件。

资源注册的安全回滚是手动恢复 `PROJECT.md` 中刚添加的一项 registry entry（不要删除资源数据本身），然后运行 `resource list` 确认。若因手动编辑破坏了注册表，按上述四字段结构修复该单项；其余项目正文和 records 不应需要重写。
