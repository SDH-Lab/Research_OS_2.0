import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { ResearchOSError } from '../lib/errors.js';
import { deepFreeze } from '../lib/readonly.js';
import { assertApprovedCodeRoot, assertResources, parseResourceRef, resolveResourceRef } from '../project/resources.js';

export const MANIFEST_INPUT_FIELDS = Object.freeze([
  'code_root', 'resolved_code_root', 'entrypoint', 'commit', 'resolved_config',
  'data_and_split', 'model_and_checkpoint', 'training_boundary', 'optimizer_scheduler',
  'evaluator', 'command', 'environment', 'output_location', 'expected_artifacts'
]);
export const MANIFEST_MACHINE_FIELDS = Object.freeze([
  'resolved_config_hash', 'normalized_hash', 'resolved_at', 'project_authority',
  'project_authority_hash', 'resolved_outputs', 'manifest_complete'
]);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{7,64}$/iu;

function fail(message, code = 'MANIFEST_INVALID') {
  throw new ResearchOSError(code, message);
}

function isPlainObject(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function single(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/[\r\n\u2028\u2029\0]/u.test(value);
}

function inspectProperties(value, path) {
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key === 'symbol')) fail(`${path} contains a non-JSON symbol key`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, String(index))) fail(`${path} contains a sparse array hole`);
    }
    const expected = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))]);
    if (keys.some(key => !expected.has(key))) fail(`${path} contains an extra array property`);
  }
  for (const key of keys) {
    if (key === 'length' && Array.isArray(value)) continue;
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) fail(`${path}.${key} contains a non-enumerable JSON property`);
    if (descriptor.get || descriptor.set || !Object.hasOwn(descriptor, 'value')) fail(`${path}.${key} contains an accessor property`);
  }
  return { keys, descriptors };
}

/** Clone exact JSON data with canonical object-key order and semantic array order. */
export function canonicalJson(value, ancestors = new WeakSet(), path = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail(`${path} contains a non-finite or non-canonical JSON number`);
    return value;
  }
  if (typeof value !== 'object') fail(`${path} contains non-JSON data`);
  if (ancestors.has(value)) fail(`${path} contains a cycle`);
  if (!Array.isArray(value) && !isPlainObject(value)) fail(`${path} must contain only plain JSON objects`);
  const { keys, descriptors } = inspectProperties(value, path);
  ancestors.add(value);
  let output;
  if (Array.isArray(value)) {
    output = Array.from({ length: value.length }, (_, index) => canonicalJson(descriptors[String(index)].value, ancestors, `${path}[${index}]`));
  } else {
    const stringKeys = keys.map(String).sort((left, right) => left.localeCompare(right, 'en'));
    const entries = [];
    for (const key of stringKeys) {
      if (UNSAFE_KEYS.has(key)) fail(`${path} contains unsafe key ${key}`);
      entries.push([key, canonicalJson(descriptors[key].value, ancestors, `${path}.${key}`)]);
    }
    output = Object.fromEntries(entries);
  }
  ancestors.delete(value);
  return output;
}

export function stableJson(value) {
  return JSON.stringify(canonicalJson(value));
}

export function sha256Json(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

/** Return one genuine, valid Date or a stable domain error. */
export function trustedDate(clock, code = 'MANIFEST_INVALID') {
  let value;
  try {
    value = clock?.() ?? new Date();
    const epoch = Date.prototype.getTime.call(value);
    if (!Number.isFinite(epoch)) fail('Clock must return a genuine valid Date', code);
    const iso = Date.prototype.toISOString.call(value);
    return Object.freeze({ epoch, iso });
  } catch (error) {
    if (error instanceof ResearchOSError) throw error;
    fail('Clock must return a genuine valid Date', code);
  }
}

export function isValidTimestamp(value) {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  const maximumDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= maximumDay
    && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59
    && (!offsetHour || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59)) && Number.isFinite(Date.parse(value));
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) fail(`${label} must be a plain object`);
  const actual = Object.keys(value).sort((a, b) => a.localeCompare(b, 'en'));
  const wanted = [...expected].sort((a, b) => a.localeCompare(b, 'en'));
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(`${label} fields must be exactly: ${expected.join(', ')}`);
}

function requireObject(value, fields, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  for (const field of fields) if (!Object.hasOwn(value, field)) fail(`${label}.${field} is required`);
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => !single(item)) || new Set(value).size !== value.length) fail(`${label} must be non-empty unique strings`);
}

