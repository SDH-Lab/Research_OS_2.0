# Core 发布与项目版本

`PROJECT.md.core_version` 固定项目使用的 Core 版本。安装新工具不会静默改写项目 pin，也不会批准新的研究范围。

2.0.0 使用新的 Active Plan、Action workflow 和 Artifact 格式。不保留旧格式读取路径、兼容层或自动数据转换。已有旧项目若要采用新版，需要单独明确整理范围和批准的研究记录处理方式；不能只改版本字符串后声称已经完成升级，也不能删除历史研究证据来通过验证。

## 查看并应用候选发布

对于已经符合候选格式的项目，现有 Core 发布命令提供明确预览与受检验的版本更新：

```bash
research-os core upgrade-preview --project ./demo --candidate-core ./candidate-core
research-os core upgrade-apply --project ./demo --candidate-core ./candidate-core --preview-hash APPROVED_SHA256
```

预览列出 schema、template 和 rule 差异、受影响文件和备份位置，不写 Vault。`APPROVED_SHA256` 必须替换为研究者已审核的实际预览 hash；候选内容改变会使旧 hash 失效。Apply 检查候选 schema 和状态规则，不负责把不兼容的研究卡片转换成新格式。

版本更新保留备份及操作收据。失败时按记录恢复；若报告中断或档案冲突，先核对具体路径与错误，保留现场，不能跳过检查或手工伪造成功。Core 升级档案与 project rebaseline 的事务恢复是不同操作。

更新成功后使用与新 pin 匹配的工具，重新安装并验证对应 Skill，再运行 Doctor 和项目验证：

```bash
research-os skill install --target "$HOME/.codex/skills"
research-os skill verify --target "$HOME/.codex/skills"
research-os doctor --project ./demo
research-os record validate --project ./demo
```

Skill 安装遇到已有不同内容时不会覆盖；按 [维护与备份](10-maintenance-troubleshooting-and-backup.md) 核对并保留旧副本后处理。自动检查通过只证明检查覆盖的发布边界；新会话能力发现和实际科研结果分别验收。
