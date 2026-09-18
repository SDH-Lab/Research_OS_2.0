import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyCoreUpgrade, previewCoreUpgrade } from '../../src/core/upgrade.js';
import { runDoctor } from '../../src/doctor.js';
import { main } from '../../src/cli.js';
import { discoverRecordCandidates } from '../../src/records/catalog.js';
import { validateProject } from '../../src/validation/validator.js';
import { buildViews } from '../../src/views/generate.js';
import { loadProject } from '../../src/project/project.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../../src/lib/markdown.js';
import { verifyUpgradeArchives } from '../../src/core/archive.js';
import { ResearchOSError } from '../../src/lib/errors.js';
import { captureIo, makeCandidateCoreFixture, makeProjectFixture, makeTempDir, pathExists } from '../helpers/fixtures.js';

const PACKAGED_SKILLS_ROOT = join(process.cwd(), 'skills');
function runTestDoctor(root, options = {}) {
  return runDoctor(root, { skillsRoot: PACKAGED_SKILLS_ROOT, ...options });
}

test('upgrade preview is deterministic, complete, and read-only', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture();
  const before = await readFile(join(root, 'PROJECT.md'));
  const first = await previewCoreUpgrade(root, candidate);
  const second = await previewCoreUpgrade(root, candidate);
  assert.deepEqual(first, second);
  assert.equal(first.fromVersion, '2.0.0');
  assert.equal(first.toVersion, '2.1.0');
  assert.deepEqual(first.affectedProjectFiles, ['PROJECT.md']);
  assert.deepEqual(first.migrations.map(item => item.id), ['project-core-version']);
  assert.match(first.backupPath, /^archive\/core-upgrades\/\d{8}T\d{9}Z-2\.0\.0-to-2\.1\.0-[a-f0-9]{12}$/u);
  assert.match(first.hash, /^[a-f0-9]{64}$/u);
  assert.ok(first.changes.schemas.some(item => item.path === 'schemas/project.schema.json'));
  assert.equal(JSON.stringify(first).includes(candidate), false);
  assert.deepEqual(await readFile(join(root, 'PROJECT.md')), before);
  assert.equal(await pathExists(join(root, 'archive')), false);
});

test('candidate Core must remain external to the Project Vault', async () => {
  const root = await makeProjectFixture();
  const external = await makeCandidateCoreFixture();
  const nested = join(root, 'candidate-core');
  await cp(external, nested, { recursive: true });
  await assert.rejects(() => previewCoreUpgrade(root, nested), /CANDIDATE_CORE_INSIDE_PROJECT/u);
});

test('project remains pinned until its exact approved preview is applied', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture();
  const preview = await previewCoreUpgrade(root, candidate);
  await assert.rejects(() => applyCoreUpgrade(root, candidate, 'wrong-hash'), /UPGRADE_PREVIEW_MISMATCH/u);
  assert.equal((await loadProject(root)).core_version, '2.0.0');
  const result = await applyCoreUpgrade(root, candidate, preview.hash);
  assert.equal((await loadProject(root)).core_version, '2.1.0');
  assert.equal(result.fromVersion, '2.0.0');
  assert.equal(result.toVersion, '2.1.0');
  assert.equal(result.previewHash, preview.hash);
  assert.equal(await pathExists(join(root, result.backupPath, 'PROJECT.md.bak')), true);
  assert.equal((await discoverRecordCandidates(root)).some(item => item.path.startsWith('archive/core-upgrades/')), false);
  assert.equal(await pathExists(join(root, 'core')), false);
});

test('apply rejects a pre-existing mismatched migration receipt before changing the project', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture();
  const preview = await previewCoreUpgrade(root, candidate);
  const directory = join(root, preview.backupPath);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'PROJECT.md.bak'), await readFile(join(root, 'PROJECT.md')));
  await writeFile(join(directory, 'migration.json'), '{"forged":true}\n', 'utf8');
  const before = await readFile(join(root, 'PROJECT.md'));
  await assert.rejects(() => applyCoreUpgrade(root, candidate, preview.hash), /CORE_BACKUP_RECEIPT_MISMATCH/u);
  assert.deepEqual(await readFile(join(root, 'PROJECT.md')), before);
});

test('candidate incompatibility fails and restores PROJECT bytes', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture('2.1.0', async candidateRoot => {
    const schemaPath = join(candidateRoot, 'schemas', 'project.schema.json');
    const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
    schema.allOf[1].required.push('unavailable_candidate_field');
    await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
  });
  const before = await readFile(join(root, 'PROJECT.md'));
  const preview = await previewCoreUpgrade(root, candidate);
  await assert.rejects(() => applyCoreUpgrade(root, candidate, preview.hash), /UPGRADE_VALIDATION_FAILED/u);
  assert.deepEqual(await readFile(join(root, 'PROJECT.md')), before);
  assert.equal((await loadProject(root)).core_version, '2.0.0');
  assert.equal((await validateProject(root)).ok, true);
});

