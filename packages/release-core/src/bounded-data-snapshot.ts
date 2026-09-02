import { types } from 'node:util';

import { ReleaseCoreError } from './errors.js';

function isScalarText(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === 0 ||
      (codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return false;
    }
  }
  return true;
}

/** Bound before schema parsing/JCS so hostile input cannot allocate an unbounded encoding. */
export function boundedDataSnapshot(
  input: unknown,
  profile: 'identity' | 'policy' | 'graph',
): unknown {
  const policy = profile === 'policy';
  const graph = profile === 'graph';
  const maximumArrayLength = graph ? 1_024 : 128;
  function invalid(path: string, reason: string): never {
    throw new ReleaseCoreError(
      graph
        ? 'CAPABILITY_GRAPH_INPUT_INVALID'
        : policy
          ? 'CLOSURE_POLICY_INPUT_INVALID'
          : 'CLOSURE_IDENTITY_INPUT_INVALID',
      path,
      reason,
    );
  }
  function limit(path: string, reason: string): never {
    throw new ReleaseCoreError(
      graph
        ? 'CAPABILITY_CLOSURE_LIMIT_EXCEEDED'
        : policy
          ? 'CLOSURE_POLICY_LIMIT_EXCEEDED'
          : 'CLOSURE_IDENTITY_LIMIT_EXCEEDED',
      path,
      reason,
    );
  }
  let remainingBytes = graph ? 8_388_608 : 1_048_576;
  let remainingNodes = graph ? 131_072 : policy ? 32_768 : 8_192;
  const active = new Set<object>();

  function visit(value: unknown, path: string, depth: number): unknown {
    remainingNodes -= 1;
    if (depth > (policy || graph ? 12 : 8) || remainingNodes < 0)
      limit(path, 'input structure exceeds its budget');
    if (typeof value === 'string') {
      if (value.length > 4_096) limit(path, 'input string exceeds byte limit');
      const bytes = Buffer.byteLength(value, 'utf8');
      remainingBytes -= bytes;
      if (bytes > 4_096 || remainingBytes < 0) {
        limit(path, 'input string data exceeds byte budget');
      }
      if (!isScalarText(value)) {
        invalid(path, 'input text must contain Unicode scalar values without NUL');
      }
      return value;
    }
    if (policy && typeof value === 'boolean') return value;
    if (policy && typeof value === 'number' && Number.isFinite(value))
      return value === 0 ? 0 : value;
    if (typeof value !== 'object' || value === null) {
      invalid(path, 'input accepts data objects, arrays and strings only');
    }
    if (types.isProxy(value)) invalid(path, 'input proxies are forbidden');
    if (active.has(value)) invalid(path, 'cyclic input is forbidden');
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) {
      invalid(path, 'input containers must be plain objects');
    }
    if (array && value.length > maximumArrayLength)
      limit(path, 'input array exceeds its entry budget');
    const keys = Reflect.ownKeys(value);
    if (keys.length > (array ? maximumArrayLength + 1 : policy ? 20 : 12)) {
      limit(path, 'input container has too many properties');
    }
    const copy: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    active.add(value);
    try {
      for (const key of keys) {
        if (array && key === 'length') continue;
        if (typeof key !== 'string' || key.length > 64) invalid(path, 'invalid input key');
        if (
          array &&
          (!/^(?:0|[1-9][0-9]*)$/u.test(key) ||
            !Number.isSafeInteger(Number(key)) ||
            Number(key) >= value.length)
        ) {
          invalid(path, 'array properties must be consecutive indices');
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          invalid(path, 'input accepts enumerable data properties only');
        }
        Object.defineProperty(copy, key, {
          value: visit(descriptor.value, `${path}.${key}`, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      if (array && keys.length !== value.length + 1) invalid(path, 'sparse arrays are forbidden');
      return copy;
    } finally {
      active.delete(value);
    }
  }

  return visit(input, '$', 0);
}
