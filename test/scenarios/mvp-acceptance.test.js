import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../../src/cli.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../../src/lib/markdown.js';
import { createRecord } from '../../src/records/create.js';
import { captureIo, configureSessionFixture, makeCandidateCoreFixture, makeProjectFixture, makeReadyActionFixture, makeTempDir, validManifest } from '../helpers/fixtures.js';

const digest = value => createHash('sha256').update(value).digest('hex');
async function rewrite(root, relativePath, changes) {
  const path = join(root, relativePath);
  const doc = parseMarkdownDocument(await readFile(path, 'utf8'), path);
  await writeFile(path, serializeMarkdownDocument({ ...doc.attributes, ...changes }, doc.body), 'utf8');
}
async function cli(args) { const capture = captureIo(); const code = await main(args, capture.io); return { code, ...capture.output() }; }

test('1. new project creates only four core entries', async () => {
  const target = join(await makeTempDir(), 'vault');
  const result = await cli(['project', 'init', '--target', target, '--id', 's1', '--title', 'Scenario 1', '--stage', 'research']);
  assert.equal(result.code, 0);
  assert.deepEqual((await readdir(target)).sort(), ['.obsidian', 'AGENTS.md', 'PROJECT.md', 'plans']);
  const initialized = JSON.parse(result.stdout);
  assert.deepEqual(initialized.created.sort(), ['.obsidian', 'AGENTS.md', 'PROJECT.md', 'plans']);
  assert.equal(initialized.setupRequired, true);
  assert.equal(initialized.nextCommand, `research-os project setup-status --project ${target}`);
});

// Controller-level coverage only: this does not prove capability discovery by a fresh Codex Session.
test('2. session context summarizes a configured fixture through the importable API', async () => {
  const root = await makeProjectFixture();
  await makeReadyActionFixture(root);
  await configureSessionFixture(root, { plan: { blockers: ['Awaiting checked artifact.'], writable_paths: ['plans/actions/ACT-001.md'] } });
  const result = await cli(['session', 'context', '--project', root]);
  assert.equal(result.code, 0);
  const context = JSON.parse(result.stdout);
  assert.match(context.foregroundObjective, /ACT-001/u);
  assert.match(context.nextAction, /ACT-001/u);
  assert.deepEqual(context.blockers, ['Awaiting checked artifact.']);
  assert.deepEqual(context.writablePaths, ['plans/actions/ACT-001.md']);
  assert.deepEqual(context.authoritativeSources.slice(0, 2), ['AGENTS.md', 'PROJECT.md']);
});

test('3. unapproved code root cannot receive an official receipt', async () => {
  const root = await makeProjectFixture();
  await rewrite(root, 'PROJECT.md', {
    resources: {
      rogue: { uri: 'ssh://example.invalid/rogue', role: 'implementation', access: 'read-only', identity: 'rogue-v1' },
      data: { uri: './data', role: 'data', access: 'read-only', identity: 'data-v1' },
      models: { uri: './models', role: 'model', access: 'read-only', identity: 'models-v1' },
      experiment_results: { uri: './results', role: 'results', access: 'read-write', identity: 'results-v1' }
    }, approved_code_roots: []
  });
  const result = await cli(['experiment', 'manifest-check', '--project', root, '--manifest', JSON.stringify(validManifest({ code_root: 'rogue', resolved_code_root: { resource: 'rogue', uri: 'ssh://example.invalid/rogue', identity: 'rogue-v1' } }))]);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /CODE_ROOT_NOT_APPROVED/u);
  assert.equal(result.stdout.includes('officialReceipt'), false);
});

test('4. Claim traces to Evidence, Result, Run, and Driver', async () => {
  const root = await makeProjectFixture();
  await createRecord(root, 'driver', { id: 'RQ-004', title: 'Driver', source: 'brief', question: 'Trace?' });
  await createRecord(root, 'experiment', { id: 'EXP-004', title: 'Experiment', scientific_question: 'Trace?' });
  await createRecord(root, 'manifest', { id: 'MAN-004', title: 'Manifest', code_root: 'code' });
  await createRecord(root, 'run', { id: 'RUN-004', title: 'Run', experiment: 'EXP-004', manifest: 'MAN-004' });
  await createRecord(root, 'result', { id: 'RES-004', title: 'Result', run: 'RUN-004' });
  await createRecord(root, 'evidence', { id: 'EVD-004', title: 'Evidence', sources: ['RES-004', 'RQ-004'] });
  await createRecord(root, 'claim', { id: 'CLM-004', title: 'Claim', evidence: ['EVD-004'] });
  const result = await cli(['record', 'trace', '--project', root, '--id', 'CLM-004']);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout).types.sort(), ['claim', 'driver', 'evidence', 'experiment', 'manifest', 'result', 'run']);
});

