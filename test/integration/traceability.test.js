import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { main } from '../../src/cli.js';
import { createRecord } from '../../src/records/create.js';
import { addProjectResource } from '../../src/project/project.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../../src/lib/markdown.js';
import { validateProject } from '../../src/validation/validator.js';
import { captureIo, makeProjectFixture } from '../helpers/fixtures.js';

const traceModule = await import('../../src/records/trace.js').catch(() => ({}));
const traceClaim = traceModule.traceClaim ?? (async () => { throw new Error('traceClaim is not implemented'); });
async function projectFixture() {
  return makeProjectFixture();
}

async function rewriteRecord(root, path, attributes, body) {
  const absolute = join(root, path);
  const current = parseMarkdownDocument(await readFile(absolute, 'utf8'), absolute);
  await writeFile(absolute, serializeMarkdownDocument({ ...current.attributes, ...attributes }, body ?? current.body), 'utf8');
}

async function createExperimentalTrace(root, approvalStatus = 'draft') {
  await createRecord(root, 'driver', { id: 'RQ-001', title: 'Question', source: 'brief', question: 'Does it work?' });
  await createRecord(root, 'experiment', { id: 'EXP-001', title: 'Experiment', scientific_question: 'Does it work?' });
  await createRecord(root, 'manifest', { id: 'MAN-001', title: 'Manifest', code_root: 'code' });
  await createRecord(root, 'run', { id: 'RUN-001', title: 'Run', experiment: 'EXP-001', manifest: 'MAN-001' });
  await createRecord(root, 'result', { id: 'RES-001', title: 'Result', run: 'RUN-001' });
  await createRecord(root, 'evidence', { id: 'EVD-001', title: 'Evidence', sources: ['RES-001', 'RQ-001'] });
  await createRecord(root, 'claim', { id: 'CLM-001', title: 'Claim', evidence: ['EVD-001'], approval_status: approvalStatus });
}

test('claim trace follows declared frontmatter fields to driver and experimental provenance deterministically', async () => {
  const root = await projectFixture();
  await createExperimentalTrace(root);

  const first = await traceClaim(root, 'CLM-001');
  const second = await traceClaim(root, 'CLM-001');

  assert.deepEqual([...first.types].sort(), ['claim', 'driver', 'evidence', 'experiment', 'manifest', 'result', 'run']);
  assert.deepEqual(first.edges, [
    { from: 'CLM-001', to: 'EVD-001', field: 'evidence' },
    { from: 'EVD-001', to: 'RES-001', field: 'sources' },
    { from: 'EVD-001', to: 'RQ-001', field: 'sources' },
    { from: 'RES-001', to: 'RUN-001', field: 'run' },
    { from: 'RUN-001', to: 'EXP-001', field: 'experiment' },
    { from: 'RUN-001', to: 'MAN-001', field: 'manifest' }
  ]);
  assert.deepEqual(first.brokenLinks, []);
  assert.deepEqual(first.cycles, []);
  assert.deepEqual(first.paths, [
    ['CLM-001', 'EVD-001', 'RES-001', 'RUN-001', 'EXP-001'],
    ['CLM-001', 'EVD-001', 'RES-001', 'RUN-001', 'MAN-001'],
    ['CLM-001', 'EVD-001', 'RQ-001']
  ]);
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.throws(() => first.types.add('forged'), TypeError);
  assert.throws(() => first.types.delete('claim'), TypeError);
  assert.throws(() => first.types.clear(), TypeError);
  assert.throws(() => Set.prototype.add.call(first.types, 'prototype-forged'), TypeError);
  assert.equal(first.types.has('forged'), false);
  assert.equal(first.types.has('prototype-forged'), false);
});

test('trace ignores body wikilinks but records missing typed targets and cycles', async () => {
  const brokenRoot = await projectFixture();
  await createRecord(brokenRoot, 'claim', { id: 'CLM-002', title: 'Broken', evidence: ['EVD-999'] });
  await rewriteRecord(brokenRoot, 'evidence/claims/CLM-002.md', {}, '# Claim\n\nBody only: [[ACT-999]].\n');
  const broken = await traceClaim(brokenRoot, 'CLM-002');
  assert.deepEqual(broken.brokenLinks, [{ from: 'CLM-002', field: 'evidence', target: 'EVD-999', code: 'MISSING_TARGET' }]);
  assert.equal(broken.brokenLinks.some(link => link.target === 'ACT-999'), false);

  const cycleRoot = await projectFixture();
  await createRecord(cycleRoot, 'evidence', { id: 'EVD-011', title: 'One', counterevidence: ['EVD-012'] });
  await createRecord(cycleRoot, 'evidence', { id: 'EVD-012', title: 'Two', counterevidence: ['EVD-011'] });
  await createRecord(cycleRoot, 'claim', { id: 'CLM-011', title: 'Cycle', evidence: ['EVD-011'] });
  const cycle = await traceClaim(cycleRoot, 'CLM-011');
  assert.deepEqual(cycle.cycles, [['EVD-011', 'EVD-012', 'EVD-011']]);
});

