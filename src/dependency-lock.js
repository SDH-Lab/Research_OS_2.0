import { isAbsolute } from 'node:path';
import semver from 'semver';

const PACKAGE_PART = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*|@[A-Za-z0-9][A-Za-z0-9._-]*)$/u;
const SRI = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})(?:\?[A-Za-z0-9_-]+)?$/u;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort((a, b) => a.localeCompare(b, 'en')).map(key => [key, stable(value[key])]));
  return value;
}
function same(left, right) { return JSON.stringify(stable(left)) === JSON.stringify(stable(right)); }
function exactKeys(value, keys) {
  return value && !Array.isArray(value) && typeof value === 'object'
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function normalizeBin(value) {
  return Object.fromEntries(Object.entries(value ?? {}).map(([name, target]) => [name, String(target).replace(/^\.\//u, '')]));
}
function validPackageName(name) {
  if (typeof name !== 'string' || name === '' || name.includes('\\') || name.includes('%') || isAbsolute(name)) return false;
  const parts = name.split('/');
  return parts.length === 1 ? PACKAGE_PART.test(parts[0]) && !parts[0].startsWith('@')
    : parts.length === 2 && parts[0].startsWith('@') && PACKAGE_PART.test(parts[0]) && PACKAGE_PART.test(parts[1]) && !parts[1].startsWith('@');
}
function validPackageKey(key) {
  if (typeof key !== 'string' || key === '' || key.includes('\\') || key.includes('%') || isAbsolute(key)) return false;
  const parts = key.split('/');
  let index = 0;
  while (index < parts.length) {
    if (parts[index] !== 'node_modules') return false;
    index += 1;
    if (parts[index]?.startsWith('@')) {
      if (!PACKAGE_PART.test(parts[index]) || !PACKAGE_PART.test(parts[index + 1] ?? '') || parts[index + 1].startsWith('@')) return false;
      index += 2;
    } else {
      if (!PACKAGE_PART.test(parts[index] ?? '') || parts[index].startsWith('@')) return false;
      index += 1;
    }
  }
  return true;
}
function validResolved(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try { return ['https:', 'http:', 'file:', 'git+ssh:'].includes(new URL(value).protocol); }
  catch { return false; }
}
function validIntegrity(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const lengths = { sha256: 32, sha384: 48, sha512: 64 };
  return value.split(/\s+/u).every(token => {
    const match = token.match(SRI);
    if (!match) return false;
    const decoded = Buffer.from(match[2], 'base64');
    const canonical = decoded.toString('base64').replace(/=+$/u, '');
    return decoded.length === lengths[match[1]] && canonical === match[2].replace(/=+$/u, '');
  });
}
function packageNamePath(name) { return name.split('/').join('/'); }
function dependencyCandidates(fromKey, name) {
  const suffix = `node_modules/${packageNamePath(name)}`;
  const output = [];
  let base = fromKey;
  while (base !== '') {
    output.push(`${base}/${suffix}`);
    const marker = base.lastIndexOf('/node_modules/');
    base = marker === -1 ? '' : base.slice(0, marker);
  }
  output.push(suffix);
  return [...new Set(output)];
}
function dependencyMaps(entry) {
  return ['dependencies', 'optionalDependencies'].flatMap(field => {
    const value = entry[field];
    if (value === undefined) return [];
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${field} must be an object`);
    return Object.entries(value);
  });
}

export class DependencyLockUnsupportedError extends Error {
  constructor(message) {
    super(`UNSUPPORTED exact-version npm v3 contract: ${message}`);
    this.name = 'DependencyLockUnsupportedError';
    this.code = 'DEPENDENCY_LOCK_UNSUPPORTED';
  }
}

function exactDirectDependencies(packageJson) {
  const dependencies = {};
  for (const field of ['dependencies', 'optionalDependencies']) {
    const declarations = packageJson[field] ?? {};
    if (!declarations || Array.isArray(declarations) || typeof declarations !== 'object') throw new Error(`${field} must be an object`);
    for (const [name, requested] of Object.entries(declarations)) {
      if (Object.hasOwn(dependencies, name)) throw new DependencyLockUnsupportedError(`direct dependency ${name} is declared in both dependencies and optionalDependencies`);
      if (semver.valid(requested) !== requested) throw new DependencyLockUnsupportedError(`direct dependency ${name} must use an exact SemVer version, received ${requested}`);
      dependencies[name] = requested;
    }
  }
  return dependencies;
}

function assertEdgeSatisfies(fromKey, name, requested, target) {
  const range = semver.validRange(requested);
  if (range === null) throw new DependencyLockUnsupportedError(`dependency edge ${fromKey || '<root>'} -> ${name} uses a non-SemVer npm spec: ${requested}`);
  if (!semver.satisfies(target.version, range)) throw new Error(`dependency ${fromKey || '<root>'} -> ${name}@${target.version} does not satisfy ${requested}`);
}

/** Validate one package-lock candidate completely before it is trusted or published. */
export function verifyDependencyLock(packageJson, lock) {
  if (lock?.lockfileVersion !== 3) throw new DependencyLockUnsupportedError(`lockfileVersion ${String(lock?.lockfileVersion)} is not supported`);
  const directDependencies = exactDirectDependencies(packageJson);
  if (!exactKeys(lock, ['name', 'version', 'lockfileVersion', 'requires', 'packages'])
    || lock.requires !== true
    || lock.name !== packageJson.name || lock.version !== packageJson.version
    || !lock.packages || Array.isArray(lock.packages) || typeof lock.packages !== 'object') {
    throw new Error('lock top-level name/version/requires/shape is invalid');
  }
  const root = lock.packages[''];
  const rootKeys = ['name', 'version', 'dependencies', 'bin', 'engines'];
  if (packageJson.optionalDependencies !== undefined) rootKeys.push('optionalDependencies');
  if (!exactKeys(root, rootKeys)) throw new Error('lock root has an unsupported or incomplete shape');
  if (root.name !== packageJson.name || root.version !== packageJson.version
    || !same(root.dependencies ?? {}, packageJson.dependencies ?? {})
    || !same(root.optionalDependencies ?? {}, packageJson.optionalDependencies ?? {})
    || !same(normalizeBin(root.bin), normalizeBin(packageJson.bin))
    || !same(root.engines ?? {}, packageJson.engines ?? {})) throw new Error('lock root identity differs from package.json');

  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '') continue;
    if (!validPackageKey(key)) throw new Error(`unsafe package key: ${key}`);
    if (!entry || Array.isArray(entry) || typeof entry !== 'object' || semver.valid(entry.version ?? '') === null) throw new Error(`package ${key} has invalid semantic version`);
    if (!validResolved(entry.resolved)) throw new Error(`package ${key} has invalid resolved authority`);
    if (!validIntegrity(entry.integrity)) throw new Error(`package ${key} has invalid integrity/SRI authority`);
    for (const [name] of dependencyMaps(entry)) if (!validPackageName(name)) throw new Error(`package ${key} has unsafe dependency name: ${name}`);
  }

  const reachable = new Set();
  const queue = [{ key: '', entry: root }];
  while (queue.length > 0) {
    const { key, entry } = queue.shift();
    for (const [name, requested] of dependencyMaps(entry)) {
      if (!validPackageName(name)) throw new Error(`package ${key || '<root>'} has unsafe dependency name: ${name}`);
      const target = dependencyCandidates(key, name).find(candidate => Object.hasOwn(lock.packages, candidate));
      if (!target) throw new Error(`dependency reference ${key || '<root>'} -> ${name} has no resolvable target`);
      assertEdgeSatisfies(key, name, requested, lock.packages[target]);
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push({ key: target, entry: lock.packages[target] });
      }
    }
  }
  for (const [name, requested] of Object.entries(directDependencies)) {
    const key = `node_modules/${name}`;
    if (!lock.packages[key] || lock.packages[key].version !== requested) throw new Error(`required dependency ${name}@${requested} lacks matching resolved/integrity authority`);
  }
  const unreachable = Object.keys(lock.packages).filter(key => key !== '' && !reachable.has(key));
  if (unreachable.length > 0) throw new Error(`lock contains package entries outside its dependency graph: ${unreachable[0]}`);
  return Object.freeze({ lockfileVersion: lock.lockfileVersion, packageCount: Object.keys(lock.packages).length - 1 });
}

export function normalizedLockRoot(packageJson) {
  const root = {
    name: packageJson.name,
    version: packageJson.version,
    dependencies: { ...(packageJson.dependencies ?? {}) },
    bin: normalizeBin(packageJson.bin),
    engines: { ...(packageJson.engines ?? {}) }
  };
  if (packageJson.optionalDependencies !== undefined) root.optionalDependencies = { ...packageJson.optionalDependencies };
  return Object.freeze(root);
}
