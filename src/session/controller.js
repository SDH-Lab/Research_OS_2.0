import { assertActionCanStart } from '../actions/workflow.js';
import { validateArtifactDependency, inspectExecution } from './execution.js';
import { assertProjectTransactionClear, publishProjectChanges } from '../project/rebaseline.js';
import { actionAttention } from './attention.js';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readUtf8, safeJoin, writeUtf8Atomic } from '../lib/fs.js';
import { ResearchOSError } from '../lib/errors.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../lib/markdown.js';
import { deepFreeze } from '../lib/readonly.js';
import { discoverRecordCandidates, discoverRecords } from '../records/catalog.js';
import { isCanonicalRecordLocation, schemaForRecordType, validateRecord, validateStatusHistory } from '../validation/validator.js';
import { validateExecPlanControls } from './exec-plan-controls.js';
import { findWriterConflicts, isWriteScopeContained, normalizeProjectRelative } from './write-scope.js';

const OPEN_STATUSES = new Set(['inbox', 'defined', 'ready', 'in_progress', 'review', 'verified', 'reopened']);
const CLAIMABLE_ACTION_STATUSES = new Set(['ready', 'in_progress', 'reopened']);
const REGISTRATION_KINDS = new Set(['session', 'experiment', 'subagent', 'audit', 'check']);
const REGISTRATION_STATUSES = new Set(['registered', 'running', 'blocked', 'candidate_ready', 'accepted', 'closed', 'cancelled']);
const ACTIVE_REGISTRATION_STATUSES = new Set(['registered', 'running', 'blocked', 'candidate_ready']);
const BACKGROUND_TRANSITIONS = Object.freeze({
  registered: Object.freeze(['running', 'blocked', 'candidate_ready', 'cancelled']),
  running: Object.freeze(['blocked', 'candidate_ready', 'cancelled']),
  blocked: Object.freeze(['running', 'candidate_ready', 'cancelled']),
  candidate_ready: Object.freeze(['blocked', 'accepted', 'cancelled']),
  accepted: Object.freeze(['closed']),
  closed: Object.freeze([]),
  cancelled: Object.freeze([])
});
const IMMUTABLE_REGISTRATION_FIELDS = Object.freeze([
  'kind', 'task_id', 'purpose', 'action_id', 'readable_paths', 'writable_paths',
  'forbidden_changes', 'expected_artifacts', 'acceptance', 'owner', 'receiver'
]);
const ID = /^[A-Z]+-[0-9]{3,}$/u;

/**
 * @typedef {Object} SessionContext
 * @property {string} projectId
 * @property {string|null} foregroundObjective
 * @property {Readonly<Record<string, unknown>>} activePlan
 * @property {string} nextAction
 * @property {ReadonlyArray<string>} blockers
 * @property {Readonly<Record<string, unknown>>} resumePoint
 * @property {ReadonlyArray<string>} writablePaths
 * @property {ReadonlyArray<string>} authoritativeSources
 */

/**
 * @typedef {Object} PreflightReport
 * @property {'READY'|'BLOCKED'} status
 * @property {boolean} ok
 * @property {string} actionId
 * @property {ReadonlyArray<string>} dependencies
 * @property {ReadonlyArray<string>} resources
 * @property {ReadonlyArray<object>} writerConflicts
 * @property {ReadonlyArray<object>} unknowns
 * @property {ReadonlyArray<object>} issues
 */

function validationError(subject, issues) {
  return new ResearchOSError('VALIDATION', `${subject} failed validation: ${issues.map(item => `${item.path} ${item.message}`).join('; ')}`, issues);
}

function assertValidRecord(schema, attributes, path) {
  const issues = [...validateRecord(schema, attributes), ...validateStatusHistory(attributes, path)];
  if (issues.length > 0) throw validationError(path, issues);
}

function assertValidExecPlanControls(attributes, planPath, project) {
  const issues = validateExecPlanControls(attributes, planPath, project);
  if (issues.length > 0) throw validationError(planPath, issues);
}

function nextUpdated(previousUpdated) {
  const previous = Date.parse(previousUpdated);
  const now = Date.now();
  return new Date(Math.max(now, Number.isNaN(previous) ? now : previous + 1)).toISOString();
}

function requireObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new ResearchOSError('USAGE', `${label} must be an object`);
}

function assertExactKeys(value, keys, label) {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const expected = [...keys].sort((left, right) => left.localeCompare(right, 'en'));
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ResearchOSError('USAGE', `${label} fields must be exactly: ${expected.join(', ')}`);
  }
}

