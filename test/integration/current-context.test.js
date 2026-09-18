import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { checkpointSession, getSessionContext } from '../../src/session/controller.js';
import { parseMarkdownDocument } from '../../src/lib/markdown.js';
import { configureSessionFixture, makeProjectFixture } from '../helpers/fixtures.js';

// A regression would put completed work back into every cold-start payload.
test('checkpoint history stays on disk while cold context contains only current work', async () => {
  const root = await makeProjectFixture();
  await configureSessionFixture(root);
  const update = {
    progress: ['Reviewed old observations. '.repeat(100)], artifacts: ['results/report.csv'],
    discoveries: ['Documented a resolved failure.'], decisions: ['Use the accepted input.'],
    resumePoint: { lastVerifiedPoint: 'Inputs checked.', nextAction: 'Evaluate the model.', nextCommandOrEdit: null,
      requiredFiles: ['plans/actions/ACT-001.md'], risks: [], reforecastTrigger: null }
  };
  await checkpointSession(root, update);
  const first = await getSessionContext(root);
  for (let i = 0; i < 8; i++) await checkpointSession(root, { ...update, progress: [`Historical step ${i}: ${update.progress[0]}`] });
  const current = await getSessionContext(root);
  const plan = parseMarkdownDocument(await readFile(join(root, 'plans/active.md'), 'utf8'));
  assert.equal(Object.hasOwn(plan.attributes, 'progress'), false);
  assert.equal(Object.hasOwn(plan.attributes, 'objective'), false);
  assert.equal(Object.hasOwn(plan.attributes, 'current_step'), false);
  assert.equal(current.nextAction, 'Evaluate the model.');
  assert.equal(JSON.stringify(current).includes('Historical step'), false);
  assert.ok(JSON.stringify(current).length <= JSON.stringify(first).length + 50);
  const files = await readdir(join(root, 'plans/logs'));
  assert.equal(files.length, 9);
  const saved = await Promise.all(files.map(file => readFile(join(root, 'plans/logs', file), 'utf8')));
  assert.ok(saved.some(text => text.includes('Historical step 0')));
  assert.ok(saved.some(text => text.includes('Documented a resolved failure.')));
  assert.equal(current.latestCheckpoint, plan.attributes.latest_checkpoint);
});
