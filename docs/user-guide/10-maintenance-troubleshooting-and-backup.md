# 10 — 维护、故障定位与备份

## 备份策略

Project Vault 使用 Git 保存 canonical Markdown 与检查点 JSON 日志；训练数据、模型和 Raw Run 留在资源注册指向的位置。提交前运行 `research-os record validate --project ./demo`。阶段关闭前另做可恢复的仓库备份，并验证恢复演练；不要把生成视图当备份。

## 维护节奏

- 每个 Session：把真实进度、发现和决定写入检查点日志，更新 Active Plan 当前恢复点。
- 每周：审核 scope、Action blocker、容量、预测变化与后台登记。
- 阶段关闭：关闭或转移 Action，归档完成计划，重建视图并保存 retrospective。

这些动作只维护会改变决策的 authority。可从 records 推导的计数、链接和视图不重复手抄。

## Doctor 的读法

运行 `research-os doctor --project ./demo`。`error` 使退出码为 3；`warning` 需要安排修复但不单独阻断；`not_applicable` 表示该检查在当前项目没有持久对象。每个 issue 都给出 evidence path，并把下一步明确分成三类：`executable` 是已知能改变该状态的恢复命令，`diagnostic` 只会复查或补充诊断，`manual` 要求人工检查、隔离或从可信备份恢复。不要把 diagnostic command 误当成自动修复。Doctor 只读，不会替你修文件。

`skill-installation` 检查把 packaged Skill 摘要与 Codex skills root 下的已安装摘要进行比较。默认 skills root 是 `CODEX_HOME` 下的 `skills`；未设置时使用当前用户的 `.codex/skills`。`SKILL_MISSING` 会给出针对 exact root 的 executable recovery，例如 `research-os skill install --target ./codex-skills`；应执行 Doctor 返回的真实目标，而不是照抄示例目录。摘要不一致、frontmatter/文件清单不合法或存在 symlink 时会返回 error 与 manual recovery：先检查并保留本地内容，再决定显式替换，Doctor 和 installer 都不会静默覆盖冲突。evidence 中的 `packaged=` 与 `installed=` 摘要相同才表示当前 Skill 与运行中的 Core 包一致。

正常安装或确认当前能力时使用：

```bash
research-os skill install --target "$HOME/.codex/skills"
research-os skill verify --target "$HOME/.codex/skills"
research-os guide locate
```

缺失安装可以由 `skill install` 创建；相同摘要重复安装返回 `current` 且不重写文件。`mismatch` 或 `invalid` 不会被 installer 覆盖，因为目录可能包含本地修改或不安全链接；先保存并检查该目录，再由人明确决定替换策略。`guide locate` 若失败，说明当前 CLI 包不完整或入口不是预期发行物，不能靠猜 checkout 路径继续。checkout-local 诊断只使用 `node bin/research-os.js`。

本发行版的依赖权威是一个明确的窄契约：`package.json` 中 `dependencies` 与 `optionalDependencies` 必须使用精确 SemVer，`package-lock.json` 必须是 npm lockfile v3。Doctor 会验证根包身份、每个可达依赖、integrity，以及每条依赖边声明的范围是否包含实际目标版本。npm v2、根依赖范围、alias、file 或其他非精确根 spec 不会被误报为“锁损坏”，而会返回 `DEPENDENCY_LOCK_UNSUPPORTED`；这表示需要使用受支持的发行包或由人工升级维护契约。Doctor 只在受保护的本地 npm v3 hidden lock 已完整预检、确定能生成通过同一 verifier 的候选，而且 canonical package 目录当前具有原子发布需要的 write 与 search 权限时提供 `executable` 修复；否则 recovery 是 `manual`。这个权限判断是只读的，不会用“试写临时文件”污染目录。实际修复会重新完成候选预检，并在发布前再次检查相同目录权限，才原子替换公开 lock；其间若权限或路径 authority 改变，修复会失败并保留原公开 lock 字节。

## 常见恢复

- frontmatter 损坏：从 Git 或最近备份恢复该文件，再运行 `research-os record validate --project ./demo`；不要猜测 machine-owned lifecycle 字段。
- broken link 或 duplicate ID：从 validation 的精确路径找到来源，修 typed ID 或正文 wikilink；ID 冲突时保留已有 authority，给新对象分配新 ID。
- 资源迁移：只修改 `PROJECT.md.resources.<name>.uri`，再运行 `research-os project resource resolve --project ./demo --ref results:run/metrics.json`。
- stale、普通文件 tamper 或普通文件形式的 invalid manifest：直接运行 `research-os view build --project ./demo`，它会以事务方式覆盖五个 allowlisted generated 文件；Doctor 会把它标为 `executable` recovery。
- symlink、目录或其他非普通 generated 路径：不要让 Agent 跟随或覆盖；先按 Doctor 的 `manual` instruction 人工检查并隔离该路径，再重建视图。
- 后台 writer 冲突：关闭、取消或缩小 Active Plan 中旧 registration，再重新 preflight。
- `DEPENDENCY_LOCK_UNSUPPORTED`：不要直接手改 lock 来消除提示；确认安装的是本发行版所声明的精确版本 npm v3 包，或由维护者明确扩展契约。`DEPENDENCY_LOCK_INVALID` 才表示当前受支持的 lock 内容不一致。
- `SKILL_MISSING`：对 Doctor 报告的 exact skills root 运行 `skill install`，再运行 `skill verify` 和 Doctor；新 Session 才能依靠 `$research-os` 做冷启动。
- `SKILL_DIGEST_MISMATCH` / `SKILL_TREE_INVALID` / `SKILL_STRUCTURE_INVALID`：保留冲突现场并人工比较，不要让 Agent 自动覆盖；只有确认旧目录可替换后才执行明确的安装替换。
- `CORE_VERSION_MISMATCH`：Project pin 与当前 CLI/Core 不一致；选择匹配发行版或按第 11 章做有预览、有审核的 Core upgrade，不能只改版本字符串。
- `project setup-status` 返回 `configured: false`：按 `missingAuthority` 和 `humanReview` 完成首次配置；不要把空字段自动补成推测值。

## 安全删除

只有未篡改的 `generated/generation-manifest.json` 精确列出的五个普通文件可由 `research-os view clean --project ./demo` 删除；invalid/tampered manifest 或 output 会让 clean 拒绝删除。canonical records、Core 升级备份和外部资源不可用通配符删除。先用 Git 或独立备份确认可恢复，再人工归档废弃 authority；不要让 Agent 推断删除范围。