test('Doctor is read-only and reports generated and waiver checks explicitly', async () => {
  const root = await makeProjectFixture();
  const before = await readFile(join(root, 'PROJECT.md'));
  const report = await runTestDoctor(root);
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map(item => item.id), [
    'node-version', 'dependency-lock', 'skill-installation', 'core-version', 'core-upgrade-backups', 'project-authority', 'generated-views', 'waiver-expiry', 'guide-core-version'
  ]);
  const skill = report.checks.find(item => item.id === 'skill-installation');
  assert.equal(skill.status, 'pass');
  assert.equal(skill.evidence[0].replace('packaged=', ''), skill.evidence[1].replace('installed=', ''));
  assert.equal(report.checks.find(item => item.id === 'generated-views').status, 'not_applicable');
  assert.equal(report.checks.find(item => item.id === 'waiver-expiry').status, 'not_applicable');
  assert.deepEqual(await readFile(join(root, 'PROJECT.md')), before);
});

test('Doctor rejects generated and backup receipt paths outside their authority roots', async () => {
  const root = await makeProjectFixture();
  await buildViews(root);
  const generatedPath = join(root, 'generated', 'generation-manifest.json');
  const generated = JSON.parse(await readFile(generatedPath, 'utf8'));
  generated.inputs[0].path = '../../../../../../../../etc/hosts';
  await writeFile(generatedPath, `${JSON.stringify(generated, null, 2)}\n`, 'utf8');
  let report = await runTestDoctor(root);
  assert.equal(report.issues.some(item => item.code === 'GENERATED_VIEW_INVALID'), true);
  assert.equal(report.issues.some(item => item.code === 'GENERATED_VIEW_STALE'), false);

  const candidate = await makeCandidateCoreFixture();
  await writeFile(generatedPath, await readFile(generatedPath));
  const preview = await previewCoreUpgrade(root, candidate);
  await applyCoreUpgrade(root, candidate, preview.hash);
  const receiptPath = join(root, preview.backupPath, 'backup.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  receipt.files[0].backup = '../../../../../../../../etc/hosts';
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  report = await runTestDoctor(root);
  assert.equal(report.issues.some(item => item.code === 'CORE_BACKUP_INVALID'), true);
  assert.equal(report.issues.some(item => item.code === 'CORE_BACKUP_HASH_MISMATCH'), false);
});

test('Doctor diagnoses a project pin that does not match the running Core', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture();
  const preview = await previewCoreUpgrade(root, candidate);
  await applyCoreUpgrade(root, candidate, preview.hash);
  const report = await runTestDoctor(root);
  assert.equal(report.ok, false);
  const issue = report.issues.find(item => item.code === 'CORE_VERSION_MISMATCH');
  assert.equal(issue.severity, 'error');
  assert.equal(issue.path, 'PROJECT.md#/core_version');
  assert.equal(issue.recovery.kind, 'manual');
  const backupFile = join(root, preview.backupPath, 'PROJECT.md.bak');
  await writeFile(backupFile, 'tampered', 'utf8');
  const tampered = await runTestDoctor(root);
  assert.equal(tampered.issues.some(item => ['CORE_BACKUP_HASH_MISMATCH', 'CORE_BACKUP_INVALID'].includes(item.code)), true);
});

test('upgrade and Doctor have exact CLI paths and exit semantics', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture();
  const previewIo = captureIo();
  assert.equal(await main(['core', 'upgrade-preview', '--project', root, '--candidate-core', candidate], previewIo.io), 0);
  const preview = JSON.parse(previewIo.output().stdout);
  const mismatch = captureIo();
  assert.equal(await main(['core', 'upgrade-apply', '--project', root, '--candidate-core', candidate, '--preview-hash', 'bad'], mismatch.io), 3);
  assert.match(mismatch.output().stderr, /UPGRADE_PREVIEW_MISMATCH/u);
  const applyIo = captureIo();
  assert.equal(await main(['core', 'upgrade-apply', '--project', root, '--candidate-core', candidate, '--preview-hash', preview.hash], applyIo.io), 0);
  const doctorIo = captureIo();
  assert.equal(await main(['doctor', '--project', root], doctorIo.io), 3);
  assert.equal(JSON.parse(doctorIo.output().stdout).issues.some(item => item.code === 'CORE_VERSION_MISMATCH'), true);
});

test('successful migration advances PROJECT.updated to the exact returned appliedAt', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture();
  const before = await loadProject(root);
  const preview = await previewCoreUpgrade(root, candidate);
  const result = await applyCoreUpgrade(root, candidate, preview.hash);
  const after = await loadProject(root);
  assert.equal(after.updated, result.appliedAt);
  assert.equal(Date.parse(after.updated) > Date.parse(before.updated), true);
});

