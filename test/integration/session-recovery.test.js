import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { main } from '../../src/cli.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../../src/lib/markdown.js';
import { createRecord, updateRecordStatus } from '../../src/records/create.js';
import {
  checkpointDisruption, checkpointSession, getSessionContext, preflightSession, registerBackgroundWork
} from '../../src/session/controller.js';
import { validateProject } from '../../src/validation/validator.js';
import {
  acceptActionFixture, captureIo, configureSessionFixture, makeProjectFixture, makeReadyActionFixture, writeRecordFixture
} from '../helpers/fixtures.js';

async function readPlan(root) {
  return parseMarkdownDocument(await readFile(join(root, 'plans/active.md'), 'utf8'), 'plans/active.md');
}

async function rewritePlan(root, update) {
  const path = join(root, 'plans/active.md');
  const plan = await readPlan(root);
  await writeFile(path, serializeMarkdownDocument({ ...plan.attributes, ...update }, plan.body), 'utf8');
}

async function rewriteRecord(root, relativePath, update) {
  const path = join(root, relativePath);
  const record = parseMarkdownDocument(await readFile(path, 'utf8'), relativePath);
  await writeFile(path, serializeMarkdownDocument({ ...record.attributes, ...update }, record.body), 'utf8');
}

function claim(overrides = {}) {
  return {
    actionId: 'ACT-001',
    dependencies: [],
    resources: ['data'],
    writablePaths: ['plans/actions/ACT-001.md'],
    unknowns: [],
    ...overrides
  };
}

function registration(overrides = {}) {
  return {
    kind: 'subagent',
    task_id: 'TASK-001',
    purpose: 'Prepare a candidate audit Artifact.',
    action_id: 'ACT-001',
    readable_paths: ['PROJECT.md', 'plans/actions/ACT-001.md'],
    writable_paths: ['generated/audit/**'],
    forbidden_changes: ['Do not change scientific Scope or Claims.'],
    expected_artifacts: ['generated/audit/report.md'],
    acceptance: 'Foreground owner reviews the diff and checks the report.',
    owner: 'session-a',
    status: 'running',
    blockers: [],
    receiver: 'foreground-session',
    ...overrides
  };
}

async function readySessionRoot({ writablePaths = ['plans/actions/ACT-001.md', 'generated/audit/**'] } = {}) {
  const root = await makeProjectFixture();
  await makeReadyActionFixture(root, { values: { execution: { resources: [], writable_paths: writablePaths, resource_observation: null } } });
  await configureSessionFixture(root, {
    resources: { data: { uri: '../data', role: 'input-data', access: 'read-only' } },
    plan: { writable_paths: writablePaths }
  });
  await updateRecordStatus(root, 'ACT-001', 'in_progress', { reason: 'Acquire fixture execution scope.' });
  return root;
}

async function closeAction(root, id = 'ACT-001') {
  const action = parseMarkdownDocument(await readFile(join(root, `plans/actions/${id}.md`), 'utf8')).attributes;
  if (action.status !== 'in_progress') {
    const plan = await readPlan(root);
    await rewritePlan(root, { writable_paths: [...new Set([...plan.attributes.writable_paths, ...action.execution.writable_paths])] });
    await updateRecordStatus(root, id, 'in_progress', { reason: 'Work started.' });
  }
  await acceptActionFixture(root, id);
}

test('cold context is sufficient without chat history and deeply read-only', async () => {
  const root = await readySessionRoot();
  const context = await getSessionContext(root);

  assert.deepEqual(Object.keys(context).sort(), [
    'actions', 'activePlan', 'attention', 'authoritativeSources', 'blockers', 'foregroundObjective',
    'latestCheckpoint', 'nextAction', 'projectId', 'resumePoint', 'writablePaths'
  ]);
  assert.equal(context.projectId, 'demo');
  assert.equal(context.foregroundObjective, 'Close ACT-001 with checked evidence.');
  assert.equal(context.nextAction, 'Claim ACT-001 and inspect its inputs.');
  assert.deepEqual(context.authoritativeSources, ['AGENTS.md', 'PROJECT.md', 'plans/active.md']);
  assert.equal(context.activePlan.path, 'plans/active.md');
  assert.equal(Object.isFrozen(context), true);
  assert.throws(() => context.writablePaths.push('PROJECT.md'), TypeError);
  assert.throws(() => { context.resumePoint.nextAction = 'forged'; }, TypeError);
  assert.throws(() => context.activePlan.background_register.push({}), TypeError);
});

test('cold recovery rejects missing, malformed, closed, and ambiguous Active Plans', async () => {
  const missing = await readySessionRoot();
  const missingProjectPath = join(missing, 'PROJECT.md');
  const missingProject = parseMarkdownDocument(await readFile(missingProjectPath, 'utf8'), missingProjectPath);
  await writeFile(missingProjectPath, serializeMarkdownDocument({ ...missingProject.attributes, active_plan: 'plans/missing.md' }, missingProject.body), 'utf8');
  await assert.rejects(() => getSessionContext(missing), error => error.code === 'MISSING_ACTIVE_PLAN');

  const malformed = await readySessionRoot();
  await writeFile(join(malformed, 'plans/active.md'), '---\nid: [broken\n---\n', 'utf8');
  await assert.rejects(() => getSessionContext(malformed), error => error.code === 'FRONTMATTER_YAML');

  const closed = await readySessionRoot();
  const closedPlan = await readPlan(closed);
  await writeFile(join(closed, 'plans/active.md'), serializeMarkdownDocument({ ...closedPlan.attributes, status: 'closed', verified_at: closedPlan.attributes.updated }, closedPlan.body), 'utf8');
  await assert.rejects(() => getSessionContext(closed), error => error.code === 'MISSING_ACTIVE_PLAN');

  const ambiguous = await readySessionRoot();
  const active = await readPlan(ambiguous);
  await writeFile(join(ambiguous, 'plans/second.md'), serializeMarkdownDocument({ ...active.attributes, id: 'PLN-002' }, active.body), 'utf8');
  await assert.rejects(() => getSessionContext(ambiguous), error => error.code === 'MULTIPLE_ACTIVE_PLANS');
});

