import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../../src/cli.js';
import { compareContract } from '../../src/experiments/contract.js';
import { normalizeManifest, sha256Json } from '../../src/experiments/manifest.js';
import { authorizeOfficialRun } from '../../src/experiments/official-gate.js';
import { ResearchOSError } from '../../src/lib/errors.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../../src/lib/markdown.js';
import { captureIo, makeProjectFixture, validContract, validExperimentProject, validManifest } from '../helpers/fixtures.js';

const now = '2026-08-03T12:00:00.000Z';
const clock = () => new Date(now);
const project = validExperimentProject();
const manifest = () => normalizeManifest(validManifest(), { clock, project });
const passDiff = () => compareContract(validContract(), manifest(), { project });

async function diskProject() {
  const root = await makeProjectFixture();
  const path = join(root, 'PROJECT.md');
  const document = parseMarkdownDocument(await readFile(path, 'utf8'), path);
  await writeFile(path, serializeMarkdownDocument({ ...document.attributes, ...project }, document.body), 'utf8');
  return root;
}

function waiver(diff, item, overrides = {}) {
  return {
    id: item.waiver_id ?? 'WVR-001',
    contract_id: diff.contractId,
    contract_version: diff.contractVersion,
    diff_hash: diff.diffHash,
    field: item.field,
    status: item.status,
    approved_use: diff.approvedUse,
    reason: 'Human accepted this bounded uncertainty.',
    approved_by: 'PI',
    approved_at: '2026-08-03T11:00:00.000Z',
    expires_at: '2026-08-04T11:00:00.000Z',
    ...overrides
  };
}

test('wrong root is a non-waivable official block and semantic smoke must pass', () => {
  const wrongManifest = manifest();
  const wrongContract = validContract(); wrongContract.requirements.code_root = 'general_code';
  const wrong = compareContract(wrongContract, wrongManifest, { project });
  assert.throws(() => authorizeOfficialRun({ contractDiff: wrong, mechanicalSmoke: 'pass', semanticSmoke: 'pass', waivers: [] }, { clock, project }), /OFFICIAL_RUN_BLOCKED/);
  assert.throws(() => authorizeOfficialRun({ contractDiff: passDiff(), mechanicalSmoke: 'pass', semanticSmoke: 'fail', waivers: [] }, { clock, project }), /OFFICIAL_RUN_BLOCKED/);
});

test('partial UNKNOWN is diagnostic-only, while complete semantic UNKNOWN can be waived', () => {
  const full = manifest();
  const partial = { ...full };
  delete partial.evaluator;
  const diagnostic = compareContract(validContract(), partial, { project });
  const diagnosticItem = diagnostic.items.find(candidate => candidate.field === 'evaluator');
  assert.equal(diagnosticItem.status, 'UNKNOWN');
  assert.throws(
    () => authorizeOfficialRun({ contractDiff: diagnostic, mechanicalSmoke: 'pass', semanticSmoke: 'pass', waivers: [waiver(diagnostic, diagnosticItem)] }, { clock, project }),
    /OFFICIAL_RUN_BLOCKED/
  );

  const contract = validContract();
  contract.semantic_checks.push({
    name: 'human release review', field: 'resolved_config.human_release_review', required: true,
    evidence: 'Human release checklist', risk: 'The review state was not recorded in the normalized Manifest.'
  });
  const diff = compareContract(contract, full, { project });
  const item = diff.items.find(candidate => candidate.field === 'resolved_config.human_release_review');
  assert.equal(item.status, 'UNKNOWN');
  assert.equal(diff.manifestComplete, true);
  assert.throws(() => authorizeOfficialRun({ contractDiff: diff, mechanicalSmoke: 'pass', semanticSmoke: 'pass', waivers: [] }, { clock, project }), /OFFICIAL_RUN_BLOCKED/);
  const receipt = authorizeOfficialRun({ contractDiff: diff, mechanicalSmoke: 'pass', semanticSmoke: 'pass', waivers: [waiver(diff, item)] }, { clock, project });
  assert.deepEqual(receipt.appliedWaiverIds, ['WVR-001']);
  assert.doesNotThrow(() => authorizeOfficialRun({
    contractDiff: diff,
    mechanicalSmoke: 'pass',
    semanticSmoke: 'pass',
    waivers: [waiver(diff, item, { approved_at: '2026-08-03T19:00:00+08:00', expires_at: '2026-08-04T19:00:00+08:00' })]
  }, { clock, project }));
  for (const bad of [
    waiver(diff, item, { expires_at: now }),
    waiver(diff, item, { approved_at: '2026-08-03T13:00:00Z' }),
    waiver(diff, item, { field: 'code_root' }),
    waiver(diff, item, { diff_hash: '0'.repeat(64) }),
    waiver(diff, item, { approved_use: 'another use' }),
    waiver(diff, item, { status: 'ALLOWED_DEVIATION' })
  ]) {
    assert.throws(() => authorizeOfficialRun({ contractDiff: diff, mechanicalSmoke: 'pass', semanticSmoke: 'pass', waivers: [bad] }, { clock, project }), /OFFICIAL_RUN_BLOCKED/);
  }
});

