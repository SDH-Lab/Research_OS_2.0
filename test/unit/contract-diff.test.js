import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeManifest, verifyNormalizedManifest } from '../../src/experiments/manifest.js';
import { compareContract, MANDATORY_MANIFEST_FIELDS } from '../../src/experiments/contract.js';
import { ResearchOSError } from '../../src/lib/errors.js';
import { validContract, validExperimentProject, validManifest } from '../helpers/fixtures.js';

const at = '2026-08-03T12:00:00.000Z';
const clock = () => new Date(at);
const project = validExperimentProject();
const normalized = (overrides = {}, options = {}) => normalizeManifest(validManifest(overrides), { clock, project, ...options });

test('manifest normalization is canonical, time-separated, immutable, and array-order sensitive', () => {
  const firstInput = validManifest({ resolved_config: { z: 1, a: { y: 2, x: 3 } } });
  const secondInput = { ...validManifest(), resolved_config: { a: { x: 3, y: 2 }, z: 1 } };
  const first = normalizeManifest(firstInput, { clock, project });
  const second = normalizeManifest(secondInput, { clock: () => new Date('2026-08-04T00:00:00Z'), project });
  assert.equal(first.normalized_hash, second.normalized_hash);
  assert.equal(first.resolved_config_hash, second.resolved_config_hash);
  assert.notEqual(first.resolved_at, second.resolved_at);
  assert.equal(Object.isFrozen(first.resolved_config.a), true);
  assert.deepEqual(firstInput.resolved_config, { z: 1, a: { y: 2, x: 3 } });

  const reordered = normalizeManifest(validManifest({ expected_artifacts: ['experiment_results:EXP-001/run.log', 'experiment_results:EXP-001/metrics.json'] }), { clock, project });
  assert.notEqual(reordered.normalized_hash, first.normalized_hash);
});

test('manifest rejects missing semantic content, unknown and machine fields, unsafe or non-JSON data', () => {
  for (const input of [
    validManifest({ evaluator: undefined }),
    validManifest({ evaluator: {} }),
    { ...validManifest(), unknown: true },
    { ...validManifest(), normalized_hash: 'forged' },
    validManifest({ resolved_config: { bad: Number.NaN } }),
    validManifest({ resolved_config: { bad: () => true } }),
    validManifest({ command: '  ' })
  ]) {
    assert.throws(() => normalizeManifest(input, { clock, project }), error => error instanceof ResearchOSError && error.code === 'MANIFEST_INVALID');
  }
  const cyclic = validManifest();
  cyclic.resolved_config.self = cyclic.resolved_config;
  assert.throws(() => normalizeManifest(cyclic, { clock, project }), /cycle/i);
  const polluted = JSON.parse(JSON.stringify(validManifest()));
  polluted.resolved_config = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => normalizeManifest(polluted, { clock, project }), /unsafe/i);
  assert.throws(() => normalizeManifest(validManifest({ resolved_code_root: { resource: 'other_code', uri: 'ssh://example/other' } }), { clock, project }), /match/i);
});

test('wrong code root BLOCKs and exact types and strings are not coerced', () => {
  const wrongProject = validExperimentProject({ approved_code_roots: ['sample_code'], resources: { ...project.resources, general_code: { uri: 'ssh://research.example.org/worktrees/general_code', role: 'implementation', access: 'read-only', identity: 'general_code-v1' } } });
  assert.throws(() => normalizeManifest(validManifest({ code_root: 'general_code' }), { clock, project: wrongProject }), error => error.code === 'CODE_ROOT_NOT_APPROVED');
  const manifest = normalized();
  const wrongContract = validContract(); wrongContract.requirements.code_root = 'general_code';
  const diff = compareContract(wrongContract, manifest, { project });
  assert.equal(diff.items.find(item => item.field === 'code_root').status, 'BLOCK');
  assert.equal(diff.summary.BLOCK, 1);
  assert.equal(Object.isFrozen(diff.items[0]), true);

  const typedContract = validContract();
  typedContract.semantic_checks = [];
  typedContract.requirements.resolved_config = { ...typedContract.requirements.resolved_config, seed: '7' };
  const typed = compareContract(typedContract, normalized(), { project });
  assert.equal(typed.items.find(item => item.field === 'resolved_config').status, 'BLOCK');
});

test('missing evaluator is UNKNOWN for defensive partial external manifests', () => {
  const manifest = normalized();
  const partial = { ...manifest };
  delete partial.evaluator;
  const diff = compareContract(validContract(), partial, { project });
  assert.equal(diff.items.find(item => item.field === 'evaluator').status, 'UNKNOWN');
  assert.equal(diff.summary.UNKNOWN, 1);
});

