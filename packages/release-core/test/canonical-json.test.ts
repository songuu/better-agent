import { describe, expect, it } from 'vitest';

import {
  canonicalJsonBytes,
  canonicalSha256,
  canonicalSha256ExcludingRootKeys,
  ReleaseCoreError,
} from '../src/index.js';

describe('RFC 8785 canonical JSON profile', () => {
  it('uses deterministic object ordering and a fixed independent digest vector', () => {
    const left = { b: 1, a: 2 };
    const right = { a: 2, b: 1 };

    expect(canonicalJsonBytes(left).toString('utf8')).toBe('{"a":2,"b":1}');
    expect(canonicalJsonBytes(right)).toEqual(canonicalJsonBytes(left));
    expect(canonicalSha256(left)).toBe(
      'sha256:d3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772',
    );
  });

  it('uses ECMAScript number serialization required by JCS', () => {
    const value = {
      numbers: [Number('333333333.33333329'), 1e30, 4.5, 0.002, 1e-27],
      literals: [null, true, false],
    };

    expect(canonicalJsonBytes(value).toString('utf8')).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}',
    );
    expect(canonicalSha256(value)).toBe(
      'sha256:f9ef8430c38ca3edd7fb96a698d14fdf39c74c63299627162d38b59af2af5abb',
    );
  });

  it('preserves array order unless a caller explicitly normalizes a semantic set', () => {
    expect(canonicalSha256({ values: ['a', 'b'] })).not.toBe(
      canonicalSha256({ values: ['b', 'a'] }),
    );
  });

  it('can exclude declared root hash fields without mutating the input', () => {
    const value = Object.freeze({ b: 1, contract_hash: 'self', a: 2 });

    expect(canonicalSha256ExcludingRootKeys(value, ['contract_hash'])).toBe(
      canonicalSha256({ a: 2, b: 1 }),
    );
    expect(value).toEqual({ b: 1, contract_hash: 'self', a: 2 });
  });

  it.each([
    ['undefined', { value: undefined }],
    ['non-finite number', { value: Number.NaN }],
    ['sparse array', Array(1)],
    ['date object', { value: new Date(0) }],
    ['unpaired surrogate', { value: '\ud800' }],
  ])('rejects non-I-JSON input: %s', (_label, input) => {
    expect(() => canonicalJsonBytes(input)).toThrow(ReleaseCoreError);
  });

  it('rejects cycles and accessor properties without invoking them', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalJsonBytes(cyclic)).toThrow(ReleaseCoreError);

    let invoked = false;
    const accessor = {};
    Object.defineProperty(accessor, 'secret', {
      enumerable: true,
      get: () => {
        invoked = true;
        return 'secret';
      },
    });
    expect(() => canonicalJsonBytes(accessor)).toThrow(ReleaseCoreError);
    expect(invoked).toBe(false);
  });
});