test('retrying an already-applied approved preview is idempotent and creates no new attempt', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture();
  const preview = await previewCoreUpgrade(root, candidate);
  const first = await applyCoreUpgrade(root, candidate, preview.hash);
  const before = await readFile(join(root, 'PROJECT.md'));
  const second = await applyCoreUpgrade(root, candidate, preview.hash);
  assert.equal(second.alreadyApplied, true);
  assert.equal(second.attemptId, first.attemptId);
  assert.equal(second.appliedAt, first.appliedAt);
  assert.deepEqual(await readFile(join(root, 'PROJECT.md')), before);
});

test('failed migration is auditable as failed-restored and a retry is a distinct attempt', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture('2.1.0', async candidateRoot => {
    const schemaPath = join(candidateRoot, 'schemas', 'project.schema.json');
    const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
    schema.allOf[1].required.push('impossible_field');
    await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
  });
  const before = await readFile(join(root, 'PROJECT.md'));
  const preview = await previewCoreUpgrade(root, candidate);
  await assert.rejects(() => applyCoreUpgrade(root, candidate, preview.hash), /UPGRADE_VALIDATION_FAILED/u);
  await assert.rejects(() => applyCoreUpgrade(root, candidate, preview.hash), /UPGRADE_VALIDATION_FAILED/u);
  assert.deepEqual(await readFile(join(root, 'PROJECT.md')), before);
  const report = await runTestDoctor(root);
  const backup = report.checks.find(item => item.id === 'core-upgrade-backups');
  assert.notEqual(backup.status, 'pass');
  assert.equal(report.issues.some(item => item.code === 'CORE_UPGRADE_FAILED_RESTORED'), true);
  assert.equal(backup.evidence.some(item => /attempt-002/u.test(item)), true);
});

test('Doctor distinguishes an incomplete crash-point attempt from failed-restored history', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture('2.1.0', async candidateRoot => {
    const schemaPath = join(candidateRoot, 'schemas', 'project.schema.json');
    const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
    schema.allOf[1].required.push('impossible_field');
    await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
  });
  const preview = await previewCoreUpgrade(root, candidate);
  await assert.rejects(() => applyCoreUpgrade(root, candidate, preview.hash));
  const archive = join(root, preview.backupPath);
  const backup = JSON.parse(await readFile(join(archive, 'backup.json'), 'utf8'));
  const pending = {
    schemaVersion: 1, attemptId: 'attempt-002', previewHash: backup.previewHash, diffIdentity: backup.diffIdentity,
    fromVersion: backup.fromVersion, toVersion: backup.toVersion,
    attemptedAt: new Date(Date.parse(JSON.parse(await readFile(join(archive, 'attempts', 'attempt-001.failed-restored.json'), 'utf8')).completedAt) + 1).toISOString(), outcome: 'attempted'
  };
  await writeFile(join(archive, 'attempts', 'attempt-002.pending.json'), `${JSON.stringify(pending, null, 2)}\n`, 'utf8');
  const report = await runTestDoctor(root);
  assert.equal(report.issues.some(item => item.code === 'CORE_UPGRADE_FAILED_RESTORED'), true);
  const incomplete = report.issues.find(item => item.code === 'CORE_UPGRADE_INCOMPLETE');
  assert.equal(incomplete.severity, 'error');
  assert.equal(incomplete.recovery.kind, 'manual');
  assert.equal(report.checks.find(item => item.id === 'core-upgrade-backups').status, 'fail');
});

test('Doctor rejects symlinked immutable backup receipt authority', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture('2.1.0', async candidateRoot => {
    const schemaPath = join(candidateRoot, 'schemas', 'project.schema.json');
    const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
    schema.allOf[1].required.push('impossible_field');
    await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
  });
  const preview = await previewCoreUpgrade(root, candidate);
  await assert.rejects(() => applyCoreUpgrade(root, candidate, preview.hash));
  const receipt = join(root, preview.backupPath, 'backup.json');
  const outside = join(await makeTempDir(), 'backup.json');
  await rename(receipt, outside);
  await symlink(outside, receipt);
  const report = await runTestDoctor(root);
  assert.equal(report.issues.some(item => item.code === 'CORE_BACKUP_INVALID'), true);
  assert.equal(report.checks.find(item => item.id === 'core-upgrade-backups').status, 'fail');
});

test('Doctor treats an empty upgrade archive as not applicable', async () => {
  const root = await makeProjectFixture();
  await mkdir(join(root, 'archive', 'core-upgrades'), { recursive: true });
  const check = (await runTestDoctor(root)).checks.find(item => item.id === 'core-upgrade-backups');
  assert.equal(check.status, 'not_applicable');
});

