import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { main } from '../../src/cli.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../../src/lib/markdown.js';
import { inspectProjectSetup } from '../../src/project/setup-status.js';
import { updateRecordStatus } from '../../src/records/create.js';
import { captureIo, configureSessionFixture, makeProjectFixture } from '../helpers/fixtures.js';

const REVIEW_IDS = [
  'writable-paths',
  'timezone-and-capacity',
  'resources-and-access',
  'modules',
  'approved-code-roots',
  'canonical-writing-sources'
];

async function configureReviewedProject(root, { projectObjective, planObjective, transition = true } = {}) {
  const objective = projectObjective ?? 'Complete the approved first research milestone.';
  const activePlanObjective = planObjective ?? objective;
  const nextAction = 'Start the first approved Action.';
  await configureSessionFixture(root, {
    objective,
    resumePoint: {
      last_verified_point: 'Setup proposal approved.',
      next_action: nextAction,
      next_command_or_edit: 'research-os session preflight',
      required_files: ['PROJECT.md', 'plans/active.md'],
      risks: [],
      reforecast_trigger: null
    },
    plan: {
      completion_conditions: ['The approved milestone acceptance is verified.'],
      scope: ['The first approved research milestone.'],
      out_of_scope: ['Unapproved follow-on work.'],
      writable_paths: ['plans/**']
    }
  });
  if (transition) {
    await updateRecordStatus(root, 'PLN-001', 'ready', { reason: 'Setup reviewed and approved by the human.' });
    await updateRecordStatus(root, 'PRJ-001', 'ready', { reason: 'Setup reviewed and approved by the human.' });
  }
}

test('fresh project exposes incomplete setup without changing authority', async () => {
  const root = await makeProjectFixture();
  const before = await Promise.all([
    readFile(join(root, 'PROJECT.md')),
    readFile(join(root, 'plans', 'active.md'))
  ]);

  const report = await inspectProjectSetup(root);

  assert.equal(report.configured, false);
  const gaps = new Set(report.missingAuthority.map(item => item.id));
  for (const id of [
    'foreground-objective', 'completion-conditions',
    'scope', 'resume-next-action', 'project-status', 'active-plan-status'
  ]) assert.equal(gaps.has(id), true, id);
  assert.deepEqual(report.humanReview.map(item => item.id), REVIEW_IDS);
  assert.equal(report.humanReview.every(item => item.status === 'review-required'), true);
  assert.match(report.humanReview.find(item => item.id === 'resources-and-access').observation, /empty may be legitimate/iu);
  assert.deepEqual(report.authoritySources, ['PROJECT.md', 'plans/active.md']);
  assert.match(report.nextAction, /proposal|review|approve/iu);
  assert.deepEqual(await Promise.all([
    readFile(join(root, 'PROJECT.md')),
    readFile(join(root, 'plans', 'active.md'))
  ]), before);
});

test('reviewed Project and Active Plan produce a configured report and CLI JSON', async () => {
  const root = await makeProjectFixture();
  await configureReviewedProject(root);

  const report = await inspectProjectSetup(root);
  assert.equal(report.configured, true);
  assert.deepEqual(report.missingAuthority, []);
  assert.equal(report.humanReview.every(item => item.status === 'confirmed'), true);
  assert.match(report.nextAction, /context|preflight/iu);

  const capture = captureIo();
  assert.equal(await main(['project', 'setup-status', '--project', root], capture.io), 0);
  assert.deepEqual(JSON.parse(capture.output().stdout), report);
  assert.equal(capture.output().stderr, '');
});

test('Project is the single source of the current objective', async () => {
  const root = await makeProjectFixture();
  await configureReviewedProject(root);
  const projectPath = join(root, 'PROJECT.md');
  const project = parseMarkdownDocument(await readFile(projectPath, 'utf8'), 'PROJECT.md');
  await writeFile(projectPath, serializeMarkdownDocument({
    ...project.attributes,
    foreground_objective: 'A different approved-looking objective.'
  }, project.body), 'utf8');

  const report = await inspectProjectSetup(root);
  assert.equal(report.configured, true);
  assert.equal(report.missingAuthority.length, 0);
});

test('complete-looking fields still require recorded review and valid project authority', async () => {
  const unreviewedRoot = await makeProjectFixture();
  await configureReviewedProject(unreviewedRoot, { transition: false });
  const unreviewed = await inspectProjectSetup(unreviewedRoot);
  assert.equal(unreviewed.configured, false);
  assert.deepEqual(unreviewed.missingAuthority.map(item => item.id), ['project-status', 'active-plan-status']);
  assert.equal(unreviewed.humanReview.every(item => item.status === 'review-required'), true);

  const invalidRoot = await makeProjectFixture();
  await configureReviewedProject(invalidRoot);
  const planPath = join(invalidRoot, 'plans', 'active.md');
  const plan = parseMarkdownDocument(await readFile(planPath, 'utf8'), 'plans/active.md');
  await writeFile(planPath, serializeMarkdownDocument({
    ...plan.attributes,
    writable_paths: ['../outside']
  }, plan.body), 'utf8');
  const invalid = await inspectProjectSetup(invalidRoot);
  assert.equal(invalid.configured, false);
  assert.equal(invalid.missingAuthority[0].id, 'project-validation');
  assert.equal(invalid.missingAuthority[0].details.length > 0, true);
});