test('preflight reports READY only for a claimable Action with satisfied inputs and no writer conflict', async () => {
  const root = await readySessionRoot();
  const ready = await preflightSession(root, claim());
  assert.deepEqual(Object.keys(ready), ['status', 'ok', 'actionId', 'dependencies', 'resources', 'writerConflicts', 'unknowns', 'issues']);
  assert.equal(ready.status, 'READY');
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.issues, []);
  assert.equal(Object.isFrozen(ready), true);

  await registerBackgroundWork(root, registration({
    writable_paths: ['plans/actions/ACT-001.md'], expected_artifacts: ['plans/actions/ACT-001.md']
  }));
  const blocked = await preflightSession(root, claim({
    resources: ['missing'],
    unknowns: [{ description: 'Evaluator identity is not confirmed.', impact: 'high' }]
  }));
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.issues.map(issue => issue.code), ['ACTION_SCOPE_NOT_APPROVED', 'RESOURCE_NOT_REGISTERED', 'WRITER_CONFLICT', 'HIGH_IMPACT_UNKNOWN']);
  assert.equal(blocked.writerConflicts[0].id, 'BG-001');
  assert.throws(() => { blocked.issues[0].code = 'forged'; }, TypeError);
});

test('preflight enforces strict claim shape, declared dependencies, Action state, and foreground objective', async () => {
  const root = await readySessionRoot();
  await assert.rejects(() => preflightSession(root, { ...claim(), extra: true }), error => error.code === 'USAGE');
  await assert.rejects(() => preflightSession(root, claim({ unknowns: [{ description: 'x', impact: 'urgent' }] })), error => error.code === 'USAGE');
  await assert.rejects(() => preflightSession(root, claim({ dependencies: ['not-an-id'] })), error => error.code === 'USAGE');
  await assert.rejects(() => preflightSession(root, claim({ resources: ['Data Root'] })), error => error.code === 'USAGE');

  const dependencyMismatch = await preflightSession(root, claim({ dependencies: ['ACT-999'] }));
  assert.deepEqual(dependencyMismatch.issues.map(issue => issue.code), ['DEPENDENCY_CLAIM_MISMATCH', 'DEPENDENCY_MISSING']);

  const unset = await makeProjectFixture();
  const unsetReport = await preflightSession(unset, claim({ resources: [] }));
  assert.equal(unsetReport.issues.some(issue => issue.code === 'FOREGROUND_OBJECTIVE_MISSING'), true);
  assert.equal(unsetReport.issues.some(issue => issue.code === 'ACTION_NOT_FOUND'), true);
});

test('preflight distinguishes missing, ambiguous, invalid, unsatisfied, and valid closed dependencies', async () => {
  const missing = await readySessionRoot();
  await rewriteRecord(missing, 'plans/actions/ACT-001.md', { dependencies: ['ACT-999'] });
  assert.equal((await preflightSession(missing, claim({ dependencies: ['ACT-999'] }))).issues.some(issue => issue.code === 'DEPENDENCY_MISSING'), true);

  const ambiguous = await readySessionRoot();
  await makeReadyActionFixture(ambiguous, { id: 'ACT-002', driver: 'RQ-002' });
  await rewriteRecord(ambiguous, 'plans/actions/ACT-001.md', { dependencies: ['ACT-002'] });
  const dependency = parseMarkdownDocument(await readFile(join(ambiguous, 'plans/actions/ACT-002.md'), 'utf8'), 'plans/actions/ACT-002.md');
  await writeRecordFixture(ambiguous, 'archive/ACT-002.md', dependency.attributes);
  assert.equal((await preflightSession(ambiguous, claim({ dependencies: ['ACT-002'] }))).issues.some(issue => issue.code === 'DEPENDENCY_AMBIGUOUS'), true);

  const invalid = await readySessionRoot();
  await makeReadyActionFixture(invalid, { id: 'ACT-002', driver: 'RQ-002' });
  await rewriteRecord(invalid, 'plans/actions/ACT-001.md', { dependencies: ['ACT-002'] });
  await rewriteRecord(invalid, 'plans/actions/ACT-002.md', { dependencies: 'corrupt', status: 'closed' });
  assert.equal((await preflightSession(invalid, claim({ dependencies: ['ACT-002'] }))).issues.some(issue => issue.code === 'DEPENDENCY_INVALID'), true);

  const parseBroken = await readySessionRoot();
  await rewriteRecord(parseBroken, 'plans/actions/ACT-001.md', { dependencies: ['ACT-002'] });
  await writeFile(join(parseBroken, 'plans/actions/ACT-002.md'), '---\nid: [broken\n---\n', 'utf8');
  assert.equal((await preflightSession(parseBroken, claim({ dependencies: ['ACT-002'] }))).issues.some(issue => issue.code === 'DEPENDENCY_INVALID'), true);

  const open = await readySessionRoot();
  await makeReadyActionFixture(open, { id: 'ACT-002', driver: 'RQ-002' });
  await rewriteRecord(open, 'plans/actions/ACT-001.md', { dependencies: ['ACT-002'] });
  assert.equal((await preflightSession(open, claim({ dependencies: ['ACT-002'] }))).issues.some(issue => issue.code === 'DEPENDENCY_NOT_SATISFIED'), true);

  const closed = await readySessionRoot();
  await makeReadyActionFixture(closed, { id: 'ACT-002', driver: 'RQ-002' });
  await closeAction(closed, 'ACT-002');
  await rewriteRecord(closed, 'plans/actions/ACT-001.md', { dependencies: ['ACT-002'] });
  assert.equal((await preflightSession(closed, claim({ dependencies: ['ACT-002'] }))).status, 'READY');
});

