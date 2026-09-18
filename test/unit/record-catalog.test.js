import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../../src/lib/markdown.js';
import { normalizeManifest } from '../../src/experiments/manifest.js';
import { addProjectResource } from '../../src/project/project.js';
import { makeProjectFixture, makeTempDir, pathExists, validExperimentProject, validManifest, writeRecordFixture } from '../helpers/fixtures.js';

const catalogModule = await import('../../src/records/catalog.js').catch(() => ({}));
const createModule = await import('../../src/records/create.js').catch(() => ({}));
const validatorModule = await import('../../src/validation/validator.js');
const discoverRecords = catalogModule.discoverRecords ?? (async () => new Map());
const createRecord = createModule.createRecord ?? (async () => { throw new Error('createRecord is not implemented'); });
const updateRecordStatus = createModule.updateRecordStatus ?? (async () => { throw new Error('updateRecordStatus is not implemented'); });
const validateProject = validatorModule.validateProject ?? (async () => Object.freeze({ ok: true, checkedFiles: 0, issues: Object.freeze([]) }));
const timestamp = '2026-08-03T00:00:00.000Z';

function baseRecord(type, id, overrides = {}) {
  return {
    schema_version: 1,
    type,
    id,
    status: 'inbox',
    created: timestamp,
    updated: timestamp,
    status_history: [],
    ...overrides
  };
}

function driver(id = 'RQ-001', overrides = {}) {
  return baseRecord('driver', id, {
    driver_kind: 'research_question',
    source: 'research brief',
    question: 'Does the intervention improve the endpoint?',
    importance: 'It determines the next study.',
    scope: 'Registered cohort only.',
    priority: 'high',
    closure_conditions: ['Evidence reviewed.'],
    actions: [],
    ...overrides
  });
}

function execPlan(id = 'PLN-002', overrides = {}) {
  return baseRecord('exec_plan', id, {
    status: 'defined',
    objective: 'Check the second plan.',
    completion_conditions: [],
    scope: [],
    out_of_scope: [],
    progress: [],
    current_step: 'Continue validation.',
    findings: [],
    decisions: [],
    risks: [],
    blockers: [],
    dependencies: [],
    background_register: [],
    validation: [],
    artifacts: [],
    writable_paths: [],
    resume_point: {
      last_verified_point: 'Second plan created.',
      next_action: 'Continue validation.',
      next_command_or_edit: null,
      required_files: [],
      risks: [],
      reforecast_trigger: null
    },
    disruption_mode: null,
    ...overrides
  });
}

async function projectFixture() {
  return makeProjectFixture();
}

async function writeRecord(root, relativePath, attributes, body = '# Record\n') {
  await writeRecordFixture(root, relativePath, attributes, body);
}

async function rewriteProject(root, attributes) {
  const path = join(root, 'PROJECT.md');
  const project = parseMarkdownDocument(await readFile(path, 'utf8'), path);
  await writeFile(path, serializeMarkdownDocument({ ...project.attributes, ...attributes }, project.body), 'utf8');
}

test('discovery is deterministic, path-keyed, and excludes non-canonical trees without hiding duplicate ids', async () => {
  const root = await projectFixture();
  await writeRecord(root, 'reviews/concerns/RQ-001.md', driver('RQ-001'));
  await writeRecord(root, 'research/questions/RQ-001.md', driver('RQ-001'));
  await writeRecord(root, 'generated/RQ-002.md', driver('RQ-002'));
  await writeRecord(root, '.obsidian/RQ-003.md', driver('RQ-003'));
  await writeRecord(root, '.git/RQ-004.md', driver('RQ-004'));
  await writeRecord(root, 'node_modules/pkg/RQ-005.md', driver('RQ-005'));
  await writeRecord(root, '.superpowers/RQ-006.md', driver('RQ-006'));
  await writeFile(join(root, 'research', 'README.md'), '# no frontmatter\n', 'utf8');

  const records = await discoverRecords(root);

  assert.deepEqual([...records.keys()], [
    'plans/active.md',
    'PROJECT.md',
    'research/questions/RQ-001.md',
    'reviews/concerns/RQ-001.md'
  ]);
  assert.equal(records.get('research/questions/RQ-001.md').attributes.id, 'RQ-001');
  assert.equal(records.get('reviews/concerns/RQ-001.md').attributes.id, 'RQ-001');
  assert.deepEqual(Object.keys(records.get('research/questions/RQ-001.md')), ['id', 'type', 'path', 'attributes']);
  assert.equal(records.get('research/questions/RQ-001.md').id, 'RQ-001');
  assert.equal(records.get('research/questions/RQ-001.md').type, 'driver');
});