test('a partial Manifest with every contract item PASS can never receive an official receipt', () => {
  const partial = { ...manifest() };
  delete partial.normalized_hash;
  const diff = compareContract(validContract(), partial, { project });
  assert.equal(diff.manifestComplete, false);
  assert.equal(diff.summary.BLOCK, 0);
  assert.equal(diff.summary.UNKNOWN, 0);
  assert.throws(
    () => authorizeOfficialRun({ contractDiff: diff, mechanicalSmoke: 'pass', semanticSmoke: 'pass', waivers: [] }, { clock, project }),
    error => error instanceof ResearchOSError && error.code === 'OFFICIAL_RUN_BLOCKED'
  );
});

test('explicit deviation needs its exact bound waiver and cannot replay across another diff', () => {
  const contract = validContract({ semantic_checks: [], allowed_deviations: [{ field: 'command', actual: 'python diagnostic.py', waiver_id: 'WVR-007', evidence: 'Human comparison', risk: 'Different controller.' }] });
  const diagnosticManifest = normalizeManifest(validManifest({ command: 'python diagnostic.py' }), { clock, project });
  const diff = compareContract(contract, diagnosticManifest, { project });
  const bound = waiver(diff, diff.items.find(item => item.field === 'command'));
  assert.throws(() => authorizeOfficialRun({ contractDiff: diff, mechanicalSmoke: 'pass', semanticSmoke: 'pass', waivers: [] }, { clock, project }), /OFFICIAL_RUN_BLOCKED/);
  assert.doesNotThrow(() => authorizeOfficialRun({ contractDiff: diff, mechanicalSmoke: 'pass', semanticSmoke: 'pass', waivers: [bound] }, { clock, project }));
  const other = compareContract({ ...contract, approved_use: 'diagnostic publication appendix' }, diagnosticManifest, { project });
  assert.throws(() => authorizeOfficialRun({ contractDiff: other, mechanicalSmoke: 'pass', semanticSmoke: 'pass', waivers: [bound] }, { clock, project }), /OFFICIAL_RUN_BLOCKED/);
});

test('gate rejects any tampered diff field, order, summary, hash, duplicates, or extraneous waiver', () => {
  const diff = passDiff();
  const mutations = [
    { ...diff, summary: { ...diff.summary, PASS: 99 } },
    { ...diff, diffHash: 'f'.repeat(64) },
    { ...diff, manifestHash: 'f'.repeat(64) },
    { ...diff, items: [...diff.items].reverse() },
    { ...diff, items: [...diff.items, diff.items[0]] },
    { ...diff, items: diff.items.map((item, index) => index === 0 ? { ...item, status: 'UNKNOWN' } : item) }
  ];
  for (const candidate of mutations) {
    assert.throws(() => authorizeOfficialRun({ contractDiff: candidate, mechanicalSmoke: 'pass', semanticSmoke: 'pass', waivers: [] }, { clock, project }), error => error instanceof ResearchOSError && error.code === 'OFFICIAL_RUN_BLOCKED');
  }
  const extraneous = waiver(diff, { field: 'code_root', status: 'UNKNOWN' });
  assert.throws(() => authorizeOfficialRun({ contractDiff: diff, mechanicalSmoke: 'pass', semanticSmoke: 'pass', waivers: [extraneous] }, { clock, project }), /OFFICIAL_RUN_BLOCKED/);

  const forgedItems = diff.items.map((item, index) => index === 0 ? { ...item, actual: 'wrong', status: 'PASS' } : item);
  const forgedPayload = { ...diff, items: forgedItems, summary: { ...diff.summary } };
  delete forgedPayload.diffHash;
  forgedPayload.diffHash = sha256Json(forgedPayload);
  assert.throws(() => authorizeOfficialRun({ contractDiff: forgedPayload, mechanicalSmoke: 'pass', semanticSmoke: 'pass', waivers: [] }, { clock, project }), /OFFICIAL_RUN_BLOCKED/);

  for (const forged of [
    { ...diff, items: [], summary: { PASS: 0, BLOCK: 0, UNKNOWN: 0, ALLOWED_DEVIATION: 0 } },
    { ...diff, items: diff.items.slice(1), summary: { ...diff.summary, PASS: diff.summary.PASS - 1 } },
    { ...diff, manifestHash: 'a'.repeat(64) }
  ]) {
    const payload = { ...forged }; delete payload.diffHash; payload.diffHash = sha256Json(payload);
    assert.throws(() => authorizeOfficialRun({ contractDiff: payload, mechanicalSmoke: 'pass', semanticSmoke: 'pass', waivers: [] }, { clock, project }), /OFFICIAL_RUN_BLOCKED/);
  }
});

