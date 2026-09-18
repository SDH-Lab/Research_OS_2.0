import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';
import Ajv from 'ajv';
import { ResearchOSError } from '../lib/errors.js';
import { safeDataClone } from '../lib/safe-data.js';
import { manifestSnapshotFromRecord, verifyNormalizedManifest } from '../experiments/manifest.js';
import { readUtf8, safeJoin } from '../lib/fs.js';
import { parseMarkdownDocument } from '../lib/markdown.js';
import { discoverRecordCandidates } from '../records/catalog.js';
import { inspectEvidenceSources, inspectProvenanceLinkValues, PROVENANCE_LINK_FIELDS, PROVENANCE_TARGET_TYPES, traceClaim } from '../records/trace.js';
import { resolveResourceRef } from '../project/resources.js';
import { validateExecPlanControls } from '../session/exec-plan-controls.js';

const recordBase = {
  $id: 'record-base',
  type: 'object',
  required: ['schema_version', 'type', 'id', 'status', 'created', 'updated', 'status_history'],
  properties: {
    schema_version: { const: 1 },
    type: { type: 'string' },
    id: { type: 'string', pattern: '^[A-Z]+-[0-9]{3,}$' },
    status: { enum: ['inbox', 'defined', 'ready', 'in_progress', 'review', 'verified', 'closed', 'reopened', 'deferred', 'cancelled', 'superseded'] },
    created: { type: 'string', format: 'date-time' },
    updated: { type: 'string', format: 'date-time' },
    status_history: { type: 'array' }
  }
};

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isValidDateTime(value) {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const maximumDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > maximumDay || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) return false;
  if (offsetHourText && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

/** @param {unknown} value */
export function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day;
}