function metricArray(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => {
    if (single(item)) return false;
    if (!isPlainObject(item)) return true;
    return !single(item.name) || !single(item.definition);
  })) fail('evaluator.metrics must contain non-empty names or structured definitions with name and definition');
  if (new Set(value.map(item => stableJson(item))).size !== value.length) fail('evaluator.metrics cannot contain duplicates');
}

function namedDescriptor(value, label) {
  requireObject(value, ['name', 'parameters'], label);
  if (!single(value.name) || !isPlainObject(value.parameters)) fail(`${label} requires a meaningful name and a parameters object`);
}

function earlyStoppingDescriptor(value) {
  requireObject(value, ['mode', 'monitor', 'patience'], 'optimizer_scheduler.early_stopping');
  if (!['enabled', 'disabled'].includes(value.mode)) fail('optimizer_scheduler.early_stopping.mode must be enabled or disabled');
  if (value.mode === 'enabled' && (!single(value.monitor) || !Number.isInteger(value.patience) || value.patience < 1)) {
    fail('enabled optimizer_scheduler.early_stopping requires a monitor and positive integer patience');
  }
  if (value.mode === 'disabled' && (value.monitor !== null || value.patience !== null)) {
    fail('disabled optimizer_scheduler.early_stopping requires null monitor and patience');
  }
}

function resourceRef(project, value, label) {
  if (!single(value)) fail(`${label} must be a registered resource reference`);
  try {
    parseResourceRef(value);
    return resolveResourceRef(project, value);
  } catch (error) {
    fail(`${label} must be a safe registered resource reference: ${error.message}`);
  }
}

function resourceSnapshot(project, name) {
  const resource = project.resources[name];
  return canonicalJson({ resource: name, uri: resource.uri, ...(resource.identity === undefined ? {} : { identity: resource.identity }) });
}

function validateProject(project) {
  if (!isPlainObject(project) || !single(project.project_id) || !single(project.core_version)) fail('A loaded authoritative Project is required');
  try { assertResources(project.resources); } catch (error) { fail(`Project resources are invalid: ${error.message}`); }
  if (!Array.isArray(project.approved_code_roots) || project.approved_code_roots.some(root => !single(root))) fail('Project approved_code_roots are invalid');
}