test('approved Claim accepts complete experimental provenance and rejects blocking gaps', async () => {
  const validRoot = await projectFixture();
  await createExperimentalTrace(validRoot, 'approved');
  const valid = await validateProject(validRoot);
  assert.equal(valid.issues.some(issue => issue.code === 'APPROVED_CLAIM_PROVENANCE'), false);

  const invalidRoot = await projectFixture();
  await createRecord(invalidRoot, 'claim', { id: 'CLM-021', title: 'Unsupported', evidence: ['EVD-999'], approval_status: 'approved' });
  const invalid = await validateProject(invalidRoot);
  assert.equal(invalid.issues.some(issue => issue.code === 'APPROVED_CLAIM_PROVENANCE' && issue.path === 'evidence/claims/CLM-021.md'), true);
});

test('approved Claim rejects direct Driver and Run bypasses and mixed wrong-type evidence branches', async () => {
  const directRoot = await projectFixture();
  await createRecord(directRoot, 'driver', { id: 'RQ-901', title: 'Question', source: 'brief', question: 'Bypass?' });
  await createRecord(directRoot, 'experiment', { id: 'EXP-901', title: 'Experiment', scientific_question: 'Bypass?' });
  await createRecord(directRoot, 'manifest', { id: 'MAN-901', title: 'Manifest', code_root: 'code' });
  await createRecord(directRoot, 'run', { id: 'RUN-901', title: 'Run', experiment: 'EXP-901', manifest: 'MAN-901' });
  await createRecord(directRoot, 'claim', { id: 'CLM-901', title: 'Bypass', evidence: ['RQ-901', 'RUN-901'], approval_status: 'approved' });
  const directTrace = await traceClaim(directRoot, 'CLM-901');
  assert.deepEqual(directTrace.brokenLinks, [
    { from: 'CLM-901', field: 'evidence', target: 'RQ-901', code: 'WRONG_LINK_TYPE', actualType: 'driver', allowedTypes: ['evidence'] },
    { from: 'CLM-901', field: 'evidence', target: 'RUN-901', code: 'WRONG_LINK_TYPE', actualType: 'run', allowedTypes: ['evidence'] }
  ]);
  assert.deepEqual([...directTrace.types], ['claim']);
  const directReport = await validateProject(directRoot);
  assert.equal(directReport.issues.some(issue => issue.code === 'APPROVED_CLAIM_PROVENANCE'), true);
  assert.equal(directReport.issues.filter(issue => issue.code === 'PROVENANCE_LINK_INVALID' && issue.path === 'evidence/claims/CLM-901.md').length, 2);

  const mixedRoot = await projectFixture();
  await createExperimentalTrace(mixedRoot, 'approved');
  await rewriteRecord(mixedRoot, 'evidence/claims/CLM-001.md', { evidence: ['EVD-001', 'RQ-001'] });
  const mixedTrace = await traceClaim(mixedRoot, 'CLM-001');
  assert.equal(mixedTrace.types.has('run'), true);
  assert.equal(mixedTrace.types.has('driver'), true);
  assert.equal(mixedTrace.brokenLinks.some(link => link.code === 'WRONG_LINK_TYPE' && link.target === 'RQ-001'), true);
  assert.equal((await validateProject(mixedRoot)).issues.some(issue => issue.code === 'APPROVED_CLAIM_PROVENANCE'), true);
});

