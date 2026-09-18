import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../../src/cli.js';
import { inspectDependencyLock, runDoctor } from '../../src/doctor.js';
import { installResearchOsSkill } from '../../src/skill/installation.js';
import { preflightDependencyLockRepair, repairDependencyLock } from '../../scripts/repair-dependency-lock.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../../src/lib/markdown.js';
import { buildViews } from '../../src/views/generate.js';
import { captureIo, configureSessionFixture, makeProjectFixture, makeTempDir } from '../helpers/fixtures.js';

const PACKAGED_SKILLS_ROOT = join(process.cwd(), 'skills');
function runTestDoctor(root, options = {}) {
  return runDoctor(root, { skillsRoot: PACKAGED_SKILLS_ROOT, ...options });
}

function generatedCheck(report) {
  return report.checks.find(item => item.id === 'generated-views');
}

test('Doctor distinguishes missing, mismatched, and current Skill installations', async t => {
  const root = await makeProjectFixture();
  const skillsRoot = join(await makeTempDir(), 'skills');

  await t.test('missing', async () => {
    const report = await runTestDoctor(root, { skillsRoot });
    const check = report.checks.find(item => item.id === 'skill-installation');
    assert.equal(check.status, 'fail');
    assert.deepEqual(check.issues.map(item => item.code), ['SKILL_MISSING']);
    assert.deepEqual(check.issues[0].recovery, {
      kind: 'executable',
      command: `research-os skill install --target '${skillsRoot}'`
    });
    assert.match(check.evidence[0], /^packaged=[a-f0-9]{64}$/u);
    assert.equal(check.evidence[1], 'installed=missing');
  });

  await installResearchOsSkill({ skillsRoot });
  await t.test('current', async () => {
    const report = await runTestDoctor(root, { skillsRoot });
    const check = report.checks.find(item => item.id === 'skill-installation');
    assert.equal(check.status, 'pass');
    assert.deepEqual(check.issues, []);
    assert.equal(check.evidence[0].replace('packaged=', ''), check.evidence[1].replace('installed=', ''));
  });

  const skillPath = join(skillsRoot, 'research-os', 'SKILL.md');
  await writeFile(skillPath, `${await readFile(skillPath, 'utf8')}\nlocal change\n`, 'utf8');
  await t.test('mismatched', async () => {
    const report = await runTestDoctor(root, { skillsRoot });
    const check = report.checks.find(item => item.id === 'skill-installation');
    assert.equal(check.status, 'fail');
    assert.deepEqual(check.issues.map(item => item.code), ['SKILL_DIGEST_MISMATCH']);
    assert.equal(check.issues[0].recovery.kind, 'manual');
    assert.match(check.issues[0].recovery.instruction, /conflict|review|inspect/iu);
  });
});

test('Doctor compares a generated manifest with the complete current canonical input snapshot', async () => {
  const root = await makeProjectFixture();
  await buildViews(root);
  await writeFile(join(root, 'NEW-AUTHORITY.md'), '# New authority\n', 'utf8');
  const report = await runTestDoctor(root);
  assert.equal(generatedCheck(report).status, 'fail');
  assert.equal(report.issues.some(item => item.code === 'GENERATED_VIEW_STALE'), true);
});

test('Doctor enforces exact generation manifest shape, digest, pin, inventory order, and uniqueness', async t => {
  const mutations = {
    'extra key': manifest => { manifest.extra = true; },
    'wrong schema': manifest => { manifest.schemaVersion = 2; },
    'wrong core pin': manifest => { manifest.coreVersion = '9.9.9'; },
    'wrong source digest': manifest => { manifest.sourceDigest = '0'.repeat(64); },
    'duplicate input': manifest => { manifest.inputs.push(structuredClone(manifest.inputs[0])); },
    'unsorted inputs': manifest => { manifest.inputs.reverse(); }
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async () => {
      const root = await makeProjectFixture();
      await buildViews(root);
      const path = join(root, 'generated', 'generation-manifest.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      mutate(manifest);
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      const report = await runTestDoctor(root);
      assert.equal(generatedCheck(report).status, 'fail');
      assert.equal(report.issues.some(item => item.code === 'GENERATED_VIEW_INVALID'), true);
    });
  }
});

test('Doctor turns a symlinked generation manifest into a structured manual-recovery issue', async () => {
  const root = await makeProjectFixture();
  await buildViews(root);
  const path = join(root, 'generated', 'generation-manifest.json');
  const outside = join(await makeTempDir(), 'manifest.json');
  await rename(path, outside);
  await symlink(outside, path);
  const report = await runTestDoctor(root);
  const found = report.issues.find(item => item.code === 'GENERATED_VIEW_INVALID');
  assert.equal(generatedCheck(report).status, 'fail');
  assert.equal(found.recovery.kind, 'manual');
});

