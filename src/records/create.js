import { assertActionCanClose } from '../actions/workflow.js';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadCore } from '../core/catalog.js';
import { renderTemplate } from '../core/render.js';
import { ResearchOSError } from '../lib/errors.js';
import { readUtf8, safeJoin, writeUtf8Atomic } from '../lib/fs.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../lib/markdown.js';
import { deepFreeze } from '../lib/readonly.js';
import { manifestSnapshotFromRecord, verifyNormalizedManifest } from '../experiments/manifest.js';
import { enableModule, loadProject } from '../project/project.js';
import { resolveResourceRef } from '../project/resources.js';
import { validateRecord, validateStatusHistory, isValidDateTime } from '../validation/validator.js';
import { discoverRecords } from './catalog.js';

const CORE_ROOT = fileURLToPath(new URL('../../core/', import.meta.url));
const ID = /^[A-Z]+-[0-9]{3,}$/u;

/**
 * @typedef {Object} RecordRef
 * @property {string} id
 * @property {string} type
 * @property {string} path
 * @property {Readonly<Record<string, unknown>>} attributes
 */

export const RECORD_KINDS = Object.freeze({
  driver: Object.freeze({ type: 'driver', schema: 'driver', module: 'research', directory: 'research/questions', template: 'driver' }),
  concern: Object.freeze({ type: 'driver', schema: 'driver', module: 'reviews', directory: 'reviews/concerns', template: 'driver' }),
  artifact: Object.freeze({ type: 'artifact', schema: 'artifact', module: null, directory: 'artifacts', template: 'artifact' }),
  action: Object.freeze({ type: 'action', schema: 'action', module: null, directory: 'plans/actions', template: 'action' }),
  experiment: Object.freeze({ type: 'experiment', schema: 'experiment', module: 'experiments', directory: 'experiments/experiments', template: 'experiment' }),
  manifest: Object.freeze({ type: 'manifest', schema: 'manifest', module: 'experiments', directory: 'experiments/manifests', template: 'manifest' }),
  run: Object.freeze({ type: 'run', schema: 'run', module: 'experiments', directory: 'experiments/runs', template: 'run' }),
  result: Object.freeze({ type: 'result', schema: 'result', module: 'experiments', directory: 'experiments/results', template: 'result' }),
  evidence: Object.freeze({ type: 'evidence', schema: 'evidence', module: 'evidence', directory: 'evidence/packets', template: 'evidence' }),
  claim: Object.freeze({ type: 'claim', schema: 'claim', module: 'evidence', directory: 'evidence/claims', template: 'claim' }),
  writing: Object.freeze({ type: 'writing', schema: 'writing', module: 'writing', directory: 'writing/units', template: 'writing' }),
  response: Object.freeze({ type: 'writing', schema: 'writing', module: 'writing', directory: 'writing/response', template: 'writing' }),
  'manuscript-change': Object.freeze({ type: 'writing', schema: 'writing', module: 'writing', directory: 'writing/changes', template: 'writing' }),
  strategy: Object.freeze({ type: 'writing', schema: 'writing', module: 'writing', directory: 'writing/strategy', template: 'writing' }),
  decision: Object.freeze({ type: 'decision', schema: 'decision', module: 'decisions', directory: 'decisions', template: 'decision' }),
  incident: Object.freeze({ type: 'incident', schema: 'incident', module: 'incidents', directory: 'incidents/incidents', template: 'incident' }),
  risk: Object.freeze({ type: 'risk', schema: 'incident', module: 'incidents', directory: 'incidents/risks', template: 'incident' })
});

function yamlScalar(value) {
  return JSON.stringify(value ?? '');
}

function renderValues(values, now) {
  const evidenceIds = Array.isArray(values.evidence) ? values.evidence.filter(value => typeof value === 'string') : [];
  return {
    ID: values.id,
    TITLE: String(values.title),
    DATE: yamlScalar(now),
    SOURCE: yamlScalar(values.source ?? ''),
    QUESTION: yamlScalar(values.question ?? values.scientific_question ?? ''),
    DRIVER: yamlScalar(values.driver ?? ''),
    CODE_ROOT: yamlScalar(values.code_root ?? ''),
    EXPERIMENT: yamlScalar(values.experiment ?? ''),
    MANIFEST: yamlScalar(values.manifest ?? ''),
    RUN: yamlScalar(values.run ?? ''),
    TARGET_LOCATION: yamlScalar(values.target_location ?? ''),
    EVIDENCE_LINKS: evidenceIds.map(id => `[[${id}]]`).join(', ')
  };
}