test('partial Manifest is diagnostic only and still receives semantic resource checks', () => {
  const partial = { ...normalized() };
  delete partial.normalized_hash;
  const diff = compareContract(validContract(), partial, { project });
  assert.equal(diff.manifestComplete, false);
  assert.deepEqual(diff.summary, { PASS: 15, BLOCK: 0, UNKNOWN: 0, ALLOWED_DEVIATION: 0 });

  const outside = { ...partial, expected_artifacts: ['data:outside.json'] };
  assert.throws(
    () => compareContract(validContract(), outside, { project }),
    error => error instanceof ResearchOSError && error.code === 'CONTRACT_INVALID' && /output_location|inside/i.test(error.message)
  );
  const nestedShell = { ...partial, optimizer_scheduler: { ...partial.optimizer_scheduler, optimizer: { x: true } } };
  assert.throws(() => compareContract(validContract(), nestedShell, { project }), /optimizer/i);
  const readOnlyProject = validExperimentProject({
    resources: { ...project.resources, experiment_results: { ...project.resources.experiment_results, access: 'read-only' } }
  });
  assert.throws(() => compareContract(validContract(), partial, { project: readOnlyProject }), /read-write/i);
});

test('explicit exact diagnostic deviation is classified but an inexact value still BLOCKs', () => {
  const contract = validContract({
    semantic_checks: [],
    allowed_deviations: [{ field: 'command', actual: 'python diagnostic.py', waiver_id: 'WVR-001', evidence: 'Diagnostic controller comparison', risk: 'Not eligible without scoped approval.' }]
  });
  const allowed = compareContract(contract, normalized({ command: 'python diagnostic.py' }), { project });
  assert.equal(allowed.items.find(item => item.field === 'command').status, 'ALLOWED_DEVIATION');
});

test('contract rejects ambiguous declarations, unknown keys, invalid paths, and malformed deviations', () => {
  const badContracts = [
    { ...validContract(), extra: true },
    validContract({ requirements: { evaluator: {} }, semantic_checks: [{ name: 'duplicate', field: 'evaluator', required: {}, evidence: 'x', risk: 'y' }] }),
    validContract({ requirements: { evaluator: {}, 'evaluator.name': 'macro-auroc' }, semantic_checks: [] }),
    validContract({ requirements: { code_root: 'sample_code' }, semantic_checks: [], allowed_deviations: [{ field: 'entrypoint', actual: 'other.py', waiver_id: 'WVR-1', evidence: 'x', risk: 'y' }] }),
    validContract({ requirements: { '__proto__.x': true }, semantic_checks: [] }),
    validContract({ requirements: { code_root: 'sample_code' }, semantic_checks: [], allowed_deviations: [{ field: 'code_root', actual: 'other', waiver_id: '', evidence: '', risk: '' }] })
  ];
  for (const contract of badContracts) {
    assert.throws(() => compareContract(contract, normalized(), { project }), error => error instanceof ResearchOSError && error.code === 'CONTRACT_INVALID');
  }
  assert.throws(
    () => compareContract(validContract({ requirements: { ...validContract().requirements, code_root: undefined }, semantic_checks: [] }), normalized(), { project }),
    error => error instanceof ResearchOSError && error.code === 'CONTRACT_INVALID'
  );
});

test('contract diff hash and sort order are deterministic', () => {
  const manifest = normalized();
  const contract = validContract({ semantic_checks: [] });
  const first = compareContract(contract, manifest, { project });
  const second = compareContract(contract, manifest, { project });
  assert.deepEqual(first.items.map(item => item.field), [...MANDATORY_MANIFEST_FIELDS].sort((a, b) => a.localeCompare(b, 'en')));
  assert.equal(first.diffHash, second.diffHash);
  assert.deepEqual(first.summary, { PASS: 14, BLOCK: 0, UNKNOWN: 0, ALLOWED_DEVIATION: 0 });
});

test('normalized identity detects stale hashes and changed Project authority', () => {
  const manifest = normalized();
  assert.equal(verifyNormalizedManifest(manifest, { project }).normalized_hash, manifest.normalized_hash);
  assert.throws(() => verifyNormalizedManifest({ ...manifest, command: 'python other.py' }, { project }), /hash/i);
  assert.throws(() => verifyNormalizedManifest({ ...manifest, resolved_config_hash: 'f'.repeat(64) }, { project }), /hash/i);
  assert.throws(() => verifyNormalizedManifest(manifest, { project: { ...project, resources: { ...project.resources, sample_code: { ...project.resources.sample_code, identity: 'sample-v2' } } } }), /authority|snapshot/i);
});

