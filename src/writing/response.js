import { deepFreeze, ReadonlyMap } from '../lib/readonly.js';
import { canonicalJson } from '../experiments/manifest.js';
import { resolveResourceRef } from '../project/resources.js';
import { writingCandidateSnapshots } from '../records/catalog.js';
import { inspectEvidenceSources, inspectProvenanceLinkValues, PROVENANCE_LINK_FIELDS, PROVENANCE_TARGET_TYPES, traceClaimCatalog } from '../records/trace.js';
import { isCanonicalRecordLocation, schemaForRecordType, validateRecord, validateStatusHistory } from '../validation/validator.js';

const ID = /^[A-Z]+-[0-9]{3,}$/u;
const PLACEHOLDER = /(?:\b(?:TODO|TBD|FIXME|UNKNOWN|PENDING|PLACEHOLDER)\b|\?\?|\{\{[^}]*\}\})/u;
const NUMBER = /(?<![\w.])[+-]?(?:(?:\d+\.\d+|\.\d+)(?:[eE][+-]?\d+)?%?|\d+(?:[eE][+-]?\d+|%))(?![\w.])/gu;

function meaningful(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

function safePath(record, fallback = '<response>') {
  return record && typeof record === 'object' && typeof record.path === 'string' ? record.path : fallback;
}

function safeId(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.attributes && typeof record.attributes === 'object' && typeof record.attributes.id === 'string') return record.attributes.id;
  return typeof record.id === 'string' ? record.id : null;
}

function makeIssue(code, path, message, relatedIds = [], severity = 'error') {
  return { severity, code, path, message, relatedIds: [...new Set(relatedIds.filter(value => typeof value === 'string'))].sort((a, b) => a.localeCompare(b, 'en')) };
}

function sortIssues(items) {
  const unique = new Map();
  for (const item of items) {
    const normalized = makeIssue(item.code, item.path, item.message, item.relatedIds, item.severity);
    const key = JSON.stringify(normalized);
    if (!unique.has(key)) unique.set(key, normalized);
  }
  return [...unique.values()].sort((left, right) =>
    left.path.localeCompare(right.path, 'en') || left.code.localeCompare(right.code, 'en') || left.message.localeCompare(right.message, 'en'));
}

function freezeIssues(items) {
  return deepFreeze(sortIssues(items));
}

function safePlain(value) {
  try {
    return { ok: true, value: canonicalJson(value) };
  } catch {
    return { ok: false, value: null };
  }
}

function safeAllowedOpenDriverIds(values) {
  let candidates = [];
  try {
    if (Array.isArray(values)) candidates = [...values];
    else if (values instanceof Set) candidates = [...Set.prototype.values.call(values)];
  } catch {
    return new Set();
  }
  return new Set(candidates.filter(value => typeof value === 'string' && ID.test(value)));
}

function usableRecord(record) {
  return record && !Array.isArray(record) && typeof record === 'object' && typeof record.path === 'string' &&
    record.attributes && !Array.isArray(record.attributes) && typeof record.attributes === 'object';
}

function indexCatalog(catalog) {
  let rawEntries = [];
  let catalogShapeValid = true;
  try {
    if (catalog instanceof Map) rawEntries = [...Map.prototype.entries.call(catalog)];
    else if (catalog instanceof ReadonlyMap) rawEntries = [...ReadonlyMap.prototype.entries.call(catalog)];
    else catalogShapeValid = false;
  } catch {
    catalogShapeValid = false;
  }
  const records = [];
  let malformedValues = 0;
  const catalogIssues = [];
  for (const [key, value] of rawEntries) {
    const cloned = safePlain(value);
    if (!cloned.ok || !usableRecord(cloned.value)) {
      malformedValues += 1;
      continue;
    }
    if (typeof key !== 'string' || key !== cloned.value.path) {
      malformedValues += 1;
      catalogIssues.push(makeIssue(
        'CATALOG_KEY_PATH_INVALID',
        typeof key === 'string' ? key : 'catalog',
        'Catalog key must be a primitive string exactly equal to RecordRef.path'
      ));
      continue;
    }
    records.push(cloned.value);
  }
  records.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const byId = new Map();
  for (const record of records) {
    const id = record.attributes.id;
    if (typeof id !== 'string') continue;
    const matches = byId.get(id) ?? [];
    matches.push(record);
    byId.set(id, matches);
  }
  const projectMatches = records.filter(record => record.path === 'PROJECT.md' && record.attributes.type === 'project');
  const index = {
    records,
    byId,
    project: projectMatches.length === 1 ? projectMatches[0].attributes : null,
    validCatalog: catalogShapeValid && records.length > 0 && malformedValues === 0,
    malformedValues,
    catalogIssues,
    candidateSnapshots: catalogShapeValid ? writingCandidateSnapshots(catalog) : []
  };
  index.candidateIssues = candidateIssues(index);
  return index;
}

function expectedReviewerKind(path) {
  if (/^reviews\/concerns\/.+\.md$/u.test(path)) return { type: 'driver', field: 'driver_kind', kind: 'concern' };
  if (/^writing\/response\/.+\.md$/u.test(path)) return { type: 'writing', field: 'writing_kind', kind: 'response_block' };
  if (/^writing\/changes\/.+\.md$/u.test(path)) return { type: 'writing', field: 'writing_kind', kind: 'manuscript_change' };
  return null;
}