test('public discovery Map and nested RecordRef attributes are observably read-only', async () => {
  const root = await projectFixture();
  await writeRecord(root, 'research/questions/RQ-007.md', driver('RQ-007', { actions: ['ACT-007'] }));
  const records = await discoverRecords(root);
  const record = records.get('research/questions/RQ-007.md');

  assert.throws(() => records.clear(), TypeError);
  assert.throws(() => records.delete('research/questions/RQ-007.md'), TypeError);
  assert.throws(() => records.set('forged.md', record), TypeError);
  assert.throws(() => Map.prototype.set.call(records, 'prototype-forged.md', record), TypeError);
  assert.throws(() => record.attributes.actions.push('ACT-999'), TypeError);
  assert.throws(() => { record.attributes.source = 'forged'; }, TypeError);
  assert.equal(records.has('research/questions/RQ-007.md'), true);
  assert.equal(records.has('prototype-forged.md'), false);
  assert.deepEqual(record.attributes.actions, ['ACT-007']);
});

test('validation retains malformed and identity-missing frontmatter candidates and continues other files', async () => {
  const root = await projectFixture();
  await mkdir(join(root, 'research/questions'), { recursive: true });
  await writeFile(join(root, 'research/questions/RQ-801.md'), '---\ntype: driver\nid: [broken\n---\n# Broken\n', 'utf8');
  const missingType = driver('RQ-802');
  delete missingType.type;
  await writeRecord(root, 'research/questions/RQ-802.md', missingType);
  const missingId = driver('RQ-803');
  delete missingId.id;
  await writeRecord(root, 'research/questions/RQ-803.md', missingId);
  await writeRecord(root, 'research/questions/RQ-804.md', driver('RQ-804'));
  const outside = await makeTempDir();
  await writeRecordFixture(outside, 'RQ-805.md', driver('RQ-805'));
  await symlink(join(outside, 'RQ-805.md'), join(root, 'research/questions/RQ-805.md'));

  const records = await discoverRecords(root);
  const report = await validateProject(root);

  assert.equal(records.has('research/questions/RQ-804.md'), true);
  assert.equal(records.has('research/questions/RQ-801.md'), false);
  assert.equal(records.has('research/questions/RQ-802.md'), false);
  assert.equal(records.has('research/questions/RQ-803.md'), false);
  assert.equal(records.has('research/questions/RQ-805.md'), false);
  assert.equal(report.checkedFiles, 6);
  assert.equal(report.issues.some(issue => issue.code === 'FRONTMATTER_INVALID' && issue.path === 'research/questions/RQ-801.md'), true);
  assert.equal(report.issues.some(issue => issue.code === 'RECORD_IDENTITY_INVALID' && issue.path === 'research/questions/RQ-802.md'), true);
  assert.equal(report.issues.some(issue => issue.code === 'RECORD_IDENTITY_INVALID' && issue.path === 'research/questions/RQ-803.md'), true);
  assert.equal(report.issues.some(issue => issue.path === 'research/questions/RQ-804.md'), false);
});

test('validation reports every duplicate id path and generated authority violation in stable order', async () => {
  const root = await projectFixture();
  await writeRecord(root, 'reviews/concerns/RQ-001.md', driver('RQ-001'));
  await writeRecord(root, 'research/questions/RQ-001.md', driver('RQ-001'));
  await writeRecord(root, 'generated/RQ-002.md', driver('RQ-002'));

  const report = await validateProject(root);
  const relevant = report.issues.filter(issue => ['DUPLICATE_RECORD_ID', 'CANONICAL_RECORD_IN_GENERATED'].includes(issue.code));

  assert.equal(report.ok, false);
  assert.equal(report.checkedFiles, 4);
  assert.deepEqual(relevant.map(issue => [issue.path, issue.code, issue.relatedIds]), [
    ['generated/RQ-002.md', 'CANONICAL_RECORD_IN_GENERATED', ['RQ-002']],
    ['research/questions/RQ-001.md', 'DUPLICATE_RECORD_ID', ['RQ-001']],
    ['reviews/concerns/RQ-001.md', 'DUPLICATE_RECORD_ID', ['RQ-001']]
  ]);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.issues), true);
  assert.equal(report.issues.every(Object.isFrozen), true);
});

