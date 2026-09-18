import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../../src/cli.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../../src/lib/markdown.js';
import { validateDelivery } from '../../src/writing/delivery.js';
import { captureIo, makeProjectFixture, writeRecordFixture } from '../helpers/fixtures.js';
import { change, concern, decision, evidence, lifecycle, provenanceCatalog, ref, researchQuestion, response, responseCatalog, run } from '../helpers/response-fixtures.js';

const receipt = (artifactIdentity, overrides = {}, receiptKind = 'check') => ({
  receipt_id: `RCP-${artifactIdentity}-${receiptKind}`,
  status: 'pass',
  artifact_identity: artifactIdentity,
  checked_at: '2026-08-04T00:00:00.000Z',
  ...overrides
});

export function renderedArtifacts(overrides = {}) {
  const items = [
    { kind: 'response_pdf', source_key: 'response', source_identity: 'response-src-v1', artifact_ref: 'artifacts:response.pdf', artifact_identity: 'response-pdf-v1' },
    { kind: 'manuscript_clean_pdf', source_key: 'manuscript_clean', source_identity: 'clean-src-v1', artifact_ref: 'artifacts:manuscript-clean.pdf', artifact_identity: 'clean-pdf-v1' },
    { kind: 'manuscript_marked_pdf', source_key: 'manuscript_marked', source_identity: 'marked-src-v1', artifact_ref: 'artifacts:manuscript-marked.pdf', artifact_identity: 'marked-pdf-v1' }
  ].map(item => ({ ...item, text_check: receipt(item.artifact_identity, {}, 'text'), visual_check: receipt(item.artifact_identity, {}, 'visual') }));
  return items.map(item => overrides[item.kind] === null ? null : { ...item, ...(overrides[item.kind] ?? {}) }).filter(Boolean);
}

function canonicalSources(catalog) {
  return structuredClone(catalog.get('PROJECT.md').attributes.canonical_writing_sources);
}

test('delivery accepts a complete graph with exact canonical sources and independent text/visual receipts', () => {
  const catalog = responseCatalog();
  const input = { catalog, canonicalSources: canonicalSources(catalog), renderedArtifacts: renderedArtifacts() };
  const before = JSON.stringify({ sources: input.canonicalSources, artifacts: input.renderedArtifacts });
  const report = validateDelivery(input);
  assert.equal(report.ok, true);
  assert.equal(report.coverage.closable, true);
  assert.deepEqual(report.checks, {
    coverage: true,
    sourceRegistry: true,
    sourceIdentity: true,
    cleanMarkedContent: true,
    renderedArtifacts: true,
    textReceipts: true,
    visualReceipts: true,
    writingState: true,
    unresolvedMarkers: true,
    numericProvenance: true
  });
  assert.deepEqual(Object.keys(report).sort(), ['artifacts', 'checks', 'coverage', 'issues', 'ok', 'sources']);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.sources.response), true);
  assert.equal(JSON.stringify({ sources: input.canonicalSources, artifacts: input.renderedArtifacts }), before);
  assert.equal(report.issues.some(item => /visually inspected/iu.test(item.message)), false);
});

test('delivery rejects caller sources that differ from PROJECT and clean/marked content mismatch while allowing source identities to differ', () => {
  const catalog = responseCatalog();
  const mismatched = canonicalSources(catalog);
  mismatched.response.source_identity = 'forged-response';
  let report = validateDelivery({ catalog, canonicalSources: mismatched, renderedArtifacts: renderedArtifacts() });
  assert.equal(report.ok, false);
  assert.equal(report.issues.some(item => item.code === 'DELIVERY_CANONICAL_SOURCE_MISMATCH'), true);

  const changedProject = structuredClone(catalog.get('PROJECT.md').attributes);
  changedProject.canonical_writing_sources.manuscript_marked.content_identity = 'different-content';
  const changedCatalog = responseCatalog({ 'PROJECT.md': changedProject });
  report = validateDelivery({ catalog: changedCatalog, canonicalSources: canonicalSources(changedCatalog), renderedArtifacts: renderedArtifacts() });
  assert.equal(report.checks.cleanMarkedContent, false);
  assert.equal(report.issues.some(item => item.code === 'DELIVERY_MANUSCRIPT_CONTENT_MISMATCH'), true);
});