function candidateIssues(index) {
  const issues = [...index.catalogIssues];
  const inspect = (path, rawAttributes, parseError = false) => {
    const expected = expectedReviewerKind(path);
    if (!expected) return;
    if (parseError) {
      issues.push(makeIssue('FRONTMATTER_INVALID', path, 'Reviewer-facing candidate frontmatter cannot be parsed'));
      return;
    }
    const cloned = safePlain(rawAttributes);
    if (!cloned.ok || !cloned.value || Array.isArray(cloned.value) || typeof cloned.value !== 'object') {
      issues.push(makeIssue('RECORD_IDENTITY_INVALID', path, 'Reviewer-facing candidate attributes must be safe plain JSON data'));
      return;
    }
    const attributes = cloned.value;
    const related = typeof attributes.id === 'string' ? [attributes.id] : [];
    if (typeof attributes.id !== 'string' || !ID.test(attributes.id) || typeof attributes.type !== 'string') {
      issues.push(makeIssue('RECORD_IDENTITY_INVALID', path, 'Reviewer-facing candidate requires a canonical id and type', related));
      return;
    }
    if (attributes.type !== expected.type || attributes[expected.field] !== expected.kind) {
      issues.push(makeIssue('REVIEWER_CANDIDATE_KIND', path, `Candidate must be ${expected.type}/${expected.kind}`, related));
    }
    const schema = schemaForRecordType(attributes.type);
    if (!schema) issues.push(makeIssue('SCHEMA_INVALID', path, `Unknown canonical record type: ${attributes.type}`, related));
    else {
      try {
        for (const item of validateRecord(schema, attributes)) issues.push(makeIssue('SCHEMA_INVALID', path, `${item.path} ${item.message}`, related));
      } catch {
        issues.push(makeIssue('SCHEMA_INVALID', path, 'Reviewer-facing candidate schema could not be checked safely', related));
      }
    }
    const record = { path, attributes };
    if (!isCanonicalRecordLocation(record)) issues.push(makeIssue('CANONICAL_LOCATION', path, `Reviewer-facing candidate ${attributes.id} is not canonical`, related));
    const matches = index.byId.get(attributes.id) ?? [];
    if (matches.length > 1) issues.push(makeIssue('DUPLICATE_RECORD_ID', path, `Canonical record ID appears in multiple files: ${attributes.id}`, related));
  };
  for (const snapshot of index.candidateSnapshots) {
    inspect(typeof snapshot.path === 'string' ? snapshot.path : '<candidate>', snapshot.attributes, snapshot.parseError === true);
  }
  for (const record of index.records) inspect(record.path, record.attributes);
  return sortIssues(issues);
}

function uniqueRecord(index, id, expectedTypes, issues, contextPath, code) {
  if (typeof id !== 'string' || !ID.test(id)) {
    issues.push(makeIssue(code, contextPath, `Invalid canonical record ID: ${String(id)}`, []));
    return null;
  }
  const matches = index.byId.get(id) ?? [];
  if (matches.length !== 1) {
    issues.push(makeIssue(matches.length > 1 ? 'COVERAGE_DUPLICATE_ID' : code, contextPath,
      matches.length > 1 ? `Canonical record ID is ambiguous: ${id}` : `Canonical record does not exist: ${id}`, [id]));
    return null;
  }
  const record = matches[0];
  if (!expectedTypes.includes(record.attributes.type)) {
    issues.push(makeIssue(code, contextPath, `Record ${id} has type ${String(record.attributes.type)}; expected ${expectedTypes.join(' or ')}`, [id]));
    return null;
  }
  if (!isCanonicalRecordLocation(record)) {
    issues.push(makeIssue(code, record.path, `Record ${id} is not in its canonical location`, [id]));
    return null;
  }
  return record;
}

function schemaAndHistoryIssues(record, code) {
  const issues = [];
  if (!usableRecord(record)) return [makeIssue(code, safePath(record), 'Record shape is invalid', [safeId(record)].filter(Boolean))];
  const schema = schemaForRecordType(record.attributes.type);
  if (!schema) return [makeIssue(code, record.path, `Unknown record type: ${String(record.attributes.type)}`, [safeId(record)].filter(Boolean))];
  try {
    for (const schemaIssue of validateRecord(schema, record.attributes)) {
      issues.push(makeIssue(code, record.path, `${schemaIssue.path} ${schemaIssue.message}`, [record.attributes.id]));
    }
    for (const historyIssue of validateStatusHistory(record.attributes, record.path)) {
      issues.push(makeIssue(code, record.path, historyIssue.message, [record.attributes.id]));
    }
  } catch (error) {
    issues.push(makeIssue(code, record.path, `Record validation failed safely: ${error.message}`, [record.attributes.id]));
  }
  return issues;
}

function resolveRegistered(project, ref) {
  try {
    resolveResourceRef(project, ref);
    return true;
  } catch {
    return false;
  }
}

function safeResponseTarget(value) {
  if (typeof value !== 'string' || !value.startsWith('response:')) return false;
  let anchor = value.slice('response:'.length);
  for (let depth = 0; depth < 3; depth += 1) {
    if (anchor.length === 0 || /[\\\r\n\u2028\u2029\0]/u.test(anchor) || anchor.startsWith('/')) return false;
    const segments = anchor.split('/');
    if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) return false;
    let decoded;
    try { decoded = decodeURIComponent(anchor); } catch { return false; }
    if (decoded === anchor) return true;
    anchor = decoded;
  }
  try { if (decodeURIComponent(anchor) !== anchor) return false; } catch { return false; }
  return anchor.length > 0 && !/[\\\r\n\u2028\u2029\0]/u.test(anchor) && !anchor.startsWith('/') &&
    !anchor.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..');
}

function projectRecord(index, issues, path) {
  if (!index.project) issues.push(makeIssue('RESPONSE_PROJECT_INVALID', path, 'A unique canonical PROJECT.md is required'));
  return index.project;
}

function numericLiterals(texts) {
  const found = [];
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    for (const match of text.matchAll(NUMBER)) found.push(match[0]);
  }
  return [...new Set(found)].sort((a, b) => a.localeCompare(b, 'en'));
}

function containsPlaceholder(value, ancestors = new WeakSet()) {
  if (typeof value === 'string') return PLACEHOLDER.test(value);
  if (!value || typeof value !== 'object' || ancestors.has(value)) return false;
  ancestors.add(value);
  let found = false;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = descriptors[key];
      if (descriptor && Object.hasOwn(descriptor, 'value') && containsPlaceholder(descriptor.value, ancestors)) { found = true; break; }
    }
  } catch { found = true; }
  ancestors.delete(value);
  if (found) return true;
  return false;
}

function formalAuthorityFields(record) {
  const attributes = record.attributes;
  if (attributes.type === 'claim') return [attributes.statement, attributes.conditions, attributes.prohibited_expansion, attributes.confidence_and_limitations];
  if (attributes.type === 'evidence') return [attributes.figures_and_numbers, attributes.interpretation, attributes.limitations, attributes.unsupported_claims];
  if (attributes.type === 'decision') return [attributes.question, attributes.options, attributes.selected_option, attributes.rationale, attributes.approver, attributes.reopen_conditions];
  return [];
}

function unresolvedAuthorityIssue(record) {
  return containsPlaceholder(formalAuthorityFields(record))
    ? makeIssue('RESPONSE_UNRESOLVED_AUTHORITY', record.path, `Reviewer-facing ${record.attributes.type} authority contains an unresolved marker`, [record.attributes.id])
    : null;
}

