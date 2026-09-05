import { describe, expect, it } from 'vitest';

import { canonicalBindingPath, canonicalSha256 } from '@better-agent/release-core';
import {
  decideStrategyRecovery,
  decideStrategyModelAttemptRecovery,
  determineStrategyLimitTermination,
  prepareInitialStrategyCheckpoint,
  prepareStrategyActionObservation,
  prepareStrategyStart,
  prepareStrategyDecisionTransition,
} from '../src/index.js';

const hashA = `sha256:${'a'.repeat(64)}`;
const hashB = `sha256:${'b'.repeat(64)}`;
const rootPin = {
  workspace_id: 'workspace-1',
  published_resource_kind: 'AGENT_RELEASE' as const,
  resource_id: 'agent-1',
  resource_version_id: 'agent-release-1',
  contract_hash: hashA,
  binding_mode: 'pinned' as const,
};
const bindingPath = canonicalBindingPath([
  { segment_kind: 'root', pin: rootPin },
  {
    segment_kind: 'binding',
    owner: { owner_kind: 'root', pin: rootPin },
    binding_kind: 'database',
    local_binding_id: 'local-db',
  },
]);

function plan() {
  const stateSchema = { type: 'object', additionalProperties: true };
  const decisionSchema = { type: 'object', required: ['kind'] };
  const observationSchema = { type: 'object' };
  const candidate = {
    schema_version: 'compiled-agent-plan/1',
    agent_release: rootPin,
    source_semantic_hash: hashA,
    capability_closure_hash: hashA,
    resolved_execution_plan_hash: hashB,
    strategy: {
      full_pin: {
        workspace_id: 'workspace-1',
        published_resource_kind: 'AGENT_STRATEGY_RELEASE',
        resource_id: 'strategy-1',
        resource_version_id: 'strategy-release-1',
        contract_hash: hashA,
        binding_mode: 'pinned',
      },
      strategy_pin: {
        published_resource_kind: 'AGENT_STRATEGY_RELEASE',
        strategy_id: 'strategy-1',
        strategy_release_id: 'strategy-release-1',
        abi_version: 'agent-strategy-abi/1',
        implementation_digest: hashA,
        config_hash: hashA,
        input_schema_hash: hashA,
        state_schema_hash: canonicalSha256(stateSchema),
        decision_schema_hash: canonicalSha256(decisionSchema),
        observation_schema_hash: canonicalSha256(observationSchema),
        sandbox_profile_id: 'deny-all',
        allowed_model_policy_hash: hashA,
        allowed_capability_binding_ids: ['local-db'],
        allowed_gate_spec_ids: [],
        max_iterations: 3,
        max_model_attempts: 2,
        max_tool_calls: 1,
        contract_hash: hashA,
      },
      component_hashes: {},
      config: {},
      schemas: {
        config: { type: 'object' },
        input: { type: 'object' },
        state: stateSchema,
        decision: decisionSchema,
        observation: observationSchema,
      },
    },
    role_context_hash: hashA,
    input_schema_hash: hashA,
    output_schema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    },
    output_schema_hash: canonicalSha256({
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    }),
    model_catalog: [
      {
        descriptor_id: 'model-primary',
        provider_id: 'provider',
        model_id: 'model',
        model_revision: 'v1',
        model_contract_hash: hashA,
      },
    ],
    model_limits: { maximum_input_tokens: 100, maximum_output_tokens: 50 },
    capability_catalog: [
      {
        schema_version: 'agent-capability-catalog-entry/1',
        local_binding_id: 'local-db',
        binding_path: bindingPath,
        binding_kind: 'database',
        target: {
          workspace_id: 'workspace-1',
          published_resource_kind: 'DATABASE_OPERATION_RELEASE',
          resource_id: 'database-1',
          resource_version_id: 'database-release-1',
          contract_hash: hashA,
          binding_mode: 'pinned',
        },
        operations: [
          {
            operation_kind: 'database_operation',
            operation_id: 'query',
            contract_hash: hashA,
            input_schema_hash: hashB,
            output_schema_hash: hashA,
            side_effect_class: 'safe',
            operation_key_required: false,
            approval_required: false,
            input_schema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
              additionalProperties: false,
            },
          },
        ],
        effective_policy_hash: hashA,
      },
    ],
    instruction_skills: [],
    gates: [],
    public_capability_handles: [],
    runtime_limits: {},
    strategy_limits: { max_iterations: 3, max_model_attempts: 2, max_tool_calls: 1 },
    checkpoint_contract_version: 'agent-strategy-checkpoint/1',
  };
  return { ...candidate, plan_hash: canonicalSha256(candidate) };
}

const counters = {
  schema_version: 'strategy-counter-snapshot/1',
  model_attempts: 0,
  capability_calls: 0,
  committed_usage_receipts: 0,
  budget_exhausted: false,
};

