import { ResearchOSError } from '../lib/errors.js';
import { posix } from 'node:path';

const RESOURCE_NAME = /^[a-z][a-z0-9_-]*$/;
const RESOURCE_FIELDS = new Set(['uri', 'role', 'access', 'identity']);
const ACCESS_VALUES = new Set(['read-only', 'read-write']);

function invalidReference(ref) {
  throw new ResearchOSError('USAGE', `Invalid resource reference: ${ref}`);
}

export function assertResourceName(name) {
  if (typeof name !== 'string' || !RESOURCE_NAME.test(name)) {
    throw new ResearchOSError('USAGE', `Invalid resource name: ${name}`);
  }
}

function assertSingleLineString(value, label, code = 'RESOURCE_CONFIG') {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n\u2028\u2029\0]/u.test(value)) {
    throw new ResearchOSError(code, `${label} must be a non-empty single-line string`);
  }
}

export function assertResource(resource, resourceName = 'resource') {
  if (!resource || Array.isArray(resource) || typeof resource !== 'object') {
    throw new ResearchOSError('RESOURCE_CONFIG', `Invalid resource: ${resourceName}`);
  }
  const keys = Object.keys(resource);
  if (keys.some(key => !RESOURCE_FIELDS.has(key)) || !['uri', 'role', 'access'].every(key => Object.hasOwn(resource, key))) {
    throw new ResearchOSError('RESOURCE_CONFIG', `Invalid resource fields: ${resourceName}`);
  }
  assertSingleLineString(resource.uri, `Resource URI for ${resourceName}`);
  assertSingleLineString(resource.role, `Resource role for ${resourceName}`);
  if (!ACCESS_VALUES.has(resource.access)) {
    throw new ResearchOSError('RESOURCE_CONFIG', `Invalid resource access for ${resourceName}: ${resource.access}`);
  }
  if (Object.hasOwn(resource, 'identity')) assertSingleLineString(resource.identity, `Resource identity for ${resourceName}`);
}

export function assertResources(resources) {
  if (!resources || Array.isArray(resources) || typeof resources !== 'object') {
    throw new ResearchOSError('RESOURCE_CONFIG', 'Resources must be an object');
  }
  for (const [name, resource] of Object.entries(resources)) {
    try {
      assertResourceName(name);
    } catch (error) {
      throw new ResearchOSError('RESOURCE_CONFIG', `Invalid resource name: ${name}`);
    }
    assertResource(resource, name);
  }
}

export function parseResourceRef(ref) {
  if (typeof ref !== 'string') throw new ResearchOSError('USAGE', 'Resource reference must be a string');
  const separator = ref.indexOf(':');
  if (separator <= 0 || separator !== ref.lastIndexOf(':')) {
    throw new ResearchOSError('USAGE', `Invalid resource reference: ${ref}`);
  }
  const resourceName = ref.slice(0, separator);
  const relativePath = ref.slice(separator + 1);
  if (!RESOURCE_NAME.test(resourceName) || relativePath.length === 0 || /[\r\n\u2028\u2029\\?#]/u.test(relativePath)) invalidReference(ref);
  return { resourceName, relativePath };
}

function decodedPathForSafety(relativePath, ref) {
  let decoded = relativePath;
  for (let index = 0; index <= relativePath.length; index += 1) {
    if (!decoded.includes('%')) return decoded;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      throw new ResearchOSError('RESOURCE_PATH_ESCAPE', ref);
    }
  }
  if (decoded.includes('%')) throw new ResearchOSError('RESOURCE_PATH_ESCAPE', ref);
  return decoded;
}

function normalizeResourcePath(relativePath, ref) {
  const decoded = decodedPathForSafety(relativePath, ref);
  const normalizedDecoded = posix.normalize(decoded);
  if (posix.isAbsolute(decoded) || normalizedDecoded === '..' || normalizedDecoded.startsWith('../')) {
    throw new ResearchOSError('RESOURCE_PATH_ESCAPE', ref);
  }
  return posix.normalize(relativePath);
}

export function joinResourceUri(resourceUri, relativePath) {
  const remote = resourceUri.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)(\/[^?#]*)?$/iu);
  if (remote) {
    const [, scheme, authority, path = ''] = remote;
    return `${scheme}://${authority}${posix.join(path || '/', relativePath)}`;
  }
  return posix.join(resourceUri, relativePath);
}

export function resolveResourceRef(project, ref) {
  const { resourceName, relativePath } = parseResourceRef(ref);
  const resources = project?.resources;
  if (!resources || !Object.hasOwn(resources, resourceName)) {
    throw new ResearchOSError('RESOURCE_NOT_FOUND', resourceName);
  }
  const resource = resources[resourceName];
  assertResource(resource, resourceName);
  const normalizedPath = normalizeResourcePath(relativePath, ref);
  return {
    uri: joinResourceUri(resource.uri, normalizedPath),
    resourceName,
    relativePath: normalizedPath,
    access: resource.access
  };
}

export function assertApprovedCodeRoot(project, resourceName) {
  assertResourceName(resourceName);
  if (!Array.isArray(project?.approved_code_roots) || !project.approved_code_roots.includes(resourceName)) {
    throw new ResearchOSError('CODE_ROOT_NOT_APPROVED', resourceName);
  }
}
