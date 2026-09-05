import type { CompiledAgentPlanV1, StrategyCheckpointV1 } from '@better-agent/domain-contracts';
import { canonicalSha256ExcludingRootKeys } from '@better-agent/release-core';
import { describe, expect, it, vi } from 'vitest';
import type { G1SourceSqlQueryClient } from '../src/modules/releases/g1-source-postgres-readback.js';
import { createAgentStrategyPostgresAdapter } from '../src/modules/runs/index.js';

const id = (suffix: string) => `018f47f2-c541-7cc6-9292-4a2c3530${suffix}`;
const digest = (value: string) => `sha256:${value.repeat(64)}` as const;
const pin = {
  workspace_id: id('4eee'),
  published_resource_kind: 'AGENT_STRATEGY_RELEASE' as const,
  resource_id: id('4101'),
  resource_version_id: id('4102'),
  contract_hash: digest('a'),
  binding_mode: 'pinned' as const,
};
const strategyPin = {
  published_resource_kind: 'AGENT_STRATEGY_RELEASE' as const,
  strategy_id: pin.resource_id,
  strategy_release_id: pin.resource_version_id,
  abi_version: 'agent-strategy-abi/1' as const,
  implementation_digest: digest('b'),
  config_hash: digest('c'),
  input_schema_hash: digest('d'),
  state_schema_hash: digest('e'),
  decision_schema_hash: digest('f'),
  observation_schema_hash: digest('1'),
  sandbox_profile_id: 'sandbox-v1',
  allowed_model_policy_hash: digest('2'),
  allowed_capability_binding_ids: [],
  allowed_gate_spec_ids: [],
  max_iterations: 1,
  max_model_attempts: 0,
  max_tool_calls: 0,
  contract_hash: pin.contract_hash,
};
const planDraft = {
  schema_version: 'compiled-agent-plan/1' as const,
  agent_release: { ...pin, published_resource_kind: 'AGENT_RELEASE' as const },
  source_semantic_hash: digest('3'),
  capability_closure_hash: digest('4'),
  resolved_execution_plan_hash: digest('5'),
  strategy: {
    full_pin: pin,
    strategy_pin: strategyPin,
    component_hashes: {},
    config: {},
    schemas: { config: {}, input: {}, state: {}, decision: {}, observation: {} },
  },
  role_context_hash: digest('6'),
  input_schema_hash: digest('7'),
  model_catalog: [],
  model_limits: { maximum_input_tokens: 0, maximum_output_tokens: 0 },
  capability_catalog: [],
  instruction_skills: [],
  gates: [],
  public_capability_handles: [],
  runtime_limits: {},
  strategy_limits: { max_iterations: 1, max_model_attempts: 0, max_tool_calls: 0 },
  checkpoint_contract_version: 'agent-strategy-checkpoint/1' as const,
};
const plan = {
  ...planDraft,
  plan_hash: canonicalSha256ExcludingRootKeys(planDraft, ['plan_hash']),
} as CompiledAgentPlanV1;
const runId = id('4201');
const executionId = id('4202');
const checkpointDraft = {
  schema_version: 'agent-strategy-checkpoint/1' as const,
  checkpoint_id: 'checkpoint-0',
  run_id: runId,
  root_step_id: 'root',
  strategy_release_id: strategyPin.strategy_release_id,
  implementation_digest: strategyPin.implementation_digest,
  resolved_agent_plan_hash: plan.plan_hash,
  capability_closure_hash: plan.capability_closure_hash,
  transition_sequence: 0,
  iteration: 0,
  phase: 'READY' as const,
  durable_state: {},
  state_schema_hash: strategyPin.state_schema_hash,
  accepted_observation_refs: [],
  completed_model_attempt_ids: [],
  completed_capability_call_ids: [],
  instruction_skill_activation_ids: [],
  counters: {},
};
const checkpoint = {
  ...checkpointDraft,
  checkpoint_hash: canonicalSha256ExcludingRootKeys(checkpointDraft, ['checkpoint_hash']),
} as StrategyCheckpointV1;
const lease = {
  run_id: runId,
  attempt_id: id('4203'),
  lease_token: id('4204'),
  lease_fencing_token: '1',
};

describe('Agent Strategy PostgreSQL adapter', () => {
  it('registers the exact reviewed plan and commits its checkpoint with parameterized SQL', async () => {
    const query = vi.fn(async (sql: string, _values: readonly unknown[]) => ({
      rows: [
        {
          result: sql.includes('register_agent_strategy_execution')
            ? {
                schema_version: 'agent-strategy-execution-registration-result/1',
                agent_strategy_execution_id: executionId,
                compiled_agent_plan_hash: plan.plan_hash,
                replayed: false,
              }
            : {
                schema_version: 'agent-strategy-checkpoint-commit-result/1',
                checkpoint,
                replayed: false,
              },
        },
      ],
    }));
    const adapter = createAgentStrategyPostgresAdapter({
      query,
    } as unknown as G1SourceSqlQueryClient);
    await expect(
      adapter.registerExecution({
        ...lease,
        agent_strategy_execution_id: executionId,
        compiled_agent_plan: plan,
        plan_attestation_id: id('4205'),
        plan_attestation_verifier: 'ab'.repeat(32),
      }),
    ).resolves.toMatchObject({ compiled_agent_plan_hash: plan.plan_hash });
    await expect(
      adapter.commitCheckpoint({
        ...lease,
        agent_strategy_execution_id: executionId,
        commit_sequence: '1',
        checkpoint,
      }),
    ).resolves.toMatchObject({ replayed: false });
    expect(query).toHaveBeenCalledTimes(2);
    for (const [sql, values] of query.mock.calls) {
      expect(sql).toMatch(/^SELECT app\./u);
      expect(sql).toContain('$1');
      expect(values).toHaveLength(1);
    }
  });

  it('rejects malformed, open, or hash-drifting facts before database authority', async () => {
    const query = vi.fn();
    const adapter = createAgentStrategyPostgresAdapter({
      query,
    } as unknown as G1SourceSqlQueryClient);
    await expect(
      adapter.commitCheckpoint({
        ...lease,
        agent_strategy_execution_id: executionId,
        commit_sequence: '1',
        checkpoint: { ...checkpoint, phase: 'TERMINAL' },
        extra: true,
      } as never),
    ).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    expect(query).not.toHaveBeenCalled();
  });

  it('normalizes database failures without leaking database details', async () => {
    const adapter = createAgentStrategyPostgresAdapter({
      query: vi.fn(async () => {
        throw new Error('secret');
      }),
    } as unknown as G1SourceSqlQueryClient);
    await expect(
      adapter.commitCheckpoint({
        ...lease,
        agent_strategy_execution_id: executionId,
        commit_sequence: '1',
        checkpoint,
      }),
    ).rejects.toMatchObject({
      code: 'QUERY_FAILED',
      message: 'Agent Strategy PostgreSQL query failed',
    });
  });
});
