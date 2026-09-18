import { publishProjectChanges } from '../project/rebaseline.js';
import { ResearchOSError } from '../lib/errors.js';
import { readUtf8, safeJoin } from '../lib/fs.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../lib/markdown.js';
import { deepFreeze } from '../lib/readonly.js';
import { discoverRecords } from '../records/catalog.js';
import { normalizeWritePattern } from '../session/write-scope.js';
import { isValidDateTime, validateRecord } from '../validation/validator.js';

function fail(message) { throw new ResearchOSError('ACTION_WORKFLOW', message); }
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function scopeKey(scope) {
  if (!scope || !['operations', 'paths', 'resources'].every(key => Array.isArray(scope[key]))) return null;
  return JSON.stringify(['operations', 'paths', 'resources'].map(key => [...scope[key]].sort()));
}
function assertFields(value, allowed, required = allowed) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    fail(`Expected fields: ${required.join(', ')}; allowed fields: ${allowed.join(', ')}`);
  }
}
function assertValid(attributes) {
  const issues = validateRecord('action', attributes);
  if (issues.length) throw new ResearchOSError('VALIDATION', `Action failed validation: ${issues.map(item => `${item.path} ${item.message}`).join('; ')}`, issues);
  if (attributes.validation_plan && new Set(attributes.validation_plan.checks.map(check => check.id)).size !== attributes.validation_plan.checks.length) fail('Validation check IDs must be unique');
  if (new Set(attributes.blockers.map(blocker => blocker.id)).size !== attributes.blockers.length) fail('Blocker IDs must be unique');
  if (attributes.operation_scope) attributes.operation_scope.paths.forEach(normalizeWritePattern);
}
async function mutateAction(root, id, mutate) {
  const matches = [...(await discoverRecords(root)).values()].filter(record => record.id === id);
  if (matches.length !== 1 || matches[0].type !== 'action') fail(`Expected one Action record for ${id}`);
  const record = matches[0];
  const path = safeJoin(root, record.path);
  const original = await readUtf8(path);
  const document = parseMarkdownDocument(original, record.path);
  const attributes = structuredClone(document.attributes);
  assertValid(attributes);
  if (['closed', 'cancelled', 'superseded', 'deferred'].includes(attributes.status)) fail('Reopen the Action before changing its workflow');
  const at = new Date(Math.max(Date.now(), Date.parse(attributes.updated) + 1)).toISOString();
  const changed = mutate(attributes, at);
  if (changed !== false) {
    attributes.updated = at;
    assertValid(attributes);
    if (await readUtf8(path) !== original) throw new ResearchOSError('CONFLICT', 'Action changed during workflow update; reload before retrying');
    await publishProjectChanges(root, [{ path: record.path, before: original, after: serializeMarkdownDocument(attributes, document.body) }], { kind: 'action-workflow' });
  }
  return deepFreeze({ id, type: 'action', path: record.path, attributes });
}

/** Return the current candidate's check progress and reusable approval; never accept science automatically. */
export function inspectActionWorkflow(attributes) {
  const configured = nonempty(attributes.candidate_version) && ['scientific', 'implementation', 'presentation'].includes(attributes.validation_plan?.tier)
    && Array.isArray(attributes.validation_plan?.checks) && attributes.validation_plan.checks.length > 0
    && scopeKey(attributes.operation_scope) !== null;
  const checks = (attributes.validation_plan?.checks ?? []).map(check => {
    const results = (attributes.validation_checks ?? []).filter(result => result.candidate_version === attributes.candidate_version && result.check_id === check.id);
    const passed = results.some(result => result.outcome === 'pass');
    return { id: check.id, attempts: results.length, max_attempts: check.max_attempts, passed, exhausted: !passed && results.length >= check.max_attempts };
  });
  const passed = configured && checks.every(check => check.passed);
  const authorization_valid = configured && (attributes.scope_approvals ?? []).some(approval => scopeKey(approval.scope) === scopeKey(attributes.operation_scope));
  const active_blockers = (attributes.blockers ?? []).filter(blocker => blocker.status === 'active');
  const acceptance = attributes.validation_acceptance;
  const accepted = Boolean(acceptance && acceptance.candidate_version === attributes.candidate_version && nonempty(acceptance.accepted_by) && isValidDateTime(acceptance.accepted_at) && nonempty(acceptance.reason));
  return deepFreeze({ configured, candidate_version: attributes.candidate_version ?? null, checks, passed, authorization_valid,
    active_blockers: structuredClone(active_blockers),
    can_start: configured && authorization_valid && !passed && !checks.some(check => check.exhausted) && active_blockers.length === 0,
    can_close: passed && accepted && authorization_valid && active_blockers.length === 0 });
}

