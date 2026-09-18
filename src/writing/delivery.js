import { deepFreeze, ReadonlyMap } from '../lib/readonly.js';
import { canonicalJson } from '../experiments/manifest.js';
import { resolveResourceRef } from '../project/resources.js';
import { isCanonicalRecordLocation, isValidDateTime, schemaForRecordType, validateRecord, validateStatusHistory } from '../validation/validator.js';
import { computeConcernCoverage, validateReviewerFacingCatalog } from './response.js';

const SOURCE_KEYS = Object.freeze(['manuscript_clean', 'manuscript_marked', 'response']);
const ARTIFACT_SPECS = Object.freeze({
  manuscript_clean_pdf: Object.freeze({ sourceKey: 'manuscript_clean' }),
  manuscript_marked_pdf: Object.freeze({ sourceKey: 'manuscript_marked' }),
  response_pdf: Object.freeze({ sourceKey: 'response' })
});
const SOURCE_FIELDS = Object.freeze(['content_identity', 'resource_ref', 'source_identity']);
const ARTIFACT_FIELDS = Object.freeze(['artifact_identity', 'artifact_ref', 'kind', 'source_identity', 'source_key', 'text_check', 'visual_check']);
const RECEIPT_FIELDS = Object.freeze(['artifact_identity', 'checked_at', 'receipt_id', 'status']);

function meaningful(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/[\r\n\u2028\u2029\0]/u.test(value);
}

function issue(code, path, message, relatedIds = []) {
  return { severity: 'error', code, path, message, relatedIds: [...new Set(relatedIds.filter(value => typeof value === 'string'))].sort((a, b) => a.localeCompare(b, 'en')) };
}

function sortIssues(items) {
  const unique = new Map();
  for (const item of items) {
    const normalized = issue(item.code, item.path, item.message, item.relatedIds);
    const key = JSON.stringify(normalized);
    if (!unique.has(key)) unique.set(key, normalized);
  }
  return [...unique.values()].sort((a, b) => a.path.localeCompare(b.path, 'en') || a.code.localeCompare(b.code, 'en') || a.message.localeCompare(b.message, 'en'));
}

function safeJson(value) {
  try { return { ok: true, value: canonicalJson(value) }; } catch { return { ok: false, value: null }; }
}

function recordsFrom(catalog) {
  let entries = [];
  try {
    if (catalog instanceof Map) entries = [...Map.prototype.entries.call(catalog)];
    else if (catalog instanceof ReadonlyMap) entries = [...ReadonlyMap.prototype.entries.call(catalog)];
    else return { records: [], valid: false, issues: [] };
  } catch {
    return { records: [], valid: false, issues: [] };
  }
  const records = [];
  const issues = [];
  let valid = entries.length > 0;
  for (const [key, item] of entries) {
    const cloned = safeJson(item);
    if (!cloned.ok || !cloned.value || Array.isArray(cloned.value) || typeof cloned.value !== 'object' ||
      typeof cloned.value.path !== 'string' || !cloned.value.attributes || Array.isArray(cloned.value.attributes) || typeof cloned.value.attributes !== 'object') {
      valid = false;
      continue;
    }
    if (typeof key !== 'string' || key !== cloned.value.path) {
      valid = false;
      issues.push(issue(
        'DELIVERY_CATALOG_KEY_PATH_INVALID',
        typeof key === 'string' ? key : 'catalog',
        'Catalog key must be a primitive string exactly equal to RecordRef.path'
      ));
      continue;
    }
    records.push(cloned.value);
  }
  records.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return { records, valid, issues: sortIssues(issues) };
}

function exactKeys(value, fields) {
  return value && !Array.isArray(value) && typeof value === 'object' &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());
}

function exactEqual(left, right) {
  try { return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right)); } catch { return false; }
}

function deliveryInput(value) {
  try {
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return { ok: false };
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key === 'symbol')) return { ok: false };
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expected = ['canonicalSources', 'catalog', 'renderedArtifacts'];
    if (keys.length !== expected.length || expected.some(key => !Object.hasOwn(descriptors, key))) return { ok: false };
    for (const key of expected) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || descriptor.get || descriptor.set || !Object.hasOwn(descriptor, 'value')) return { ok: false };
    }
    return { ok: true, catalog: descriptors.catalog.value, canonicalSources: descriptors.canonicalSources.value, renderedArtifacts: descriptors.renderedArtifacts.value };
  } catch {
    return { ok: false };
  }
}