test('preflight reports a malformed claimed Action instead of crashing or claiming it', async () => {
  const root = await readySessionRoot();
  const actionPath = join(root, 'plans/actions/ACT-001.md');
  const action = parseMarkdownDocument(await readFile(actionPath, 'utf8'), actionPath);
  await writeFile(actionPath, serializeMarkdownDocument({ ...action.attributes, dependencies: 'corrupt' }, action.body), 'utf8');
  const report = await preflightSession(root, claim());
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.issues.some(issue => issue.code === 'ACTION_INVALID' && issue.path === 'plans/actions/ACT-001.md'), true);
});

test('preflight reports a parse-broken canonical Action as invalid, not missing', async () => {
  const root = await readySessionRoot();
  await writeFile(join(root, 'plans/actions/ACT-001.md'), '---\nid: [broken\n---\n', 'utf8');
  const report = await preflightSession(root, claim());
  assert.equal(report.issues.some(issue => issue.code === 'ACTION_INVALID' && issue.path === 'plans/actions/ACT-001.md'), true);
  assert.equal(report.issues.some(issue => issue.code === 'ACTION_NOT_FOUND'), false);
});

test('preflight and active registration cannot exceed the Active Plan write ceiling', async () => {
  const root = await readySessionRoot();
  await rewritePlan(root, { writable_paths: ['plans/actions/ACT-001.md'] });
  for (const writablePaths of [['PROJECT.md'], ['generated/audit/**'], ['plans/active.md']]) {
    const report = await preflightSession(root, claim({ writablePaths }));
    assert.equal(report.issues.some(issue => issue.code === 'WRITE_SCOPE_NOT_IN_ACTIVE_PLAN'), true);
  }
  const before = await readFile(join(root, 'plans/active.md'), 'utf8');
  await assert.rejects(() => registerBackgroundWork(root, registration()), error => error.code === 'VALIDATION');
  await assert.rejects(() => registerBackgroundWork(root, registration({ status: 'accepted' })), error => error.code === 'VALIDATION');
  assert.equal(await readFile(join(root, 'plans/active.md'), 'utf8'), before);

  const controlWriter = await readySessionRoot({ writablePaths: ['plans/actions/ACT-001.md', 'plans/active.md'] });
  assert.equal((await preflightSession(controlWriter, claim({ writablePaths: ['plans/active.md'] }))).status, 'READY');
});

test('background registrations are complete, monotonic, atomic, and enforce one writer', async () => {
  const root = await readySessionRoot();
  assert.equal(await registerBackgroundWork(root, registration({ status: 'accepted' })), 'BG-001');
  assert.equal(await registerBackgroundWork(root, registration({ task_id: 'TASK-002', owner: 'session-b' })), 'BG-002');
  let plan = await readPlan(root);
  assert.deepEqual(plan.attributes.background_register.map(item => item.id), ['BG-001', 'BG-002']);
  assert.deepEqual(plan.attributes.background_register[1].control_paths, ['PROJECT.md', 'plans/active.md']);
  assert.equal(plan.attributes.background_register[1].registered_at, plan.attributes.background_register[1].updated_at);
  assert.equal(typeof plan.attributes.background_register[1].acceptance, 'string');
  const registeredAt = plan.attributes.background_register[1].registered_at;

  const before = await readFile(join(root, 'plans/active.md'), 'utf8');
  await assert.rejects(
    () => registerBackgroundWork(root, registration({ task_id: 'TASK-003', owner: 'session-c', writable_paths: ['generated/audit/report.md'] })),
    error => error.code === 'CONFLICT'
  );
  assert.equal(await readFile(join(root, 'plans/active.md'), 'utf8'), before);
  assert.equal(await registerBackgroundWork(root, registration({ task_id: 'TASK-002', owner: 'session-b', status: 'candidate_ready' })), 'BG-002');
  assert.equal(await registerBackgroundWork(root, registration({ task_id: 'TASK-002', owner: 'session-b', status: 'accepted' })), 'BG-002');
  plan = await readPlan(root);
  assert.equal(plan.attributes.background_register.length, 2);
  assert.equal(plan.attributes.background_register[1].registered_at, registeredAt);
  assert.equal(Date.parse(plan.attributes.background_register[1].updated_at) > Date.parse(registeredAt), true);
  assert.equal(plan.attributes.background_register[1].status, 'accepted');
  assert.equal(await registerBackgroundWork(root, registration({ task_id: 'TASK-003', owner: 'session-c', writable_paths: ['generated/audit/report.md'] })), 'BG-003');
  await assert.rejects(
    () => registerBackgroundWork(root, registration({ task_id: 'TASK-004', writable_paths: ['../outside'] })),
    error => error.code === 'USAGE'
  );
  await assert.rejects(
    () => registerBackgroundWork(root, registration({ task_id: 'TASK-005', expected_artifacts: ['generated/audit/*.md'] })),
    error => error.code === 'USAGE'
  );
});

