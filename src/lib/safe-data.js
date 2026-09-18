import { types } from 'node:util';
import { ResearchOSError } from './errors.js';

function fail(message) {
  throw new ResearchOSError('VALIDATION', `Input is not safely readable: ${message}`);
}

function cloneData(value, visiting, memo, location, allowNonCanonicalNumbers) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number') {
    if (!allowNonCanonicalNumbers && (!Number.isFinite(value) || Object.is(value, -0))) fail(`${location} contains a non-finite or non-canonical JSON number`);
    return value;
  }
  if (typeof value !== 'object') fail(`${location} contains unsupported ${typeof value} data`);
  if (types.isProxy(value)) fail(`${location} is a Proxy`);
  if (visiting.has(value)) fail(`${location} contains a cycle`);
  if (memo.has(value)) return memo.get(value);
  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    fail(`${location} must contain only plain objects and arrays`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (array) {
    for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(descriptors, String(index))) fail(`${location} contains a sparse array hole`);
    const expected = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))]);
    if (keys.some(key => !expected.has(key))) fail(`${location} contains an extra array property`);
  }
  for (const key of keys) {
    if (typeof key === 'symbol') fail(`${location} contains a symbol property`);
    const descriptor = descriptors[key];
    if (array && key === 'length') continue;
    if (!descriptor.enumerable) fail(`${location}.${key} is a non-enumerable property`);
    if (descriptor.get || descriptor.set || !Object.hasOwn(descriptor, 'value')) fail(`${location}.${key} is an accessor property`);
  }
  const output = array ? new Array(value.length) : {};
  memo.set(value, output);
  visiting.add(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (array && key === 'length') continue;
    if (!array && ['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${location} contains unsafe key ${key}`);
    Object.defineProperty(output, key, {
      value: cloneData(descriptor.value, visiting, memo, `${location}.${key}`, allowNonCanonicalNumbers),
      enumerable: true, writable: true, configurable: true
    });
  }
  visiting.delete(value);
  return output;
}

/** Clone exact JSON authority without executing accessors or Proxy traps. */
export function safeDataClone(value, location = 'value', options = {}) {
  try {
    return cloneData(value, new Set(), new WeakMap(), location, options.allowNonCanonicalNumbers === true);
  } catch (error) {
    if (error instanceof ResearchOSError) throw error;
    throw new ResearchOSError('VALIDATION', `Input is not safely readable: ${location}: ${error.message}`);
  }
}

/** Read own data properties from a plain top-level object without invoking accessors. */
export function safeOwnDataProperties(value, required = [], location = 'value', allowed = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) fail(`${location} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${location} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowedKeys = allowed === null ? null : new Set(allowed);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') fail(`${location} contains a symbol property`);
    if (!descriptors[key].enumerable) fail(`${location}.${key} is a non-enumerable property`);
    if (descriptors[key].get || descriptors[key].set || !Object.hasOwn(descriptors[key], 'value')) fail(`${location}.${key} is an accessor property`);
    if (allowedKeys && !allowedKeys.has(key)) fail(`${location}.${key} is not an allowed property`);
  }
  for (const key of required) if (!Object.hasOwn(descriptors, key)) fail(`${location}.${key} is required`);
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