function resolves(project, ref) {
  try {
    resolveResourceRef(project, ref);
    return true;
  } catch {
    return false;
  }
}

function projectFrom(records, issues) {
  const matches = records.filter(record => record.path === 'PROJECT.md' && record.attributes.type === 'project');
  if (matches.length !== 1) {
    issues.push(issue('DELIVERY_PROJECT_INVALID', 'PROJECT.md', 'Delivery requires one canonical PROJECT.md'));
    return null;
  }
  const project = matches[0];
  const schemaIssues = validateRecord('project', project.attributes);
  for (const item of schemaIssues) issues.push(issue('DELIVERY_PROJECT_INVALID', project.path, `${item.path} ${item.message}`, [project.attributes.id]));
  return project.attributes;
}

function validateSources(project, supplied, issues) {
  const summaries = {};
  if (!supplied || Array.isArray(supplied) || typeof supplied !== 'object') {
    issues.push(issue('DELIVERY_INPUT_SHAPE', 'canonicalSources', 'canonicalSources must be an object'));
    return summaries;
  }
  const keys = Object.keys(supplied).sort();
  if (JSON.stringify(keys) !== JSON.stringify(SOURCE_KEYS)) {
    issues.push(issue('DELIVERY_SOURCE_KEYS', 'canonicalSources', `Canonical source keys must be exactly: ${SOURCE_KEYS.join(', ')}`));
  }
  for (const key of SOURCE_KEYS) {
    const source = supplied[key];
    if (!exactKeys(source, SOURCE_FIELDS) || !SOURCE_FIELDS.every(field => meaningful(source?.[field]))) {
      issues.push(issue('DELIVERY_SOURCE_SHAPE', `canonicalSources.${key}`, 'Source snapshot must have exact meaningful resource_ref/source_identity/content_identity fields'));
      summaries[key] = null;
      continue;
    }
    summaries[key] = { resource_ref: source.resource_ref, source_identity: source.source_identity, content_identity: source.content_identity };
    if (!resolves(project, source.resource_ref)) {
      issues.push(issue('DELIVERY_SOURCE_REF', `canonicalSources.${key}.resource_ref`, `Source reference is not safe and registered: ${source.resource_ref}`));
    }
  }
  if (!exactEqual(supplied, project?.canonical_writing_sources)) {
    issues.push(issue('DELIVERY_CANONICAL_SOURCE_MISMATCH', 'canonicalSources', 'Supplied canonical sources do not exactly match PROJECT.canonical_writing_sources'));
  }
  if (summaries.manuscript_clean && summaries.manuscript_marked && summaries.manuscript_clean.content_identity !== summaries.manuscript_marked.content_identity) {
    issues.push(issue('DELIVERY_MANUSCRIPT_CONTENT_MISMATCH', 'canonicalSources', 'Clean and marked manuscript content_identity must match'));
  }
  return summaries;
}

function validateReceipt(value, artifactIdentity, path, code, issues) {
  if (!exactKeys(value, RECEIPT_FIELDS) || !meaningful(value?.receipt_id) || value?.status !== 'pass' ||
    value?.artifact_identity !== artifactIdentity || !isValidDateTime(value?.checked_at)) {
    issues.push(issue(code, path, `Receipt must be exact, passing, timestamped, and bound to artifact identity ${String(artifactIdentity)}`));
    return false;
  }
  return true;
}