test('Doctor rejects a symlinked upgrade archive root without following it or throwing', async () => {
  const root = await makeProjectFixture();
  const external = await makeTempDir();
  await mkdir(join(root, 'archive'), { recursive: true });
  await symlink(external, join(root, 'archive', 'core-upgrades'));
  const report = await runTestDoctor(root);
  assert.equal(report.issues.some(item => item.code === 'CORE_BACKUP_INVALID'), true);
  assert.equal(report.checks.find(item => item.id === 'core-upgrade-backups').status, 'fail');
});

test('candidate versions use strict SemVer rules', async () => {
  const root = await makeProjectFixture();
  for (const version of ['02.1.0', '1.01.0', '2.1.00', '2.1.0-.', '2.1.0-01', '2.1.0+']) {
    const candidate = await makeCandidateCoreFixture(version);
    await assert.rejects(() => previewCoreUpgrade(root, candidate), error => error.code === 'CORE_VERSION', version);
  }
});

test('candidate transition graph is total, unique, condition-closed, and v1 lifecycle-compatible', async () => {
  const root = await makeProjectFixture();
  const mutations = [
    graph => { delete graph.transitions.review; },
    graph => { graph.transitions.inbox = ['defined', 'defined']; },
    graph => { graph.conditions['ghost->defined'] = { requires: ['reason'] }; },
    graph => { graph.statuses = graph.statuses.filter(status => status !== 'review'); delete graph.transitions.review; graph.transitions.in_progress = ['closed']; }
  ];
  for (const mutate of mutations) {
    const candidate = await makeCandidateCoreFixture('2.1.0', async candidateRoot => {
      const path = join(candidateRoot, 'rules', 'status-transitions.json');
      const graph = JSON.parse(await readFile(path, 'utf8'));
      mutate(graph);
      await writeFile(path, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
    });
    await assert.rejects(() => previewCoreUpgrade(root, candidate), error => ['CORE_PACKAGE_INVALID', 'CORE_MIGRATION_REQUIRED'].includes(error.code));
  }
});

test('candidate failures have stable public CLI validation and I/O exits with no thrown stack', async () => {
  const root = await makeProjectFixture();
  const missing = captureIo();
  assert.equal(await main(['core', 'upgrade-preview', '--project', root, '--candidate-core', join(root, '..', 'missing')], missing.io), 7);
  assert.match(missing.output().stderr, /CORE_CANDIDATE_IO/u);
  assert.doesNotMatch(missing.output().stderr, /\n\s+at\s/u);

  const malformed = await makeCandidateCoreFixture('2.1.0', async candidateRoot => {
    await writeFile(join(candidateRoot, 'rules', 'status-transitions.json'), '{bad json', 'utf8');
  });
  const invalid = captureIo();
  assert.equal(await main(['core', 'upgrade-preview', '--project', root, '--candidate-core', malformed], invalid.io), 3);
  assert.match(invalid.output().stderr, /CORE_PACKAGE_INVALID/u);
  assert.doesNotMatch(invalid.output().stderr, /\n\s+at\s/u);
});

test('stale applied history cannot grant idempotent success after PROJECT byte revert', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture();
  const preview = await previewCoreUpgrade(root, candidate);
  await applyCoreUpgrade(root, candidate, preview.hash);
  await writeFile(join(root, 'PROJECT.md'), await readFile(join(root, preview.backupPath, 'PROJECT.md.bak')));
  await assert.rejects(() => applyCoreUpgrade(root, candidate, preview.hash), error => error.code === 'CORE_UPGRADE_STATE_MISMATCH');
  const report = await runTestDoctor(root);
  assert.equal(report.ok, false);
  assert.equal(report.issues.some(item => item.code === 'CORE_UPGRADE_STATE_MISMATCH'), true);
});