export function assertActionCanStart(attributes) {
  const state = inspectActionWorkflow(attributes);
  if (!state.configured) fail('Configure the Action candidate, necessary checks, attempt limits, and operation scope before starting');
  if (!state.authorization_valid) fail('Action operation scope needs an explicit approval');
  if (state.active_blockers.length) fail('Resolve active Action blockers before starting');
  if (state.checks.some(check => check.exhausted)) fail('Agreed validation attempts are exhausted; record a reasoned revision before continuing');
  if (state.passed) fail('Necessary checks already passed; stop checking and request acceptance');
  return state;
}

export function assertActionCanClose(attributes) {
  const state = inspectActionWorkflow(attributes);
  if (!state.passed) fail('All necessary checks must pass for the current candidate before closure');
  if (state.active_blockers.length) fail('Resolve active Action blockers before closure');
  if (!state.authorization_valid) fail('Current operation scope needs approval before closure');
  if (!state.can_close) fail('Closing requires explicit human acceptance of the current candidate');
  return state;
}

/** Define a bounded plan. A changed candidate or plan requires a recorded reason. */
export async function configureAction(root, id, definition) {
  assertFields(definition, ['candidate_version', 'validation_plan', 'operation_scope', 'reason'], ['candidate_version', 'validation_plan', 'operation_scope']);
  return mutateAction(root, id, (attributes, at) => {
    const previous = { candidate_version: attributes.candidate_version, validation_plan: attributes.validation_plan, operation_scope: attributes.operation_scope };
    const next = structuredClone({ candidate_version: definition.candidate_version, validation_plan: definition.validation_plan, operation_scope: definition.operation_scope });
    const configured = previous.candidate_version !== undefined;
    const changed = !same(previous, next);
    if (!changed) return false;
    if (configured && !nonempty(definition.reason)) fail('Changing the candidate, validation plan, or scope requires a reason');
    if (configured && previous.candidate_version === next.candidate_version) {
      for (const prior of previous.validation_plan.checks) {
        const replacement = next.validation_plan?.checks?.find(check => check.id === prior.id);
        if (!replacement || replacement.description !== prior.description || next.validation_plan.tier !== previous.validation_plan.tier) {
          fail('Changing check criteria requires a new candidate version and reason');
        }
      }
    }
    if (configured && previous.candidate_version !== next.candidate_version && (attributes.validation_revisions ?? []).some(revision => revision.candidate_version === next.candidate_version)) fail('Use a new candidate version; prior candidate evidence is immutable');
    attributes.validation_revisions ??= [];
    if (configured) attributes.validation_revisions.push({ ...previous, reason: definition.reason, at });
    Object.assign(attributes, next);
    attributes.validation_checks ??= [];
    attributes.scope_approvals ??= [];
    attributes.validation_acceptance = null;
    if (previous.candidate_version !== next.candidate_version && ['review', 'verified'].includes(attributes.status)) {
      attributes.status_history.push({ from: attributes.status, to: 'ready', at, reason: definition.reason });
      attributes.status = 'ready';
    }
    // The explicit revision is the decision to continue after a bounded failure.
    for (const blocker of attributes.blockers) {
      if (blocker.status !== 'active' || blocker.category !== 'validation' || !blocker.check_id) continue;
      const revisedCheck = next.validation_plan?.checks?.find(check => check.id === blocker.check_id);
      const oldCheck = previous.validation_plan?.checks?.find(check => check.id === blocker.check_id);
      if (next.candidate_version !== previous.candidate_version || (revisedCheck && oldCheck && revisedCheck.max_attempts > oldCheck.max_attempts)) {
        Object.assign(blocker, { status: 'resolved', resolved_at: at, resolution: definition.reason });
      }
    }
  });
}