function validateArtifacts(project, sources, renderedArtifacts, issues) {
  const summaries = {};
  if (!Array.isArray(renderedArtifacts)) {
    issues.push(issue('DELIVERY_INPUT_SHAPE', 'renderedArtifacts', 'renderedArtifacts must be an array'));
    return summaries;
  }
  const byKind = new Map();
  const refOwners = new Map();
  const identityOwners = new Map();
  const receiptOwners = new Map();
  for (const [index, artifact] of renderedArtifacts.entries()) {
    const path = `renderedArtifacts[${index}]`;
    if (!exactKeys(artifact, ARTIFACT_FIELDS)) {
      issues.push(issue('DELIVERY_ARTIFACT_SHAPE', path, 'Rendered artifact must have the exact delivery fields'));
      continue;
    }
    const spec = ARTIFACT_SPECS[artifact.kind];
    if (!spec) {
      issues.push(issue('DELIVERY_ARTIFACT_KIND', `${path}.kind`, `Unexpected rendered artifact kind: ${String(artifact.kind)}`));
      continue;
    }
    const matches = byKind.get(artifact.kind) ?? [];
    matches.push({ artifact, index });
    byKind.set(artifact.kind, matches);
    if (meaningful(artifact.artifact_ref)) {
      const owners = refOwners.get(artifact.artifact_ref) ?? [];
      owners.push(path); refOwners.set(artifact.artifact_ref, owners);
    }
    if (meaningful(artifact.artifact_identity)) {
      const owners = identityOwners.get(artifact.artifact_identity) ?? [];
      owners.push(path); identityOwners.set(artifact.artifact_identity, owners);
    }
    for (const [receiptField, receipt] of [['text_check', artifact.text_check], ['visual_check', artifact.visual_check]]) {
      if (exactKeys(receipt, RECEIPT_FIELDS) && meaningful(receipt.receipt_id)) {
        const owners = receiptOwners.get(receipt.receipt_id) ?? [];
        owners.push(`${path}.${receiptField}`); receiptOwners.set(receipt.receipt_id, owners);
      }
    }
  }
  for (const [ref, owners] of refOwners) if (owners.length > 1) {
    for (const path of owners) issues.push(issue('DELIVERY_ARTIFACT_DISTINCTNESS', `${path}.artifact_ref`, `artifact_ref must be globally unique: ${ref}`));
  }
  for (const [identity, owners] of identityOwners) if (owners.length > 1) {
    for (const path of owners) issues.push(issue('DELIVERY_ARTIFACT_DISTINCTNESS', `${path}.artifact_identity`, `artifact_identity must be globally unique: ${identity}`));
  }
  for (const [receiptId, owners] of receiptOwners) if (owners.length > 1) {
    for (const path of owners) issues.push(issue('DELIVERY_RECEIPT_DISTINCTNESS', path, `receipt_id must identify one independent check: ${receiptId}`));
  }
  for (const kind of Object.keys(ARTIFACT_SPECS).sort()) {
    const matches = byKind.get(kind) ?? [];
    if (matches.length !== 1) {
      issues.push(issue('DELIVERY_ARTIFACT_KIND', 'renderedArtifacts', `Expected exactly one ${kind}; found ${matches.length}`));
      continue;
    }
    const { artifact, index } = matches[0];
    const path = `renderedArtifacts[${index}]`;
    const sourceKey = ARTIFACT_SPECS[kind].sourceKey;
    if (artifact.source_key !== sourceKey || !meaningful(artifact.source_identity) || artifact.source_identity !== sources[sourceKey]?.source_identity) {
      issues.push(issue('DELIVERY_ARTIFACT_SOURCE', path, `${kind} must bind to current ${sourceKey} source identity`));
    }
    if (!meaningful(artifact.artifact_ref) || !resolves(project, artifact.artifact_ref)) {
      issues.push(issue('DELIVERY_ARTIFACT_REF', `${path}.artifact_ref`, `${kind} artifact_ref must resolve through PROJECT.resources`));
    }
    if (!meaningful(artifact.artifact_identity)) {
      issues.push(issue('DELIVERY_ARTIFACT_SHAPE', `${path}.artifact_identity`, 'artifact_identity must be a meaningful single-line string'));
    }
    validateReceipt(artifact.text_check, artifact.artifact_identity, `${path}.text_check`, 'DELIVERY_TEXT_RECEIPT', issues);
    validateReceipt(artifact.visual_check, artifact.artifact_identity, `${path}.visual_check`, 'DELIVERY_VISUAL_RECEIPT', issues);
    summaries[kind] = {
      source_key: artifact.source_key,
      source_identity: artifact.source_identity,
      artifact_ref: artifact.artifact_ref,
      artifact_identity: artifact.artifact_identity,
      text_receipt_id: exactKeys(artifact.text_check, RECEIPT_FIELDS) ? artifact.text_check.receipt_id : null,
      visual_receipt_id: exactKeys(artifact.visual_check, RECEIPT_FIELDS) ? artifact.visual_check.receipt_id : null
    };
  }
  return summaries;
}

