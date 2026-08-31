import { describe, expect, it } from 'vitest';

import { readPostgresInstantMicroseconds } from '../src/index.js';

describe('PostgreSQL instant parsing', () => {
  it.each(['2026-02-29T00:00:00Z', '2026-02-30T00:00:00Z', '2026-04-31T00:00:00Z'])(
    'rejects normalized invalid calendar date %s',
    (value) => {
      expect(() => readPostgresInstantMicroseconds(value, '$.instant')).toThrowError(
        /RUN_STATE_INVALID/,
      );
    },
  );

  it('preserves legal leap days, offsets, and PostgreSQL microsecond fractions', () => {
    expect(readPostgresInstantMicroseconds('0001-01-01T00:00:00Z', '$.minimum-year')).toBeTypeOf(
      'bigint',
    );
    expect(readPostgresInstantMicroseconds('2028-02-29T01:02:03.123456+08:00', '$.left')).toBe(
      readPostgresInstantMicroseconds('2028-02-28T17:02:03.123456Z', '$.right'),
    );
    expect(readPostgresInstantMicroseconds('2028-02-29T01:02:03.123457+08:00', '$.later')).toBe(
      readPostgresInstantMicroseconds('2028-02-28T17:02:03.123456Z', '$.earlier') + 1n,
    );
  });

  it.each(['0000-01-01T00:00:00Z', '2026-01-01T00:00:00.0000001Z', '2026-01-01T00:00:00+16:00'])(
    'rejects PostgreSQL-incompatible precision or offset %s',
    (value) => {
      expect(() => readPostgresInstantMicroseconds(value, '$.instant')).toThrowError(
        /RUN_STATE_INVALID/,
      );
    },
  );
});
