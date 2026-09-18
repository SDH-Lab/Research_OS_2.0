import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ResearchOSError } from '../../src/lib/errors.js';
import { readUtf8, safeJoin, walkFiles, writeUtf8Atomic } from '../../src/lib/fs.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../../src/lib/markdown.js';
import { makeTempDir } from '../helpers/fixtures.js';

test('frontmatter round trip preserves attributes and body', () => {
  const source = '---\ntype: action\nid: ACT-001\nlinks:\n  - RQ-001\n---\n# Action\n\nBody.\n';
  const parsed = parseMarkdownDocument(source, 'action.md');
  assert.equal(parsed.attributes.id, 'ACT-001');
  assert.equal(parseMarkdownDocument(serializeMarkdownDocument(parsed.attributes, parsed.body), 'out.md').body, parsed.body);
});

test('frontmatter parser rejects invalid boundaries, duplicate keys, and non-object values', () => {
  assert.throws(() => parseMarkdownDocument('type: action\n', 'no-frontmatter.md'), error => error instanceof ResearchOSError && error.code === 'FRONTMATTER_BOUNDARY');
  assert.throws(() => parseMarkdownDocument('---\nid: ACT-001\nid: ACT-002\n---\nBody\n', 'duplicate.md'), error => error instanceof ResearchOSError && error.code === 'FRONTMATTER_YAML');
  assert.throws(() => parseMarkdownDocument('---\n- action\n---\nBody\n', 'array.md'), error => error instanceof ResearchOSError && error.code === 'FRONTMATTER_OBJECT');
});

test('markdown serialization keeps a stable key order and one terminal body newline', () => {
  const output = serializeMarkdownDocument({ zeta: true, id: 'ACT-001', alpha: 'first' }, 'Body.\n\n');
  assert.equal(output, '---\nalpha: first\nid: ACT-001\nzeta: true\n---\nBody.\n');
});

test('safeJoin rejects paths outside its root', () => {
  assert.equal(safeJoin('/tmp/research-os', 'plans/active.md'), '/tmp/research-os/plans/active.md');
  assert.throws(() => safeJoin('/tmp/research-os', '../outside.md'), error => error instanceof ResearchOSError && error.code === 'PATH_OUTSIDE_ROOT');
  assert.throws(() => safeJoin('/tmp/research-os', '/tmp/outside.md'), error => error instanceof ResearchOSError && error.code === 'PATH_OUTSIDE_ROOT');
});

test('safeJoin blocks a symlink escape before reading an external file', async () => {
  const root = await makeTempDir();
  const outside = await makeTempDir();
  await writeFile(join(outside, 'secret.md'), 'outside data', 'utf8');
  await symlink(outside, join(root, 'escape'));
  await assert.rejects(async () => readUtf8(safeJoin(root, 'escape/secret.md')), error => error instanceof ResearchOSError && error.code === 'PATH_OUTSIDE_ROOT');
});

test('safeJoin blocks a symlink escape before atomically writing an external file', async () => {
  const root = await makeTempDir();
  const outside = await makeTempDir();
  await writeFile(join(outside, 'secret.md'), 'outside data', 'utf8');
  await symlink(outside, join(root, 'escape'));
  await assert.rejects(async () => writeUtf8Atomic(safeJoin(root, 'escape/secret.md'), 'changed'), error => error instanceof ResearchOSError && error.code === 'PATH_OUTSIDE_ROOT');
  assert.equal(await readFile(join(outside, 'secret.md'), 'utf8'), 'outside data');
});

test('atomic writes replace a file and deterministic walking returns sorted relative paths', async () => {
  const root = await makeTempDir();
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'z.md'), 'old', 'utf8');
  await writeFile(join(root, 'nested', 'a.md'), 'nested', 'utf8');
  await writeUtf8Atomic(join(root, 'z.md'), 'new');
  assert.equal(await readFile(join(root, 'z.md'), 'utf8'), 'new');
  assert.deepEqual(await walkFiles(root), ['nested/a.md', 'z.md']);
});