test('same-task registration updates preserve dispatch authority and obey status transitions', async () => {
  const root = await readySessionRoot();
  await registerBackgroundWork(root, registration());
  const before = await readFile(join(root, 'plans/active.md'), 'utf8');
  await assert.rejects(
    () => registerBackgroundWork(root, registration({ owner: 'session-thief', writable_paths: ['generated/audit/report.md'] })),
    error => error.code === 'VALIDATION'
  );
  assert.equal(await readFile(join(root, 'plans/active.md'), 'utf8'), before);

  await registerBackgroundWork(root, registration({ status: 'blocked', blockers: ['Awaiting input.'] }));
  await registerBackgroundWork(root, registration({ status: 'running' }));
  await registerBackgroundWork(root, registration({ status: 'candidate_ready' }));
  await registerBackgroundWork(root, registration({ status: 'accepted' }));
  await registerBackgroundWork(root, registration({ status: 'closed' }));
  const terminal = await readFile(join(root, 'plans/active.md'), 'utf8');
  await assert.rejects(() => registerBackgroundWork(root, registration({ status: 'running' })), error => error.code === 'VALIDATION');
  assert.equal(await readFile(join(root, 'plans/active.md'), 'utf8'), terminal);
});

test('duplicate background IDs or task IDs invalidate every context and mutation byte-identically', async () => {
  for (const duplicateField of ['id', 'task_id']) {
    const root = await readySessionRoot();
    await registerBackgroundWork(root, registration({ task_id: 'TASK-A', writable_paths: ['generated/audit/a/**'], expected_artifacts: ['generated/audit/a/report.md'] }));
    await registerBackgroundWork(root, registration({ task_id: 'TASK-B', owner: 'session-b', writable_paths: ['generated/audit/b/**'], expected_artifacts: ['generated/audit/b/report.md'] }));
    const plan = await readPlan(root);
    const register = plan.attributes.background_register.map(item => ({ ...item }));
    register[1][duplicateField] = register[0][duplicateField];
    await rewritePlan(root, { background_register: register });
    const report = await validateProject(root);
    const expectedCode = duplicateField === 'id' ? 'DUPLICATE_BACKGROUND_ID' : 'DUPLICATE_BACKGROUND_TASK_ID';
    assert.equal(report.issues.some(issue => issue.code === expectedCode), true);
    const before = await readFile(join(root, 'plans/active.md'), 'utf8');
    for (const mutation of [
      () => registerBackgroundWork(root, registration({ task_id: 'TASK-A', writable_paths: ['generated/audit/a/**'], expected_artifacts: ['generated/audit/a/report.md'], status: 'blocked', blockers: ['x'] })),
      () => checkpointSession(root, { progress: [], artifacts: [], discoveries: [], decisions: [], resumePoint: { lastVerifiedPoint: 'Checked.', nextAction: 'Continue.', nextCommandOrEdit: null, requiredFiles: [], risks: [], reforecastTrigger: null } }),
      () => checkpointDisruption(root, { status: 'active', capacityReduction: '50%', pausedActions: [], resumePoint: { lastVerifiedPoint: 'Checked.', nextAction: 'Continue.', nextCommandOrEdit: null, requiredFiles: [], risks: [], reforecastTrigger: null } })
    ]) await assert.rejects(mutation, error => error.code === 'VALIDATION');
    await assert.rejects(() => getSessionContext(root), error => error.code === 'VALIDATION');
    assert.equal(await readFile(join(root, 'plans/active.md'), 'utf8'), before);
  }
});

test('semantic validation diagnoses forged background authority fields together', async () => {
  const root = await readySessionRoot();
  await registerBackgroundWork(root, registration());
  const plan = await readPlan(root);
  const forged = {
    ...plan.attributes.background_register[0],
    status: 'blocked',
    blockers: [],
    readable_paths: ['../outside'],
    expected_artifacts: ['evidence/EVD-001.md'],
    control_paths: ['PROJECT.md', 'plans/active.md', 'plans/forged.md'],
    registered_at: '2099-01-01T00:00:00.000Z'
  };
  await rewritePlan(root, { background_register: [forged] });
  const report = await validateProject(root);
  for (const code of [
    'EXEC_PLAN_PATH_INVALID', 'BACKGROUND_CONTROL_PATH_INVALID', 'BACKGROUND_TIMESTAMP_INVALID',
    'BLOCKED_WITHOUT_BLOCKER', 'BACKGROUND_ARTIFACT_OUT_OF_SCOPE'
  ]) assert.equal(report.issues.some(item => item.code === code), true);
  const before = await readFile(join(root, 'plans/active.md'), 'utf8');
  await assert.rejects(() => getSessionContext(root), error => error.code === 'VALIDATION');
  assert.equal(await readFile(join(root, 'plans/active.md'), 'utf8'), before);
});

