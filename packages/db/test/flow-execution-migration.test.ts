import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadMigrations } from '../src/index.js';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function migrationSql(direction: 'upSql' | 'downSql'): Promise<string> {
  const migration = (await loadMigrations(path.join(packageDirectory, 'migrations'))).find(
    ({ id }) => id === '010',
  );
  expect(migration).toMatchObject({ id: '010', name: 'g1_flow_execution' });
  return migration?.[direction] ?? '';
}

describe('010 G1 Flow execution migration', () => {
  it('binds each Flow Run to one exact canonical compiled plan', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('public.flow_executions');
    expect(sql).toContain("'compiled-flow-plan/1'");
    expect(sql).toContain("'FLOW_VERSION'");
    expect(sql).toContain("app.g007_canonical_json(v_plan - 'compiled_hash')");
    expect(sql).toContain('v_run.accepted_plan_hash');
    expect(sql).toContain('app.require_execution_owner_lease');
    expect(sql).toContain('auth.issue_flow_execution_plan_attestation');
    expect(sql).toContain('auth.consume_flow_execution_plan_attestation');
    expect(sql).toContain('auth.revoke_flow_execution_plan_attestation');
    expect(sql).toContain('isolated management issuer login');
    expect(sql).toContain('isolated execution login');
  });

  it('atomically projects model receipts into the existing usage ledger', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('public.flow_model_usage_receipts');
    expect(sql).toContain('app.record_flow_model_usage_receipt');
    expect(sql).toContain('app.record_usage_attribution');
    expect(sql).toContain('producer_operation_key');
    expect(sql).toContain('model_attempt_number');
    expect(sql).toContain('receipt_hash');
    expect(sql).toContain('public.flow_step_checkpoints');
    expect(sql).toContain('app.record_flow_step_checkpoint');
    expect(sql).toContain('previous_checkpoint_hash');
    expect(sql).toContain('predecessor_checkpoint_hashes');
  });

  it('keeps facts owner-only, immutable, FORCE RLS and exposes fixed functions only', async () => {
    const sql = await migrationSql('upSql');
    expect(sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(4);
    expect(sql).toContain('app.reject_g1_flow_execution_fact_change');
    expect(sql).not.toMatch(/GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]*flow_/u);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.register_flow_execution\(jsonb\)[\s\S]*TO ba_execution_executor;/u,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.record_flow_model_usage_receipt\(jsonb\)[\s\S]*TO ba_execution_executor;/u,
    );
  });

  it('rejects downgrade after durable Flow facts exist', async () => {
    const sql = await migrationSql('downSql');
    expect(sql).toContain('durable Flow execution facts exist; downgrade rejected');
    expect(sql).toContain('DROP TABLE public.flow_model_usage_receipts');
    expect(sql).toContain('DROP TABLE public.flow_executions');
  });
});
