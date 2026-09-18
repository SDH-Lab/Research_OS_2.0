import assert from 'node:assert/strict';
import { readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { locateGuide } from '../../src/guide.js';
import {
  installResearchOsSkill,
  packagedSkillRoot,
  verifyResearchOsSkill
} from '../../src/skill/installation.js';
import { main } from '../../src/cli.js';
import { EXIT_CODES } from '../../src/lib/errors.js';
import { makeTempDir, pathExists } from '../helpers/fixtures.js';

async function makeSkillsRoot() {
  return join(await makeTempDir(), 'skills');
}

async function stagingEntries(skillsRoot) {
  if (!await pathExists(skillsRoot)) return [];
  return (await readdir(skillsRoot)).filter(name => name.startsWith('.research-os-install-'));
}

async function runCli(args) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, {
    stdout: value => { stdout += value; },
    stderr: value => { stderr += value; }
  });
  return { code, stdout, stderr };
}

test('skill install is atomic, verifiable, and idempotent', async () => {
  const skillsRoot = await makeSkillsRoot();

  const first = await installResearchOsSkill({ skillsRoot });
  assert.equal(first.status, 'installed');
  assert.equal(first.skillRoot, join(skillsRoot, 'research-os'));
  assert.deepEqual(await stagingEntries(skillsRoot), []);

  const verified = await verifyResearchOsSkill({ skillsRoot });
  assert.equal(verified.ok, true);
  assert.equal(verified.status, 'current');
  assert.equal(verified.packagedDigest, verified.installedDigest);
  assert.deepEqual(verified.issues, []);

  const before = await stat(join(skillsRoot, 'research-os', 'SKILL.md'));
  const second = await installResearchOsSkill({ skillsRoot });
  const after = await stat(join(skillsRoot, 'research-os', 'SKILL.md'));
  assert.equal(second.status, 'current');
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(await stagingEntries(skillsRoot), []);
});

test('missing and changed installations fail verification without being overwritten', async () => {
  const skillsRoot = await makeSkillsRoot();
  const missing = await verifyResearchOsSkill({ skillsRoot });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 'missing');
  assert.equal(missing.installedDigest, null);
  assert.deepEqual(missing.issues.map(issue => issue.code), ['SKILL_MISSING']);

  await installResearchOsSkill({ skillsRoot });
  const skillPath = join(skillsRoot, 'research-os', 'SKILL.md');
  await writeFile(skillPath, `${await readFile(skillPath, 'utf8')}\nlocal change\n`, 'utf8');
  const changedBytes = await readFile(skillPath);

  const mismatched = await verifyResearchOsSkill({ skillsRoot });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.status, 'mismatch');
  assert.notEqual(mismatched.packagedDigest, mismatched.installedDigest);
  assert.deepEqual(mismatched.issues.map(issue => issue.code), ['SKILL_DIGEST_MISMATCH']);

  await assert.rejects(
    installResearchOsSkill({ skillsRoot }),
    error => error?.code === 'CONFLICT'
  );
  assert.deepEqual(await readFile(skillPath), changedBytes);
  assert.deepEqual(await stagingEntries(skillsRoot), []);
});

test('a symlink in an installed skill is invalid and never followed', async () => {
  const skillsRoot = await makeSkillsRoot();
  await installResearchOsSkill({ skillsRoot });
  await symlink(packagedSkillRoot, join(skillsRoot, 'research-os', 'references', 'escape'));

  const report = await verifyResearchOsSkill({ skillsRoot });
  assert.equal(report.ok, false);
  assert.equal(report.status, 'invalid');
  assert.deepEqual(report.issues.map(issue => issue.code), ['SKILL_TREE_INVALID']);
  await assert.rejects(
    installResearchOsSkill({ skillsRoot }),
    error => error?.code === 'CONFLICT'
  );
  assert.deepEqual(await stagingEntries(skillsRoot), []);
});

test('installed Skill frontmatter and file inventory remain part of verification', async () => {
  const skillsRoot = await makeSkillsRoot();
  await installResearchOsSkill({ skillsRoot });
  const skillPath = join(skillsRoot, 'research-os', 'SKILL.md');
  await writeFile(skillPath, '# Research OS without frontmatter\n', 'utf8');

  const malformed = await verifyResearchOsSkill({ skillsRoot });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.status, 'invalid');
  assert.deepEqual(malformed.issues.map(issue => issue.code), ['SKILL_STRUCTURE_INVALID']);
  await assert.rejects(
    installResearchOsSkill({ skillsRoot }),
    error => error?.code === 'CONFLICT'
  );
  assert.deepEqual(await stagingEntries(skillsRoot), []);
});

test('skill and guide CLI commands emit one JSON document with stable exit codes', async () => {
  const skillsRoot = await makeSkillsRoot();

  const absent = await runCli(['skill', 'verify', '--target', skillsRoot]);
  assert.equal(absent.code, EXIT_CODES.VALIDATION);
  assert.equal(JSON.parse(absent.stdout).status, 'missing');
  assert.equal(absent.stderr, '');

  const installed = await runCli(['skill', 'install', '--target', skillsRoot]);
  assert.equal(installed.code, EXIT_CODES.OK);
  assert.equal(JSON.parse(installed.stdout).status, 'installed');
  assert.equal(installed.stderr, '');

  const located = await runCli(['guide', 'locate']);
  assert.equal(located.code, EXIT_CODES.OK);
  assert.deepEqual(JSON.parse(located.stdout), await locateGuide());
  assert.equal(located.stderr, '');
});

test('guide location is derived from this package and points at regular files', async () => {
  const located = await locateGuide();

  assert.equal(located.coreVersion, '2.0.0');
  assert.equal(located.packagedSkillRoot, packagedSkillRoot);
  assert.equal((await stat(located.guideIndex)).isFile(), true);
  assert.equal((await stat(join(located.packagedSkillRoot, 'SKILL.md'))).isFile(), true);
});
