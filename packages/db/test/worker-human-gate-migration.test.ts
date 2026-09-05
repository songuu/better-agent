import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadMigrations } from '../src/index.js';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function migrationSql(direction: 'upSql' | 'downSql'): Promise<string> {
  const migration = (await loadMigrations(path.join(packageDirectory, 'migrations'))).find(
    ({ id }) => id === '013',
  );
  expect(migration).toMatchObject({ id: '013', name: 'g1_worker_human_gate' });
  return migration?.[direction] ?? '';
}

describe('013 G1 Worker Human Gate migration', () => {
  it('uses replay-first mutation receipts whose namespace excludes the target', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('app.resume_human_gate');
    expect(sql).toContain(
      "p_fact ?& ARRAY['workspaceId','authenticatedPrincipal','browserIdentity'",
    );
    expect(sql).toContain("'/v1/oapi/runs/{run_id}/gates/{gate_id}/resume'");
    expect(sql).toContain('v_mutation.target_gate_id');
    expect(sql).toContain("'outcome', 'REPLAY'");
    expect(sql.indexOf('IF FOUND THEN')).toBeLessThan(sql.indexOf('FOR UPDATE OF gate_row'));
  });

  it('atomically claims one disposition and emits exactly one closed outcome', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain("'NEXT_GATE_WAITING'");
    expect(sql).toContain("'RUN_RESUMED'");
    expect(sql).toContain("'TERMINAL_INTENT_ACCEPTED'");
    expect(sql).toMatch(/status\s*=\s*'CLAIMED'/u);
    expect(sql).toContain('decision_hash');
    expect(sql).toContain('public.human_gate_evidence');
    expect(sql).toContain('private_payload');
    expect(sql).toContain('run_mutation_idempotency');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
  });

  it('keeps intermediate approvals quiescent and final decisions single-dispatch', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain("'run.waiting'");
    expect(sql).toContain("'run.resumed'");
    expect(sql).toMatch(/'gate-resume:'\s*\|\|\s*v_gate\.id::text/u);
    expect(sql).toMatch(/'gate-finalize:'\s*\|\|\s*v_gate\.id::text/u);
    expect(sql).toContain('public.run_attempts');
    expect(sql).toContain('public.outbox');
  });

  it('enables literal run:resume authorization for service and browser callers', async () => {
    const sql = await migrationSql('upSql');
    expect(sql.match(/'run:resume'/gu)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(sql).toContain('app.require_original_run_authorization');
    expect(sql).toContain("jsonb_typeof(p_auth -> 'browserIdentity')");
  });

  it('refuses downgrade while gate resume facts exist', async () => {
    const sql = await migrationSql('downSql');
    expect(sql).toContain('Human Gate resume facts exist; downgrade rejected');
    expect(sql).toContain('DROP FUNCTION app.resume_human_gate(jsonb)');
    expect(sql.match(/REVOKE SELECT/gu)).toHaveLength(5);
    expect(sql).toContain('ON public.api_credential_scopes FROM ba_run_owner');
  });
});