test('Doctor enforces ordered applied timestamps and a contiguous attempt sequence from 001', async t => {
  await t.test('timestamp order', async () => {
    const root = await makeProjectFixture();
    const candidate = await makeCandidateCoreFixture();
    const preview = await previewCoreUpgrade(root, candidate);
    const result = await applyCoreUpgrade(root, candidate, preview.hash);
    const archive = join(root, preview.backupPath);
    const migrationPath = join(archive, 'migration.json');
    const migration = JSON.parse(await readFile(migrationPath, 'utf8'));
    migration.attemptedAt = new Date(Date.parse(migration.completedAt) + 60_000).toISOString();
    await writeFile(migrationPath, `${JSON.stringify(migration, null, 2)}\n`, 'utf8');
    const appliedPath = join(archive, 'attempts', `${result.attemptId}.applied.json`);
    if (await pathExists(appliedPath)) await writeFile(appliedPath, `${JSON.stringify(migration, null, 2)}\n`, 'utf8');
    const report = await runTestDoctor(root);
    assert.equal(report.issues.some(item => item.code === 'CORE_BACKUP_INVALID'), true);
  });

  await t.test('attempt sequence', async () => {
    const root = await makeProjectFixture();
    const candidate = await makeCandidateCoreFixture();
    const preview = await previewCoreUpgrade(root, candidate);
    const result = await applyCoreUpgrade(root, candidate, preview.hash);
    const archive = join(root, preview.backupPath);
    const attempts = join(archive, 'attempts');
    const attempted = JSON.parse(await readFile(join(attempts, `${result.attemptId}.attempted.json`), 'utf8'));
    attempted.attemptId = 'attempt-777';
    await writeFile(join(attempts, 'attempt-777.attempted.json'), `${JSON.stringify(attempted, null, 2)}\n`, 'utf8');
    await rename(join(attempts, `${result.attemptId}.attempted.json`), join(await makeTempDir(), 'old-attempted.json'));
    const appliedPath = join(attempts, `${result.attemptId}.applied.json`);
    if (await pathExists(appliedPath)) {
      const applied = JSON.parse(await readFile(appliedPath, 'utf8'));
      applied.attemptId = 'attempt-777';
      await writeFile(join(attempts, 'attempt-777.applied.json'), `${JSON.stringify(applied, null, 2)}\n`, 'utf8');
      await rename(appliedPath, join(await makeTempDir(), 'old-applied.json'));
    }
    const migrationPath = join(archive, 'migration.json');
    const migration = JSON.parse(await readFile(migrationPath, 'utf8'));
    migration.attemptId = 'attempt-777';
    await writeFile(migrationPath, `${JSON.stringify(migration, null, 2)}\n`, 'utf8');
    const report = await runTestDoctor(root);
    assert.equal(report.issues.some(item => item.code === 'CORE_BACKUP_INVALID'), true);
  });
});

test('Doctor rejects a migration marker without its attempted authority', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture();
  const preview = await previewCoreUpgrade(root, candidate);
  const result = await applyCoreUpgrade(root, candidate, preview.hash);
  const attempted = join(root, preview.backupPath, 'attempts', `${result.attemptId}.attempted.json`);
  await rename(attempted, join(await makeTempDir(), 'removed-attempted.json'));
  const report = await runTestDoctor(root);
  assert.equal(report.issues.some(item => item.code === 'CORE_BACKUP_INVALID'), true);
});

test('an unresolved prior attempt blocks apply instead of starting a successor', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture();
  const preview = await previewCoreUpgrade(root, candidate);
  const original = await readFile(join(root, 'PROJECT.md'));
  const project = parseMarkdownDocument(original.toString('utf8'), 'PROJECT.md').attributes;
  const archive = join(root, preview.backupPath);
  await mkdir(join(archive, 'attempts'), { recursive: true });
  await writeFile(join(archive, 'PROJECT.md.bak'), original);
  const backup = {
    schemaVersion: 1, previewHash: preview.hash, diffIdentity: preview.diffIdentity, fromVersion: preview.fromVersion, toVersion: preview.toVersion,
    backupPath: preview.backupPath, createdFromUpdated: project.updated, files: [{ path: 'PROJECT.md', backup: 'PROJECT.md.bak', sha256: createHash('sha256').update(original).digest('hex') }]
  };
  await writeFile(join(archive, 'backup.json'), `${JSON.stringify(backup, null, 2)}\n`, 'utf8');
  const attempted = {
    schemaVersion: 1, attemptId: 'attempt-001', previewHash: preview.hash, diffIdentity: preview.diffIdentity,
    fromVersion: preview.fromVersion, toVersion: preview.toVersion, attemptedAt: new Date(Date.parse(project.updated) + 1).toISOString(), outcome: 'attempted'
  };
  await writeFile(join(archive, 'attempts', 'attempt-001.attempted.json'), `${JSON.stringify(attempted, null, 2)}\n`, 'utf8');
  await assert.rejects(() => applyCoreUpgrade(root, candidate, preview.hash), error => error.code === 'CORE_UPGRADE_INCOMPLETE');
  assert.deepEqual(await readFile(join(root, 'PROJECT.md')), original);
  assert.deepEqual((await readdir(join(archive, 'attempts'))).sort(), ['attempt-001.attempted.json']);
});

test('every injected pre-commit upgrade failure restores bytes and leaves one failed terminal', async t => {
  for (const hook of ['afterAttempted', 'beforeProjectWrite', 'afterProjectWrite', 'afterCandidateValidation', 'beforeMigrationPublish']) {
    await t.test(hook, async () => {
      const root = await makeProjectFixture();
      const candidate = await makeCandidateCoreFixture();
      const preview = await previewCoreUpgrade(root, candidate);
      const before = await readFile(join(root, 'PROJECT.md'));
      await assert.rejects(
        () => applyCoreUpgrade(root, candidate, preview.hash, { hooks: { [hook]: async () => { throw new Error(`injected:${hook}`); } } }),
        error => error.code === 'CORE_UPGRADE_PUBLICATION_FAILED'
      );
      assert.deepEqual(await readFile(join(root, 'PROJECT.md')), before);
      const names = (await readdir(join(root, preview.backupPath, 'attempts'))).sort();
      assert.equal(names.filter(name => name.endsWith('.failed-restored.json')).length, 1);
      assert.equal(names.some(name => name.endsWith('.applied.json')), false);
      assert.deepEqual(names, ['attempt-001.attempted.json', 'attempt-001.failed-restored.json']);
    });
  }
});

