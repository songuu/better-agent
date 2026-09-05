import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadMigrations } from '../src/index.js';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function migrationSql(direction: 'upSql' | 'downSql'): Promise<string> {
  const migration = (await loadMigrations(path.join(packageDirectory, 'migrations'))).find(
    ({ id }) => id === '012',
  );
  expect(migration).toMatchObject({ id: '012', name: 'g1_agent_strategy_execution' });
  return migration?.[direction] ?? '';
}

describe('012 G1 Agent Strategy execution migration', () => {
  it('binds an Agent Run to one exact canonical compiled AgentPlan', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('public.agent_strategy_executions');
    expect(sql).toContain("'compiled-agent-plan/1'");
    expect(sql).toContain("'agent-strategy-checkpoint/1'");
    expect(sql).toContain("app.g007_canonical_json(v_plan - 'plan_hash')");
    expect(sql).toContain('v_run.accepted_plan_hash');
    expect(sql).toContain('app.require_execution_owner_lease');
    expect(sql).toContain('app.register_agent_strategy_execution');
  });

  it('commits checkpoint, pending action and outbox with one causal CAS', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('public.agent_strategy_checkpoints');
    expect(sql).toContain('public.agent_strategy_actions');
    expect(sql).toContain('app.commit_agent_strategy_checkpoint');
    expect(sql).toContain('previous_checkpoint_hash');
    expect(sql).toContain('commit_sequence');
    expect(sql).toContain('operation_id');
    expect(sql).toContain('decision_hash');
    expect(sql).toContain(
      "v_outbox ->> 'decision_hash' IS DISTINCT FROM p_fact ->> 'decision_hash'",
    );
    expect(sql).toContain("v_outbox ->> 'decision_kind' IS DISTINCT FROM (CASE v_action_kind");
    expect(sql).toContain('outbox');
    expect(sql).toContain('FOR UPDATE');
  });

  it('accepts one exact action result and usage receipt before the next checkpoint', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('public.agent_strategy_action_results');
    expect(sql).toContain('public.agent_model_usage_receipts');
    expect(sql).toContain('app.commit_agent_strategy_action_result');
    expect(sql).toContain('app.record_usage_attribution');
    expect(sql).toContain("'OUTCOME_UNKNOWN'");
    expect(sql).toContain('MODEL_OUTCOME_UNKNOWN');
    expect(sql).toContain('SIDE_EFFECT_UNKNOWN');
    expect(sql).toContain('receipt_hash');
  });

  it('keeps all facts immutable, owner-only and FORCE RLS', async () => {
    const sql = await migrationSql('upSql');
    expect(sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(6);
    expect(sql).toContain('app.reject_g1_agent_strategy_fact_change');
    expect(sql).not.toMatch(/GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]*agent_strategy/u);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.register_agent_strategy_execution\(jsonb\)[\s\S]*TO ba_execution_executor;/u,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.commit_agent_strategy_action_result\(jsonb\)[\s\S]*TO ba_execution_executor;/u,
    );
  });

  it('rejects downgrade after durable Agent Strategy facts exist', async () => {
    const sql = await migrationSql('downSql');
    expect(sql).toContain('durable Agent Strategy facts exist; downgrade rejected');
    expect(sql).toContain('DROP TABLE public.agent_strategy_action_results');
    expect(sql).toContain('DROP TABLE public.agent_strategy_executions');
  });
});
