#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { constants } from 'node:fs';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeUtf8Atomic } from '../src/lib/fs.js';
import { normalizedLockRoot, verifyDependencyLock } from '../src/dependency-lock.js';

function fail(message) {
  process.stderr.write(`[DEPENDENCY_LOCK_REPAIR_FAILED] ${message}\n`);
  process.exitCode = 7;
}

function inside(root, target) {
  const fromRoot = relative(root, target);
  return fromRoot === '' || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot));
}

async function readRegularJson(path, label, root) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  const canonical = await realpath(path);
  if (!inside(root, canonical)) throw new Error(`${label} resolves outside its authority root`);
  return JSON.parse(await readFile(path, 'utf8'));
}

async function assertAtomicPublicationAuthority(root) {
  try {
    await access(root, constants.W_OK | constants.X_OK);
  } catch (error) {
    throw new Error(`canonical package directory lacks write and search authority for atomic publication: ${error.message}`);
  }
}

export async function preflightDependencyLockRepair(packageRoot) {
  const root = await realpath(packageRoot);
  const packageJson = await readRegularJson(join(root, 'package.json'), 'package.json', root);
  const nodeModulesPath = resolve(root, 'node_modules');
  const nodeModulesStat = await lstat(nodeModulesPath);
  if (!nodeModulesStat.isDirectory() || nodeModulesStat.isSymbolicLink()) throw new Error('node_modules must be a real directory, not a symlink');
  const nodeModulesRoot = await realpath(nodeModulesPath);
  if (!inside(root, nodeModulesRoot) || nodeModulesRoot !== nodeModulesPath) throw new Error('node_modules resolves outside the package root');
  const hiddenPath = join(nodeModulesRoot, '.package-lock.json');
  const installed = await readRegularJson(hiddenPath, 'node_modules/.package-lock.json', nodeModulesRoot);
  if (installed.lockfileVersion !== 3 || !installed.packages || Array.isArray(installed.packages) || typeof installed.packages !== 'object') {
    throw new Error('installed dependency snapshot must be a v3 package-lock packages object');
  }
  const packages = Object.fromEntries(Object.entries(installed.packages).sort(([a], [b]) => a.localeCompare(b, 'en')));
  packages[''] = normalizedLockRoot(packageJson);
  const lock = { name: packageJson.name, version: packageJson.version, lockfileVersion: 3, requires: true, packages };
  verifyDependencyLock(packageJson, lock);
  const lockPath = join(root, 'package-lock.json');
  try {
    const lockStat = await lstat(lockPath);
    if (!lockStat.isFile() || lockStat.isSymbolicLink()) throw new Error('package-lock.json must be a regular non-symlink file');
    if (!inside(root, await realpath(lockPath))) throw new Error('package-lock.json resolves outside the package root');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await assertAtomicPublicationAuthority(root);
  return Object.freeze({ root, lockPath, lock });
}

export async function repairDependencyLock(packageRoot) {
  const { root, lockPath, lock } = await preflightDependencyLockRepair(packageRoot);
  await assertAtomicPublicationAuthority(root);
  await writeUtf8Atomic(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return Object.freeze({ repaired: 'package-lock.json', source: 'node_modules/.package-lock.json', packageRoot: root });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf('--package-root');
  if (index === -1 || process.argv[index + 1] === undefined || process.argv.length !== 4) {
    fail('Usage: repair-dependency-lock --package-root PATH');
  } else {
    try { process.stdout.write(`${JSON.stringify(await repairDependencyLock(process.argv[index + 1]))}\n`); }
    catch (error) { fail(error.message); }
  }
}