test('delivery rejects missing/extra canonical source keys, unsafe refs, stale identity, and malformed values', () => {
  const catalog = responseCatalog();
  const cases = [
    [{ response: canonicalSources(catalog).response }, 'DELIVERY_SOURCE_KEYS'],
    [{ ...canonicalSources(catalog), extra: canonicalSources(catalog).response }, 'DELIVERY_SOURCE_KEYS'],
    [{ ...canonicalSources(catalog), response: { ...canonicalSources(catalog).response, resource_ref: '/absolute/response.tex' } }, 'DELIVERY_CANONICAL_SOURCE_MISMATCH'],
    [null, 'DELIVERY_INPUT_SHAPE'],
    [42, 'DELIVERY_INPUT_SHAPE']
  ];
  for (const [sources, code] of cases) {
    const report = validateDelivery({ catalog, canonicalSources: sources, renderedArtifacts: renderedArtifacts() });
    assert.equal(report.ok, false);
    assert.equal(report.issues.some(item => item.code === code), true, code);
  }
});

test('delivery blocks open/reopened graph records, unapproved Claims, reviewer-facing markers, and numeric gaps', () => {
  const baseCatalog = responseCatalog();
  const open = structuredClone(baseCatalog.get('plans/actions/ACT-002.md').attributes);
  open.status = 'reopened';
  open.status_history = [...open.status_history, { from: 'closed', to: 'reopened', at: '2026-08-03T00:00:08.000Z', reason: 'New reviewer requirement.' }];
  open.updated = '2026-08-03T00:00:08.000Z';
  open.affected_ids = ['CON-001'];
  const draftClaim = { ...baseCatalog.get('evidence/claims/CLM-001.md').attributes, approval_status: 'draft' };
  const markedResponse = { ...baseCatalog.get('writing/response/WRT-001.md').attributes, draft: 'TODO: add 91.2%.', numeric_sources: [] };
  const strategy = {
    ...baseCatalog.get('writing/response/WRT-001.md').attributes,
    id: 'WRT-099', writing_kind: 'internal_strategy', draft: 'TODO: this private option is allowed.'
  };
  const catalog = responseCatalog({
    'plans/actions/ACT-002.md': open,
    'evidence/claims/CLM-001.md': draftClaim,
    'writing/response/WRT-001.md': markedResponse,
    'writing/strategy/WRT-099.md': strategy
  });
  const report = validateDelivery({ catalog, canonicalSources: canonicalSources(catalog), renderedArtifacts: renderedArtifacts() });
  const codes = report.issues.map(item => item.code);
  assert.equal(report.ok, false);
  assert.equal(codes.includes('DELIVERY_COVERAGE_OPEN'), true);
  assert.equal(codes.includes('DELIVERY_RELEVANT_RECORD_OPEN'), true);
  assert.equal(codes.includes('DELIVERY_UNAPPROVED_CLAIM'), true);
  assert.equal(codes.includes('DELIVERY_UNRESOLVED_MARKER'), true);
  assert.equal(codes.includes('DELIVERY_NUMERIC_PROVENANCE'), true);
  assert.equal(report.issues.some(item => item.relatedIds.includes('WRT-099')), false);
});

test('delivery scans unresolved markers across canonical writing metadata, not only prose draft fields', () => {
  const baseCatalog = responseCatalog();
  const marked = { ...baseCatalog.get('writing/changes/WRT-002.md').attributes, change_summary: 'TODO: summarize the accepted change.' };
  const catalog = responseCatalog({ 'writing/changes/WRT-002.md': marked });
  const report = validateDelivery({ catalog, canonicalSources: canonicalSources(catalog), renderedArtifacts: renderedArtifacts() });
  assert.equal(report.ok, false);
  assert.equal(report.issues.some(item => item.code === 'DELIVERY_UNRESOLVED_MARKER' && item.relatedIds.includes('WRT-002')), true);
});

test('delivery maps unresolved formal Decision text to an exact blocking authority issue', () => {
  const catalog = responseCatalog({
    'decisions/DEC-001.md': decision({ options: [{ option: { values: ['TBD'] } }] }),
    'writing/response/WRT-001.md': response({ evidence_or_reason: ['DEC-001'] })
  });
  const report = validateDelivery({ catalog, canonicalSources: canonicalSources(catalog), renderedArtifacts: renderedArtifacts() });
  assert.equal(report.ok, false);
  assert.equal(report.issues.some(item => item.code === 'DELIVERY_UNRESOLVED_AUTHORITY' && item.path === 'decisions/DEC-001.md'), true);
});

