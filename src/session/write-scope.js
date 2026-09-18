import { posix } from 'node:path';
import { ResearchOSError } from '../lib/errors.js';
import { deepFreeze } from '../lib/readonly.js';

const ACTIVE_WRITER_STATUSES = new Set(['registered', 'running', 'blocked', 'candidate_ready']);
const DEFAULT_CONTROL_PATHS = ['PROJECT.md', 'plans/active.md'];

function decodedPath(value) {
  let decoded = value;
  for (let index = 0; index <= value.length; index += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new ResearchOSError('USAGE', `Path contains invalid percent encoding: ${value}`);
    }
    if (next === decoded) break;
    decoded = next;
    if (index === value.length) throw new ResearchOSError('USAGE', `Path encoding did not stabilize: ${value}`);
  }
  return decoded;
}

function invalidDecodedTraversal(value) {
  const decoded = decodedPath(value);
  return decoded.startsWith('/') || decoded.includes('\\') || decoded.split('/').some(segment => segment === '..' || segment === '.');
}

/**
 * Normalize one non-glob project-relative path and reject ambiguous or escaped paths.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeProjectRelative(value) {
  if (typeof value !== 'string' || value.length === 0 || value === '.' || value.includes('\0') || value.includes('\\') || value.startsWith('/') || invalidDecodedTraversal(value)) {
    throw new ResearchOSError('USAGE', `Path must be a safe project-relative path: ${String(value)}`);
  }
  const segments = value.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new ResearchOSError('USAGE', `Path must be a safe project-relative path: ${value}`);
  }
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized.startsWith('../')) {
    throw new ResearchOSError('USAGE', `Path must be canonical and project-relative: ${value}`);
  }
  return normalized;
}

export function normalizeWritePattern(value) {
  const pattern = normalizeProjectRelative(value);
  for (const segment of pattern.split('/')) {
    if (/[?\[\]{}]/u.test(segment) || (segment.includes('**') && segment !== '**') || (segment !== '**' && (segment.match(/\*/gu) ?? []).length > 1)) {
      throw new ResearchOSError('USAGE', `Unsupported write-scope pattern: ${value}`);
    }
  }
  return pattern;
}

function segmentPatternContained(authorized, requested) {
  if (authorized === '*' || authorized === requested) return true;
  if (!requested.includes('*')) return segmentMatches(authorized, requested);
  return false;
}

function patternContained(authorized, requested) {
  if (authorized === requested) return true;
  if (!requested.includes('*')) return matchesWritePattern(authorized, requested);
  if (!authorized.includes('*')) return false;
  const authorizedSegments = authorized.split('/');
  const requestedSegments = requested.split('/');
  const doubleStar = authorizedSegments.indexOf('**');
  if (doubleStar >= 0) {
    if (doubleStar !== authorizedSegments.length - 1) return false;
    if (requestedSegments.length < doubleStar) return false;
    return authorizedSegments.slice(0, doubleStar)
      .every((segment, index) => segmentPatternContained(segment, requestedSegments[index]));
  }
  if (requestedSegments.includes('**') || authorizedSegments.length !== requestedSegments.length) return false;
  return authorizedSegments.every((segment, index) => segmentPatternContained(segment, requestedSegments[index]));
}

/**
 * Conservatively prove that every requested scope is a subset of an authority ceiling.
 * Sensitive control paths are authorized only by an identical exact grant.
 * @param {ReadonlyArray<string>} authorizedPatterns
 * @param {ReadonlyArray<string>} requestedPatterns
 * @param {ReadonlyArray<string>} [controlPaths]
 * @returns {boolean}
 */
export function isWriteScopeContained(authorizedPatterns, requestedPatterns, controlPaths = DEFAULT_CONTROL_PATHS) {
  if (!Array.isArray(authorizedPatterns) || !Array.isArray(requestedPatterns) || !Array.isArray(controlPaths)) {
    throw new ResearchOSError('USAGE', 'Write-scope containment inputs must be arrays');
  }
  const authorized = authorizedPatterns.map(normalizeWritePattern);
  const requested = requestedPatterns.map(normalizeWritePattern);
  const controls = controlPaths.map(normalizeProjectRelative);
  const exactAuthorized = new Set(authorized.filter(pattern => !hasWildcard(pattern)));
  for (const candidate of requested) {
    const overlappingControl = controls.find(control => patternsMayOverlap(candidate, control));
    if (overlappingControl && (candidate !== overlappingControl || !exactAuthorized.has(overlappingControl))) return false;
    if (!authorized.some(ceiling => patternContained(ceiling, candidate))) return false;
  }
  return true;
}

function segmentMatches(pattern, value) {
  if (pattern === '*') return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace('*', '.*');
  return new RegExp(`^${escaped}$`, 'u').test(value);
}

function matchSegments(pattern, path, patternIndex = 0, pathIndex = 0) {
  if (patternIndex === pattern.length) return pathIndex === path.length;
  if (pattern[patternIndex] === '**') {
    if (patternIndex === pattern.length - 1) return true;
    for (let index = pathIndex; index <= path.length; index += 1) {
      if (matchSegments(pattern, path, patternIndex + 1, index)) return true;
    }
    return false;
  }
  return pathIndex < path.length && segmentMatches(pattern[patternIndex], path[pathIndex]) && matchSegments(pattern, path, patternIndex + 1, pathIndex + 1);
}