test('receipt is stable, deep-frozen, and only authorizes provenance promotion', () => {
  const first = authorizeOfficialRun({ contractDiff: passDiff(), mechanicalSmoke: 'pass', semanticSmoke: 'pass', waivers: [] }, { clock, project });
  const second = authorizeOfficialRun({ contractDiff: passDiff(), mechanicalSmoke: 'pass', semanticSmoke: 'pass', waivers: [] }, { clock, project });
  assert.equal(first.receiptHash, second.receiptHash);
  assert.equal(first.authorizationScope, 'provenance-promotion-only; does-not-execute-command-or-set-run-official');
  assert.equal(first.projectId, 'demo');
  assert.equal(first.codeRoot, 'sample_code');
  assert.equal(Object.isFrozen(first.appliedWaiverIds), true);
  const changedProject = { ...project, resources: { ...project.resources, sample_code: { ...project.resources.sample_code, identity: 'sample-v2' } } };
  assert.throws(() => authorizeOfficialRun({ contractDiff: passDiff(), mechanicalSmoke: 'pass', semanticSmoke: 'pass', waivers: [] }, { clock, project: changedProject }), /OFFICIAL_RUN_BLOCKED/);
  for (const badClock of [() => new Date('invalid'), () => ({ getTime: () => Date.now(), toISOString: () => 'fake' })]) {
    assert.throws(() => authorizeOfficialRun({ contractDiff: passDiff(), mechanicalSmoke: 'pass', semanticSmoke: 'pass', waivers: [] }, { clock: badClock, project }), error => error instanceof ResearchOSError && error.code === 'OFFICIAL_RUN_BLOCKED');
  }
});

test('experiment CLI validates exact JSON contracts, blocks safely, and has no command side effect', async () => {
  globalThis.__researchOsCommandExecuted = false;
  const projectRoot = await diskProject();
  const checked = captureIo();
  assert.equal(await main(['experiment', 'manifest-check', '--project', projectRoot, '--manifest', JSON.stringify(validManifest())], checked.io), 0);
  const checkedManifest = JSON.parse(checked.output().stdout);
  const contractIo = captureIo();
  assert.equal(await main(['experiment', 'contract-diff', '--project', projectRoot, '--contract', JSON.stringify(validContract()), '--manifest', JSON.stringify(checkedManifest)], contractIo.io), 0);
  const diff = JSON.parse(contractIo.output().stdout);
  const authorizeIo = captureIo();
  assert.equal(await main(['experiment', 'authorize', '--project', projectRoot, '--diff', JSON.stringify(diff), '--mechanical-smoke', 'pass', '--semantic-smoke', 'pass', '--waivers', '[]'], authorizeIo.io), 0);
  assert.equal(globalThis.__researchOsCommandExecuted, false);

  const blockedContract = validContract(); blockedContract.requirements.code_root = 'general_code';
  const blockedDiff = compareContract(blockedContract, manifest(), { project });
  const blocked = captureIo();
  assert.equal(await main(['experiment', 'authorize', '--project', projectRoot, '--diff', JSON.stringify(blockedDiff), '--mechanical-smoke', 'pass', '--semantic-smoke', 'pass', '--waivers', '[]'], blocked.io), 4);
  assert.equal(globalThis.__researchOsCommandExecuted, false);

  for (const args of [
    ['manifest-check', '--manifest', '[]'],
    ['contract-diff', '--contract', '{}', '--manifest', '[]'],
    ['authorize', '--diff', '{}', '--mechanical-smoke', 'pass', '--semantic-smoke', 'pass', '--waivers', '{}'],
    ['manifest-check', '--manifest', '{}', '--manifest', '{}'],
    ['authorize', '--diff', '{}', '--mechanical-smoke', 'pass', '--semantic-smoke', 'pass', '--waivers', '[]', '--unknown', 'x']
  ]) {
    const invalid = captureIo();
    assert.equal(await main(['experiment', ...args], invalid.io), 2);
  }
});