test('delivery enforces exactly one rendered artifact of each kind and exact source mapping', () => {
  const catalog = responseCatalog();
  const cases = [
    [renderedArtifacts({ response_pdf: null }), 'DELIVERY_ARTIFACT_KIND'],
    [[...renderedArtifacts(), renderedArtifacts()[0]], 'DELIVERY_ARTIFACT_KIND'],
    [renderedArtifacts({ response_pdf: { source_key: 'manuscript_clean' } }), 'DELIVERY_ARTIFACT_SOURCE'],
    [renderedArtifacts({ response_pdf: { source_identity: 'stale-source' } }), 'DELIVERY_ARTIFACT_SOURCE'],
    [renderedArtifacts({ response_pdf: { artifact_ref: '/tmp/response.pdf' } }), 'DELIVERY_ARTIFACT_REF'],
    [[null], 'DELIVERY_ARTIFACT_SHAPE']
  ];
  for (const [artifacts, code] of cases) {
    const report = validateDelivery({ catalog, canonicalSources: canonicalSources(catalog), renderedArtifacts: artifacts });
    assert.equal(report.ok, false);
    assert.equal(report.issues.some(item => item.code === code), true, code);
  }
});

test('delivery receipts are exact, current, passing, and bound to the declared artifact identity', () => {
  const catalog = responseCatalog();
  const cases = [
    [{ visual_check: null }, 'DELIVERY_VISUAL_RECEIPT'],
    [{ text_check: receipt('response-pdf-v1', { status: 'fail' }) }, 'DELIVERY_TEXT_RECEIPT'],
    [{ visual_check: receipt('other-artifact') }, 'DELIVERY_VISUAL_RECEIPT'],
    [{ text_check: receipt('response-pdf-v1', { checked_at: 'yesterday' }) }, 'DELIVERY_TEXT_RECEIPT'],
    [{ visual_check: { ...receipt('response-pdf-v1'), extra: true } }, 'DELIVERY_VISUAL_RECEIPT']
  ];
  for (const [override, code] of cases) {
    const report = validateDelivery({
      catalog,
      canonicalSources: canonicalSources(catalog),
      renderedArtifacts: renderedArtifacts({ response_pdf: override })
    });
    assert.equal(report.ok, false);
    assert.equal(report.issues.some(item => item.code === code), true, code);
  }
});

test('delivery requires globally distinct artifact refs, identities, and independent receipt IDs', () => {
  const catalog = responseCatalog();
  const sharedText = receipt('response-pdf-v1', {}, 'shared');
  const cases = [
    renderedArtifacts({ manuscript_clean_pdf: { artifact_ref: 'artifacts:response.pdf' } }),
    renderedArtifacts({ manuscript_clean_pdf: { artifact_identity: 'response-pdf-v1' } }),
    renderedArtifacts({ response_pdf: { text_check: sharedText, visual_check: sharedText } }),
    renderedArtifacts({
      response_pdf: { text_check: sharedText },
      manuscript_clean_pdf: { text_check: { ...sharedText, artifact_identity: 'clean-pdf-v1' } }
    })
  ];
  for (const artifacts of cases) {
    const report = validateDelivery({ catalog, canonicalSources: canonicalSources(catalog), renderedArtifacts: artifacts });
    assert.equal(report.ok, false);
    assert.equal(report.issues.some(item => item.code === 'DELIVERY_ARTIFACT_DISTINCTNESS' || item.code === 'DELIVERY_RECEIPT_DISTINCTNESS'), true);
  }
});