test('apply idempotency rejects a symlinked attempts directory', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture();
  const preview = await previewCoreUpgrade(root, candidate);
  await applyCoreUpgrade(root, candidate, preview.hash);
  const attempts = join(root, preview.backupPath, 'attempts');
  const external = join(await makeTempDir(), 'attempts');
  await rename(attempts, external);
  await symlink(external, attempts);
  await assert.rejects(() => applyCoreUpgrade(root, candidate, preview.hash), error => ['CORE_BACKUP_INVALID', 'CORE_UPGRADE_STATE_MISMATCH'].includes(error.code));
});

async function writePreparedArchive(root, preview, backupBytes = null) {
  const original = backupBytes ?? await readFile(join(root, 'PROJECT.md'));
  const authority = parseMarkdownDocument((await readFile(join(root, 'PROJECT.md'))).toString('utf8'), 'PROJECT.md').attributes;
  const base = join(root, preview.backupPath);
  await mkdir(join(base, 'attempts'), { recursive: true });
  await writeFile(join(base, 'PROJECT.md.bak'), original);
  const receipt = {
    schemaVersion: 1, previewHash: preview.hash, diffIdentity: preview.diffIdentity, fromVersion: preview.fromVersion, toVersion: preview.toVersion,
    backupPath: preview.backupPath, createdFromUpdated: authority.updated,
    files: [{ path: 'PROJECT.md', backup: 'PROJECT.md.bak', sha256: createHash('sha256').update(original).digest('hex') }]
  };
  await writeFile(join(base, 'backup.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return { base, receipt };
}

async function writeAppliedArchive(root, { fromVersion, toVersion, backupUpdated, appliedAt, completedAt, identity }) {
  const projectPath = join(root, 'PROJECT.md');
  const current = parseMarkdownDocument(await readFile(projectPath, 'utf8'), 'PROJECT.md');
  const backupBytes = Buffer.from(serializeMarkdownDocument({ ...current.attributes, core_version: fromVersion, updated: backupUpdated }, current.body));
  const diffIdentity = createHash('sha256').update(`${identity}:diff`).digest('hex');
  const previewHash = createHash('sha256').update(`${identity}:preview`).digest('hex');
  const timestamp = new Date(backupUpdated).toISOString().replace(/[-:.]/gu, '');
  const backupPath = `archive/core-upgrades/${timestamp}-${fromVersion}-to-${toVersion}-${diffIdentity.slice(0, 12)}`;
  const base = join(root, backupPath);
  await mkdir(join(base, 'attempts'), { recursive: true });
  await writeFile(join(base, 'PROJECT.md.bak'), backupBytes);
  const backup = { schemaVersion: 1, previewHash, diffIdentity, fromVersion, toVersion, backupPath, createdFromUpdated: backupUpdated, files: [{ path: 'PROJECT.md', backup: 'PROJECT.md.bak', sha256: createHash('sha256').update(backupBytes).digest('hex') }] };
  const attemptedAt = new Date(Date.parse(appliedAt) - 1).toISOString();
  const attempted = { schemaVersion: 1, attemptId: 'attempt-001', previewHash, diffIdentity, fromVersion, toVersion, attemptedAt, outcome: 'attempted' };
  const migration = { ...attempted, outcome: 'applied', appliedAt, completedAt };
  await writeFile(join(base, 'backup.json'), `${JSON.stringify(backup, null, 2)}\n`);
  await writeFile(join(base, 'attempts', 'attempt-001.attempted.json'), `${JSON.stringify(attempted, null, 2)}\n`);
  await writeFile(join(base, 'migration.json'), `${JSON.stringify(migration, null, 2)}\n`);
  return { backupPath, migration };
}

test('backup plus empty attempts is an incomplete crash residue, including before-attempt preparation failure', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture();
  const preview = await previewCoreUpgrade(root, candidate);
  await writePreparedArchive(root, preview);
  let report = await runTestDoctor(root);
  assert.equal(report.issues.some(item => item.code === 'CORE_UPGRADE_INCOMPLETE'), true);

  const secondRoot = await makeProjectFixture();
  const secondCandidate = await makeCandidateCoreFixture();
  const secondPreview = await previewCoreUpgrade(secondRoot, secondCandidate);
  const before = await readFile(join(secondRoot, 'PROJECT.md'));
  await assert.rejects(
    () => applyCoreUpgrade(secondRoot, secondCandidate, secondPreview.hash, { hooks: { beforeAttemptedPublish: async () => { throw new Error('pre-attempt failure'); } } }),
    error => error.code === 'CORE_UPGRADE_PUBLICATION_FAILED'
  );
  assert.deepEqual(await readFile(join(secondRoot, 'PROJECT.md')), before);
  report = await runTestDoctor(secondRoot);
  assert.equal(report.issues.some(item => item.code === 'CORE_UPGRADE_INCOMPLETE'), true);
});

test('backup bytes must parse and bind core_version and updated to backup receipt metadata', async t => {
  for (const mode of ['not-markdown', 'wrong-core-version', 'wrong-updated']) {
    await t.test(mode, async () => {
      const root = await makeProjectFixture();
      const candidate = await makeCandidateCoreFixture();
      const preview = await previewCoreUpgrade(root, candidate);
      const current = parseMarkdownDocument(await readFile(join(root, 'PROJECT.md'), 'utf8'), 'PROJECT.md');
      const bytes = mode === 'not-markdown' ? Buffer.from('not a Project document\n') : Buffer.from(serializeMarkdownDocument({
        ...current.attributes,
        ...(mode === 'wrong-core-version' ? { core_version: '9.9.9' } : { updated: new Date(Date.parse(current.attributes.updated) + 1000).toISOString() })
      }, current.body));
      await writePreparedArchive(root, preview, bytes);
      assert.equal((await runTestDoctor(root)).issues.some(item => item.code === 'CORE_BACKUP_INVALID'), true);
    });
  }
});

test('a successor backup pre-state is bound to the prior applied toVersion and appliedAt', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture();
  const preview = await previewCoreUpgrade(root, candidate);
  await applyCoreUpgrade(root, candidate, preview.hash);
  const prior = JSON.parse(await readFile(join(root, preview.backupPath, 'migration.json')));
  const falsePreState = new Date(Date.parse(prior.appliedAt) + 1000).toISOString();
  const appliedAt = new Date(Date.parse(falsePreState) + 1000).toISOString();
  const completedAt = new Date(Date.parse(appliedAt) + 60_000).toISOString();
  const successor = await writeAppliedArchive(root, { fromVersion: '2.1.0', toVersion: '2.2.0', backupUpdated: falsePreState, appliedAt, completedAt, identity: 'false-pre-state' });
  const project = parseMarkdownDocument(await readFile(join(root, 'PROJECT.md'), 'utf8'), 'PROJECT.md');
  await writeFile(join(root, 'PROJECT.md'), serializeMarkdownDocument({ ...project.attributes, core_version: '2.2.0', updated: successor.migration.appliedAt }, project.body));
  const report = await verifyUpgradeArchives(root);
  assert.equal(report.problems.some(item => item.code === 'CORE_BACKUP_INVALID' && /pre-state|successor/u.test(item.message)), true, JSON.stringify(report.problems));
});