function renderBodyValues(values, now) {
  const evidenceIds = Array.isArray(values.evidence) ? values.evidence.filter(value => typeof value === 'string') : [];
  return {
    ID: markdownInline(values.id),
    TITLE: markdownInline(values.title),
    DATE: now,
    SOURCE: markdownInline(values.source ?? ''),
    QUESTION: markdownInline(values.question ?? values.scientific_question ?? ''),
    DRIVER: markdownInline(values.driver ?? ''),
    CODE_ROOT: markdownInline(values.code_root ?? ''),
    EXPERIMENT: markdownInline(values.experiment ?? ''),
    MANIFEST: markdownInline(values.manifest ?? ''),
    RUN: markdownInline(values.run ?? ''),
    TARGET_LOCATION: markdownInline(values.target_location ?? ''),
    EVIDENCE_LINKS: evidenceIds.map(id => ID.test(id) ? `[[${id}]]` : markdownInline(id)).join(', ')
  };
}

function markdownInline(value) {
  return String(value)
    .replace(/[\r\n\u2028\u2029]+/gu, ' ')
    .replace(/([\\`*_[\]{}()<>#+.!|])/gu, '\\$1');
}

function renderRecordTemplate(template, values, now) {
  const match = template.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/u);
  if (!match) throw new ResearchOSError('CORE_TEMPLATE_BOUNDARY', 'Record template must contain YAML frontmatter');
  return `${renderTemplate(match[1], renderValues(values, now))}${renderTemplate(match[2], renderBodyValues(values, now))}`;
}

function assertCreateInput(kind, values) {
  if (!Object.hasOwn(RECORD_KINDS, kind)) throw new ResearchOSError('USAGE', `Unknown record type: ${kind}`);
  if (!values || Array.isArray(values) || typeof values !== 'object') throw new ResearchOSError('USAGE', 'Record values must be an object');
  if (typeof values.id !== 'string' || !ID.test(values.id)) throw new ResearchOSError('USAGE', `Invalid record id: ${values.id ?? ''}`);
  if (typeof values.title !== 'string' || values.title.length === 0 || /[\r\n\u2028\u2029\0]/u.test(values.title)) throw new ResearchOSError('USAGE', 'Record title must be a non-empty single-line string');
}

function userFieldNames(core, definition) {
  const properties = core.schemas[definition.schema]?.allOf?.[1]?.properties ?? {};
  const manifestMachineFields = new Set(['resolved_config_hash', 'normalized_hash', 'resolved_at', 'project_authority', 'project_authority_hash', 'resolved_outputs', 'manifest_complete']);
  return new Set(Object.keys(properties).filter(name => !['type', 'kind', 'driver_kind', 'writing_kind', 'validation_checks', 'validation_revisions', 'validation_acceptance', 'scope_approvals'].includes(name) && !(definition.schema === 'artifact' && ['sha256', 'acceptance'].includes(name)) && !(definition.schema === 'manifest' && manifestMachineFields.has(name))));
}

function machineKind(kind) {
  if (kind === 'driver') return { driver_kind: 'research_question' };
  if (kind === 'concern') return { driver_kind: 'concern' };
  if (kind === 'writing') return { writing_kind: 'general' };
  if (kind === 'response') return { writing_kind: 'response_block' };
  if (kind === 'manuscript-change') return { writing_kind: 'manuscript_change' };
  if (kind === 'strategy') return { writing_kind: 'internal_strategy' };
  return {};
}

function userAttributes(core, definition, values) {
  const allowed = userFieldNames(core, definition);
  const unsupported = Object.keys(values).filter(name => !['id', 'title'].includes(name) && !allowed.has(name)).sort();
  if (unsupported.length > 0) throw new ResearchOSError('USAGE', `Unsupported record value field(s): ${unsupported.join(', ')}`);
  return Object.fromEntries(Object.entries(values).filter(([name]) => allowed.has(name)));
}

function validationError(id, issues) {
  return new ResearchOSError('VALIDATION', `Record ${id} failed validation: ${issues.map(item => `${item.path} ${item.message}`).join('; ')}`, issues);
}

function schemaForType(type) {
  if (type === 'exec_plan') return 'exec-plan';
  if (type === 'risk') return 'incident';
  return type;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Create a canonical record from a Core template.
 * @param {string} projectRoot
 * @param {string} kind
 * @param {Record<string, unknown>} values
 * @returns {Promise<Readonly<{id: string, path: string}>>}
 */
export async function createRecord(projectRoot, kind, values) {
  assertCreateInput(kind, values);
  const definition = RECORD_KINDS[kind];
  const core = await loadCore(CORE_ROOT);
  const suppliedAttributes = userAttributes(core, definition, values);
  const path = `${definition.directory}/${values.id}.md`;
  const records = await discoverRecords(projectRoot);
  if ([...records.values()].some(record => record.attributes.id === values.id) || await pathExists(safeJoin(projectRoot, path))) {
    throw new ResearchOSError('CONFLICT', `Record already exists: ${values.id}`);
  }
  if (kind === 'concern') {
    try {
      resolveResourceRef(await loadProject(projectRoot), suppliedAttributes.source_ref);
    } catch {
      throw new ResearchOSError('VALIDATION', 'Concern source_ref must be a safe registered resource reference');
    }
  }

  const now = new Date().toISOString();
  const rendered = renderRecordTemplate(core.templates.records[definition.template], values, now);
  const templateDocument = parseMarkdownDocument(rendered, path);
  const attributes = {
    ...templateDocument.attributes,
    ...suppliedAttributes,
    id: values.id,
    type: definition.type,
    ...machineKind(kind),
    ...(kind === 'risk' ? { kind: 'risk' } : {}),
    ...(kind === 'incident' ? { kind: 'incident' } : {})
  };
  const issues = validateRecord(definition.schema, attributes);
  if (issues.length > 0) throw validationError(values.id, issues);

  if (definition.module) await enableModule(projectRoot, definition.module);
  const target = safeJoin(projectRoot, path);
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(target, serializeMarkdownDocument(attributes, templateDocument.body), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new ResearchOSError('CONFLICT', `Record path already exists: ${path}`);
    throw error;
  }
  const persisted = parseMarkdownDocument(await readFile(target, 'utf8'), path);
  const persistedIssues = validateRecord(definition.schema, persisted.attributes);
  if (persistedIssues.length > 0) throw validationError(values.id, persistedIssues);
  return Object.freeze({ id: values.id, path });
}

function nextUpdated(previousUpdated) {
  const previous = Date.parse(previousUpdated);
  const now = Date.now();
  return new Date(Math.max(now, Number.isNaN(previous) ? now : previous + 1)).toISOString();
}

async function findRecord(projectRoot, id) {
  const matches = [...(await discoverRecords(projectRoot)).values()].filter(record => record.attributes.id === id);
  if (matches.length === 0) throw new ResearchOSError('RECORD_NOT_FOUND', `Record not found: ${id}`);
  if (matches.length > 1) throw new ResearchOSError('CONFLICT', `Record ID is not unique: ${id}`);
  return matches[0];
}

function assertTransition(transitions, current, next, change, type) {
  const edges = type === 'action' ? transitions.action_transitions : transitions.transitions;
  if (!edges[current]?.includes(next)) {
    throw new ResearchOSError('INVALID_TRANSITION', `Illegal status transition: ${current}->${next}`);
  }
  if (next === 'closed' && !isValidDateTime(change.verifiedAt)) {
    throw new ResearchOSError('STATUS_CONDITION', 'Closing a record requires a valid verifiedAt date-time');
  }
  if (next === 'reopened') {
    const validReason = typeof change.reason === 'string' && change.reason.trim().length > 0;
    const validAffectedIds = Array.isArray(change.affectedIds) && change.affectedIds.length > 0 && change.affectedIds.every(id => typeof id === 'string' && ID.test(id));
    if (!validReason || !validAffectedIds) throw new ResearchOSError('STATUS_CONDITION', 'Reopening a record requires a non-empty reason and affectedIds');
  }
}

const RUNNABLE_MANIFEST_STATUSES = new Set(['ready', 'in_progress', 'review', 'verified', 'closed', 'reopened']);

async function assertRunnableManifest(projectRoot, recordPath, attributes) {
  if (attributes.type !== 'manifest' || !RUNNABLE_MANIFEST_STATUSES.has(attributes.status)) return;
  try {
    const project = await loadProject(projectRoot);
    verifyNormalizedManifest(manifestSnapshotFromRecord(attributes), { project });
  } catch (error) {
    throw validationError(attributes.id, [{
      severity: 'error',
      code: 'MANIFEST_SEMANTIC_INVALID',
      path: recordPath,
      message: `Runnable Manifest is not an exact normalized snapshot of the current Project: ${error.message}`,
      relatedIds: [attributes.id]
    }]);
  }
}

/**
 * Apply one legal, history-preserving status transition.
 * @param {string} projectRoot
 * @param {string} id
 * @param {string} nextStatus
 * @param {{reason?: string, affectedIds?: string[], verifiedAt?: string}} change
 * @returns {Promise<RecordRef>}
 */
export async function updateRecordStatus(projectRoot, id, nextStatus, change = {}) {
  if (typeof id !== 'string' || !ID.test(id) || typeof nextStatus !== 'string') throw new ResearchOSError('USAGE', 'Record id and target status are required');
  const [record, core] = await Promise.all([findRecord(projectRoot, id), loadCore(CORE_ROOT)]);
  const schema = schemaForType(record.attributes.type);
  const currentIssues = validateRecord(schema, record.attributes);
  if (currentIssues.length > 0) throw validationError(id, currentIssues);
  const currentHistoryIssues = validateStatusHistory(record.attributes, record.path);
  if (currentHistoryIssues.length > 0) throw validationError(id, currentHistoryIssues);
  assertTransition(core.transitions, record.attributes.status, nextStatus, change, record.attributes.type);
  if (record.attributes.type === 'artifact' && (['verified', 'closed'].includes(nextStatus) || record.attributes.status === 'closed')) throw new ResearchOSError('STATUS_CONDITION', 'Use artifact accept for version-bound acceptance; create a new Artifact for a changed version');
  if (record.attributes.type === 'action' && nextStatus === 'in_progress') {
    if (record.attributes.execution?.resources?.length) throw new ResearchOSError('STATUS_CONDITION', 'Use action claim to check and acquire resource lanes');
    const { claimExecution } = await import('../session/execution.js');
    return claimExecution(projectRoot, id);
  }
  if (record.attributes.type === 'action' && ['deferred', 'cancelled', 'superseded'].includes(nextStatus) && !change.reason?.trim()) throw new ResearchOSError('STATUS_CONDITION', 'Task disposition requires a reason');
  const at = nextUpdated(record.attributes.updated);
  const attributes = {
    ...record.attributes,
    status: nextStatus,
    updated: at,
    ...(nextStatus === 'closed' ? { verified_at: change.verifiedAt } : {}),
    ...(nextStatus === 'reopened' ? { affected_ids: [...change.affectedIds] } : {}),
    status_history: [
      ...record.attributes.status_history,
      { from: record.attributes.status, to: nextStatus, at, reason: change.reason ?? null }
    ]
  };
  if (attributes.type === 'action' && ['verified', 'closed'].includes(nextStatus)) {
    if (change.acceptedBy?.trim() && change.reason?.trim()) attributes.validation_acceptance = { candidate_version: attributes.candidate_version, accepted_by: change.acceptedBy, accepted_at: at, reason: change.reason };
    assertActionCanClose(attributes);
  }
  const issues = validateRecord(schema, attributes);
  if (issues.length > 0) throw validationError(id, issues);
  const historyIssues = validateStatusHistory(attributes, record.path);
  if (historyIssues.length > 0) throw validationError(id, historyIssues);
  await assertRunnableManifest(projectRoot, record.path, attributes);
  const path = safeJoin(projectRoot, record.path);
  const currentDocument = parseMarkdownDocument(await readUtf8(path), record.path);
  await writeUtf8Atomic(path, serializeMarkdownDocument(attributes, currentDocument.body));
  const persisted = parseMarkdownDocument(await readUtf8(path), record.path);
  deepFreeze(persisted.attributes);
  return Object.freeze({ id: persisted.attributes.id, type: persisted.attributes.type, path: record.path, attributes: persisted.attributes });
}
