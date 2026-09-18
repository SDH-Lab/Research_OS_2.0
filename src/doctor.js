import { lstat, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadCore } from './core/catalog.js';
import { verifyUpgradeArchives } from './core/archive.js';
import { verifyDependencyLock } from './dependency-lock.js';
import { loadProject } from './project/project.js';
import { validateProject } from './validation/validator.js';
import { verifyGenerationSnapshot } from './views/generate.js';
import { safeJoin } from './lib/fs.js';
import { preflightDependencyLockRepair } from '../scripts/repair-dependency-lock.js';
import { verifyResearchOsSkill } from './skill/installation.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CORE_ROOT = fileURLToPath(new URL('../core/', import.meta.url));

function executable(command, argv) { return Object.freeze({ kind: 'executable', command, ...(argv === undefined ? {} : { argv: Object.freeze([...argv]) }) }); }
function diagnostic(command) { return Object.freeze({ kind: 'diagnostic', command }); }
function manual(instruction) { return Object.freeze({ kind: 'manual', instruction }); }
function issue(severity, code, path, message, recovery = null, relatedIds) {
  return Object.freeze({ severity, code, path, message, recovery, recoveryCommand: recovery?.command ?? null, ...(relatedIds === undefined ? {} : { relatedIds: Object.freeze([...relatedIds]) }) });
}
function check(id, status, issues = [], evidence = []) { return Object.freeze({ id, status, evidence: Object.freeze(evidence), issues: Object.freeze(issues) }); }
async function statOrNull(path) { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
async function dependencyRecovery(packageRoot, code) {
  const script = join(PACKAGE_ROOT, 'scripts', 'repair-dependency-lock.js');
  const argv = [process.execPath, script, '--package-root', packageRoot];
  try {
    await preflightDependencyLockRepair(packageRoot);
    return executable(argv.map(shellQuote).join(' '), argv);
  } catch {
    return code === 'DEPENDENCY_LOCK_UNSUPPORTED'
      ? manual('Use the supported exact-version npm v3 Research OS release package, or have a maintainer explicitly extend and verify the dependency contract; do not rewrite the lock by hand.')
      : manual('Inspect package.json and the installed hidden npm v3 lock, then reinstall this Research OS release from a trusted package source before rebuilding package-lock.json.');
  }
}

function skillIssue(item, skillsRoot) {
  const recovery = item.code === 'SKILL_MISSING'
    ? executable(`research-os skill install --target ${shellQuote(skillsRoot)}`)
    : manual('Inspect the installed Research OS Skill conflict, compare it with the packaged Skill, and preserve any local content before an explicit replacement; do not overwrite it automatically.');
  return issue('error', item.code, item.path, item.message, recovery);
}

async function skillInstallationCheck(skillsRoot) {
  try {
    const skill = await verifyResearchOsSkill({ skillsRoot });
    return check(
      'skill-installation',
      skill.ok ? 'pass' : 'fail',
      skill.ok ? [] : skill.issues.map(item => skillIssue(item, skillsRoot)),
      [`packaged=${skill.packagedDigest}`, `installed=${skill.installedDigest ?? 'missing'}`]
    );
  } catch (error) {
    return check('skill-installation', 'fail', [issue(
      'error', 'SKILL_VERIFICATION_FAILED', skillsRoot, error.message,
      manual('Inspect the packaged and installed Skill trees and restore this Research OS release from a trusted source.')
    )], ['packaged=unavailable', 'installed=unavailable']);
  }
}

/** Inspect the package lock used by the running Research OS installation. */
export async function inspectDependencyLock(packageRoot = PACKAGE_ROOT) {
  const path = 'package-lock.json';
  try {
    const root = await realpath(packageRoot);
    const packagePath = join(root, 'package.json');
    const lockPath = join(root, path);
    const [packageStat, lockStat] = await Promise.all([lstat(packagePath), lstat(lockPath)]);
    if (!packageStat.isFile() || packageStat.isSymbolicLink() || !lockStat.isFile() || lockStat.isSymbolicLink()) throw new Error('package.json and package-lock.json must be regular non-symlink files');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const verified = verifyDependencyLock(packageJson, lock);
    return check('dependency-lock', 'pass', [], [path, 'contract=exact-version-npm-v3', `lockfileVersion=${verified.lockfileVersion}`, `packages=${verified.packageCount}`]);
  } catch (error) {
    const code = error.code === 'ENOENT' ? 'DEPENDENCY_LOCK_MISSING'
      : error.code === 'DEPENDENCY_LOCK_UNSUPPORTED' ? 'DEPENDENCY_LOCK_UNSUPPORTED' : 'DEPENDENCY_LOCK_INVALID';
    return check('dependency-lock', 'fail', [issue('error', code, path, error.message, await dependencyRecovery(packageRoot, code))], [path]);
  }
}

function generatedRecovery(code, unsafe = false) {
  return unsafe || code === 'GENERATED_VIEW_UNSAFE'
    ? manual('Quarantine the non-regular or symlinked generated path after human inspection, then run research-os view build --project .')
    : executable('research-os view build --project .');
}

async function generatedCheck(projectRoot) {
  const manifestRelative = 'generated/generation-manifest.json';
  let manifestPath;
  try { manifestPath = safeJoin(projectRoot, manifestRelative); }
  catch (error) { return check('generated-views', 'fail', [issue('error', 'GENERATED_VIEW_INVALID', manifestRelative, error.message, generatedRecovery('GENERATED_VIEW_INVALID', true))]); }
  const manifestStat = await statOrNull(manifestPath).catch(error => ({ error }));
  if (manifestStat === null) return check('generated-views', 'not_applicable', [], [`${manifestRelative} is absent; generated views are optional`]);
  if (manifestStat?.error) return check('generated-views', 'fail', [issue('error', 'GENERATED_VIEW_INVALID', manifestRelative, manifestStat.error.message, generatedRecovery('GENERATED_VIEW_INVALID', true))]);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) return check('generated-views', 'fail', [issue('error', 'GENERATED_VIEW_INVALID', manifestRelative, 'Generation manifest must be a regular non-symlink file.', generatedRecovery('GENERATED_VIEW_INVALID', true))]);
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch (error) { return check('generated-views', 'fail', [issue('error', 'GENERATED_VIEW_INVALID', manifestRelative, error.message, generatedRecovery('GENERATED_VIEW_INVALID'))], [manifestRelative]); }
  let report;
  try { report = await verifyGenerationSnapshot(projectRoot, manifest); }
  catch (error) { return check('generated-views', 'fail', [issue('error', 'GENERATED_VIEW_INVALID', manifestRelative, error.message, generatedRecovery('GENERATED_VIEW_INVALID'))], [manifestRelative]); }
  const issues = report.issues.map(item => issue(item.code === 'GENERATED_VIEW_STALE' ? 'warning' : 'error', item.code, item.path, item.message, generatedRecovery(item.code, item.unsafe === true)));
  return check('generated-views', issues.length ? 'fail' : 'pass', issues, [manifestRelative]);
}