/** @param {unknown} value */
export function isValidIanaTimeZone(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

const schemaDirectory = fileURLToPath(new URL('../../core/schemas/', import.meta.url));
const schemaFiles = ['project', 'exec-plan', 'driver', 'action', 'experiment', 'manifest', 'run', 'result', 'evidence', 'claim', 'writing', 'decision', 'incident', 'artifact'];
const transitions = JSON.parse(readFileSync(fileURLToPath(new URL('../../core/rules/status-transitions.json', import.meta.url)), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addFormat('date-time', { type: 'string', validate: isValidDateTime });
ajv.addFormat('date', { type: 'string', validate: isValidDate });
ajv.addSchema(recordBase);
for (const name of schemaFiles) {
  ajv.addSchema(JSON.parse(readFileSync(`${schemaDirectory}${name}.schema.json`, 'utf8')), name);
}

/**
 * @param {string} schemaName
 * @param {Readonly<Record<string, unknown>>} attributes
 * @returns {ValidationIssue[]}
 */
export function validateRecord(schemaName, attributes) {
  const validate = ajv.getSchema(schemaName);
  if (!validate) throw new ResearchOSError('CORE_SCHEMA_NOT_FOUND', `Unknown core schema: ${schemaName}`);
  let snapshot;
  let unsafeNumberIssue = null;
  try {
    snapshot = safeDataClone(attributes, schemaName);
  } catch (error) {
    if (!error.message.includes('non-finite or non-canonical JSON number')) {
      return [{ severity: 'error', code: 'unsafe', path: '/', message: error.message, relatedIds: [] }];
    }
    try {
      snapshot = safeDataClone(attributes, schemaName, { allowNonCanonicalNumbers: true });
      unsafeNumberIssue = { severity: 'error', code: 'unsafe', path: '/', message: error.message, relatedIds: [] };
    } catch (retryError) {
      return [{ severity: 'error', code: 'unsafe', path: '/', message: retryError.message, relatedIds: [] }];
    }
  }
  const valid = validate(snapshot);
  const issues = valid ? [] : validate.errors.map(error => ({
    severity: 'error',
    code: error.keyword,
    path: error.keyword === 'required' ? `/${error.params.missingProperty}` : error.instancePath || '/',
    message: error.message,
    relatedIds: []
  }));
  if (unsafeNumberIssue) issues.push(unsafeNumberIssue);
  if (snapshot?.type !== 'action' && ['deferred', 'cancelled', 'superseded'].includes(snapshot?.status)) issues.push({ severity: 'error', code: 'semantic', path: '/status', message: 'This disposition is only valid for Actions', relatedIds: [] });
  if (schemaName === 'action' && snapshot && !Array.isArray(snapshot) && typeof snapshot === 'object' && Array.isArray(snapshot.blockers)) {
    for (const [index, blocker] of snapshot.blockers.entries()) {
      if (!blocker || Array.isArray(blocker) || typeof blocker !== 'object') continue;
      for (const field of ['description', 'owner', 'next_unblock_action']) {
        if (typeof blocker[field] === 'string' && blocker[field].trim().length === 0) {
          issues.push({ severity: 'error', code: 'semantic', path: `/blockers/${index}/${field}`, message: 'must contain non-whitespace text', relatedIds: [] });
        }
      }
      if (blocker.status === 'resolved' && isValidDateTime(blocker.since) && isValidDateTime(blocker.resolved_at) && Date.parse(blocker.resolved_at) < Date.parse(blocker.since)) {
        issues.push({ severity: 'error', code: 'semantic', path: `/blockers/${index}/resolved_at`, message: 'must not be earlier than since', relatedIds: [] });
      }
      if (isValidDateTime(blocker.since) && isValidDateTime(blocker.review_at) && Date.parse(blocker.review_at) < Date.parse(blocker.since)) {
        issues.push({ severity: 'error', code: 'semantic', path: `/blockers/${index}/review_at`, message: 'must not be earlier than since', relatedIds: [] });
      }
      if (isValidDateTime(snapshot.created) && isValidDateTime(blocker.since) && Date.parse(blocker.since) < Date.parse(snapshot.created)) {
        issues.push({ severity: 'error', code: 'semantic', path: `/blockers/${index}/since`, message: 'must not be earlier than Action.created', relatedIds: [] });
      }
      if (isValidDateTime(snapshot.updated) && isValidDateTime(blocker.since) && Date.parse(blocker.since) > Date.parse(snapshot.updated)) {
        issues.push({ severity: 'error', code: 'semantic', path: `/blockers/${index}/since`, message: 'must not be later than Action.updated', relatedIds: [] });
      }
      if (isValidDateTime(snapshot.updated) && isValidDateTime(blocker.resolved_at) && Date.parse(blocker.resolved_at) > Date.parse(snapshot.updated)) {
        issues.push({ severity: 'error', code: 'semantic', path: `/blockers/${index}/resolved_at`, message: 'must not be later than Action.updated', relatedIds: [] });
      }
      if (snapshot.status === 'closed' && blocker.status === 'active') {
        issues.push({ severity: 'error', code: 'semantic', path: `/blockers/${index}/status`, message: 'closed Action cannot retain an active blocker', relatedIds: [] });
      }
    }
  }
  if (schemaName === 'project' && snapshot && !Array.isArray(snapshot) && typeof snapshot === 'object') {
    const settings = snapshot.forecast_settings;
    if (settings && !Array.isArray(settings) && typeof settings === 'object') {
      if (!isValidIanaTimeZone(settings.timezone)) issues.push({ severity: 'error', code: 'semantic', path: '/forecast_settings/timezone', message: 'must be a valid IANA timezone', relatedIds: [] });
      if (!Number.isFinite(settings.integration_buffer)) issues.push({ severity: 'error', code: 'semantic', path: '/forecast_settings/integration_buffer', message: 'must be finite', relatedIds: [] });
      if (!Number.isFinite(settings.default_weekly_capacity)) issues.push({ severity: 'error', code: 'semantic', path: '/forecast_settings/default_weekly_capacity', message: 'must be finite', relatedIds: [] });
      if (Array.isArray(settings.capacity_calendar)) {
        const seen = new Set();
        for (const [index, week] of settings.capacity_calendar.entries()) {
          if (!week || Array.isArray(week) || typeof week !== 'object') continue;
          if (seen.has(week.week_start)) issues.push({ severity: 'error', code: 'semantic', path: `/forecast_settings/capacity_calendar/${index}/week_start`, message: 'must be unique', relatedIds: [] });
          seen.add(week.week_start);
          if (isValidDate(week.week_start) && new Date(`${week.week_start}T00:00:00Z`).getUTCDay() !== 1) {
            issues.push({ severity: 'error', code: 'semantic', path: `/forecast_settings/capacity_calendar/${index}/week_start`, message: 'must be a Monday', relatedIds: [] });
          }
          if (!Number.isFinite(week.available_units)) issues.push({ severity: 'error', code: 'semantic', path: `/forecast_settings/capacity_calendar/${index}/available_units`, message: 'must be finite', relatedIds: [] });
          if (typeof week.reason === 'string' && week.reason.trim().length === 0) issues.push({ severity: 'error', code: 'semantic', path: `/forecast_settings/capacity_calendar/${index}/reason`, message: 'must contain non-whitespace text', relatedIds: [] });
        }
      }
    }
  }
  return issues;
}

const ID = /^[A-Z]+-[0-9]{3,}$/u;
const OPEN_STATUSES = new Set(transitions.statuses.filter(status => status !== 'closed'));
const SCHEMA_BY_TYPE = Object.freeze({ exec_plan: 'exec-plan', risk: 'incident' });

/**
 * Resolve a canonical record type to its registered Core schema.
 * @param {unknown} type
 * @returns {string|null}
 */
export function schemaForRecordType(type) {
  if (typeof type !== 'string') return null;
  const schema = SCHEMA_BY_TYPE[type] ?? type;
  return schemaFiles.includes(schema) ? schema : null;
}

function issue(code, path, message, relatedIds = []) {
  return { severity: 'error', code, path, message, relatedIds };
}

/**
 * @typedef {Object} ValidationIssue
 * @property {'error'|'warning'} severity
 * @property {string} code
 * @property {string} path
 * @property {string} message
 * @property {ReadonlyArray<string>} relatedIds
 */

/**
 * @typedef {Object} ValidationReport
 * @property {boolean} ok
 * @property {number} checkedFiles
 * @property {ReadonlyArray<ValidationIssue>} issues
 */

function expectedLocations(record) {
  const { id, type } = record.attributes;
  if (typeof id !== 'string' || typeof type !== 'string') return [];
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const exact = path => new RegExp(`^${path}/${escapedId}\\.md$`, 'u');
  switch (type) {
    case 'project': return [/^PROJECT\.md$/u];
    case 'exec_plan': return [/^plans\/[^/]+\.md$/u];
    case 'driver':
      if (record.attributes.driver_kind === 'concern') return [exact('reviews/concerns')];
      if (record.attributes.driver_kind === 'research_question') return [exact('research/questions')];
      return [];
    case 'action': return [exact('plans/actions')];
    case 'artifact': return [exact('artifacts')];
    case 'experiment': return [exact('experiments/experiments')];
    case 'manifest': return [exact('experiments/manifests')];
    case 'run': return [exact('experiments/runs')];
    case 'result': return [exact('experiments/results')];
    case 'evidence': return [exact('evidence/packets')];
    case 'claim': return [exact('evidence/claims')];
    case 'writing':
      if (record.attributes.writing_kind === 'response_block') return [exact('writing/response')];
      if (record.attributes.writing_kind === 'manuscript_change') return [exact('writing/changes')];
      if (record.attributes.writing_kind === 'internal_strategy') return [exact('writing/strategy')];
      if (record.attributes.writing_kind === 'general') return [exact('writing/units')];
      return [];
    case 'decision': return [exact('decisions')];
    case 'incident': return [exact('incidents/incidents')];
    case 'risk': return [exact('incidents/risks')];
    default: return [];
  }
}

/**
 * Check whether a discovered canonical record occupies one of the Core-owned locations
 * for its exact type and ID.
 * @param {unknown} record
 * @returns {boolean}
 */
export function isCanonicalRecordLocation(record) {
  if (!record || Array.isArray(record) || typeof record !== 'object' || typeof record.path !== 'string' || !record.attributes || Array.isArray(record.attributes) || typeof record.attributes !== 'object') return false;
  const locations = expectedLocations(record);
  return locations.length > 0 && locations.some(pattern => pattern.test(record.path));
}

function validateUniqueIds(records) {
  const byId = new Map();
  for (const record of records.values()) {
    const paths = byId.get(record.attributes.id) ?? [];
    paths.push(record.path);
    byId.set(record.attributes.id, paths);
  }
  const issues = [];
  for (const [id, paths] of byId) {
    if (paths.length < 2) continue;
    for (const path of paths) issues.push(issue('DUPLICATE_RECORD_ID', path, `Canonical record ID appears in multiple files: ${id}`, [id]));
  }
  return issues;
}

function validateCandidates(candidates) {
  const issues = [];
  for (const candidate of candidates) {
    if (!candidate.document) {
      issues.push(issue('FRONTMATTER_INVALID', candidate.path, candidate.error.message));
      continue;
    }
    const { attributes } = candidate.document;
    const relatedIds = typeof attributes.id === 'string' ? [attributes.id] : [];
    if (typeof attributes.id !== 'string' || !ID.test(attributes.id)) {
      issues.push(issue('RECORD_IDENTITY_INVALID', candidate.path, 'Record id must match ^[A-Z]+-[0-9]{3,}$', relatedIds));
    }
    if (typeof attributes.type !== 'string' || attributes.type.length === 0) {
      issues.push(issue('RECORD_IDENTITY_INVALID', candidate.path, 'Record type must be a non-empty string', relatedIds));
      continue;
    }
    const schemaName = schemaForRecordType(attributes.type);
    try {
      if (!schemaName) throw new ResearchOSError('CORE_SCHEMA_NOT_FOUND', `Unknown core schema: ${attributes.type}`);
      for (const schemaIssue of validateRecord(schemaName, attributes)) {
        issues.push(issue('SCHEMA_INVALID', candidate.path, `${schemaIssue.path} ${schemaIssue.message}`, relatedIds));
      }
    } catch (error) {
      if (error instanceof ResearchOSError && error.code === 'CORE_SCHEMA_NOT_FOUND') {
        issues.push(issue('SCHEMA_INVALID', candidate.path, `Unknown canonical record type: ${attributes.type}`, relatedIds));
      } else {
        throw error;
      }
    }
  }
  return issues;
}

function validateExecPlanControlRecords(records) {
  const project = records.get('PROJECT.md')?.attributes;
  const issues = [];
  for (const record of records.values()) {
    if (record.attributes.type !== 'exec_plan') continue;
    const relevantProject = project?.active_plan === record.path ? project : null;
    for (const controlIssue of validateExecPlanControls(record.attributes, record.path, relevantProject)) {
      issues.push(issue(controlIssue.code, controlIssue.path, controlIssue.message, controlIssue.relatedIds ?? [record.attributes.id]));
    }
  }
  return issues;
}

function validateCanonicalLocations(records) {
  const issues = [];
  for (const record of records.values()) {
    if (!isCanonicalRecordLocation(record)) {
      issues.push(issue('CANONICAL_LOCATION', record.path, `Record ${record.attributes.id} is not in a canonical location for type ${record.attributes.type}`, [record.attributes.id]));
    }
  }
  return issues;
}

function bodyLinkIds(body) {
  const ids = [];
  for (const match of body.matchAll(/\[\[([^\]]+)\]\]/gu)) {
    const target = match[1].split('|', 1)[0].split('#', 1)[0].trim();
    if (ID.test(target)) ids.push(target);
  }
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right, 'en'));
}