test('schema-invalid background registration values return deterministic validation issues without throwing', async () => {
  const root = await readySessionRoot();
  await rewritePlan(root, {
    created: { invalid: 'date' },
    updated: ['invalid-date'],
    writable_paths: ['   '],
    resume_point: 'invalid-packet',
    background_register: [null, 7, 'invalid-registration', {}]
  });
  const first = await validateProject(root);
  const second = await validateProject(root);
  assert.equal(first.ok, false);
  assert.deepEqual(first, second);
  assert.equal(first.issues.some(issue => issue.code === 'SCHEMA_INVALID'), true);
  assert.equal(first.issues.some(issue => issue.code === 'BACKGROUND_REGISTRATION_INVALID'), true);
  assert.equal(first.issues.some(issue => issue.code === 'EXEC_PLAN_PATH_INVALID'), true);
});

test('unsafe disruption recovery packets block validation, cold load, and mutation atomically', async () => {
  const root = await readySessionRoot();
  await rewritePlan(root, {
    disruption_mode: {
      status: 'active',
      capacity_reduction: '50%',
      paused_actions: ['ACT-001'],
      last_verified_point: '   ',
      next_action: 'line one\nline two',
      next_command_or_edit: 'command one\ncommand two',
      required_files: ['../outside', '   '],
      risks: [],
      reforecast_trigger: 'trigger one\ntrigger two'
    }
  });
  const report = await validateProject(root);
  assert.equal(report.issues.some(issue => issue.code === 'EXEC_PLAN_FIELD_INVALID' && issue.path.includes('/disruption_mode/')), true);
  assert.equal(report.issues.some(issue => issue.code === 'EXEC_PLAN_PATH_INVALID' && issue.path.includes('/disruption_mode/required_files/')), true);
  const before = await readFile(join(root, 'plans/active.md'), 'utf8');
  await assert.rejects(() => getSessionContext(root), error => error.code === 'VALIDATION');
  await assert.rejects(() => checkpointSession(root, {
    progress: [], artifacts: [], discoveries: [], decisions: [],
    resumePoint: { lastVerifiedPoint: 'Checked.', nextAction: 'Continue safely.', nextCommandOrEdit: null, requiredFiles: [], risks: [], reforecastTrigger: null }
  }), error => error.code === 'VALIDATION');
  await assert.rejects(() => checkpointDisruption(root, {
    status: 'recovered', capacityReduction: 'Normal.', pausedActions: [],
    resumePoint: { lastVerifiedPoint: 'Checked.', nextAction: 'Continue safely.', nextCommandOrEdit: null, requiredFiles: [], risks: [], reforecastTrigger: null }
  }), error => error.code === 'VALIDATION');
  assert.equal(await readFile(join(root, 'plans/active.md'), 'utf8'), before);
});

test('disruption paused Actions must be a flat list of canonical IDs', async () => {
  const root = await readySessionRoot();
  const plan = await readPlan(root);
  await rewritePlan(root, {
    disruption_mode: {
      status: 'active', capacity_reduction: '50%', paused_actions: ['not-an-id', ['ACT-002']],
      ...plan.attributes.resume_point
    }
  });
  const report = await validateProject(root);
  assert.equal(report.issues.filter(issue => issue.code === 'DISRUPTION_PAUSED_ACTION_INVALID').length, 2);
});

test('background timestamps cannot predate the Active Plan and fail mutations byte-identically', async () => {
  const root = await readySessionRoot();
  await registerBackgroundWork(root, registration());
  const plan = await readPlan(root);
  const registrationBeforePlan = {
    ...plan.attributes.background_register[0],
    registered_at: '2000-01-01T00:00:00.000Z',
    updated_at: '2000-01-01T00:00:01.000Z'
  };
  await rewritePlan(root, { background_register: [registrationBeforePlan] });
  const report = await validateProject(root);
  assert.equal(report.issues.some(issue => issue.code === 'BACKGROUND_TIMESTAMP_INVALID'), true);
  const before = await readFile(join(root, 'plans/active.md'), 'utf8');
  await assert.rejects(() => getSessionContext(root), error => error.code === 'VALIDATION');
  await assert.rejects(() => checkpointSession(root, {
    progress: [], artifacts: [], discoveries: [], decisions: [],
    resumePoint: { lastVerifiedPoint: 'Checked.', nextAction: 'Continue.', nextCommandOrEdit: null, requiredFiles: [], risks: [], reforecastTrigger: null }
  }), error => error.code === 'VALIDATION');
  assert.equal(await readFile(join(root, 'plans/active.md'), 'utf8'), before);
});

test('blocked background work requires a meaningful non-whitespace blocker', async () => {
  const root = await readySessionRoot();
  await registerBackgroundWork(root, registration());
  const plan = await readPlan(root);
  await rewritePlan(root, {
    background_register: [{ ...plan.attributes.background_register[0], status: 'blocked', blockers: ['   '] }]
  });
  const report = await validateProject(root);
  assert.equal(report.issues.some(issue => issue.code === 'BLOCKED_WITHOUT_BLOCKER'), true);
  const before = await readFile(join(root, 'plans/active.md'), 'utf8');
  await assert.rejects(() => getSessionContext(root), error => error.code === 'VALIDATION');
  await assert.rejects(() => registerBackgroundWork(root, registration({ status: 'running' })), error => error.code === 'VALIDATION');
  assert.equal(await readFile(join(root, 'plans/active.md'), 'utf8'), before);
});

test('the Active Plan blocker list cannot contain whitespace-only authority', async () => {
  const root = await readySessionRoot();
  await rewritePlan(root, { blockers: ['   '] });
  const report = await validateProject(root);
  assert.equal(report.issues.some(issue => issue.code === 'EXEC_PLAN_BLOCKER_INVALID'), true);
  await assert.rejects(() => getSessionContext(root), error => error.code === 'VALIDATION');
});

