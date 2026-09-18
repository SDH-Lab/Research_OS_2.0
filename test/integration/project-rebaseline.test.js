import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeProjectFixture, makeReadyActionFixture } from '../helpers/fixtures.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../../src/lib/markdown.js';
import { discoverRecords } from '../../src/records/catalog.js';
import { summarizeActions } from '../../src/views/forecast.js';
import { createRecord } from '../../src/records/create.js';
import { rebaselineProject, publishProjectChanges, assertProjectTransactionClear, recoverProjectTransaction } from '../../src/project/rebaseline.js';
import { isScheduledActionStatus, isSuccessfulActionStatus } from '../../src/records/action-state.js';
import { validateProject } from '../../src/validation/validator.js';

async function document(root, path) { return parseMarkdownDocument(await readFile(join(root, path), 'utf8'), path); }
async function fixture() {
  const root = await makeProjectFixture();
  await makeReadyActionFixture(root);
  const project = await document(root, 'PROJECT.md');
  await writeFile(join(root, 'PROJECT.md'), serializeMarkdownDocument({ ...project.attributes, foreground_objective: 'Evaluate ExampleModel method.' }, project.body));
  for (let index = 2; index <= 4; index++) await createRecord(root, 'action', { id: `ACT-00${index}`, title: 'Old method work', driver: 'RQ-001', acceptance: 'Checked evidence.' });
  const change = {
    approvedBy: 'Researcher', reason: 'Prioritize pipeline validation and report delivery.',
    foregroundObjective: 'Validate BaselineModel pipeline for report delivery.',
    driver: { id: 'RQ-001', question: 'Is pipeline ready for report validation?', closureConditions: ['Validation results accepted.'] },
    plan: { completionConditions: ['Report package accepted.'], scope: ['Pipeline validation'], outOfScope: ['ExampleModel ablations'], resumePoint: { last_verified_point: 'Report direction approved.', next_action: 'Validate report package.', next_command_or_edit: null, required_files: ['PROJECT.md', 'plans/active.md'], risks: [], reforecast_trigger: null } },
    actions: [{ id: 'ACT-001', disposition: 'keep' }, { id: 'ACT-002', disposition: 'cancel' }, { id: 'ACT-003', disposition: 'defer' }, { id: 'ACT-004', disposition: 'supersede', replacement: 'ACT-001' }]
  };
  return { root, change };
}

test('rebaseline publishes approved objective, driver, plan and explicit dispositions together', async () => {
  const { root, change } = await fixture();
  const historical = '# Historical experiment: ExampleModel\n';
  await mkdir(join(root, 'archive'), { recursive: true });
  await writeFile(join(root, 'archive', 'experiment.md'), historical);
  const result = await rebaselineProject(root, change);
  assert.equal((await document(root, 'PROJECT.md')).attributes.foreground_objective, change.foregroundObjective);
  assert.equal((await document(root, 'research/questions/RQ-001.md')).attributes.question, change.driver.question);
  assert.deepEqual((await document(root, 'plans/active.md')).attributes.completion_conditions, change.plan.completionConditions);
  assert.equal((await document(root, 'plans/actions/ACT-001.md')).attributes.status, 'ready');
  for (const [id, status] of [['ACT-002', 'cancelled'], ['ACT-003', 'deferred'], ['ACT-004', 'superseded']]) {
    const action = (await document(root, `plans/actions/${id}.md`)).attributes;
    assert.equal(action.status, status);
    assert.equal(isSuccessfulActionStatus(status), false);
    assert.equal(isScheduledActionStatus(status), false);
    assert.equal(action.verified_at, undefined);
  }
  const summary = summarizeActions(await discoverRecords(root), { asOf: new Date().toISOString().slice(0, 10), timezone: 'UTC', defaultWeeklyUnits: 5, weeks: [] });
  assert.deepEqual(summary.remainingItems.map(item => item.actionId), ['ACT-001']);
  assert.equal(summary.throughputHistory.weeks.reduce((sum, week) => sum + week.closed, 0), 0);
  const decision = await document(root, result.decisionPath);
  assert.equal(decision.attributes.approver, 'Researcher');
  assert.match(decision.body, /Evaluate ExampleModel method/);
  assert.match(decision.body, /BaselineModel/);
  assert.match(decision.body, /ACT-004/);
  assert.equal(await readFile(join(root, 'archive/experiment.md'), 'utf8'), historical);
  await assertProjectTransactionClear(root);
  const validation = await validateProject(root);
  assert.deepEqual(validation.issues, []);
  assert.equal(validation.ok, true);
});

test('missing approval, incomplete decisions and bad replacement fail without authority writes', async () => {
  const { root, change } = await fixture();
  const before = await readFile(join(root, 'PROJECT.md'), 'utf8');
  for (const invalid of [{ ...change, approvedBy: '' }, { ...change, actions: change.actions.slice(1) }, { ...change, actions: change.actions.map(a => a.id === 'ACT-004' ? { ...a, replacement: 'ACT-002' } : a) }]) {
    await assert.rejects(rebaselineProject(root, invalid), { code: 'VALIDATION' });
    assert.equal(await readFile(join(root, 'PROJECT.md'), 'utf8'), before);
  }
  await assertProjectTransactionClear(root);
});