test('validation checks ID-shaped body wikilinks separately from prose links', async () => {
  const root = await projectFixture();
  await writeRecord(root, 'research/questions/RQ-001.md', driver(), '# Question\n\nSee [[ACT-999]] and [[ordinary note]].\n');

  const report = await validateProject(root);
  const broken = report.issues.filter(issue => issue.code === 'BROKEN_WIKILINK');

  assert.deepEqual(broken.map(issue => [issue.path, issue.relatedIds]), [
    ['research/questions/RQ-001.md', ['ACT-999']]
  ]);
});

test('validation reports schema failures and canonical location failures against the record file', async () => {
  const root = await projectFixture();
  const invalid = driver('RQ-001');
  delete invalid.importance;
  await writeRecord(root, 'research/RQ-001.md', invalid);

  const report = await validateProject(root);

  assert.equal(report.issues.some(issue => issue.code === 'SCHEMA_INVALID' && issue.path === 'research/RQ-001.md' && issue.message.includes('/importance')), true);
  assert.equal(report.issues.some(issue => issue.code === 'CANONICAL_LOCATION' && issue.path === 'research/RQ-001.md'), true);
});

test('validation reports illegal history edges and closed records without valid verification time', async () => {
  const root = await projectFixture();
  await writeRecord(root, 'research/questions/RQ-001.md', driver('RQ-001', {
    status: 'closed',
    status_history: [{ from: 'inbox', to: 'closed', at: timestamp, reason: null }]
  }));

  const report = await validateProject(root);

  assert.equal(report.issues.some(issue => issue.code === 'ILLEGAL_STATUS_TRANSITION' && issue.path === 'research/questions/RQ-001.md'), true);
  assert.equal(report.issues.some(issue => issue.code === 'CLOSED_WITHOUT_VERIFICATION' && issue.path === 'research/questions/RQ-001.md'), true);
});

test('validation requires PROJECT.active_plan to resolve to one canonical open ExecPlan', async () => {
  const missingRoot = await projectFixture();
  await rewriteProject(missingRoot, { active_plan: 'plans/missing.md' });
  const missing = await validateProject(missingRoot);
  assert.equal(missing.issues.some(issue => issue.code === 'MISSING_ACTIVE_PLAN' && issue.path === 'PROJECT.md'), true);

  const multipleRoot = await projectFixture();
  await writeRecord(multipleRoot, 'plans/second.md', execPlan());
  const multiple = await validateProject(multipleRoot);
  assert.equal(multiple.issues.some(issue => issue.code === 'MULTIPLE_ACTIVE_PLANS' && issue.path === 'PROJECT.md'), true);

  const closedRoot = await projectFixture();
  const activePath = join(closedRoot, 'plans/active.md');
  const active = parseMarkdownDocument(await readFile(activePath, 'utf8'), activePath);
  await writeFile(activePath, serializeMarkdownDocument({ ...active.attributes, status: 'closed', verified_at: timestamp }, active.body), 'utf8');
  const closed = await validateProject(closedRoot);
  assert.equal(closed.issues.some(issue => issue.code === 'MISSING_ACTIVE_PLAN' && issue.path === 'PROJECT.md'), true);
});