function validateNumericSources(record, index, project, texts) {
  const issues = [];
  const path = safePath(record);
  const id = safeId(record);
  const declarations = record?.attributes?.numeric_sources;
  if (!Array.isArray(declarations)) {
    return [makeIssue('NUMERIC_SOURCE_SHAPE', path, 'numeric_sources must be an array', [id].filter(Boolean))];
  }
  const literals = numericLiterals(texts);
  const declared = new Map();
  for (const [position, item] of declarations.entries()) {
    if (!item || Array.isArray(item) || typeof item !== 'object' ||
      !['literal', 'evidence', 'locator'].every(key => Object.hasOwn(item, key)) || Object.keys(item).length !== 3 ||
      !meaningful(item.literal) || typeof item.evidence !== 'string' || !ID.test(item.evidence) || !meaningful(item.locator)) {
      issues.push(makeIssue('NUMERIC_SOURCE_SHAPE', path, `numeric_sources[${position}] must have exact literal/evidence/locator fields`, [id].filter(Boolean)));
      continue;
    }
    const entries = declared.get(item.literal) ?? [];
    entries.push(item);
    declared.set(item.literal, entries);
    const evidence = uniqueRecord(index, item.evidence, ['evidence'], issues, path, 'NUMERIC_SOURCE_EVIDENCE');
    if (evidence && (evidence.attributes.status !== 'closed' || schemaAndHistoryIssues(evidence, 'NUMERIC_SOURCE_EVIDENCE').length > 0)) {
      issues.push(makeIssue('NUMERIC_SOURCE_EVIDENCE', evidence.path, `Numeric source Evidence must be closed and valid: ${item.evidence}`, [id, item.evidence].filter(Boolean)));
    }
    if (!resolveRegistered(project, item.locator)) {
      issues.push(makeIssue('NUMERIC_SOURCE_LOCATOR', path, `Numeric source locator is not a safe registered resource reference: ${item.locator}`, [id].filter(Boolean)));
    }
    if (evidence && (!Array.isArray(evidence.attributes.sources) || !evidence.attributes.sources.includes(item.locator))) {
      issues.push(makeIssue('NUMERIC_SOURCE_LOCATOR', path, `Numeric locator is not declared by Evidence ${item.evidence}: ${item.locator}`, [id, item.evidence].filter(Boolean)));
    }
  }
  for (const literal of literals) {
    if (!declared.has(literal)) issues.push(makeIssue('NUMERIC_SOURCE_UNDECLARED', path, `Numeric literal has no exact source declaration: ${literal}`, [id].filter(Boolean)));
  }
  for (const [literal, items] of declared) {
    if (items.length > 1) issues.push(makeIssue('NUMERIC_SOURCE_DUPLICATE', path, `Numeric source declaration is duplicated: ${literal}`, [id].filter(Boolean)));
    if (!literals.includes(literal)) issues.push(makeIssue('NUMERIC_SOURCE_STALE', path, `Numeric source declaration is not used in reviewer-facing text: ${literal}`, [id].filter(Boolean)));
  }
  return issues;
}

function validateClaim(record, index, issues, contextPath, allowedOpenDriverIds = []) {
  if (!record) return false;
  const allowedOpenDrivers = safeAllowedOpenDriverIds(allowedOpenDriverIds);
  const id = record.attributes.id;
  const before = issues.length;
  issues.push(...schemaAndHistoryIssues(record, 'RESPONSE_CLAIM_INVALID'));
  if (record.attributes.approval_status !== 'approved' || record.attributes.status === 'reopened') {
    issues.push(makeIssue('RESPONSE_CLAIM_UNAPPROVED', record.path, `Claim is not approved for delivery: ${id}`, [id]));
  }
  const markerIssue = unresolvedAuthorityIssue(record);
  if (markerIssue) issues.push(markerIssue);
  if (!Array.isArray(record.attributes.evidence) || record.attributes.evidence.length === 0) {
    issues.push(makeIssue('RESPONSE_CLAIM_EVIDENCE', record.path, `Claim has no Evidence links: ${id}`, [id]));
  } else {
    for (const evidenceId of record.attributes.evidence) {
      const evidence = uniqueRecord(index, evidenceId, ['evidence'], issues, contextPath, 'RESPONSE_CLAIM_EVIDENCE');
      if (!evidence) continue;
      issues.push(...schemaAndHistoryIssues(evidence, 'RESPONSE_CLAIM_EVIDENCE'));
      if (evidence.attributes.status !== 'closed') {
        issues.push(makeIssue('RESPONSE_CLAIM_EVIDENCE', evidence.path, `Claim Evidence must be closed: ${evidenceId}`, [id, evidenceId]));
      }
      const sources = inspectEvidenceSources(index.project, evidence);
      for (const broken of sources.brokenSources) {
        issues.push(makeIssue('RESPONSE_CLAIM_EVIDENCE', evidence.path, `Evidence source is broken: ${String(broken.ref)}`, [id, evidenceId]));
      }
      for (const field of PROVENANCE_LINK_FIELDS.evidence) {
        const inspected = inspectProvenanceLinkValues(evidence, field);
        if (inspected.invalidValues.length > 0) issues.push(makeIssue('RESPONSE_CLAIM_EVIDENCE', evidence.path, `Evidence ${field} contains invalid link values`, [id, evidenceId]));
        for (const targetId of inspected.targets) {
          const target = uniqueRecord(index, targetId, PROVENANCE_TARGET_TYPES.evidence[field] ?? [], issues, evidence.path, 'RESPONSE_CLAIM_EVIDENCE');
          if (!target) continue;
        }
      }
    }
  }
  try {
    const safeCatalog = new Map(index.records.map(item => [item.path, item]));
    const graph = traceClaimCatalog(safeCatalog, id);
    const broken = graph.brokenLinks.length > 0 || graph.brokenSources.length > 0;
    const hasDriver = graph.types.has('driver');
    const hasSource = graph.types.has('run') || graph.externalSources.length > 0;
    if (broken || !hasDriver || !hasSource) {
      issues.push(makeIssue('RESPONSE_CLAIM_PROVENANCE', record.path, `Approved Claim requires unbroken provenance to a Driver and a Run or registered Evidence source: ${id}`, [id]));
    }
    for (const node of graph.nodes) {
      const matches = index.byId.get(node.id) ?? [];
      if (matches.length !== 1) {
        issues.push(makeIssue('RESPONSE_CLAIM_PROVENANCE', record.path, `Transitive provenance node is missing or ambiguous: ${node.id}`, [id, node.id]));
        continue;
      }
      const target = matches[0];
      const invalid = schemaAndHistoryIssues(target, 'RESPONSE_CLAIM_PROVENANCE');
      issues.push(...invalid);
      if (!isCanonicalRecordLocation(target)) {
        issues.push(makeIssue('RESPONSE_CLAIM_PROVENANCE', target.path, `Transitive provenance node is noncanonical: ${node.id}`, [id, node.id]));
      }
      if (target.attributes.type === 'driver' && target.attributes.status !== 'closed') {
        if (target.attributes.status === 'reopened') {
          issues.push(makeIssue('RESPONSE_CLAIM_PROVENANCE', target.path, `Transitive Driver provenance is reopened: ${node.id}`, [id, node.id]));
        } else if (!allowedOpenDrivers.has(node.id) || !['review', 'verified'].includes(target.attributes.status)) {
          issues.push(makeIssue('RESPONSE_CLAIM_PROVENANCE', target.path, `Non-current transitive Driver provenance must be closed: ${node.id}`, [id, node.id]));
        }
      } else if (target.attributes.type !== 'driver' && target.attributes.status !== 'closed') {
        issues.push(makeIssue('RESPONSE_CLAIM_PROVENANCE', target.path, `Transitive provenance node must be closed: ${node.id}`, [id, node.id]));
      }
      if (target.attributes.type === 'result' && !['adopted', 'credible_negative'].includes(target.attributes.classification)) {
        issues.push(makeIssue('RESPONSE_CLAIM_PROVENANCE', target.path, `Result is not accepted for Claim provenance: ${node.id}`, [id, node.id]));
      }
      if (target.attributes.type === 'run' && (target.attributes.official !== true || target.attributes.run_status !== 'completed')) {
        issues.push(makeIssue('RESPONSE_CLAIM_PROVENANCE', target.path, `Run is not an official completed source: ${node.id}`, [id, node.id]));
      }
      if (target.attributes.type === 'manifest' && target.attributes.manifest_complete !== true) {
        issues.push(makeIssue('RESPONSE_CLAIM_PROVENANCE', target.path, `Manifest is incomplete: ${node.id}`, [id, node.id]));
      }
    }
  } catch {
    issues.push(makeIssue('RESPONSE_CLAIM_PROVENANCE', record.path, `Approved Claim provenance cannot be traced safely: ${id}`, [id]));
  }
  return issues.length === before;
}

