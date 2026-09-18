import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../../src/lib/markdown.js';
import { ReadonlyMap } from '../../src/lib/readonly.js';
import { createRecord } from '../../src/records/create.js';
import { addProjectResource } from '../../src/project/project.js';
import { validateProject, validateRecord } from '../../src/validation/validator.js';
import { computeConcernCoverage, validateManuscriptChangeRecord, validateResponseBlock } from '../../src/writing/response.js';
import { makeProjectFixture, writeRecordFixture } from '../helpers/fixtures.js';
import { action, base, change, claim, concern, decision, evidence, lifecycle, project, provenanceCatalog, ref, researchQuestion, response, responseCatalog, run } from '../helpers/response-fixtures.js';

test('Driver and Writing schemas encode concern, response, manuscript-change, and canonical-source contracts', () => {
  assert.equal(validateRecord('driver', concern()).length, 0);
  assert.equal(validateRecord('writing', response()).length, 0);
  assert.equal(validateRecord('writing', change()).length, 0);
  assert.equal(validateRecord('project', project()).length, 0);

  const missingComment = concern({ source_ref: null });
  assert.equal(validateRecord('driver', missingComment).some(item => item.path === '/source_ref'), true);
  const wrongTargets = change({ target_source_keys: ['manuscript_clean'], source_identities: { manuscript_clean: 'clean-src-v1' } });
  assert.equal(validateRecord('writing', wrongTargets).length > 0, true);
  const earlyProject = project({ canonical_writing_sources: {} });
  assert.equal(validateRecord('project', earlyProject).length, 0);
  const incompleteSource = project({ canonical_writing_sources: { response: { resource_ref: 'writing:response.tex', source_identity: 'v1' } } });
  assert.equal(validateRecord('project', incompleteSource).some(item => item.path.includes('content_identity')), true);
});

test('record aliases machine-set kinds and stable canonical paths without allowing callers to forge kind', async () => {
  const root = await makeProjectFixture();
  await addProjectResource(root, 'review', { uri: '/vault/review', role: 'decision-letter', access: 'read-only', identity: 'review-v1' });
  const created = [
    await createRecord(root, 'concern', { id: 'CON-101', title: 'Reviewer concern', source: 'review', source_comment_id: 'R1-C1', source_ref: 'review:letter.txt', question: 'Clarify endpoint.' }),
    await createRecord(root, 'response', { id: 'WRT-101', title: 'Response block', concern: 'CON-101', direct_answer: 'We clarified the endpoint.', evidence_or_reason: [], limitations: 'none_identified', manuscript_changes: [], covered_actions: [], numeric_sources: [] }),
    await createRecord(root, 'manuscript-change', { id: 'WRT-102', title: 'Manuscript change', target_source_keys: ['manuscript_clean', 'manuscript_marked'], source_identities: { manuscript_clean: 'clean-v1', manuscript_marked: 'marked-v1' }, location_anchor: 'sec:intro', change_summary: 'Clarified endpoint.', response_blocks: ['WRT-101'], numeric_sources: [] }),
    await createRecord(root, 'strategy', { id: 'WRT-103', title: 'Internal strategy' })
  ];
  assert.deepEqual(created.map(item => item.path), [
    'reviews/concerns/CON-101.md', 'writing/response/WRT-101.md', 'writing/changes/WRT-102.md', 'writing/strategy/WRT-103.md'
  ]);
  const kinds = [];
  for (const item of created) {
    const document = parseMarkdownDocument(await readFile(join(root, item.path), 'utf8'), item.path);
    kinds.push(document.attributes.driver_kind ?? document.attributes.writing_kind);
  }
  assert.deepEqual(kinds, ['concern', 'response_block', 'manuscript_change', 'internal_strategy']);
  await assert.rejects(
    createRecord(root, 'response', { id: 'WRT-104', title: 'Forged', writing_kind: 'internal_strategy' }),
    error => error.code === 'USAGE'
  );
  await assert.rejects(
    createRecord(root, 'concern', { id: 'CON-105', title: 'Unsafe source', source: 'review', source_comment_id: 'R1-C2', source_ref: '/absolute/letter.txt', question: 'Question?' }),
    error => error.code === 'VALIDATION'
  );
});

test('project validation reports unregistered Concern and canonical writing source references', async () => {
  const root = await makeProjectFixture();
  await writeRecordFixture(root, 'reviews/concerns/CON-201.md', concern({ id: 'CON-201', actions: [], source_ref: 'missing:letter.txt' }));
  const projectPath = join(root, 'PROJECT.md');
  const document = parseMarkdownDocument(await readFile(projectPath, 'utf8'), projectPath);
  await writeFile(projectPath, serializeMarkdownDocument({
    ...document.attributes,
    canonical_writing_sources: {
      response: { resource_ref: '/absolute/response.tex', source_identity: 'v1', content_identity: 'v1' }
    }
  }, document.body), 'utf8');
  const report = await validateProject(root);
  assert.equal(report.issues.some(item => item.code === 'REGISTERED_REFERENCE_INVALID' && item.path === 'reviews/concerns/CON-201.md'), true);
  assert.equal(report.issues.some(item => item.code === 'REGISTERED_REFERENCE_INVALID' && item.path === 'PROJECT.md'), true);
});

