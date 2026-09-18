import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseMarkdownDocument } from '../lib/markdown.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const ABANDONED_STAGE = /^\.migration-(attempt-\d{3})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/u;

function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function exactKeys(value, keys) {
  return value && !Array.isArray(value) && typeof value === 'object'
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function validTime(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function later(left, right) { return Date.parse(left) < Date.parse(right); }
function inside(root, target) {
  const fromRoot = relative(root, target);
  return fromRoot === '' || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot));
}

async function assertDirectoryChain(root, path, label) {
  const components = relative(root, path).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = resolve(current, component);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory without a symbolic link; unsafe component: ${component}`);
    const canonical = await realpath(current);
    if (!inside(root, canonical)) throw new Error(`${label} resolves outside the Project root`);
  }
}

async function readRegular(root, path, label) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  const canonical = await realpath(path);
  if (!inside(root, canonical)) throw new Error(`${label} resolves outside the Project root`);
  return readFile(path);
}

async function readJson(root, path, label) {
  try { return JSON.parse((await readRegular(root, path, label)).toString('utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON: ${error.message}`);
    throw error;
  }
}

function validBackup(value) {
  if (!exactKeys(value, ['schemaVersion', 'previewHash', 'diffIdentity', 'fromVersion', 'toVersion', 'backupPath', 'createdFromUpdated', 'files'])
    || value.schemaVersion !== 1 || !SHA256.test(value.previewHash) || !SHA256.test(value.diffIdentity)
    || !SEMVER.test(value.fromVersion) || !SEMVER.test(value.toVersion) || typeof value.backupPath !== 'string'
    || !validTime(value.createdFromUpdated) || !Array.isArray(value.files) || value.files.length !== 1) return false;
  const file = value.files[0];
  return exactKeys(file, ['path', 'backup', 'sha256']) && file.path === 'PROJECT.md'
    && file.backup === 'PROJECT.md.bak' && SHA256.test(file.sha256);
}

function commonAttempt(value, backup, attemptId, outcome) {
  return value?.schemaVersion === 1 && value.attemptId === attemptId && value.outcome === outcome
    && value.previewHash === backup.previewHash && value.diffIdentity === backup.diffIdentity
    && value.fromVersion === backup.fromVersion && value.toVersion === backup.toVersion
    && validTime(value.attemptedAt);
}

function validAttempted(value, backup, attemptId) {
  return exactKeys(value, ['schemaVersion', 'attemptId', 'previewHash', 'diffIdentity', 'fromVersion', 'toVersion', 'attemptedAt', 'outcome'])
    && commonAttempt(value, backup, attemptId, 'attempted');
}

function validFailure(value, backup, attemptId) {
  return exactKeys(value, ['schemaVersion', 'attemptId', 'previewHash', 'diffIdentity', 'fromVersion', 'toVersion', 'attemptedAt', 'outcome', 'completedAt', 'failureCode', 'restoredSha256'])
    && commonAttempt(value, backup, attemptId, 'failed-restored') && validTime(value.completedAt)
    && later(value.attemptedAt, value.completedAt) && typeof value.failureCode === 'string' && value.failureCode.length > 0
    && value.restoredSha256 === backup.files[0].sha256;
}

function validMigration(value, backup, attemptId) {
  return exactKeys(value, ['schemaVersion', 'attemptId', 'previewHash', 'diffIdentity', 'fromVersion', 'toVersion', 'attemptedAt', 'outcome', 'completedAt', 'appliedAt'])
    && commonAttempt(value, backup, attemptId, 'applied') && validTime(value.appliedAt) && validTime(value.completedAt)
    && later(value.attemptedAt, value.appliedAt) && later(value.appliedAt, value.completedAt);
}

function problem(code, path, message) { return Object.freeze({ code, path, message }); }