/** Record one real check; attempts and evidence are never erased when revising a candidate. */
export async function recordActionCheck(root, id, check) {
  assertFields(check, ['check_id', 'candidate_version', 'outcome', 'evidence']);
  return mutateAction(root, id, (attributes, at) => {
    if (!['in_progress', 'review'].includes(attributes.status)) fail('Start the Action before recording checks; expected in_progress or review');
    if (check.candidate_version !== attributes.candidate_version) fail('Check candidate version must match the current candidate');
    const state = inspectActionWorkflow(attributes);
    const progress = state.checks.find(item => item.id === check.check_id);
    if (!progress) fail('Check must be declared in the validation plan');
    if (progress.passed) fail('Check already passed for this candidate; stop or record a reasoned candidate revision');
    if (progress.exhausted) fail('Agreed check attempts are exhausted; record a reasoned revision before continuing');
    assertActionCanStart(attributes);
    attributes.validation_checks.push({ ...check, at });
    attributes.validation_acceptance = null;
    if (check.outcome === 'fail' && progress.attempts + 1 === progress.max_attempts) {
      let index = 1;
      while (attributes.blockers.some(blocker => blocker.id === `VALIDATION-${index}`)) index += 1;
      attributes.blockers.push({ id: `VALIDATION-${index}`, category: 'validation', check_id: check.check_id, candidate_version: check.candidate_version,
        description: `Check ${check.check_id} exhausted its agreed ${progress.max_attempts} attempts.`, owner: attributes.writer || 'action-owner',
        since: at, review_at: null, next_unblock_action: 'Decide whether to revise the candidate or attempt budget, reduce scope, or pause.',
        status: 'active', resolved_at: null, root_cause: check.evidence, critical_path: true, resolution: null });
    }
  });
}

/** Store a grant only for the exact currently configured scope; existing grants remain auditable. */
export async function approveActionScope(root, id, approval) {
  assertFields(approval, ['grant_id', 'approver', 'reason']);
  return mutateAction(root, id, (attributes, at) => {
    if (!inspectActionWorkflow(attributes).configured) fail('Configure an operation scope before approving it');
    const existing = attributes.scope_approvals.find(item => item.grant_id === approval.grant_id);
    if (existing) {
      if (scopeKey(existing.scope) !== scopeKey(attributes.operation_scope) || existing.approver !== approval.approver) fail('Grant ID already records a different scope or approver; provide a new grant ID');
      return false;
    }
    attributes.scope_approvals.push({ ...approval, scope: structuredClone(attributes.operation_scope), approved_at: at });
  });
}

/** Append a stable blocker or resolve it in place, preserving its original cause and timestamps. */
export async function recordActionBlocker(root, id, change) {
  if (!change || !['create', 'resolve'].includes(change.operation)) fail('Blocker operation must be create or resolve');
  if (change.operation === 'create') assertFields(change, ['operation', 'id', 'category', 'description', 'owner', 'since', 'next_unblock_action', 'review_at', 'root_cause', 'critical_path']);
  else assertFields(change, ['operation', 'id', 'resolved_at', 'resolution'], ['operation', 'id', 'resolution']);
  return mutateAction(root, id, (attributes, at) => {
    const existing = attributes.blockers.find(blocker => blocker.id === change.id);
    if (change.operation === 'create') {
      if (existing) fail('Blocker ID already exists; preserve its history and use a new ID');
      const { operation, ...blocker } = change;
      attributes.blockers.push({ ...blocker, status: 'active', resolved_at: null, resolution: null });
    } else {
      if (!existing || existing.status !== 'active') fail('Only an active blocker can be resolved');
      if (existing.check_id && inspectActionWorkflow(attributes).checks.some(check => check.id === existing.check_id && check.exhausted)) fail('Validation attempts are exhausted; record a reasoned revision to resolve the blocker');
      const resolved_at = Object.hasOwn(change, 'resolved_at') ? change.resolved_at : at;
      if (existing.since && resolved_at && Date.parse(resolved_at) < Date.parse(existing.since)) fail('Blocker resolution cannot precede its start');
      Object.assign(existing, { status: 'resolved', resolved_at, resolution: change.resolution });
    }
  });
}
