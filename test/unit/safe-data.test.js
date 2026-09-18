import assert from 'node:assert/strict';
import test from 'node:test';
import { ResearchOSError } from '../../src/lib/errors.js';
import { safeDataClone } from '../../src/lib/safe-data.js';

function rejects(value) {
  assert.throws(() => safeDataClone(value), error => error instanceof ResearchOSError && error.code === 'VALIDATION');
}

test('safeDataClone preserves exact JSON data and shared references', () => {
  const shared = { value: 1 };
  const input = { text: 'x', truth: true, nothing: null, items: [shared, shared] };
  const output = safeDataClone(input);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  assert.equal(output.items[0], output.items[1]);
  assert.equal(input.items[0], input.items[1]);
});

test('safeDataClone rejects sparse and decorated arrays instead of normalizing them', () => {
  const sparse = ['x']; sparse.length = 2;
  const extra = ['x']; extra.note = 'hidden authority';
  const nonenumerable = ['x']; Object.defineProperty(nonenumerable, '0', { value: 'x', enumerable: false });
  for (const value of [sparse, extra, nonenumerable]) rejects(value);
});

test('safeDataClone rejects every non-JSON own property and value', () => {
  const hidden = { visible: true }; Object.defineProperty(hidden, 'hidden', { value: 1, enumerable: false });
  const symbolKey = { visible: true }; symbolKey[Symbol('key')] = 1;
  for (const value of [
    hidden, symbolKey, { value: undefined }, { value: Infinity }, { value: -Infinity }, { value: NaN }, { value: -0 },
    { value: Symbol('value') }, { value: 1n }, { value() {} }
  ]) rejects(value);
});

test('safeDataClone rejects getters, proxies and cycles without executing attacker code', () => {
  let hits = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'value', { enumerable: true, get() { hits += 1; return 1; } });
  const cycle = {}; cycle.self = cycle;
  for (const value of [accessor, new Proxy({}, {}), cycle]) rejects(value);
  assert.equal(hits, 0);
});