test('delivery blocks every broken transitive approved-Claim provenance chain', () => {
  const valid = provenanceCatalog();
  assert.equal(validateDelivery({ catalog: valid, canonicalSources: canonicalSources(valid), renderedArtifacts: renderedArtifacts() }).ok, true);
  const cases = [
    provenanceCatalog({ 'experiments/runs/RUN-001.md': null }),
    provenanceCatalog({
      'experiments/runs/RUN-001.md': null,
      'evidence/packets/RUN-001.md': evidence({ id: 'RUN-001', sources: ['CON-001', 'results:metrics.json'] })
    }),
    provenanceCatalog({ 'experiments/runs/RUN-001.md': null, 'archive/RUN-001.md': run() }),
    provenanceCatalog({ 'experiments/runs/RUN-001-copy.md': run() }),
    provenanceCatalog({ 'experiments/runs/RUN-001.md': null })
  ];
  for (const catalog of cases) {
    const report = validateDelivery({ catalog, canonicalSources: canonicalSources(catalog), renderedArtifacts: renderedArtifacts() });
    assert.equal(report.ok, false);
    assert.equal(report.coverage.closable, false);
    assert.equal(report.issues.some(item => item.code === 'DELIVERY_CLAIM_PROVENANCE' || item.code === 'RESPONSE_CLAIM_PROVENANCE'), true);
  }
});

test('delivery blocks every open non-current Driver but accepts the same authority when closed', () => {
  for (const status of ['inbox', 'defined', 'ready', 'in_progress', 'review', 'verified']) {
    const catalog = responseCatalog({
      'research/questions/RQ-099.md': researchQuestion({ ...lifecycle(status) }),
      'evidence/packets/EVD-001.md': evidence({ sources: ['CON-001', 'RQ-099', 'results:metrics.json'] })
    });
    const report = validateDelivery({ catalog, canonicalSources: canonicalSources(catalog), renderedArtifacts: renderedArtifacts() });
    assert.equal(report.ok, false, status);
    assert.equal(report.issues.some(item => item.code === 'DELIVERY_CLAIM_PROVENANCE'), true, status);
  }
  const otherConcern = responseCatalog({
    'reviews/concerns/CON-099.md': concern({ id: 'CON-099', source_comment_id: 'R9-C9', actions: [], ...lifecycle('review') }),
    'evidence/packets/EVD-001.md': evidence({ sources: ['CON-001', 'CON-099', 'results:metrics.json'] })
  });
  const otherReport = validateDelivery({ catalog: otherConcern, canonicalSources: canonicalSources(otherConcern), renderedArtifacts: renderedArtifacts() });
  assert.equal(otherReport.ok, false);
  assert.equal(otherReport.issues.some(item => item.code === 'DELIVERY_CLAIM_PROVENANCE' && item.relatedIds.includes('CON-099')), true);
  const closed = responseCatalog({
    'research/questions/RQ-099.md': researchQuestion(),
    'evidence/packets/EVD-001.md': evidence({ sources: ['CON-001', 'RQ-099', 'results:metrics.json'] })
  });
  assert.equal(validateDelivery({ catalog: closed, canonicalSources: canonicalSources(closed), renderedArtifacts: renderedArtifacts() }).ok, true);
});

test('delivery rejects path-keyed catalog entries whose key cannot authorize the RecordRef path', () => {
  const catalogs = [];
  const mismatch = responseCatalog();
  mismatch.set('reviews/concerns/RQ-099.md', ref('research/questions/RQ-099.md', researchQuestion()));
  catalogs.push(mismatch);
  const symbolKey = responseCatalog();
  symbolKey.set(Symbol('hidden'), ref('research/questions/RQ-099.md', researchQuestion()));
  catalogs.push(symbolKey);
  for (const catalog of catalogs) {
    const report = validateDelivery({ catalog, canonicalSources: canonicalSources(catalog), renderedArtifacts: renderedArtifacts() });
    assert.equal(report.ok, false);
    assert.equal(report.coverage.issues.some(item => item.code === 'CATALOG_KEY_PATH_INVALID'), true);
  }
});

test('delivery is total over untrusted input shapes and returns a stable frozen report', () => {
  for (const input of [null, undefined, 7, 'delivery', [], {}, { catalog: new Map(), canonicalSources: {}, renderedArtifacts: [] }]) {
    assert.doesNotThrow(() => validateDelivery(input));
    const report = validateDelivery(input);
    assert.deepEqual(Object.keys(report).sort(), ['artifacts', 'checks', 'coverage', 'issues', 'ok', 'sources']);
    assert.equal(report.ok, false);
    assert.equal(Object.isFrozen(report.issues), true);
  }
});