function validateSemanticInput(input, project, options = {}) {
  const complete = options.complete !== false;
  if (complete) exactKeys(input, MANIFEST_INPUT_FIELDS, 'Manifest input');
  const has = field => Object.hasOwn(input, field);
  for (const field of ['code_root', 'entrypoint', 'commit', 'command', 'output_location']) {
    if ((complete || has(field)) && !single(input[field])) fail(`${field} must be a meaningful single-line string`);
  }
  if ((complete || has('commit')) && !COMMIT.test(input.commit)) fail('commit must be a 7-64 character hexadecimal identity');
  if ((complete || has('entrypoint')) && (posix.isAbsolute(input.entrypoint) || posix.normalize(input.entrypoint) !== input.entrypoint || input.entrypoint === '..' || input.entrypoint.startsWith('../') || input.entrypoint.includes('\\'))) fail('entrypoint must be a safe relative path');
  if ((complete || has('resolved_config')) && (!isPlainObject(input.resolved_config) || Object.keys(input.resolved_config).length === 0)) fail('resolved_config must be a non-empty safe object');

  if (complete || has('data_and_split')) {
    requireObject(input.data_and_split, ['dataset_root', 'manifest', 'split_function', 'seed', 'class_or_domain_order'], 'data_and_split');
    resourceRef(project, input.data_and_split.dataset_root, 'data_and_split.dataset_root');
    resourceRef(project, input.data_and_split.manifest, 'data_and_split.manifest');
    if (!single(input.data_and_split.split_function) || !Number.isInteger(input.data_and_split.seed)) fail('data_and_split split_function and integer seed are required');
    stringArray(input.data_and_split.class_or_domain_order, 'data_and_split.class_or_domain_order');
  }

  if (complete || has('model_and_checkpoint')) {
    requireObject(input.model_and_checkpoint, ['model_class', 'checkpoint'], 'model_and_checkpoint');
    if (!single(input.model_and_checkpoint.model_class)) fail('model_and_checkpoint.model_class is required');
    resourceRef(project, input.model_and_checkpoint.checkpoint, 'model_and_checkpoint.checkpoint');
  }

  if (complete || has('training_boundary')) {
    requireObject(input.training_boundary, ['trainable_parameters', 'loss', 'sampler', 'gradient_accumulation'], 'training_boundary');
    stringArray(input.training_boundary.trainable_parameters, 'training_boundary.trainable_parameters');
    if (!single(input.training_boundary.loss) || !single(input.training_boundary.sampler) || !Number.isInteger(input.training_boundary.gradient_accumulation) || input.training_boundary.gradient_accumulation < 1) fail('training_boundary loss, sampler, and positive gradient_accumulation are required');
  }

  if (complete || has('optimizer_scheduler')) {
    requireObject(input.optimizer_scheduler, ['optimizer', 'scheduler', 'checkpoint_selection', 'early_stopping'], 'optimizer_scheduler');
    namedDescriptor(input.optimizer_scheduler.optimizer, 'optimizer_scheduler.optimizer');
    namedDescriptor(input.optimizer_scheduler.scheduler, 'optimizer_scheduler.scheduler');
    if (!single(input.optimizer_scheduler.checkpoint_selection)) fail('optimizer_scheduler.checkpoint_selection must be meaningful');
    earlyStoppingDescriptor(input.optimizer_scheduler.early_stopping);
  }

  if (complete || has('evaluator')) {
    requireObject(input.evaluator, ['implementation', 'metrics', 'aggregation', 'state'], 'evaluator');
    if (!single(input.evaluator.implementation) || !single(input.evaluator.aggregation) || !single(input.evaluator.state)) fail('evaluator implementation, aggregation, and state are required');
    metricArray(input.evaluator.metrics);
  }

  if (complete || has('environment')) {
    requireObject(input.environment, ['runtime', 'packages', 'hardware'], 'environment');
    if (!single(input.environment.runtime) || !single(input.environment.hardware) || !isPlainObject(input.environment.packages) || Object.keys(input.environment.packages).length === 0) fail('environment runtime, packages, and hardware are required');
  }

  let output;
  let artifacts;
  if (complete || has('output_location') || has('expected_artifacts')) {
    if (!has('output_location') || !has('expected_artifacts')) fail('output_location and expected_artifacts must be provided together');
    stringArray(input.expected_artifacts, 'expected_artifacts');
    output = resourceRef(project, input.output_location, 'output_location');
    if (output.access !== 'read-write') fail('output_location must select a read-write Project resource');
    artifacts = input.expected_artifacts.map((ref, index) => resourceRef(project, ref, `expected_artifacts[${index}]`));
    if (artifacts.some(artifact => artifact.resourceName !== output.resourceName || !(artifact.relativePath === output.relativePath || artifact.relativePath.startsWith(`${output.relativePath}/`)))) fail('expected_artifacts must resolve inside output_location');
  }
  if (complete || has('code_root') || has('resolved_code_root')) {
    if (!has('code_root') || !has('resolved_code_root')) fail('code_root and resolved_code_root must be provided together');
    try { assertApprovedCodeRoot(project, input.code_root); } catch (error) { throw error; }
    if (!Object.hasOwn(project.resources, input.code_root)) fail('Approved code root must be a registered Project resource');
    const rootSnapshot = resourceSnapshot(project, input.code_root);
    if (stableJson(input.resolved_code_root) !== stableJson(rootSnapshot)) fail('resolved_code_root snapshot does not match current Project authority');
  }
  return { output, artifacts };
}

function authorityFor(project, input) {
  const refs = [input.data_and_split.dataset_root, input.data_and_split.manifest, input.model_and_checkpoint.checkpoint, input.output_location, ...input.expected_artifacts];
  const names = [...new Set([input.code_root, ...refs.map(ref => parseResourceRef(ref).resourceName)])].sort((a, b) => a.localeCompare(b, 'en'));
  const selected_resources = Object.fromEntries(names.map(name => [name, canonicalJson(project.resources[name])]));
  return canonicalJson({
    project_id: project.project_id,
    core_version: project.core_version,
    approved_code_roots: [...project.approved_code_roots].sort((a, b) => a.localeCompare(b, 'en')),
    code_root: input.code_root,
    selected_resources
  });
}

function derived(input, project) {
  validateProject(project);
  const resolved = validateSemanticInput(input, project);
  const projectAuthority = authorityFor(project, input);
  const resolvedOutputs = canonicalJson({ output_location: resolved.output, expected_artifacts: resolved.artifacts });
  return { projectAuthority, resolvedOutputs };
}