test('active registration validates its Action and declared Artifact feasibility atomically', async () => {
  const outside = await readySessionRoot();
  const beforeOutside = await readFile(join(outside, 'plans/active.md'), 'utf8');
  await assert.rejects(() => registerBackgroundWork(outside, registration({ expected_artifacts: ['evidence/EVD-001.md'] })), error => error.code === 'VALIDATION');
  assert.equal(await readFile(join(outside, 'plans/active.md'), 'utf8'), beforeOutside);

  const closed = await readySessionRoot();
  await closeAction(closed);
  const beforeClosed = await readFile(join(closed, 'plans/active.md'), 'utf8');
  await assert.rejects(() => registerBackgroundWork(closed, registration()), error => error.code === 'VALIDATION');
  assert.equal(await readFile(join(closed, 'plans/active.md'), 'utf8'), beforeClosed);

  const invalid = await readySessionRoot();
  await rewriteRecord(invalid, 'plans/actions/ACT-001.md', { dependencies: 'corrupt' });
  const beforeInvalid = await readFile(join(invalid, 'plans/active.md'), 'utf8');
  await assert.rejects(() => registerBackgroundWork(invalid, registration()), error => error.code === 'VALIDATION');
  assert.equal(await readFile(join(invalid, 'plans/active.md'), 'utf8'), beforeInvalid);

  const ambiguous = await readySessionRoot();
  const action = parseMarkdownDocument(await readFile(join(ambiguous, 'plans/actions/ACT-001.md'), 'utf8'), 'plans/actions/ACT-001.md');
  await writeRecordFixture(ambiguous, 'archive/ACT-001.md', action.attributes);
  const beforeAmbiguous = await readFile(join(ambiguous, 'plans/active.md'), 'utf8');
  await assert.rejects(() => registerBackgroundWork(ambiguous, registration()), error => error.code === 'VALIDATION');
  assert.equal(await readFile(join(ambiguous, 'plans/active.md'), 'utf8'), beforeAmbiguous);
});

test('an archived Action cannot authorize preflight or background work', async () => {
  const root = await readySessionRoot();
  await mkdir(join(root, 'archive'), { recursive: true });
  await rename(join(root, 'plans/actions/ACT-001.md'), join(root, 'archive/ACT-001.md'));
  const validation = await validateProject(root);
  assert.equal(validation.issues.some(issue => issue.code === 'CANONICAL_LOCATION' && issue.path === 'archive/ACT-001.md'), true);
  const preflight = await preflightSession(root, claim());
  assert.equal(preflight.status, 'BLOCKED');
  assert.equal(preflight.issues.some(issue => issue.code === 'ACTION_INVALID' && issue.path === 'archive/ACT-001.md'), true);
  const before = await readFile(join(root, 'plans/active.md'), 'utf8');
  await assert.rejects(() => registerBackgroundWork(root, registration()), error => error.code === 'VALIDATION');
  assert.equal(await readFile(join(root, 'plans/active.md'), 'utf8'), before);
});

test('a parsed canonical Action candidate with forged identity is invalid rather than missing', async () => {
  const root = await readySessionRoot();
  await rewriteRecord(root, 'plans/actions/ACT-001.md', { id: 'ACT-999' });
  const report = await preflightSession(root, claim());
  assert.equal(report.issues.some(issue => issue.code === 'ACTION_INVALID' && issue.path === 'plans/actions/ACT-001.md'), true);
  assert.equal(report.issues.some(issue => issue.code === 'ACTION_NOT_FOUND'), false);
});

test('a valid closed dependency outside its canonical location cannot unblock preflight', async () => {
  const root = await readySessionRoot();
  await makeReadyActionFixture(root, { id: 'ACT-002', driver: 'RQ-002' });
  await closeAction(root, 'ACT-002');
  await rewriteRecord(root, 'plans/actions/ACT-001.md', { dependencies: ['ACT-002'] });
  await mkdir(join(root, 'archive'), { recursive: true });
  await rename(join(root, 'plans/actions/ACT-002.md'), join(root, 'archive/ACT-002.md'));
  const validation = await validateProject(root);
  assert.equal(validation.issues.some(issue => issue.code === 'CANONICAL_LOCATION' && issue.path === 'archive/ACT-002.md'), true);
  const report = await preflightSession(root, claim({ dependencies: ['ACT-002'] }));
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.issues.some(issue => issue.code === 'DEPENDENCY_INVALID' && issue.path === 'archive/ACT-002.md'), true);
});

test('background writer overlap is conservative across uncertain glob intersections', async () => {
  const root = await readySessionRoot({ writablePaths: ['plans/actions/ACT-001.md', 'generated/**'] });
  await registerBackgroundWork(root, registration({ writable_paths: ['generated/*/report.md'] }));
  const before = await readFile(join(root, 'plans/active.md'), 'utf8');
  await assert.rejects(
    () => registerBackgroundWork(root, registration({
      task_id: 'TASK-009', writable_paths: ['generated/a/**'], expected_artifacts: ['generated/a/report.md']
    })),
    error => error.code === 'CONFLICT'
  );
  assert.equal(await readFile(join(root, 'plans/active.md'), 'utf8'), before);
});

