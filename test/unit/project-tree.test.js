import assert from 'node:assert/strict';
import test from 'node:test';
import { PROJECT_INTERNAL_DIRECTORIES, isProjectInternalDirectory } from '../../src/lib/project-tree.js';

test('catalog discovery and source snapshots share one explicit internal-directory contract', () => {
  assert.deepEqual([...PROJECT_INTERNAL_DIRECTORIES], [
    '.agents', '.codex', '.git', '.obsidian', '.superpowers', '.tmp', 'generated', 'node_modules'
  ]);
  for (const name of PROJECT_INTERNAL_DIRECTORIES) assert.equal(isProjectInternalDirectory(name), true);
  assert.equal(isProjectInternalDirectory('plans'), false);
});
