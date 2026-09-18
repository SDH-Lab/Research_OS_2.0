import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResearchOSError } from '../lib/errors.js';
import { parseMarkdownDocument } from '../lib/markdown.js';

export const RESEARCH_OS_SKILL_NAME = 'research-os';
export const packagedSkillRoot = fileURLToPath(
  new URL('../../skills/research-os/', import.meta.url)
);
const REQUIRED_FILES = Object.freeze([
  'agents/openai.yaml',
  'references/setup-handshake.md',
  'references/startup-contract.md',
  'references/task-routing.md',
  'SKILL.md'
]);

function frozenIssue(code, path, message) {
  return Object.freeze({ code, path, message });
}

function treeError(message) {
  return new ResearchOSError('SKILL_TREE_INVALID', message);
}

function resolvedSkillsRoot(skillsRoot) {
  if (typeof skillsRoot !== 'string' || skillsRoot.trim().length === 0 || /[\0\r\n\u2028\u2029]/u.test(skillsRoot)) {
    throw new ResearchOSError('USAGE', 'skillsRoot must be a non-empty single-line path');
  }
  return resolve(skillsRoot);
}

function isOutside(root, path) {
  const fromRoot = relative(root, path);
  return fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot);
}

async function regularFiles(root) {
  const resolvedRoot = resolve(root);
  let rootStats;
  try {
    rootStats = await lstat(resolvedRoot);
  } catch (error) {
    throw treeError(`Skill root is unavailable: ${resolvedRoot}: ${error.message}`);
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw treeError(`Skill root must be a regular non-symlink directory: ${resolvedRoot}`);
  }

  const files = [];
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (isOutside(resolvedRoot, path)) throw treeError(`Skill path escapes its root: ${path}`);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) throw treeError(`Skill tree contains a symbolic link: ${relative(resolvedRoot, path)}`);
      if (stats.isDirectory()) await visit(path);
      else if (stats.isFile()) files.push(relative(resolvedRoot, path).split('\\').join('/'));
      else throw treeError(`Skill tree contains a non-regular entry: ${relative(resolvedRoot, path)}`);
    }
  }
  await visit(resolvedRoot);
  return files.sort((left, right) => left.localeCompare(right, 'en'));
}

function lengthPrefix(length) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(length));
  return buffer;
}

async function digestTree(root) {
  const files = await regularFiles(root);
  const hash = createHash('sha256');
  for (const relativePath of files) {
    const pathBytes = Buffer.from(relativePath, 'utf8');
    const fileBytes = await readFile(join(root, relativePath));
    hash.update(lengthPrefix(pathBytes.length));
    hash.update(pathBytes);
    hash.update(lengthPrefix(fileBytes.length));
    hash.update(fileBytes);
  }
  return Object.freeze({ digest: hash.digest('hex'), files: Object.freeze(files) });
}

async function assertSkillContract(root, tree) {
  if (tree.files.length !== REQUIRED_FILES.length || tree.files.some((path, index) => path !== REQUIRED_FILES[index])) {
    throw new ResearchOSError('SKILL_CONTRACT_INVALID', `Skill file inventory must be exactly: ${REQUIRED_FILES.join(', ')}`);
  }
  let document;
  try {
    document = parseMarkdownDocument(await readFile(join(root, 'SKILL.md'), 'utf8'), 'SKILL.md');
  } catch (error) {
    throw new ResearchOSError('SKILL_CONTRACT_INVALID', `SKILL.md frontmatter is invalid: ${error.message}`);
  }
  const keys = Object.keys(document.attributes).sort((left, right) => left.localeCompare(right, 'en'));
  if (keys.length !== 2 || keys[0] !== 'description' || keys[1] !== 'name'
      || document.attributes.name !== RESEARCH_OS_SKILL_NAME
      || typeof document.attributes.description !== 'string'
      || document.attributes.description.trim().length === 0) {
    throw new ResearchOSError('SKILL_CONTRACT_INVALID', 'SKILL.md frontmatter must contain only the research-os name and a non-empty description.');
  }
}

async function validatedTree(root) {
  const tree = await digestTree(root);
  await assertSkillContract(root, tree);
  return tree;
}