function validateEvidenceRecord(record, index, issues, contextPath, code = 'RESPONSE_EVIDENCE_INVALID') {
  if (!record) return false;
  const before = issues.length;
  issues.push(...schemaAndHistoryIssues(record, code));
  if (record.attributes.status !== 'closed') {
    issues.push(makeIssue('RESPONSE_EVIDENCE_STATUS', record.path, `Evidence must be closed: ${record.attributes.id}`, [record.attributes.id]));
  }
  const inspectedSources = inspectEvidenceSources(index.project, record);
  for (const broken of inspectedSources.brokenSources) {
    issues.push(makeIssue(code, record.path, `Evidence source is broken: ${String(broken.ref)}`, [record.attributes.id]));
  }
  const markerIssue = unresolvedAuthorityIssue(record);
  if (markerIssue) issues.push(markerIssue);
  for (const field of PROVENANCE_LINK_FIELDS.evidence) {
    const inspected = inspectProvenanceLinkValues(record, field);
    if (inspected.invalidValues.length > 0) issues.push(makeIssue(code, record.path, `Evidence ${field} contains invalid link values`, [record.attributes.id]));
    for (const targetId of inspected.targets) {
      uniqueRecord(index, targetId, PROVENANCE_TARGET_TYPES.evidence[field] ?? [], issues, contextPath, code);
    }
  }
  return issues.length === before;
}

function allowedChangeConcernIds(record, responseContext, index, issues) {
  const responseIds = record.attributes.response_blocks;
  const resolved = [];
  let valid = Array.isArray(responseIds) && responseIds.length > 0 &&
    responseIds.every(value => typeof value === 'string' && ID.test(value)) && new Set(responseIds).size === responseIds.length;
  if (!valid) {
    issues.push(makeIssue('MANUSCRIPT_CHANGE_RESPONSE_LINK', record.path, 'Manuscript Change must declare unique canonical Response Block links', [record.attributes.id]));
    return [];
  }
  for (const responseId of responseIds) {
    const before = issues.length;
    const responseRecord = uniqueRecord(index, responseId, ['writing'], issues, record.path, 'MANUSCRIPT_CHANGE_RESPONSE_LINK');
    if (!responseRecord) { valid = false; continue; }
    if (responseRecord.attributes.writing_kind !== 'response_block' || !isCanonicalRecordLocation(responseRecord)) {
      issues.push(makeIssue('MANUSCRIPT_CHANGE_RESPONSE_LINK', responseRecord.path, `Linked record must be a canonical Response Block: ${responseId}`, [record.attributes.id, responseId]));
    }
    issues.push(...schemaAndHistoryIssues(responseRecord, 'MANUSCRIPT_CHANGE_RESPONSE_LINK'));
    const concern = uniqueRecord(index, responseRecord.attributes.concern, ['driver'], issues, responseRecord.path, 'MANUSCRIPT_CHANGE_RESPONSE_LINK');
    if (concern && (concern.attributes.driver_kind !== 'concern' || !isCanonicalRecordLocation(concern))) {
      issues.push(makeIssue('MANUSCRIPT_CHANGE_RESPONSE_LINK', concern.path, `Response Block must link one canonical Concern: ${responseId}`, [record.attributes.id, responseId, concern.attributes.id]));
    }
    if (issues.length !== before || !concern) valid = false;
    else resolved.push({ response: responseRecord, concern });
  }
  if (!valid) return [];
  if (responseContext) {
    const context = resolved.find(item => item.response.attributes.id === responseContext.attributes?.id && item.response.path === responseContext.path);
    if (!context || responseContext.attributes?.writing_kind !== 'response_block' || !isCanonicalRecordLocation(responseContext)) {
      issues.push(makeIssue('MANUSCRIPT_CHANGE_RESPONSE_LINK', record.path, 'Calling Response Block is not an exact canonical response_blocks authority', [record.attributes.id, safeId(responseContext)].filter(Boolean)));
      return [];
    }
    return [context.concern.attributes.id];
  }
  return [...new Set(resolved.map(item => item.concern.attributes.id))].sort((a, b) => a.localeCompare(b, 'en'));
}

