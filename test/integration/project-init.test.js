import assert from 'node:assert/strict';
import { cp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { enableModule, initProject } from '../../src/project/project.js';
import { main } from '../../src/cli.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../../src/lib/markdown.js';
import { captureIo, pathExists, makeTempDir } from '../helpers/fixtures.js';
import { validateRecord } from '../../src/validation/validator.js';

const coreRoot = join(process.cwd(), 'core');

test('project init creates four core entries with valid, distinct project records', async () => {
  const root = await makeTempDir();

  const initialized = await initProject({ targetDir: root, projectId: 'demo', title: 'Demo', stage: 'research', coreRoot });

  assert.deepEqual(initialized, {
    projectRoot: root,
    created: ['AGENTS.md', 'PROJECT.md', 'plans', '.obsidian'],
    setupRequired: true,
    nextCommand: `research-os project setup-status --project ${root}`
  });
  assert.deepEqual((await readdir(root)).sort(), ['.obsidian', 'AGENTS.md', 'PROJECT.md', 'plans']);
  assert.equal(await pathExists(join(root, 'plans', 'active.md')), true);
  assert.equal(await pathExists(join(root, 'experiments')), false);

  const project = parseMarkdownDocument(await readFile(join(root, 'PROJECT.md'), 'utf8'), 'PROJECT.md').attributes;
  const activePlan = parseMarkdownDocument(await readFile(join(root, 'plans', 'active.md'), 'utf8'), 'plans/active.md').attributes;
  assert.equal(project.id, 'PRJ-001');
  assert.equal(project.project_id, 'demo');
  assert.equal(project.foreground_objective, null);
  assert.deepEqual(project.forecast_settings, {
    as_of: project.created.slice(0, 10),
    timezone: 'UTC',
    integration_buffer: 0.2,
    default_weekly_capacity: 5,
    capacity_calendar: []
  });
  assert.equal(activePlan.id, 'PLN-001');
  assert.equal(Object.hasOwn(activePlan, 'objective'), false);
  assert.deepEqual(activePlan.resume_point, {
    last_verified_point: 'Project initialized.',
    next_action: 'Define the foreground objective.',
    next_command_or_edit: null,
    required_files: ['PROJECT.md', 'plans/active.md'],
    risks: [],
    reforecast_trigger: null
  });
  assert.deepEqual(activePlan.completion_conditions, []);
  assert.deepEqual(activePlan.scope, []);
  assert.deepEqual(activePlan.out_of_scope, []);
  assert.equal(activePlan.resume_point.next_action, 'Define the foreground objective.');
  assert.deepEqual(activePlan.writable_paths, []);
  assert.equal(activePlan.disruption_mode, null);
  assert.deepEqual(validateRecord('project', project), []);
  assert.deepEqual(validateRecord('exec-plan', activePlan), []);
  const activePlanBody = (await readFile(join(root, 'plans', 'active.md'), 'utf8'));
  for (const section of [
    'Completion conditions', 'Current work', 'Blockers and decisions needed', 'History'
  ]) {
    assert.match(activePlanBody, new RegExp(`^## ${section}$`, 'm'));
  }

  const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
  for (const required of [
    '$research-os',
    'research-os doctor --project',
    'research-os project setup-status --project',
    'research-os session context --project'
  ]) assert.equal(agents.includes(required), true, required);
  assert.match(agents, /stop|blocker/iu);
  assert.equal(agents.includes(coreRoot), false);
  assert.equal((agents.match(/[A-Za-z0-9$.-]+/gu) ?? []).length <= 220, true);
});

test('project init preserves YAML-looking and colon-containing identity values', async () => {
  const cases = [
    { projectId: 'true', title: 'null', stage: '2026-08-03' },
    { projectId: 'demo:alpha', title: 'Research: phase one', stage: 'research: discovery' }
  ];

  for (const [index, identity] of cases.entries()) {
    const root = join(await makeTempDir(), `vault-${index}`);
    await initProject({ targetDir: root, ...identity, coreRoot });
    const project = parseMarkdownDocument(await readFile(join(root, 'PROJECT.md'), 'utf8'), 'PROJECT.md').attributes;
    assert.equal(project.project_id, identity.projectId);
    assert.equal(project.title, identity.title);
    assert.equal(project.stage, identity.stage);
    assert.deepEqual(validateRecord('project', project), []);
  }
});

test('project init validates generated Project and ExecPlan records before success', async () => {
  const invalidCore = join(await makeTempDir(), 'invalid-core');
  const targetDir = join(await makeTempDir(), 'vault');
  await cp(coreRoot, invalidCore, { recursive: true });
  const templatePath = join(invalidCore, 'templates', 'project', 'PROJECT.md');
  await writeFile(templatePath, (await readFile(templatePath, 'utf8')).replace('type: project', 'type: not_project'), 'utf8');

  await assert.rejects(
    () => initProject({ targetDir, projectId: 'demo', title: 'Demo', stage: 'research', coreRoot: invalidCore }),
    error => error.code === 'VALIDATION'
  );
});

test('enabling a module is idempotent and records one sorted module link', async () => {
  const root = await makeTempDir();
  await initProject({ targetDir: root, projectId: 'demo', title: 'Demo', stage: 'research', coreRoot });

  assert.deepEqual(await enableModule(root, 'evidence'), { moduleName: 'evidence', createdFiles: ['evidence/README.md'] });
  assert.deepEqual(await enableModule(root, 'archive'), { moduleName: 'archive', createdFiles: ['archive/README.md'] });
  assert.deepEqual(await enableModule(root, 'evidence'), { moduleName: 'evidence', createdFiles: [] });

  const projectText = await readFile(join(root, 'PROJECT.md'), 'utf8');
  const project = parseMarkdownDocument(projectText, 'PROJECT.md');
  assert.deepEqual(project.attributes.modules, ['archive', 'evidence']);
  assert.equal((project.body.match(/^## Modules$/gm) ?? []).length, 1);
  assert.equal((project.body.match(/\[archive\]\(archive\/README\.md\)/g) ?? []).length, 1);
  assert.equal((project.body.match(/\[evidence\]\(evidence\/README\.md\)/g) ?? []).length, 1);
  assert.match(await readFile(join(root, 'evidence', 'README.md'), 'utf8'), /Authority: evidence records\./);
});

test('CLI initializes, shows, and enables a module without duplicate files', async () => {
  const root = await makeTempDir();
  const init = captureIo();
  assert.equal(await main(['project', 'init', '--target', root, '--id', 'demo', '--title', 'Demo', '--stage', 'research'], init.io), 0);
  const initialized = JSON.parse(init.output().stdout);
  assert.equal(initialized.setupRequired, true);
  assert.equal(initialized.nextCommand, `research-os project setup-status --project ${root}`);

  const showFirst = captureIo();
  assert.equal(await main(['project', 'show', '--project', root], showFirst.io), 0);
  const showSecond = captureIo();
  assert.equal(await main(['project', 'show', '--project', root], showSecond.io), 0);
  assert.equal(showFirst.output().stdout, showSecond.output().stdout);
  assert.equal(showFirst.output().stdout.endsWith('\n'), true);
  assert.equal(JSON.parse(showFirst.output().stdout).project_id, 'demo');

  const firstEnable = captureIo();
  assert.equal(await main(['module', 'enable', '--project', root, '--name', 'evidence'], firstEnable.io), 0);
  assert.deepEqual(JSON.parse(firstEnable.output().stdout), { moduleName: 'evidence', createdFiles: ['evidence/README.md'] });
  const repeatedEnable = captureIo();
  assert.equal(await main(['module', 'enable', '--project', root, '--name', 'evidence'], repeatedEnable.io), 0);
  assert.deepEqual(JSON.parse(repeatedEnable.output().stdout), { moduleName: 'evidence', createdFiles: [] });
});

test('CLI refuses non-empty project targets and malformed options', async () => {
  const root = await makeTempDir();
  await writeFile(join(root, 'unrelated.txt'), 'keep', 'utf8');
  const occupied = captureIo();
  assert.equal(await main(['project', 'init', '--target', root, '--id', 'demo', '--title', 'Demo', '--stage', 'research'], occupied.io), 5);
  assert.match(occupied.output().stderr, /^\[CONFLICT\]/);

  const malformed = captureIo();
  assert.equal(await main(['module', 'enable', '--name', 'unknown'], malformed.io), 2);
  assert.match(malformed.output().stderr, /^\[USAGE\]/);
  const unknown = captureIo();
  assert.equal(await main(['module', 'enable', '--project', root, '--name', 'not-a-module'], unknown.io), 2);
  assert.match(unknown.output().stderr, /^\[USAGE\]/);
  const unknownOption = captureIo();
  assert.equal(await main(['project', 'show', '--project', root, '--unknown', 'value'], unknownOption.io), 2);
  assert.match(unknownOption.output().stderr, /^\[USAGE\]/);
});

test('CLI rejects multiline identity values deterministically without creating a vault', async () => {
  for (const option of ['--id', '--title', '--stage']) {
    const firstTarget = join(await makeTempDir(), 'first');
    const secondTarget = join(await makeTempDir(), 'second');
    const args = ['project', 'init', '--target', firstTarget, '--id', 'demo', '--title', 'Demo', '--stage', 'research'];
    args[args.indexOf(option) + 1] = 'line one\nline two';
    const first = captureIo();
    assert.equal(await main(args, first.io), 2);
    const second = captureIo();
    args[3] = secondTarget;
    assert.equal(await main(args, second.io), 2);
    assert.deepEqual(first.output(), second.output());
    assert.equal(await pathExists(firstTarget), false);
    assert.equal(await pathExists(secondTarget), false);
  }
});

test('CLI resource add, list, and resolve preserve the Project body and registry contract', async () => {
  const root = await makeTempDir();
  await initProject({ targetDir: root, projectId: 'demo', title: 'Demo', stage: 'research', coreRoot });
  const before = parseMarkdownDocument(await readFile(join(root, 'PROJECT.md'), 'utf8'), 'PROJECT.md');
  const futureUpdated = '2099-01-01T00:00:00.000Z';
  await writeFile(join(root, 'PROJECT.md'), serializeMarkdownDocument({ ...before.attributes, updated: futureUpdated }, before.body), 'utf8');

  const added = captureIo();
  assert.equal(await main(['project', 'resource', 'add', '--project', root, '--name', 'experiment_results', '--uri', '../shared-results', '--role', 'experiment-results', '--access', 'read-only', '--identity', 'dataset-v1'], added.io), 0);
  assert.deepEqual(JSON.parse(added.output().stdout), {
    name: 'experiment_results',
    resource: { uri: '../shared-results', role: 'experiment-results', access: 'read-only', identity: 'dataset-v1' }
  });
  const afterFirstAdd = parseMarkdownDocument(await readFile(join(root, 'PROJECT.md'), 'utf8'), 'PROJECT.md');
  assert.equal(afterFirstAdd.attributes.created, before.attributes.created);
  assert.equal(afterFirstAdd.attributes.title, before.attributes.title);
  assert.equal(afterFirstAdd.body, before.body);
  assert.equal(Date.parse(afterFirstAdd.attributes.updated) > Date.parse(futureUpdated), true);

  const addedAgain = captureIo();
  assert.equal(await main(['project', 'resource', 'add', '--project', root, '--name', 'shared_data', '--uri', '../shared-data', '--role', 'input-data', '--access', 'read-only'], addedAgain.io), 0);
  const afterSecondAdd = parseMarkdownDocument(await readFile(join(root, 'PROJECT.md'), 'utf8'), 'PROJECT.md');
  assert.equal(Date.parse(afterSecondAdd.attributes.updated) > Date.parse(afterFirstAdd.attributes.updated), true);

  const listed = captureIo();
  assert.equal(await main(['project', 'resource', 'list', '--project', root], listed.io), 0);
  assert.deepEqual(JSON.parse(listed.output().stdout), [
    { name: 'experiment_results', uri: '../shared-results', role: 'experiment-results', access: 'read-only', identity: 'dataset-v1' },
    { name: 'shared_data', uri: '../shared-data', role: 'input-data', access: 'read-only' }
  ]);

  const resolved = captureIo();
  assert.equal(await main(['project', 'resource', 'resolve', '--project', root, '--ref', 'experiment_results:EXP-001/run.json'], resolved.io), 0);
  assert.deepEqual(JSON.parse(resolved.output().stdout), {
    uri: '../shared-results/EXP-001/run.json', resourceName: 'experiment_results', relativePath: 'EXP-001/run.json', access: 'read-only'
  });

  const after = parseMarkdownDocument(await readFile(join(root, 'PROJECT.md'), 'utf8'), 'PROJECT.md');
  assert.equal(after.body, before.body);
  assert.deepEqual(after.attributes.resources, {
    experiment_results: { uri: '../shared-results', role: 'experiment-results', access: 'read-only', identity: 'dataset-v1' },
    shared_data: { uri: '../shared-data', role: 'input-data', access: 'read-only' }
  });
  assert.deepEqual(validateRecord('project', after.attributes), []);

  const indexPath = join(await makeTempDir(), 'PROJECTS.md');
  const indexed = captureIo();
  assert.equal(await main(['project', 'index', 'add', '--index', indexPath, '--project', root, '--next-milestone', 'Validate baseline'], indexed.io), 0);
  assert.equal(JSON.parse(indexed.output().stdout).updated, afterSecondAdd.attributes.updated);

  const duplicate = captureIo();
  assert.equal(await main(['project', 'resource', 'add', '--project', root, '--name', 'experiment_results', '--uri', '/other', '--role', 'experiment-results', '--access', 'read-only'], duplicate.io), 5);
  assert.match(duplicate.output().stderr, /^\[CONFLICT\]/);
  for (const args of [
    ['project', 'resource', 'add', '--project', root, '--name', 'bad', '--uri', '/safe', '--role', 'data'],
    ['project', 'resource', 'add', '--project', root, '--name', 'bad', '--uri', '/safe', '--role', 'data', '--access', 'write'],
    ['project', 'resource', 'list', '--project', root, '--unknown', 'x']
  ]) {
    const invalid = captureIo();
    assert.equal(await main(args, invalid.io), 2);
    assert.match(invalid.output().stderr, /^\[USAGE\]/);
  }
});
