import { ReleaseCoreError } from './errors.js';

const maximumDepth = 256;

function fail(path: string, reason: string): never {
  throw new ReleaseCoreError('RELEASE_CANONICALIZATION_INVALID', path, reason);
}

function assertIJsonString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) {
        fail(path, 'string contains an unpaired high surrogate');
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      fail(path, 'string contains an unpaired low surrogate');
    }
  }
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function readDataProperty(
  owner: object,
  key: string,
  path: string,
): PropertyDescriptor & { value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !('value' in descriptor) ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  ) {
    fail(path, 'canonical JSON accepts enumerable data properties only');
  }
  return descriptor as PropertyDescriptor & { value: unknown };
}

function serialize(
  value: unknown,
  path: string,
  depth: number,
  active: Set<object>,
  excludedRootKeys: ReadonlySet<string>,
): string {
  if (depth > maximumDepth) fail(path, 'canonical JSON nesting exceeds the depth limit');
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'numbers must be finite I-JSON values');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    assertIJsonString(value, path);
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') fail(path, 'value is not representable as JSON');

  if (active.has(value)) fail(path, 'cyclic values are not canonical JSON');
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      for (const key of ownKeys) {
        if (typeof key !== 'string') fail(path, 'symbol properties are not canonical JSON');
        if (key === 'length') continue;
        if (!isArrayIndex(key, value.length)) fail(path, 'arrays cannot have extra properties');
      }

      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) fail(`${path}[${index}]`, 'sparse arrays are forbidden');
        const descriptor = readDataProperty(value, String(index), `${path}[${index}]`);
        items.push(
          serialize(descriptor.value, `${path}[${index}]`, depth + 1, active, excludedRootKeys),
        );
      }
      return `[${items.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(path, 'only plain objects are canonical JSON containers');
    }

    const keys: string[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') fail(path, 'symbol properties are not canonical JSON');
      if (depth === 0 && excludedRootKeys.has(key)) continue;
      assertIJsonString(key, `${path}.[key]`);
      readDataProperty(value, key, `${path}.${key}`);
      keys.push(key);
    }
    keys.sort();

    return `{${keys
      .map((key) => {
        const descriptor = readDataProperty(value, key, `${path}.${key}`);
        return `${JSON.stringify(key)}:${serialize(
          descriptor.value,
          `${path}.${key}`,
          depth + 1,
          active,
          excludedRootKeys,
        )}`;
      })
      .join(',')}}`;
  } finally {
    active.delete(value);
  }
}

function validateExcludedRootKeys(keys: readonly string[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const key of keys) {
    if (key.length === 0 || result.has(key)) {
      throw new ReleaseCoreError(
        'RELEASE_HASH_PROFILE_INVALID',
        '$',
        'excluded root keys must be unique non-empty strings',
      );
    }
    assertIJsonString(key, '$.[excluded-key]');
    result.add(key);
  }
  return result;
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(serialize(value, '$', 0, new Set(), new Set()), 'utf8');
}

export function canonicalJsonBytesExcludingRootKeys(
  value: unknown,
  excludedRootKeys: readonly string[],
): Buffer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReleaseCoreError(
      'RELEASE_HASH_PROFILE_INVALID',
      '$',
      'root-key exclusion requires a JSON object',
    );
  }
  return Buffer.from(
    serialize(value, '$', 0, new Set(), validateExcludedRootKeys(excludedRootKeys)),
    'utf8',
  );
}