test('delivery rejects cycles and accessors deterministically without executing getters or mutating input', () => {
  const catalog = responseCatalog();
  const cyclicSources = canonicalSources(catalog);
  cyclicSources.response.resource_ref = cyclicSources.response;
  let getterCalls = 0;
  const accessorSources = canonicalSources(catalog);
  Object.defineProperty(accessorSources, 'response', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('secret getter message'); }
  });
  for (const sources of [cyclicSources, accessorSources]) {
    let first;
    let second;
    assert.doesNotThrow(() => { first = validateDelivery({ catalog, canonicalSources: sources, renderedArtifacts: renderedArtifacts() }); });
    assert.doesNotThrow(() => { second = validateDelivery({ catalog, canonicalSources: sources, renderedArtifacts: renderedArtifacts() }); });
    assert.deepEqual(first, second);
    assert.equal(first.ok, false);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.issues), true);
    assert.equal(first.issues.some(item => item.message.includes('secret getter message')), false);
  }
  assert.equal(cyclicSources.response.resource_ref, cyclicSources.response);
  assert.equal(getterCalls, 0);
});

async function diskCatalogFixture(catalog = responseCatalog()) {
  const root = await makeProjectFixture();
  for (const [path, record] of catalog) {
    if (path === 'PROJECT.md') {
      const current = parseMarkdownDocument(await readFile(join(root, path), 'utf8'), path);
      await writeFile(join(root, path), serializeMarkdownDocument(record.attributes, current.body), 'utf8');
    } else {
      await writeRecordFixture(root, path, record.attributes);
    }
  }
  return { root, catalog };
}

test('writing CLI does not let a body wikilink replace missing Result-to-Run frontmatter provenance', async () => {
  const catalog = provenanceCatalog({ 'experiments/runs/RUN-001.md': null });
  const { root } = await diskCatalogFixture(catalog);
  const resultRecord = catalog.get('experiments/results/RES-001.md');
  await writeRecordFixture(root, resultRecord.path, resultRecord.attributes, '# Result\n\nThe run appears only as [[RUN-001]] in prose.\n');
  const io = captureIo();
  assert.equal(await main(['writing', 'delivery-check', '--project', root, '--rendered-artifacts', JSON.stringify(renderedArtifacts())], io.io), 3);
  const report = JSON.parse(io.output().stdout);
  assert.equal(report.ok, false);
  assert.equal(report.issues.some(item => item.code === 'DELIVERY_CLAIM_PROVENANCE' || item.code === 'RESPONSE_CLAIM_PROVENANCE'), true);
});

test('writing CLI exposes deterministic coverage, block validation, and delivery checks with validation exit codes', async () => {
  const { root, catalog } = await diskCatalogFixture();
  const coverageIo = captureIo();
  assert.equal(await main(['writing', 'coverage', '--project', root], coverageIo.io), 0);
  assert.equal(JSON.parse(coverageIo.output().stdout).closable, true);

  const blockIo = captureIo();
  assert.equal(await main(['writing', 'validate-block', '--project', root, '--id', 'WRT-001'], blockIo.io), 0);
  assert.deepEqual(JSON.parse(blockIo.output().stdout), { id: 'WRT-001', ok: true, issues: [] });

  const deliveryIo = captureIo();
  assert.equal(await main(['writing', 'delivery-check', '--project', root, '--rendered-artifacts', JSON.stringify(renderedArtifacts())], deliveryIo.io), 0);
  assert.equal(JSON.parse(deliveryIo.output().stdout).ok, true);

  const projectPath = join(root, 'PROJECT.md');
  const projectDocument = parseMarkdownDocument(await readFile(projectPath, 'utf8'), projectPath);
  const mismatched = structuredClone(projectDocument.attributes);
  mismatched.canonical_writing_sources.manuscript_marked.content_identity = 'different-content';
  await writeFile(projectPath, serializeMarkdownDocument(mismatched, projectDocument.body), 'utf8');
  const blocked = captureIo();
  assert.equal(await main(['writing', 'delivery-check', '--project', root, '--rendered-artifacts', JSON.stringify(renderedArtifacts())], blocked.io), 3);
  assert.equal(JSON.parse(blocked.output().stdout).ok, false);
  assert.equal(catalog.get('PROJECT.md').attributes.project_id, 'demo');

  for (const args of [
    ['coverage'],
    ['coverage', '--project', root, '--extra', 'x'],
    ['validate-block', '--project', root],
    ['delivery-check', '--project', root, '--rendered-artifacts', '{}'],
    ['delivery-check', '--project', root, '--rendered-artifacts', '[broken']
  ]) {
    const invalid = captureIo();
    assert.equal(await main(['writing', ...args], invalid.io), 2);
  }
});

