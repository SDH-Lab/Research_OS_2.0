import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../src/project/project.js';
import { inspectProjectSetup } from '../src/project/setup-status.js';
import { rebaselineProject } from '../src/project/rebaseline.js';
import { createRecord, updateRecordStatus } from '../src/records/create.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../src/lib/markdown.js';
import { configureAction, approveActionScope, recordActionBlocker, recordActionCheck } from '../src/actions/workflow.js';
import { acceptArtifact, claimExecution, deriveExecutionReadiness } from '../src/session/execution.js';
import { checkpointSession, getSessionContext, renderPlanBody } from '../src/session/controller.js';
import { validateProject } from '../src/validation/validator.js';
import { buildViews } from '../src/views/generate.js';

// Every grant, acceptance, resource observation and data file below is synthetic.
// This script neither connects to compute servers nor performs scientific research.
const actor = 'SYNTHETIC-DEMO-ACTOR';
const coreRoot = fileURLToPath(new URL('../core/', import.meta.url));
let root;
async function edit(path, update) {
  const document = parseMarkdownDocument(await readFile(join(root, path), 'utf8'), path);
  const attributes = update(document.attributes);
  await writeFile(join(root, path), serializeMarkdownDocument(attributes, path === 'plans/active.md' ? renderPlanBody(attributes) : document.body));
}
const readAction = async id => parseMarkdownDocument(await readFile(join(root, `plans/actions/${id}.md`), 'utf8')).attributes;
async function action(id, title, resources = [], dependencies = []) {
  const paths = [`outputs/${id}/**`];
  await createRecord(root, 'action', { id, title, driver: 'RQ-001', purpose: `合成演示：${title}`, acceptance: '合成文件结构与来源检查通过。',
    dependencies, domain: 'coordination', size: 'small', writer: actor,
    execution: { resources, writable_paths: paths, resource_observation: null } });
  await configureAction(root, id, { candidate_version: `${id}-v1`, validation_plan: { tier: 'implementation',
    checks: [{ id: 'sample', description: 'Read the synthetic input and verify the complete sample transformation.', max_attempts: 1 }] },
    operation_scope: { operations: ['synthetic-demo'], paths, resources } });
  await approveActionScope(root, id, { grant_id: `SYNTHETIC-${id}`, approver: actor, reason: '合成演示授权；不是实际研究者对科研操作的批准。' });
  for (const status of ['defined', 'ready']) await updateRecordStatus(root, id, status, { reason: 'Synthetic demo task definition.' });
}
const observe = () => ({ observed_at: new Date().toISOString(), source: 'SYNTHETIC: gpu1 available, gpu0 busy; no server queried.', available: ['gpu1'] });