test('a valid response block is frozen, deterministic, and does not mutate catalog input', () => {
  const catalog = responseCatalog();
  const before = JSON.stringify([...catalog].map(([path, item]) => [path, item.attributes]));
  const first = validateResponseBlock(catalog.get('writing/response/WRT-001.md'), catalog);
  const second = validateResponseBlock(catalog.get('writing/response/WRT-001.md'), catalog);
  assert.deepEqual(first, []);
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(JSON.stringify([...catalog].map(([path, item]) => [path, item.attributes])), before);
});

test('response block rejects missing direct answer, placeholder text, missing/extra actions, and internal strategy confusion', () => {
  const cases = [
    [response({ direct_answer: '  ' }), 'RESPONSE_FIELD_REQUIRED'],
    [response({ direct_answer: 'TBD after checking.' }), 'RESPONSE_UNRESOLVED_MARKER'],
    [response({ covered_actions: ['ACT-001'] }), 'RESPONSE_ACTION_COVERAGE'],
    [response({ covered_actions: ['ACT-001', 'ACT-002', 'ACT-999'] }), 'RESPONSE_ACTION_INVALID'],
    [response({ writing_kind: 'internal_strategy' }), 'RESPONSE_RECORD_KIND']
  ];
  for (const [attributes, code] of cases) {
    const record = ref('writing/response/WRT-001.md', attributes);
    const catalog = responseCatalog({ 'writing/response/WRT-001.md': attributes });
    assert.equal(validateResponseBlock(record, catalog).some(item => item.code === code), true, code);
  }
});

test('response block rejects malformed catalogs, wrong link types, noncanonical and archived records without throwing', () => {
  for (const catalog of [null, 42, new Map([['bad', null]]), new Map([['bad', { attributes: null }]])]) {
    assert.doesNotThrow(() => validateResponseBlock(null, catalog));
    assert.equal(validateResponseBlock(null, catalog).length > 0, true);
  }
  const wrongConcern = responseCatalog({ 'reviews/concerns/CON-001.md': { ...concern(), driver_kind: 'research_question' } });
  assert.equal(validateResponseBlock(wrongConcern.get('writing/response/WRT-001.md'), wrongConcern).some(item => item.code === 'RESPONSE_CONCERN_INVALID'), true);
  const archivedEvidence = responseCatalog({ 'evidence/packets/EVD-001.md': evidence({ status: 'reopened', ...lifecycle('reopened') }) });
  assert.equal(validateResponseBlock(archivedEvidence.get('writing/response/WRT-001.md'), archivedEvidence).some(item => item.code === 'RESPONSE_EVIDENCE_STATUS'), true);
  const noncanonical = responseCatalog({ 'writing/response/WRT-001.md': null, 'archive/WRT-001.md': response() });
  assert.equal(validateResponseBlock(noncanonical.get('archive/WRT-001.md'), noncanonical).some(item => item.code === 'RESPONSE_RECORD_LOCATION'), true);
});

test('response block validates approved Claim to closed Evidence and numeric declarations exactly', () => {
  const brokenClaim = responseCatalog({ 'evidence/claims/CLM-001.md': claim({ evidence: ['EVD-999'] }) });
  assert.equal(validateResponseBlock(brokenClaim.get('writing/response/WRT-001.md'), brokenClaim).some(item => item.code === 'RESPONSE_CLAIM_EVIDENCE'), true);
  const draftClaim = responseCatalog({ 'evidence/claims/CLM-001.md': claim({ approval_status: 'draft' }) });
  assert.equal(validateResponseBlock(draftClaim.get('writing/response/WRT-001.md'), draftClaim).some(item => item.code === 'RESPONSE_CLAIM_UNAPPROVED'), true);

  const numericCases = [
    [response({ numeric_sources: [] }), 'NUMERIC_SOURCE_UNDECLARED'],
    [response({ numeric_sources: [{ literal: '88.0%', evidence: 'EVD-001', locator: 'results:metrics.json' }] }), 'NUMERIC_SOURCE_STALE'],
    [response({ numeric_sources: [{ literal: '91.2%', evidence: 'DEC-001', locator: 'results:metrics.json' }] }), 'NUMERIC_SOURCE_EVIDENCE'],
    [response({ numeric_sources: [{ literal: '91.2%', evidence: 'EVD-001', locator: '/absolute/metrics.json' }] }), 'NUMERIC_SOURCE_LOCATOR'],
    [response({ numeric_sources: [
      { literal: '91.2%', evidence: 'EVD-001', locator: 'results:metrics.json' },
      { literal: '91.2%', evidence: 'EVD-001', locator: 'results:metrics.json' }
    ] }), 'NUMERIC_SOURCE_DUPLICATE']
  ];
  for (const [attributes, code] of numericCases) {
    const catalog = responseCatalog({ 'writing/response/WRT-001.md': attributes });
    assert.equal(validateResponseBlock(catalog.get('writing/response/WRT-001.md'), catalog).some(item => item.code === code), true, code);
  }
});

