import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { main } from '../../src/cli.js';
import { parseMarkdownDocument } from '../../src/lib/markdown.js';
import { renderTemplate } from '../../src/core/render.js';
import { captureIo, makeTempDir } from '../helpers/fixtures.js';
import { initProject } from '../../src/project/project.js';

const globalIndexModule = await import('../../src/project/global-index.js').catch(() => ({}));
const upsertGlobalProject = globalIndexModule.upsertGlobalProject ?? (async () => {
  throw new Error('Global index module is not available');
});
const renderGlobalIndexBody = globalIndexModule.renderGlobalIndexBody ?? (() => '');

const coreRoot = join(process.cwd(), 'core');

function tableLines(body) {
  return body.split('\n').filter(line => line.startsWith('|'));
}

function columnCount(line) {
  return line.split('|').length - 2;
}

test('global index templates and rendered tables keep all seven columns aligned', async () => {
  const template = parseMarkdownDocument(renderTemplate(await readFile(join(coreRoot, 'templates/global/PROJECTS.md'), 'utf8'), {
    CORE_VERSION: '2.0.0', DATE: '2026-08-03T00:00:00.000Z'
  }), 'PROJECTS.md');
  const project = {
    project_id: 'PRJ-1', title: 'Demo', stage: 'research', status: 'defined', next_milestone: 'Validate', project_uri: '/vault/demo', updated: '2026-08-03T00:00:00.000Z'
  };
  for (const body of [template.body, renderGlobalIndexBody([]), renderGlobalIndexBody([project])]) {
    const lines = tableLines(body);
    assert.equal(lines[0], '| Project ID | Title | Stage | Status | Next milestone | Vault entry | Updated |');
    assert.equal(lines.length, body === renderGlobalIndexBody([project]) ? 3 : 2);
    assert.deepEqual(lines.map(columnCount), Array(lines.length).fill(7));
  }
});

test('CLI creates a canonical global index and derives its project summary', async () => {
  const projectRoot = await makeTempDir();
  const indexPath = join(await makeTempDir(), 'PROJECTS.md');
  await initProject({ targetDir: projectRoot, projectId: 'demo', title: 'Demo', stage: 'research', coreRoot });

  const added = captureIo();
  assert.equal(await main(['project', 'index', 'add', '--index', indexPath, '--project', projectRoot, '--next-milestone', 'Validate baseline'], added.io), 0);
  const summary = JSON.parse(added.output().stdout);
  assert.deepEqual(Object.keys(summary).sort(), ['next_milestone', 'project_id', 'project_uri', 'stage', 'status', 'title', 'updated']);
  assert.equal(summary.project_id, 'demo');
  assert.equal(summary.project_uri, projectRoot);

  const index = parseMarkdownDocument(await readFile(indexPath, 'utf8'), indexPath);
  assert.deepEqual(index.attributes.projects, [summary]);
  assert.equal(index.attributes.type, 'project_index');
  assert.match(index.body, /^\| Project ID \| Title \| Stage \| Status \| Next milestone \| Vault entry \| Updated \|$/m);
});

test('global index upsert replaces by project id, sorts, rejects non-summary fields, and renders safe table cells', async () => {
  const indexPath = join(await makeTempDir(), 'PROJECTS.md');
  const base = {
    title: 'Demo', stage: 'research', status: 'defined', next_milestone: 'Validate', project_uri: '/vault/demo', updated: '2026-08-03T00:00:00.000Z'
  };
  await upsertGlobalProject(indexPath, { ...base, project_id: 'PRJ-2' });
  await upsertGlobalProject(indexPath, { ...base, project_id: 'PRJ-1', title: 'Pipe | title\nSecond', next_milestone: 'Plan | validate\nthen record' });
  await upsertGlobalProject(indexPath, { ...base, project_id: 'PRJ-1', title: 'Replaced | title\nSecond', next_milestone: 'Repair | validate\nthen record' });

  const document = parseMarkdownDocument(await readFile(indexPath, 'utf8'), indexPath);
  assert.deepEqual(document.attributes.projects.map(project => project.project_id), ['PRJ-1', 'PRJ-2']);
  assert.equal(document.attributes.projects[0].title, 'Replaced | title\nSecond');
  assert.match(document.body, /Replaced \\| title<br>Second/);
  assert.match(document.body, /Repair \\| validate<br>then record/);
  assert.equal((document.body.match(/^\| PRJ-1 \|/gm) ?? []).length, 1);

  await assert.rejects(() => upsertGlobalProject(indexPath, { ...base, project_id: 'PRJ-3', task_count: 2 }), error => error.code === 'GLOBAL_INDEX_FIELD');
  await assert.rejects(() => upsertGlobalProject(indexPath, { ...base, project_id: 'PRJ-3', reviewer_content: 'Do not store' }), error => error.code === 'GLOBAL_INDEX_FIELD');
  const { updated, ...missingUpdated } = { ...base, project_id: 'PRJ-3' };
  await assert.rejects(() => upsertGlobalProject(indexPath, missingUpdated), error => error.code === 'GLOBAL_INDEX_FIELD');
});

test('CLI index list and option validation have deterministic boundaries', async () => {
  const projectRoot = await makeTempDir();
  const indexPath = join(await makeTempDir(), 'PROJECTS.md');
  await initProject({ targetDir: projectRoot, projectId: 'demo', title: 'Demo', stage: 'research', coreRoot });
  const configured = captureIo();
  assert.equal(await main(['project', 'index', 'add', '--index', indexPath, '--project', projectRoot, '--next-milestone', 'Validate'], configured.io), 0);

  const listed = captureIo();
  assert.equal(await main(['project', 'index', 'list', '--index', indexPath], listed.io), 0);
  assert.deepEqual(JSON.parse(listed.output().stdout).map(project => project.project_id), ['demo']);

  for (const args of [
    ['project', 'index', 'add', '--index', indexPath, '--project', projectRoot],
    ['project', 'index', 'add', '--index', indexPath, '--project', projectRoot, '--next-milestone', 'one\ntwo'],
    ['project', 'index', 'list', '--index', indexPath, '--project', projectRoot]
  ]) {
    const invalid = captureIo();
    assert.equal(await main(args, invalid.io), 2);
    assert.match(invalid.output().stderr, /^\[USAGE\]/);
  }
});