test('approved Claim rejects every malformed evidence item mixed with a valid Evidence ID', async () => {
  const root = await projectFixture();
  await createExperimentalTrace(root, 'approved');
  await rewriteRecord(root, 'evidence/claims/CLM-001.md', { evidence: ['EVD-001', 'plain.pdf', 42] });

  const graph = await traceClaim(root, 'CLM-001');
  assert.deepEqual(graph.brokenLinks.filter(link => link.code === 'INVALID_LINK_VALUE'), [
    { from: 'CLM-001', field: 'evidence', value: 'plain.pdf', code: 'INVALID_LINK_VALUE' },
    { from: 'CLM-001', field: 'evidence', value: 42, code: 'INVALID_LINK_VALUE' }
  ]);
  assert.equal(graph.types.has('evidence'), true);

  const report = await validateProject(root);
  assert.equal(report.issues.filter(issue => issue.code === 'PROVENANCE_LINK_INVALID' && issue.path === 'evidence/claims/CLM-001.md').length, 2);
  assert.equal(report.issues.some(issue => issue.code === 'APPROVED_CLAIM_PROVENANCE' && issue.path === 'evidence/claims/CLM-001.md'), true);
});

test('nested typed provenance arrays stay invalid instead of becoming valid edges', async () => {
  const root = await projectFixture();
  await createExperimentalTrace(root, 'approved');
  await rewriteRecord(root, 'evidence/claims/CLM-001.md', { evidence: [['EVD-001']] });

  const graph = await traceClaim(root, 'CLM-001');
  assert.deepEqual(graph.edges, []);
  assert.deepEqual(graph.brokenLinks, [
    { from: 'CLM-001', field: 'evidence', value: ['EVD-001'], code: 'INVALID_LINK_VALUE' }
  ]);
  assert.deepEqual([...graph.types], ['claim']);

  const report = await validateProject(root);
  assert.equal(report.issues.some(issue => issue.code === 'PROVENANCE_LINK_INVALID' && issue.path === 'evidence/claims/CLM-001.md'), true);
  assert.equal(report.issues.some(issue => issue.code === 'APPROVED_CLAIM_PROVENANCE' && issue.path === 'evidence/claims/CLM-001.md'), true);
});

test('scalar typed provenance fields reject array values without flattening them', async () => {
  const root = await projectFixture();
  await createExperimentalTrace(root, 'approved');
  await rewriteRecord(root, 'experiments/results/RES-001.md', { run: ['RUN-001'] });

  const graph = await traceClaim(root, 'CLM-001');
  assert.equal(graph.edges.some(edge => edge.from === 'RES-001' && edge.to === 'RUN-001'), false);
  assert.deepEqual(graph.brokenLinks.filter(link => link.from === 'RES-001'), [
    { from: 'RES-001', field: 'run', value: ['RUN-001'], code: 'INVALID_LINK_VALUE' }
  ]);

  const report = await validateProject(root);
  assert.equal(report.issues.some(issue => issue.code === 'PROVENANCE_LINK_INVALID' && issue.path === 'experiments/results/RES-001.md'), true);
  assert.equal(report.issues.some(issue => issue.code === 'APPROVED_CLAIM_PROVENANCE' && issue.path === 'evidence/claims/CLM-001.md'), true);
});

test('non-Claim provenance arrays report invalid items without recursively promoting nested IDs', async () => {
  const root = await projectFixture();
  await createExperimentalTrace(root, 'approved');
  await createRecord(root, 'action', { id: 'ACT-001', title: 'Action', driver: 'RQ-001', acceptance: 'Reviewed.' });
  await rewriteRecord(root, 'research/questions/RQ-001.md', {
    actions: ['ACT-001', 'plain.pdf', 42, ['ACT-999']]
  });

  const graph = await traceClaim(root, 'CLM-001');
  assert.equal(graph.edges.some(edge => edge.from === 'RQ-001' && edge.to === 'ACT-001'), true);
  assert.equal(graph.brokenLinks.some(link => link.target === 'ACT-999'), false);
  assert.deepEqual(graph.brokenLinks.filter(link => link.from === 'RQ-001'), [
    { from: 'RQ-001', field: 'actions', value: 'plain.pdf', code: 'INVALID_LINK_VALUE' },
    { from: 'RQ-001', field: 'actions', value: 42, code: 'INVALID_LINK_VALUE' },
    { from: 'RQ-001', field: 'actions', value: ['ACT-999'], code: 'INVALID_LINK_VALUE' }
  ]);

  const report = await validateProject(root);
  assert.equal(report.issues.filter(issue => issue.code === 'PROVENANCE_LINK_INVALID' && issue.path === 'research/questions/RQ-001.md').length, 3);
  assert.equal(report.issues.some(issue => issue.code === 'APPROVED_CLAIM_PROVENANCE' && issue.path === 'evidence/claims/CLM-001.md'), true);
});

