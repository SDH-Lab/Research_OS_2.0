import { configureAction, approveActionScope, recordActionCheck } from '../../src/actions/workflow.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { main } from '../../src/cli.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../../src/lib/markdown.js';
import { createRecord, updateRecordStatus } from '../../src/records/create.js';
import { enableModule } from '../../src/project/project.js';
import { buildViews, calculateForecastForProject, cleanViews, GENERATED_FILES, showView } from '../../src/views/generate.js';
import { captureIo, configureSessionFixture, makeProjectFixture, pathExists } from '../helpers/fixtures.js';

async function bytes(path) {
  return readFile(path);
}

async function hashes(root, paths) {
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash('sha256').update(await bytes(join(root, path))).digest('hex')])));
}

async function outputBytes(root) {
  return Object.fromEntries(await Promise.all(GENERATED_FILES.map(async path => [path, await readFile(join(root, path), 'utf8')])));
}

test('build is byte-identical twice and after safe clean while canonical input hashes stay unchanged', async () => {
  const root = await makeProjectFixture();
  const canonical = ['AGENTS.md', 'PROJECT.md', 'plans/active.md'];
  const before = await hashes(root, canonical);

  const first = await buildViews(root);
  const firstBytes = await outputBytes(root);
  const second = await buildViews(root);
  const secondBytes = await outputBytes(root);
  assert.deepEqual(secondBytes, firstBytes);
  assert.equal(second.sourceDigest, first.sourceDigest);
  assert.deepEqual([...first.files], [...GENERATED_FILES]);

  await writeFile(join(root, 'generated', 'personal-note.md'), '# Keep me\n', 'utf8');
  const cleaned = await cleanViews(root);
  assert.deepEqual([...cleaned.removed], [...GENERATED_FILES]);
  assert.equal(await pathExists(join(root, 'generated', 'personal-note.md')), true);
  await buildViews(root);
  assert.deepEqual(await outputBytes(root), firstBytes);
  assert.deepEqual(await hashes(root, canonical), before);
});