test('mandatory coverage cannot be selectively omitted and null presence stays exact', () => {
  const contract = validContract();
  delete contract.requirements.code_root;
  assert.throws(() => compareContract(contract, normalized(), { project }), /mandatory/i);
  const nullContract = validContract();
  nullContract.semantic_checks = [{ name: 'nullable flag', field: 'resolved_config.optional', required: null, evidence: 'Approved null', risk: 'Absence differs.' }];
  const present = normalized({ resolved_config: { seed: 7, batch_size: 16, optional: null } });
  nullContract.requirements.resolved_config = present.resolved_config;
  const presentItem = compareContract(nullContract, present, { project }).items.find(item => item.field === 'resolved_config.optional');
  assert.equal(presentItem.actualPresent, true);
  assert.equal(presentItem.status, 'PASS');
  const absent = { ...present, resolved_config: { seed: 7, batch_size: 16 } };
  delete absent.normalized_hash;
  const absentItem = compareContract(nullContract, absent, { project }).items.find(item => item.field === 'resolved_config.optional');
  assert.equal(absentItem.actualPresent, false);
  assert.equal(absentItem.status, 'UNKNOWN');
});

test('canonical JSON rejects aliases and does not execute getters', () => {
  const cases = [];
  cases.push(validManifest({ resolved_config: { seed: -0 } }));
  const sparse = validManifest(); sparse.expected_artifacts = new Array(1); cases.push(sparse);
  const nestedSparse = validManifest(); nestedSparse.evaluator.metrics = new Array(1); cases.push(nestedSparse);
  const symbol = validManifest(); symbol.resolved_config[Symbol('hidden')] = true; cases.push(symbol);
  const nonenum = validManifest(); Object.defineProperty(nonenum.resolved_config, 'hidden', { value: true, enumerable: false }); cases.push(nonenum);
  const extraArray = validManifest(); extraArray.expected_artifacts.extra = true; cases.push(extraArray);
  for (const value of cases) assert.throws(() => normalizeManifest(value, { clock, project }), /JSON|array|key|finite/i);
  let reads = 0;
  const getter = validManifest();
  Object.defineProperty(getter.resolved_config, 'trap', { enumerable: true, get() { reads += 1; return 1; } });
  assert.throws(() => normalizeManifest(getter, { clock, project }), /accessor/i);
  assert.equal(reads, 0);
});

test('semantic shells, unsafe resources, fake clocks, and invalid waiver IDs fail before Diff', () => {
  for (const field of ['data_and_split', 'model_and_checkpoint', 'training_boundary', 'optimizer_scheduler', 'evaluator', 'environment']) {
    assert.throws(() => normalized({ [field]: { x: true } }), new RegExp(field));
  }
  assert.throws(() => normalized({ resolved_code_root: { resource: 'sample_code', uri: 'pending', identity: 'sample-v1' } }), /snapshot/i);
  assert.throws(() => normalized({ output_location: 'not-a-ref' }), /reference/i);
  const readOnlyProject = validExperimentProject({
    resources: { ...project.resources, experiment_results: { ...project.resources.experiment_results, access: 'read-only' } }
  });
  assert.throws(() => normalizeManifest(validManifest(), { project: readOnlyProject, clock }), /read-write|writable/i);
  for (const optimizer_scheduler of [
    { ...validManifest().optimizer_scheduler, optimizer: { x: true } },
    { ...validManifest().optimizer_scheduler, scheduler: { x: true } },
    { ...validManifest().optimizer_scheduler, early_stopping: { x: true } },
    { ...validManifest().optimizer_scheduler, early_stopping: { mode: 'enabled', monitor: null, patience: null } },
    { ...validManifest().optimizer_scheduler, early_stopping: { mode: 'disabled', monitor: 'auroc', patience: 5 } }
  ]) assert.throws(() => normalized({ optimizer_scheduler }), /optimizer|scheduler|early_stopping/i);
  assert.throws(() => normalized({ evaluator: { ...validManifest().evaluator, metrics: [{ x: true }] } }), /metrics/i);
  assert.doesNotThrow(() => normalized({
    optimizer_scheduler: {
      optimizer: { name: 'AdamW', parameters: { learning_rate: 0.001 }, implementation: 'torch.optim.AdamW' },
      scheduler: { name: 'cosine', parameters: {}, warmup_steps: 10 },
      checkpoint_selection: 'best-auroc',
      early_stopping: { mode: 'disabled', monitor: null, patience: null, rationale: 'fixed budget' }
    },
    evaluator: { ...validManifest().evaluator, metrics: [{ name: 'auroc', definition: 'one-vs-rest', averaging: 'macro' }] }
  }));
  assert.throws(() => normalizeManifest(validManifest(), { project, clock: () => ({ getTime: () => Date.now(), toISOString: () => 'fake' }) }), error => error instanceof ResearchOSError);
  assert.throws(() => normalizeManifest(validManifest(), { project, clock: () => new Date('invalid') }), error => error instanceof ResearchOSError);
  const badWaiver = validContract(); badWaiver.allowed_deviations = [{ field: 'code_root', actual: 'x', waiver_id: 'anything', evidence: 'x', risk: 'x' }];
  assert.throws(() => compareContract(badWaiver, normalized(), { project }), /waiver/i);
  assert.doesNotThrow(() => normalized({ evaluator: { implementation: 'custom', metrics: [{ name: 'auroc', definition: 'one-vs-rest' }], aggregation: 'macro', state: 'eval' } }));
});
