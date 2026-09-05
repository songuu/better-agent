import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadMigrations } from '../src/index.js';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function migrationSql(direction: 'upSql' | 'downSql'): Promise<string> {
  const migration = (await loadMigrations(path.join(packageDirectory, 'migrations'))).find(
    ({ id }) => id === '019',
  );
  expect(migration).toMatchObject({ id: '019', name: 'g1_production_evaluation' });
  return migration?.[direction] ?? '';
}

describe('019 G1 production evaluation migration', () => {
  it('stores immutable suite, run, evidence and decision facts behind FORCE RLS', async () => {
    const sql = await migrationSql('upSql');
    for (const table of [
      'evaluation_suite_releases',
      'evaluation_runs',
      'evaluation_evidence_bundles',
      'production_promotion_decisions',
    ]) {
      expect(sql).toContain(`public.${table}`);
    }
    expect(sql).toContain('FOREACH v_table IN ARRAY ARRAY[');
    expect(sql).toContain("'ALTER TABLE public.%I FORCE ROW LEVEL SECURITY'");
    expect(sql).toContain('production_promotion_decisions_live_key');
    expect(sql).toContain("status IN ('PENDING','APPROVED')");
  });

  it('admits only passed exact evidence and CAS decision transitions', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('app.register_evaluation_evidence_bundle');
    expect(sql).toContain("evaluation_run.status<>'PASSED'");
    expect(sql).toContain('app.transition_production_promotion_decision');
    expect(sql).toContain('decision_version=p_expected_decision_version');
    expect(sql).toContain("status='PENDING'");
    expect(sql).toContain("status='APPROVED' AND p_target_status='INVALIDATED'");
    expect(sql).toContain("IF TG_OP='DELETE' THEN");
  });

  it('uses one shared atomic production promotion path for Agent and Flow', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('app.consume_production_promotion_decision');
    expect(sql).toContain("v_decision.deployment_kind='agent'");
    expect(sql).toContain("v_decision.deployment_kind='flow'");
    expect(sql).toContain("v_decision.status<>'APPROVED'");
    expect(sql).toContain("SET status='CONSUMED'");
    expect(sql).toContain('auth.record_authorization_epoch_change');
  });

  it('keeps control callers off tables and exposes only narrow functions', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('REVOKE ALL ON TABLE');
    expect(sql).toContain('TO ba_control_executor');
    expect(sql).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]+TO ba_control_executor/isu,
    );
    expect(sql).toContain('published_executable_closures_evaluation_reviewer_read');
    expect(sql).toContain(
      "pg_catalog.pg_has_role(session_user,'ba_management_attestation_issuer','MEMBER')",
    );
    expect(sql).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]+TO ba_management_attestation_issuer/isu,
    );
  });

  it('refuses downgrade once evaluation or decision facts exist', async () => {
    const sql = await migrationSql('downSql');
    expect(sql).toContain('production evaluation facts exist; downgrade rejected');
  });
});
