import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResearchOSError } from './lib/errors.js';
import { packagedSkillRoot } from './skill/installation.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));

async function assertRegularFile(path, label) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    throw new ResearchOSError('IO', `${label} is unavailable: ${error.message}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new ResearchOSError('IO', `${label} must be a regular non-symlink file: ${path}`);
  }
}

export async function locateGuide() {
  const versionPath = join(PACKAGE_ROOT, 'core', 'VERSION');
  const guideIndex = join(PACKAGE_ROOT, 'docs', 'user-guide', 'README.md');
  await Promise.all([
    assertRegularFile(versionPath, 'Core version file'),
    assertRegularFile(guideIndex, 'User guide index')
  ]);
  const coreVersion = (await readFile(versionPath, 'utf8')).trim();
  return Object.freeze({ coreVersion, guideIndex, packagedSkillRoot });
}