test('Doctor diagnoses exact/glob active writer overlap but ignores disjoint and terminal writers', async () => {
  const root = await makeProjectFixture();
  await configureSessionFixture(root, { objective: 'Shared objective.', plan: { writable_paths: ['evidence/**', 'research/**'] } });
  const planPath = join(root, 'plans', 'active.md');
  const plan = parseMarkdownDocument(await readFile(planPath, 'utf8'), planPath);
  const at = plan.attributes.created;
  const registration = (id, status, paths) => ({
    id, kind: 'audit', task_id: `task-${id}`, purpose: 'Audit evidence.', action_id: 'ACT-001',
    readable_paths: paths, writable_paths: paths, forbidden_changes: ['PROJECT.md'], expected_artifacts: [`${paths[0].replace(/\/(?:\*\*|\*)$/u, '')}/out.md`],
    acceptance: 'Artifact checked.', owner: `owner-${id}`, status, blockers: [], receiver: 'foreground', registered_at: at, updated_at: at,
    control_paths: ['PROJECT.md', 'plans/active.md']
  });
  const attributes = { ...plan.attributes, background_register: [
    registration('BG-001', 'running', ['evidence/**']),
    registration('BG-002', 'blocked', ['evidence/results/*']),
    registration('BG-003', 'running', ['research/**']),
    registration('BG-004', 'accepted', ['evidence/**'])
  ] };
  await writeFile(planPath, serializeMarkdownDocument(attributes, plan.body), 'utf8');
  const report = await runTestDoctor(root);
  const conflicts = report.issues.filter(item => item.code === 'BACKGROUND_WRITER_CONFLICT');
  assert.equal(conflicts.length, 2);
  assert.deepEqual(new Set(conflicts.flatMap(item => item.relatedIds)), new Set(['BG-001', 'BG-002']));
  assert.equal(conflicts.every(item => item.path.includes('plans/active.md')), true);
});

