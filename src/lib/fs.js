import { lstatSync } from 'node:fs';
import { readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { ResearchOSError } from './errors.js';

function outsideRoot(root, target) {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === '..' || pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(pathFromRoot);
}

function hasSymlinkComponent(root, target) {
  const components = relative(root, target).split(process.platform === 'win32' ? '\\' : '/').filter(Boolean);
  let current = root;
  for (const component of components) {
    current = resolve(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  return false;
}

export function safeJoin(root, relativePath) {
  if (typeof relativePath !== 'string' || isAbsolute(relativePath)) {
    throw new ResearchOSError('PATH_OUTSIDE_ROOT', `Path must be relative to root: ${relativePath}`);
  }
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, relativePath);
  if (outsideRoot(resolvedRoot, target)) {
    throw new ResearchOSError('PATH_OUTSIDE_ROOT', `Path is outside root: ${relativePath}`);
  }
  if (hasSymlinkComponent(resolvedRoot, target)) {
    throw new ResearchOSError('PATH_OUTSIDE_ROOT', `Path traverses a symbolic link: ${relativePath}`);
  }
  return target;
}

export async function readUtf8(path) {
  return readFile(path, 'utf8');
}

export async function writeUtf8Atomic(path, text) {
  const temporaryPath = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, text, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(cleanupError => {
      if (cleanupError.code !== 'ENOENT') throw cleanupError;
    });
    throw error;
  }
}

export async function walkFiles(root) {
  const resolvedRoot = resolve(root);
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) files.push(relative(resolvedRoot, fullPath).split(process.platform === 'win32' ? '\\' : '/').join('/'));
    }
  }

  await visit(resolvedRoot);
  return files.sort((left, right) => left.localeCompare(right, 'en'));
}
