export function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

export class ReadonlyMap {
  #values;

  constructor(entries = []) {
    this.#values = new Map(entries);
    Object.freeze(this);
  }

  get size() { return this.#values.size; }
  get(key) { return this.#values.get(key); }
  has(key) { return this.#values.has(key); }
  entries() { return this.#values.entries(); }
  keys() { return this.#values.keys(); }
  values() { return this.#values.values(); }
  forEach(callback, thisArg) {
    for (const [key, value] of this.#values) callback.call(thisArg, value, key, this);
  }
  [Symbol.iterator]() { return this.entries(); }
  get [Symbol.toStringTag]() { return 'ReadonlyMap'; }
  set() { throw new TypeError('ReadonlyMap cannot be mutated'); }
  delete() { throw new TypeError('ReadonlyMap cannot be mutated'); }
  clear() { throw new TypeError('ReadonlyMap cannot be mutated'); }
}

export class ReadonlySet {
  #values;

  constructor(values = []) {
    this.#values = new Set(values);
    Object.freeze(this);
  }

  get size() { return this.#values.size; }
  has(value) { return this.#values.has(value); }
  entries() { return this.#values.entries(); }
  keys() { return this.#values.keys(); }
  values() { return this.#values.values(); }
  forEach(callback, thisArg) {
    for (const value of this.#values) callback.call(thisArg, value, value, this);
  }
  [Symbol.iterator]() { return this.values(); }
  get [Symbol.toStringTag]() { return 'ReadonlySet'; }
  add() { throw new TypeError('ReadonlySet cannot be mutated'); }
  delete() { throw new TypeError('ReadonlySet cannot be mutated'); }
  clear() { throw new TypeError('ReadonlySet cannot be mutated'); }
}
