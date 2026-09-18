import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { EXIT_CODES } from '../../src/lib/errors.js';
import { makeTempDir } from '../helpers/fixtures.js';

const packageRoot = process.cwd();
const launcher = join(packageRoot, 'bin', 'research-os.js');

function runInstalled(linkPath, args, codexHome) {
  return spawnSync(process.execPath, [linkPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: codexHome }
  });
}

function successfulJson(result, label) {
  assert.equal(result.status, EXIT_CODES.OK, `${label}: ${result.stderr}`);
  assert.equal(result.stderr, '', label);
  assert.notEqual(result.stdout.trim(), '', label);
  return JSON.parse(result.stdout);
}

test('installed capability reaches an unconfigured Vault across the filesystem boundary', async () => {
  const root = await makeTempDir();
  const codexHome = join(root, 'codex-home');
  const skillsRoot = join(codexHome, 'skills');
  const binRoot = join(root, 'bin');
  const installedCli = join(binRoot, 'research-os');
  const vault = join(root, 'vault');
  await mkdir(binRoot, { recursive: true });
  await symlink(launcher, installedCli);

  const installed = successfulJson(runInstalled(installedCli, [
    'skill', 'install', '--target', skillsRoot
  ], codexHome), 'skill install');
  assert.equal(installed.skillRoot, join(skillsRoot, 'research-os'));

  const verified = successfulJson(runInstalled(installedCli, [
    'skill', 'verify', '--target', skillsRoot
  ], codexHome), 'skill verify');
  assert.equal(verified.ok, true);
  assert.equal(verified.packagedDigest, verified.installedDigest);

  const initialized = successfulJson(runInstalled(installedCli, [
    'project', 'init', '--target', vault, '--id', 'cold-start-demo',
    '--title', 'Cold-start demo', '--stage', 'research'
  ], codexHome), 'project init');
  assert.equal(initialized.setupRequired, true);

  const doctor = successfulJson(runInstalled(installedCli, [
    'doctor', '--project', vault
  ], codexHome), 'doctor');
  assert.equal(doctor.ok, true);
  assert.equal(doctor.checks.find(item => item.id === 'skill-installation').status, 'pass');

  const guide = successfulJson(runInstalled(installedCli, [
    'guide', 'locate'
  ], codexHome), 'guide locate');
  assert.equal(guide.guideIndex, join(packageRoot, 'docs', 'user-guide', 'README.md'));
  assert.equal(resolve(guide.packagedSkillRoot), join(packageRoot, 'skills', 'research-os'));

  const setup = successfulJson(runInstalled(installedCli, [
    'project', 'setup-status', '--project', vault
  ], codexHome), 'project setup-status');
  assert.equal(setup.configured, false);
  assert.equal(setup.missingAuthority.some(item => item.id === 'foreground-objective'), true);

  const context = successfulJson(runInstalled(installedCli, [
    'session', 'context', '--project', vault
  ], codexHome), 'session context');
  assert.equal(context.foregroundObjective, null);
  assert.equal(context.nextAction, 'Define the foreground objective.');
  assert.deepEqual(context.authoritativeSources, ['AGENTS.md', 'PROJECT.md', 'plans/active.md']);

  const agentEntry = await readFile(join(vault, 'AGENTS.md'), 'utf8');
  assert.match(agentEntry, /\$research-os/u);
  assert.equal(agentEntry.includes(packageRoot), false);
});
