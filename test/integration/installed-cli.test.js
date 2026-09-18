import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { EXIT_CODES } from '../../src/lib/errors.js';
import { makeTempDir } from '../helpers/fixtures.js';

const packageRoot = process.cwd();

async function declaredEntry() {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  return join(packageRoot, packageJson.bin['research-os']);
}

async function installedStyleLink() {
  const root = await makeTempDir();
  const binRoot = join(root, 'bin');
  const linkPath = join(binRoot, 'research-os');
  await mkdir(binRoot);
  const entry = await declaredEntry();
  await symlink(entry, linkPath);
  return { entry, linkPath, root };
}

function spawnNode(linkPath, args) {
  return spawnSync(process.execPath, [linkPath, ...args], { encoding: 'utf8' });
}

test('declared npm entry runs through an installed-style symlink', async () => {
  const { entry, linkPath } = await installedStyleLink();

  const launched = spawnNode(linkPath, ['--help']);

  assert.equal(launched.status, EXIT_CODES.OK);
  assert.match(launched.stdout, /^Research OS/u);
  assert.equal(launched.stderr, '');

  if (process.platform !== 'win32') {
    assert.notEqual((await stat(entry)).mode & 0o111, 0);
    const direct = spawnSync(linkPath, ['--help'], { encoding: 'utf8' });
    assert.equal(direct.status, EXIT_CODES.OK);
    assert.match(direct.stdout, /^Research OS/u);
    assert.equal(direct.stderr, '');
  }
});

test('installed entry executes init, show, and usage errors', async () => {
  const { linkPath, root } = await installedStyleLink();
  const vault = join(root, 'vault');

  const initialized = spawnNode(linkPath, [
    'project', 'init', '--target', vault, '--id', 'installed-demo',
    '--title', 'Installed demo', '--stage', 'research'
  ]);
  assert.equal(initialized.status, EXIT_CODES.OK);
  assert.equal(JSON.parse(initialized.stdout).projectRoot, vault);
  assert.equal(initialized.stderr, '');

  const shown = spawnNode(linkPath, ['project', 'show', '--project', vault]);
  assert.equal(shown.status, EXIT_CODES.OK);
  assert.equal(JSON.parse(shown.stdout).project_id, 'installed-demo');
  assert.equal(shown.stderr, '');

  const unknown = spawnNode(linkPath, ['not-a-command']);
  assert.equal(unknown.status, EXIT_CODES.USAGE);
  assert.equal(unknown.stdout, '');
  assert.match(unknown.stderr, /^Unknown command: not-a-command/u);
});
