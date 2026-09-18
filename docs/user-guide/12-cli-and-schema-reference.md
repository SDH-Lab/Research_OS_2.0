# 12 — CLI、Schema 与 ownership 精确参考

## CLI 命令目录

所有 option 都是成对的 `--name value`；缺失/重复/未知 option 返回 2。以下是完整公开路径：

| 命令 | 必需 option | 可选 option |
| --- | --- | --- |
| `research-os project init` | `--target --id --title --stage` | `--core` |
| `research-os project show` | `--project` | 无 |
| `research-os project setup-status` | `--project` | 无 |
| `research-os project rebaseline` | `--project --change` | 无 |
| `research-os project recover` | `--project` | 无 |
| `research-os action configure` | `--project --id --definition` | 无 |
| `research-os action check` | `--project --id --check` | 无 |
| `research-os action blocker` | `--project --id --change` | 无 |
| `research-os action approve` | `--project --id --approval` | 无 |
| `research-os action claim` | `--project --id` | `--observation` |
| `research-os action ready` | `--project` | 无 |
| `research-os artifact accept` | `--project --id --acceptance` | 无 |
| `research-os project resource add` | `--project --name --uri --role --access` | `--identity` |
| `research-os project resource list` | `--project` | 无 |
| `research-os project resource resolve` | `--project --ref` | 无 |
| `research-os project index add` | `--index --project --next-milestone` | `--project-uri` |
| `research-os project index list` | `--index` | 无 |
| `research-os module enable` | `--project --name` | 无 |
| `research-os record new` | `--project --type --id --title` | `--values` |
| `research-os record status` | `--project --id --to` | `--reason --affected-ids --verified-at --accepted-by` |
| `research-os record validate` | `--project` | 无 |
| `research-os record trace` | `--project --id` | 无 |
| `research-os session context` | `--project` | 无 |
| `research-os session preflight` | `--project --claim` | 无 |
| `research-os session background` | `--project --registration` | 无 |
| `research-os session checkpoint` | `--project --update` | 无 |
| `research-os session check-diff` | `--registration --changed-paths` | 无 |
| `research-os session disruption` | `--project --update` | 无 |
| `research-os experiment manifest-check` | `--project --manifest` | 无 |
| `research-os experiment contract-diff` | `--project --contract --manifest` | 无 |
| `research-os experiment authorize` | `--project --diff --mechanical-smoke --semantic-smoke --waivers` | 无 |
| `research-os writing coverage` | `--project` | 无 |
| `research-os writing validate-block` | `--project --id` | 无 |
| `research-os writing delivery-check` | `--project --rendered-artifacts` | 无 |
| `research-os view build` | `--project` | 无 |
| `research-os view clean` | `--project` | 无 |
| `research-os view show` | `--project --name` | 无 |
| `research-os forecast calculate` | `--project` | 无 |
| `research-os core upgrade-preview` | `--project --candidate-core` | 无 |
| `research-os core upgrade-apply` | `--project --candidate-core --preview-hash` | 无 |
| `research-os skill install` | `--target` | 无 |
| `research-os skill verify` | `--target` | 无 |
| `research-os guide locate` | 无 | 无 |
| `research-os doctor` | `--project` | 无 |

退出码：0 成功；2 用法错误；3 validation/Doctor/upgrade 不通过；4 授权被阻断；5 写入冲突；6 对象不存在；7 I/O 或未分类 Research OS 错误。

## CLI、Skill 与指南定位

`research-os` 的公开可执行入口是 package `bin/research-os.js`；全局或本地 npm link 最终都必须经过这个 launcher。仓库内诊断的等价形式是 `node bin/research-os.js`。`src/cli.js` 仅导出 importable controller，不能作为直接命令，也不能用其测试结果代替安装边界测试。

`research-os skill install --target ./codex-skills` 只安装固定清单内的 `$research-os` Skill 文件，使用 staging 与原子 rename；相同 digest 返回 `current`，冲突目录不会被覆盖。`skill verify` 比较 packaged/installed digest 并验证 frontmatter、固定文件清单、普通文件类型与 symlink 禁令。`guide locate` 从实际运行 package 推导 Core 版本、指南入口和 packaged Skill；返回路径用于当前 Session 定位，不能持久化为 Vault authority。

`project init` 输出 `setupRequired: true` 与下一条 `setup-status` 命令。`project setup-status` 只读比较 Project/Active Plan authority，返回 `configured`、`missingAuthority`、`humanReview`、`authoritySources` 和 `nextAction`；它不自行填写或批准科学语义。

## Guide 的机械检查边界

