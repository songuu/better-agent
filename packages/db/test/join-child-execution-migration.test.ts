import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadMigrations } from '../src/index.js';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function migrationSql(direction: 'upSql' | 'downSql'): Promise<string> {
  const migration = (await loadMigrations(path.join(packageDirectory, 'migrations'))).find(
    ({ id }) => id === '014',
  );
  expect(migration).toMatchObject({ id: '014', name: 'g1_join_child_execution' });
  return migration?.[direction] ?? '';
}

describe('014 G1 join-only child execution migration', () => {
  it('opens only the typed child topology while retaining one billing root', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain("run_kind IN ('top_level','join_child')");
    expect(sql).toMatch(/run_kind\s*=\s*'join_child'/u);
    expect(sql).toContain('billing_owner_run_id');
    expect(sql).toContain('public.run_parent_links');
    expect(sql).toContain('public.run_budget_allocations');
    expect(sql).toMatch(/completion_policy[^\n]*'join'|completion_policy,'join'/u);
    expect(sql).toContain("'wait_for_settlement'");
  });

  it('rejects ancestor recursion and bounded delegation drift before writes', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('ancestor_target_refs');
    expect(sql).toContain('allowed_target_refs');
    expect(sql).toContain('delegation_expires_at');
    expect(sql).toContain('max_calls');
    expect(sql).toContain('max_depth');
    expect(sql).toContain('max_budget_credits');
    expect(sql).toContain('recursive child target is denied');
    expect(sql.indexOf('recursive child target is denied')).toBeLessThan(
      sql.indexOf('INSERT INTO public.runs'),
    );
  });

  it('uses one replay identity and cross-owner allocation transaction', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('app.create_child_run');
    expect(sql).toContain('app.allocate_child_run_budget');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(sql).toContain("'replayed',true");
    expect(sql).toContain('parent_reservation_id');
    expect(sql).toContain('TO ba_run_owner');
    expect(sql).toContain('TO ba_execution_executor');
  });

  it('does not create a second credit reservation for a child', async () => {
    const sql = await migrationSql('upSql');
    const body = sql.slice(sql.indexOf('CREATE FUNCTION app.create_child_run'));
    expect(body).not.toContain('INSERT INTO public.credit_reservations');
    expect(sql).toContain('child Run cannot own a credit reservation');
    expect(sql).toMatch(
      /CREATE FUNCTION app\.reject_child_credit_reservation\(\) RETURNS trigger\s+LANGUAGE plpgsql SECURITY DEFINER/u,
    );
    expect(sql).toContain(
      'ALTER FUNCTION app.reject_child_credit_reservation() OWNER TO ba_run_owner',
    );
  });

  it('keeps topology immutable and refuses a downgrade with child facts', async () => {
    const up = await migrationSql('upSql');
    const down = await migrationSql('downSql');
    expect(up).toContain('run_parent_links_immutable');
    expect(up).toContain('run_budget_allocations_immutable');
    expect(down).toContain('join-child execution facts exist; downgrade rejected');
    expect(down).toContain('DROP FUNCTION app.create_child_run(jsonb)');
  });
});