function validateBodyLinks(records) {
  const ids = new Set([...records.values()].map(record => record.attributes.id));
  const issues = [];
  for (const record of records.values()) {
    for (const target of bodyLinkIds(record.body)) {
      if (!ids.has(target)) issues.push(issue('BROKEN_WIKILINK', record.path, `Body wikilink target does not exist: ${target}`, [target]));
    }
  }
  return issues;
}

function expectedInitialStatus(type) {
  return ['project', 'exec_plan', 'manifest'].includes(type) ? 'defined' : 'inbox';
}

/**
 * Validate the complete lifecycle authority for one record.
 * @param {Readonly<Record<string, unknown>>} attributes
 * @param {string} path
 * @returns {ValidationIssue[]}
 */
export function validateStatusHistory(attributes, path) {
  const issues = [];
  const relatedIds = typeof attributes.id === 'string' ? [attributes.id] : [];
  if (!Array.isArray(attributes.status_history)) {
    return [issue('INVALID_STATUS_HISTORY', path, 'status_history must be an array', relatedIds)];
  }
  const history = attributes.status_history;
  const initialStatus = expectedInitialStatus(attributes.type);
  if (history.length === 0) {
    if (attributes.status !== initialStatus) {
      issues.push(issue('INVALID_STATUS_HISTORY', path, `Empty status history requires initial status ${initialStatus}`, relatedIds));
    }
    if (attributes.status === 'closed' && !isValidDateTime(attributes.verified_at)) {
      issues.push(issue('CLOSED_WITHOUT_VERIFICATION', path, `Closed transition requires a valid verified_at: ${attributes.id}`, relatedIds));
    }
    return issues;
  }

  let previousTo;
  let previousAt;
  for (const [index, entry] of history.entries()) {
    const validShape = entry && !Array.isArray(entry) && typeof entry === 'object' && typeof entry.from === 'string' && typeof entry.to === 'string' && isValidDateTime(entry.at);
    if (!validShape) {
      issues.push(issue('INVALID_STATUS_HISTORY', path, `Status history entry ${index} is malformed`, relatedIds));
      continue;
    }
    if (index === 0 && entry.from !== initialStatus) {
      issues.push(issue('INVALID_STATUS_HISTORY', path, `Status history must begin at ${initialStatus}`, relatedIds));
    }
    if (previousTo !== undefined && entry.from !== previousTo) {
      issues.push(issue('INVALID_STATUS_HISTORY', path, `Status history is discontinuous at ${entry.from}->${entry.to}`, relatedIds));
    }
    const edges = attributes.type === 'action' ? transitions.action_transitions : transitions.transitions;
    if (!edges[entry.from]?.includes(entry.to)) {
      issues.push(issue('ILLEGAL_STATUS_TRANSITION', path, `Illegal status transition: ${entry.from}->${entry.to}`, relatedIds));
    }
    const at = Date.parse(entry.at);
    if (previousAt !== undefined && at <= previousAt) {
      issues.push(issue('INVALID_STATUS_HISTORY', path, 'Status history timestamps must increase strictly', relatedIds));
    }
    if (isValidDateTime(attributes.created) && at < Date.parse(attributes.created)) {
      issues.push(issue('INVALID_STATUS_HISTORY', path, 'Status history cannot predate created', relatedIds));
    }
    if (isValidDateTime(attributes.updated) && at > Date.parse(attributes.updated)) {
      issues.push(issue('INVALID_STATUS_HISTORY', path, 'Status history cannot be later than updated', relatedIds));
    }
    previousAt = at;
    previousTo = entry.to;
  }
  if (previousTo !== attributes.status) {
    issues.push(issue('INVALID_STATUS_HISTORY', path, `Status history does not end at current status ${attributes.status}`, relatedIds));
  }
  if (history.some(entry => entry?.to === 'closed') && !isValidDateTime(attributes.verified_at)) {
    issues.push(issue('CLOSED_WITHOUT_VERIFICATION', path, `Closed transition requires a valid verified_at: ${attributes.id}`, relatedIds));
  }
  const reopenEntries = history.filter(entry => entry?.to === 'reopened');
  if (reopenEntries.length > 0) {
    const hasReason = reopenEntries.every(entry => typeof entry.reason === 'string' && entry.reason.trim().length > 0);
    const hasAffectedIds = Array.isArray(attributes.affected_ids) && attributes.affected_ids.length > 0 && attributes.affected_ids.every(id => typeof id === 'string' && ID.test(id));
    if (!hasReason || !hasAffectedIds) {
      issues.push(issue('REOPENED_WITHOUT_CONTEXT', path, `Reopened record requires preserved reason and affected_ids: ${attributes.id}`, relatedIds));
    }
  }
  return issues;
}