async function upgradeBackupCheck(projectRoot) {
  const recovery = manual('Inspect and restore archive/core-upgrades from a trusted backup; do not follow or replace symlinked audit authority automatically.');
  let report;
  try { report = await verifyUpgradeArchives(projectRoot); }
  catch (error) { return check('core-upgrade-backups', 'fail', [issue('error', 'CORE_BACKUP_INVALID', 'archive/core-upgrades', error.message, recovery)]); }
  if (!report.exists) return check('core-upgrade-backups', 'not_applicable', [], ['archive/core-upgrades is absent']);
  if (report.archives.length === 0 && report.problems.length === 0) return check('core-upgrade-backups', 'not_applicable', [], ['archive/core-upgrades is empty']);
  const issues = [
    ...report.problems.map(item => issue('error', item.code, item.path, item.message, recovery)),
    ...report.warnings.map(item => issue('warning', item.code, item.path, item.message, diagnostic('research-os doctor --project .')))
  ];
  return check('core-upgrade-backups', report.problems.length ? 'fail' : report.warnings.length ? 'warning' : 'pass', issues, report.evidence);
}

/** Run deterministic, read-only environment and project diagnostics. */
export async function runDoctor(projectRoot, options = {}) {
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const skillsRoot = options.skillsRoot
    ?? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills');
  const checks = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push(check('node-version', major >= 20 ? 'pass' : 'fail', major >= 20 ? [] : [issue('error', 'NODE_VERSION_UNSUPPORTED', 'process.version', `Node ${process.version} is below 20.`, manual('Install Node.js 20 or newer.'))], [process.version]));
  checks.push(await inspectDependencyLock(packageRoot));
  checks.push(await skillInstallationCheck(skillsRoot));
  let project;
  let runtime;
  try { project = await loadProject(projectRoot); runtime = await loadCore(CORE_ROOT); } catch (error) {
    checks.push(check('core-version', 'fail', [issue('error', 'PROJECT_OR_CORE_UNREADABLE', 'PROJECT.md', error.message, diagnostic('research-os record validate --project .'))]));
  }
  if (project && runtime) {
    const mismatch = project.core_version !== runtime.version;
    checks.push(check('core-version', mismatch ? 'fail' : 'pass', mismatch ? [issue('error', 'CORE_VERSION_MISMATCH', 'PROJECT.md#/core_version', `Project pins ${project.core_version}; running Core is ${runtime.version}.`, manual('Run an explicit Core upgrade with a reviewed matching candidate, or use the matching Research OS release.'))] : [], [`project=${project.core_version}`, `runtime=${runtime.version}`]));
  }
  checks.push(await upgradeBackupCheck(projectRoot));
  let validation;
  try { validation = await validateProject(projectRoot); } catch (error) { validation = { ok: false, issues: [{ severity: 'error', code: 'PROJECT_VALIDATION_CRASH', path: 'PROJECT.md', message: error.message }] }; }
  const authorityIssues = validation.issues.map(item => issue(item.severity ?? 'error', item.code, item.path, item.message, diagnostic('research-os record validate --project .'), item.relatedIds));
  checks.push(check('project-authority', validation.ok ? 'pass' : 'fail', authorityIssues, [`checkedFiles=${validation.checkedFiles ?? 0}`]));
  checks.push(await generatedCheck(projectRoot));
  checks.push(check('waiver-expiry', 'not_applicable', [], ['v1 persists no waiver registry; Official Gate revalidates each ephemeral waiver on authorization']));
  const guidePath = join(packageRoot, 'docs', 'user-guide', 'README.md');
  let guideIssue = [];
  try {
    const guideStat = await lstat(guidePath);
    if (!guideStat.isFile() || guideStat.isSymbolicLink()) throw new Error('Guide README must be a regular non-symlink file');
    const guide = await readFile(guidePath, 'utf8');
    const match = guide.match(/^core_version:\s*([^\s]+)$/mu);
    if (!match || !runtime || match[1] !== runtime.version) guideIssue = [issue('error', 'GUIDE_CORE_VERSION_MISMATCH', 'docs/user-guide/README.md', 'Guide core_version does not match the running Core.', diagnostic('npm run check:docs'))];
  } catch (error) { guideIssue = [issue('error', 'GUIDE_MISSING', 'docs/user-guide/README.md', error.message, diagnostic('npm run check:docs'))]; }
  checks.push(check('guide-core-version', guideIssue.length ? 'fail' : 'pass', guideIssue, ['docs/user-guide/README.md', 'core/VERSION']));
  const issues = Object.freeze(checks.flatMap(item => item.issues));
  return Object.freeze({ ok: issues.every(item => item.severity !== 'error'), environment: Object.freeze({ node: process.version, platform: process.platform }), checks: Object.freeze(checks), issues });
}