test('checkpoint merges authority, refreshes managed body, and rejects missing exact next action atomically', async () => {
  const root = await readySessionRoot();
  await checkpointSession(root, {
    progress: ['ACT-001 inspected.', 'ACT-001 inspected.'],
    artifacts: ['generated/audit/report.md'],
    discoveries: ['The source needs a second check.'],
    decisions: ['Keep the registered metric.'],
    resumePoint: {
      lastVerifiedPoint: 'Candidate diff inspected.',
      nextAction: 'Verify the report against ACT-001 acceptance.',
      nextCommandOrEdit: 'git diff -- generated/audit/report.md',
      requiredFiles: ['plans/actions/ACT-001.md', 'generated/audit/report.md'],
      risks: ['The source may be stale.'],
      reforecastTrigger: 'Artifact verification fails.'
    }
  });
  const checkpointed = await readPlan(root);
  const log = JSON.parse(await readFile(join(root, checkpointed.attributes.latest_checkpoint), 'utf8'));
  assert.deepEqual(log.progress, ['ACT-001 inspected.', 'ACT-001 inspected.']);
  assert.deepEqual(log.artifacts, ['generated/audit/report.md']);
  assert.deepEqual(log.discoveries, ['The source needs a second check.']);
  for (const field of ['objective', 'current_step', 'progress', 'artifacts', 'findings', 'decisions', 'validation']) {
    assert.equal(Object.hasOwn(checkpointed.attributes, field), false);
  }
  assert.equal(checkpointed.attributes.resume_point.next_action, 'Verify the report against ACT-001 acceptance.');
  for (const text of ['ACT-001 inspected.', 'The source needs a second check.', 'Keep the registered metric.']) {
    assert.equal(checkpointed.body.includes(text), false);
    assert.equal(JSON.stringify(log).includes(text), true);
  }
  assert.equal(checkpointed.body.includes('Verify the report against ACT-001 acceptance.'), true);
  assert.deepEqual(await readdir(join(root, 'plans')), ['actions', 'active.md', 'logs']);

  const before = await readFile(join(root, 'plans/active.md'), 'utf8');
  await assert.rejects(() => checkpointSession(root, {
    progress: ['must not persist'], artifacts: [], discoveries: [], decisions: [],
    resumePoint: { lastVerifiedPoint: 'x', nextAction: ' ', nextCommandOrEdit: null, requiredFiles: [], risks: [], reforecastTrigger: null }
  }), error => error.code === 'RESUME_POINT_MISSING');
  assert.equal(await readFile(join(root, 'plans/active.md'), 'utf8'), before);

  await assert.rejects(() => checkpointSession(root, {
    progress: [], artifacts: [], discoveries: [], decisions: [], currentStep: 'Different step.',
    resumePoint: { lastVerifiedPoint: 'x', nextAction: 'Canonical next action.', nextCommandOrEdit: null, requiredFiles: [], risks: [], reforecastTrigger: null }
  }), error => error.code === 'USAGE');
  assert.equal(await readFile(join(root, 'plans/active.md'), 'utf8'), before);

  await assert.rejects(() => checkpointSession(root, {
    progress: [], artifacts: [], discoveries: [], decisions: [],
    resumePoint: { lastVerifiedPoint: ' ', nextAction: 'Canonical next action.', nextCommandOrEdit: null, requiredFiles: [], risks: [], reforecastTrigger: null }
  }), error => error.code === 'USAGE');
  assert.equal(await readFile(join(root, 'plans/active.md'), 'utf8'), before);
});

test('semantic ExecPlan validation rejects unsafe hand-edits before context or mutation', async () => {
  const root = await readySessionRoot();
  await rewritePlan(root, {
    objective: 'Forged objective',
    writable_paths: ['../outside'],
    current_step: 'line one\nline two',
    resume_point: {
      last_verified_point: '', next_action: 'line one\nline two', next_command_or_edit: null,
      required_files: ['../outside'], risks: [], reforecast_trigger: null
    }
  });
  const report = await validateProject(root);
  for (const code of ['SCHEMA_INVALID', 'EXEC_PLAN_PATH_INVALID', 'EXEC_PLAN_FIELD_INVALID']) {
    assert.equal(report.issues.some(issue => issue.code === code), true);
  }
  const before = await readFile(join(root, 'plans/active.md'), 'utf8');
  await assert.rejects(() => getSessionContext(root), error => error.code === 'VALIDATION');
  await assert.rejects(() => checkpointDisruption(root, {
    status: 'active', capacityReduction: '50%', pausedActions: [],
    resumePoint: { lastVerifiedPoint: 'Checked.', nextAction: 'Continue.', nextCommandOrEdit: null, requiredFiles: [], risks: [], reforecastTrigger: null }
  }), error => error.code === 'VALIDATION');
  assert.equal(await readFile(join(root, 'plans/active.md'), 'utf8'), before);
});

test('cold recovery rejects the obsolete duplicate current step field', async () => {
  const root = await readySessionRoot();
  await rewritePlan(root, { current_step: 'A different valid single-line step.' });
  const report = await validateProject(root);
  assert.equal(report.issues.some(issue => issue.code === 'SCHEMA_INVALID' && issue.message.includes('/current_step')), true);
  const before = await readFile(join(root, 'plans/active.md'), 'utf8');
  await assert.rejects(() => getSessionContext(root), error => error.code === 'VALIDATION');
  assert.equal(await readFile(join(root, 'plans/active.md'), 'utf8'), before);
});

