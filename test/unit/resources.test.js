import assert from 'node:assert/strict';
import test from 'node:test';
import { assertApprovedCodeRoot, parseResourceRef, resolveResourceRef } from '../../src/project/resources.js';
import { resourceProject } from '../helpers/fixtures.js';

test('parseResourceRef separates a strict resource name from its relative path', () => {
  assert.deepEqual(parseResourceRef('experiment_results:EXP-001/run-01/metrics.json'), {
    resourceName: 'experiment_results',
    relativePath: 'EXP-001/run-01/metrics.json'
  });
});

test('resource references survive URI migration', () => {
  const ref = 'experiment_results:EXP-001/run-01/metrics.json';
  assert.equal(resolveResourceRef(resourceProject('/server/a'), ref).uri, '/server/a/EXP-001/run-01/metrics.json');
  assert.equal(resolveResourceRef(resourceProject('/server/b'), ref).uri, '/server/b/EXP-001/run-01/metrics.json');
});

test('resource resolver joins relative and SSH resource URIs without changing authority', () => {
  assert.equal(resolveResourceRef(resourceProject('../shared'), 'experiment_results:EXP-001/metrics.json').uri, '../shared/EXP-001/metrics.json');
  assert.equal(resolveResourceRef(resourceProject('/safe'), 'code:src/index.js').uri, 'ssh://research.example.org/worktrees/project/src/index.js');
});

test('resource resolver rejects traversal and URI-encoded traversal', () => {
  const project = resourceProject('/safe');
  for (const ref of ['experiment_results:../../outside', 'experiment_results:/outside', 'experiment_results:ok/../../outside', 'experiment_results:%2e%2e/outside', 'experiment_results:%2E%2E%2Foutside']) {
    assert.throws(() => resolveResourceRef(project, ref), error => error.code === 'RESOURCE_PATH_ESCAPE');
  }
});

test('resource resolver rejects traversal that is encoded beyond a fixed decode cap', () => {
  const project = resourceProject('/safe');
  const encodeRepeatedly = (value, times) => Array.from({ length: times }).reduce(encoded => encodeURIComponent(encoded), value);
  for (const path of ['../outside', '/outside']) {
    assert.throws(
      () => resolveResourceRef(project, `experiment_results:${encodeRepeatedly(path, 12)}`),
      error => error.code === 'RESOURCE_PATH_ESCAPE'
    );
  }
});

test('resource resolver rejects malformed, unknown, and invalidly configured resources', () => {
  const project = resourceProject('/safe');
  for (const ref of ['missing:run.json', 'Experiment:run.json', 'experiment_results:', 'experiment_results:one:two', 'experiment_results']) {
    assert.throws(() => resolveResourceRef(project, ref));
  }
  assert.throws(() => resolveResourceRef({ ...project, resources: { ...project.resources, broken: { uri: '/safe', role: 'result', access: 'write' } } }, 'broken:x'), error => error.code === 'RESOURCE_CONFIG');
});

test('approved code roots use exact resource-name membership', () => {
  const project = resourceProject('/safe', { approved_code_roots: ['code'] });
  assert.doesNotThrow(() => assertApprovedCodeRoot(project, 'code'));
  assert.throws(() => assertApprovedCodeRoot(project, 'code_backup'), error => error.code === 'CODE_ROOT_NOT_APPROVED');
  assert.throws(() => assertApprovedCodeRoot({ ...project, approved_code_roots: ['/safe/code'] }, 'code'), error => error.code === 'CODE_ROOT_NOT_APPROVED');
});
