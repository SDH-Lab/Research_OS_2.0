import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { checkpointRepositoryStatus } from '../../src/session/repository-status.js';
import { makeTempDir } from '../helpers/fixtures.js';

test('checkpoint Git advice includes new records and history but excludes rebuildable views', async () => {
  const root = await makeTempDir();
  await promisify(execFile)('git', ['init', root]);
  await mkdir(join(root, 'plans/logs'), { recursive: true });
  await mkdir(join(root, 'generated'), { recursive: true });
  await writeFile(join(root, 'PROJECT.md'), 'Current objective');
  await writeFile(join(root, 'plans/logs/checkpoint.json'), '{}');
  await writeFile(join(root, 'generated/dashboard.md'), 'Derived');
  const status = await checkpointRepositoryStatus(root);
  assert.equal(status.applicable, true);
  assert.deepEqual(status.uncommittedRecords.sort(), ['PROJECT.md', 'plans/logs/checkpoint.json']);
  assert.match(status.message, /commit/u);
});