test('coverage closes a complete graph and groups split Concerns by reviewer source comment', () => {
  const split = concern({ id: 'CON-002', actions: [], question: 'Also clarify the evaluation split.' });
  const strategy = base('writing', 'WRT-099', 'closed', {
    writing_kind: 'internal_strategy', purpose: 'Private options.', claims: [], target_location: 'internal', draft: 'Do not submit.',
    synchronization_status: 'synchronized', verification_result: 'passed'
  });
  const catalog = responseCatalog({ 'reviews/concerns/CON-002.md': split, 'writing/strategy/WRT-099.md': strategy });
  const report = computeConcernCoverage(catalog);
  assert.deepEqual(report.comments['R1-C1'].concernIds, ['CON-001', 'CON-002']);
  assert.equal(report.concerns['CON-001'].closable, true);
  assert.equal(report.concerns['CON-002'].closable, false);
  assert.equal(report.concerns['CON-002'].responseBlocks.includes('WRT-099'), false);
  assert.equal(report.closable, false);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.concerns['CON-001'].issues), true);
});

test('coverage blocks split Concerns whose shared comment id points at conflicting review sources', () => {
  const split = concern({ id: 'CON-002', actions: [], source_ref: 'review:another-letter.txt' });
  const catalog = responseCatalog({ 'reviews/concerns/CON-002.md': split });
  const report = computeConcernCoverage(catalog);
  assert.equal(report.closable, false);
  assert.equal(report.concerns['CON-001'].issues.some(item => item.code === 'COVERAGE_COMMENT_SOURCE_CONFLICT'), true);
  assert.equal(report.concerns['CON-002'].issues.some(item => item.code === 'COVERAGE_COMMENT_SOURCE_CONFLICT'), true);
});

test('coverage reports open Action, broken Claim Evidence, missing Change, and a falsely closed Concern', () => {
  const openAction = action('ACT-002', { status: 'in_progress', ...lifecycle('in_progress'), inputs: ['EVD-001'], outputs: ['WRT-002'] });
  const closedConcern = concern({ status: 'closed', ...lifecycle('closed') });
  const catalog = responseCatalog({
    'reviews/concerns/CON-001.md': closedConcern,
    'plans/actions/ACT-002.md': openAction,
    'evidence/claims/CLM-001.md': claim({ evidence: ['EVD-999'] }),
    'writing/changes/WRT-002.md': null
  });
  const report = computeConcernCoverage(catalog);
  assert.deepEqual(report.concerns['CON-001'].openActions, ['ACT-002']);
  assert.deepEqual(report.concerns['CON-001'].unapprovedClaims, ['CLM-001']);
  assert.deepEqual(report.concerns['CON-001'].missingChanges, ['WRT-002']);
  assert.equal(report.concerns['CON-001'].issues.some(item => item.code === 'CLOSED_CONCERN_NOT_CLOSABLE'), true);
  assert.equal(report.closable, false);
});

test('coverage does not treat an open or unverified Response Block as closure-ready', () => {
  const openResponse = response({
    status: 'in_progress', ...lifecycle('in_progress'),
    synchronization_status: 'pending', verification_result: 'pending'
  });
  const catalog = responseCatalog({ 'writing/response/WRT-001.md': openResponse });
  const report = computeConcernCoverage(catalog);
  assert.equal(report.closable, false);
  assert.equal(report.concerns['CON-001'].issues.some(item => item.code === 'COVERAGE_RESPONSE_STATUS'), true);
});

