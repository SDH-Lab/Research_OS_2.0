import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createRecord, updateRecordStatus } from '../../src/records/create.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../../src/lib/markdown.js';
import { preflightSession, registerBackgroundWork } from '../../src/session/controller.js';
import { recordActionCheck } from '../../src/actions/workflow.js';
import { discoverRecords } from '../../src/records/catalog.js';
import { makeProjectFixture } from '../helpers/fixtures.js';

const execution = await import('../../src/session/execution.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
async function edit(root, path, update) {
  const document = parseMarkdownDocument(await readFile(join(root, path), 'utf8'));
  await writeFile(join(root, path), serializeMarkdownDocument(update(document.attributes), document.body));
}
async function action(root, id, resources = [], dependencies = [], paths = [`outputs/${id}/**`]) {
  const { configureAction, approveActionScope } = await import('../../src/actions/workflow.js');
  await createRecord(root, 'action', { id, title: id, driver: 'RQ-001', acceptance: 'Checked output.', dependencies });
  await configureAction(root, id, {
    candidate_version: `${id}-v1`,
    validation_plan: { tier: 'implementation', checks: [{ id: 'sample', description: 'Run a sample.', max_attempts: 2 }] },
    operation_scope: { operations: ['execute'], paths, resources }
  });
  await approveActionScope(root, id, { grant_id: `GRANT-${id}`, approver: 'researcher', reason: 'Run this Action.' });
  await edit(root, `plans/actions/${id}.md`, attributes => ({ ...attributes, execution: { resources, writable_paths: paths, resource_observation: null } }));
  await updateRecordStatus(root, id, 'defined', { reason: 'Defined.' });
  await updateRecordStatus(root, id, 'ready', { reason: 'Ready.' });
}
async function fixture() {
  const root = await makeProjectFixture({ resources: {
    gpu0: { uri: 'ssh://server/gpu/0', role: 'compute', access: 'read-write' },
    gpu1: { uri: 'ssh://server/gpu/1', role: 'compute', access: 'read-write' }
  } });
  await edit(root, 'PROJECT.md', attributes => ({ ...attributes, foreground_objective: 'Accept a model and use it downstream.' }));
  await edit(root, 'plans/active.md', attributes => ({ ...attributes, writable_paths: ['outputs/**', 'artifacts/**'] }));
  return root;
}
const observe = () => ({ observed_at: new Date().toISOString(), source: 'ssh server nvidia-smi', available: ['gpu1'] });
const record = async (root, id) => [...(await discoverRecords(root)).values()].find(item => item.id === id);
async function artifact(root) {
  await mkdir(join(root, 'outputs/ACT-001'), { recursive: true });
  await writeFile(join(root, 'outputs/ACT-001/model.bin'), Buffer.from([0, 1, 2, 255]));
  await createRecord(root, 'artifact', { id: 'ART-001', title: 'Accepted model', producer_action: 'ACT-001', file: 'outputs/ACT-001/model.bin' });
  for (const status of ['defined', 'ready', 'in_progress', 'review']) await updateRecordStatus(root, 'ART-001', status, { reason: 'Candidate model checked.' });
}

test('accepted file version unblocks a downstream Action while its producer remains active', async () => {
  assert.equal(typeof execution.acceptArtifact, 'function');
  const root = await fixture();
  await action(root, 'ACT-001');
  await execution.claimExecution(root, 'ACT-001');
  await artifact(root);
  await action(root, 'ACT-002', [], ['ART-001']);
  let views = await execution.deriveExecutionReadiness(root);
  assert.equal(views.waiting.find(item => item.id === 'ACT-002').issues[0].code, 'ARTIFACT_NOT_ACCEPTED');
  const accepted = await execution.acceptArtifact(root, 'ART-001', { actor: 'researcher', evidence: 'Held-out evaluation and checkpoint provenance checked.' });
  assert.equal(accepted.attributes.status, 'closed');
  assert.equal(accepted.attributes.sha256.length, 64);
  assert.equal(accepted.attributes.acceptance.actor, 'researcher');
  assert.equal((await record(root, 'ACT-001')).attributes.status, 'in_progress');
  views = await execution.deriveExecutionReadiness(root);
  assert.deepEqual(views.runnable.map(item => item.id), ['ACT-002']);
  await writeFile(join(root, 'outputs/ACT-001/model.bin'), 'new model');
  views = await execution.deriveExecutionReadiness(root);
  assert.equal(views.waiting[0].issues.some(item => item.code === 'ARTIFACT_VERSION_CHANGED'), true);
  await assert.rejects(() => execution.claimExecution(root, 'ACT-002'), /ARTIFACT_VERSION_CHANGED/);
  await assert.rejects(() => execution.acceptArtifact(root, 'ART-001', { actor: 'researcher', evidence: 'accept again' }), /review|immutable|accepted/i);
});

test('an exact available GPU lane can be claimed while another lane is busy', async () => {
  assert.equal(typeof execution.claimExecution, 'function');
  const root = await fixture();
  await action(root, 'ACT-001', ['gpu1']);
  await action(root, 'ACT-002', ['gpu0']);
  const claimed = await execution.claimExecution(root, 'ACT-001', observe());
  assert.equal(claimed.attributes.status, 'in_progress');
  assert.deepEqual(claimed.attributes.execution.resources, ['gpu1']);
  assert.equal(claimed.attributes.execution.resource_observation.source, 'ssh server nvidia-smi');
  await assert.rejects(() => execution.claimExecution(root, 'ACT-002', observe()), /RESOURCE_UNAVAILABLE/);
  await action(root, 'ACT-003', ['gpu1']);
  await assert.rejects(() => execution.claimExecution(root, 'ACT-003', observe()), /RESOURCE_CONFLICT/);
});

test('claim rechecks exact write authority, live writer conflicts, and observation freshness', async () => {
  assert.equal(typeof execution.claimExecution, 'function');
  const root = await fixture();
  await action(root, 'ACT-001', ['gpu1']);
  await assert.rejects(() => execution.claimExecution(root, 'ACT-001', { ...observe(), observed_at: '2020-01-01T00:00:00Z' }), /RESOURCE_OBSERVATION_STALE/);
  await edit(root, 'plans/actions/ACT-001.md', attributes => ({ ...attributes, execution: { ...attributes.execution, writable_paths: ['outputs/other/**'] } }));
  await assert.rejects(() => execution.claimExecution(root, 'ACT-001', observe()), /EXECUTION_SCOPE_NOT_APPROVED/);
  assert.equal((await record(root, 'ACT-001')).attributes.status, 'ready');
});

test('concurrent claim attempts cannot allocate one lane twice', async () => {
  assert.equal(typeof execution.claimExecution, 'function');
  const root = await fixture();
  await action(root, 'ACT-001', ['gpu1']);
  await action(root, 'ACT-002', ['gpu1']);
  const results = await Promise.allSettled([
    execution.claimExecution(root, 'ACT-001', observe()),
    execution.claimExecution(root, 'ACT-002', observe())
  ]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal((await execution.deriveExecutionReadiness(root)).active.length, 1);
});

test('active write scopes wait without blocking an unrelated ready Action', async () => {
  const root = await fixture();
  await action(root, 'ACT-001', [], [], ['outputs/shared/**']);
  await action(root, 'ACT-002', [], [], ['outputs/shared/report.md']);
  await action(root, 'ACT-003');
  await execution.claimExecution(root, 'ACT-001');
  const views = await execution.deriveExecutionReadiness(root);
  assert.deepEqual(views.runnable.map(item => item.id), ['ACT-003']);
  assert.equal(views.waiting[0].issues.some(item => item.code === 'WRITER_CONFLICT'), true);
  await assert.rejects(() => execution.claimExecution(root, 'ACT-002'), /WRITER_CONFLICT/);
});

test('partial project updates block execution readers', async () => {
  const root = await fixture();
  await action(root, 'ACT-001');
  await mkdir(join(root, '.tmp'), { recursive: true });
  await writeFile(join(root, '.tmp/project-transaction.json'), '{}');
  await assert.rejects(() => execution.deriveExecutionReadiness(root), error => error.code === 'PROJECT_TRANSACTION_PENDING');
});

test('a stored observation cannot substitute for a fresh observation at resource claim', async () => {
  const root = await fixture();
  await action(root, 'ACT-001', ['gpu1']);
  await edit(root, 'plans/actions/ACT-001.md', attributes => ({ ...attributes, execution: { ...attributes.execution, resource_observation: observe() } }));
  await assert.rejects(() => execution.claimExecution(root, 'ACT-001'), /RESOURCE_OBSERVATION_REQUIRED/);
});

function background(actionId, path, status = 'running') {
  return { kind: 'subagent', task_id: `worker-${actionId}`, purpose: 'Produce a checked file.', action_id: actionId,
    readable_paths: [], writable_paths: [path], forbidden_changes: [], expected_artifacts: [],
    acceptance: 'Inspect the file.', owner: 'worker', status, blockers: [], receiver: 'foreground' };
}

test('generic CPU start and background dispatch cannot bypass missing dependencies', async () => {
  const root = await fixture();
  await action(root, 'ACT-001', [], ['ART-999']);
  await assert.rejects(() => updateRecordStatus(root, 'ACT-001', 'in_progress'), /DEPENDENCY/);
  await assert.rejects(() => registerBackgroundWork(root, background('ACT-001', 'outputs/ACT-001/**')), /claim|in_progress/i);
  assert.equal((await record(root, 'ACT-001')).attributes.status, 'ready');
});

test('foreground and background writes stay within the actual claimed allocation', async () => {
  const root = await fixture();
  await action(root, 'ACT-001', [], [], ['outputs/**']);
  await edit(root, 'plans/actions/ACT-001.md', a => ({ ...a, execution: { ...a.execution, writable_paths: ['outputs/a/**'] } }));
  await action(root, 'ACT-002', [], [], ['outputs/b/**']);
  await execution.claimExecution(root, 'ACT-001');
  await execution.claimExecution(root, 'ACT-002');
  const report = await preflightSession(root, { actionId: 'ACT-001', dependencies: [], resources: [], writablePaths: ['outputs/b/report.md'], unknowns: [] });
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.issues.some(i => i.code === 'EXECUTION_SCOPE_NOT_CLAIMED'), true);
  await assert.rejects(() => registerBackgroundWork(root, background('ACT-001', 'outputs/b/**')), /execution|allocation|claimed/i);
});

test('passing validation allows background delivery and acceptance to finish', async () => {
  const root = await fixture();
  await action(root, 'ACT-001');
  await execution.claimExecution(root, 'ACT-001');
  await registerBackgroundWork(root, background('ACT-001', 'outputs/ACT-001/**'));
  await recordActionCheck(root, 'ACT-001', { check_id: 'sample', candidate_version: 'ACT-001-v1', outcome: 'pass', evidence: 'Sample inspected.' });
  await registerBackgroundWork(root, background('ACT-001', 'outputs/ACT-001/**', 'candidate_ready'));
  await registerBackgroundWork(root, background('ACT-001', 'outputs/ACT-001/**', 'accepted'));
  await registerBackgroundWork(root, background('ACT-001', 'outputs/ACT-001/**', 'closed'));
  const plan = parseMarkdownDocument(await readFile(join(root, 'plans/active.md'), 'utf8')).attributes;
  assert.equal(plan.background_register[0].status, 'closed');
});

test('execution lanes require explicit compute registration instead of reserving input resources', async () => {
  const root = await fixture();
  await action(root, 'ACT-001', ['gpu1']);
  await edit(root, 'PROJECT.md', a => ({ ...a, resources: { ...a.resources, gpu1: { ...a.resources.gpu1, role: 'input-data' } } }));
  await assert.rejects(() => execution.claimExecution(root, 'ACT-001', observe()), /RESOURCE_NOT_COMPUTE/);
});