test('writing CLI blocks every invalid reviewer-facing candidate instead of silently dropping it', async () => {
  const cases = [
    {
      path: 'writing/response/WRT-099.md',
      attributes: response({ id: 'WRT-099', concern: 'CON-999', direct_answer: '', manuscript_changes: [] })
    },
    {
      path: 'writing/changes/WRT-099.md',
      attributes: change({
        id: 'WRT-099', synchronization_status: 'pending', verification_result: 'failed',
        response_blocks: []
      })
    },
    {
      path: 'reviews/concerns/CON-099.md',
      attributes: concern({ id: 'CON-099', driver_kind: 'research_question', actions: [] })
    }
  ];
  for (const candidate of cases) {
    const { root } = await diskCatalogFixture();
    await writeRecordFixture(root, candidate.path, candidate.attributes);
    const io = captureIo();
    const code = await main(['writing', 'delivery-check', '--project', root, '--rendered-artifacts', JSON.stringify(renderedArtifacts())], io.io);
    assert.equal(code, 3, candidate.path);
    const report = JSON.parse(io.output().stdout);
    assert.equal(report.ok, false, candidate.path);
    assert.equal(report.issues.some(item => item.path === candidate.path), true, candidate.path);
  }

  const { root } = await diskCatalogFixture();
  const corruptPath = join(root, 'writing/response/WRT-999.md');
  await writeFile(corruptPath, '---\nid: WRT-999\ntype: writing\nwriting_kind: [broken\n---\n', 'utf8');
  const io = captureIo();
  const code = await main(['writing', 'delivery-check', '--project', root, '--rendered-artifacts', JSON.stringify(renderedArtifacts())], io.io);
  assert.equal(code, 3);
  const report = JSON.parse(io.output().stdout);
  assert.equal(report.ok, false);
  assert.equal(report.issues.some(item => item.path === 'writing/response/WRT-999.md'), true);

  const missingFixture = await diskCatalogFixture();
  const missingId = response({ id: undefined });
  delete missingId.id;
  await writeRecordFixture(missingFixture.root, 'writing/response/missing-id.md', missingId);
  const missingIo = captureIo();
  assert.equal(await main(['writing', 'delivery-check', '--project', missingFixture.root, '--rendered-artifacts', JSON.stringify(renderedArtifacts())], missingIo.io), 3);
  assert.equal(JSON.parse(missingIo.output().stdout).issues.some(item => item.path === 'writing/response/missing-id.md'), true);

  const duplicateFixture = await diskCatalogFixture();
  await writeRecordFixture(duplicateFixture.root, 'writing/changes/WRT-001.md', change({ id: 'WRT-001' }));
  const duplicateIo = captureIo();
  assert.equal(await main(['writing', 'delivery-check', '--project', duplicateFixture.root, '--rendered-artifacts', JSON.stringify(renderedArtifacts())], duplicateIo.io), 3);
  const duplicateReport = JSON.parse(duplicateIo.output().stdout);
  assert.equal(duplicateReport.issues.some(item => item.code === 'DUPLICATE_RECORD_ID' && item.path === 'writing/response/WRT-001.md'), true);
  assert.equal(duplicateReport.issues.some(item => item.code === 'DUPLICATE_RECORD_ID' && item.path === 'writing/changes/WRT-001.md'), true);
});

