import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ResearchOSError } from '../lib/errors.js';
import { safeJoin, readUtf8 } from '../lib/fs.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../lib/markdown.js';
import { deepFreeze } from '../lib/readonly.js';
import { discoverRecords } from '../records/catalog.js';
import { isCanonicalRecordLocation, isValidDateTime, schemaForRecordType, validateRecord, validateStatusHistory } from '../validation/validator.js';
import { assertActionCanStart } from '../actions/workflow.js';
import { assertProjectTransactionClear, publishProjectChanges } from '../project/rebaseline.js';
import { findWriterConflicts, isWriteScopeContained, normalizeProjectRelative } from './write-scope.js';

const issue = (code, path, message) => ({ code, path, message });
const nextTime = value => new Date(Math.max(Date.now(), Date.parse(value) + 1)).toISOString();
const digest = data => createHash('sha256').update(data).digest('hex');

function assertValid(record) {
  const schema = schemaForRecordType(record.type);
  const issues = !schema || !isCanonicalRecordLocation(record)
    ? [issue('RECORD_INVALID', record.path, 'Record type or canonical location is invalid')]
    : [...validateRecord(schema, record.attributes), ...validateStatusHistory(record.attributes, record.path)];
  if (issues.length) throw new ResearchOSError('VALIDATION', `Invalid ${record.id}: ${issues.map(value => value.message).join('; ')}`, issues);
}

function oneRecord(records, id, type) {
  const matches = [...records.values()].filter(value => value.id === id);
  if (matches.length !== 1 || (type && matches[0].type !== type)) throw new ResearchOSError('VALIDATION', `Expected exactly one ${type ?? 'record'} for ${id}`);
  assertValid(matches[0]);
  return matches[0];
}

async function loadState(projectRoot) {
  await assertProjectTransactionClear(projectRoot);
  const discovered = await discoverRecords(projectRoot);
  const snapshots = await Promise.all([...discovered.values()].map(async record => ({ path: record.path, before: await readUtf8(safeJoin(projectRoot, record.path)) })));
  const records = new Map(snapshots.map(snapshot => {
    const attributes = parseMarkdownDocument(snapshot.before, snapshot.path).attributes;
    return [snapshot.path, { path: snapshot.path, id: attributes.id, type: attributes.type, attributes }];
  }));
  const project = records.get('PROJECT.md');
  if (!project) throw new ResearchOSError('VALIDATION', 'PROJECT.md is missing');
  assertValid(project);
  const planPath = normalizeProjectRelative(project.attributes.active_plan);
  const plan = records.get(planPath);
  if (!plan || plan.type !== 'exec_plan') throw new ResearchOSError('VALIDATION', 'Active Plan is missing');
  assertValid(plan);
  await assertProjectTransactionClear(projectRoot);
  return { records, snapshots, project: project.attributes, plan: plan.attributes, planPath };
}

async function fileDigest(projectRoot, file) {
  const path = normalizeProjectRelative(file);
  if (path.includes('*')) throw new ResearchOSError('USAGE', 'Artifact file must be an exact path');
  return digest(await readFile(safeJoin(projectRoot, path)));
}

/** Validate an accepted exact file version, independently of producer completion. */
export async function validateArtifactDependency(projectRoot, record, records) {
  const issues = [];
  try {
    assertValid(record);
    if (record.type !== 'artifact') throw new ResearchOSError('VALIDATION', 'Expected an Artifact');
    if (record.attributes.status !== 'closed' || !record.attributes.acceptance || !record.attributes.sha256) {
      return [issue('ARTIFACT_NOT_ACCEPTED', record.path, 'Artifact needs explicit acceptance before use')];
    }
    const catalog = records ?? await discoverRecords(projectRoot);
    oneRecord(catalog, record.attributes.producer_action, 'action');
    if (await fileDigest(projectRoot, record.attributes.file) !== record.attributes.sha256) {
      issues.push(issue('ARTIFACT_VERSION_CHANGED', record.path, 'Artifact file no longer matches the accepted SHA-256 version'));
    }
  } catch (error) {
    issues.push(issue('ARTIFACT_INVALID', record.path, error.message));
  }
  return issues;
}

async function dependencyIssues(projectRoot, action, state) {
  const issues = [];
  for (const id of action.attributes.dependencies) {
    let dependency;
    try { dependency = oneRecord(state.records, id); }
    catch (error) { issues.push(issue('DEPENDENCY_INVALID', `record:${id}`, error.message)); continue; }
    if (dependency.type === 'artifact') issues.push(...await validateArtifactDependency(projectRoot, dependency, state.records));
    else if (dependency.attributes.status !== 'closed') issues.push(issue('DEPENDENCY_NOT_SATISFIED', dependency.path, `Dependency is not closed: ${id}`));
  }
  return issues;
}