function relevantRecordChecks(records, coverage, issues) {
  const relevant = new Set();
  for (const detail of Object.values(coverage.concerns ?? {})) {
    for (const id of [detail.id, ...detail.actionIds, ...detail.evidenceOrReason, ...detail.claimIds, ...detail.responseBlocks, ...detail.manuscriptChanges]) relevant.add(id);
  }
  for (const record of records) {
    if (!relevant.has(record.attributes.id)) continue;
    const type = record.attributes.type;
    const schema = schemaForRecordType(type);
    if (!schema || !isCanonicalRecordLocation(record)) {
      issues.push(issue('DELIVERY_RELEVANT_RECORD_INVALID', record.path, `Relevant record is not canonical: ${String(record.attributes.id)}`, [record.attributes.id]));
      continue;
    }
    for (const item of validateRecord(schema, record.attributes)) {
      issues.push(issue('DELIVERY_RELEVANT_RECORD_INVALID', record.path, `${item.path} ${item.message}`, [record.attributes.id]));
    }
    for (const item of validateStatusHistory(record.attributes, record.path)) {
      issues.push(issue('DELIVERY_RELEVANT_RECORD_INVALID', record.path, item.message, [record.attributes.id]));
    }
    if (record.attributes.status !== 'closed') {
      issues.push(issue('DELIVERY_RELEVANT_RECORD_OPEN', record.path, `Relevant ${type} record is not closed: ${record.attributes.id}`, [record.attributes.id]));
    }
    if (type === 'claim' && record.attributes.approval_status !== 'approved') {
      issues.push(issue('DELIVERY_UNAPPROVED_CLAIM', record.path, `Claim is not approved: ${record.attributes.id}`, [record.attributes.id]));
    }
  }
}

function writingChecks(catalog, issues) {
  const reviewerIssues = validateReviewerFacingCatalog(catalog);
  issues.push(...reviewerIssues);
  for (const item of reviewerIssues) {
    if (item.code.startsWith('NUMERIC_SOURCE_')) {
      issues.push(issue('DELIVERY_NUMERIC_PROVENANCE', item.path, 'Reviewer-facing writing has incomplete numeric provenance', item.relatedIds));
    }
    if (['RESPONSE_CLAIM_UNAPPROVED', 'RESPONSE_CLAIM_EVIDENCE'].includes(item.code)) {
      issues.push(issue('DELIVERY_UNAPPROVED_CLAIM', item.path, 'Reviewer-facing writing uses an unapproved or broken Claim', item.relatedIds));
    }
    if (item.code === 'RESPONSE_CLAIM_PROVENANCE') {
      issues.push(issue('DELIVERY_CLAIM_PROVENANCE', item.path, 'Reviewer-facing writing uses a Claim with broken transitive provenance', item.relatedIds));
    }
    if (item.code === 'RESPONSE_UNRESOLVED_AUTHORITY') {
      issues.push(issue('DELIVERY_UNRESOLVED_AUTHORITY', item.path, 'Reviewer-facing formal authority contains an unresolved marker', item.relatedIds));
    }
    if (['RESPONSE_UNRESOLVED_MARKER', 'MANUSCRIPT_CHANGE_UNRESOLVED_MARKER'].includes(item.code)) {
      issues.push(issue('DELIVERY_UNRESOLVED_MARKER', item.path, 'Reviewer-facing canonical writing contains an unresolved marker', item.relatedIds));
    }
    if (item.code === 'RESPONSE_TARGET_SOURCE') {
      issues.push(issue('DELIVERY_WRITING_TARGET', item.path, 'Response Block target_location is unsafe', item.relatedIds));
    }
  }
}

function emptyCoverage() {
  return deepFreeze({ comments: {}, concerns: {}, issues: [], openActions: [], unapprovedClaims: [], missingChanges: [], closable: false });
}

/**
 * Check delivery metadata and independent receipts; this function never reads or claims to inspect PDF content.
 * @param {unknown} input
 * @returns {Readonly<{ok:boolean,coverage:object,checks:object,issues:ReadonlyArray<object>,sources:object,artifacts:object}>}
 */