test('publish detects stale input snapshots before changing any file', async () => {
  const root = await makeProjectFixture();
  const before = await readFile(join(root, 'PROJECT.md'), 'utf8');
  await assert.rejects(publishProjectChanges(root, [{ path: 'PROJECT.md', before: 'stale', after: 'replacement' }]), { code: 'CONFLICT' });
  assert.equal(await readFile(join(root, 'PROJECT.md'), 'utf8'), before);
  await assertProjectTransactionClear(root);
});

test('publish rolls back a partial write failure', async () => {
  const root = await makeProjectFixture();
  const before = await readFile(join(root, 'PROJECT.md'), 'utf8');
  await assert.rejects(publishProjectChanges(root, [
    { path: 'PROJECT.md', before, after: 'changed' },
    { path: 'PROJECT.md/impossible.md', before: null, after: 'cannot write below a file' }
  ]));
  assert.equal(await readFile(join(root, 'PROJECT.md'), 'utf8'), before);
  await assertProjectTransactionClear(root);
});

test('interrupted transaction blocks reads and explicit recovery restores original bytes', async () => {
  const root = await makeProjectFixture();
  const before = await readFile(join(root, 'PROJECT.md'), 'utf8');
  await mkdir(join(root, '.tmp'), { recursive: true });
  await writeFile(join(root, '.tmp/project-transaction.json'), JSON.stringify({ version: 1, pid: 99999999, kind: 'rebaseline', changes: [{ path: 'PROJECT.md', before, after: 'partial write' }] }));
  await writeFile(join(root, 'PROJECT.md'), 'partial write');
  await assert.rejects(assertProjectTransactionClear(root), { code: 'PROJECT_TRANSACTION_PENDING' });
  const result = await recoverProjectTransaction(root);
  assert.equal(result.recovered, true);
  assert.equal(await readFile(join(root, 'PROJECT.md'), 'utf8'), before);
  await assertProjectTransactionClear(root);
});

test('concurrent publishers cannot both replace the same input snapshot', async () => {
  const root = await makeProjectFixture();
  const before = await readFile(join(root, 'PROJECT.md'), 'utf8');
  const attempts = await Promise.allSettled(['first', 'second'].map(after => publishProjectChanges(root, [{ path: 'PROJECT.md', before, after }])));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(result => result.status === 'rejected').length, 1);
  await assertProjectTransactionClear(root);
});

test('publication checks binary evidence and the complete Action inventory', async () => {
  const { createHash } = await import('node:crypto');
  const { root } = await fixture();
  const before = await readFile(join(root, 'PROJECT.md'), 'utf8');
  const bytes = Buffer.from([0, 255, 128, 1]);
  await writeFile(join(root, 'artifact.bin'), bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(root, 'artifact.bin'), Buffer.from([0, 255, 128, 2]));
  await assert.rejects(publishProjectChanges(root, [{ path: 'PROJECT.md', before, after: 'changed' }], { expectedInputs: [{ path: 'artifact.bin', sha256: digest }] }), { code: 'CONFLICT' });
  await assert.rejects(publishProjectChanges(root, [{ path: 'PROJECT.md', before, after: 'changed' }], { expectedActionPaths: ['plans/actions/ACT-001.md'] }), { code: 'CONFLICT' });
  assert.equal(await readFile(join(root, 'PROJECT.md'), 'utf8'), before);
});

test('recovery preserves third-party edits and refuses a live transaction owner', async () => {
  const root = await makeProjectFixture();
  const before = await readFile(join(root, 'PROJECT.md'), 'utf8');
  await mkdir(join(root, '.tmp'), { recursive: true });
  const journal = { version: 1, pid: process.pid, kind: 'rebaseline', changes: [{ path: 'PROJECT.md', before, after: 'partial write' }] };
  await writeFile(join(root, '.tmp/project-transaction.json'), JSON.stringify(journal));
  await assert.rejects(recoverProjectTransaction(root), { code: 'CONFLICT' });
  await writeFile(join(root, '.tmp/project-transaction.json'), JSON.stringify({ ...journal, pid: 99999999 }));
  await writeFile(join(root, 'PROJECT.md'), 'external edit');
  await assert.rejects(recoverProjectTransaction(root), { code: 'CONFLICT' });
  assert.equal(await readFile(join(root, 'PROJECT.md'), 'utf8'), 'external edit');
  await assert.rejects(assertProjectTransactionClear(root), { code: 'PROJECT_TRANSACTION_PENDING' });
});

test('publication rejects journal overwrite and aliased duplicate paths', async () => {
  const root = await makeProjectFixture();
  for (const path of ['.tmp/project-transaction.json', 'plans/../.tmp/project-transaction.json', 'plans/../PROJECT.md']) {
    await assert.rejects(publishProjectChanges(root, [{ path, before: null, after: 'invalid' }]), { code: 'VALIDATION' });
  }
  await assertProjectTransactionClear(root);
});