function observationIssues(observation, action, project, claiming) {
  const path = `${action.path}#/execution/resource_observation`;
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)
    || Object.keys(observation).sort().join(',') !== 'available,observed_at,source'
    || !isValidDateTime(observation.observed_at) || typeof observation.source !== 'string' || !observation.source.trim()
    || !Array.isArray(observation.available) || observation.available.some(name => typeof name !== 'string' || !Object.hasOwn(project.resources, name))
    || new Set(observation.available).size !== observation.available.length) {
    return [issue('RESOURCE_OBSERVATION_REQUIRED', path, 'Supply an observation time, source, and exact registered available lanes')];
  }
  if (Date.parse(observation.observed_at) > Date.now()) return [issue('RESOURCE_OBSERVATION_INVALID', path, 'Resource observation is in the future')];
  if (claiming && Date.parse(observation.observed_at) < Date.parse(action.attributes.updated)) {
    return [issue('RESOURCE_OBSERVATION_STALE', path, 'Recheck resources after the latest Action change before claiming')];
  }
  return [];
}

async function evaluate(projectRoot, action, state, { observation, claiming = false } = {}) {
  const issues = await dependencyIssues(projectRoot, action, state);
  if (typeof state.project.foreground_objective !== 'string' || !state.project.foreground_objective.trim() || state.project.foreground_objective === 'Not set') {
    issues.push(issue('FOREGROUND_OBJECTIVE_MISSING', 'PROJECT.md#/foreground_objective', 'Set one foreground objective before claiming work'));
  }
  try { assertActionCanStart(action.attributes); }
  catch (error) { issues.push(issue(error.code ?? 'ACTION_WORKFLOW', action.path, error.message)); }
  const execution = action.attributes.execution;
  if (!execution) return { ok: false, issues: [...issues, issue('EXECUTION_UNCONFIGURED', action.path, 'Declare execution resources and writable paths')] };
  const scope = action.attributes.operation_scope;
  if (!scope || !isWriteScopeContained(scope.paths, execution.writable_paths, ['PROJECT.md', state.planPath])
    || execution.resources.some(name => !scope.resources.includes(name))) {
    issues.push(issue('EXECUTION_SCOPE_NOT_APPROVED', action.path, 'Execution paths and resources must fit the approved Action scope'));
  }
  if (!isWriteScopeContained(state.plan.writable_paths, execution.writable_paths, ['PROJECT.md', state.planPath])) {
    issues.push(issue('WRITE_SCOPE_NOT_IN_ACTIVE_PLAN', action.path, 'Execution writes exceed the Active Plan ceiling'));
  }
  const active = [...state.records.values()].filter(value => value.type === 'action' && value.id !== action.id && value.attributes.status === 'in_progress');
  for (const other of active) {
    try { assertValid(other); }
    catch (error) { issues.push(issue('ACTIVE_ACTION_INVALID', other.path, error.message)); continue; }
    const overlap = execution.resources.filter(name => other.attributes.execution?.resources.includes(name));
    if (overlap.length) issues.push(issue('RESOURCE_CONFLICT', other.path, `Resources already claimed by ${other.id}: ${overlap.join(', ')}`));
  }
  const writers = [
    ...state.plan.background_register.filter(value => value.action_id !== action.id),
    ...active.filter(value => value.attributes.execution).map(value => ({ id: value.id, owner: value.attributes.writer, status: 'running', writable_paths: value.attributes.execution.writable_paths }))
  ];
  if (findWriterConflicts(writers, execution.writable_paths).length) issues.push(issue('WRITER_CONFLICT', action.path, 'Execution paths overlap an active writer'));
  for (const name of execution.resources) {
    if (!Object.hasOwn(state.project.resources, name)) issues.push(issue('RESOURCE_NOT_REGISTERED', action.path, `Resource not registered: ${name}`));
    else if (state.project.resources[name].role !== 'compute') issues.push(issue('RESOURCE_NOT_COMPUTE', action.path, `Execution lane ${name} must be registered with role compute`));
  }
  const observed = claiming ? observation : observation ?? execution.resource_observation;
  if (execution.resources.length) {
    const invalid = observationIssues(observed, action, state.project, claiming);
    issues.push(...invalid);
    if (!invalid.length) {
      for (const name of execution.resources) if (!observed.available.includes(name)) issues.push(issue('RESOURCE_UNAVAILABLE', action.path, `Requested resource is unavailable: ${name}`));
    }
  }
  if (claiming && action.attributes.status !== 'ready') issues.push(issue('ACTION_NOT_CLAIMABLE', action.path, 'Only a ready Action can obtain a new execution claim'));
  return { ok: !issues.length, actionId: action.id, issues };
}