export function validateDelivery(input) {
  const issues = [];
  const extracted = deliveryInput(input);
  let catalog = null;
  let canonicalSources = null;
  let renderedArtifacts = null;
  if (!extracted.ok) {
    issues.push(issue('DELIVERY_INPUT_SHAPE', '<delivery>', 'Delivery input must have exact catalog/canonicalSources/renderedArtifacts fields'));
  } else {
    catalog = extracted.catalog;
    const sourceSnapshot = safeJson(extracted.canonicalSources);
    const artifactSnapshot = safeJson(extracted.renderedArtifacts);
    if (!sourceSnapshot.ok) issues.push(issue('DELIVERY_INPUT_SHAPE', 'canonicalSources', 'canonicalSources must be safe acyclic plain JSON data'));
    else canonicalSources = sourceSnapshot.value;
    if (!artifactSnapshot.ok) issues.push(issue('DELIVERY_INPUT_SHAPE', 'renderedArtifacts', 'renderedArtifacts must be safe acyclic plain JSON data'));
    else renderedArtifacts = artifactSnapshot.value;
  }
  const catalogSnapshot = recordsFrom(catalog);
  const records = catalogSnapshot.records;
  issues.push(...catalogSnapshot.issues);
  if (!catalogSnapshot.valid) issues.push(issue('DELIVERY_INPUT_SHAPE', 'catalog', 'catalog must expose only safe canonical RecordRef values'));
  const project = projectFrom(records, issues);
  let coverage = emptyCoverage();
  try { coverage = computeConcernCoverage(catalog); } catch {
    issues.push(issue('DELIVERY_COVERAGE_OPEN', 'coverage', 'Coverage could not be computed safely'));
  }
  if (!coverage.closable) issues.push(issue('DELIVERY_COVERAGE_OPEN', 'coverage', 'Concern coverage is not closable', [
    ...coverage.openActions, ...coverage.unapprovedClaims, ...coverage.missingChanges
  ]));
  for (const id of coverage.unapprovedClaims) issues.push(issue('DELIVERY_UNAPPROVED_CLAIM', 'coverage', `Coverage contains unapproved or broken Claim: ${id}`, [id]));

  const sources = validateSources(project, canonicalSources, issues);
  const artifacts = validateArtifacts(project, sources, renderedArtifacts, issues);
  relevantRecordChecks(records, coverage, issues);
  writingChecks(catalog, issues);

  const sorted = sortIssues(issues);
  const has = (...codes) => sorted.some(item => codes.includes(item.code));
  const prefix = value => sorted.some(item => item.code.startsWith(value));
  const checks = {
    coverage: coverage.closable,
    sourceRegistry: !has('DELIVERY_PROJECT_INVALID', 'DELIVERY_SOURCE_REF', 'DELIVERY_SOURCE_SHAPE', 'DELIVERY_INPUT_SHAPE'),
    sourceIdentity: !has('DELIVERY_SOURCE_KEYS', 'DELIVERY_CANONICAL_SOURCE_MISMATCH', 'DELIVERY_SOURCE_SHAPE'),
    cleanMarkedContent: !has('DELIVERY_MANUSCRIPT_CONTENT_MISMATCH'),
    renderedArtifacts: !has('DELIVERY_ARTIFACT_KIND', 'DELIVERY_ARTIFACT_SHAPE', 'DELIVERY_ARTIFACT_SOURCE', 'DELIVERY_ARTIFACT_REF', 'DELIVERY_ARTIFACT_DISTINCTNESS'),
    textReceipts: !has('DELIVERY_TEXT_RECEIPT', 'DELIVERY_RECEIPT_DISTINCTNESS'),
    visualReceipts: !has('DELIVERY_VISUAL_RECEIPT', 'DELIVERY_RECEIPT_DISTINCTNESS'),
    writingState: !has('DELIVERY_RELEVANT_RECORD_OPEN', 'DELIVERY_RELEVANT_RECORD_INVALID', 'DELIVERY_UNAPPROVED_CLAIM', 'DELIVERY_WRITING_TARGET', 'DELIVERY_CLAIM_PROVENANCE') &&
      !sorted.some(item => ['FRONTMATTER_INVALID', 'RECORD_IDENTITY_INVALID', 'REVIEWER_CANDIDATE_KIND', 'SCHEMA_INVALID', 'CANONICAL_LOCATION', 'DUPLICATE_RECORD_ID'].includes(item.code)),
    unresolvedMarkers: !has('DELIVERY_UNRESOLVED_MARKER', 'DELIVERY_UNRESOLVED_AUTHORITY'),
    numericProvenance: !has('DELIVERY_NUMERIC_PROVENANCE') && !prefix('NUMERIC_SOURCE_')
  };
  const frozenIssues = deepFreeze(sorted);
  return deepFreeze({ ok: frozenIssues.length === 0, coverage, checks, issues: frozenIssues, sources, artifacts });
}