/**
 * Match one validated project-relative pattern against one validated path.
 * @param {string} pattern
 * @param {string} path
 * @returns {boolean}
 */
export function matchesWritePattern(pattern, path) {
  const normalizedPattern = normalizeWritePattern(pattern);
  const normalizedPath = normalizeProjectRelative(path);
  return matchSegments(normalizedPattern.split('/'), normalizedPath.split('/'));
}

function hasWildcard(pattern) {
  return pattern.includes('*');
}

function patternsMayOverlap(leftValue, rightValue) {
  const left = normalizeWritePattern(leftValue);
  const right = normalizeWritePattern(rightValue);
  if (!hasWildcard(left) && !hasWildcard(right)) return left === right;
  if (!hasWildcard(left)) return matchesWritePattern(right, left);
  if (!hasWildcard(right)) return matchesWritePattern(left, right);
  const staticPrefix = pattern => {
    const result = [];
    for (const segment of pattern.split('/')) {
      if (segment.includes('*')) break;
      result.push(segment);
    }
    return result;
  };
  const leftPrefix = staticPrefix(left);
  const rightPrefix = staticPrefix(right);
  const length = Math.min(leftPrefix.length, rightPrefix.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPrefix[index] !== rightPrefix[index]) return false;
  }
  return true;
}

function registrationWritablePaths(registration) {
  const paths = registration?.writablePaths ?? registration?.writable_paths;
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) {
    throw new ResearchOSError('USAGE', 'Registration writable paths must be a string array');
  }
  return paths.map(normalizeWritePattern);
}

function registrationControlPaths(registration) {
  const supplied = registration?.controlPaths ?? registration?.control_paths ?? [];
  if (!Array.isArray(supplied) || supplied.some(path => typeof path !== 'string')) {
    throw new ResearchOSError('USAGE', 'Registration control paths must be a string array');
  }
  return [...new Set([...DEFAULT_CONTROL_PATHS, ...supplied.map(normalizeProjectRelative)])].sort((left, right) => left.localeCompare(right, 'en'));
}

/**
 * Find active registered writers whose canonical scopes may overlap requested scopes.
 * @param {ReadonlyArray<Record<string, unknown>>} registrations
 * @param {ReadonlyArray<string>} requestedPaths
 * @returns {ReadonlyArray<Readonly<{id: string, owner: string, writablePaths: ReadonlyArray<string>}>>}
 */
export function findWriterConflicts(registrations, requestedPaths) {
  if (!Array.isArray(registrations)) throw new ResearchOSError('USAGE', 'Background register must be an array');
  const requested = requestedPaths.map(normalizeWritePattern);
  const conflicts = [];
  for (const registration of registrations) {
    if (!ACTIVE_WRITER_STATUSES.has(registration.status)) continue;
    const writablePaths = registrationWritablePaths(registration);
    if (!requested.some(path => writablePaths.some(existing => patternsMayOverlap(existing, path)))) continue;
    conflicts.push({ id: String(registration.id), owner: String(registration.owner), writablePaths });
  }
  conflicts.sort((left, right) => left.id.localeCompare(right.id, 'en'));
  return deepFreeze(conflicts);
}

/**
 * @typedef {Object} WriteScopeReport
 * @property {boolean} ok
 * @property {ReadonlyArray<string>} allowed
 * @property {ReadonlyArray<Readonly<{code: string, path: string, reason: string}>>} violations
 */

/**
 * Check a candidate diff against the writer registration that produced it.
 * @param {Record<string, unknown>} registration
 * @param {ReadonlyArray<unknown>} changedPaths
 * @returns {Readonly<WriteScopeReport>}
 */
export function checkWriteScope(registration, changedPaths) {
  if (!Array.isArray(changedPaths)) throw new ResearchOSError('USAGE', 'Changed paths must be an array');
  const patterns = registrationWritablePaths(registration);
  const controlPaths = new Set(registrationControlPaths(registration));
  const exactGrants = new Set(patterns.filter(pattern => !hasWildcard(pattern)));
  const allowed = [];
  const violations = [];

  const sortedInputs = [...changedPaths].sort((left, right) => String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0);
  for (const input of sortedInputs) {
    let path;
    try {
      path = normalizeProjectRelative(input);
    } catch {
      violations.push({ code: 'WRITE_SCOPE_VIOLATION', path: String(input), reason: 'INVALID_PROJECT_RELATIVE_PATH' });
      continue;
    }
    if (controlPaths.has(path) && !exactGrants.has(path)) {
      violations.push({ code: 'WRITE_SCOPE_VIOLATION', path, reason: 'SENSITIVE_CONTROL_FILE_REQUIRES_EXACT_GRANT' });
      continue;
    }
    if (!patterns.some(pattern => matchesWritePattern(pattern, path))) {
      violations.push({ code: 'WRITE_SCOPE_VIOLATION', path, reason: 'PATH_NOT_AUTHORIZED' });
      continue;
    }
    allowed.push(path);
  }

  return deepFreeze({ ok: violations.length === 0, allowed: [...new Set(allowed)], violations });
}
