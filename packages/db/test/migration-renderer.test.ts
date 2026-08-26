import { describe, expect, it } from 'vitest';

import {
  type Migration,
  renderDownMigrationSql,
  renderMigrationStatusSql,
  renderUpMigrationSql,
} from '../src/index.js';

const migrations: readonly Migration[] = [
  {
    checksum: 'a'.repeat(64),
    downChecksum: undefined,
    downSql: undefined,
    id: '000',
    name: 'platform',
    upSql: 'CREATE EXTENSION IF NOT EXISTS vector;\n',
    version: 0,
  },
  {
    checksum: 'b'.repeat(64),
    downChecksum: 'c'.repeat(64),
    downSql: 'DROP TABLE migration_probe;\n',
    id: '001',
    name: 'probe',
    upSql: 'CREATE TABLE migration_probe (id integer PRIMARY KEY);\n',
    version: 1,
  },
];

describe('renderUpMigrationSql', () => {
  it('uses one transaction, one advisory lock and checksum guards', () => {
    const sql = renderUpMigrationSql(migrations);

    expect(sql.match(/^BEGIN;$/gmu)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gmu)).toHaveLength(1);
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain('schema migration 000 checksum mismatch');
    expect(sql).toContain('schema migration 001 checksum mismatch');
    expect(sql).toContain("down_checksum IS DISTINCT FROM 'cccc");
    expect(sql).toContain('\\if :ba_apply_000');
    expect(sql).toContain('\\if :ba_apply_001');
    expect(sql.indexOf('CREATE EXTENSION')).toBeLessThan(
      sql.indexOf('CREATE TABLE migration_probe'),
    );
    expect(sql).toContain('database migration ledger contains a version unknown to this checkout');
    expect(sql).toContain('database migration ledger is not a contiguous prefix');
  });

  it('still bootstraps and checks the database when no migrations exist', () => {
    const sql = renderUpMigrationSql([]);

    expect(sql).toContain('server_version_num');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS better_agent_migrations.schema_migrations');
    expect(sql).not.toContain('ba_apply_000');
  });

  it('rejects an unordered or incomplete local migration chain before opening the database', () => {
    expect(() => renderUpMigrationSql([migrations[1] as Migration])).toThrow(
      'local migration chain must be contiguous: expected 000, found 001',
    );
    expect(() => renderUpMigrationSql([...migrations].reverse())).toThrow(
      'local migration chain must be contiguous: expected 000, found 001',
    );
  });

  it('revalidates transaction control at the public renderer boundary', () => {
    expect(() =>
      renderUpMigrationSql([{ ...(migrations[0] as Migration), upSql: 'COMMIT AND CHAIN;' }]),
    ).toThrow('must not manage its own transaction');
  });
});

describe('renderDownMigrationSql', () => {
  it('requires an explicit destructive-action acknowledgement', () => {
    expect(() => renderDownMigrationSql(migrations, 0, { allowDown: false })).toThrow(
      'rollback is disabled unless allowDown is explicitly true',
    );
  });

  it('rolls back reviewed down migrations in reverse order', () => {
    const sql = renderDownMigrationSql(migrations, 0, { allowDown: true });

    expect(sql).toContain('DROP TABLE migration_probe;');
    expect(sql).toContain('DELETE FROM better_agent_migrations.schema_migrations');
    expect(sql).not.toContain('CREATE EXTENSION');
  });

  it('fails closed before touching the database when a down migration is missing', () => {
    expect(() => renderDownMigrationSql(migrations, -1, { allowDown: true })).toThrow(
      'migration 000_platform has no reviewed down migration',
    );
  });
});

describe('renderMigrationStatusSql', () => {
  it('reports server, pgvector and ordered ledger state without mutation', () => {
    const sql = renderMigrationStatusSql();

    expect(sql).toContain("current_setting('server_version_num')");
    expect(sql).toContain("extname = 'vector'");
    expect(sql).toContain('ORDER BY version');
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/iu);
  });
});