function validateStatuses(records) {
  return [...records.values()].flatMap(record => validateStatusHistory(record.attributes, record.path));
}

function dateInTimezone(value, timezone) {
  if (!isValidDateTime(value)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(value));
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function validateForecastAuthorityCutoff(records) {
  const project = records.get('PROJECT.md')?.attributes;
  const settings = project?.forecast_settings;
  if (!settings || !isValidDate(settings.as_of) || !isValidIanaTimeZone(settings.timezone)) return [];
  const issues = [];
  const check = (record, field, value) => {
    const local = dateInTimezone(value, settings.timezone);
    if (local && local > settings.as_of) {
      issues.push(issue(
        'FORECAST_AS_OF_BEFORE_AUTHORITY',
        record.path,
        `${field} resolves to ${local} in ${settings.timezone}, after forecast as_of ${settings.as_of}`,
        [record.attributes.id]
      ));
    }
  };
  for (const record of records.values()) {
    for (const field of ['created', 'updated', 'verified_at']) check(record, field, record.attributes[field]);
    if (Array.isArray(record.attributes.status_history)) {
      for (const [index, entry] of record.attributes.status_history.entries()) check(record, `status_history[${index}].at`, entry?.at);
    }
    if (record.attributes.type === 'action' && Array.isArray(record.attributes.blockers)) {
      for (const [index, blocker] of record.attributes.blockers.entries()) {
        check(record, `blockers[${index}].since`, blocker?.since);
        check(record, `blockers[${index}].resolved_at`, blocker?.resolved_at);
      }
    }
  }
  return issues;
}

function validateRunnableManifests(records) {
  const runnable = new Set(['ready', 'in_progress', 'review', 'verified', 'closed', 'reopened']);
  const project = [...records.values()].find(record => record.attributes.type === 'project' && record.path === 'PROJECT.md')?.attributes;
  return [...records.values()].flatMap(record => {
    if (record.attributes.type !== 'manifest' || !runnable.has(record.attributes.status)) return [];
    try {
      verifyNormalizedManifest(manifestSnapshotFromRecord(record.attributes), { project });
      return [];
    } catch (error) {
      return [issue(
        'MANIFEST_SEMANTIC_INVALID',
        record.path,
        `Runnable Manifest is not an exact normalized snapshot of the current Project: ${error.message}`,
        [record.attributes.id]
      )];
    }
  });
}

function validateActivePlan(records) {
  const project = [...records.values()].find(record => record.attributes.type === 'project' && record.path === 'PROJECT.md');
  if (!project) return [issue('MISSING_ACTIVE_PLAN', 'PROJECT.md', 'PROJECT.md is missing or invalid')];
  const activePath = project.attributes.active_plan;
  const active = typeof activePath === 'string' ? records.get(activePath) : undefined;
  const issues = [];
  if (!active || active.attributes.type !== 'exec_plan' || !OPEN_STATUSES.has(active.attributes.status)) {
    issues.push(issue('MISSING_ACTIVE_PLAN', 'PROJECT.md', `PROJECT.active_plan does not resolve to a canonical ExecPlan: ${activePath ?? ''}`));
  }
  const openPlans = [...records.values()].filter(record => record.attributes.type === 'exec_plan' && OPEN_STATUSES.has(record.attributes.status));
  if (openPlans.length > 1) {
    issues.push(issue('MULTIPLE_ACTIVE_PLANS', 'PROJECT.md', `Expected one open Active ExecPlan, found ${openPlans.length}`, openPlans.map(record => record.attributes.id).sort()));
  }
  return issues;
}

async function validateApprovedClaims(projectRoot, records) {
  const issues = [];
  const approved = [...records.values()].filter(record => record.attributes.type === 'claim' && record.attributes.approval_status === 'approved');
  for (const record of approved) {
    try {
      const graph = await traceClaim(projectRoot, record.attributes.id);
      const hasDriver = graph.types.has('driver');
      const hasSource = graph.types.has('run') || graph.externalSources.length > 0;
      const hasBrokenProvenance = graph.brokenLinks.length > 0 || graph.brokenSources.length > 0;
      if (!hasDriver || !hasSource || hasBrokenProvenance) {
        issues.push(issue(
          'APPROVED_CLAIM_PROVENANCE',
          record.path,
          `Approved Claim requires unbroken provenance to a Driver and a Run or registered Evidence source: ${record.attributes.id}`,
          [record.attributes.id]
        ));
      }
    } catch (error) {
      issues.push(issue('APPROVED_CLAIM_PROVENANCE', record.path, `Approved Claim provenance cannot be traced: ${error.code ?? error.message}`, [record.attributes.id]));
    }
  }
  return issues;
}

function validateEvidenceSources(records) {
  const project = [...records.values()].find(record => record.attributes.type === 'project' && record.path === 'PROJECT.md')?.attributes;
  const issues = [];
  for (const record of records.values()) {
    if (record.attributes.type !== 'evidence') continue;
    for (const broken of inspectEvidenceSources(project, record).brokenSources) {
      issues.push(issue(
        'EVIDENCE_SOURCE_INVALID',
        record.path,
        `Evidence source is not a canonical ID or registered resource reference: ${String(broken.ref)} (${broken.code})`,
        typeof broken.ref === 'string' && ID.test(broken.ref) ? [broken.ref] : []
      ));
    }
  }
  return issues;
}

function validateRegisteredReferences(records) {
  const project = [...records.values()].find(record => record.attributes.type === 'project' && record.path === 'PROJECT.md')?.attributes;
  const issues = [];
  const check = (path, ref, relatedIds, label) => {
    try {
      resolveResourceRef(project, ref);
    } catch {
      issues.push(issue('REGISTERED_REFERENCE_INVALID', path, `${label} must be a safe registered resource reference: ${String(ref)}`, relatedIds));
    }
  };
  for (const record of records.values()) {
    if (record.attributes.type === 'driver' && record.attributes.driver_kind === 'concern') {
      check(record.path, record.attributes.source_ref, [record.attributes.id], 'Concern source_ref');
    }
  }
  const sources = project?.canonical_writing_sources;
  if (sources && !Array.isArray(sources) && typeof sources === 'object') {
    for (const [key, source] of Object.entries(sources)) {
      check('PROJECT.md', source?.resource_ref, [project.id], `canonical_writing_sources.${key}.resource_ref`);
    }
  }
  return issues;
}

function validateProvenanceLinks(records) {
  const byId = new Map();
  for (const record of records.values()) {
    const matches = byId.get(record.attributes.id) ?? [];
    matches.push(record);
    byId.set(record.attributes.id, matches);
  }
  const issues = [];
  for (const record of records.values()) {
    for (const field of PROVENANCE_LINK_FIELDS[record.attributes.type] ?? []) {
      const allowedTypes = PROVENANCE_TARGET_TYPES[record.attributes.type]?.[field] ?? [];
      const inspected = inspectProvenanceLinkValues(record, field);
      for (const value of inspected.invalidValues) {
        let rendered;
        try {
          rendered = JSON.stringify(value);
        } catch {
          rendered = String(value);
        }
        issues.push(issue('PROVENANCE_LINK_INVALID', record.path, `${record.attributes.type}.${field}: INVALID_LINK_VALUE:${rendered ?? '<missing>'}`, [record.attributes.id]));
      }
      for (const target of inspected.targets) {
        const matches = byId.get(target) ?? [];
        let reason;
        if (matches.length === 0) reason = 'MISSING_TARGET';
        else if (matches.length > 1) reason = 'AMBIGUOUS_TARGET';
        else if (!allowedTypes.includes(matches[0].attributes.type)) reason = `WRONG_LINK_TYPE:${matches[0].attributes.type}`;
        if (reason) {
          issues.push(issue('PROVENANCE_LINK_INVALID', record.path, `${record.attributes.type}.${field} -> ${target}: ${reason}`, [record.attributes.id, target]));
        }
      }
    }
  }
  return issues;
}

async function generatedRecordIssues(projectRoot) {
  const generatedRoot = safeJoin(projectRoot, 'generated');
  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
    }
  }
  await visit(generatedRoot);
  const issues = [];
  const root = resolve(projectRoot);
  for (const file of files.sort((left, right) => left.localeCompare(right, 'en'))) {
    const text = await readUtf8(file);
    if (!text.startsWith('---\n')) continue;
    let document;
    try {
      document = parseMarkdownDocument(text, file);
    } catch {
      continue;
    }
    const { id, type } = document.attributes;
    if (typeof type !== 'string' || typeof id !== 'string' || !ID.test(id)) continue;
    const path = relative(root, file).split(/[/\\]/u).join('/');
    issues.push(issue('CANONICAL_RECORD_IN_GENERATED', path, `Canonical-shaped record must not be stored under generated/: ${id}`, [id]));
  }
  return issues;
}

