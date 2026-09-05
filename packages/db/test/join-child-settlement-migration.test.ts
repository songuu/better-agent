import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadMigrations } from '../src/index.js';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function migrationSql(direction: 'upSql' | 'downSql'): Promise<string> {
  const migration = (await loadMigrations(path.join(packageDirectory, 'migrations'))).find(
    ({ id }) => id === '015',
  );
  expect(migration).toMatchObject({ id: '015', name: 'g1_join_child_settlement' });
  return migration?.[direction] ?? '';
}

describe('015 G1 join-child settlement migration', () => {
  it('stores one immutable receipt per child terminal identity', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('public.join_child_settlement_receipts');
    expect(sql).toContain('child_terminal_intent_hash');
    expect(sql).toContain('terminal_payload_sha256');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('join_child_settlement_receipts_immutable');
  });

  it('requires allocation settlement before crossing the join barrier', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('app.require_closed_join_allocation');
    expect(sql).toContain("status NOT IN ('SETTLED','RELEASED')");
    expect(sql).toContain("'BARRIER_WAITING'");
    expect(sql).toContain('NOT EXISTS');
  });

  it('resumes a successful parent with one attempt, event and dispatch', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain("'RESUME_PARENT'");
    expect(sql).toContain('public.run_attempts');
    expect(sql).toContain("'RUN_QUEUED'");
    expect(sql).toContain("'RUN_DISPATCH'");
    expect(sql).toContain("execution_status='QUEUED'");
  });

  it('routes any non-success terminal outcome to the parent finalizer path', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain("'FAIL_PARENT'");
    expect(sql).toContain("'CANCEL_PARENT'");
    expect(sql).toContain("'FAIL_PARENT_CHILD_TIMED_OUT'");
    expect(sql).toContain("'HOLD_PARENT_NEEDS_ATTENTION'");
    expect(sql).toContain("execution_status='CANCELLING'");
  });

  it('refuses downgrade while settlement receipts exist', async () => {
    const sql = await migrationSql('downSql');
    expect(sql).toContain('join-child settlement facts exist; downgrade rejected');
    expect(sql).toContain('DROP FUNCTION app.settle_join_child(jsonb)');
    expect(sql).toContain('DROP TABLE public.join_child_settlement_receipts');
  });
});