function verificationReport({ ok, status, skillRoot, packagedDigest, installedDigest, issues }) {
  return Object.freeze({
    ok,
    status,
    skillRoot,
    packagedDigest,
    installedDigest,
    issues: Object.freeze(issues)
  });
}

export async function verifyResearchOsSkill({ skillsRoot }) {
  const targetRoot = resolvedSkillsRoot(skillsRoot);
  const skillRoot = join(targetRoot, RESEARCH_OS_SKILL_NAME);
  const packaged = await validatedTree(packagedSkillRoot);

  try {
    await lstat(skillRoot);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return verificationReport({
        ok: false, status: 'invalid', skillRoot, packagedDigest: packaged.digest, installedDigest: null,
        issues: [frozenIssue('SKILL_TREE_INVALID', skillRoot, `Installed Skill cannot be inspected: ${error.message}`)]
      });
    }
    return verificationReport({
      ok: false, status: 'missing', skillRoot, packagedDigest: packaged.digest, installedDigest: null,
      issues: [frozenIssue('SKILL_MISSING', skillRoot, 'Research OS Skill is not installed.')]
    });
  }

  let installed;
  try {
    installed = await validatedTree(skillRoot);
  } catch (error) {
    const code = error?.code === 'SKILL_CONTRACT_INVALID' ? 'SKILL_STRUCTURE_INVALID' : 'SKILL_TREE_INVALID';
    return verificationReport({
      ok: false, status: 'invalid', skillRoot, packagedDigest: packaged.digest, installedDigest: null,
      issues: [frozenIssue(code, skillRoot, error.message)]
    });
  }
  if (installed.digest !== packaged.digest) {
    return verificationReport({
      ok: false, status: 'mismatch', skillRoot, packagedDigest: packaged.digest, installedDigest: installed.digest,
      issues: [frozenIssue('SKILL_DIGEST_MISMATCH', skillRoot, 'Installed Research OS Skill differs from the packaged Skill.')]
    });
  }
  return verificationReport({
    ok: true, status: 'current', skillRoot, packagedDigest: packaged.digest, installedDigest: installed.digest, issues: []
  });
}

async function assertInstallRoot(skillsRoot) {
  await mkdir(skillsRoot, { recursive: true });
  const stats = await lstat(skillsRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ResearchOSError('CONFLICT', `Skills root must be a regular non-symlink directory: ${skillsRoot}`);
  }
}

async function copyPackagedSkill(stagingRoot, source) {
  await mkdir(stagingRoot);
  for (const relativePath of source.files) {
    const destination = join(stagingRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(packagedSkillRoot, relativePath), destination, constants.COPYFILE_EXCL);
  }
  const staged = await digestTree(stagingRoot);
  if (staged.digest !== source.digest) throw treeError('Staged Skill digest differs from the packaged source.');
}

export async function installResearchOsSkill({ skillsRoot }) {
  const targetRoot = resolvedSkillsRoot(skillsRoot);
  const initial = await verifyResearchOsSkill({ skillsRoot: targetRoot });
  if (initial.ok) return Object.freeze({ status: 'current', skillRoot: initial.skillRoot, digest: initial.packagedDigest });
  if (initial.status !== 'missing') {
    throw new ResearchOSError('CONFLICT', `Existing Research OS Skill is ${initial.status}; review it before installation.`, initial);
  }

  await assertInstallRoot(targetRoot);
  const source = await validatedTree(packagedSkillRoot);
  const stagingRoot = join(targetRoot, `.research-os-install-${randomUUID()}`);
  let installed = false;
  try {
    await copyPackagedSkill(stagingRoot, source);
    try {
      await rename(stagingRoot, initial.skillRoot);
      installed = true;
    } catch (error) {
      const concurrent = await verifyResearchOsSkill({ skillsRoot: targetRoot });
      if (concurrent.ok) {
        return Object.freeze({ status: 'current', skillRoot: concurrent.skillRoot, digest: concurrent.packagedDigest });
      }
      if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) {
        throw new ResearchOSError('CONFLICT', 'Research OS Skill appeared during installation and does not match the packaged Skill.', concurrent);
      }
      throw error;
    }
    return Object.freeze({ status: 'installed', skillRoot: initial.skillRoot, digest: source.digest });
  } finally {
    if (!installed) await rm(stagingRoot, { recursive: true, force: true });
  }
}