test('generation manifest has exact allowlist, stable sorted source hashes, no generated input or self hash', async () => {
  const root = await makeProjectFixture();
  await buildViews(root);
  const manifest = JSON.parse(await readFile(join(root, 'generated', 'generation-manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.files, [...GENERATED_FILES]);
  assert.equal(manifest.coreVersion, '2.0.0');
  assert.match(manifest.sourceDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.inputs, [...manifest.inputs].sort((a, b) => a.path.localeCompare(b.path, 'en')));
  assert.equal(manifest.inputs.some(item => item.path.startsWith('generated/')), false);
  assert.equal(Object.hasOwn(manifest, 'selfHash'), false);
  assert.equal(manifest.inputs.every(item => /^[a-f0-9]{64}$/.test(item.sha256)), true);
  assert.deepEqual(manifest.outputs.map(item => item.path), GENERATED_FILES.slice(0, -1));
  assert.deepEqual(
    Object.fromEntries(manifest.outputs.map(item => [item.path, item.sha256])),
    await hashes(root, GENERATED_FILES.slice(0, -1))
  );
});

test('volatile tool-state directories never affect the canonical source digest', async () => {
  const root = await makeProjectFixture();
  await mkdir(join(root, '.codex'), { recursive: true });
  await writeFile(join(root, '.codex', 'session.log'), 'first\n', 'utf8');
  const first = await buildViews(root);
  await writeFile(join(root, '.codex', 'session.log'), 'second\n', 'utf8');
  const second = await buildViews(root);
  assert.equal(second.sourceDigest, first.sourceDigest);
  const manifest = JSON.parse(await readFile(join(root, 'generated', 'generation-manifest.json'), 'utf8'));
  assert.equal(manifest.inputs.some(item => item.path.startsWith('.codex/')), false);

  await writeFile(join(root, 'AGENTS.md'), '# Changed canonical authority\n', 'utf8');
  const third = await buildViews(root);
  assert.notEqual(third.sourceDigest, second.sourceDigest);
});

test('clean refuses a tampered manifest atomically and preserves all listed and unlisted files', async () => {
  const root = await makeProjectFixture();
  await buildViews(root);
  const manifestPath = join(root, 'generated', 'generation-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files = [...manifest.files, '../PROJECT.md'];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'generated', 'personal-note.md'), '# Keep me\n', 'utf8');

  await assert.rejects(() => cleanViews(root), error => error.code === 'VALIDATION');
  for (const path of GENERATED_FILES) assert.equal(await pathExists(join(root, path)), true, path);
  assert.equal(await pathExists(join(root, 'generated', 'personal-note.md')), true);
  assert.equal(await pathExists(join(root, 'PROJECT.md')), true);
});

test('clean validates the complete manifest contract before any deletion', async () => {
  for (const mutate of [
    manifest => { manifest.sourceDigest = 'not-a-digest'; },
    manifest => { manifest.coreVersion = 'not-a-version'; },
    manifest => { manifest.coreVersion = '99.0.0'; },
    manifest => { manifest.inputs[0].sha256 = 'b'.repeat(64); },
    manifest => { manifest.inputs = [...manifest.inputs].reverse(); },
    manifest => { manifest.inputs[0].path = 'generated/dashboard.md'; },
    manifest => { manifest.outputs[0].sha256 = 'b'.repeat(64); },
    manifest => { manifest.outputs = [...manifest.outputs].reverse(); },
    manifest => { manifest.outputs[0].path = 'generated/unknown.md'; },
    manifest => { manifest.selfHash = 'a'.repeat(64); }
  ]) {
    const root = await makeProjectFixture();
    await buildViews(root);
    const manifestPath = join(root, 'generated', 'generation-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    mutate(manifest);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await assert.rejects(() => cleanViews(root), error => error.code === 'VALIDATION');
    for (const path of GENERATED_FILES) assert.equal(await pathExists(join(root, path)), true, path);
  }
});

test('clean rejects symlinks and missing listed files before deleting anything', async t => {
  const root = await makeProjectFixture();
  await buildViews(root);
  const target = join(root, 'generated', 'dashboard.md');
  const original = await readFile(target, 'utf8');
  await t.test('missing file', async () => {
    const { unlink } = await import('node:fs/promises');
    await unlink(target);
    await assert.rejects(() => cleanViews(root), error => error.code === 'VALIDATION');
    assert.equal(await pathExists(join(root, 'generated', 'forecast.json')), true);
    await writeFile(target, original, 'utf8');
  });
  await t.test('symlink file', async () => {
    const { symlink, unlink } = await import('node:fs/promises');
    await unlink(target);
    await symlink(join(root, 'PROJECT.md'), target);
    await assert.rejects(() => cleanViews(root), error => error.code === 'VALIDATION');
    assert.equal(await pathExists(join(root, 'generated', 'forecast.json')), true);
  });
});

test('build validates authority before writing and reports disabled reviews as not applicable', async () => {
  const root = await makeProjectFixture();
  await buildViews(root);
  assert.match(await readFile(join(root, 'generated', 'coverage.md'), 'utf8'), /not_applicable/);

  const invalidRoot = await makeProjectFixture();
  const projectPath = join(invalidRoot, 'PROJECT.md');
  const project = parseMarkdownDocument(await readFile(projectPath, 'utf8'), projectPath);
  await writeFile(projectPath, serializeMarkdownDocument({ ...project.attributes, forecast_settings: { ...project.attributes.forecast_settings, timezone: 'Mars/Olympus' } }, project.body), 'utf8');
  await assert.rejects(() => buildViews(invalidRoot), error => error.code === 'VALIDATION');
  assert.equal(await pathExists(join(invalidRoot, 'generated')), false);
});

test('enabled reviews use candidate-aware coverage and corrupt candidates block before generation', async () => {
  const root = await makeProjectFixture();
  await enableModule(root, 'reviews');
  await buildViews(root);
  const coverage = await readFile(join(root, 'generated', 'coverage.md'), 'utf8');
  assert.match(coverage, /status: enabled/);
  assert.match(coverage, /Concern count: 0/);

  const corrupt = await makeProjectFixture();
  await enableModule(corrupt, 'reviews');
  await mkdir(join(corrupt, 'reviews', 'concerns'), { recursive: true });
  await writeFile(join(corrupt, 'reviews', 'concerns', 'bad.md'), '# Missing authority\n', 'utf8');
  await assert.rejects(() => buildViews(corrupt), error => error.code === 'VALIDATION' && error.details.some(item => item.path === 'reviews/concerns/bad.md'));
  assert.equal(await pathExists(join(corrupt, 'generated')), false);
});

test('dashboard and exception inbox link canonical sources and expose sentinel Actions', async () => {
  const root = await makeProjectFixture();
  await createRecord(root, 'driver', { id: 'RQ-001', title: 'Question', source: 'brief', question: 'What remains?' });
  await createRecord(root, 'action', { id: 'ACT-001', title: 'Unclassified work', driver: 'RQ-001', acceptance: 'Checked.' });
  await buildViews(root);
  const dashboard = await readFile(join(root, 'generated', 'dashboard.md'), 'utf8');
  const exceptions = await readFile(join(root, 'generated', 'exception-inbox.md'), 'utf8');
  assert.match(dashboard, /\[PROJECT\.md\]\(\.\.\/PROJECT\.md\)/);
  assert.match(dashboard, /\[plans\/actions\/ACT-001\.md\]\(\.\.\/plans\/actions\/ACT-001\.md\)/);
  assert.match(dashboard, /Optimistic/);
  assert.match(dashboard, /Handoff/);
  assert.match(exceptions, /ACTION_DOMAIN_UNCLASSIFIED/);
  assert.match(exceptions, /\[plans\/actions\/ACT-001\.md\]\(\.\.\/plans\/actions\/ACT-001\.md\)/);
});

test('dependency-cycle forecast issues are visible in the Exception Inbox with canonical paths', async () => {
  const root = await makeProjectFixture();
  await createRecord(root, 'driver', { id: 'RQ-001', title: 'Question', source: 'brief', question: 'What remains?' });
  await createRecord(root, 'action', { id: 'ACT-011', title: 'First', driver: 'RQ-001', acceptance: 'Checked.', domain: 'analysis', size: 'small', dependencies: ['ACT-012'] });
  await createRecord(root, 'action', { id: 'ACT-012', title: 'Second', driver: 'RQ-001', acceptance: 'Checked.', domain: 'writing', size: 'small', dependencies: ['ACT-011'] });
  await buildViews(root);
  const exceptions = await readFile(join(root, 'generated', 'exception-inbox.md'), 'utf8');
  const forecast = JSON.parse(await readFile(join(root, 'generated', 'forecast.json'), 'utf8'));
  assert.match(exceptions, /DEPENDENCY_CYCLE/);
  assert.match(exceptions, /plans\/actions\/ACT-011\.md/);
  assert.match(exceptions, /plans\/actions\/ACT-012\.md/);
  assert.deepEqual(forecast.issues.filter(item => item.code === 'DEPENDENCY_CYCLE').map(item => item.path), [
    'plans/actions/ACT-011.md', 'plans/actions/ACT-012.md'
  ]);
  assert.equal(forecast.optimistic.earliest, null);
});

test('closed canonical non-Action dependencies satisfy forecast authority', async () => {
  const root = await makeProjectFixture();
  await createRecord(root, 'driver', { id: 'RQ-021', title: 'Question', source: 'brief', question: 'What remains?' });
  for (const status of ['defined', 'ready', 'in_progress']) await updateRecordStatus(root, 'RQ-021', status, { reason: status });
  await updateRecordStatus(root, 'RQ-021', 'closed', { reason: 'answered', verifiedAt: new Date().toISOString() });
  await createRecord(root, 'action', { id: 'ACT-021', title: 'Use answer', driver: 'RQ-021', dependencies: ['RQ-021'], acceptance: 'Checked.', domain: 'analysis', size: 'small' });
  await buildViews(root);
  const forecast = JSON.parse(await readFile(join(root, 'generated', 'forecast.json'), 'utf8'));
  assert.equal(forecast.issues.some(item => item.code.startsWith('DEPENDENCY_')), false);
  assert.notEqual(forecast.optimistic.earliest, null);
});

test('forecast asOf is a hard authority cutoff for build and calculate with zero writes', async () => {
  const root = await makeProjectFixture();
  const projectPath = join(root, 'PROJECT.md');
  const project = parseMarkdownDocument(await readFile(projectPath, 'utf8'), projectPath);
  await writeFile(projectPath, serializeMarkdownDocument({
    ...project.attributes,
    forecast_settings: { ...project.attributes.forecast_settings, as_of: '2000-01-01' }
  }, project.body), 'utf8');

  await assert.rejects(
    () => buildViews(root),
    error => error.code === 'VALIDATION' && error.details.some(item => item.code === 'FORECAST_AS_OF_BEFORE_AUTHORITY' && item.path === 'PROJECT.md')
  );
  assert.equal(await pathExists(join(root, 'generated')), false);
  const io = captureIo();
  assert.equal(await main(['forecast', 'calculate', '--project', root], io.io), 3);
  assert.match(io.output().stderr, /FORECAST_AS_OF_BEFORE_AUTHORITY/);
});

test('build preflights all targets and rolls published views back on hook or final-authority failure', async t => {
  await t.test('target collision changes no other output', async () => {
    const root = await makeProjectFixture();
    await buildViews(root);
    const before = await outputBytes(root);
    const collision = join(root, 'generated', 'forecast.json');
    await unlink(collision);
    await mkdir(collision);
    await assert.rejects(() => buildViews(root), error => error.code === 'VALIDATION');
    for (const path of GENERATED_FILES.filter(path => path !== 'generated/forecast.json')) {
      assert.equal(await readFile(join(root, path), 'utf8'), before[path]);
    }
    assert.deepEqual((await readdir(join(root, 'generated'))).filter(name => name.includes('.research-os-stage')), []);
  });

  for (const [name, hook] of [
    ['after-stage authority mutation', {
      afterStage: async ({ projectRoot }) => writeFile(join(projectRoot, 'AGENTS.md'), '# Mutated authority\n', 'utf8')
    }],
    ['mid-publish failure', {
      beforePublish: async ({ index }) => { if (index === 1) throw new Error('publish hook failure'); }
    }],
    ['post-publish authority mutation', {
      afterPublish: async ({ path, projectRoot }) => {
        if (path === 'generated/forecast.json') await writeFile(join(projectRoot, 'AGENTS.md'), '# Mutated after publish\n', 'utf8');
      }
    }]
  ]) {
    await t.test(name, async () => {
      const root = await makeProjectFixture();
      await buildViews(root);
      const before = await outputBytes(root);
      const projectPath = join(root, 'PROJECT.md');
      const project = parseMarkdownDocument(await readFile(projectPath, 'utf8'), projectPath);
      await writeFile(projectPath, serializeMarkdownDocument({ ...project.attributes, title: `${project.attributes.title} changed` }, project.body), 'utf8');
      await assert.rejects(() => buildViews(root, { hooks: hook }), error => error.code === 'VALIDATION');
      assert.deepEqual(await outputBytes(root), before);
      assert.equal((await readdir(join(root, 'generated'))).some(entry => entry.includes('.research-os-')), false);
    });
  }
});

test('successful transaction publishes the manifest last and cleans staging files', async () => {
  const root = await makeProjectFixture();
  await buildViews(root);
  const manifestPath = join(root, 'generated', 'generation-manifest.json');
  const oldManifest = await readFile(manifestPath, 'utf8');
  const projectPath = join(root, 'PROJECT.md');
  const project = parseMarkdownDocument(await readFile(projectPath, 'utf8'), projectPath);
  await writeFile(projectPath, serializeMarkdownDocument({ ...project.attributes, title: `${project.attributes.title} changed` }, project.body), 'utf8');
  const observations = [];
  await buildViews(root, { hooks: {
    beforePublish: async ({ path }) => observations.push({
      path,
      manifestExists: await pathExists(manifestPath),
      privateEntries: (await readdir(join(root, 'generated'))).filter(entry => entry.includes('.research-os-'))
    })
  } });
  assert.deepEqual(observations.map(item => item.path), [...GENERATED_FILES]);
  assert.equal(observations.every(item => item.manifestExists === false), true);
  assert.equal(observations.every(item => item.privateEntries.every(entry => !entry.includes('-backup-'))), true);
  assert.notEqual(await readFile(manifestPath, 'utf8'), oldManifest);
  assert.equal((await readdir(join(root, 'generated'))).some(entry => entry.includes('.research-os-')), false);
});

test('manifest rename is terminal because no post-commit backup cleanup remains', async () => {
  const root = await makeProjectFixture();
  await buildViews(root);
  const oldManifest = (await showView(root, 'manifest')).content;
  const projectPath = join(root, 'PROJECT.md');
  const project = parseMarkdownDocument(await readFile(projectPath, 'utf8'), projectPath);
  await writeFile(projectPath, serializeMarkdownDocument({ ...project.attributes, title: 'Terminal committed title' }, project.body), 'utf8');
  let foundBackup = false;
  await buildViews(root, { hooks: { beforePublish: async ({ path }) => {
    if (path !== 'generated/generation-manifest.json') return;
    const backup = (await readdir(join(root, 'generated'))).find(entry => entry.startsWith('.research-os-backup-'));
    if (!backup) return;
    foundBackup = true;
    await unlink(join(root, 'generated', backup));
    await mkdir(join(root, 'generated', backup));
  } } });
  assert.equal(foundBackup, false);
  assert.notEqual((await showView(root, 'manifest')).content, oldManifest);
  assert.equal((await showView(root, 'dashboard')).path, 'generated/dashboard.md');
  assert.equal((await readdir(join(root, 'generated'))).some(entry => entry.includes('.research-os-')), false);
});

test('show refuses mixed and uncommitted output generations throughout publication', async () => {
  const root = await makeProjectFixture();
  await buildViews(root);
  const before = await outputBytes(root);
  const projectPath = join(root, 'PROJECT.md');
  const project = parseMarkdownDocument(await readFile(projectPath, 'utf8'), projectPath);
  await writeFile(projectPath, serializeMarkdownDocument({ ...project.attributes, title: `${project.attributes.title} changed` }, project.body), 'utf8');
  const observations = [];
  await assert.rejects(() => buildViews(root, { hooks: {
    beforePublish: async ({ path }) => {
      try { await showView(root, 'dashboard'); observations.push({ path, readable: true }); }
      catch (error) { observations.push({ path, readable: false, code: error.code }); }
    },
    afterPublish: async ({ path, projectRoot }) => {
      try { await showView(root, 'dashboard'); observations.push({ path: `after:${path}`, readable: true }); }
      catch (error) { observations.push({ path: `after:${path}`, readable: false, code: error.code }); }
      if (path === 'generated/forecast.json') await writeFile(join(projectRoot, 'AGENTS.md'), '# Authority changed during publish\n', 'utf8');
    }
  } }), error => error.code === 'VALIDATION');
  assert.equal(observations.length > 0, true);
  assert.equal(observations.every(item => item.readable === false && ['RECORD_NOT_FOUND', 'VALIDATION'].includes(item.code)), true);
  assert.deepEqual(await outputBytes(root), before);
  assert.equal((await readdir(join(root, 'generated'))).some(entry => entry.includes('.research-os-')), false);
});

test('show validates the complete manifest and generated links encode every path segment', async () => {
  const root = await makeProjectFixture();
  const oldPlanPath = join(root, 'plans', 'active.md');
  const special = 'plans/active #?%() 中文.md';
  await rename(oldPlanPath, join(root, special));
  const projectPath = join(root, 'PROJECT.md');
  const project = parseMarkdownDocument(await readFile(projectPath, 'utf8'), projectPath);
  await writeFile(projectPath, serializeMarkdownDocument({ ...project.attributes, active_plan: special }, project.body), 'utf8');
  await buildViews(root);
  const dashboard = await readFile(join(root, 'generated', 'dashboard.md'), 'utf8');
  assert.match(dashboard, /\.\.\/plans\/active%20%23%3F%25%28%29%20%E4%B8%AD%E6%96%87\.md/);

  const manifestPath = join(root, 'generated', 'generation-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.inputs[0].sha256 = 'x'.repeat(64);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await assert.rejects(() => showView(root, 'dashboard'), error => error.code === 'VALIDATION');
});

test('show verifies the selected generated output hash', async () => {
  const root = await makeProjectFixture();
  await buildViews(root);
  const dashboardPath = join(root, 'generated', 'dashboard.md');
  await writeFile(dashboardPath, `${await readFile(dashboardPath, 'utf8')}\nTampered.\n`, 'utf8');
  await assert.rejects(() => showView(root, 'dashboard'), error => error.code === 'VALIDATION');
});

test('multiple Action reopen transitions create one exception and Dashboard renders confidence actions', async () => {
  const root = await makeProjectFixture();
  await configureSessionFixture(root, { objective: 'Resolve the reopened question.', plan: { writable_paths: ['generated/**'] } });
  await createRecord(root, 'driver', { id: 'RQ-031', title: 'Question', source: 'brief', question: 'What remains?' });
  await createRecord(root, 'action', { id: 'ACT-031', title: 'Reopened', driver: 'RQ-031', acceptance: 'Checked.', domain: 'unclassified', size: 'unestimated' });
  const definition = { candidate_version: 'v1', validation_plan: { tier: 'implementation', checks: [{ id: 'check', description: 'Evidence checked', max_attempts: 1 }] }, operation_scope: { operations: ['test'], paths: ['generated/**'], resources: [] } };
  await configureAction(root, 'ACT-031', definition);
  await approveActionScope(root, 'ACT-031', { grant_id: 'test', approver: 'fixture', reason: 'Fixture scope' });
  for (const status of ['defined', 'ready', 'in_progress']) await updateRecordStatus(root, 'ACT-031', status, { reason: status });
  await recordActionCheck(root, 'ACT-031', {check_id:'check', candidate_version:'v1', outcome:'pass', evidence:'Checked'});
  await updateRecordStatus(root, 'ACT-031', 'closed', { reason: 'closed', acceptedBy: 'fixture', verifiedAt: new Date().toISOString() });
  await updateRecordStatus(root, 'ACT-031', 'reopened', { reason: 'new evidence', affectedIds: ['ACT-031'] });
  await configureAction(root, 'ACT-031', {...definition, candidate_version:'v2', reason:'New evidence'});
  for (const status of ['defined', 'ready', 'in_progress']) await updateRecordStatus(root, 'ACT-031', status, { reason: `again-${status}` });
  await recordActionCheck(root, 'ACT-031', {check_id:'check', candidate_version:'v2', outcome:'pass', evidence:'Rechecked'});
  await updateRecordStatus(root, 'ACT-031', 'closed', { reason: 'closed again', acceptedBy: 'fixture', verifiedAt: new Date().toISOString() });
  await updateRecordStatus(root, 'ACT-031', 'reopened', { reason: 'more evidence', affectedIds: ['ACT-031'] });
  await buildViews(root);
  const exceptions = await readFile(join(root, 'generated', 'exception-inbox.md'), 'utf8');
  assert.equal((exceptions.match(/RECORD_REOPENED/gu) ?? []).length, 1);
  const dashboard = await readFile(join(root, 'generated', 'dashboard.md'), 'utf8');
  assert.match(dashboard, /Confidence actions/);
  assert.match(dashboard, /classify|size/iu);
});

test('show and forecast calculate read canonical authority with stable public results', async () => {
  const root = await makeProjectFixture();
  await buildViews(root);
  const shown = await showView(root, 'forecast');
  assert.deepEqual(Object.keys(shown), ['name', 'path', 'content']);
  assert.equal(shown.path, 'generated/forecast.json');
  assert.deepEqual(JSON.parse(shown.content), await calculateForecastForProject(root));
  await assert.rejects(() => showView(root, 'secret'), error => error.code === 'USAGE');
});

test('CLI view and forecast commands keep usage versus validation exit contracts', async () => {
  const root = await makeProjectFixture();
  const built = captureIo();
  assert.equal(await main(['view', 'build', '--project', root], built.io), 0);
  assert.equal(JSON.parse(built.output().stdout).files.length, 5);

  const shown = captureIo();
  assert.equal(await main(['view', 'show', '--project', root, '--name', 'dashboard'], shown.io), 0);
  assert.equal(JSON.parse(shown.output().stdout).name, 'dashboard');

  const invalidName = captureIo();
  assert.equal(await main(['view', 'show', '--project', root, '--name', 'unknown'], invalidName.io), 2);
  assert.match(invalidName.output().stderr, /^\[USAGE\]/);

  const calculated = captureIo();
  assert.equal(await main(['forecast', 'calculate', '--project', root], calculated.io), 0);
  assert.deepEqual(JSON.parse(calculated.output().stdout), await calculateForecastForProject(root));

  const projectPath = join(root, 'PROJECT.md');
  const project = parseMarkdownDocument(await readFile(projectPath, 'utf8'), projectPath);
  await writeFile(projectPath, serializeMarkdownDocument({ ...project.attributes, forecast_settings: null }, project.body), 'utf8');
  const invalid = captureIo();
  assert.equal(await main(['forecast', 'calculate', '--project', root], invalid.io), 3);
  assert.match(invalid.output().stderr, /^\[VALIDATION\]/);
});

test('generated directory contains only declared outputs unless user adds an unlisted file', async () => {
  const root = await makeProjectFixture();
  await buildViews(root);
  assert.deepEqual((await readdir(join(root, 'generated'))).sort(), GENERATED_FILES.map(path => path.replace('generated/', '')).sort());
});