function validateManuscriptChange(record, responseContext, index) {
  const issues = [];
  if (!usableRecord(record) || record.attributes.type !== 'writing' || record.attributes.writing_kind !== 'manuscript_change') {
    return [makeIssue('MANUSCRIPT_CHANGE_KIND', safePath(record), 'Referenced record is not a Manuscript Change', [safeId(record)].filter(Boolean))];
  }
  const { attributes } = record;
  issues.push(...schemaAndHistoryIssues(record, 'MANUSCRIPT_CHANGE_INVALID'));
  if (!isCanonicalRecordLocation(record)) issues.push(makeIssue('MANUSCRIPT_CHANGE_LOCATION', record.path, 'Manuscript Change is not canonical', [attributes.id]));
  const keys = Array.isArray(attributes.target_source_keys) ? [...new Set(attributes.target_source_keys)].sort() : [];
  if (JSON.stringify(keys) !== JSON.stringify(['manuscript_clean', 'manuscript_marked'])) {
    issues.push(makeIssue('MANUSCRIPT_CHANGE_TARGETS', record.path, 'target_source_keys must cover manuscript_clean and manuscript_marked exactly', [attributes.id]));
  }
  const canonical = index.project?.canonical_writing_sources;
  for (const key of ['manuscript_clean', 'manuscript_marked']) {
    if (!meaningful(attributes.source_identities?.[key]) || attributes.source_identities?.[key] !== canonical?.[key]?.source_identity) {
      issues.push(makeIssue('MANUSCRIPT_CHANGE_SOURCE_IDENTITY', record.path, `Manuscript Change ${key} identity does not match PROJECT`, [attributes.id]));
    }
  }
  if (meaningful(canonical?.manuscript_clean?.content_identity) && meaningful(canonical?.manuscript_marked?.content_identity) &&
    canonical.manuscript_clean.content_identity !== canonical.manuscript_marked.content_identity) {
    issues.push(makeIssue('MANUSCRIPT_CHANGE_CONTENT_MISMATCH', record.path, 'PROJECT clean and marked manuscript content_identity must match', [attributes.id]));
  }
  if (attributes.synchronization_status !== 'synchronized' || attributes.status !== 'closed') {
    issues.push(makeIssue('MANUSCRIPT_CHANGE_NOT_SYNCHRONIZED', record.path, 'Manuscript Change must be closed and synchronized', [attributes.id]));
  }
  if (attributes.verification_result !== 'passed') {
    issues.push(makeIssue('MANUSCRIPT_CHANGE_NOT_VERIFIED', record.path, 'Manuscript Change verification_result must be passed', [attributes.id]));
  }
  const allowedOpenDriverIds = allowedChangeConcernIds(record, responseContext, index, issues);
  if ([attributes.purpose, attributes.draft, attributes.change_summary]
    .some(value => typeof value === 'string' && PLACEHOLDER.test(value))) {
    issues.push(makeIssue('MANUSCRIPT_CHANGE_UNRESOLVED_MARKER', record.path, 'Manuscript Change contains an unresolved marker', [attributes.id]));
  }
  for (const claimId of Array.isArray(attributes.claims) ? attributes.claims : []) {
    const claim = uniqueRecord(index, claimId, ['claim'], issues, record.path, 'MANUSCRIPT_CHANGE_CLAIM');
    validateClaim(claim, index, issues, record.path, allowedOpenDriverIds);
  }
  issues.push(...validateNumericSources(record, index, index.project, [attributes.draft]));
  return issues;
}

/** Validate one Manuscript Change independently of graph reachability. */
export function validateManuscriptChangeRecord(record, catalog) {
  const normalized = safePlain(record);
  if (!normalized.ok) return freezeIssues([makeIssue('MANUSCRIPT_CHANGE_KIND', '<manuscript-change>', 'Manuscript Change must be safe plain JSON data')]);
  return freezeIssues(validateManuscriptChange(normalized.value, null, indexCatalog(catalog)));
}

/** Return all candidate and semantic issues for reviewer-facing records, including orphans. */
export function validateReviewerFacingCatalog(catalog) {
  const index = indexCatalog(catalog);
  const issues = [...index.candidateIssues];
  if (!index.validCatalog) issues.push(makeIssue('RESPONSE_CATALOG_INVALID', 'catalog', 'Catalog must expose only safe canonical RecordRef values'));
  const safeCatalog = new Map(index.records.map(record => [record.path, record]));
  for (const record of index.records) {
    if (record.attributes.type !== 'writing') continue;
    if (record.attributes.writing_kind === 'response_block') issues.push(...validateResponseBlock(record, safeCatalog));
    if (record.attributes.writing_kind === 'manuscript_change') issues.push(...validateManuscriptChange(record, null, index));
  }
  return freezeIssues(issues);
}

/**
 * Validate one canonical reviewer-facing Response Block without mutating its catalog.
 * @param {unknown} responseRecord
 * @param {unknown} catalog canonical RecordRef map/facade with primitive-string keys exactly equal to RecordRef.path
 * @returns {ReadonlyArray<Readonly<{severity:'error'|'warning',code:string,path:string,message:string,relatedIds:ReadonlyArray<string>}>>}
 */
