import assert from 'node:assert/strict';
import test from 'node:test';
import { main } from '../../src/cli.js';
import { checkWriteScope, isWriteScopeContained } from '../../src/session/write-scope.js';
import { captureIo } from '../helpers/fixtures.js';

test('unauthorized background diff cannot be accepted', () => {
  const report = checkWriteScope(
    { writablePaths: ['generated/audit/**'] },
    ['evidence/CLM-001.md']
  );
  assert.equal(report.ok, false);
  assert.equal(report.violations[0].code, 'WRITE_SCOPE_VIOLATION');
  assert.deepEqual(report.allowed, []);
  assert.equal(Object.isFrozen(report), true);
  assert.throws(() => report.violations.push({}), TypeError);
});

test('write scope accepts only deterministic project-relative glob matches', () => {
  const report = checkWriteScope(
    { writablePaths: ['generated/audit/**', 'evidence/*.md'] },
    ['evidence/EVD-001.md', 'generated/audit/nested/report.md', 'generated/audit/a.md', 'evidence/nested/EVD-002.md']
  );
  assert.equal(report.ok, false);
  assert.deepEqual(report.allowed, ['evidence/EVD-001.md', 'generated/audit/a.md', 'generated/audit/nested/report.md']);
  assert.deepEqual(report.violations, [{
    code: 'WRITE_SCOPE_VIOLATION', path: 'evidence/nested/EVD-002.md', reason: 'PATH_NOT_AUTHORIZED'
  }]);
});

test('write scope rejects traversal, encoded traversal, backslashes, absolute paths, and malformed patterns', () => {
  const invalidPaths = ['../outside.md', '%2e%2e/outside.md', 'nested\\outside.md', '/tmp/outside.md', '.', ''];
  const report = checkWriteScope({ writablePaths: ['generated/**'] }, invalidPaths);
  assert.equal(report.ok, false);
  assert.deepEqual(report.allowed, []);
  assert.equal(report.violations.length, invalidPaths.length);
  assert.equal(report.violations.every(item => item.code === 'WRITE_SCOPE_VIOLATION' && item.reason === 'INVALID_PROJECT_RELATIVE_PATH'), true);
  assert.throws(() => checkWriteScope({ writablePaths: ['generated/**/bad**'] }, ['generated/a.md']), error => error.code === 'USAGE');
  assert.throws(() => checkWriteScope({ writablePaths: ['generated/?.md'] }, ['generated/a.md']), error => error.code === 'USAGE');
});

test('write scope rejects traversal encoded beyond a fixed decoding depth', () => {
  const encoded = Array.from({ length: 20 }).reduce(value => encodeURIComponent(value), '../outside.md');
  const report = checkWriteScope({ writablePaths: ['generated/**'] }, [encoded]);
  assert.deepEqual(report.violations, [{
    code: 'WRITE_SCOPE_VIOLATION', path: encoded, reason: 'INVALID_PROJECT_RELATIVE_PATH'
  }]);
});

test('sensitive control files require an exact named grant', () => {
  const denied = checkWriteScope(
    { writablePaths: ['*.md', 'plans/**'], controlPaths: ['PROJECT.md', 'plans/active.md'] },
    ['PROJECT.md', 'plans/active.md']
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.violations.every(item => item.reason === 'SENSITIVE_CONTROL_FILE_REQUIRES_EXACT_GRANT'), true);

  const allowed = checkWriteScope(
    { writablePaths: ['PROJECT.md', 'plans/active.md'], controlPaths: ['PROJECT.md', 'plans/active.md'] },
    ['PROJECT.md', 'plans/active.md']
  );
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.allowed, ['PROJECT.md', 'plans/active.md']);
});

test('scope containment proves only safe exact, star, and prefix-glob subsets', () => {
  const controls = ['PROJECT.md', 'plans/active.md'];
  assert.equal(isWriteScopeContained(['plans/actions/ACT-001.md'], ['plans/actions/ACT-001.md'], controls), true);
  assert.equal(isWriteScopeContained(['generated/**'], ['generated/a/*.md'], controls), true);
  assert.equal(isWriteScopeContained(['generated/*/report.md'], ['generated/a/report.md'], controls), true);
  assert.equal(isWriteScopeContained(['evidence/*.md'], ['evidence/EVD-001.md'], controls), true);
  assert.equal(isWriteScopeContained(['generated/a/**'], ['generated/b/report.md'], controls), false);
  assert.equal(isWriteScopeContained(['generated/*/report.md'], ['generated/*/*.md'], controls), false);
  assert.equal(isWriteScopeContained(['**'], ['PROJECT.md'], controls), false);
  assert.equal(isWriteScopeContained(['plans/**'], ['plans/active.md'], controls), false);
  assert.equal(isWriteScopeContained(['PROJECT.md', 'plans/active.md'], ['PROJECT.md', 'plans/active.md'], controls), true);
});

test('session check-diff CLI returns normalized JSON and validation status', async () => {
  const registration = JSON.stringify({ writablePaths: ['generated/audit/**'] });
  const allowed = captureIo();
  assert.equal(await main([
    'session', 'check-diff', '--registration', registration, '--changed-paths', '["generated/audit/report.md"]'
  ], allowed.io), 0);
  assert.deepEqual(JSON.parse(allowed.output().stdout), {
    ok: true, allowed: ['generated/audit/report.md'], violations: []
  });

  const blocked = captureIo();
  assert.equal(await main([
    'session', 'check-diff', '--registration', registration, '--changed-paths', '["PROJECT.md"]'
  ], blocked.io), 3);
  assert.equal(JSON.parse(blocked.output().stdout).violations[0].code, 'WRITE_SCOPE_VIOLATION');

  for (const args of [
    ['check-diff', '--registration', registration],
    ['check-diff', '--registration', '[]', '--changed-paths', '[]'],
    ['check-diff', '--registration', registration, '--changed-paths', '{}'],
    ['check-diff', '--registration', registration, '--changed-paths', '[]', '--extra', 'x']
  ]) {
    const invalid = captureIo();
    assert.equal(await main(['session', ...args], invalid.io), 2);
    assert.match(invalid.output().stderr, /^\[USAGE\]/);
  }
});