test('record creation maps aliases to canonical types and exact paths while enabling owning modules', async () => {
  const root = await projectFixture();
  await addProjectResource(root, 'reviews', { uri: '/vault/reviews', role: 'review-source', access: 'read-only' });
  const cases = [
    ['driver', 'RQ-101', 'research/questions/RQ-101.md', { source: 'brief', question: 'Research question?' }],
    ['concern', 'CON-101', 'reviews/concerns/CON-101.md', { source: 'reviewer 1', source_comment_id: 'R1-C1', source_ref: 'reviews:decision-letter.txt', question: 'Concern?' }],
    ['action', 'ACT-101', 'plans/actions/ACT-101.md', { driver: 'RQ-101', acceptance: 'Reviewed.' }],
    ['experiment', 'EXP-101', 'experiments/experiments/EXP-101.md', { scientific_question: 'Does it work?' }],
    ['manifest', 'MAN-101', 'experiments/manifests/MAN-101.md', { code_root: 'code' }],
    ['run', 'RUN-101', 'experiments/runs/RUN-101.md', { experiment: 'EXP-101', manifest: 'MAN-101' }],
    ['result', 'RES-101', 'experiments/results/RES-101.md', { run: 'RUN-101' }],
    ['evidence', 'EVD-101', 'evidence/packets/EVD-101.md', {}],
    ['claim', 'CLM-101', 'evidence/claims/CLM-101.md', {}],
    ['writing', 'WRT-101', 'writing/units/WRT-101.md', { target_location: 'paper:main.tex' }],
    ['decision', 'DEC-101', 'decisions/DEC-101.md', {}],
    ['incident', 'INC-101', 'incidents/incidents/INC-101.md', {}],
    ['risk', 'RSK-101', 'incidents/risks/RSK-101.md', {}]
  ];

  for (const [kind, id, path, values] of cases) {
    assert.deepEqual(await createRecord(root, kind, { id, title: `${kind}: title`, ...values }), { id, path });
  }

  const records = await discoverRecords(root);
  assert.equal(records.get('research/questions/RQ-101.md').attributes.type, 'driver');
  assert.equal(records.get('reviews/concerns/CON-101.md').attributes.type, 'driver');
  assert.equal(records.get('incidents/risks/RSK-101.md').attributes.type, 'risk');
  assert.match((await readFile(join(root, 'plans/actions/ACT-101.md'), 'utf8')), /Driver: \[\[RQ-101\]\]/);
  const project = parseMarkdownDocument(await readFile(join(root, 'PROJECT.md'), 'utf8'), 'PROJECT.md').attributes;
  assert.deepEqual(project.modules, ['decisions', 'evidence', 'experiments', 'incidents', 'research', 'reviews', 'writing']);
});