test('coverage blocks malformed Action links, wrong source identity, unsynchronized Change, and duplicate canonical IDs', () => {
  const malformedAction = action('ACT-002', { outputs: ['EVD-999'] });
  const badChange = change({
    synchronization_status: 'pending', verification_result: 'failed',
    source_identities: { manuscript_clean: 'wrong-clean', manuscript_marked: 'marked-src-v1' }
  });
  const duplicateClaim = claim({ id: 'CLM-001' });
  const catalog = responseCatalog({
    'plans/actions/ACT-002.md': malformedAction,
    'writing/changes/WRT-002.md': badChange,
    'archive/CLM-001.md': duplicateClaim
  });
  const report = computeConcernCoverage(catalog);
  const codes = report.concerns['CON-001'].issues.map(item => item.code);
  assert.equal(codes.includes('COVERAGE_ACTION_LINK'), true);
  assert.equal(codes.includes('MANUSCRIPT_CHANGE_SOURCE_IDENTITY'), true);
  assert.equal(codes.includes('MANUSCRIPT_CHANGE_NOT_SYNCHRONIZED'), true);
  assert.equal(codes.includes('COVERAGE_DUPLICATE_ID'), true);
  assert.equal(report.closable, false);
});

test('coverage and block validation are total over primitive and malformed catalog values', () => {
  for (const catalog of [null, undefined, 0, 'catalog', {}, new Map([['x', 7]])]) {
    assert.doesNotThrow(() => computeConcernCoverage(catalog));
    const report = computeConcernCoverage(catalog);
    assert.deepEqual(Object.keys(report).sort(), ['closable', 'comments', 'concerns', 'issues', 'missingChanges', 'openActions', 'unapprovedClaims']);
    assert.equal(report.closable, false);
  }
  const mixed = responseCatalog({ malformed: 7 });
  assert.equal(computeConcernCoverage(mixed).closable, false);
  assert.equal(computeConcernCoverage(mixed).concerns['CON-001'].issues.some(item => item.code === 'COVERAGE_CATALOG_INVALID'), true);
});

test('response validators reject accessor-bearing RecordRefs without executing getters and remain deterministic', () => {
  let getterCalls = 0;
  const poison = {
    id: 'WRT-099', type: 'writing', attributes: response({ id: 'WRT-099' })
  };
  Object.defineProperty(poison, 'path', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('secret path getter'); }
  });
  const catalog = responseCatalog({ poison: null });
  catalog.set('poison', poison);
  let first;
  let second;
  assert.doesNotThrow(() => { first = validateResponseBlock(poison, catalog); });
  assert.doesNotThrow(() => { second = validateResponseBlock(poison, catalog); });
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(first.some(item => item.message.includes('secret path getter')), false);
  assert.doesNotThrow(() => computeConcernCoverage(catalog));
  assert.deepEqual(computeConcernCoverage(catalog), computeConcernCoverage(catalog));
  assert.equal(Object.isFrozen(computeConcernCoverage(catalog)), true);
  assert.equal(getterCalls, 0);
});

test('approved Claim provenance traces Result to canonical Run, Experiment, and Manifest using frontmatter only', () => {
  const valid = provenanceCatalog();
  assert.deepEqual(validateResponseBlock(valid.get('writing/response/WRT-001.md'), valid), []);
  assert.equal(computeConcernCoverage(valid).closable, true);

  const cases = [
    provenanceCatalog({ 'experiments/runs/RUN-001.md': null }),
    provenanceCatalog({
      'experiments/runs/RUN-001.md': null,
      'evidence/packets/RUN-001.md': evidence({ id: 'RUN-001', sources: ['CON-001', 'results:metrics.json'] })
    }),
    provenanceCatalog({ 'experiments/runs/RUN-001.md': null, 'archive/RUN-001.md': run() }),
    provenanceCatalog({
      'experiments/runs/RUN-001-copy.md': run(),
      'experiments/runs/RUN-001.md': run()
    }),
    provenanceCatalog({ 'experiments/runs/RUN-001.md': null })
  ];
  for (const catalog of cases) {
    const issues = validateResponseBlock(catalog.get('writing/response/WRT-001.md'), catalog);
    assert.equal(issues.some(item => item.code === 'RESPONSE_CLAIM_PROVENANCE'), true);
    assert.equal(computeConcernCoverage(catalog).closable, false);
  }
});