test('checkpoint history remains in the log without adding history headings to Active Plan', async () => {
  const root = await readySessionRoot();
  const history = 'Observed value with Markdown ## Artifacts and ## Progress headings.';
  await checkpointSession(root, {
    progress: [], artifacts: [], discoveries: [history], decisions: [],
    resumePoint: {
      lastVerifiedPoint: 'Frontmatter checked.', nextAction: 'Continue ACT-001.', nextCommandOrEdit: null,
      requiredFiles: [], risks: [], reforecastTrigger: null
    }
  });
  const checkpointed = await readPlan(root);
  assert.equal((checkpointed.body.match(/^## Progress$/gmu) ?? []).length, 0);
  assert.equal((checkpointed.body.match(/^## Artifacts$/gmu) ?? []).length, 0);
  assert.equal(checkpointed.body.includes(history), false);
  const log = JSON.parse(await readFile(join(root, checkpointed.attributes.latest_checkpoint), 'utf8'));
  assert.deepEqual(log.discoveries, [history]);
  const context = await getSessionContext(root);
  assert.equal(context.latestCheckpoint, checkpointed.attributes.latest_checkpoint);
});

test('disruption and recovery use the same Active Plan resume packet without a handoff file', async () => {
  const root = await readySessionRoot();
  const activeUpdate = {
    status: 'active',
    capacityReduction: 'Available capacity reduced to 25%.',
    pausedActions: ['ACT-002'],
    resumePoint: {
      lastVerifiedPoint: 'ACT-001 inputs checked.',
      nextAction: 'Run the registered validation only.',
      nextCommandOrEdit: 'research-os record validate --project ./demo',
      requiredFiles: ['PROJECT.md', 'plans/active.md'],
      risks: ['Travel network may be unavailable.'],
      reforecastTrigger: 'Normal capacity returns.'
    }
  };
  await checkpointDisruption(root, activeUpdate);
  let plan = await readPlan(root);
  assert.equal(plan.attributes.disruption_mode.status, 'active');
  assert.equal(plan.attributes.disruption_mode.capacity_reduction, 'Available capacity reduced to 25%.');
  assert.equal(plan.attributes.resume_point.next_action, 'Run the registered validation only.');

  await checkpointDisruption(root, { ...activeUpdate, status: 'recovered', capacityReduction: 'Normal capacity restored.' });
  plan = await readPlan(root);
  assert.equal(plan.attributes.disruption_mode.status, 'recovered');
  assert.equal(plan.attributes.disruption_mode.capacity_reduction, 'Normal capacity restored.');
  assert.deepEqual(await readdir(join(root, 'plans')), ['actions', 'active.md']);
});

test('session CLI has deterministic JSON boundaries and validation exit codes', async () => {
  const root = await readySessionRoot();
  const contextIo = captureIo();
  assert.equal(await main(['session', 'context', '--project', root], contextIo.io), 0);
  assert.equal(JSON.parse(contextIo.output().stdout).projectId, 'demo');

  const preflightIo = captureIo();
  assert.equal(await main(['session', 'preflight', '--project', root, '--claim', JSON.stringify(claim())], preflightIo.io), 0);
  assert.equal(JSON.parse(preflightIo.output().stdout).status, 'READY');

  const backgroundIo = captureIo();
  assert.equal(await main(['session', 'background', '--project', root, '--registration', JSON.stringify(registration())], backgroundIo.io), 0);
  assert.deepEqual(JSON.parse(backgroundIo.output().stdout), { id: 'BG-001' });

  const blockedIo = captureIo();
  assert.equal(await main(['session', 'preflight', '--project', root, '--claim', JSON.stringify(claim({ writablePaths: ['generated/audit/report.md'] }))], blockedIo.io), 3);
  assert.equal(JSON.parse(blockedIo.output().stdout).status, 'BLOCKED');

  const checkpointIo = captureIo();
  const update = {
    progress: [], artifacts: [], discoveries: [], decisions: [],
    resumePoint: { lastVerifiedPoint: 'CLI checked.', nextAction: 'Continue ACT-001.', nextCommandOrEdit: null, requiredFiles: [], risks: [], reforecastTrigger: null }
  };
  assert.equal(await main(['session', 'checkpoint', '--project', root, '--update', JSON.stringify(update)], checkpointIo.io), 0);
  const checkpoint = JSON.parse(checkpointIo.output().stdout);
  assert.equal(checkpoint.ok, true);
  assert.match(checkpoint.path, /^plans\/logs\/.+\.json$/u);
  assert.equal(checkpoint.repository.applicable, false);
  assert.deepEqual(checkpoint.repository.uncommittedRecords, []);

  const disruptionIo = captureIo();
  assert.equal(await main(['session', 'disruption', '--project', root, '--update', JSON.stringify({
    status: 'active', capacityReduction: '50%', pausedActions: [], resumePoint: update.resumePoint
  })], disruptionIo.io), 0);
  assert.deepEqual(JSON.parse(disruptionIo.output().stdout), { ok: true });

  for (const args of [
    ['context', '--project'],
    ['context', '--project', root, '--project', root],
    ['preflight', '--project', root, '--claim', '{'],
    ['background', '--project', root, '--registration', '[]'],
    ['checkpoint', '--project', root, '--update', '{}', '--unknown', 'x']
  ]) {
    const invalid = captureIo();
    assert.equal(await main(['session', ...args], invalid.io), 2);
    assert.match(invalid.output().stderr, /^\[USAGE\]/);
  }
});