export function validateResponseBlock(responseRecord, catalog) {
  const normalized = safePlain(responseRecord);
  const issues = [];
  const index = indexCatalog(catalog);
  if (!normalized.ok) return freezeIssues([makeIssue('RESPONSE_RECORD_SHAPE', '<response>', 'Response Block must be safe plain JSON data')]);
  responseRecord = normalized.value;
  const path = safePath(responseRecord);
  const id = safeId(responseRecord);
  if (!index.validCatalog) issues.push(makeIssue('RESPONSE_CATALOG_INVALID', path, 'Catalog must expose only canonical RecordRef values'));
  if (!usableRecord(responseRecord)) {
    issues.push(makeIssue('RESPONSE_RECORD_SHAPE', path, 'Response Block record shape is invalid', [id].filter(Boolean)));
    return freezeIssues(issues);
  }
  const attributes = responseRecord.attributes;
  let allowedOpenDriverIds = [];
  if (attributes.type !== 'writing' || attributes.writing_kind !== 'response_block') {
    issues.push(makeIssue('RESPONSE_RECORD_KIND', path, 'Record must be writing/response_block', [id].filter(Boolean)));
  }
  if (!isCanonicalRecordLocation(responseRecord)) issues.push(makeIssue('RESPONSE_RECORD_LOCATION', path, 'Response Block is not in its canonical location', [id].filter(Boolean)));
  issues.push(...schemaAndHistoryIssues(responseRecord, 'RESPONSE_RECORD_INVALID'));
  const required = ['concern', 'direct_answer', 'evidence_or_reason', 'limitations', 'manuscript_changes', 'covered_actions'];
  for (const field of required) {
    if (!meaningful(attributes[field])) issues.push(makeIssue('RESPONSE_FIELD_REQUIRED', path, `Response Block field is required and meaningful: ${field}`, [id].filter(Boolean)));
  }
  if (meaningful(attributes.direct_answer) && /[\r\n\u2028\u2029\0]/u.test(attributes.direct_answer)) {
    issues.push(makeIssue('RESPONSE_DIRECT_ANSWER_UNSAFE', path, 'direct_answer must be a single-line reviewer-facing answer', [id].filter(Boolean)));
  }
  for (const field of ['purpose', 'direct_answer', 'draft', 'limitations']) {
    if (typeof attributes[field] === 'string' && PLACEHOLDER.test(attributes[field])) {
      issues.push(makeIssue('RESPONSE_UNRESOLVED_MARKER', path, `Reviewer-facing field contains an unresolved marker: ${field}`, [id].filter(Boolean)));
    }
  }
  const project = projectRecord(index, issues, path);
  if (!safeResponseTarget(attributes.target_location)) {
    issues.push(makeIssue('RESPONSE_TARGET_SOURCE', path, 'target_location must use response:<safe meaningful anchor>', [id].filter(Boolean)));
  }
  const concern = uniqueRecord(index, attributes.concern, ['driver'], issues, path, 'RESPONSE_CONCERN_INVALID');
  if (concern) {
    if (concern.attributes.driver_kind !== 'concern' || !isCanonicalRecordLocation(concern)) {
      issues.push(makeIssue('RESPONSE_CONCERN_INVALID', concern.path, 'Response concern must be a canonical Concern Driver', [id, concern.attributes.id].filter(Boolean)));
    }
    if (concern.attributes.driver_kind === 'concern' && isCanonicalRecordLocation(concern)) allowedOpenDriverIds = [concern.attributes.id];
    issues.push(...schemaAndHistoryIssues(concern, 'RESPONSE_CONCERN_INVALID'));
    if (!resolveRegistered(project, concern.attributes.source_ref)) {
      issues.push(makeIssue('RESPONSE_CONCERN_SOURCE', concern.path, 'Concern source_ref must resolve through PROJECT.resources', [concern.attributes.id]));
    }
    const expected = Array.isArray(concern.attributes.actions) ? [...new Set(concern.attributes.actions)].sort() : [];
    const covered = Array.isArray(attributes.covered_actions) ? [...new Set(attributes.covered_actions)].sort() : [];
    if (JSON.stringify(expected) !== JSON.stringify(covered)) {
      issues.push(makeIssue('RESPONSE_ACTION_COVERAGE', path, `covered_actions must exactly cover Concern Actions: ${expected.join(', ')}`, [id, concern.attributes.id].filter(Boolean)));
    }
    for (const actionId of Array.isArray(attributes.covered_actions) ? attributes.covered_actions : []) {
      const action = uniqueRecord(index, actionId, ['action'], issues, path, 'RESPONSE_ACTION_INVALID');
      if (action && action.attributes.driver !== concern.attributes.id) {
        issues.push(makeIssue('RESPONSE_ACTION_INVALID', action.path, `Action ${actionId} is owned by another Driver`, [concern.attributes.id, actionId]));
      }
    }
  }
  for (const targetId of Array.isArray(attributes.evidence_or_reason) ? attributes.evidence_or_reason : []) {
    const target = uniqueRecord(index, targetId, ['evidence', 'decision'], issues, path, 'RESPONSE_EVIDENCE_INVALID');
    if (target) {
      issues.push(...schemaAndHistoryIssues(target, 'RESPONSE_EVIDENCE_INVALID'));
      if (target.attributes.status !== 'closed') issues.push(makeIssue('RESPONSE_EVIDENCE_STATUS', target.path, `Evidence or Decision must be closed: ${targetId}`, [id, targetId].filter(Boolean)));
      if (target.attributes.type === 'evidence') validateEvidenceRecord(target, index, issues, path);
      const authorityMarker = unresolvedAuthorityIssue(target);
      if (authorityMarker) issues.push(authorityMarker);
    }
  }
  for (const claimId of Array.isArray(attributes.claims) ? attributes.claims : []) {
    const claim = uniqueRecord(index, claimId, ['claim'], issues, path, 'RESPONSE_CLAIM_INVALID');
    validateClaim(claim, index, issues, path, allowedOpenDriverIds);
  }
  for (const changeId of Array.isArray(attributes.manuscript_changes) ? attributes.manuscript_changes : []) {
    const change = uniqueRecord(index, changeId, ['writing'], issues, path, 'RESPONSE_CHANGE_INVALID');
    if (change) issues.push(...validateManuscriptChange(change, responseRecord, index));
  }
  issues.push(...validateNumericSources(responseRecord, index, project, [attributes.direct_answer, attributes.draft, attributes.limitations]));
  return freezeIssues(issues);
}

function closureDependencySet(rootIds, index) {
  const reached = new Set();
  const queue = [...rootIds].filter(value => typeof value === 'string').sort();
  while (queue.length > 0) {
    const id = queue.shift();
    if (reached.has(id)) continue;
    reached.add(id);
    const matches = index.byId.get(id) ?? [];
    if (matches.length !== 1) continue;
    const record = matches[0];
    const fields = record.attributes.type === 'claim' ? ['evidence']
      : record.attributes.type === 'evidence' ? ['sources', 'counterevidence']
        : record.attributes.type === 'writing' ? ['claims', 'evidence_or_reason', 'manuscript_changes']
          : record.attributes.type === 'result' ? ['run']
            : record.attributes.type === 'run' ? ['experiment', 'manifest'] : [];
    for (const field of fields) {
      const inspected = inspectProvenanceLinkValues(record, field);
      for (const target of inspected.targets) if (!reached.has(target)) queue.push(target);
    }
    queue.sort((left, right) => left.localeCompare(right, 'en'));
  }
  return reached;
}