function assertString(value, label, { nonempty = true } = {}) {
  if (typeof value !== 'string' || (nonempty && value.trim().length === 0) || /[\0\r\n\u2028\u2029]/u.test(value)) {
    throw new ResearchOSError('USAGE', `${label} must be ${nonempty ? 'a non-empty ' : 'a '}single-line string`);
  }
}

function assertStringArray(value, label, { nonemptyItems = true } = {}) {
  if (!Array.isArray(value)) throw new ResearchOSError('USAGE', `${label} must be a string array`);
  for (const [index, item] of value.entries()) assertString(item, `${label}[${index}]`, { nonempty: nonemptyItems });
}

function publicResumePoint(value) {
  return {
    lastVerifiedPoint: value.last_verified_point,
    nextAction: value.next_action,
    nextCommandOrEdit: value.next_command_or_edit,
    requiredFiles: [...value.required_files],
    risks: [...value.risks],
    reforecastTrigger: value.reforecast_trigger
  };
}

function persistedResumePoint(value) {
  requireObject(value, 'resumePoint');
  assertExactKeys(value, ['lastVerifiedPoint', 'nextAction', 'nextCommandOrEdit', 'requiredFiles', 'risks', 'reforecastTrigger'], 'resumePoint');
  assertString(value.lastVerifiedPoint, 'resumePoint.lastVerifiedPoint');
  if (typeof value.nextAction !== 'string' || value.nextAction.trim().length === 0 || /[\0\r\n\u2028\u2029]/u.test(value.nextAction)) {
    throw new ResearchOSError('RESUME_POINT_MISSING', 'resumePoint.nextAction must be an exact non-empty single-line action');
  }
  if (value.nextCommandOrEdit !== null) assertString(value.nextCommandOrEdit, 'resumePoint.nextCommandOrEdit', { nonempty: false });
  assertStringArray(value.requiredFiles, 'resumePoint.requiredFiles');
  assertStringArray(value.risks, 'resumePoint.risks');
  if (value.reforecastTrigger !== null) assertString(value.reforecastTrigger, 'resumePoint.reforecastTrigger', { nonempty: false });
  return {
    last_verified_point: value.lastVerifiedPoint,
    next_action: value.nextAction,
    next_command_or_edit: value.nextCommandOrEdit,
    required_files: [...value.requiredFiles],
    risks: [...value.risks],
    reforecast_trigger: value.reforecastTrigger
  };
}