async function fixtureCheckpoint() {
  const value = plan();
  const checkpoint = await prepareInitialStrategyCheckpoint({
    plan: value,
    expected_plan_hash: value.plan_hash,
    checkpoint_id: 'checkpoint-0',
    run_id: 'run-1',
    root_step_id: 'step-1',
    durable_state: {},
    counters,
  });
  return { value, checkpoint };
}

describe('durable Strategy runtime', () => {
  it('never redispatches an uncertain non-idempotent model attempt', () => {
    expect(
      decideStrategyModelAttemptRecovery({
        status: 'ABSENT',
        provider_supports_idempotency_key: false,
        provider_supports_result_query: false,
      }),
    ).toBe('PREPARE_ATTEMPT');
    expect(
      decideStrategyModelAttemptRecovery({
        status: 'PREPARED',
        provider_supports_idempotency_key: true,
        provider_supports_result_query: false,
      }),
    ).toBe('DISPATCH_WITH_STABLE_KEY');
    expect(
      decideStrategyModelAttemptRecovery({
        status: 'DISPATCHED',
        provider_supports_idempotency_key: false,
        provider_supports_result_query: false,
      }),
    ).toBe('MARK_OUTCOME_UNKNOWN');
    expect(
      decideStrategyModelAttemptRecovery({
        status: 'DISPATCHED',
        provider_supports_idempotency_key: false,
        provider_supports_result_query: true,
      }),
    ).toBe('QUERY_ORIGINAL_ATTEMPT');
    expect(
      decideStrategyModelAttemptRecovery({
        status: 'SUCCEEDED',
        provider_supports_idempotency_key: false,
        provider_supports_result_query: false,
      }),
    ).toBe('ACCEPT_COMMITTED_RECEIPT');
  });

  it('projects a secret-free StrategyStart from only compiled catalogs', () => {
    const value = plan();
    const start = prepareStrategyStart({
      plan: value,
      expected_plan_hash: value.plan_hash,
      run_id: 'run-1',
      root_step_id: 'step-1',
      input_snapshot_ref: 'input-snapshot-1',
    });
    expect(start).toMatchObject({
      schema_version: 'agent-strategy-start/1',
      resolved_agent_plan_hash: value.plan_hash,
      capability_closure_hash: value.capability_closure_hash,
      input_snapshot_ref: 'input-snapshot-1',
      model_catalog: value.model_catalog,
      capability_catalog: value.capability_catalog,
      instruction_skills: value.instruction_skills,
    });
    expect(JSON.stringify(start)).not.toContain('credential');
  });

  it('creates a self-hashed READY checkpoint from the exact compiled AgentPlan', async () => {
    const { value, checkpoint } = await fixtureCheckpoint();
    expect(checkpoint).toMatchObject({
      schema_version: 'agent-strategy-checkpoint/1',
      run_id: 'run-1',
      phase: 'READY',
      transition_sequence: 0,
      resolved_agent_plan_hash: value.plan_hash,
      capability_closure_hash: value.capability_closure_hash,
    });
    const { checkpoint_hash: _hash, ...preimage } = checkpoint;
    expect(checkpoint.checkpoint_hash).toBe(canonicalSha256(preimage));
  });

  it('derives a stable model action identity before dispatch', async () => {
    const { value, checkpoint } = await fixtureCheckpoint();
    const transition = await prepareStrategyDecisionTransition({
      plan: value,
      expected_plan_hash: value.plan_hash,
      checkpoint,
      expected_checkpoint_hash: checkpoint.checkpoint_hash,
      checkpoint_id: 'checkpoint-1',
      decision: {
        kind: 'request_model',
        model_descriptor_id: 'model-primary',
        request: { prompt_ref: 'prompt-1' },
        retry_policy_ref: 'fixed-1',
      },
      durable_state: { turn: 1 },
      counters,
    });
    expect(transition.checkpoint).toMatchObject({
      phase: 'MODEL_PENDING',
      transition_sequence: 1,
      iteration: 1,
      previous_checkpoint_hash: checkpoint.checkpoint_hash,
      pending_action: {
        action_kind: 'model',
        model_descriptor_id: 'model-primary',
      },
    });
    expect(transition.outbox.operation_id).toBe(
      canonicalSha256({
        schema_version: 'strategy-logical-action-id/1',
        run_id: 'run-1',
        root_step_id: 'step-1',
        transition_sequence: 1,
        decision_kind: 'request_model',
      }),
    );
  });

  it('rejects guessed model and capability identities before producing outbox work', async () => {
    const { value, checkpoint } = await fixtureCheckpoint();
    await expect(
      prepareStrategyDecisionTransition({
        plan: value,
        expected_plan_hash: value.plan_hash,
        checkpoint,
        expected_checkpoint_hash: checkpoint.checkpoint_hash,
        checkpoint_id: 'checkpoint-1',
        decision: {
          kind: 'request_model',
          model_descriptor_id: 'unknown',
          request: {},
          retry_policy_ref: 'fixed-1',
        },
        durable_state: {},
        counters,
      }),
    ).rejects.toThrow('RUN_STRATEGY_DECISION_INVALID');

    await expect(
      prepareStrategyDecisionTransition({
        plan: value,
        expected_plan_hash: value.plan_hash,
        checkpoint,
        expected_checkpoint_hash: checkpoint.checkpoint_hash,
        checkpoint_id: 'checkpoint-1',
        decision: {
          kind: 'invoke_capability',
          binding_path: 'sibling-same-local-id',
          operation_contract_hash: hashA,
          input: {},
        },
        durable_state: {},
        counters,
      }),
    ).rejects.toThrow('RUN_STRATEGY_DECISION_INVALID');
  });

  it('returns explicit terminal reasons from authoritative counter snapshots', () => {
    const value = plan();
    expect(
      determineStrategyLimitTermination(value, { ...counters, budget_exhausted: true }, 0),
    ).toBe('BUDGET_EXHAUSTED');
    expect(determineStrategyLimitTermination(value, counters, 3)).toBe('MAX_ITERATIONS');
    expect(
      determineStrategyLimitTermination(value, { ...counters, model_attempts: 2 }, 0, 'model'),
    ).toBe('MAX_MODEL_ATTEMPTS');
    expect(
      determineStrategyLimitTermination(
        value,
        { ...counters, capability_calls: 1 },
        0,
        'capability',
      ),
    ).toBe('MAX_TOOL_CALLS');
  });

  it('never computes a second action while a committed action is pending', async () => {
    const { checkpoint } = await fixtureCheckpoint();
    expect(decideStrategyRecovery(checkpoint)).toBe('COMPUTE_DECISION');
    for (const [phase, action] of [
      ['MODEL_PENDING', 'RECONCILE_MODEL'],
      ['CAPABILITY_PENDING', 'RECONCILE_CAPABILITY'],
      ['SUSPENDED', 'WAIT_FOR_HUMAN'],
      ['RESUMING', 'COMPUTE_DECISION'],
      ['TERMINAL', 'STOP'],
    ] as const) {
      expect(decideStrategyRecovery({ ...checkpoint, phase })).toBe(action);
    }
  });

  it('validates capability input and keeps a zero tool budget from blocking model-only work', async () => {
    const modelOnly = plan();
    modelOnly.strategy_limits.max_tool_calls = 0;
    modelOnly.strategy.strategy_pin.max_tool_calls = 0;
    modelOnly.plan_hash = canonicalSha256(
      Object.fromEntries(Object.entries(modelOnly).filter(([key]) => key !== 'plan_hash')),
    );
    const initial = await prepareInitialStrategyCheckpoint({
      plan: modelOnly,
      expected_plan_hash: modelOnly.plan_hash,
      checkpoint_id: 'checkpoint-0',
      run_id: 'run-model-only',
      root_step_id: 'step-1',
      durable_state: {},
      counters,
    });
    await expect(
      prepareStrategyDecisionTransition({
        plan: modelOnly,
        expected_plan_hash: modelOnly.plan_hash,
        checkpoint: initial,
        expected_checkpoint_hash: initial.checkpoint_hash,
        checkpoint_id: 'checkpoint-1',
        decision: {
          kind: 'request_model',
          model_descriptor_id: 'model-primary',
          request: {},
          retry_policy_ref: 'fixed-1',
        },
        durable_state: {},
        counters,
      }),
    ).resolves.toMatchObject({ checkpoint: { phase: 'MODEL_PENDING' } });

    const { value, checkpoint } = await fixtureCheckpoint();
    await expect(
      prepareStrategyDecisionTransition({
        plan: value,
        expected_plan_hash: value.plan_hash,
        checkpoint,
        expected_checkpoint_hash: checkpoint.checkpoint_hash,
        checkpoint_id: 'checkpoint-1',
        decision: {
          kind: 'invoke_capability',
          binding_path: bindingPath,
          operation_contract_hash: hashA,
          input: { unexpected: true },
        },
        durable_state: {},
        counters,
      }),
    ).rejects.toThrow('capability input failed');
  });

  it('seals a valid capability action and validates terminal output', async () => {
    const { value, checkpoint } = await fixtureCheckpoint();
    const capability = await prepareStrategyDecisionTransition({
      plan: value,
      expected_plan_hash: value.plan_hash,
      checkpoint,
      expected_checkpoint_hash: checkpoint.checkpoint_hash,
      checkpoint_id: 'checkpoint-capability',
      decision: {
        kind: 'invoke_capability',
        binding_path: bindingPath,
        operation_contract_hash: hashA,
        input: { query: 'hello' },
      },
      durable_state: {},
      counters,
    });
    expect(capability.checkpoint).toMatchObject({
      phase: 'CAPABILITY_PENDING',
      pending_action: { action_kind: 'capability', binding_path: bindingPath },
    });

    await expect(
      prepareStrategyDecisionTransition({
        plan: value,
        expected_plan_hash: value.plan_hash,
        checkpoint,
        expected_checkpoint_hash: checkpoint.checkpoint_hash,
        checkpoint_id: 'checkpoint-complete',
        decision: {
          kind: 'complete',
          output: { answer: 42 },
          output_schema_hash: value.output_schema_hash,
        },
        durable_state: {},
        counters,
      }),
    ).rejects.toThrow('output failed');
  });

  it('accepts one committed model observation and rejects a foreign action result', async () => {
    const { value, checkpoint } = await fixtureCheckpoint();
    const pending = await prepareStrategyDecisionTransition({
      plan: value,
      expected_plan_hash: value.plan_hash,
      checkpoint,
      expected_checkpoint_hash: checkpoint.checkpoint_hash,
      checkpoint_id: 'checkpoint-pending',
      decision: {
        kind: 'request_model',
        model_descriptor_id: 'model-primary',
        request: {},
        retry_policy_ref: 'fixed-1',
      },
      durable_state: {},
      counters,
    });
    const operationId = String(
      (pending.checkpoint.pending_action as { operation_id: string }).operation_id,
    );
    const result = await prepareStrategyActionObservation({
      plan: value,
      expected_plan_hash: value.plan_hash,
      checkpoint: pending.checkpoint,
      expected_checkpoint_hash: pending.checkpoint.checkpoint_hash,
      checkpoint_id: 'checkpoint-observed',
      action_result: {
        schema_version: 'strategy-action-result/1',
        operation_id: operationId,
        action_kind: 'model',
        completion_id: 'model-attempt-1',
        status: 'SUCCEEDED',
        observation_ref: 'observation-1',
        observation_hash: canonicalSha256({ answer: 'ok' }),
        receipt_hash: hashA,
      },
      observation: { answer: 'ok' },
      counters: { ...counters, model_attempts: 1, committed_usage_receipts: 1 },
    });
    expect(result).toMatchObject({
      phase: 'READY',
      transition_sequence: 1,
      completed_model_attempt_ids: ['model-attempt-1'],
      accepted_observation_refs: ['observation-1'],
    });
    expect(result).not.toHaveProperty('pending_action');

    await expect(
      prepareStrategyActionObservation({
        plan: value,
        expected_plan_hash: value.plan_hash,
        checkpoint: pending.checkpoint,
        expected_checkpoint_hash: pending.checkpoint.checkpoint_hash,
        checkpoint_id: 'checkpoint-foreign',
        action_result: {
          schema_version: 'strategy-action-result/1',
          operation_id: hashB,
          action_kind: 'model',
          completion_id: 'model-attempt-1',
          status: 'SUCCEEDED',
          observation_ref: 'observation-1',
          observation_hash: canonicalSha256({ answer: 'ok' }),
          receipt_hash: hashA,
        },
        observation: { answer: 'ok' },
        counters,
      }),
    ).rejects.toThrow('foreign action result');
  });

  it('turns an unknown dispatched outcome into a non-resumable terminal intent', async () => {
    const { value, checkpoint } = await fixtureCheckpoint();
    const pending = await prepareStrategyDecisionTransition({
      plan: value,
      expected_plan_hash: value.plan_hash,
      checkpoint,
      expected_checkpoint_hash: checkpoint.checkpoint_hash,
      checkpoint_id: 'checkpoint-pending',
      decision: {
        kind: 'request_model',
        model_descriptor_id: 'model-primary',
        request: {},
        retry_policy_ref: 'fixed-1',
      },
      durable_state: {},
      counters,
    });
    const operationId = String(
      (pending.checkpoint.pending_action as { operation_id: string }).operation_id,
    );
    const result = await prepareStrategyActionObservation({
      plan: value,
      expected_plan_hash: value.plan_hash,
      checkpoint: pending.checkpoint,
      expected_checkpoint_hash: pending.checkpoint.checkpoint_hash,
      checkpoint_id: 'checkpoint-unknown',
      action_result: {
        schema_version: 'strategy-action-result/1',
        operation_id: operationId,
        action_kind: 'model',
        completion_id: 'model-attempt-1',
        status: 'OUTCOME_UNKNOWN',
      },
      counters: { ...counters, model_attempts: 1 },
    });
    expect(result).toMatchObject({
      phase: 'TERMINATING',
      termination_reason: 'MODEL_OUTCOME_UNKNOWN',
    });
  });
});