test('closed Concern Actions must produce canonical artifacts that reach that Concern closure graph', () => {
  for (const outputs of [[], ['EVD-999']]) {
    const catalog = responseCatalog({ 'plans/actions/ACT-001.md': action('ACT-001', { outputs }) });
    const report = computeConcernCoverage(catalog);
    assert.equal(report.closable, false);
    assert.equal(report.concerns['CON-001'].issues.some(item => item.code === 'COVERAGE_ACTION_OUTPUT'), true);
  }

  const detached = responseCatalog({
    'plans/actions/ACT-001.md': action('ACT-001', { outputs: ['EVD-002'] }),
    'evidence/packets/EVD-002.md': evidence({ id: 'EVD-002', sources: ['CON-001', 'results:metrics.json'], supported_claims: [], writing_destinations: [] })
  });
  assert.equal(computeConcernCoverage(detached).concerns['CON-001'].issues.some(item => item.code === 'COVERAGE_ACTION_OUTPUT'), true);

  const otherConcern = responseCatalog({
    'plans/actions/ACT-001.md': action('ACT-001', { outputs: ['EVD-002'] }),
    'reviews/concerns/CON-002.md': concern({ id: 'CON-002', source_comment_id: 'R1-C2', actions: [] }),
    'evidence/packets/EVD-002.md': evidence({ id: 'EVD-002', sources: ['CON-002', 'results:metrics.json'], supported_claims: [], writing_destinations: [] })
  });
  assert.equal(computeConcernCoverage(otherConcern).concerns['CON-001'].issues.some(item => item.code === 'COVERAGE_ACTION_OUTPUT'), true);

  const direct = responseCatalog();
  assert.equal(computeConcernCoverage(direct).concerns['CON-001'].issues.some(item => item.code === 'COVERAGE_ACTION_OUTPUT'), false);
  const viaResult = provenanceCatalog({
    'plans/actions/ACT-001.md': action('ACT-001', { outputs: ['RES-001'] }),
    'plans/actions/ACT-002.md': action('ACT-002', { outputs: ['RES-001'] })
  });
  assert.equal(computeConcernCoverage(viaResult).closable, true);
  const viaDecision = responseCatalog({
    'decisions/DEC-001.md': decision(),
    'plans/actions/ACT-001.md': action('ACT-001', { outputs: ['DEC-001'] }),
    'plans/actions/ACT-002.md': action('ACT-002', { outputs: ['DEC-001'] }),
    'writing/response/WRT-001.md': response({ evidence_or_reason: ['DEC-001'] })
  });
  assert.equal(computeConcernCoverage(viaDecision).closable, true);
});

test('reviewer-facing Claim, Evidence, and Decision formal fields block unresolved markers', () => {
  const claimCases = [
    claim({ statement: 'The mechanism is UNKNOWN.' }),
    claim({ confidence_and_limitations: 'TBD: after analysis' }),
    claim({ conditions: ['Applies to ?? cohort.'] }),
    claim({ prohibited_expansion: ['{{replace this}}'] })
  ];
  for (const attributes of claimCases) {
    const catalog = responseCatalog({ 'evidence/claims/CLM-001.md': attributes });
    const issues = validateResponseBlock(catalog.get('writing/response/WRT-001.md'), catalog);
    assert.equal(issues.some(item => item.code === 'RESPONSE_UNRESOLVED_AUTHORITY' && item.path === 'evidence/claims/CLM-001.md'), true);
    assert.equal(computeConcernCoverage(catalog).closable, false);
  }
  const markedEvidence = responseCatalog({ 'evidence/packets/EVD-001.md': evidence({ interpretation: 'FIXME interpretation.' }) });
  assert.equal(validateResponseBlock(markedEvidence.get('writing/response/WRT-001.md'), markedEvidence)
    .some(item => item.code === 'RESPONSE_UNRESOLVED_AUTHORITY' && item.path === 'evidence/packets/EVD-001.md'), true);
  const markedDecision = responseCatalog({
    'decisions/DEC-001.md': decision({ rationale: 'PENDING: final justification.' }),
    'writing/response/WRT-001.md': response({ evidence_or_reason: ['DEC-001'] })
  });
  assert.equal(validateResponseBlock(markedDecision.get('writing/response/WRT-001.md'), markedDecision)
    .some(item => item.code === 'RESPONSE_UNRESOLVED_AUTHORITY' && item.path === 'decisions/DEC-001.md'), true);
  assert.equal(computeConcernCoverage(markedDecision).closable, false);
});

test('Concern coverage blocks clean and marked manuscript content identity mismatch', () => {
  const changedProject = project();
  changedProject.canonical_writing_sources.manuscript_marked.content_identity = 'different-content';
  const catalog = responseCatalog({ 'PROJECT.md': changedProject });
  const report = computeConcernCoverage(catalog);
  assert.equal(report.closable, false);
  assert.equal(report.concerns['CON-001'].issues.some(item => item.code === 'MANUSCRIPT_CHANGE_CONTENT_MISMATCH'), true);
});

test('Response limitations mechanically scan decimal, percent, and scientific numeric literals', () => {
  for (const literal of ['2.5', '7%', '1e-3']) {
    const attributes = response({ limitations: `The limitation applies to ${literal} cohorts.` });
    const catalog = responseCatalog({ 'writing/response/WRT-001.md': attributes });
    const issues = validateResponseBlock(catalog.get('writing/response/WRT-001.md'), catalog);
    assert.equal(issues.some(item => item.code === 'NUMERIC_SOURCE_UNDECLARED' && item.message.includes(literal)), true, literal);
  }
});