async function verifyEntry(projectRoot, archiveRoot, name, { allowEmpty = false } = {}) {
  const entryPath = `archive/core-upgrades/${name}`;
  const base = join(archiveRoot, name);
  await assertDirectoryChain(projectRoot, base, entryPath);
  const entryNames = (await readdir(base)).sort((a, b) => a.localeCompare(b, 'en'));
  const stageNames = entryNames.filter(child => ABANDONED_STAGE.test(child));
  const unexpected = entryNames.find(child => !['PROJECT.md.bak', 'attempts', 'backup.json', 'migration.json'].includes(child) && !ABANDONED_STAGE.test(child));
  if (unexpected) {
    throw new Error(`unexpected upgrade archive authority: ${unexpected}`);
  }
  if (stageNames.length > 1) throw new Error('more than one abandoned migration stage is not valid authority');
  const backup = await readJson(projectRoot, join(base, 'backup.json'), `${entryPath}/backup.json`);
  if (!validBackup(backup)) throw new Error('backup.json has an invalid exact shape');
  const expectedName = `${new Date(backup.createdFromUpdated).toISOString().replace(/[-:.]/gu, '')}-${backup.fromVersion}-to-${backup.toVersion}-${backup.diffIdentity.slice(0, 12)}`;
  if (name !== expectedName || backup.backupPath !== entryPath) throw new Error('archive directory identity is not bound to backup receipt metadata');
  const backupBytes = await readRegular(projectRoot, join(base, 'PROJECT.md.bak'), `${entryPath}/PROJECT.md.bak`);
  if (sha(backupBytes) !== backup.files[0].sha256) throw new Error('PROJECT.md.bak hash differs from backup.json');
  let backupProject;
  try { backupProject = parseMarkdownDocument(backupBytes.toString('utf8'), `${entryPath}/PROJECT.md.bak`).attributes; }
  catch (error) { throw new Error(`PROJECT.md.bak is not a valid Project document: ${error.message}`); }
  if (backupProject.core_version !== backup.fromVersion || backupProject.updated !== backup.createdFromUpdated) {
    throw new Error('PROJECT.md.bak pre-state does not match backup fromVersion/createdFromUpdated');
  }
  const attemptsPath = join(base, 'attempts');
  await assertDirectoryChain(projectRoot, attemptsPath, `${entryPath}/attempts`);
  const children = (await readdir(attemptsPath)).sort((a, b) => a.localeCompare(b, 'en'));
  const records = new Map();
  for (const child of children) {
    const match = child.match(/^(attempt-\d{3})\.(attempted|pending|failed-restored)\.json$/u);
    if (!match) throw new Error(`unexpected attempt authority: ${child}`);
    const list = records.get(match[1]) ?? [];
    list.push({ state: match[2], name: child, value: await readJson(projectRoot, join(attemptsPath, child), `${entryPath}/attempts/${child}`) });
    records.set(match[1], list);
  }
  const migrationPath = join(base, 'migration.json');
  const migrationPresent = entryNames.includes('migration.json');
  const migration = migrationPresent ? await readJson(projectRoot, migrationPath, `${entryPath}/migration.json`) : null;
  const stageName = stageNames[0] ?? null;
  const stageMatch = stageName?.match(ABANDONED_STAGE) ?? null;
  const stage = stageName ? await readJson(projectRoot, join(base, stageName), `${entryPath}/${stageName}`) : null;
  if (children.length === 0) {
    if (migrationPresent || stage) throw new Error('migration authority requires a bound attempted authority');
    return Object.freeze({ entryPath, backup, backupProject, attempts: Object.freeze([]), migration: null, abandonedStage: null, incomplete: !allowEmpty, empty: true, warnings: Object.freeze([]) });
  }

  const ids = [...records.keys()].sort((a, b) => a.localeCompare(b, 'en'));
  for (const [index, id] of ids.entries()) {
    if (id !== `attempt-${String(index + 1).padStart(3, '0')}`) throw new Error('attempt sequence must start at attempt-001 and remain contiguous');
  }
  const attempts = [];
  const warnings = [];
  let previousCompletedAt = backup.createdFromUpdated;
  let incomplete = false;
  for (const [index, id] of ids.entries()) {
    const list = records.get(id);
    const attemptedRecords = list.filter(item => ['attempted', 'pending'].includes(item.state));
    const failures = list.filter(item => item.state === 'failed-restored');
    if (attemptedRecords.length !== 1 || attemptedRecords[0].state === 'pending' && list.length !== 1) throw new Error(`attempt ${id} has invalid attempted authority`);
    const attempted = attemptedRecords[0].value;
    if (!validAttempted(attempted, backup, id)) throw new Error(`attempt ${id} attempted receipt is invalid`);
    if (!later(previousCompletedAt, attempted.attemptedAt)) throw new Error(`attempt ${id} timestamp is not strictly ordered`);
    const isApplied = migration?.attemptId === id;
    if (attemptedRecords[0].state === 'pending' || (!isApplied && failures.length === 0)) {
      if (index !== ids.length - 1 || list.length !== 1 || migration) throw new Error(`incomplete attempt ${id} is not the sole latest terminal candidate`);
      incomplete = true;
      attempts.push(Object.freeze({ id, attempted, terminal: null }));
      continue;
    }
    if (isApplied) {
      if (failures.length !== 0 || list.length !== 1 || index !== ids.length - 1 || !validMigration(migration, backup, id)
        || migration.attemptedAt !== attempted.attemptedAt) throw new Error(`attempt ${id} applied lifecycle is invalid`);
      previousCompletedAt = migration.completedAt;
      attempts.push(Object.freeze({ id, attempted, terminal: migration }));
      continue;
    }
    if (failures.length !== 1 || list.length !== 2 || !validFailure(failures[0].value, backup, id)
      || failures[0].value.attemptedAt !== attempted.attemptedAt) throw new Error(`attempt ${id} failed lifecycle is invalid`);
    previousCompletedAt = failures[0].value.completedAt;
    attempts.push(Object.freeze({ id, attempted, terminal: failures[0].value }));
    warnings.push(problem('CORE_UPGRADE_FAILED_RESTORED', `${entryPath}/attempts/${failures[0].name}`, `Upgrade ${id} failed and restored the original PROJECT.md bytes.`));
  }
  if (migration && !attempts.some(attempt => attempt.terminal === migration)) throw new Error('migration.json is not bound to the latest contiguous attempt');
  let abandonedStage = null;
  if (stage) {
    const stageAttemptId = stageMatch[1];
    const latestAttempt = attempts.at(-1);
    if (migration || latestAttempt?.id !== stageAttemptId || !validMigration(stage, backup, stageAttemptId)
      || stage.attemptedAt !== latestAttempt.attempted.attemptedAt || latestAttempt.terminal?.outcome !== 'failed-restored') {
      throw new Error('abandoned migration stage is not an exact unpublished terminal for the latest attempt');
    }
    incomplete = true;
    abandonedStage = Object.freeze({ path: `${entryPath}/${stageName}`, receipt: stage });
  }
  return Object.freeze({ entryPath, backup, backupProject, attempts: Object.freeze(attempts), migration, abandonedStage, incomplete, empty: false, warnings: Object.freeze(warnings), attemptEvidence: Object.freeze(children.map(child => `${entryPath}/attempts/${child}`)) });
}