test('dependency lock authority validates shape and package/dependency identity', async () => {
  const packageRoot = await makeTempDir();
  await cp(join(process.cwd(), 'package.json'), join(packageRoot, 'package.json'));
  await cp(join(process.cwd(), 'package-lock.json'), join(packageRoot, 'package-lock.json'));
  await mkdir(join(packageRoot, 'node_modules'));
  await cp(join(process.cwd(), 'node_modules', '.package-lock.json'), join(packageRoot, 'node_modules', '.package-lock.json'));
  const afterRepair = await inspectDependencyLock(packageRoot);
  assert.equal(afterRepair.status, 'pass', JSON.stringify(afterRepair.issues));
  const lockPath = join(packageRoot, 'package-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  lock.packages[''].version = '9.9.9';
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  const check = await inspectDependencyLock(packageRoot);
  assert.equal(check.status, 'fail');
  assert.equal(check.issues.some(item => item.code === 'DEPENDENCY_LOCK_INVALID'), true);
  assert.equal(check.issues[0].recovery.kind, 'executable');
  const [command, ...args] = check.issues[0].recovery.argv;
  const repaired = spawnSync(command, args, { cwd: packageRoot, encoding: 'utf8' });
  assert.equal(repaired.status, 0, repaired.stderr);
  const repairedCheck = await inspectDependencyLock(packageRoot);
  assert.equal(repairedCheck.status, 'pass', JSON.stringify(repairedCheck.issues));
  const integrityLock = JSON.parse(await readFile(lockPath, 'utf8'));
  delete integrityLock.packages['node_modules/ajv'].integrity;
  await writeFile(lockPath, `${JSON.stringify(integrityLock, null, 2)}\n`, 'utf8');
  const integrityCheck = await inspectDependencyLock(packageRoot);
  assert.equal(integrityCheck.status, 'fail');
  assert.equal(integrityCheck.issues[0].recovery.kind, 'executable');
  const [repairProgram, ...repairArgs] = integrityCheck.issues[0].recovery.argv;
  const integrityRepair = spawnSync(repairProgram, repairArgs, { encoding: 'utf8' });
  assert.equal(integrityRepair.status, 0, integrityRepair.stderr);
  assert.equal((await inspectDependencyLock(packageRoot)).status, 'pass');
});

test('regular generated tamper advertises an executable recovery that actually repairs the state', async () => {
  const root = await makeProjectFixture();
  await buildViews(root);
  await writeFile(join(root, 'generated', 'dashboard.md'), 'tampered\n', 'utf8');
  const report = await runTestDoctor(root);
  const found = report.issues.find(item => item.code === 'GENERATED_VIEW_TAMPERED');
  assert.deepEqual(found.recovery, { kind: 'executable', command: 'research-os view build --project .' });
  const io = captureIo();
  assert.equal(await main(['view', 'build', '--project', root], io.io), 0);
  assert.equal(generatedCheck(await runTestDoctor(root)).status, 'pass');
});

test('dependency lock verifier covers top-level identity, requires, SRI, transitives, and graph references', async t => {
  const fixture = async mutate => {
    const root = await makeTempDir();
    await cp(join(process.cwd(), 'package.json'), join(root, 'package.json'));
    await cp(join(process.cwd(), 'package-lock.json'), join(root, 'package-lock.json'));
    const path = join(root, 'package-lock.json');
    const lock = JSON.parse(await readFile(path, 'utf8'));
    mutate(lock);
    await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
    return inspectDependencyLock(root);
  };
  const cases = {
    'top-level name': lock => { lock.name = 'forged'; },
    'top-level version': lock => { lock.version = '9.9.9'; },
    'requires false': lock => { lock.requires = false; },
    'invalid direct SRI': lock => { lock.packages['node_modules/ajv'].integrity = 'x'; },
    'wrong direct SRI digest length': lock => { lock.packages['node_modules/ajv'].integrity = 'sha512-YQ=='; },
    'invalid transitive SemVer': lock => { lock.packages['node_modules/fast-uri'].version = 'not-semver'; },
    'missing transitive SRI': lock => { delete lock.packages['node_modules/fast-uri'].integrity; },
    'missing dependency target': lock => { delete lock.packages['node_modules/fast-uri']; },
    'unsafe package key': lock => { lock.packages['../escape'] = structuredClone(lock.packages['node_modules/fast-uri']); }
  };
  for (const [name, mutate] of Object.entries(cases)) {
    await t.test(name, async () => assert.equal((await fixture(mutate)).status, 'fail'));
  }
});

test('dependency repair rejects malformed hidden authority without changing package-lock bytes', async () => {
  const root = await makeTempDir();
  await cp(join(process.cwd(), 'package.json'), join(root, 'package.json'));
  await cp(join(process.cwd(), 'package-lock.json'), join(root, 'package-lock.json'));
  await mkdir(join(root, 'node_modules'));
  await cp(join(process.cwd(), 'node_modules', '.package-lock.json'), join(root, 'node_modules', '.package-lock.json'));
  const target = join(root, 'package-lock.json');
  const before = await readFile(target);
  const hiddenPath = join(root, 'node_modules', '.package-lock.json');
  const hidden = JSON.parse(await readFile(hiddenPath, 'utf8'));
  hidden.packages['node_modules/fast-uri'].integrity = 'x';
  await writeFile(hiddenPath, `${JSON.stringify(hidden, null, 2)}\n`, 'utf8');
  await assert.rejects(() => repairDependencyLock(root), /integrity|SRI/u);
  assert.deepEqual(await readFile(target), before);
});

test('dependency repair rejects symlinked node_modules without changing package-lock bytes', async () => {
  const root = await makeTempDir();
  await cp(join(process.cwd(), 'package.json'), join(root, 'package.json'));
  await cp(join(process.cwd(), 'package-lock.json'), join(root, 'package-lock.json'));
  const target = join(root, 'package-lock.json');
  const before = await readFile(target);
  const external = await makeTempDir();
  await cp(join(process.cwd(), 'node_modules', '.package-lock.json'), join(external, '.package-lock.json'));
  await symlink(external, join(root, 'node_modules'));
  await assert.rejects(() => repairDependencyLock(root), /symlink|real directory|outside/u);
  assert.deepEqual(await readFile(target), before);
});

test('dependency recovery is manual when the canonical package directory cannot publish atomically', async () => {
  const root = await makeTempDir();
  await cp(join(process.cwd(), 'package.json'), join(root, 'package.json'));
  await cp(join(process.cwd(), 'package-lock.json'), join(root, 'package-lock.json'));
  await mkdir(join(root, 'node_modules'));
  await cp(join(process.cwd(), 'node_modules', '.package-lock.json'), join(root, 'node_modules', '.package-lock.json'));
  const lockPath = join(root, 'package-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  lock.lockfileVersion = 2;
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  const before = await readFile(lockPath);
  const entriesBefore = await readdir(root);

  await chmod(root, 0o500);
  try {
    const inspected = await inspectDependencyLock(root);
    assert.equal(inspected.status, 'fail');
    assert.equal(inspected.issues[0].code, 'DEPENDENCY_LOCK_UNSUPPORTED');
    assert.equal(inspected.issues[0].recovery.kind, 'manual');
    await assert.rejects(() => preflightDependencyLockRepair(root), /atomic|publish|writ|search|permission/iu);
    assert.deepEqual(await readFile(lockPath), before);
    assert.deepEqual(await readdir(root), entriesBefore);
  } finally {
    await chmod(root, 0o700);
  }
});

test('dependency lock contract is explicitly exact-version npm v3 and reports unsupported inputs distinctly', async t => {
  await t.test('current real npm v3 lock passes with contract evidence', async () => {
    const root = await makeTempDir();
    await cp(join(process.cwd(), 'package.json'), join(root, 'package.json'));
    await cp(join(process.cwd(), 'package-lock.json'), join(root, 'package-lock.json'));
    const check = await inspectDependencyLock(root);
    assert.equal(check.status, 'pass', JSON.stringify(check.issues));
    assert.equal(check.evidence.includes('contract=exact-version-npm-v3'), true);
  });

  await t.test('real npm-generated v2 lock is unsupported', async () => {
    const root = await makeTempDir();
    await cp(join(process.cwd(), 'package.json'), join(root, 'package.json'));
    await cp(join(process.cwd(), 'package-lock.json'), join(root, 'package-lock.json'));
    const generated = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--lockfile-version=2', '--offline'], { cwd: root, encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    assert.equal(JSON.parse(await readFile(join(root, 'package-lock.json'))).lockfileVersion, 2);
    const check = await inspectDependencyLock(root);
    assert.equal(check.status, 'fail');
    assert.equal(check.issues[0].code, 'DEPENDENCY_LOCK_UNSUPPORTED');
    assert.match(check.issues[0].message, /UNSUPPORTED|exact-version npm v3/iu);
  });

  await t.test('direct root range is unsupported rather than corrupt', async () => {
    const root = await makeTempDir();
    await cp(join(process.cwd(), 'package.json'), join(root, 'package.json'));
    await cp(join(process.cwd(), 'package-lock.json'), join(root, 'package-lock.json'));
    const packagePath = join(root, 'package.json');
    const lockPath = join(root, 'package-lock.json');
    const packageJson = JSON.parse(await readFile(packagePath));
    const lock = JSON.parse(await readFile(lockPath));
    packageJson.dependencies.ajv = '^8.17.1';
    lock.packages[''].dependencies.ajv = '^8.17.1';
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    const check = await inspectDependencyLock(root);
    assert.equal(check.status, 'fail');
    assert.equal(check.issues[0].code, 'DEPENDENCY_LOCK_UNSUPPORTED');
    assert.match(check.issues[0].message, /exact version|UNSUPPORTED/iu);
  });
});

test('every transitive dependency edge must resolve to a version satisfying its declared SemVer range', async () => {
  const root = await makeTempDir();
  await cp(join(process.cwd(), 'package.json'), join(root, 'package.json'));
  await cp(join(process.cwd(), 'package-lock.json'), join(root, 'package-lock.json'));
  const path = join(root, 'package-lock.json');
  const lock = JSON.parse(await readFile(path));
  assert.match(lock.packages['node_modules/ajv'].dependencies['fast-uri'], /^\^3/u);
  lock.packages['node_modules/fast-uri'].version = '9.9.9';
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`);
  const check = await inspectDependencyLock(root);
  assert.equal(check.status, 'fail');
  assert.equal(check.issues[0].code, 'DEPENDENCY_LOCK_INVALID');
  assert.match(check.issues[0].message, /does not satisfy|fast-uri/iu);
});

test('exact-version root optionalDependencies participate in the same npm v3 graph contract', async () => {
  const root = await makeTempDir();
  await cp(join(process.cwd(), 'package.json'), join(root, 'package.json'));
  await cp(join(process.cwd(), 'package-lock.json'), join(root, 'package-lock.json'));
  const packagePath = join(root, 'package.json');
  const lockPath = join(root, 'package-lock.json');
  const packageJson = JSON.parse(await readFile(packagePath));
  const lock = JSON.parse(await readFile(lockPath));
  delete packageJson.dependencies.semver;
  packageJson.optionalDependencies = { semver: '7.8.5' };
  delete lock.packages[''].dependencies.semver;
  lock.packages[''].optionalDependencies = { semver: '7.8.5' };
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  assert.equal((await inspectDependencyLock(root)).status, 'pass');

  packageJson.optionalDependencies.semver = '^7.8.5';
  lock.packages[''].optionalDependencies.semver = '^7.8.5';
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const unsupported = await inspectDependencyLock(root);
  assert.equal(unsupported.status, 'fail');
  assert.equal(unsupported.issues[0].code, 'DEPENDENCY_LOCK_UNSUPPORTED');
});

async function executableDependencyRecovery(issue, packageRoot) {
  assert.equal(issue.recovery.kind, 'executable');
  const before = await inspectDependencyLock(packageRoot);
  assert.equal(before.status, 'fail');
  const [program, ...args] = issue.recovery.argv;
  const result = spawnSync(program, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await inspectDependencyLock(packageRoot)).status, 'pass');
}

test('dependency recovery is state-aware and every advertised executable fixture actually recovers', async t => {
  await t.test('unsupported root range is manual', async () => {
    const root = await makeTempDir();
    await cp(join(process.cwd(), 'package.json'), join(root, 'package.json'));
    await cp(join(process.cwd(), 'package-lock.json'), join(root, 'package-lock.json'));
    await mkdir(join(root, 'node_modules'));
    await cp(join(process.cwd(), 'node_modules/.package-lock.json'), join(root, 'node_modules/.package-lock.json'));
    const packagePath = join(root, 'package.json');
    const lockPath = join(root, 'package-lock.json');
    const packageJson = JSON.parse(await readFile(packagePath));
    const lock = JSON.parse(await readFile(lockPath));
    packageJson.dependencies.semver = '^7.8.5';
    lock.packages[''].dependencies.semver = '^7.8.5';
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    const before = await readFile(lockPath);
    const issue = (await inspectDependencyLock(root)).issues[0];
    assert.equal(issue.code, 'DEPENDENCY_LOCK_UNSUPPORTED');
    assert.equal(issue.recovery.kind, 'manual');
    assert.match(issue.recovery.instruction, /exact-version npm v3|supported release|contract/iu);
    assert.deepEqual(await readFile(lockPath), before);
  });

  await t.test('invalid hidden authority makes invalid public lock manual', async () => {
    const root = await makeTempDir();
    await cp(join(process.cwd(), 'package.json'), join(root, 'package.json'));
    await cp(join(process.cwd(), 'package-lock.json'), join(root, 'package-lock.json'));
    await mkdir(join(root, 'node_modules'));
    await cp(join(process.cwd(), 'node_modules/.package-lock.json'), join(root, 'node_modules/.package-lock.json'));
    const lockPath = join(root, 'package-lock.json');
    const lock = JSON.parse(await readFile(lockPath));
    lock.packages[''].version = '9.9.9';
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    const hiddenPath = join(root, 'node_modules/.package-lock.json');
    const hidden = JSON.parse(await readFile(hiddenPath));
    hidden.packages['node_modules/fast-uri'].integrity = 'x';
    await writeFile(hiddenPath, `${JSON.stringify(hidden, null, 2)}\n`);
    assert.equal((await inspectDependencyLock(root)).issues[0].recovery.kind, 'manual');
  });

  await t.test('missing public lock is executable when hidden v3 authority preflights', async () => {
    const root = await makeTempDir();
    await cp(join(process.cwd(), 'package.json'), join(root, 'package.json'));
    await mkdir(join(root, 'node_modules'));
    await cp(join(process.cwd(), 'node_modules/.package-lock.json'), join(root, 'node_modules/.package-lock.json'));
    const issue = (await inspectDependencyLock(root)).issues[0];
    assert.equal(issue.code, 'DEPENDENCY_LOCK_MISSING');
    await executableDependencyRecovery(issue, root);
  });

  await t.test('public v2 lock is executable when exact package and hidden v3 authority preflight', async () => {
    const root = await makeTempDir();
    await cp(join(process.cwd(), 'package.json'), join(root, 'package.json'));
    await cp(join(process.cwd(), 'package-lock.json'), join(root, 'package-lock.json'));
    await mkdir(join(root, 'node_modules'));
    await cp(join(process.cwd(), 'node_modules/.package-lock.json'), join(root, 'node_modules/.package-lock.json'));
    const lockPath = join(root, 'package-lock.json');
    const lock = JSON.parse(await readFile(lockPath));
    lock.lockfileVersion = 2;
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    const issue = (await inspectDependencyLock(root)).issues[0];
    assert.equal(issue.code, 'DEPENDENCY_LOCK_UNSUPPORTED');
    await executableDependencyRecovery(issue, root);
  });
});
