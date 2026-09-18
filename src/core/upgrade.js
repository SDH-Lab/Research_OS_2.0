import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative } from 'node:path';
import Ajv from 'ajv';
import { loadCore } from './catalog.js';
import { verifyUpgradeArchives } from './archive.js';
import { ResearchOSError } from '../lib/errors.js';
import { safeJoin, walkFiles, writeUtf8Atomic } from '../lib/fs.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../lib/markdown.js';
import { loadProject } from '../project/project.js';
import { discoverRecordCandidates } from '../records/catalog.js';
import { isValidDate, isValidDateTime } from '../validation/validator.js';
import { validateProject } from '../validation/validator.js';

const RUNTIME_CORE_ROOT = fileURLToPath(new URL('../../core/', import.meta.url));
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SCHEMA_BY_TYPE = Object.freeze({ exec_plan: 'exec-plan', risk: 'incident' });
const BASE_SCHEMA = Object.freeze({
  $id: 'record-base', type: 'object',
  required: ['schema_version', 'type', 'id', 'status', 'created', 'updated', 'status_history'],
  properties: {
    schema_version: { const: 1 }, type: { type: 'string' }, id: { type: 'string', pattern: '^[A-Z]+-[0-9]{3,}$' },
    status: { enum: ['inbox', 'defined', 'ready', 'in_progress', 'review', 'verified', 'closed', 'reopened'] },
    created: { type: 'string', format: 'date-time' }, updated: { type: 'string', format: 'date-time' }, status_history: { type: 'array' }
  }
});

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort((a, b) => a.localeCompare(b, 'en')).map(key => [key, stable(value[key])]));
  return value;
}
function stableJson(value) { return JSON.stringify(stable(value)); }

