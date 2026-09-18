import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createRecord, updateRecordStatus } from '../../src/records/create.js';
import { parseMarkdownDocument } from '../../src/lib/markdown.js';
import { validateRecord } from '../../src/validation/validator.js';
import { configureSessionFixture, makeProjectFixture } from '../helpers/fixtures.js';

import { claimExecution } from '../../src/session/execution.js';
import * as workflow from '../../src/actions/workflow.js';

const definition = () => ({
  candidate_version: 'report-v1',
  validation_plan: { tier: 'presentation', checks: [{ id: 'layout', description: 'Read the rendered page and check units.', max_attempts: 2 }] },
  operation_scope: { operations: ['edit-report'], paths: ['writing/report.md'], resources: [] }
});
async function fixture() {
  const root = await makeProjectFixture();
  await createRecord(root, 'action', { id: 'ACT-001', title: 'Report layout', driver: 'RQ-001', acceptance: 'The rendered report is accepted.', execution: { resources: [], writable_paths: ['writing/report.md'], resource_observation: null } });
  await configureSessionFixture(root, { plan: { writable_paths: ['writing/report.md'] } });
  return root;
}
async function start(root) {
  await updateRecordStatus(root, 'ACT-001', 'defined', { reason: 'Define the report.' });
  await updateRecordStatus(root, 'ACT-001', 'ready', { reason: 'Inputs checked.' });
  return claimExecution(root, 'ACT-001');
}
const read = async root => parseMarkdownDocument(await readFile(join(root, 'plans/actions/ACT-001.md'), 'utf8')).attributes;
const check = (outcome, candidate_version = 'report-v1') => ({ check_id: 'layout', candidate_version, outcome, evidence: 'Rendered writing/report.md and inspected units.' });
const approve = root => workflow.approveActionScope(root, 'ACT-001', { grant_id: 'GRANT-001', approver: 'researcher', reason: 'Requested report correction.' });

test('workflow config is required to start, then an exact reusable approval allows work', async () => {
  assert.equal(typeof workflow.configureAction, 'function');
  const root = await fixture();
  assert.throws(() => workflow.assertActionCanStart({ type: 'action', blockers: [] }), /configur/i);
  await workflow.configureAction(root, 'ACT-001', definition());
  const unapproved = await read(root);
  assert.throws(() => workflow.assertActionCanStart(unapproved), /approval/i);
  await approve(root);
  const first = await read(root);
  workflow.assertActionCanStart(first);
  await approve(root);
  assert.equal((await read(root)).scope_approvals.length, 1);
  assert.equal(workflow.inspectActionWorkflow(first).can_start, true);
  assert.deepEqual(validateRecord('action', first), []);
});

test('pass ends checks for that candidate but closure needs explicit human acceptance', async () => {
  assert.equal(typeof workflow.recordActionCheck, 'function');
  const root = await fixture();
  await workflow.configureAction(root, 'ACT-001', definition());
  await approve(root);
  await start(root);
  await workflow.recordActionCheck(root, 'ACT-001', check('pass'));
  const current = await read(root);
  assert.equal(workflow.inspectActionWorkflow(current).passed, true);
  await assert.rejects(() => workflow.recordActionCheck(root, 'ACT-001', check('pass')), /already passed/i);
  assert.throws(() => workflow.assertActionCanStart(current), /passed/i);
  assert.throws(() => workflow.assertActionCanClose(current), /acceptance/i);
  const accepted = { ...current, validation_acceptance: { candidate_version: 'report-v1', accepted_by: 'researcher', accepted_at: new Date().toISOString(), reason: 'Report accepted, without changing the scientific conclusion.' } };
  workflow.assertActionCanClose(accepted);
  assert.equal(workflow.inspectActionWorkflow(accepted).can_close, true);
  assert.throws(() => workflow.assertActionCanClose({ ...accepted, candidate_version: 'report-v2' }), /check|acceptance/i);
});