test('approved Claim accepts a registered non-experiment Evidence source plus a Driver', async () => {
  const root = await projectFixture();
  await addProjectResource(root, 'papers', { uri: '../papers', role: 'literature', access: 'read-only' });
  await createRecord(root, 'driver', { id: 'RQ-031', title: 'Question', source: 'brief', question: 'What does literature support?' });
  await createRecord(root, 'evidence', { id: 'EVD-031', title: 'Literature evidence', sources: ['papers:article.pdf', 'RQ-031'] });
  await createRecord(root, 'claim', { id: 'CLM-031', title: 'Literature claim', evidence: ['EVD-031'], approval_status: 'approved' });

  const graph = await traceClaim(root, 'CLM-031');
  assert.deepEqual(graph.externalSources, [{ from: 'EVD-031', field: 'sources', ref: 'papers:article.pdf', uri: '../papers/article.pdf' }]);
  assert.deepEqual(graph.brokenSources, []);
  const report = await validateProject(root);
  assert.equal(report.issues.some(issue => issue.code === 'APPROVED_CLAIM_PROVENANCE'), false);
});

test('every invalid Evidence source is reported and blocks approval even beside valid sources', async () => {
  const root = await projectFixture();
  await addProjectResource(root, 'papers', { uri: '../papers', role: 'literature', access: 'read-only' });
  await createRecord(root, 'driver', { id: 'RQ-911', title: 'Question', source: 'brief', question: 'Sources?' });
  await createRecord(root, 'evidence', { id: 'EVD-911', title: 'Mixed sources', sources: ['RQ-911'] });
  await rewriteRecord(root, 'evidence/packets/EVD-911.md', {
    sources: ['RQ-911', 'papers:good.pdf', '/tmp/private.pdf', 'plain.pdf', 'missing:file.pdf', 42]
  });
  await createRecord(root, 'claim', { id: 'CLM-911', title: 'Mixed claim', evidence: ['EVD-911'], approval_status: 'approved' });

  const graph = await traceClaim(root, 'CLM-911');
  assert.deepEqual(graph.externalSources, [{ from: 'EVD-911', field: 'sources', ref: 'papers:good.pdf', uri: '../papers/good.pdf' }]);
  assert.deepEqual(graph.brokenSources.map(source => [source.ref, source.code]), [
    ['/tmp/private.pdf', 'USAGE'],
    [42, 'INVALID_SOURCE'],
    ['missing:file.pdf', 'RESOURCE_NOT_FOUND'],
    ['plain.pdf', 'USAGE']
  ]);
  const report = await validateProject(root);
  assert.equal(report.issues.some(issue => issue.code === 'SCHEMA_INVALID' && issue.path === 'evidence/packets/EVD-911.md'), true);
  assert.equal(report.issues.filter(issue => issue.code === 'EVIDENCE_SOURCE_INVALID' && issue.path === 'evidence/packets/EVD-911.md').length, 4);
  assert.equal(report.issues.some(issue => issue.code === 'APPROVED_CLAIM_PROVENANCE' && issue.path === 'evidence/claims/CLM-911.md'), true);
});

test('reported provenance cycles alone do not block an otherwise complete approved Claim', async () => {
  const root = await projectFixture();
  await createExperimentalTrace(root, 'approved');
  await rewriteRecord(root, 'evidence/packets/EVD-001.md', { supported_claims: ['CLM-001'] });

  const graph = await traceClaim(root, 'CLM-001');
  assert.equal(graph.cycles.length > 0, true);
  assert.equal((await validateProject(root)).issues.some(issue => issue.code === 'APPROVED_CLAIM_PROVENANCE'), false);
});