async function validateCandidatePackage(candidateCoreRoot) {
  let core;
  try { core = await loadCore(candidateCoreRoot); }
  catch (error) {
    if (error instanceof ResearchOSError && error.code === 'CORE_VERSION') throw error;
    if (error instanceof SyntaxError) throw new ResearchOSError('CORE_PACKAGE_INVALID', `Candidate Core contains malformed JSON: ${error.message}`);
    if (['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) throw new ResearchOSError('CORE_CANDIDATE_IO', `Candidate Core cannot be read: ${error.message}`);
    if (error instanceof ResearchOSError) throw error;
    throw new ResearchOSError('CORE_PACKAGE_INVALID', `Candidate Core cannot be loaded: ${error.message}`);
  }
  if (!SEMVER.test(core.version)) throw new ResearchOSError('CORE_VERSION', `Candidate Core VERSION is not semantic: ${core.version}`);
  const runtime = await loadCore(RUNTIME_CORE_ROOT);
  const expectedSchemas = Object.keys(runtime.schemas).sort();
  if (JSON.stringify(Object.keys(core.schemas).sort()) !== JSON.stringify(expectedSchemas)) {
    throw new ResearchOSError('CORE_PACKAGE_INVALID', 'Candidate Core must contain the exact registered schema catalog');
  }
  if (!core.transitions || !Array.isArray(core.transitions.statuses) || !core.transitions.transitions || typeof core.transitions.transitions !== 'object') {
    throw new ResearchOSError('CORE_PACKAGE_INVALID', 'Candidate Core status transitions are malformed');
  }
  const statuses = new Set(core.transitions.statuses);
  const transitionKeys = Object.keys(core.transitions.transitions);
  if (statuses.size !== core.transitions.statuses.length
    || [...statuses].some(status => typeof status !== 'string' || status.length === 0)
    || transitionKeys.length !== statuses.size
    || transitionKeys.some(status => !statuses.has(status))
    || [...statuses].some(status => !Object.hasOwn(core.transitions.transitions, status))
    || Object.entries(core.transitions.transitions).some(([, targets]) => !Array.isArray(targets) || new Set(targets).size !== targets.length || targets.some(target => !statuses.has(target)))) {
    throw new ResearchOSError('CORE_PACKAGE_INVALID', 'Candidate Core status transition graph is not closed over its unique status catalog');
  }
  if (JSON.stringify([...statuses].sort()) !== JSON.stringify([...runtime.transitions.statuses].sort())) {
    throw new ResearchOSError('CORE_MIGRATION_REQUIRED', 'Candidate Core changes the v1 lifecycle status catalog; an explicit lifecycle migration is required');
  }
  const conditions = core.transitions.conditions;
  if (!conditions || Array.isArray(conditions) || typeof conditions !== 'object') throw new ResearchOSError('CORE_PACKAGE_INVALID', 'Candidate Core transition conditions are malformed');
  for (const [edge, condition] of Object.entries(conditions)) {
    const parts = edge.split('->');
    if (parts.length !== 2 || !core.transitions.transitions[parts[0]]?.includes(parts[1])
      || !condition || Array.isArray(condition) || typeof condition !== 'object'
      || Object.keys(condition).sort().join(',') !== 'requires'
      || !Array.isArray(condition.requires) || new Set(condition.requires).size !== condition.requires.length
      || condition.requires.some(field => typeof field !== 'string' || field.length === 0)) {
      throw new ResearchOSError('CORE_PACKAGE_INVALID', `Candidate Core transition condition is invalid: ${edge}`);
    }
  }
  let candidateFiles;
  try { candidateFiles = new Set(await walkFiles(candidateCoreRoot)); }
  catch (error) { throw new ResearchOSError('CORE_CANDIDATE_IO', `Candidate Core inventory cannot be read: ${error.message}`); }
  const requiredFiles = (await walkFiles(RUNTIME_CORE_ROOT)).filter(path => path.startsWith('templates/') || ['rules/authority.md', 'rules/status-transitions.json'].includes(path));
  if (requiredFiles.some(path => !candidateFiles.has(path))) throw new ResearchOSError('CORE_PACKAGE_INVALID', 'Candidate Core is missing a registered template or rule');
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addFormat('date-time', { type: 'string', validate: isValidDateTime });
  ajv.addFormat('date', { type: 'string', validate: isValidDate });
  ajv.addSchema(BASE_SCHEMA);
  try { for (const [name, schema] of Object.entries(core.schemas)) ajv.addSchema(schema, name); }
  catch (error) { throw new ResearchOSError('CORE_PACKAGE_INVALID', `Candidate schema compilation failed: ${error.message}`); }
  return { core, ajv };
}

async function assertExternalCandidate(projectRoot, candidateCoreRoot) {
  let project;
  let candidate;
  try { [project, candidate] = await Promise.all([realpath(projectRoot), realpath(candidateCoreRoot)]); }
  catch (error) {
    throw new ResearchOSError('CORE_CANDIDATE_IO', `Candidate Core path cannot be resolved: ${error.message}`);
  }
  const fromProject = relative(project, candidate);
  if (fromProject === '' || (!fromProject.startsWith('..') && !isAbsolute(fromProject))) {
    throw new ResearchOSError('CANDIDATE_CORE_INSIDE_PROJECT', 'CANDIDATE_CORE_INSIDE_PROJECT: candidate Core must remain external to the Project Vault');
  }
}

function backupTimestamp(projectUpdated) {
  if (!isValidDateTime(projectUpdated)) throw new ResearchOSError('UPGRADE_VALIDATION_FAILED', 'PROJECT.updated must be a valid timestamp before upgrade');
  return new Date(projectUpdated).toISOString().replace(/[-:.]/gu, '');
}

async function writeBackupAuthority(path, bytes, mismatchCode) {
  try { await writeFile(path, bytes, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ResearchOSError(mismatchCode, `${mismatchCode}: existing backup authority is not a regular file`);
    if (!Buffer.from(await readFile(path)).equals(Buffer.from(bytes))) throw new ResearchOSError(mismatchCode, `${mismatchCode}: existing backup authority differs from the approved preview`);
  }
}

function exactTimestampAfter(value) {
  const previous = Date.parse(value);
  const now = Date.now();
  return new Date(Math.max(now, previous + 1)).toISOString();
}

async function fileInventory(root) {
  const files = (await walkFiles(root)).filter(path => path.startsWith('schemas/') || path.startsWith('templates/') || path.startsWith('rules/'));
  const inventory = new Map();
  for (const path of files) inventory.set(path, hash(await readFile(join(root, path))));
  return inventory;
}

async function candidateFileInventory(root) {
  try { return await fileInventory(root); }
  catch (error) {
    if (error instanceof ResearchOSError) throw error;
    throw new ResearchOSError('CORE_CANDIDATE_IO', `Candidate Core file inventory cannot be read: ${error.message}`);
  }
}

function categorizedChanges(current, candidate) {
  const output = { schemas: [], templates: [], rules: [] };
  const paths = [...new Set([...current.keys(), ...candidate.keys()])].sort((a, b) => a.localeCompare(b, 'en'));
  for (const path of paths) {
    const fromHash = current.get(path) ?? null;
    const toHash = candidate.get(path) ?? null;
    if (fromHash === toHash) continue;
    const category = path.startsWith('schemas/') ? 'schemas' : path.startsWith('templates/') ? 'templates' : 'rules';
    output[category].push(Object.freeze({ path, change: fromHash === null ? 'added' : toHash === null ? 'removed' : 'modified', fromHash, toHash }));
  }
  return Object.freeze(Object.fromEntries(Object.entries(output).map(([key, values]) => [key, Object.freeze(values)])));
}

/** Build a deterministic, read-only Core upgrade proposal. */
export async function previewCoreUpgrade(projectRoot, candidateCoreRoot) {
  await assertExternalCandidate(projectRoot, candidateCoreRoot);
  const project = await loadProject(projectRoot);
  const runtime = await loadCore(RUNTIME_CORE_ROOT);
  if (project.core_version !== runtime.version) {
    throw new ResearchOSError('CORE_VERSION_MISMATCH', `Project pins ${project.core_version}, but the running Core is ${runtime.version}`);
  }
  const { core: candidate } = await validateCandidatePackage(candidateCoreRoot);
  if (candidate.version === runtime.version) throw new ResearchOSError('CORE_VERSION', 'Candidate Core version must differ from the running Core');
  const changes = categorizedChanges(await fileInventory(RUNTIME_CORE_ROOT), await candidateFileInventory(candidateCoreRoot));
  const migrations = Object.freeze([Object.freeze({ id: 'project-core-version', path: 'PROJECT.md', field: 'core_version', from: runtime.version, to: candidate.version })]);
  const identity = hash(stableJson({ fromVersion: runtime.version, toVersion: candidate.version, changes, migrations }));
  const previewWithoutHash = Object.freeze({
    fromVersion: runtime.version,
    toVersion: candidate.version,
    changes,
    migrations,
    affectedProjectFiles: Object.freeze(['PROJECT.md']),
    backupPath: `archive/core-upgrades/${backupTimestamp(project.updated)}-${runtime.version}-to-${candidate.version}-${identity.slice(0, 12)}`
  });
  return Object.freeze({ ...previewWithoutHash, diffIdentity: identity, hash: hash(stableJson(previewWithoutHash)) });
}

async function validateWithCandidate(projectRoot, candidateCoreRoot) {
  const { core, ajv } = await validateCandidatePackage(candidateCoreRoot);
  const candidates = await discoverRecordCandidates(projectRoot);
  const issues = [];
  for (const candidate of candidates) {
    if (!candidate.document) {
      issues.push({ path: candidate.path, message: candidate.error?.message ?? 'Record cannot be parsed' });
      continue;
    }
    const attributes = candidate.document.attributes;
    const schemaName = SCHEMA_BY_TYPE[attributes.type] ?? attributes.type;
    const validate = ajv.getSchema(schemaName);
    if (!validate || !validate(attributes)) {
      issues.push({ path: candidate.path, message: validate ? ajv.errorsText(validate.errors) : `No candidate schema for ${String(attributes.type)}` });
    }
    if (!core.transitions.statuses.includes(attributes.status)) issues.push({ path: candidate.path, message: `Candidate Core does not register current status ${String(attributes.status)}` });
    if (!Array.isArray(attributes.status_history)) continue;
    for (const entry of attributes.status_history) {
      if (!core.transitions.transitions?.[entry?.from]?.includes(entry?.to)) issues.push({ path: candidate.path, message: `Candidate Core rejects transition ${entry?.from}->${entry?.to}` });
    }
  }
  return Object.freeze({ ok: issues.length === 0, checkedFiles: candidates.length, issues: Object.freeze(issues.map(Object.freeze)) });
}

function archiveFailure(report) {
  const found = report.problems.find(item => item.code === 'CORE_BACKUP_INVALID')
    ?? report.problems.find(item => item.code === 'CORE_UPGRADE_STATE_MISMATCH')
    ?? report.problems.find(item => item.code === 'CORE_UPGRADE_INCOMPLETE');
  if (!found) return null;
  const code = found.code === 'CORE_BACKUP_INVALID' && /backup\.json/u.test(found.message) && /ENOENT/u.test(found.message)
    ? 'CORE_BACKUP_RECEIPT_MISMATCH' : found.code;
  return new ResearchOSError(code, `${code}: ${found.message}`);
}

async function findAppliedUpgrade(projectRoot, candidateCoreRoot, approvedPreviewHash) {
  await assertExternalCandidate(projectRoot, candidateCoreRoot);
  const [{ core: candidate }, project] = await Promise.all([validateCandidatePackage(candidateCoreRoot), loadProject(projectRoot)]);
  const archives = await verifyUpgradeArchives(projectRoot);
  const failure = archiveFailure(archives);
  if (failure) throw failure;
  const match = archives.archives.find(item => item.migration?.previewHash === approvedPreviewHash && item.migration.toVersion === candidate.version);
  if (match && project.core_version === candidate.version && project.updated === match.migration.appliedAt) {
    const receipt = match.migration;
    return Object.freeze({
      fromVersion: receipt.fromVersion, toVersion: receipt.toVersion, previewHash: receipt.previewHash,
      backupPath: match.entryPath, validationReport: Object.freeze({ ok: true, checkedFiles: 0, issues: Object.freeze([]) }),
      appliedAt: receipt.appliedAt, attemptId: receipt.attemptId, outcome: receipt.outcome, alreadyApplied: true
    });
  }
  return null;
}

/** Apply only the exact approved v1 PROJECT metadata migration, with byte rollback. */
export async function applyCoreUpgrade(projectRoot, candidateCoreRoot, approvedPreviewHash, options = {}) {
  const invokeHook = async name => options.hooks?.[name]?.();
  const alreadyApplied = await findAppliedUpgrade(projectRoot, candidateCoreRoot, approvedPreviewHash);
  if (alreadyApplied) return alreadyApplied;
  const preview = await previewCoreUpgrade(projectRoot, candidateCoreRoot);
  if (preview.hash !== approvedPreviewHash) throw new ResearchOSError('UPGRADE_PREVIEW_MISMATCH', `UPGRADE_PREVIEW_MISMATCH: expected ${preview.hash}`);
  const currentReport = await validateProject(projectRoot);
  if (!currentReport.ok) throw new ResearchOSError('UPGRADE_VALIDATION_FAILED', 'Current project must validate before Core upgrade', currentReport.issues);
  const projectPath = safeJoin(projectRoot, 'PROJECT.md');
  const original = await readFile(projectPath);
  const backupDirectory = safeJoin(projectRoot, preview.backupPath);
  let archiveExisted = true;
  try { await lstat(backupDirectory); }
  catch (error) { if (error.code === 'ENOENT') archiveExisted = false; else throw error; }
  await mkdir(backupDirectory, { recursive: true });
  try {
    const migration = await lstat(join(backupDirectory, 'migration.json'));
    if (migration) throw new ResearchOSError('CORE_BACKUP_RECEIPT_MISMATCH', 'CORE_BACKUP_RECEIPT_MISMATCH: migration receipt exists before a verified attempt');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const backupProjectPath = join(backupDirectory, 'PROJECT.md.bak');
  const projectBefore = parseMarkdownDocument(original.toString('utf8'), 'PROJECT.md');
  const backupReceipt = {
    schemaVersion: 1,
    previewHash: preview.hash,
    diffIdentity: preview.diffIdentity,
    fromVersion: preview.fromVersion,
    toVersion: preview.toVersion,
    backupPath: preview.backupPath,
    createdFromUpdated: projectBefore.attributes.updated,
    files: [{ path: 'PROJECT.md', backup: 'PROJECT.md.bak', sha256: hash(original) }]
  };
  const receiptBytes = `${JSON.stringify(backupReceipt, null, 2)}\n`;
  await writeBackupAuthority(backupProjectPath, original, 'CORE_BACKUP_BYTES_MISMATCH');
  await writeBackupAuthority(join(backupDirectory, 'backup.json'), receiptBytes, 'CORE_BACKUP_RECEIPT_MISMATCH');
  const attemptsDirectory = join(backupDirectory, 'attempts');
  await mkdir(attemptsDirectory, { recursive: true });
  const attemptsStat = await lstat(attemptsDirectory);
  if (!attemptsStat.isDirectory() || attemptsStat.isSymbolicLink()) throw new ResearchOSError('CORE_BACKUP_INVALID', 'CORE_BACKUP_INVALID: attempts authority must be a real directory');
  const archiveReport = await verifyUpgradeArchives(projectRoot, { allowEmptyEntryPath: archiveExisted ? null : preview.backupPath });
  const archiveError = archiveFailure(archiveReport);
  if (archiveError) throw archiveError;
  const archive = archiveReport.archives.find(item => item.entryPath === preview.backupPath);
  if (!archive) throw new ResearchOSError('CORE_BACKUP_INVALID', 'CORE_BACKUP_INVALID: newly established archive cannot be verified');
  const attemptId = `attempt-${String(archive.attempts.length + 1).padStart(3, '0')}`;
  const globalCompletions = archiveReport.archives.flatMap(item => item.migration?.completedAt ? [item.migration.completedAt] : []);
  const previousTime = [projectBefore.attributes.updated, archive.attempts.at(-1)?.terminal?.completedAt, ...globalCompletions]
    .filter(Boolean).sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  const attemptedAt = exactTimestampAfter(previousTime);
  const attemptedPath = join(attemptsDirectory, `${attemptId}.attempted.json`);
  const attemptBase = {
    schemaVersion: 1, attemptId, previewHash: preview.hash, diffIdentity: preview.diffIdentity,
    fromVersion: preview.fromVersion, toVersion: preview.toVersion, attemptedAt
  };
  try {
    await invokeHook('beforeAttemptedPublish');
    await writeFile(attemptedPath, `${JSON.stringify({ ...attemptBase, outcome: 'attempted' }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    throw new ResearchOSError('CORE_UPGRADE_PUBLICATION_FAILED', `CORE_UPGRADE_PUBLICATION_FAILED: ${error.message}`);
  }
  const migrationPath = join(backupDirectory, 'migration.json');
  let stagePath = null;
  try {
    await invokeHook('afterAttempted');
    const appliedAt = exactTimestampAfter(attemptedAt);
    await invokeHook('beforeProjectWrite');
    await writeUtf8Atomic(projectPath, serializeMarkdownDocument({ ...projectBefore.attributes, core_version: preview.toVersion, updated: appliedAt }, projectBefore.body));
    await invokeHook('afterProjectWrite');
    const validationReport = await validateWithCandidate(projectRoot, candidateCoreRoot);
    if (!validationReport.ok) throw new ResearchOSError('UPGRADE_VALIDATION_FAILED', 'UPGRADE_VALIDATION_FAILED: candidate Core rejects the migrated project', validationReport.issues);
    await invokeHook('afterCandidateValidation');
    const completedAt = exactTimestampAfter(appliedAt);
    const terminal = { ...attemptBase, outcome: 'applied', completedAt, appliedAt };
    const result = Object.freeze({ fromVersion: preview.fromVersion, toVersion: preview.toVersion, previewHash: preview.hash, backupPath: preview.backupPath, validationReport, appliedAt, attemptId, outcome: 'applied' });
    stagePath = join(backupDirectory, `.migration-${attemptId}-${randomUUID()}.tmp`);
    await writeFile(stagePath, `${JSON.stringify(terminal, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await invokeHook('beforeMigrationPublish');
    await rename(stagePath, migrationPath);
    return result;
  } catch (error) {
    if (stagePath) await unlink(stagePath).catch(() => {});
    try {
      await writeUtf8Atomic(projectPath, original.toString('utf8'));
      const completedAt = exactTimestampAfter(attemptedAt);
      const failureCode = error instanceof ResearchOSError ? error.code : 'CORE_UPGRADE_PUBLICATION_FAILED';
      const failure = { ...attemptBase, outcome: 'failed-restored', completedAt, failureCode, restoredSha256: hash(original) };
      await writeFile(join(attemptsDirectory, `${attemptId}.failed-restored.json`), `${JSON.stringify(failure, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch (publicationError) {
      throw new ResearchOSError('CORE_UPGRADE_PUBLICATION_FAILED', `CORE_UPGRADE_PUBLICATION_FAILED: ${publicationError.message}`);
    }
    if (error instanceof ResearchOSError) throw error;
    throw new ResearchOSError('CORE_UPGRADE_PUBLICATION_FAILED', `CORE_UPGRADE_PUBLICATION_FAILED: ${error.message}`);
  }
}