test('archive verifier, apply, and CLI normalize unreadable archive I/O without throwing raw errors', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture();
  const preview = await previewCoreUpgrade(root, candidate);
  const archiveRoot = join(root, 'archive', 'core-upgrades');
  await mkdir(archiveRoot, { recursive: true });
  await chmod(archiveRoot, 0o000);
  try {
    const verified = await verifyUpgradeArchives(root);
    assert.equal(verified.problems.some(item => item.code === 'CORE_BACKUP_INVALID'), true);
    await assert.rejects(() => applyCoreUpgrade(root, candidate, preview.hash), error => error instanceof ResearchOSError && error.code === 'CORE_BACKUP_INVALID');
    const io = captureIo();
    const exit = await main(['core', 'upgrade-apply', '--project', root, '--candidate-core', candidate, '--preview-hash', preview.hash], io.io);
    assert.equal([3, 7].includes(exit), true);
    assert.match(io.output().stderr, /CORE_BACKUP_INVALID/u);
    assert.doesNotMatch(io.output().stderr, /\n\s+at\s/u);
  } finally { await chmod(archiveRoot, 0o700); }
});

test('new attempt time advances from the latest global migration completion even when PROJECT.updated is earlier', async () => {
  const root = await makeProjectFixture();
  const current = parseMarkdownDocument(await readFile(join(root, 'PROJECT.md'), 'utf8'), 'PROJECT.md');
  const appliedAt = current.attributes.updated;
  const completedAt = new Date(Date.parse(appliedAt) + 60_000).toISOString();
  const backupUpdated = new Date(Date.parse(appliedAt) - 10).toISOString();
  await writeAppliedArchive(root, { fromVersion: '0.9.0', toVersion: '2.0.0', backupUpdated, appliedAt, completedAt, identity: 'prior-runtime-activation' });
  const candidate = await makeCandidateCoreFixture();
  const preview = await previewCoreUpgrade(root, candidate);
  const result = await applyCoreUpgrade(root, candidate, preview.hash);
  const migration = JSON.parse(await readFile(join(root, result.backupPath, 'migration.json')));
  assert.equal(Date.parse(migration.attemptedAt) > Date.parse(completedAt), true);
});