test('record CLI emits normalized deterministic JSON for new, validate, trace, and status', async () => {
  const root = await projectFixture();
  const created = captureIo();
  assert.equal(await main(['record', 'new', '--project', root, '--type', 'driver', '--id', 'RQ-041', '--title', 'CLI question', '--values', '{"source":"brief","question":"Question?"}'], created.io), 0);
  assert.deepEqual(JSON.parse(created.output().stdout), { id: 'RQ-041', path: 'research/questions/RQ-041.md' });

  await createRecord(root, 'evidence', { id: 'EVD-041', title: 'Evidence', sources: ['RQ-041'] });
  await createRecord(root, 'claim', { id: 'CLM-041', title: 'Claim', evidence: ['EVD-041'] });
  const traced = captureIo();
  assert.equal(await main(['record', 'trace', '--project', root, '--id', 'CLM-041'], traced.io), 0);
  const traceJson = JSON.parse(traced.output().stdout);
  assert.deepEqual(traceJson.types, ['claim', 'driver', 'evidence']);
  assert.equal(traced.output().stdout.endsWith('\n'), true);

  const status = captureIo();
  assert.equal(await main(['record', 'status', '--project', root, '--id', 'RQ-041', '--to', 'defined', '--reason', 'Defined'], status.io), 0);
  assert.equal(JSON.parse(status.output().stdout).attributes.status, 'defined');

  const validated = captureIo();
  assert.equal(await main(['record', 'validate', '--project', root], validated.io), 0);
  assert.equal(typeof JSON.parse(validated.output().stdout).ok, 'boolean');
});

test('record CLI rejects malformed JSON, wrong JSON types, unknown options, and domain failures deterministically', async () => {
  const root = await projectFixture();
  const cases = [
    ['new', '--project', root, '--type', 'driver', '--id', 'RQ-051', '--title', 'Bad', '--values', '{'],
    ['new', '--project', root, '--type', 'driver', '--id', 'RQ-051', '--title', 'Bad', '--values', '[]'],
    ['status', '--project', root, '--id', 'RQ-051', '--to', 'reopened', '--affected-ids', '{}'],
    ['validate', '--project', root, '--unknown', 'x']
  ];
  for (const args of cases) {
    const first = captureIo();
    const second = captureIo();
    assert.equal(await main(['record', ...args], first.io), 2);
    assert.equal(await main(['record', ...args], second.io), 2);
    assert.deepEqual(first.output(), second.output());
    assert.match(first.output().stderr, /^\[USAGE\]/);
  }

  const missing = captureIo();
  assert.equal(await main(['record', 'trace', '--project', root, '--id', 'CLM-999'], missing.io), 6);
  assert.match(missing.output().stderr, /^\[RECORD_NOT_FOUND\]/);
});

test('record CLI rejects forged lifecycle and multiline title while safely rendering multiline scientific values', async () => {
  const root = await projectFixture();
  const beforeProject = await readFile(join(root, 'PROJECT.md'), 'utf8');
  const forgedIdentity = captureIo();
  assert.equal(await main([
    'record', 'new', '--project', root, '--type', 'driver', '--id', 'RQ-950', '--title', 'Identity',
    '--values', '{"id":"RQ-999","title":"Hidden","source":"brief","question":"Question?"}'
  ], forgedIdentity.io), 2);
  assert.match(forgedIdentity.output().stderr, /^\[USAGE\]/);
  const forged = captureIo();
  assert.equal(await main([
    'record', 'new', '--project', root, '--type', 'driver', '--id', 'RQ-951', '--title', 'Forged',
    '--values', '{"source":"brief","question":"Question?","status":"closed","verified_at":"2026-08-03T00:00:00Z"}'
  ], forged.io), 2);
  assert.match(forged.output().stderr, /^\[USAGE\]/);

  const multilineTitle = captureIo();
  assert.equal(await main([
    'record', 'new', '--project', root, '--type', 'driver', '--id', 'RQ-952', '--title', 'Safe\n## Injected',
    '--values', '{"source":"brief","question":"Question?"}'
  ], multilineTitle.io), 2);
  assert.match(multilineTitle.output().stderr, /^\[USAGE\]/);
  assert.equal(await readFile(join(root, 'PROJECT.md'), 'utf8'), beforeProject);

  const source = 'brief\n## forged `code` [[ACT-999]]';
  const created = captureIo();
  assert.equal(await main([
    'record', 'new', '--project', root, '--type', 'driver', '--id', 'RQ-953', '--title', 'Safe [[ACT-999]]',
    '--values', JSON.stringify({ source, question: 'line one:\nline two' })
  ], created.io), 0);
  const document = parseMarkdownDocument(await readFile(join(root, 'research/questions/RQ-953.md'), 'utf8'), 'RQ-953.md');
  assert.equal(document.attributes.source, source);
  assert.equal(document.attributes.question, 'line one:\nline two');
  assert.equal(document.body.includes('\n## forged'), false);
  assert.equal(document.body.includes('[[ACT-999]]'), false);
});