async function loadControlPlane(projectRoot) {
  await assertProjectTransactionClear(projectRoot);
  await readUtf8(safeJoin(projectRoot, 'AGENTS.md'));
  const projectDocument = parseMarkdownDocument(await readUtf8(safeJoin(projectRoot, 'PROJECT.md')), 'PROJECT.md');
  assertValidRecord('project', projectDocument.attributes, 'PROJECT.md');
  let planPath;
  try {
    planPath = normalizeProjectRelative(projectDocument.attributes.active_plan);
  } catch {
    throw new ResearchOSError('MISSING_ACTIVE_PLAN', `PROJECT.active_plan is not a safe canonical path: ${String(projectDocument.attributes.active_plan)}`);
  }
  let planDocument;
  try {
    planDocument = parseMarkdownDocument(await readUtf8(safeJoin(projectRoot, planPath)), planPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new ResearchOSError('MISSING_ACTIVE_PLAN', `Active ExecPlan does not exist: ${planPath}`);
    throw error;
  }
  const schemaIssues = validateRecord('exec-plan', planDocument.attributes);
  if (schemaIssues.length > 0) throw validationError(planPath, schemaIssues);
  if (planDocument.attributes.type !== 'exec_plan' || !OPEN_STATUSES.has(planDocument.attributes.status)) {
    throw new ResearchOSError('MISSING_ACTIVE_PLAN', `PROJECT.active_plan is not an open ExecPlan: ${planPath}`);
  }
  const historyIssues = validateStatusHistory(planDocument.attributes, planPath);
  if (historyIssues.length > 0) throw validationError(planPath, historyIssues);
  assertValidExecPlanControls(planDocument.attributes, planPath, projectDocument.attributes);
  const records = await discoverRecords(projectRoot);
  const openPlans = [...records.values()].filter(record => record.type === 'exec_plan' && OPEN_STATUSES.has(record.attributes.status));
  if (openPlans.length !== 1 || openPlans[0].path !== planPath) {
    throw new ResearchOSError('MULTIPLE_ACTIVE_PLANS', `Expected exactly one open Active ExecPlan; found ${openPlans.length}`);
  }
  await assertProjectTransactionClear(projectRoot);
  return { projectDocument, planDocument, planPath };
}

function contextFromControl({ projectDocument, planDocument, planPath }) {
  const project = projectDocument.attributes;
  const plan = planDocument.attributes;
  const context = {
    activePlan: { id: plan.id, path: planPath, completion_conditions: plan.completion_conditions,
      scope: plan.scope, out_of_scope: plan.out_of_scope, risks: plan.risks, disruption_mode: plan.disruption_mode,
      writable_paths: plan.writable_paths, background_register: plan.background_register.filter(item => !['closed', 'cancelled'].includes(item.status)) },
    latestCheckpoint: plan.latest_checkpoint,
    authoritativeSources: ['AGENTS.md', 'PROJECT.md', planPath],
    blockers: [...plan.blockers],
    foregroundObjective: project.foreground_objective,
    nextAction: plan.resume_point.next_action,
    projectId: project.project_id,
    resumePoint: publicResumePoint(plan.resume_point),
    writablePaths: [...plan.writable_paths]
  };
  return deepFreeze(context);
}

/**
 * Rebuild all information needed to resume a Session without using chat history.
 * @param {string} projectRoot
 * @returns {Promise<Readonly<SessionContext>>}
 */
export async function getSessionContext(projectRoot) {
  const control = await loadControlPlane(projectRoot);
  const context = contextFromControl(control);
  const records = await discoverRecords(projectRoot);
  const actions = [...records.values()].filter(record => record.type === 'action' && !['closed', 'cancelled', 'superseded', 'deferred'].includes(record.attributes.status));
  const attention = actionAttention(records, control.projectDocument.attributes.forecast_settings.as_of);
  return deepFreeze({ ...context,
    actions: actions.map(record => ({ id: record.id, path: record.path, status: record.attributes.status,
      purpose: record.attributes.purpose, nextStep: record.attributes.next_step })),
    attention,
    blockers: [...context.blockers, ...attention.filter(item => item.code === 'ACTION_BLOCKED').map(item => `${item.actionId}: ${item.message}`)]
  });
}

function assertClaim(claim) {
  requireObject(claim, 'claim');
  assertExactKeys(claim, ['actionId', 'dependencies', 'resources', 'writablePaths', 'unknowns'], 'claim');
  assertString(claim.actionId, 'claim.actionId');
  if (!ID.test(claim.actionId)) throw new ResearchOSError('USAGE', 'claim.actionId must be a canonical ID');
  assertStringArray(claim.dependencies, 'claim.dependencies');
  assertStringArray(claim.resources, 'claim.resources');
  if (claim.dependencies.some(id => !ID.test(id))) throw new ResearchOSError('USAGE', 'claim.dependencies must contain canonical IDs');
  if (claim.resources.some(name => !/^[a-z][a-z0-9_-]*$/u.test(name))) throw new ResearchOSError('USAGE', 'claim.resources must contain registered resource names');
  assertStringArray(claim.writablePaths, 'claim.writablePaths');
  findWriterConflicts([], claim.writablePaths);
  if (!Array.isArray(claim.unknowns)) throw new ResearchOSError('USAGE', 'claim.unknowns must be an array');
  for (const [index, unknown] of claim.unknowns.entries()) {
    requireObject(unknown, `claim.unknowns[${index}]`);
    assertExactKeys(unknown, ['description', 'impact'], `claim.unknowns[${index}]`);
    assertString(unknown.description, `claim.unknowns[${index}].description`);
    if (!['low', 'medium', 'high'].includes(unknown.impact)) throw new ResearchOSError('USAGE', `claim.unknowns[${index}].impact must be low, medium, or high`);
  }
}

function preflightIssue(code, path, message) {
  return { code, path, message };
}

async function resolveActionAuthority(projectRoot, actionId, records) {
  const canonicalPath = `plans/actions/${actionId}.md`;
  let document;
  try {
    document = parseMarkdownDocument(await readUtf8(safeJoin(projectRoot, canonicalPath)), canonicalPath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return { issue: preflightIssue('ACTION_INVALID', canonicalPath, `Claimed Action cannot be parsed: ${error.message}`), record: null };
    }
  }
  const matches = [...records.values()].filter(record => record.id === actionId);
  if (document) {
    const record = { id: document.attributes.id, type: document.attributes.type, path: canonicalPath, attributes: document.attributes };
    if (document.attributes.id !== actionId || document.attributes.type !== 'action' || !isCanonicalRecordLocation(record)) {
      return { issue: preflightIssue('ACTION_INVALID', canonicalPath, 'Canonical Action path must contain the matching Action identity and type'), record: null };
    }
    const actionIssues = [...validateRecord('action', record.attributes), ...validateStatusHistory(record.attributes, record.path)];
    if (actionIssues.length > 0) {
      return {
        issue: preflightIssue('ACTION_INVALID', record.path, `Claimed Action is invalid: ${actionIssues.map(item => `${item.path} ${item.message}`).join('; ')}`),
        record: null
      };
    }
    if (matches.length > 1) {
      return { issue: preflightIssue('ACTION_AMBIGUOUS', `record:${actionId}`, `Claimed Action ID resolves to multiple records: ${actionId}`), record: null };
    }
    return { issue: null, record };
  }
  if (matches.length > 1) {
    return { issue: preflightIssue('ACTION_AMBIGUOUS', `record:${actionId}`, `Claimed Action ID resolves to multiple records: ${actionId}`), record: null };
  }
  if (matches.length === 1) {
    return { issue: preflightIssue('ACTION_INVALID', matches[0].path, `Claimed Action is outside its canonical path: ${canonicalPath}`), record: null };
  }
  return { issue: preflightIssue('ACTION_NOT_FOUND', `record:${actionId}`, `Claimed Action does not exist: ${actionId}`), record: null };
}

/**
 * Check a foreground Action claim against canonical project state and registered writers.
 * @param {string} projectRoot
 * @param {Record<string, unknown>} claim
 * @returns {Promise<Readonly<PreflightReport>>}
 */
export async function preflightSession(projectRoot, claim) {
  assertClaim(claim);
  const control = await loadControlPlane(projectRoot);
  const context = contextFromControl(control);
  const [records, candidates] = await Promise.all([discoverRecords(projectRoot), discoverRecordCandidates(projectRoot)]);
  const actionAuthority = await resolveActionAuthority(projectRoot, claim.actionId, records);
  const action = actionAuthority.record;
  const activeActionWriters = [...records.values()].filter(record => record.type === 'action' && record.id !== claim.actionId && record.attributes.status === 'in_progress' && record.attributes.execution)
    .map(record => ({ id: record.id, owner: record.attributes.writer, status: 'running', writable_paths: record.attributes.execution.writable_paths }));
  const writerConflicts = findWriterConflicts([...context.activePlan.background_register, ...activeActionWriters], claim.writablePaths);
  const issues = [];

  if (typeof context.foregroundObjective !== 'string' || context.foregroundObjective.trim().length === 0 || context.foregroundObjective === 'Not set') {
    issues.push(preflightIssue('FOREGROUND_OBJECTIVE_MISSING', 'PROJECT.md#/foreground_objective', 'Set one foreground objective before claiming work'));
  }
  if (!action) {
    issues.push(actionAuthority.issue);
  } else {
    if (!CLAIMABLE_ACTION_STATUSES.has(action.attributes.status)) {
      issues.push(preflightIssue('ACTION_NOT_CLAIMABLE', `${action.path}#/status`, `Action status is not claimable: ${action.attributes.status}`));
    }
    try { assertActionCanStart(action.attributes); }
    catch (error) { issues.push(preflightIssue('ACTION_WORKFLOW', action.path, error.message)); }
    const scope = action.attributes.operation_scope;
    if (!scope || !isWriteScopeContained(scope.paths, claim.writablePaths, ['PROJECT.md', control.planPath]) || claim.resources.some(name => !scope.resources.includes(name))) {
      issues.push(preflightIssue('ACTION_SCOPE_NOT_APPROVED', action.path, 'Claim exceeds the approved Action paths or resources'));
    }
    const allocation = action.attributes.execution;
    if (!allocation || !isWriteScopeContained(allocation.writable_paths, claim.writablePaths, ['PROJECT.md', control.planPath])
      || claim.resources.some(name => control.projectDocument.attributes.resources[name]?.role === 'compute' && !allocation.resources.includes(name))) {
      issues.push(preflightIssue('EXECUTION_SCOPE_NOT_CLAIMED', action.path, 'Claim paths and compute lanes must fit the Action execution allocation'));
    }
    const declared = [...action.attributes.dependencies].sort((left, right) => left.localeCompare(right, 'en'));
    const claimed = [...claim.dependencies].sort((left, right) => left.localeCompare(right, 'en'));
    if (declared.length !== claimed.length || declared.some((id, index) => id !== claimed[index])) {
      issues.push(preflightIssue('DEPENDENCY_CLAIM_MISMATCH', `${action.path}#/dependencies`, 'Claim dependencies must exactly match the Action dependencies'));
    }
  }
  for (const dependency of claim.dependencies) {
    const dependencyMatches = [...records.values()].filter(record => record.id === dependency);
    const namedDependencyCandidates = candidates.filter(candidate => candidate.path.split('/').at(-1) === `${dependency}.md`);
    if (dependencyMatches.length === 0) {
      if (namedDependencyCandidates.length > 0) {
        const invalid = namedDependencyCandidates[0];
        const reason = invalid.document ? 'Dependency candidate identity does not match its canonical filename' : `Dependency candidate cannot be parsed: ${invalid.error.message}`;
        issues.push(preflightIssue('DEPENDENCY_INVALID', invalid.path, reason));
      } else {
        issues.push(preflightIssue('DEPENDENCY_MISSING', `record:${dependency}`, `Dependency does not exist: ${dependency}`));
      }
      continue;
    }
    if (dependencyMatches.length > 1) {
      issues.push(preflightIssue('DEPENDENCY_AMBIGUOUS', `record:${dependency}`, `Dependency ID resolves to multiple records: ${dependency}`));
      continue;
    }
    const dependencyRecord = dependencyMatches[0];
    const schema = schemaForRecordType(dependencyRecord.type);
    let dependencyIssues = [];
    if (!schema) dependencyIssues = [{ path: '/', message: `Unknown canonical record type: ${dependencyRecord.type}` }];
    else dependencyIssues = [...validateRecord(schema, dependencyRecord.attributes), ...validateStatusHistory(dependencyRecord.attributes, dependencyRecord.path)];
    if (!isCanonicalRecordLocation(dependencyRecord)) {
      issues.push(preflightIssue('DEPENDENCY_INVALID', dependencyRecord.path, `Dependency is outside its canonical location: ${dependency}`));
    } else if (dependencyIssues.length > 0) {
      issues.push(preflightIssue('DEPENDENCY_INVALID', dependencyRecord.path, `Dependency is invalid: ${dependencyIssues.map(item => `${item.path} ${item.message}`).join('; ')}`));
    } else if (dependencyRecord.type === 'artifact') {
      issues.push(...await validateArtifactDependency(projectRoot, dependencyRecord, records));
    } else if (dependencyRecord.attributes.status !== 'closed') {
      issues.push(preflightIssue('DEPENDENCY_NOT_SATISFIED', dependencyRecord.path, `Dependency is valid but not closed: ${dependency}`));
    }
  }
  if (action) {
    const execution = await inspectExecution(projectRoot, action.id);
    issues.push(...execution.issues.filter(item => !item.code.startsWith('DEPENDENCY_') && !issues.some(other => other.code === item.code)));
  }
  for (const resource of claim.resources) {
    if (!Object.hasOwn(control.projectDocument.attributes.resources, resource)) {
      issues.push(preflightIssue('RESOURCE_NOT_REGISTERED', `PROJECT.md#/resources/${resource}`, `Required resource is not registered: ${resource}`));
    }
  }
  if (writerConflicts.length > 0) {
    issues.push(preflightIssue('WRITER_CONFLICT', `${context.activePlan.path}#/background_register`, 'Requested writable paths overlap an active registered writer'));
  }
  if (!isWriteScopeContained(context.activePlan.writable_paths, claim.writablePaths, ['PROJECT.md', context.activePlan.path])) {
    issues.push(preflightIssue('WRITE_SCOPE_NOT_IN_ACTIVE_PLAN', 'claim.writablePaths', 'Requested writable paths are not contained in Active Plan writable_paths'));
  }
  for (const [index, unknown] of claim.unknowns.entries()) {
    if (unknown.impact === 'high') issues.push(preflightIssue('HIGH_IMPACT_UNKNOWN', `claim.unknowns[${index}]`, unknown.description));
  }

  return deepFreeze({
    status: issues.length === 0 ? 'READY' : 'BLOCKED',
    ok: issues.length === 0,
    actionId: claim.actionId,
    dependencies: [...claim.dependencies],
    resources: [...claim.resources],
    writerConflicts,
    unknowns: claim.unknowns.map(item => ({ ...item })),
    issues
  });
}

function assertRegistration(registration) {
  requireObject(registration, 'registration');
  const keys = [
    'kind', 'task_id', 'purpose', 'action_id', 'readable_paths', 'writable_paths',
    'forbidden_changes', 'expected_artifacts', 'acceptance', 'owner', 'status', 'blockers', 'receiver'
  ];
  assertExactKeys(registration, keys, 'registration');
  if (!REGISTRATION_KINDS.has(registration.kind)) throw new ResearchOSError('USAGE', `Unsupported background kind: ${String(registration.kind)}`);
  if (!REGISTRATION_STATUSES.has(registration.status)) throw new ResearchOSError('USAGE', `Unsupported background status: ${String(registration.status)}`);
  for (const field of ['task_id', 'purpose', 'action_id', 'acceptance', 'owner', 'receiver']) assertString(registration[field], `registration.${field}`);
  if (!ID.test(registration.action_id)) throw new ResearchOSError('USAGE', 'registration.action_id must be a canonical ID');
  for (const field of ['readable_paths', 'writable_paths']) {
    assertStringArray(registration[field], `registration.${field}`);
    findWriterConflicts([], registration[field]);
  }
  for (const field of ['forbidden_changes', 'blockers']) assertStringArray(registration[field], `registration.${field}`);
  assertStringArray(registration.expected_artifacts, 'registration.expected_artifacts');
  for (const path of registration.expected_artifacts) {
    normalizeProjectRelative(path);
    if (path.includes('*')) throw new ResearchOSError('USAGE', `registration.expected_artifacts must contain exact paths: ${path}`);
  }
}

async function archivedBackground(projectRoot) {
  let files;
  try { files = await readdir(safeJoin(projectRoot, 'plans/logs')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const file of files.filter(file => file.endsWith('.json'))) {
    const entry = JSON.parse(await readUtf8(safeJoin(projectRoot, `plans/logs/${file}`)));
    records.push(...(entry.completedBackground ?? []));
  }
  return records;
}

function nextBackgroundId(registrations) {
  const maximum = registrations.reduce((current, registration) => {
    const match = typeof registration.id === 'string' && registration.id.match(/^BG-([0-9]+)$/u);
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `BG-${String(maximum + 1).padStart(3, '0')}`;
}

function sameAuthorityValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertRegistrationUpdate(current, registration) {
  for (const field of IMMUTABLE_REGISTRATION_FIELDS) {
    if (!sameAuthorityValue(current[field], registration[field])) {
      throw new ResearchOSError('VALIDATION', `Background task ${registration.task_id} cannot change immutable dispatch field ${field}; create a new task_id`);
    }
  }
  if (current.status !== registration.status && !BACKGROUND_TRANSITIONS[current.status]?.includes(registration.status)) {
    throw new ResearchOSError('VALIDATION', `Illegal background status transition: ${current.status}->${registration.status}`);
  }
}

function markdownInline(value) {
  return String(value)
    .replace(/[\r\n\u2028\u2029]+/gu, ' ')
    .replace(/([\\`*_[\]{}<>#|])/gu, '\\$1');
}

function listLines(values, empty = 'None recorded.') {
  if (values.length === 0) return `- ${empty}`;
  return values.map(value => `- ${markdownInline(value)}`).join('\n');
}

export function renderPlanBody(attributes) {
  const background = attributes.background_register.map(item => `${item.id} — ${item.status} — ${item.purpose}`);
  const resume = attributes.resume_point;
  return `# Active ExecPlan: ${markdownInline(attributes.id)}\n\n` +
    `Objective: see [PROJECT.md](../PROJECT.md).\n\n` +
    `## Completion conditions\n\n${listLines(attributes.completion_conditions)}\n\n` +
    `## Scope\n\n${listLines(attributes.scope)}\n\n` +
    `## Out of scope\n\n${listLines(attributes.out_of_scope)}\n\n` +
    `## Current work\n\n${markdownInline(resume.next_action)}\n\n` +
    `## Blockers\n\n${listLines(attributes.blockers)}\n\n` +
    `## Background work\n\n${listLines(background)}\n\n` +
    `## Resume point\n\nLast verified: ${markdownInline(resume.last_verified_point)}\n\n` +
    `Next command/edit: ${markdownInline(resume.next_command_or_edit ?? 'none')}\n\n` +
    `Required files: ${resume.required_files.map(markdownInline).join(', ') || 'none'}\n\n` +
    `Risks: ${listLines(resume.risks)}\n\n` +
    `## History\n\n${attributes.latest_checkpoint ?? 'No checkpoint yet.'}\n`;
}

async function savePlan(projectRoot, control, attributes) {
  assertValidRecord('exec-plan', attributes, control.planPath);
  assertValidExecPlanControls(attributes, control.planPath, control.projectDocument.attributes);
  await writeUtf8Atomic(safeJoin(projectRoot, control.planPath), serializeMarkdownDocument(attributes, renderPlanBody(attributes)));
}

/**
 * Register bounded background work and acquire its canonical write scope.
 * @param {string} projectRoot
 * @param {Record<string, unknown>} registration
 * @returns {Promise<string>}
 */
export async function registerBackgroundWork(projectRoot, registration) {
  assertRegistration(registration);
  const control = await loadControlPlane(projectRoot);
  const plan = control.planDocument.attributes;
  const records = await discoverRecords(projectRoot);
  const actionAuthority = await resolveActionAuthority(projectRoot, registration.action_id, records);
  if (!actionAuthority.record) throw new ResearchOSError('VALIDATION', actionAuthority.issue.message, [actionAuthority.issue]);
  const action = actionAuthority.record;
  if (ACTIVE_REGISTRATION_STATUSES.has(registration.status)) {
    if (action.attributes.status !== 'in_progress') throw new ResearchOSError('VALIDATION', 'Claim the Action before starting active background execution; expected in_progress');
    if (!isWriteScopeContained(action.attributes.operation_scope?.paths ?? [], registration.writable_paths, ['PROJECT.md', control.planPath])) throw new ResearchOSError('VALIDATION', 'Background writes exceed approved Action scope');
    if (!isWriteScopeContained(action.attributes.execution?.writable_paths ?? [], registration.writable_paths, ['PROJECT.md', control.planPath])) throw new ResearchOSError('VALIDATION', 'Background writes exceed the claimed execution allocation');
    if (['registered', 'running'].includes(registration.status)) {
      const execution = await inspectExecution(projectRoot, action.id);
      if (!execution.ok) throw new ResearchOSError('VALIDATION', execution.issues.map(item => `${item.code}: ${item.message}`).join('; '), execution.issues);
    }
  }
  const currentIndex = plan.background_register.findIndex(item => item.task_id === registration.task_id);
  const current = currentIndex >= 0 ? plan.background_register[currentIndex] : null;
  const archived = await archivedBackground(projectRoot);
  if (!current && archived.some(item => item.task_id === registration.task_id)) throw new ResearchOSError('VALIDATION', 'Completed background task requires a new task_id');
  if (current) assertRegistrationUpdate(current, registration);
  if ((!current || ACTIVE_REGISTRATION_STATUSES.has(registration.status)) && !CLAIMABLE_ACTION_STATUSES.has(action.attributes.status)) {
    throw new ResearchOSError('VALIDATION', `Active background work requires a claimable Action; found ${action.attributes.status}`);
  }
  if (!isWriteScopeContained(registration.writable_paths, registration.expected_artifacts, ['PROJECT.md', control.planPath])) {
    throw new ResearchOSError('VALIDATION', 'Every expected Artifact must be inside registration.writable_paths');
  }
  if ((!current || ACTIVE_REGISTRATION_STATUSES.has(registration.status)) && !isWriteScopeContained(plan.writable_paths, registration.writable_paths, ['PROJECT.md', control.planPath])) {
    throw new ResearchOSError('VALIDATION', 'New or active background writable_paths must be contained in Active Plan writable_paths');
  }
  const otherRegistrations = currentIndex >= 0
    ? plan.background_register.filter((_, index) => index !== currentIndex)
    : plan.background_register;
  const conflicts = ACTIVE_REGISTRATION_STATUSES.has(registration.status)
    ? findWriterConflicts(otherRegistrations, registration.writable_paths)
    : [];
  if (conflicts.length > 0) throw new ResearchOSError('CONFLICT', `Background write scope overlaps active writer(s): ${conflicts.map(item => item.id).join(', ')}`, conflicts);
  const at = nextUpdated(plan.updated);
  const id = current?.id ?? nextBackgroundId([...plan.background_register, ...archived]);
  const entry = current
    ? { ...current, status: registration.status, blockers: [...registration.blockers], updated_at: at }
    : {
        id,
        ...registration,
        readable_paths: [...registration.readable_paths],
        writable_paths: [...registration.writable_paths],
        forbidden_changes: [...registration.forbidden_changes],
        expected_artifacts: [...registration.expected_artifacts],
        blockers: [...registration.blockers],
        registered_at: at,
        updated_at: at,
        control_paths: ['PROJECT.md', control.planPath]
      };
  const backgroundRegister = current
    ? plan.background_register.map((item, index) => index === currentIndex ? entry : item)
    : [...plan.background_register, entry];
  const candidate = { ...plan, updated: at, background_register: backgroundRegister };
  await savePlan(projectRoot, control, candidate);
  return id;
}


function assertCheckpointUpdate(update) {
  requireObject(update, 'update');
  const allowed = ['progress', 'artifacts', 'discoveries', 'decisions', 'resumePoint'];
  const required = ['progress', 'artifacts', 'discoveries', 'decisions', 'resumePoint'];
  const actual = Object.keys(update);
  if (actual.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(update, key))) {
    throw new ResearchOSError('USAGE', `checkpoint update requires ${required.join(', ')}`);
  }
  for (const field of ['progress', 'artifacts', 'discoveries', 'decisions']) assertStringArray(update[field], `update.${field}`);
}

/**
 * Persist one end-of-Session checkpoint into the unique Active ExecPlan.
 * @param {string} projectRoot
 * @param {Record<string, unknown>} update
 * @returns {Promise<void>}
 */
export async function checkpointSession(projectRoot, update) {
  assertCheckpointUpdate(update);
  const resumePoint = persistedResumePoint(update.resumePoint);
  const control = await loadControlPlane(projectRoot);
  const plan = control.planDocument.attributes;
  const at = nextUpdated(plan.updated);
  const logPath = `plans/logs/${at.replaceAll(':', '-')}-${randomUUID()}.json`;
  const completedBackground = plan.background_register.filter(item => ['closed', 'cancelled'].includes(item.status));
  const candidate = { ...plan, updated: at, latest_checkpoint: logPath, resume_point: resumePoint,
    background_register: plan.background_register.filter(item => !['closed', 'cancelled'].includes(item.status)) };
  assertValidRecord('exec-plan', candidate, control.planPath);
  assertValidExecPlanControls(candidate, control.planPath, control.projectDocument.attributes);
  const entry = { at, planId: plan.id, previous: plan.latest_checkpoint, completedBackground, ...update };
  // Use exact persisted text for conflict checking; serialization can normalize whitespace.
  const original = await readUtf8(safeJoin(projectRoot, control.planPath));
  const parsed = parseMarkdownDocument(original, control.planPath);
  if (JSON.stringify(parsed.attributes) !== JSON.stringify(plan)) throw new ResearchOSError('CONFLICT', 'Active Plan changed before checkpoint');
  await publishProjectChanges(projectRoot, [
    { path: logPath, before: null, after: `${JSON.stringify(entry, null, 2)}\n` },
    { path: control.planPath, before: original, after: serializeMarkdownDocument(candidate, renderPlanBody(candidate)) }
  ], { kind: 'checkpoint' });
  return { path: logPath };

}

function assertDisruptionUpdate(update) {
  requireObject(update, 'update');
  assertExactKeys(update, ['status', 'capacityReduction', 'pausedActions', 'resumePoint'], 'disruption update');
  if (!['active', 'recovered'].includes(update.status)) throw new ResearchOSError('USAGE', 'disruption status must be active or recovered');
  assertString(update.capacityReduction, 'disruption capacityReduction');
  assertStringArray(update.pausedActions, 'disruption pausedActions');
  if (update.pausedActions.some(id => !ID.test(id))) throw new ResearchOSError('USAGE', 'disruption pausedActions must contain canonical IDs');
}

/**
 * Persist active or recovered disruption state through the Active ExecPlan checkpoint path.
 * @param {string} projectRoot
 * @param {Record<string, unknown>} update
 * @returns {Promise<void>}
 */
export async function checkpointDisruption(projectRoot, update) {
  assertDisruptionUpdate(update);
  const resumePoint = persistedResumePoint(update.resumePoint);
  const control = await loadControlPlane(projectRoot);
  const plan = control.planDocument.attributes;
  const candidate = {
    ...plan,
    updated: nextUpdated(plan.updated),
    resume_point: resumePoint,
    disruption_mode: {
      status: update.status,
      capacity_reduction: update.capacityReduction,
      paused_actions: [...update.pausedActions],
      ...resumePoint
    }
  };
  await savePlan(projectRoot, control, candidate);
}