/** Shared checks for foreground preflight and registered background execution. */
export async function inspectExecution(projectRoot, actionId, options = {}) {
  const state = await loadState(projectRoot);
  return deepFreeze(await evaluate(projectRoot, oneRecord(state.records, actionId, 'action'), state, options));
}

/** Lists are derived from canonical Actions; there is no parallel task-status store. */
export async function deriveExecutionReadiness(projectRoot, options = {}) {
  const state = await loadState(projectRoot);
  const result = { runnable: [], active: [], waiting: [] };
  for (const action of [...state.records.values()].filter(value => value.type === 'action').sort((a, b) => a.id.localeCompare(b.id, 'en'))) {
    assertValid(action);
    if (action.attributes.status === 'in_progress') { result.active.push({ id: action.id, path: action.path, resources: action.attributes.execution.resources }); continue; }
    if (action.attributes.status !== 'ready') continue;
    const report = await evaluate(projectRoot, action, state, options);
    result[report.ok ? 'runnable' : 'waiting'].push({ id: action.id, path: action.path, issues: report.issues });
  }
  return deepFreeze(result);
}

async function publishRecord(projectRoot, state, record, attributes, kind, extraInputs = []) {
  const before = state.snapshots.find(value => value.path === record.path).before;
  const body = parseMarkdownDocument(before, record.path).body;
  assertValid({ ...record, attributes });
  await publishProjectChanges(projectRoot, [{ path: record.path, before, after: serializeMarkdownDocument(attributes, body) }], {
    kind,
    expectedInputs: [...state.snapshots, ...extraInputs],
    expectedActionPaths: [...state.records.values()].filter(value => value.type === 'action').map(value => value.path).sort()
  });
  return deepFreeze({ ...record, attributes });
}

/** Claim only the requested lanes after a fresh observation and serialized authority recheck. */
export async function claimExecution(projectRoot, actionId, observation) {
  const state = await loadState(projectRoot);
  const action = oneRecord(state.records, actionId, 'action');
  const report = await evaluate(projectRoot, action, state, { observation, claiming: true });
  if (!report.ok) throw new ResearchOSError('EXECUTION_BLOCKED', report.issues.map(value => `${value.code}: ${value.message}`).join('; '), report.issues);
  const at = nextTime(action.attributes.updated);
  const attributes = {
    ...action.attributes, status: 'in_progress', updated: at,
    execution: { ...action.attributes.execution, resource_observation: observation ?? null },
    status_history: [...action.attributes.status_history, { from: 'ready', to: 'in_progress', at, reason: 'Dependencies, resources, and writer scope checked at execution claim.' }]
  };
  const files = action.attributes.dependencies.map(id => oneRecord(state.records, id)).filter(value => value.type === 'artifact').map(value => ({ path: value.attributes.file, sha256: value.attributes.sha256 }));
  return publishRecord(projectRoot, state, action, attributes, 'execution-claim', files);
}

/** Acceptance freezes the exact existing file version; producer completion is independent. */
export async function acceptArtifact(projectRoot, artifactId, acceptance) {
  if (!acceptance || Object.keys(acceptance).sort().join(',') !== 'actor,evidence'
    || ['actor', 'evidence'].some(key => typeof acceptance[key] !== 'string' || !acceptance[key].trim())) {
    throw new ResearchOSError('USAGE', 'Artifact acceptance requires an actor and evidence');
  }
  const state = await loadState(projectRoot);
  const artifact = oneRecord(state.records, artifactId, 'artifact');
  if (artifact.attributes.status !== 'review') throw new ResearchOSError('VALIDATION', 'Only an Artifact in review can be accepted; accepted versions are immutable');
  const producer = oneRecord(state.records, artifact.attributes.producer_action, 'action');
  if (!isWriteScopeContained(producer.attributes.operation_scope?.paths ?? [], [artifact.attributes.file])) throw new ResearchOSError('VALIDATION', 'Artifact file is outside the producer Action scope');
  const sha256 = await fileDigest(projectRoot, artifact.attributes.file);
  const verified = nextTime(artifact.attributes.updated);
  const at = nextTime(verified);
  const attributes = {
    ...artifact.attributes, status: 'closed', updated: at, verified_at: verified, sha256,
    acceptance: { ...acceptance, at: verified },
    status_history: [...artifact.attributes.status_history,
      { from: 'review', to: 'verified', at: verified, reason: acceptance.evidence },
      { from: 'verified', to: 'closed', at, reason: `Accepted exact file version by ${acceptance.actor}.` }]
  };
  return publishRecord(projectRoot, state, artifact, attributes, 'artifact-acceptance', [{ path: artifact.attributes.file, sha256 }]);
}
