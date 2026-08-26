import { describe, expect, it } from 'vitest';

import {
  createPsqlChildEnvironment,
  redactPsqlError,
  validatePsqlEnvironment,
} from '../src/psql.js';

describe('validatePsqlEnvironment', () => {
  it('requires discrete libpq settings and never accepts a URL containing a password', () => {
    expect(() => validatePsqlEnvironment({})).toThrow('PGHOST is required');
    expect(() =>
      validatePsqlEnvironment({
        DATABASE_URL: 'postgresql://user:secret@example.invalid/db',
        PGDATABASE: 'db',
        PGHOST: 'example.invalid',
        PGUSER: 'user',
      }),
    ).toThrow('DATABASE_URL is not accepted');
  });

  it('accepts explicit libpq connection settings', () => {
    expect(
      validatePsqlEnvironment({
        PGDATABASE: 'better_agent',
        PGHOST: '127.0.0.1',
        PGPASSWORD: 'secret',
        PGPORT: '5432',
        PGSSLMODE: 'verify-full',
        PGUSER: 'migrator',
      }),
    ).toEqual({
      PGDATABASE: 'better_agent',
      PGHOST: '127.0.0.1',
      PGPASSWORD: 'secret',
      PGPORT: '5432',
      PGSSLMODE: 'verify-full',
      PGUSER: 'migrator',
    });
  });

  it('does not forward unapproved libpq variables to psql', () => {
    const childEnvironment = createPsqlChildEnvironment({
      PATH: 'test-path',
      PGDATABASE: 'better_agent',
      PGHOST: '127.0.0.1',
      PGHOSTADDR: 'attacker.invalid',
      PGOPTIONS: '-c search_path=shadow',
      PGPASSFILE: 'unexpected.pgpass',
      PGUSER: 'migrator',
    });

    expect(childEnvironment).toEqual({
      PATH: 'test-path',
      PGDATABASE: 'better_agent',
      PGHOST: '127.0.0.1',
      PGUSER: 'migrator',
    });
  });
});

describe('redactPsqlError', () => {
  it('redacts configured secrets while retaining actionable context', () => {
    expect(redactPsqlError('connection failed for secret-token', ['secret-token'])).toBe(
      'connection failed for [REDACTED]',
    );
  });
});