test('Response target_location requires the response key and a safe meaningful anchor', () => {
  for (const anchor of ['response:R1-C1', 'response:sec:foo']) {
    const catalog = responseCatalog({ 'writing/response/WRT-001.md': response({ target_location: anchor }) });
    assert.equal(validateResponseBlock(catalog.get('writing/response/WRT-001.md'), catalog).some(item => item.code === 'RESPONSE_TARGET_SOURCE'), false, anchor);
  }
  for (const anchor of [
    'response:', 'response:.', 'response:..', 'response:foo/../bar', 'response:%2e%2e/secret',
    'response:%252e%252e/secret', 'response:/absolute', 'response:foo\\bar', 'response:foo\nbar', 'manuscript:R1-C1'
  ]) {
    const catalog = responseCatalog({ 'writing/response/WRT-001.md': response({ target_location: anchor }) });
    assert.equal(validateResponseBlock(catalog.get('writing/response/WRT-001.md'), catalog).some(item => item.code === 'RESPONSE_TARGET_SOURCE'), true, anchor);
  }
});

test('ordinary Maps enforce reviewer-root type and kind while canonical internal strategy remains excluded', () => {
  const wrongConcern = responseCatalog({
    'reviews/concerns/CON-099.md': concern({ id: 'CON-099', driver_kind: 'research_question', actions: [] })
  });
  assert.equal(computeConcernCoverage(wrongConcern).issues.some(item => item.path === 'reviews/concerns/CON-099.md'), true);
  const misplacedStrategy = responseCatalog({
    'writing/response/WRT-099.md': base('writing', 'WRT-099', 'closed', {
      writing_kind: 'internal_strategy', purpose: 'Private.', claims: [], target_location: 'internal', draft: 'Done.',
      synchronization_status: 'synchronized', verification_result: 'passed'
    })
  });
  assert.equal(computeConcernCoverage(misplacedStrategy).issues.some(item => item.path === 'writing/response/WRT-099.md'), true);
  const canonicalStrategy = responseCatalog({
    'writing/strategy/WRT-099.md': base('writing', 'WRT-099', 'closed', {
      writing_kind: 'internal_strategy', purpose: 'Private.', claims: [], target_location: 'internal', draft: 'TODO private.',
      synchronization_status: 'synchronized', verification_result: 'passed'
    })
  });
  assert.equal(computeConcernCoverage(canonicalStrategy).closable, true);
});

test('Action-to-Action reachability stays within the authoritative same-Concern action set', () => {
  const sameConcern = responseCatalog({
    'reviews/concerns/CON-001.md': concern({ actions: ['ACT-001', 'ACT-002', 'ACT-099'] }),
    'plans/actions/ACT-001.md': action('ACT-001', { outputs: ['ACT-099'] }),
    'plans/actions/ACT-099.md': action('ACT-099', { outputs: ['EVD-001'] }),
    'writing/response/WRT-001.md': response({ covered_actions: ['ACT-001', 'ACT-002', 'ACT-099'] })
  });
  assert.equal(computeConcernCoverage(sameConcern).closable, true);

  const crossConcern = responseCatalog({
    'plans/actions/ACT-001.md': action('ACT-001', { outputs: ['ACT-099'] }),
    'plans/actions/ACT-099.md': action('ACT-099', { driver: 'CON-099', outputs: ['EVD-001'] }),
    'reviews/concerns/CON-099.md': concern({ id: 'CON-099', source_comment_id: 'R9-C9', actions: ['ACT-099'] })
  });
  assert.equal(computeConcernCoverage(crossConcern).concerns['CON-001'].issues.some(item => item.code === 'COVERAGE_ACTION_OUTPUT'), true);

  const unlisted = responseCatalog({
    'plans/actions/ACT-001.md': action('ACT-001', { outputs: ['ACT-099'] }),
    'plans/actions/ACT-099.md': action('ACT-099', { outputs: ['EVD-001'] })
  });
  assert.equal(computeConcernCoverage(unlisted).concerns['CON-001'].issues.some(item => item.code === 'COVERAGE_ACTION_OUTPUT'), true);

  const mixed = responseCatalog({
    'plans/actions/ACT-001.md': action('ACT-001', { outputs: ['EVD-001', 'ACT-099'] }),
    'plans/actions/ACT-099.md': action('ACT-099', { driver: 'CON-099', outputs: ['EVD-001'] })
  });
  assert.equal(computeConcernCoverage(mixed).concerns['CON-001'].issues.some(item => item.code === 'COVERAGE_ACTION_OUTPUT'), true);

  const cycle = responseCatalog({
    'reviews/concerns/CON-001.md': concern({ actions: ['ACT-001', 'ACT-002', 'ACT-099'] }),
    'plans/actions/ACT-001.md': action('ACT-001', { outputs: ['ACT-099'] }),
    'plans/actions/ACT-099.md': action('ACT-099', { outputs: ['ACT-001'] }),
    'writing/response/WRT-001.md': response({ covered_actions: ['ACT-001', 'ACT-002', 'ACT-099'] })
  });
  const first = computeConcernCoverage(cycle);
  assert.equal(first.closable, false);
  assert.deepEqual(first, computeConcernCoverage(cycle));
});