test('writing validate-block reports ambiguous and non-writing IDs as structured validation failures', async () => {
  const { root } = await diskCatalogFixture();
  await writeRecordFixture(root, 'writing/response/WRT-001-copy.md', response());
  const ambiguous = captureIo();
  assert.equal(await main(['writing', 'validate-block', '--project', root, '--id', 'WRT-001'], ambiguous.io), 3);
  assert.equal(ambiguous.output().stderr, '');
  const ambiguousReport = JSON.parse(ambiguous.output().stdout);
  assert.equal(ambiguousReport.id, 'WRT-001');
  assert.equal(ambiguousReport.ok, false);
  assert.equal(ambiguousReport.issues.some(item => item.code === 'RESPONSE_RECORD_AMBIGUOUS'), true);

  const nonWriting = captureIo();
  assert.equal(await main(['writing', 'validate-block', '--project', root, '--id', 'EVD-001'], nonWriting.io), 3);
  assert.equal(nonWriting.output().stderr, '');
  const nonWritingReport = JSON.parse(nonWriting.output().stdout);
  assert.equal(nonWritingReport.ok, false);
  assert.equal(nonWritingReport.issues.some(item => item.code === 'RESPONSE_RECORD_KIND'), true);
});

test('all writing CLI commands expose recursive reviewer-candidate diagnostics, including selected corrupt blocks', async () => {
  const nestedFixture = await diskCatalogFixture();
  const nested = 'writing/response/nested/WRT-099.md';
  await mkdir(join(nestedFixture.root, 'writing/response/nested'), { recursive: true });
  await writeFile(join(nestedFixture.root, nested), '# missing frontmatter\n', 'utf8');
  for (const args of [
    ['writing', 'coverage', '--project', nestedFixture.root],
    ['writing', 'delivery-check', '--project', nestedFixture.root, '--rendered-artifacts', JSON.stringify(renderedArtifacts())]
  ]) {
    const io = captureIo();
    assert.equal(await main(args, io.io), 3);
    assert.equal(JSON.stringify(JSON.parse(io.output().stdout)).includes(nested), true);
  }

  const siblingFixture = await diskCatalogFixture();
  const sibling = 'writing/changes/WRT-099.md';
  await writeFile(join(siblingFixture.root, sibling), '---\nid: WRT-099\ntype: writing\nwriting_kind: [broken\n---\n', 'utf8');
  const siblingIo = captureIo();
  assert.equal(await main(['writing', 'validate-block', '--project', siblingFixture.root, '--id', 'WRT-001'], siblingIo.io), 3);
  assert.equal(JSON.stringify(JSON.parse(siblingIo.output().stdout)).includes(sibling), true);

  const selectedFixture = await diskCatalogFixture();
  const selected = 'writing/response/WRT-099.md';
  await writeFile(join(selectedFixture.root, selected), '---\nid: WRT-099\ntype: writing\nwriting_kind: [broken\n---\n', 'utf8');
  const selectedIo = captureIo();
  assert.equal(await main(['writing', 'validate-block', '--project', selectedFixture.root, '--id', 'WRT-099'], selectedIo.io), 3);
  assert.equal(selectedIo.output().stderr, '');
  assert.equal(JSON.stringify(JSON.parse(selectedIo.output().stdout)).includes(selected), true);
});

test('coverage exposes top-level issues when invalid reviewer candidates are the only Concern authority', async () => {
  const root = await makeProjectFixture();
  const projectRecord = responseCatalog().get('PROJECT.md');
  const current = parseMarkdownDocument(await readFile(join(root, 'PROJECT.md'), 'utf8'), 'PROJECT.md');
  await writeFile(join(root, 'PROJECT.md'), serializeMarkdownDocument(projectRecord.attributes, current.body), 'utf8');
  const path = 'reviews/concerns/CON-099.md';
  await writeRecordFixture(root, path, concern({ id: 'CON-099', driver_kind: 'research_question', actions: [] }));
  const io = captureIo();
  assert.equal(await main(['writing', 'coverage', '--project', root], io.io), 3);
  const report = JSON.parse(io.output().stdout);
  assert.equal(report.issues.some(item => item.path === path), true);
  assert.equal(report.closable, false);
});

test('delivery requires Concern closure even when pre-close coverage is otherwise closable', () => {
  const catalog = responseCatalog({ 'reviews/concerns/CON-001.md': concern({ ...lifecycle('review') }) });
  const report = validateDelivery({ catalog, canonicalSources: canonicalSources(catalog), renderedArtifacts: renderedArtifacts() });
  assert.equal(report.coverage.closable, true);
  assert.equal(report.ok, false);
  assert.equal(report.issues.some(item => item.code === 'DELIVERY_RELEVANT_RECORD_OPEN' && item.relatedIds.includes('CON-001')), true);
});
