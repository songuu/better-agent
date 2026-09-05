import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadMigrations } from '../src/index.js';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function migrationSql(direction: 'upSql' | 'downSql'): Promise<string> {
  const migration = (await loadMigrations(path.join(packageDirectory, 'migrations'))).find(
    ({ id }) => id === '016',
  );
  expect(migration).toMatchObject({ id: '016', name: 'g1_join_child_terminalization' });
  return migration?.[direction] ?? '';
}

describe('016 G1 join-child terminalization migration', () => {
  it('stores the execution-authored terminal intent as an immutable authority fact', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('public.join_child_terminal_intents');
    expect(sql).toContain('producer_lease_fencing_token');
    expect(sql).toContain('source_authority_hash');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('join_child_terminal_intents_immutable');
  });

  it('admits terminal intent only under the live execution lease and exact child allocation', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('app.commit_join_child_terminal_intent');
    expect(sql).toContain('app.require_execution_owner_lease');
    expect(sql).toContain("v_child.run_kind<>'join_child'");
    expect(sql).toContain("v_settle_credits>(v_allocation->>'allocated_credits')::bigint");
  });

  it('settles child usage against the root reservation and closes only the child allocation', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('app.finalize_join_child');
    expect(sql).toContain('app.apply_credit_settlement_kernel');
    expect(sql).toContain("'producer_run_id',p_child_run_id");
    expect(sql).toContain('released_credits=v_allocation.allocated_credits-p_settle_credits');
    expect(sql).toContain("status=CASE WHEN p_settle_credits>0 THEN 'SETTLED' ELSE 'RELEASED' END");
  });

  it('writes an exact terminal tombstone and makes replay conflict explicit', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('join-child terminal intent replay conflict');
    expect(sql).toContain('join-child finalization replay conflict');
    expect(sql).toContain("'RUN_FINISHED'");
    expect(sql).toContain("billing_state='SETTLED'");
    expect(sql).toContain('terminal_result_redacted=v_intent.terminal_result_redacted');
  });

  it('refuses downgrade after terminal intent facts exist', async () => {
    const sql = await migrationSql('downSql');
    expect(sql).toContain('join-child terminal intent facts exist; downgrade rejected');
    expect(sql).toContain('DROP FUNCTION app.finalize_join_child(jsonb)');
    expect(sql).toContain('DROP FUNCTION app.commit_join_child_terminal_intent(jsonb)');
    expect(sql).toContain('DROP TABLE public.join_child_terminal_intents');
  });
});