发布检查会从普通代码块、行内代码，以及带 `-`、`*`、`+`、数字列表、`>` 引用和可选 `$` 提示符的命令示例中提取 `research-os` 调用，并与上表的同一份运行时 command spec 比较；普通叙述中的产品名不会被当作命令。链接检查则由精确锁定版本的 CommonMark AST parser 解析整份 Markdown，再遍历真实的 inline link、image、definition 与 reference 节点；不会用物理行正则猜测 authority。full、collapsed、shortcut 使用标准标签折叠和 first-definition 语义，并支持 escaped `]`、多行 label、blockquote/list 内的 definition、标签后单次换行 destination、angle destination、同一行或下一行开始的多行 title，同时保持 title 与后续 definition 的边界。fenced/indented code 和 HTML literal 不生成链接 authority；未解析的 full/collapsed 写法只在 AST text node 中产生 broken-reference 诊断。重复定义会报错，而且每一个真实本地 definition 目的地——包括未使用和重复定义——都必须是 guide root 内已有的普通非 symlink 文件；这样 definition 不能成为绕过 path containment 的隐藏通道。`HTTP`、`HTTPS` 与 `MAILTO` scheme 大小写不敏感，本地无 scheme 路径仍执行 traversal 检查。

## 公共字段与 type 字段

所有 canonical record 必须有 `schema_version,type,id,status,created,updated,status_history`。各 type 的必需领域字段如下；精确嵌套结构以 `core/schemas/*.schema.json` 为 authority。

| type | 必需领域字段 |
| --- | --- |
| project | project_id,title,stage,foreground_objective,active_plan,core_version,modules,resources,approved_code_roots,canonical_writing_sources,forecast_settings |
| exec_plan | completion_conditions,scope,out_of_scope,risks,blockers,dependencies,background_register,writable_paths,resume_point,disruption_mode,latest_checkpoint |
| driver | driver_kind,source,source_comment_id,source_ref,question,importance,scope,priority,closure_conditions,actions |
| action | driver,purpose,inputs,outputs,dependencies,acceptance,risks,writer,next_step,domain,size,blockers |
| artifact | producer_action,file,sha256,acceptance；文件哈希和验收由 artifact accept 写入 |
| experiment | scientific_question,variables,fixed_conditions,data_model_boundary,priors_and_bias,forbidden_shortcuts,outcome_definitions,stopping_conditions,acceptance |
| manifest | code_root,resolved_code_root,entrypoint,commit,resolved_config,data_and_split,model_and_checkpoint,training_boundary,optimizer_scheduler,evaluator,command,environment,output_location,expected_artifacts 及 machine-owned snapshot/hash 字段 |
| run | experiment,manifest,started_at,ended_at,run_status,logs,artifacts,failure_details,official |
| result | run,protocol_checks,numeric_checks,classification,adoption_reason,limitations,follow_up |
| evidence | sources,figures_and_numbers,interpretation,counterevidence,limitations,supported_claims,unsupported_claims,writing_destinations |
| claim | statement,evidence,conditions,prohibited_expansion,confidence_and_limitations,use_locations,approval_status,reopen_conditions |
| writing | writing_kind 以及对应 response_block/manuscript_change/internal_strategy/general 条件字段 |
| decision | question,options,selected_option,rationale,impact,approver,decision_date,reopen_conditions |
| incident/risk | kind,fact_or_risk,evidence,impact_scope,root_cause_status,remediation,reverification,guardrail_candidate |

## 状态转换

固定边是 `inbox → defined → ready → in_progress → review → verified → closed → reopened → defined`；另有 `in_progress → closed` 短路径。进入 closed 必须提供 `verified_at`；Action 还要求当前候选必要检查通过、范围获批、无活动 blocker 和实际人工验收；`closed → reopened` 必须提供 reason 和 affected IDs。Manifest 进入 ready 及以后还必须重新通过 normalized snapshot 与当前 Project authority 检查。

## Generated ownership

生成器唯一拥有 `generated/coverage.md`、`generated/dashboard.md`、`generated/exception-inbox.md`、`generated/forecast.json`、`generated/generation-manifest.json`。它们不是 canonical authority，可以通过 manifest allowlist 清理和重建；其他路径不可由 view clean 删除。

Action 在定义时可以未配置 workflow，但执行前需要 `candidate_version`、`validation_plan:{tier,checks:[{id,description,max_attempts}]}`、`operation_scope:{operations,paths,resources}` 和匹配的 scope approval。系统维护 `validation_checks`、`validation_revisions`、`validation_acceptance`、`scope_approvals`；不得通过创建输入伪造这些机器历史。`execution` 包含 resources、writable_paths、resource_observation。Blocker 包含稳定 id、category、critical_path、root_cause、起止时间、责任人与解决记录，未知时间为 null。

Action 另支持 deferred、cancelled、superseded，记录明确 reason；这些状态不是成功关闭。Artifact 的验收只能通过 artifact accept 绑定当前文件内容，不能用普通状态跳转伪造。项目目标转向的 rebaseline 输入一次覆盖每个未结束任务的取舍。
