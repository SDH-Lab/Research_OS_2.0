# 可重复的合成流程演示

在 Core 仓库根目录运行：

```bash
node scripts/demo-workflow.js
```

脚本调用生产 API，创建一个独立临时 Vault，最后输出中文 JSON 摘要和绝对输出路径。也可指定一个**尚不存在**的目录，其父目录必须已存在：

```bash
node scripts/demo-workflow.js ./meeting-demo-01
```

每次运行生成独立结果。已有目录会被拒绝，不覆盖、不清理旧输出；失败现场同样保留，并在错误中打印路径。不要把真实研究 Vault 作为输出目录。

## 演示的完整流程

1. 初始化并配置一个明确标为合成的项目，初始目标为 ExampleModel 方法研究。
2. 使用 `rebaselineProject` 把目标改为围绕流程验证与结果交付组织工作，取消旧任务，保留新的生产、下游和资源等待任务。
3. 提交合成资源观察：`gpu1` 可用、`gpu0` 忙碌。生产任务认领 `gpu1`；请求 `gpu0` 的任务被阻断。
4. 生成一个标明“并非训练模型”的 JSON 文件。未验收时下游等待；通过 `acceptArtifact` 接受该文件版本后，下游可以认领，生产任务仍是 `in_progress`。
5. 在下游任务记录并解决一个实现 blocker，保留原记录。
6. 实际读取输入、转换字段、生成并回读报告，记录通过的必要检查。再次提交同一通过检查必须被拒绝。
7. 写入明确标为合成的验收，关闭下游任务；保存检查点、验证项目并生成看板。
8. 再读取当前上下文，展示新目标、剩余任务和下一步。

脚本中的验证判断会在行为不符合预期时终止运行，不会伪造成功摘要。它使用生产初始化、记录、工作流、目标调整、执行、检查点和视图 API，不依赖测试 fixtures。

## 结果在哪里

JSON 摘要中的 `输出目录` 指向这次新建的 Vault。可查看：

- `PROJECT.md`：单一当前目标。
- `decisions/DEC-001.md`：目标前后变化与任务取舍。
- `plans/actions/ACT-001.md`：被取消的旧任务。
- `plans/actions/ACT-002.md`：仍在执行的生产任务及资源认领。
- `artifacts/ART-001.md`：已验收文件的 SHA-256 与合成验收记录。
- `plans/actions/ACT-003.md`：已解决 blocker、检查证据和关闭记录。
- `plans/actions/ACT-004.md`：尚未取得所需资源的任务。
- `plans/active.md` 与 `plans/logs/`：当前恢复点及独立历史。
- `outputs/ACT-003/report.json`：实际生成并回读核对的合成报告。
- `generated/dashboard.md`、`generated/demo-summary.json`：看板和本次结果摘要。

若已安装对应 CLI，可把这次输出路径作为项目路径，继续只读展示：

```bash
research-os session context --project ./meeting-demo-01
research-os action ready --project ./meeting-demo-01
research-os record validate --project ./meeting-demo-01
research-os view show --project ./meeting-demo-01 --name dashboard
```

## 2–3 分钟组会使用

先运行脚本并保留这次输出。现场依次展示目标变更决定、生产任务未结束但产物已验收、下游任务的检查和关闭记录，最后展示当前恢复点。静态截图应从这次实际输出取得，并标明合成演示；不要把示例截图作为真实项目证据。

所有批准者均为 `SYNTHETIC-DEMO-ACTOR`，所有授权、验收与 GPU 观察都是合成情境。脚本不连接服务器，不查询真实 GPU，不运行训练，不含患者数据，也不建立科学结论。它证明一次本地系统流程的实际行为，不代表真实研究项目、安装边界或全新 Agent 会话已经验收。