test('formal-authority marker scanning reaches every nested plain-data string leaf', () => {
  const cases = [
    responseCatalog({ 'evidence/claims/CLM-001.md': claim({ conditions: [{ scope: { values: ['UNKNOWN'] } }] }) }),
    responseCatalog({ 'evidence/packets/EVD-001.md': evidence({ limitations: [{ caveat: { values: ['TBD'] } }] }) }),
    responseCatalog({
      'decisions/DEC-001.md': decision({ options: [{ option: { values: ['{{choose}}'] } }] }),
      'writing/response/WRT-001.md': response({ evidence_or_reason: ['DEC-001'] })
    })
  ];
  for (const catalog of cases) {
    const issues = validateResponseBlock(catalog.get('writing/response/WRT-001.md'), catalog);
    assert.equal(issues.some(item => item.code === 'RESPONSE_UNRESOLVED_AUTHORITY'), true);
    assert.equal(computeConcernCoverage(catalog).closable, false);
  }
});

test('coverage is a pre-close gate for review or verified Concern but reopened remains blocked', () => {
  for (const status of ['review', 'verified']) {
    const catalog = responseCatalog({ 'reviews/concerns/CON-001.md': concern({ ...lifecycle(status) }) });
    assert.equal(computeConcernCoverage(catalog).closable, true, status);
  }
  const closed = concern();
  const reopened = {
    ...closed, status: 'reopened', updated: '2026-08-03T00:00:08.000Z', affected_ids: ['CON-001'],
    status_history: [...closed.status_history, { from: 'closed', to: 'reopened', at: '2026-08-03T00:00:08.000Z', reason: 'New reviewer requirement.' }]
  };
  assert.equal(computeConcernCoverage(responseCatalog({ 'reviews/concerns/CON-001.md': reopened })).closable, false);
});

test('only the exact current Response Concern receives the pre-close Driver exception', () => {
  for (const status of ['inbox', 'defined', 'ready', 'in_progress', 'review', 'verified']) {
    const catalog = responseCatalog({
      'research/questions/RQ-099.md': researchQuestion({ ...lifecycle(status) }),
      'evidence/packets/EVD-001.md': evidence({ sources: ['CON-001', 'RQ-099', 'results:metrics.json'] })
    });
    const issues = validateResponseBlock(catalog.get('writing/response/WRT-001.md'), catalog);
    assert.equal(issues.some(item => item.code === 'RESPONSE_CLAIM_PROVENANCE' && item.relatedIds.includes('RQ-099')), true, status);
    assert.equal(computeConcernCoverage(catalog).closable, false, status);
  }

  const otherConcern = responseCatalog({
    'reviews/concerns/CON-099.md': concern({ id: 'CON-099', source_comment_id: 'R9-C9', actions: [], ...lifecycle('review') }),
    'evidence/packets/EVD-001.md': evidence({ sources: ['CON-001', 'CON-099', 'results:metrics.json'] })
  });
  assert.equal(computeConcernCoverage(otherConcern).concerns['CON-001'].issues
    .some(item => item.code === 'RESPONSE_CLAIM_PROVENANCE' && item.relatedIds.includes('CON-099')), true);

  const closed = responseCatalog({
    'research/questions/RQ-099.md': researchQuestion(),
    'evidence/packets/EVD-001.md': evidence({ sources: ['CON-001', 'RQ-099', 'results:metrics.json'] })
  });
  assert.equal(computeConcernCoverage(closed).closable, true);
});