test('task-specific exhaustion creates one blocker and revision retains evidence and blocker history', async () => {
  assert.equal(typeof workflow.recordActionCheck, 'function');
  const root = await fixture();
  await workflow.configureAction(root, 'ACT-001', definition());
  await approve(root);
  await start(root);
  await workflow.recordActionCheck(root, 'ACT-001', check('fail'));
  await workflow.recordActionCheck(root, 'ACT-001', check('fail'));
  let current = await read(root);
  assert.equal(current.blockers.length, 1);
  assert.equal(current.blockers[0].category, 'validation');
  assert.equal(current.blockers[0].status, 'active');
  assert.throws(() => workflow.assertActionCanStart(current), /block|exhaust/i);
  await assert.rejects(() => workflow.recordActionCheck(root, 'ACT-001', check('pass')), /exhaust/i);
  await assert.rejects(() => workflow.configureAction(root, 'ACT-001', { ...definition(), candidate_version: 'report-v2' }), /reason/i);
  await workflow.configureAction(root, 'ACT-001', { ...definition(), candidate_version: 'report-v2', reason: 'Corrected the figure width after the agreed budget failed.' });
  current = await read(root);
  assert.equal(current.validation_checks.length, 2);
  assert.equal(current.blockers[0].status, 'resolved');
  assert.equal(current.validation_revisions.length, 1);
  assert.equal(workflow.inspectActionWorkflow(current).checks[0].attempts, 0);
  await assert.rejects(() => workflow.recordActionCheck(root, 'ACT-001', check('pass')), /candidate/i);
  await workflow.recordActionCheck(root, 'ACT-001', check('pass', 'report-v2'));
});

test('scope changes require a new grant, and resolved blockers preserve explicitly unknown times', async () => {
  assert.equal(typeof workflow.recordActionBlocker, 'function');
  const root = await fixture();
  await workflow.configureAction(root, 'ACT-001', definition());
  await approve(root);
  const next = definition();
  next.operation_scope.paths.push('writing/second.md');
  await workflow.configureAction(root, 'ACT-001', { ...next, reason: 'Second report is now requested.' });
  assert.equal(workflow.inspectActionWorkflow(await read(root)).authorization_valid, false);
  await assert.rejects(() => approve(root), /grant/i);
  await workflow.approveActionScope(root, 'ACT-001', { grant_id: 'GRANT-002', approver: 'researcher', reason: 'Both reports requested.' });
  await workflow.recordActionBlocker(root, 'ACT-001', { operation: 'create', id: 'BLOCK-001', category: 'network', description: 'Cannot retrieve image.', owner: 'researcher', since: null, review_at: null, next_unblock_action: 'Restore connection.', root_cause: 'Remote host unavailable.', critical_path: false });
  const blocked = await read(root);
  assert.throws(() => workflow.assertActionCanStart(blocked), /block/i);
  await workflow.recordActionBlocker(root, 'ACT-001', { operation: 'resolve', id: 'BLOCK-001', resolved_at: null, resolution: 'Connection restored; exact time unknown.' });
  const current = await read(root);
  assert.equal(current.blockers[0].since, null);
  assert.equal(current.blockers[0].resolved_at, null);
  assert.equal(current.blockers[0].status, 'resolved');
  assert.equal(current.blockers[0].resolution, 'Connection restored; exact time unknown.');
  assert.deepEqual(validateRecord('action', current), []);
  workflow.assertActionCanStart(current);
});

test('invalid plans and unsafe scopes leave the original record byte-identical', async () => {
  const root = await fixture();
  const before = await readFile(join(root, 'plans/actions/ACT-001.md'), 'utf8');
  for (const mutate of [
    value => { value.validation_plan.checks[0].max_attempts = 0; },
    value => { value.validation_plan.checks.push({ ...value.validation_plan.checks[0] }); },
    value => { value.operation_scope.paths = ['../outside']; },
    value => { value.validation_plan.tier = 'whatever'; }
  ]) {
    const invalid = definition();
    mutate(invalid);
    await assert.rejects(() => workflow.configureAction(root, 'ACT-001', invalid));
    assert.equal(await readFile(join(root, 'plans/actions/ACT-001.md'), 'utf8'), before);
  }
});

test('a reasoned budget extension retains attempts and does not repeat a passed check', async () => {
  const root = await fixture();
  const plan = definition();
  plan.validation_plan.checks.push({ id: 'content', description: 'Check report content.', max_attempts: 1 });
  await workflow.configureAction(root, 'ACT-001', plan);
  await approve(root);
  await start(root);
  await workflow.recordActionCheck(root, 'ACT-001', { ...check('pass'), check_id: 'content' });
  await workflow.recordActionCheck(root, 'ACT-001', check('fail'));
  await workflow.recordActionCheck(root, 'ACT-001', check('fail'));
  const revised = structuredClone(plan);
  revised.validation_plan.checks[0].max_attempts = 3;
  revised.reason = 'Root cause found in image dimensions; allow one targeted repair check.';
  await workflow.configureAction(root, 'ACT-001', revised);
  const state = workflow.inspectActionWorkflow(await read(root));
  assert.equal(state.checks.find(item => item.id === 'layout').attempts, 2);
  assert.equal(state.checks.find(item => item.id === 'content').passed, true);
  await assert.rejects(() => workflow.recordActionCheck(root, 'ACT-001', { ...check('pass'), check_id: 'content' }), /already passed/i);
  await workflow.recordActionCheck(root, 'ACT-001', check('pass'));
  assert.equal(workflow.inspectActionWorkflow(await read(root)).passed, true);
});