/** Verify every Core-upgrade archive with one exact parser shared by apply and Doctor. */
export async function verifyUpgradeArchives(projectPath, { checkProjectState = true, allowEmptyEntryPath = null } = {}) {
  let projectRoot;
  try { projectRoot = await realpath(projectPath); }
  catch (error) {
    return Object.freeze({ exists: true, archives: Object.freeze([]), problems: Object.freeze([problem('CORE_BACKUP_INVALID', 'archive/core-upgrades', `Project root cannot be resolved: ${error.message}`)]), warnings: Object.freeze([]), evidence: Object.freeze([]) });
  }
  const archiveRoot = join(projectRoot, 'archive', 'core-upgrades');
  try { await assertDirectoryChain(projectRoot, archiveRoot, 'archive/core-upgrades'); }
  catch (error) {
    if (error.code === 'ENOENT') return Object.freeze({ exists: false, archives: Object.freeze([]), problems: Object.freeze([]), warnings: Object.freeze([]), evidence: Object.freeze([]) });
    return Object.freeze({ exists: true, archives: Object.freeze([]), problems: Object.freeze([problem('CORE_BACKUP_INVALID', 'archive/core-upgrades', error.message)]), warnings: Object.freeze([]), evidence: Object.freeze([]) });
  }
  let names;
  try { names = (await readdir(archiveRoot)).sort((a, b) => a.localeCompare(b, 'en')); }
  catch (error) {
    return Object.freeze({ exists: true, archives: Object.freeze([]), problems: Object.freeze([problem('CORE_BACKUP_INVALID', 'archive/core-upgrades', `Upgrade archive cannot be read: ${error.message}`)]), warnings: Object.freeze([]), evidence: Object.freeze([]) });
  }
  const archives = [];
  const problems = [];
  const warnings = [];
  const evidence = [];
  for (const name of names) {
    const entryPath = `archive/core-upgrades/${name}`;
    try {
      const archive = await verifyEntry(projectRoot, archiveRoot, name, { allowEmpty: allowEmptyEntryPath === entryPath });
      archives.push(archive);
      warnings.push(...archive.warnings);
      evidence.push(`${entryPath}/backup.json`, `${entryPath}/PROJECT.md.bak`, `${entryPath}/attempts`);
      evidence.push(...(archive.attemptEvidence ?? []));
      if (archive.migration) evidence.push(`${entryPath}/migration.json`);
      if (archive.abandonedStage) evidence.push(archive.abandonedStage.path);
      if (archive.incomplete) {
        problems.push(archive.abandonedStage
          ? problem('CORE_UPGRADE_INCOMPLETE', archive.abandonedStage.path, 'Verified migration stage was never published as applied authority; its failed-restored receipt remains truthful, but the exact residue requires explicit manual cleanup before retry.')
          : problem('CORE_UPGRADE_INCOMPLETE', `${entryPath}/attempts`, 'Upgrade attempt has no terminal outcome.'));
      }
    } catch (error) {
      problems.push(problem('CORE_BACKUP_INVALID', entryPath, error.message));
    }
  }
  if (checkProjectState && problems.every(item => item.code !== 'CORE_BACKUP_INVALID')) {
    const applied = archives.filter(archive => archive.migration).sort((a, b) => Date.parse(a.migration.completedAt) - Date.parse(b.migration.completedAt));
    for (let index = 1; index < applied.length; index += 1) {
      if (applied[index].backup.fromVersion !== applied[index - 1].backup.toVersion
        || applied[index].backup.createdFromUpdated !== applied[index - 1].migration.appliedAt
        || !later(applied[index - 1].migration.completedAt, applied[index].migration.attemptedAt)) {
        problems.push(problem('CORE_BACKUP_INVALID', applied[index].entryPath, 'applied archive pre-state is not an explicit ordered successor of prior applied history'));
      }
    }
    if (applied.length > 0) {
      const latest = applied.at(-1);
      try {
        const project = parseMarkdownDocument((await readRegular(projectRoot, join(projectRoot, 'PROJECT.md'), 'PROJECT.md')).toString('utf8'), 'PROJECT.md').attributes;
        if (project.core_version !== latest.migration.toVersion || project.updated !== latest.migration.appliedAt) {
          problems.push(problem('CORE_UPGRADE_STATE_MISMATCH', 'PROJECT.md', 'Current PROJECT core_version/updated does not match the latest applied Core migration.'));
        }
      } catch (error) {
        problems.push(problem('CORE_UPGRADE_STATE_MISMATCH', 'PROJECT.md', error.message));
      }
    }
    for (const archive of archives.filter(item => item.abandonedStage)) {
      try {
        const projectBytes = await readRegular(projectRoot, join(projectRoot, 'PROJECT.md'), 'PROJECT.md');
        if (sha(projectBytes) !== archive.backup.files[0].sha256) {
          problems.push(problem('CORE_UPGRADE_STATE_MISMATCH', 'PROJECT.md', `Current PROJECT bytes do not match the failed-restored pre-state bound to ${archive.abandonedStage.path}.`));
        }
      } catch (error) {
        problems.push(problem('CORE_UPGRADE_STATE_MISMATCH', 'PROJECT.md', error.message));
      }
    }
  }
  return Object.freeze({ exists: true, archives: Object.freeze(archives), problems: Object.freeze(problems), warnings: Object.freeze(warnings), evidence: Object.freeze(evidence.sort((a, b) => a.localeCompare(b, 'en'))) });
}