/** @typedef {Readonly<Record<string, unknown>>} ImplementationManifest */

export function normalizeManifest(input, options = {}) {
  if (!isPlainObject(options) || Object.keys(options).some(key => !['clock', 'project'].includes(key))) fail('Manifest options must provide only project and optional clock');
  const canonical = canonicalJson(input);
  const { projectAuthority, resolvedOutputs } = derived(canonical, options.project);
  const resolvedConfigHash = sha256Json(canonical.resolved_config);
  const projectAuthorityHash = sha256Json(projectAuthority);
  const payload = canonicalJson({
    ...canonical,
    resolved_config_hash: resolvedConfigHash,
    project_authority: projectAuthority,
    project_authority_hash: projectAuthorityHash,
    resolved_outputs: resolvedOutputs,
    manifest_complete: true
  });
  const { iso } = trustedDate(options.clock);
  return deepFreeze({ ...payload, normalized_hash: sha256Json(payload), resolved_at: iso });
}

export function verifyProjectAuthoritySnapshot(manifest, project) {
  const required = ['code_root', 'resolved_code_root', 'data_and_split', 'model_and_checkpoint', 'output_location', 'expected_artifacts'];
  if (required.some(field => !Object.hasOwn(manifest, field))) fail('Partial Manifest lacks fields needed to verify Project authority');
  validateProject(project);
  const caller = canonicalJson(Object.fromEntries(MANIFEST_INPUT_FIELDS.filter(field => Object.hasOwn(manifest, field)).map(field => [field, manifest[field]])));
  validateSemanticInput(caller, project, { complete: false });
  const projectAuthority = authorityFor(project, caller);
  if (stableJson(manifest.project_authority) !== stableJson(projectAuthority) || manifest.project_authority_hash !== sha256Json(projectAuthority)) fail('Manifest Project authority snapshot/hash mismatch');
  return deepFreeze(projectAuthority);
}

/** Extract the exact detached normalized Manifest snapshot from a canonical record. */
export function manifestSnapshotFromRecord(attributes) {
  if (!isPlainObject(attributes)) fail('Manifest record attributes must be a plain object');
  const fields = [...MANIFEST_INPUT_FIELDS, ...MANIFEST_MACHINE_FIELDS];
  const missing = fields.filter(field => !Object.hasOwn(attributes, field));
  if (missing.length > 0) fail(`Manifest record lacks snapshot fields: ${missing.join(', ')}`);
  return deepFreeze(canonicalJson(Object.fromEntries(fields.map(field => [field, attributes[field]]))));
}

export function verifyNormalizedManifest(manifest, options = {}) {
  const canonical = canonicalJson(manifest);
  exactKeys(canonical, [...MANIFEST_INPUT_FIELDS, ...MANIFEST_MACHINE_FIELDS], 'Normalized Manifest');
  if (canonical.manifest_complete !== true || !HASH.test(canonical.resolved_config_hash) || !HASH.test(canonical.normalized_hash) || !HASH.test(canonical.project_authority_hash)) fail('Normalized Manifest machine fields are invalid');
  if (!isValidTimestamp(canonical.resolved_at)) fail('Normalized Manifest resolved_at is invalid');
  const caller = Object.fromEntries(MANIFEST_INPUT_FIELDS.map(field => [field, canonical[field]]));
  const { projectAuthority, resolvedOutputs } = derived(caller, options.project);
  if (canonical.resolved_config_hash !== sha256Json(caller.resolved_config)) fail('Resolved config hash mismatch');
  if (canonical.project_authority_hash !== sha256Json(projectAuthority) || stableJson(canonical.project_authority) !== stableJson(projectAuthority)) fail('Project authority snapshot/hash mismatch');
  if (stableJson(canonical.resolved_outputs) !== stableJson(resolvedOutputs)) fail('Resolved output snapshot mismatch');
  const payload = canonicalJson({ ...caller, resolved_config_hash: canonical.resolved_config_hash, project_authority: projectAuthority, project_authority_hash: canonical.project_authority_hash, resolved_outputs: resolvedOutputs, manifest_complete: true });
  if (canonical.normalized_hash !== sha256Json(payload)) fail('Normalized Manifest hash mismatch');
  return deepFreeze(canonical);
}