test('Manuscript Change derives open-Driver authority only from exact canonical Response links', () => {
  const currentReview = responseCatalog({ 'reviews/concerns/CON-001.md': concern({ ...lifecycle('review') }) });
  assert.equal(validateManuscriptChangeRecord(currentReview.get('writing/changes/WRT-002.md'), currentReview)
    .some(item => item.code === 'RESPONSE_CLAIM_PROVENANCE'), false);

  const invalidLink = responseCatalog({
    'reviews/concerns/CON-099.md': concern({ id: 'CON-099', source_comment_id: 'R9-C9', actions: [], ...lifecycle('review') }),
    'evidence/packets/EVD-001.md': evidence({ sources: ['CON-099', 'results:metrics.json'] }),
    'writing/changes/WRT-002.md': change({ response_blocks: ['WRT-404'] })
  });
  const invalidIssues = validateManuscriptChangeRecord(invalidLink.get('writing/changes/WRT-002.md'), invalidLink);
  assert.equal(invalidIssues.some(item => item.code === 'MANUSCRIPT_CHANGE_RESPONSE_LINK'), true);
  assert.equal(invalidIssues.some(item => item.code === 'RESPONSE_CLAIM_PROVENANCE' && item.relatedIds.includes('CON-099')), true);

  const linked = responseCatalog({
    'reviews/concerns/CON-099.md': concern({ id: 'CON-099', source_comment_id: 'R9-C9', actions: [], ...lifecycle('review') }),
    'evidence/packets/EVD-001.md': evidence({ sources: ['CON-099', 'results:metrics.json'] }),
    'writing/response/WRT-001.md': response({ claims: [] }),
    'writing/response/WRT-099.md': response({ id: 'WRT-099', concern: 'CON-099', target_location: 'response:R9-C9', covered_actions: [], manuscript_changes: ['WRT-002'] }),
    'writing/changes/WRT-002.md': change({ response_blocks: ['WRT-001', 'WRT-099'] })
  });
  assert.equal(validateManuscriptChangeRecord(linked.get('writing/changes/WRT-002.md'), linked)
    .some(item => item.code === 'RESPONSE_CLAIM_PROVENANCE'), false);
  assert.equal(validateResponseBlock(linked.get('writing/response/WRT-001.md'), linked)
    .some(item => item.code === 'RESPONSE_CLAIM_PROVENANCE' && item.relatedIds.includes('CON-099')), true);
});

test('path-keyed catalog Maps require a primitive string key exactly equal to RecordRef.path', () => {
  const mismatches = [];
  const reviewerKey = responseCatalog();
  reviewerKey.set('reviews/concerns/RQ-099.md', ref('research/questions/RQ-099.md', researchQuestion()));
  mismatches.push(reviewerKey);
  const reviewerValue = responseCatalog();
  reviewerValue.set('research/questions/CON-099.md', ref('reviews/concerns/CON-099.md', concern({ id: 'CON-099', source_comment_id: 'R9-C9', actions: [] })));
  mismatches.push(reviewerValue);
  const numberKey = responseCatalog();
  numberKey.set(7, ref('research/questions/RQ-099.md', researchQuestion()));
  mismatches.push(numberKey);
  const symbolKey = responseCatalog();
  symbolKey.set(Symbol('hidden'), ref('research/questions/RQ-099.md', researchQuestion()));
  mismatches.push(symbolKey);

  for (const catalog of mismatches) {
    const before = catalog.size;
    const first = computeConcernCoverage(catalog);
    assert.equal(first.closable, false);
    assert.equal(first.issues.some(item => item.code === 'CATALOG_KEY_PATH_INVALID'), true);
    assert.deepEqual(first, computeConcernCoverage(catalog));
    assert.equal(Object.isFrozen(first.issues), true);
    assert.equal(catalog.size, before);
  }
  assert.equal(computeConcernCoverage(responseCatalog()).closable, true);
  assert.equal(computeConcernCoverage(new ReadonlyMap(responseCatalog())).closable, true);
  class OverrideMap extends Map {
    entries() { throw new Error('must not call override'); }
    values() { throw new Error('must not call override'); }
  }
  assert.equal(computeConcernCoverage(new OverrideMap(responseCatalog())).closable, true);
});

test('only explicit uppercase marker syntax blocks; scientific lowercase prose and safe anchors remain valid', () => {
  for (const token of ['TODO', 'TBD', 'FIXME', 'UNKNOWN', 'PENDING', 'PLACEHOLDER', '??', '{{choose}}']) {
    const catalog = responseCatalog({ 'evidence/claims/CLM-001.md': claim({ statement: `Result is ${token}.` }) });
    assert.equal(validateResponseBlock(catalog.get('writing/response/WRT-001.md'), catalog).some(item => item.code === 'RESPONSE_UNRESOLVED_AUTHORITY'), true, token);
  }
  for (const statement of ['The classifier separates known and unknown classes.', 'We evaluate unknown-class detection.']) {
    const catalog = responseCatalog({ 'evidence/claims/CLM-001.md': claim({ statement }) });
    assert.equal(validateResponseBlock(catalog.get('writing/response/WRT-001.md'), catalog).some(item => item.code === 'RESPONSE_UNRESOLVED_AUTHORITY'), false, statement);
  }
  const anchored = responseCatalog({ 'writing/response/WRT-001.md': response({ target_location: 'response:UNKNOWN-001' }) });
  assert.equal(validateResponseBlock(anchored.get('writing/response/WRT-001.md'), anchored).some(item => item.code.includes('UNRESOLVED')), false);
});
