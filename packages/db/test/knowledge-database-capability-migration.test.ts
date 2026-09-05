import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadMigrations } from '../src/index.js';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function migrationSql(direction: 'upSql' | 'downSql'): Promise<string> {
  const migration = (await loadMigrations(path.join(packageDirectory, 'migrations'))).find(
    ({ id }) => id === '011',
  );
  expect(migration).toMatchObject({ id: '011', name: 'g1_knowledge_database_capability' });
  return migration?.[direction] ?? '';
}

describe('011 G1 Knowledge and Database capability migration', () => {
  it('stores immutable exact-generation Knowledge query receipts under execution lease', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('public.knowledge_query_receipts');
    expect(sql).toContain('app.record_knowledge_query_receipt');
    expect(sql).toContain('app.require_execution_owner_lease');
    expect(sql).toContain("'compiled-knowledge-query/1'");
    expect(sql).toContain("'KNOWLEDGE_INDEX_GENERATION'");
    expect(sql).toContain('authority_hash');
    expect(sql).toContain('authorized_sources');
  });

  it('stores immutable parameterized read-only Database operation receipts', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('public.database_operation_receipts');
    expect(sql).toContain('app.record_database_operation_receipt');
    expect(sql).toContain("'compiled-database-select/1'");
    expect(sql).toContain("'DATABASE_OPERATION_RELEASE'");
    expect(sql).toContain("'read_only'");
    expect(sql).toContain('compiled_hash');
    expect(sql).toContain('operation_key');
  });

  it('keeps both receipt tables owner-only, immutable and FORCE RLS', async () => {
    const sql = await migrationSql('upSql');
    expect(sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(2);
    expect(sql).toContain('app.reject_g1_capability_receipt_change');
    expect(sql).not.toMatch(
      /GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]*(?:knowledge_query|database_operation)_receipts/u,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.record_knowledge_query_receipt\(jsonb\)[\s\S]*TO ba_execution_executor;/u,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.record_database_operation_receipt\(jsonb\)[\s\S]*TO ba_execution_executor;/u,
    );
  });

  it('rejects downgrade after durable capability receipts exist', async () => {
    const sql = await migrationSql('downSql');
    expect(sql).toContain('durable G1 capability receipts exist; downgrade rejected');
    expect(sql).toContain('DROP TABLE public.knowledge_query_receipts');
    expect(sql).toContain('DROP TABLE public.database_operation_receipts');
  });
});