function actionReachesClosure(action, closureIds, index, concernId, actionIds, issues, visited = new Set()) {
  const id = action.attributes.id;
  if (visited.has(id)) {
    issues.push(makeIssue('COVERAGE_ACTION_OUTPUT', action.path, `Action output chain contains a cycle at ${id}`, [id, concernId]));
    return false;
  }
  const nextVisited = new Set(visited).add(id);
  const inspected = inspectProvenanceLinkValues(action, 'outputs');
  let reaches = false;
  for (const targetId of inspected.targets) {
    if (closureIds.has(targetId)) { reaches = true; continue; }
    const matches = index.byId.get(targetId) ?? [];
    if (matches.length !== 1 || matches[0].attributes.type !== 'action') continue;
    const target = matches[0];
    const valid = actionIds.has(targetId) && target.attributes.driver === concernId && target.attributes.status === 'closed' &&
      isCanonicalRecordLocation(target) && schemaAndHistoryIssues(target, 'COVERAGE_ACTION_OUTPUT').length === 0;
    if (!valid) {
      issues.push(makeIssue('COVERAGE_ACTION_OUTPUT', target.path, `Intermediate Action must be closed, canonical, owned by ${concernId}, and listed by the Concern: ${targetId}`, [id, targetId, concernId]));
      continue;
    }
    if (actionReachesClosure(target, closureIds, index, concernId, actionIds, issues, nextVisited)) reaches = true;
  }
  return reaches;
}

function validateActionLinks(action, concernId, authoritativeActionIds, index, closureIds) {
  const issues = [...schemaAndHistoryIssues(action, 'COVERAGE_ACTION_INVALID')];
  if (!isCanonicalRecordLocation(action) || action.attributes.driver !== concernId) {
    issues.push(makeIssue('COVERAGE_ACTION_INVALID', action.path, `Action must be canonical and owned by ${concernId}`, [action.attributes.id, concernId]));
  }
  for (const field of ['inputs', 'dependencies']) {
    const inspected = inspectProvenanceLinkValues(action, field);
    if (inspected.invalidValues.length > 0) issues.push(makeIssue('COVERAGE_ACTION_LINK', action.path, `Action ${field} contains malformed IDs`, [action.attributes.id]));
    for (const targetId of inspected.targets) {
      uniqueRecord(index, targetId, PROVENANCE_TARGET_TYPES.action[field] ?? [], issues, action.path, 'COVERAGE_ACTION_LINK');
    }
  }
  const outputs = inspectProvenanceLinkValues(action, 'outputs');
  if (!Array.isArray(action.attributes.outputs) || action.attributes.outputs.length === 0 || outputs.invalidValues.length > 0) {
    issues.push(makeIssue('COVERAGE_ACTION_OUTPUT', action.path, 'Closed Concern Action must declare nonempty canonical outputs', [action.attributes.id, concernId]));
  }
  for (const targetId of outputs.targets) {
    const before = issues.length;
    const target = uniqueRecord(index, targetId, PROVENANCE_TARGET_TYPES.action.outputs ?? [], issues, action.path, 'COVERAGE_ACTION_LINK');
    if (!target) continue;
    issues.push(...schemaAndHistoryIssues(target, 'COVERAGE_ACTION_OUTPUT'));
    if (!isCanonicalRecordLocation(target) || target.attributes.status !== 'closed') {
      issues.push(makeIssue('COVERAGE_ACTION_OUTPUT', target.path, `Action output must be canonical and closed: ${targetId}`, [action.attributes.id, targetId]));
    }
    if (target.attributes.type === 'action' && (target.attributes.driver !== concernId || !authoritativeActionIds.has(targetId))) {
      issues.push(makeIssue('COVERAGE_ACTION_OUTPUT', target.path, `Action output must remain inside ${concernId}'s authoritative action set: ${targetId}`, [action.attributes.id, targetId, concernId]));
    }
    if (issues.length > before) issues.push(makeIssue('COVERAGE_ACTION_OUTPUT', action.path, `Action output is invalid: ${targetId}`, [action.attributes.id, targetId]));
  }
  if (outputs.targets.length === 0 || !actionReachesClosure(action, closureIds, index, concernId, authoritativeActionIds, issues)) {
    issues.push(makeIssue('COVERAGE_ACTION_OUTPUT', action.path, 'At least one Action output must reach this Concern closure graph', [action.attributes.id, concernId]));
  }
  return issues;
}