test('revising scope order preserves authorization and malformed evidence is rejected atomically', async () => {
  const root = await fixture();
  const plan = definition();
  plan.operation_scope.paths.push('writing/second.md');
  await workflow.configureAction(root, 'ACT-001', plan);
  await approve(root);
  plan.operation_scope.paths.reverse();
  await workflow.configureAction(root, 'ACT-001', { ...plan, reason: 'Reordered scope for readability.' });
  assert.equal(workflow.inspectActionWorkflow(await read(root)).authorization_valid, true);
  await start(root);
  const before = await readFile(join(root, 'plans/actions/ACT-001.md'), 'utf8');
  await assert.rejects(() => workflow.recordActionCheck(root, 'ACT-001', { ...check('pass'), evidence: '  ' }));
  assert.equal(await readFile(join(root, 'plans/actions/ACT-001.md'), 'utf8'), before);
});

test('checks cannot finish an unstarted candidate and strand it before execution', async () => {
  const root = await fixture();
  await workflow.configureAction(root, 'ACT-001', definition());
  await approve(root);
  for (const status of ['inbox', 'defined', 'ready']) {
    if (status !== 'inbox') await updateRecordStatus(root, 'ACT-001', status, { reason: 'Advance setup.' });
    const before = await readFile(join(root, 'plans/actions/ACT-001.md'), 'utf8');
    await assert.rejects(() => workflow.recordActionCheck(root, 'ACT-001', check('pass')), /in_progress|review|start/i);
    assert.equal(await readFile(join(root, 'plans/actions/ACT-001.md'), 'utf8'), before);
  }
  await claimExecution(root, 'ACT-001');
  await workflow.recordActionCheck(root, 'ACT-001', check('pass'));
  await updateRecordStatus(root, 'ACT-001', 'closed', { reason: 'Report accepted.', acceptedBy: 'researcher', verifiedAt: new Date().toISOString() });
  assert.equal((await read(root)).status, 'closed');
});

for (const status of ['review', 'verified']) {
  test(`a revised candidate in ${status} reacquires execution and closes after fresh checks`, async () => {
    const root = await fixture();
    await workflow.configureAction(root, 'ACT-001', definition());
    await approve(root);
    await start(root);
    await workflow.recordActionCheck(root, 'ACT-001', check(status === 'review' ? 'fail' : 'pass'));
    await updateRecordStatus(root, 'ACT-001', 'review', { reason: 'Review first candidate.' });
    if (status === 'verified') await updateRecordStatus(root, 'ACT-001', 'verified', { reason: 'First version accepted.', acceptedBy: 'researcher' });
    await workflow.configureAction(root, 'ACT-001', { ...definition(), candidate_version: 'report-v2', reason: 'Correct units for revised report.' });
    const revised = await read(root);
    assert.equal(revised.status, 'ready');
    assert.equal(revised.validation_acceptance, null);
    assert.deepEqual(revised.status_history.at(-1), { from: status, to: 'ready', at: revised.updated, reason: 'Correct units for revised report.' });
    await assert.rejects(() => workflow.recordActionCheck(root, 'ACT-001', check('pass', 'report-v2')), /in_progress|review|start/i);
    await claimExecution(root, 'ACT-001');
    await workflow.recordActionCheck(root, 'ACT-001', check('pass', 'report-v2'));
    await updateRecordStatus(root, 'ACT-001', 'closed', { reason: 'Revised report accepted.', acceptedBy: 'researcher', verifiedAt: new Date().toISOString() });
    const closed = await read(root);
    assert.equal(closed.status, 'closed');
    assert.equal(closed.validation_checks.length, 2);
    assert.equal(closed.validation_acceptance.candidate_version, 'report-v2');
  });
}

test('execution claim cannot bypass an undefined project objective', async () => {
  const root = await fixture();
  await workflow.configureAction(root, 'ACT-001', definition());
  await approve(root);
  await configureSessionFixture(root, { objective: 'Not set', plan: { writable_paths: ['writing/report.md'] } });
  await updateRecordStatus(root, 'ACT-001', 'defined', { reason: 'Defined.' });
  await updateRecordStatus(root, 'ACT-001', 'ready', { reason: 'Ready.' });
  await assert.rejects(() => claimExecution(root, 'ACT-001'), /FOREGROUND_OBJECTIVE_MISSING/);
  assert.equal((await read(root)).status, 'ready');
});