test('5. unauthorized background diff is rejected', async () => {
  const registration = { writable_paths: ['evidence/packets/EVD-005.md'], control_paths: ['PROJECT.md', 'plans/active.md'] };
  const result = await cli(['session', 'check-diff', '--registration', JSON.stringify(registration), '--changed-paths', JSON.stringify(['PROJECT.md', 'writing/response/WRT-005.md'])]);
  assert.equal(result.code, 3);
  assert.equal(JSON.parse(result.stdout).violations.some(item => item.code === 'WRITE_SCOPE_VIOLATION'), true);
});

test('6. generated views rebuild without changing canonical hashes', async () => {
  const root = await makeProjectFixture();
  const before = [await readFile(join(root, 'PROJECT.md')), await readFile(join(root, 'plans/active.md'))].map(digest);
  assert.equal((await cli(['view', 'build', '--project', root])).code, 0);
  assert.equal((await cli(['view', 'clean', '--project', root])).code, 0);
  const rebuilt = await cli(['view', 'build', '--project', root]);
  assert.equal(rebuilt.code, 0);
  assert.deepEqual([await readFile(join(root, 'PROJECT.md')), await readFile(join(root, 'plans/active.md'))].map(digest), before);
  assert.equal(JSON.parse(rebuilt.stdout).files.length, 5);
});

test('7. resource URI migration needs one registry edit', async () => {
  const root = await makeProjectFixture();
  assert.equal((await cli(['project', 'resource', 'add', '--project', root, '--name', 'results', '--uri', './old-results', '--role', 'results', '--access', 'read-only'])).code, 0);
  const first = await cli(['project', 'resource', 'resolve', '--project', root, '--ref', 'results:metrics.json']);
  await rewrite(root, 'PROJECT.md', { resources: { results: { uri: './new-results', role: 'results', access: 'read-only' } } });
  const second = await cli(['project', 'resource', 'resolve', '--project', root, '--ref', 'results:metrics.json']);
  assert.equal(first.code, 0); assert.equal(second.code, 0);
  assert.match(JSON.parse(first.stdout).uri, /old-results/u);
  assert.match(JSON.parse(second.stdout).uri, /new-results/u);
});

test('8. pinned Core does not change before approved preview', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture();
  const preview = await cli(['core', 'upgrade-preview', '--project', root, '--candidate-core', candidate]);
  const before = await cli(['project', 'show', '--project', root]);
  assert.equal(preview.code, 0); assert.equal(JSON.parse(before.stdout).core_version, '2.0.0');
  const apply = await cli(['core', 'upgrade-apply', '--project', root, '--candidate-core', candidate, '--preview-hash', JSON.parse(preview.stdout).hash]);
  assert.equal(apply.code, 0);
  assert.equal(JSON.parse((await cli(['project', 'show', '--project', root])).stdout).core_version, '2.1.0');
});

test('9. disruption resume packet restores last verified point and triggers reforecast', async () => {
  const root = await makeProjectFixture();
  await makeReadyActionFixture(root);
  await configureSessionFixture(root);
  const packet = {
    status: 'active', capacityReduction: 'Travel week: 50 percent capacity.', pausedActions: ['ACT-001'],
    resumePoint: {
      lastVerifiedPoint: 'ACT-001 inputs checked.', nextAction: 'Resume ACT-001 from the checked inputs.',
      nextCommandOrEdit: 'research-os session preflight', requiredFiles: ['PROJECT.md', 'plans/active.md', 'plans/actions/ACT-001.md'],
      risks: ['Capacity remains reduced.'], reforecastTrigger: 'Update the capacity calendar and rebuild views.'
    }
  };
  const disrupted = await cli(['session', 'disruption', '--project', root, '--update', JSON.stringify(packet)]);
  const context = await cli(['session', 'context', '--project', root]);
  const forecast = await cli(['forecast', 'calculate', '--project', root]);
  assert.equal(disrupted.code, 0); assert.equal(context.code, 0); assert.equal(forecast.code, 0);
  assert.equal(JSON.parse(context.stdout).activePlan.disruption_mode.last_verified_point, packet.resumePoint.lastVerifiedPoint);
  assert.equal(JSON.parse(context.stdout).activePlan.disruption_mode.reforecast_trigger, packet.resumePoint.reforecastTrigger);
  assert.equal(typeof JSON.parse(forecast.stdout).confidence, 'string');
});