/**
 * Validate every canonical frontmatter candidate without aborting on corrupt files.
 * @param {string} projectRoot
 * @returns {Promise<ValidationReport>}
 */
async function validateAcceptedArtifacts(projectRoot, records) {
  const { validateArtifactDependency } = await import('../session/execution.js');
  const catalog = new Map([...records].map(([path, value]) => [path, { ...value, id: value.attributes.id, type: value.attributes.type }]));
  const issues = [];
  for (const record of catalog.values()) {
    if (record.type !== 'artifact' || record.attributes.status !== 'closed') continue;
    for (const value of await validateArtifactDependency(projectRoot, record, catalog)) issues.push(issue(value.code, value.path, value.message, [record.id]));
  }
  return issues;
}

export async function validateProject(projectRoot) {
  const candidates = await discoverRecordCandidates(projectRoot);
  const parsed = candidates.filter(candidate => candidate.document).map(candidate => ({
    path: candidate.path,
    attributes: candidate.document.attributes,
    body: candidate.document.body
  }));
  const records = new Map(parsed
    .filter(record => typeof record.attributes.id === 'string' && typeof record.attributes.type === 'string')
    .map(record => [record.path, record]));
  const documents = new Map(parsed.map(record => [record.path, record]));
  const issues = [
    ...validateUniqueIds(records),
    ...validateCandidates(candidates),
    ...validateBodyLinks(documents),
    ...validateStatuses(records),
    ...validateForecastAuthorityCutoff(records),
    ...validateRunnableManifests(records),
    ...validateProvenanceLinks(records),
    ...validateEvidenceSources(records),
    ...validateRegisteredReferences(records),
    ...validateExecPlanControlRecords(records),
    ...validateActivePlan(records),
    ...await validateApprovedClaims(projectRoot, records),
    ...validateCanonicalLocations(records),
    ...await validateAcceptedArtifacts(projectRoot, records),
    ...await generatedRecordIssues(projectRoot)
  ].sort((left, right) => left.path.localeCompare(right.path, 'en') || left.code.localeCompare(right.code, 'en'));
  const frozenIssues = Object.freeze(issues.map(item => Object.freeze({ ...item, relatedIds: Object.freeze([...item.relatedIds]) })));
  return Object.freeze({ ok: frozenIssues.every(item => item.severity !== 'error'), checkedFiles: candidates.length, issues: frozenIssues });
}