async function main() {
  if (process.argv.length > 3 || process.argv[2]?.startsWith('-')) throw new Error('Usage: node scripts/demo-workflow.js [new-output-directory]');
  if (process.argv[2]) { root = resolve(process.argv[2]); await mkdir(root); }
  else root = await mkdtemp(join(tmpdir(), 'research-os-demo-'));
  await initProject({ targetDir: root, coreRoot, projectId: 'synthetic-demo', title: '合成演示：非真实研究项目', stage: 'research', resources: {
    gpu0: { uri: './synthetic-resources/gpu0', role: 'compute', access: 'read-write' },
    gpu1: { uri: './synthetic-resources/gpu1', role: 'compute', access: 'read-write' }
  } });
  const resume = { last_verified_point: 'Synthetic setup prepared.', next_action: 'Review the synthetic change of direction.',
    next_command_or_edit: null, required_files: ['PROJECT.md', 'plans/active.md'], risks: ['Synthetic data only.'], reforecast_trigger: null };
  await edit('PROJECT.md', a => ({ ...a, foreground_objective: '合成案例：研究 ExampleModel 方法。' }));
  await edit('plans/active.md', a => ({ ...a, completion_conditions: ['Synthetic workflow demonstrated.'], scope: ['Synthetic local files only.'],
    out_of_scope: ['Real training, patient data and scientific conclusions.'], writable_paths: ['outputs/**', 'artifacts/**'], resume_point: resume }));
  for (const id of ['PLN-001', 'PRJ-001']) await updateRecordStatus(root, id, 'ready', { reason: 'Synthetic setup approval by SYNTHETIC-DEMO-ACTOR; not real project authorization.' });
  await createRecord(root, 'driver', { id: 'RQ-001', title: '合成研究方向', source: 'Synthetic scenario', question: '是否继续合成的 ExampleModel 方法任务？', actions: [] });
  await action('ACT-001', '旧方法任务');
  await action('ACT-002', '生成合成产物', ['gpu1']);
  await action('ACT-003', '消费已验收产物并完成报告', [], ['ART-001']);
  await action('ACT-004', '等待合成忙碌设备', ['gpu0']);
  await edit('research/questions/RQ-001.md', a => ({ ...a, actions: ['ACT-001', 'ACT-002', 'ACT-003', 'ACT-004'] }));
  const before = await getSessionContext(root);
  const rebaseline = await rebaselineProject(root, { approvedBy: actor, reason: '合成目标转向演示；不修改任何真实项目。',
    foregroundObjective: '合成案例：围绕 BaselineModel 流程验证与结果交付组织任务；不执行真实科学研究。',
    driver: { id: 'RQ-001', question: '合成的流程交付流程是否保持输入、验收与下一步一致？', closureConditions: ['Synthetic workflow evidence is inspectable.'] },
    plan: { completionConditions: ['Synthetic report accepted and next step saved.'], scope: ['Synthetic report-delivery workflow.'],
      outOfScope: ['Real training, scientific claims, and old-method experiments.'], resumePoint: { ...resume, next_action: 'Claim the available synthetic lane and prepare an artifact.' } },
    actions: ['ACT-001', 'ACT-002', 'ACT-003', 'ACT-004'].map(id => ({ id, disposition: id === 'ACT-001' ? 'cancel' : 'keep' })) });
  await claimExecution(root, 'ACT-002', observe());
  await assert.rejects(() => claimExecution(root, 'ACT-004', observe()), /RESOURCE_UNAVAILABLE/);
  await mkdir(join(root, 'outputs/ACT-002'), { recursive: true });
  await writeFile(join(root, 'outputs/ACT-002/model.json'), JSON.stringify({ synthetic: true, kind: 'format-example-not-a-trained-model', fields: ['source', 'version'] }));
  await createRecord(root, 'artifact', { id: 'ART-001', title: '合成文件版本，不是真实模型', producer_action: 'ACT-002', file: 'outputs/ACT-002/model.json' });
  for (const status of ['defined', 'ready', 'in_progress', 'review']) await updateRecordStatus(root, 'ART-001', status, { reason: 'Synthetic artifact prepared for acceptance.' });
  const pending = await deriveExecutionReadiness(root);
  assert(pending.waiting.find(a => a.id === 'ACT-003').issues.some(i => i.code === 'ARTIFACT_NOT_ACCEPTED'));
  const artifact = await acceptArtifact(root, 'ART-001', { actor, evidence: 'Synthetic format file reviewed; this does not accept a trained model or scientific result.' });
  await claimExecution(root, 'ACT-003');
  const producerStatus = (await readAction('ACT-002')).status;
  assert.equal(producerStatus, 'in_progress');
  await recordActionBlocker(root, 'ACT-003', { operation: 'create', id: 'DEMO-BLOCK-001', category: 'implementation',
    description: 'Synthetic report label needs confirmation.', owner: actor, since: null, review_at: null,
    root_cause: 'Demo label deliberately left undecided.', next_unblock_action: 'Confirm the synthetic-only label.', critical_path: true });
  await recordActionBlocker(root, 'ACT-003', { operation: 'resolve', id: 'DEMO-BLOCK-001', resolution: 'Synthetic-only label confirmed within this demo.' });
  const input = JSON.parse(await readFile(join(root, 'outputs/ACT-002/model.json'), 'utf8'));
  assert.equal(input.synthetic, true);
  await mkdir(join(root, 'outputs/ACT-003'), { recursive: true });
  const report = { synthetic: true, source: 'ART-001', source_sha256: artifact.attributes.sha256, fields: input.fields, scientific_result: false };
  await writeFile(join(root, 'outputs/ACT-003/report.json'), JSON.stringify(report, null, 2));
  assert.deepEqual(JSON.parse(await readFile(join(root, 'outputs/ACT-003/report.json'), 'utf8')), report);
  const check = { check_id: 'sample', candidate_version: 'ACT-003-v1', outcome: 'pass', evidence: 'Actually read the synthetic source, transformed its fields, and read back matching report JSON.' };
  await recordActionCheck(root, 'ACT-003', check);
  await assert.rejects(() => recordActionCheck(root, 'ACT-003', check), /already passed/);
  await updateRecordStatus(root, 'ACT-003', 'closed', { acceptedBy: actor, verifiedAt: new Date().toISOString(), reason: 'Synthetic acceptance: sample transformation passed; no research conclusion accepted.' });
  const checkpoint = await checkpointSession(root, { progress: ['Synthetic downstream report completed; producer remains active.'],
    artifacts: ['outputs/ACT-003/report.json'], discoveries: ['Accepted exact artifact permits downstream use before producer closure.'],
    decisions: ['All approvals and observations in this demo are synthetic.'], resumePoint: {
      lastVerifiedPoint: 'ACT-003 synthetic report accepted; ACT-002 still active.', nextAction: 'Review the remaining synthetic producer task and the busy resource.',
      nextCommandOrEdit: null, requiredFiles: ['plans/actions/ACT-002.md', 'plans/actions/ACT-004.md'], risks: ['No actual GPU observation or scientific result.'], reforecastTrigger: null } });
  await edit('PROJECT.md', a => ({ ...a, forecast_settings: { ...a.forecast_settings, as_of: new Date().toISOString().slice(0, 10) } }));
  const validation = await validateProject(root);
  assert.equal(validation.ok, true, JSON.stringify(validation.issues));
  assert.equal((await inspectProjectSetup(root)).configured, true);
  await buildViews(root);
  const after = await getSessionContext(root);
  const summary = { 说明: '全为合成演示：无真实授权、GPU 查询、训练、病人数据或科学结论。', 输出目录: root,
    目标之前: before.foregroundObjective, 目标之后: after.foregroundObjective, 旧任务: (await readAction('ACT-001')).status,
    生产任务: producerStatus, 产物验收: artifact.attributes.status, 下游任务: (await readAction('ACT-003')).status,
    资源演示: 'gpu1 已认领；gpu0 不可用时正确阻断。', 检查停止: '重复提交已通过检查被拒绝。',
    阻断记录: (await readAction('ACT-003')).blockers[0].status, 项目验证: validation.ok, 目标决定: rebaseline.decisionPath,
    检查点: checkpoint.path, 下一步: after.nextAction, 看板: 'generated/dashboard.md' };
  await writeFile(join(root, 'generated/demo-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
main().catch(error => { console.error(JSON.stringify({ error: error.message, code: error.code ?? null, output: root ?? null })); process.exitCode = 1; });