function buildConcernCoverage(concern, index) {
  const issues = [];
  const id = concern.attributes.id;
  if (!index.validCatalog) issues.push(makeIssue('COVERAGE_CATALOG_INVALID', concern.path, 'Catalog contains malformed non-RecordRef values', [id]));
  issues.push(...schemaAndHistoryIssues(concern, 'COVERAGE_CONCERN_INVALID'));
  if (!isCanonicalRecordLocation(concern)) issues.push(makeIssue('COVERAGE_CONCERN_INVALID', concern.path, 'Concern is not in its canonical location', [id]));
  if (!resolveRegistered(index.project, concern.attributes.source_ref)) issues.push(makeIssue('COVERAGE_CONCERN_SOURCE', concern.path, 'Concern source_ref is not registered', [id]));

  const actionIds = Array.isArray(concern.attributes.actions) ? [...new Set(concern.attributes.actions)].sort() : [];
  const openActions = [];
  const actions = [];
  for (const actionId of actionIds) {
    const action = uniqueRecord(index, actionId, ['action'], issues, concern.path, 'COVERAGE_ACTION_INVALID');
    if (!action) { openActions.push(actionId); continue; }
    actions.push(action);
    if (action.attributes.status !== 'closed') openActions.push(actionId);
  }

  const responseRecords = index.records.filter(record => record.attributes.type === 'writing' && record.attributes.writing_kind === 'response_block' && record.attributes.concern === id);
  const responseBlocks = [...new Set(responseRecords.map(record => record.attributes.id).filter(value => typeof value === 'string'))].sort();
  const validResponses = [];
  const claimIds = new Set();
  const evidenceOrReason = new Set();
  const changeIds = new Set();
  for (const response of responseRecords) {
    const responseIssues = validateResponseBlock(response, new Map(index.records.map(record => [record.path, record])));
    issues.push(...responseIssues);
    const closureReady = response.attributes.status === 'closed' && response.attributes.synchronization_status === 'synchronized' && response.attributes.verification_result === 'passed';
    if (!closureReady) {
      issues.push(makeIssue('COVERAGE_RESPONSE_STATUS', response.path, 'Response Block must be closed, synchronized, and verified before Concern closure', [response.attributes.id]));
    }
    if (closureReady && responseIssues.every(item => item.severity !== 'error')) validResponses.push(response.attributes.id);
    for (const value of Array.isArray(response.attributes.claims) ? response.attributes.claims : []) claimIds.add(value);
    for (const value of Array.isArray(response.attributes.evidence_or_reason) ? response.attributes.evidence_or_reason : []) evidenceOrReason.add(value);
    for (const value of Array.isArray(response.attributes.manuscript_changes) ? response.attributes.manuscript_changes : []) changeIds.add(value);
  }
  if (responseRecords.length === 0) issues.push(makeIssue('COVERAGE_RESPONSE_MISSING', concern.path, 'Concern has no reviewer-facing Response Block', [id]));
  if (validResponses.length === 0) issues.push(makeIssue('COVERAGE_RESPONSE_INVALID', concern.path, 'Concern has no valid Response Block covering every Action', [id, ...responseBlocks]));
  if (evidenceOrReason.size === 0) issues.push(makeIssue('COVERAGE_EVIDENCE_OR_REASON_MISSING', concern.path, 'Concern has no closed Evidence or Decision path', [id]));

  const unapprovedClaims = [];
  for (const claimId of [...claimIds].sort()) {
    const before = issues.length;
    const claim = uniqueRecord(index, claimId, ['claim'], issues, concern.path, 'RESPONSE_CLAIM_INVALID');
    const valid = validateClaim(claim, index, issues, concern.path, [id]);
    if (!claim || !valid || issues.length > before) unapprovedClaims.push(claimId);
  }
  const missingChanges = [];
  for (const changeId of [...changeIds].sort()) {
    const before = issues.length;
    const change = uniqueRecord(index, changeId, ['writing'], issues, concern.path, 'RESPONSE_CHANGE_INVALID');
    if (change) issues.push(...validateManuscriptChange(change, null, index));
    if (!change || issues.length > before) missingChanges.push(changeId);
  }

  const closureIds = closureDependencySet([...responseBlocks, ...evidenceOrReason, ...claimIds, ...changeIds], index);
  const authoritativeActionIds = new Set(actionIds);
  for (const action of actions) issues.push(...validateActionLinks(action, id, authoritativeActionIds, index, closureIds));

  let closable = openActions.length === 0 && validResponses.length > 0 && evidenceOrReason.size > 0 && unapprovedClaims.length === 0 && missingChanges.length === 0 && issues.every(item => item.severity !== 'error');
  if (concern.attributes.status === 'reopened') closable = false;
  if (concern.attributes.status === 'closed' && !closable) {
    issues.push(makeIssue('CLOSED_CONCERN_NOT_CLOSABLE', concern.path, 'Concern is closed but its response graph is not closable', [id]));
    closable = false;
  }
  return {
    id,
    path: concern.path,
    sourceCommentId: concern.attributes.source_comment_id,
    sourceRef: concern.attributes.source_ref,
    actionIds,
    evidenceOrReason: [...evidenceOrReason].sort(),
    claimIds: [...claimIds].sort(),
    responseBlocks,
    manuscriptChanges: [...changeIds].sort(),
    openActions: [...new Set(openActions)].sort(),
    unapprovedClaims: [...new Set(unapprovedClaims)].sort(),
    missingChanges: [...new Set(missingChanges)].sort(),
    issues: sortIssues(issues),
    closable
  };
}

/**
 * Compute deterministic reviewer-comment and Concern closure coverage.
 * @param {unknown} catalog canonical RecordRef map/facade with primitive-string keys exactly equal to RecordRef.path
 * @returns {Readonly<{comments:object,concerns:object,issues:ReadonlyArray<object>,openActions:ReadonlyArray<string>,unapprovedClaims:ReadonlyArray<string>,missingChanges:ReadonlyArray<string>,closable:boolean}>}
 */
export function computeConcernCoverage(catalog) {
  const index = indexCatalog(catalog);
  const globalIssues = validateReviewerFacingCatalog(catalog);
  if (index.records.length === 0 || !index.project) {
    return deepFreeze({ comments: {}, concerns: {}, issues: globalIssues, openActions: [], unapprovedClaims: [], missingChanges: [], closable: false });
  }
  const concernRecords = index.records.filter(record => record.attributes.type === 'driver' && record.attributes.driver_kind === 'concern');
  const detail = {};
  for (const concern of concernRecords) {
    if (typeof concern.attributes.id !== 'string' || Object.hasOwn(detail, concern.attributes.id)) continue;
    detail[concern.attributes.id] = buildConcernCoverage(concern, index);
  }
  const sourceGroups = new Map();
  for (const item of Object.values(detail)) {
    const members = sourceGroups.get(item.sourceCommentId) ?? [];
    members.push(item);
    sourceGroups.set(item.sourceCommentId, members);
  }
  for (const members of sourceGroups.values()) {
    const refs = [...new Set(members.map(item => item.sourceRef))];
    if (members.length < 2 || refs.length < 2) continue;
    for (const item of members) {
      item.issues = sortIssues([...item.issues, makeIssue(
        'COVERAGE_COMMENT_SOURCE_CONFLICT',
        item.path,
        `Concerns sharing source_comment_id must share one source_ref; found ${refs.join(', ')}`,
        members.map(member => member.id)
      )]);
      item.closable = false;
    }
  }
  const comments = {};
  for (const item of Object.values(detail)) {
    const key = meaningful(item.sourceCommentId) ? item.sourceCommentId : '<missing>';
    const current = comments[key] ?? { sourceRef: item.sourceRef, concernIds: [] };
    current.concernIds.push(item.id);
    comments[key] = current;
  }
  for (const item of Object.values(comments)) item.concernIds.sort();
  const uniqueField = field => [...new Set(Object.values(detail).flatMap(item => item[field]))].sort();
  const concerns = Object.fromEntries(Object.entries(detail).sort(([a], [b]) => a.localeCompare(b, 'en')));
  return deepFreeze({
    comments: Object.fromEntries(Object.entries(comments).sort(([a], [b]) => a.localeCompare(b, 'en'))),
    concerns,
    issues: globalIssues,
    openActions: uniqueField('openActions'),
    unapprovedClaims: uniqueField('unapprovedClaims'),
    missingChanges: uniqueField('missingChanges'),
    closable: Object.keys(concerns).length > 0 && Object.values(concerns).every(item => item.closable) && globalIssues.every(item => item.severity !== 'error')
  });
}