test('attempted-receipt write failure is normalized and leaves the preparation residue diagnosable', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture();
  const preview = await previewCoreUpgrade(root, candidate);
  const attempts = join(root, preview.backupPath, 'attempts');
  let caught;
  try {
    await applyCoreUpgrade(root, candidate, preview.hash, {
      hooks: { beforeAttemptedPublish: async () => chmod(attempts, 0o500) }
    });
  } catch (error) { caught = error; }
  finally { await chmod(attempts, 0o700); }
  assert.equal(caught instanceof ResearchOSError, true);
  assert.equal(caught.code, 'CORE_UPGRADE_PUBLICATION_FAILED');
  assert.equal((await runTestDoctor(root)).issues.some(item => item.code === 'CORE_UPGRADE_INCOMPLETE'), true);
});

test('public CLI normalizes an attempted-receipt write failure after a completed prior attempt', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture();
  const preview = await previewCoreUpgrade(root, candidate);
  await assert.rejects(
    () => applyCoreUpgrade(root, candidate, preview.hash, { hooks: { afterAttempted: async () => { throw new Error('first attempt fails cleanly'); } } }),
    error => error.code === 'CORE_UPGRADE_PUBLICATION_FAILED'
  );
  const attempts = join(root, preview.backupPath, 'attempts');
  await chmod(attempts, 0o500);
  const io = captureIo();
  let exit;
  let thrown;
  try { exit = await main(['core', 'upgrade-apply', '--project', root, '--candidate-core', candidate, '--preview-hash', preview.hash], io.io); }
  catch (error) { thrown = error; }
  finally { await chmod(attempts, 0o700); }
  assert.equal(thrown, undefined);
  assert.equal(exit, 7);
  assert.match(io.output().stderr, /CORE_UPGRADE_PUBLICATION_FAILED/u);
  assert.doesNotMatch(io.output().stderr, /\n\s+at\s/u);
});

test('an unremovable verified migration stage is an explicit incomplete residue, never applied authority', async () => {
  const root = await makeProjectFixture();
  const candidate = await makeCandidateCoreFixture();
  const preview = await previewCoreUpgrade(root, candidate);
  const before = await readFile(join(root, 'PROJECT.md'));
  const archive = join(root, preview.backupPath);
  let caught;
  try {
    await applyCoreUpgrade(root, candidate, preview.hash, {
      hooks: { beforeMigrationPublish: async () => chmod(archive, 0o500) }
    });
  } catch (error) {
    caught = error;
  } finally {
    await chmod(archive, 0o700);
  }

  assert.equal(caught instanceof ResearchOSError, true);
  assert.equal(caught.code, 'CORE_UPGRADE_PUBLICATION_FAILED');
  assert.deepEqual(await readFile(join(root, 'PROJECT.md')), before);
  const stageNames = (await readdir(archive)).filter(name => name.startsWith('.migration-'));
  assert.equal(stageNames.length, 1);
  const stagePath = `${preview.backupPath}/${stageNames[0]}`;
  const report = await runTestDoctor(root);
  assert.equal(report.issues.some(item => item.code === 'CORE_UPGRADE_INCOMPLETE' && item.path === stagePath), true, JSON.stringify(report.issues));
  assert.equal(report.issues.some(item => item.code === 'CORE_BACKUP_INVALID'), false, JSON.stringify(report.issues));
  assert.equal(report.issues.some(item => item.code === 'CORE_UPGRADE_FAILED_RESTORED'), true, JSON.stringify(report.issues));

  const project = parseMarkdownDocument(before.toString('utf8'), 'PROJECT.md');
  await writeFile(join(root, 'PROJECT.md'), serializeMarkdownDocument({ ...project.attributes, title: `${project.attributes.title} changed` }, project.body));
  const falseRestoration = await runTestDoctor(root);
  assert.equal(falseRestoration.issues.some(item => item.code === 'CORE_UPGRADE_STATE_MISMATCH'), true, JSON.stringify(falseRestoration.issues));
  await writeFile(join(root, 'PROJECT.md'), before);
  await assert.rejects(() => applyCoreUpgrade(root, candidate, preview.hash), error => error.code === 'CORE_UPGRADE_INCOMPLETE');

  await writeFile(join(archive, stageNames[0]), '{}\n', 'utf8');
  const tampered = await runTestDoctor(root);
  assert.equal(tampered.issues.some(item => item.code === 'CORE_BACKUP_INVALID'), true, JSON.stringify(tampered.issues));
});