test('record creation preserves YAML-looking, colon-containing, and multiline values without overwriting an id', async () => {
  const root = await projectFixture();
  const values = {
    id: 'RQ-201',
    title: 'Question: true',
    source: 'true',
    question: 'line one:\nline two',
    importance: 'null'
  };
  await createRecord(root, 'driver', values);
  const path = join(root, 'research/questions/RQ-201.md');
  const before = await readFile(path, 'utf8');
  const created = parseMarkdownDocument(before, path);
  assert.equal(created.attributes.source, 'true');
  assert.equal(created.attributes.question, 'line one:\nline two');
  assert.equal(created.attributes.importance, 'null');
  assert.match(created.body, /^# RQ-201 — Question: true$/m);

  await assert.rejects(
    () => createRecord(root, 'concern', { ...values, title: 'Do not overwrite' }),
    error => error.code === 'CONFLICT'
  );
  assert.equal(await readFile(path, 'utf8'), before);
});

test('record creation validates the rendered record before returning success', async () => {
  const root = await projectFixture();
  await assert.rejects(
    () => createRecord(root, 'action', { id: 'ACT-201', title: 'Invalid action', driver: 'RQ-201', acceptance: '' }),
    error => error.code === 'VALIDATION'
  );
  await assert.rejects(() => readFile(join(root, 'plans/actions/ACT-201.md'), 'utf8'), error => error.code === 'ENOENT');
});

test('record creation rejects machine-owned and unknown fields before any project or file mutation', async () => {
  const root = await projectFixture();
  const beforeProject = await readFile(join(root, 'PROJECT.md'), 'utf8');
  const forged = {
    id: 'RQ-211', title: 'Forged lifecycle', source: 'brief', question: 'Can lifecycle be forged?',
    status: 'closed', created: '2000-01-01T00:00:00Z', updated: '2000-01-01T00:00:00Z',
    status_history: [], verified_at: '2000-01-01T00:00:00Z', unknown_field: true
  };

  await assert.rejects(() => createRecord(root, 'driver', forged), error => error.code === 'USAGE');
  assert.equal(await readFile(join(root, 'PROJECT.md'), 'utf8'), beforeProject);
  assert.equal(await pathExists(join(root, 'research')), false);
  assert.equal(await pathExists(join(root, 'research/questions/RQ-211.md')), false);
});

test('Manifest cards reject machine identity forgery and cannot advance while incomplete', async () => {
  const root = await projectFixture();
  await assert.rejects(() => createRecord(root, 'manifest', {
    id: 'MAN-211', title: 'Forged Manifest', code_root: 'code', normalized_hash: 'f'.repeat(64),
    resolved_config_hash: 'f'.repeat(64), resolved_at: timestamp, project_authority: {}, project_authority_hash: 'f'.repeat(64)
  }), error => error.code === 'USAGE');
  await createRecord(root, 'manifest', { id: 'MAN-212', title: 'Incomplete Manifest', code_root: 'code' });
  const path = join(root, 'experiments/manifests/MAN-212.md');
  const card = parseMarkdownDocument(await readFile(path, 'utf8'), path);
  assert.equal(card.attributes.normalized_hash, null);
  await assert.rejects(() => updateRecordStatus(root, 'MAN-212', 'ready'), error => error.code === 'VALIDATION');
});

test('Manifest cards must verify exact normalized identity against current Project at every runnable transition', async () => {
  const root = await projectFixture();
  const projectPath = join(root, 'PROJECT.md');
  const projectDocument = parseMarkdownDocument(await readFile(projectPath, 'utf8'), projectPath);
  const authority = validExperimentProject();
  await writeFile(projectPath, serializeMarkdownDocument({ ...projectDocument.attributes, ...authority }, projectDocument.body), 'utf8');
  const snapshot = normalizeManifest(validManifest(), { clock: () => new Date(timestamp), project: authority });

  await createRecord(root, 'manifest', { id: 'MAN-213', title: 'Verified Manifest', code_root: 'sample_code' });
  const verifiedPath = join(root, 'experiments/manifests/MAN-213.md');
  const verifiedCard = parseMarkdownDocument(await readFile(verifiedPath, 'utf8'), verifiedPath);
  await writeFile(verifiedPath, serializeMarkdownDocument({ ...verifiedCard.attributes, ...snapshot }, verifiedCard.body), 'utf8');
  const ready = await updateRecordStatus(root, 'MAN-213', 'ready', { reason: 'Exact normalized snapshot checked.' });
  assert.equal(ready.attributes.status, 'ready');

  await createRecord(root, 'manifest', { id: 'MAN-214', title: 'Forged Manifest', code_root: 'sample_code' });
  const forgedPath = join(root, 'experiments/manifests/MAN-214.md');
  const forgedCard = parseMarkdownDocument(await readFile(forgedPath, 'utf8'), forgedPath);
  await writeFile(forgedPath, serializeMarkdownDocument({
    ...forgedCard.attributes,
    ...snapshot,
    normalized_hash: 'f'.repeat(64),
    optimizer_scheduler: { ...snapshot.optimizer_scheduler, optimizer: { x: true } }
  }, forgedCard.body), 'utf8');
  const forgedBefore = await readFile(forgedPath, 'utf8');
  await assert.rejects(() => updateRecordStatus(root, 'MAN-214', 'ready'), error => error.code === 'VALIDATION');
  assert.equal(await readFile(forgedPath, 'utf8'), forgedBefore);

  const driftedProject = parseMarkdownDocument(await readFile(projectPath, 'utf8'), projectPath);
  await writeFile(projectPath, serializeMarkdownDocument({
    ...driftedProject.attributes,
    resources: {
      ...driftedProject.attributes.resources,
      sample_code: { ...driftedProject.attributes.resources.sample_code, identity: 'sample-v2' }
    }
  }, driftedProject.body), 'utf8');
  const readyBefore = await readFile(verifiedPath, 'utf8');
  await assert.rejects(() => updateRecordStatus(root, 'MAN-213', 'in_progress'), error => error.code === 'VALIDATION');
  assert.equal(await readFile(verifiedPath, 'utf8'), readyBefore);

  const report = await validateProject(root);
  assert.equal(report.issues.some(issue => issue.code === 'MANIFEST_SEMANTIC_INVALID' && issue.relatedIds.includes('MAN-213')), true);
});

test('record creation rejects multiline title and escapes Markdown presentation while preserving frontmatter values', async () => {
  const root = await projectFixture();
  await assert.rejects(
    () => createRecord(root, 'driver', { id: 'RQ-221', title: 'Safe\n## Injected [[ACT-999]]', source: 'brief', question: 'Question?' }),
    error => error.code === 'USAGE'
  );
  assert.equal(await pathExists(join(root, 'research')), false);

  const source = 'brief\n## forged\n- item `code` [[ACT-999]]';
  const question = 'line one:\nline two';
  await createRecord(root, 'driver', { id: 'RQ-222', title: 'Safe [[ACT-999]] `title`', source, question });
  const created = parseMarkdownDocument(await readFile(join(root, 'research/questions/RQ-222.md'), 'utf8'), 'RQ-222.md');
  assert.equal(created.attributes.source, source);
  assert.equal(created.attributes.question, question);
  assert.equal(created.body.includes('\n## forged'), false);
  assert.equal(created.body.includes('```'), false);
  assert.equal(created.body.includes('[[ACT-999]]'), false);
  assert.match(created.body, /\\\[\\\[ACT-999\\\]\\\]/);
});

test('status mutation follows Core transitions, appends history, preserves content, and advances updated strictly', async () => {
  const root = await projectFixture();
  await createRecord(root, 'driver', { id: 'RQ-301', title: 'Status', source: 'brief', question: 'Status?' });
  const path = join(root, 'research/questions/RQ-301.md');
  const initial = parseMarkdownDocument(await readFile(path, 'utf8'), path);
  const future = '2099-01-01T00:00:00.000Z';
  await writeFile(path, serializeMarkdownDocument({ ...initial.attributes, updated: future, custom: { keep: true } }, `${initial.body}\nUnrelated body text.\n`), 'utf8');

  const updated = await updateRecordStatus(root, 'RQ-301', 'defined', { reason: 'Scope recorded.' });
  const persisted = parseMarkdownDocument(await readFile(path, 'utf8'), path);

  assert.deepEqual(Object.keys(updated), ['id', 'type', 'path', 'attributes']);
  assert.equal(updated.id, 'RQ-301');
  assert.equal(updated.type, 'driver');
  assert.equal(updated.attributes.status, 'defined');
  assert.equal(Date.parse(updated.attributes.updated) > Date.parse(future), true);
  assert.equal(updated.attributes.created, initial.attributes.created);
  assert.deepEqual(updated.attributes.custom, { keep: true });
  assert.throws(() => { updated.attributes.custom.keep = false; }, TypeError);
  assert.deepEqual(updated.attributes.status_history, [{ from: 'inbox', to: 'defined', at: updated.attributes.updated, reason: 'Scope recorded.' }]);
  assert.equal(persisted.body.includes('Unrelated body text.'), true);
  await assert.rejects(() => updateRecordStatus(root, 'RQ-301', 'closed', { verifiedAt: timestamp }), error => error.code === 'INVALID_TRANSITION');
});

test('closing always requires valid verification and reopening requires reason plus affected ids', async () => {
  const root = await projectFixture();
  await createRecord(root, 'driver', { id: 'RQ-401', title: 'Lifecycle', source: 'brief', question: 'Lifecycle?' });
  for (const status of ['defined', 'ready', 'in_progress']) await updateRecordStatus(root, 'RQ-401', status, {});

  await assert.rejects(() => updateRecordStatus(root, 'RQ-401', 'closed', {}), error => error.code === 'STATUS_CONDITION');
  await assert.rejects(() => updateRecordStatus(root, 'RQ-401', 'closed', { verifiedAt: '2026-02-31T00:00:00Z' }), error => error.code === 'STATUS_CONDITION');
  const closed = await updateRecordStatus(root, 'RQ-401', 'closed', { verifiedAt: timestamp });
  assert.equal(closed.attributes.verified_at, timestamp);

  await assert.rejects(() => updateRecordStatus(root, 'RQ-401', 'reopened', { reason: ' ', affectedIds: ['ACT-001'] }), error => error.code === 'STATUS_CONDITION');
  await assert.rejects(() => updateRecordStatus(root, 'RQ-401', 'reopened', { reason: 'New evidence', affectedIds: [] }), error => error.code === 'STATUS_CONDITION');
  const reopened = await updateRecordStatus(root, 'RQ-401', 'reopened', { reason: 'New evidence', affectedIds: ['ACT-001'] });
  assert.deepEqual(reopened.attributes.affected_ids, ['ACT-001']);
  assert.deepEqual(reopened.attributes.status_history.at(-1), {
    from: 'closed', to: 'reopened', at: reopened.attributes.updated, reason: 'New evidence'
  });
});

test('validation rejects reopened history without preserved reason and affected ids', async () => {
  const root = await projectFixture();
  await writeRecord(root, 'research/questions/RQ-501.md', driver('RQ-501', {
    status: 'reopened',
    verified_at: timestamp,
    status_history: [{ from: 'closed', to: 'reopened', at: timestamp, reason: '' }]
  }));

  const report = await validateProject(root);

  assert.equal(report.issues.some(issue => issue.code === 'REOPENED_WITHOUT_CONTEXT' && issue.path === 'research/questions/RQ-501.md'), true);
});

test('validation keeps checking reopen context after the record advances to defined', async () => {
  const root = await projectFixture();
  await writeRecord(root, 'research/questions/RQ-502.md', driver('RQ-502', {
    status: 'defined',
    verified_at: timestamp,
    status_history: [
      { from: 'closed', to: 'reopened', at: timestamp, reason: '' },
      { from: 'reopened', to: 'defined', at: '2026-08-03T00:00:01.000Z', reason: 'Reframed.' }
    ]
  }));

  const report = await validateProject(root);

  assert.equal(report.issues.some(issue => issue.code === 'REOPENED_WITHOUT_CONTEXT' && issue.path === 'research/questions/RQ-502.md'), true);
});

test('validation reports missing verification when a closed record has an empty history', async () => {
  const root = await projectFixture();
  await writeRecord(root, 'research/questions/RQ-503.md', driver('RQ-503', {
    status: 'closed',
    status_history: []
  }));

  const report = await validateProject(root);
  const codes = report.issues
    .filter(issue => issue.path === 'research/questions/RQ-503.md')
    .map(issue => issue.code);

  assert.equal(codes.includes('INVALID_STATUS_HISTORY'), true);
  assert.equal(codes.includes('CLOSED_WITHOUT_VERIFICATION'), true);
});

test('status mutation rejects an invalid current schema without rewriting the file', async () => {
  const root = await projectFixture();
  await writeRecord(root, 'research/questions/RQ-601.md', driver('RQ-601', { status_history: 'corrupt' }));
  const path = join(root, 'research/questions/RQ-601.md');
  const before = await readFile(path, 'utf8');

  await assert.rejects(
    () => updateRecordStatus(root, 'RQ-601', 'defined', { reason: 'Must not mask corruption.' }),
    error => error.code === 'VALIDATION'
  );
  assert.equal(await readFile(path, 'utf8'), before);
});

test('status mutation rejects illegal, truncated, and non-chronological semantic history byte-identically', async () => {
  const cases = [
    driver('RQ-611', {
      status: 'defined',
      status_history: [{ from: 'inbox', to: 'closed', at: timestamp, reason: 'forged' }],
      verified_at: timestamp
    }),
    driver('RQ-612', { status: 'defined', status_history: [] }),
    driver('RQ-613', {
      status: 'ready',
      status_history: [
        { from: 'inbox', to: 'defined', at: '2026-08-03T00:00:02.000Z', reason: 'first' },
        { from: 'defined', to: 'ready', at: '2026-08-03T00:00:01.000Z', reason: 'backwards' }
      ]
    })
  ];
  for (const attributes of cases) {
    const root = await projectFixture();
    const relativePath = `research/questions/${attributes.id}.md`;
    await writeRecord(root, relativePath, attributes);
    const path = join(root, relativePath);
    const before = await readFile(path, 'utf8');
    await assert.rejects(
      () => updateRecordStatus(root, attributes.id, attributes.status === 'ready' ? 'in_progress' : 'ready', { reason: 'Must reject corrupt history.' }),
      error => error.code === 'VALIDATION'
    );
    assert.equal(await readFile(path, 'utf8'), before);
  }
});
