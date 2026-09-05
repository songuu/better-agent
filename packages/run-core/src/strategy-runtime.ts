import {
  StrategyCheckpointV1Schema,
  StrategyDecisionV1Schema,
  StrategyStartV1Schema,
  type StrategyCheckpointV1,
  type StrategyTerminationReasonV1,
} from '@better-agent/domain-contracts';
import {
  boundedDataSnapshot,
  canonicalSha256,
  canonicalSha256ExcludingRootKeys,
  deepFreezeJson,
  validateJsonSchemaInstance,
  verifyCompiledAgentPlan,
} from '@better-agent/release-core';

import { failRunCore } from './errors.js';

type JsonRecord = Record<string, unknown>;

function invalidCheckpoint(path: string, reason: string): never {
  return failRunCore('RUN_STRATEGY_CHECKPOINT_INVALID', path, reason);
}

function invalidDecision(path: string, reason: string): never {
  return failRunCore('RUN_STRATEGY_DECISION_INVALID', path, reason);
}

function invalidObservation(path: string, reason: string): never {
  return failRunCore('RUN_STRATEGY_OBSERVATION_INVALID', path, reason);
}

function record(value: unknown, path: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalidCheckpoint(path, 'expected an object');
  return value as JsonRecord;
}

function trustedPlan(input: unknown, expectedHash: string) {
  const plan = record(verifyCompiledAgentPlan(input, expectedHash), '$.plan');
  const strategy = record(plan.strategy, '$.plan.strategy');
  const strategyPin = record(strategy.strategy_pin, '$.plan.strategy.strategy_pin');
  const schemas = record(strategy.schemas, '$.plan.strategy.schemas');
  const limits = record(plan.strategy_limits, '$.plan.strategy_limits');
  if (
    typeof plan.capability_closure_hash !== 'string' ||
    typeof strategyPin.strategy_release_id !== 'string' ||
    typeof strategyPin.implementation_digest !== 'string' ||
    typeof strategyPin.state_schema_hash !== 'string' ||
    !Array.isArray(plan.model_catalog) ||
    !Array.isArray(plan.capability_catalog) ||
    !Array.isArray(plan.instruction_skills) ||
    !Array.isArray(plan.gates)
  )
    invalidCheckpoint('$.plan', 'compiled AgentPlan omits required Strategy runtime facts');
  return { plan, strategyPin, schemas, limits };
}

function counters(value: unknown): JsonRecord & {
  model_attempts: number;
  capability_calls: number;
  committed_usage_receipts: number;
  budget_exhausted: boolean;
} {
  const result = record(boundedDataSnapshot(value, 'closure'), '$.counters');
  if (
    result.schema_version !== 'strategy-counter-snapshot/1' ||
    !Number.isSafeInteger(result.model_attempts) ||
    (result.model_attempts as number) < 0 ||
    !Number.isSafeInteger(result.capability_calls) ||
    (result.capability_calls as number) < 0 ||
    !Number.isSafeInteger(result.committed_usage_receipts) ||
    (result.committed_usage_receipts as number) < 0 ||
    typeof result.budget_exhausted !== 'boolean'
  )
    invalidCheckpoint('$.counters', 'counter snapshot failed its closed nonnegative contract');
  const keys = Object.keys(result).sort();
  const expected = [
    'budget_exhausted',
    'capability_calls',
    'committed_usage_receipts',
    'model_attempts',
    'schema_version',
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    invalidCheckpoint('$.counters', 'counter snapshot contains unknown fields');
  return result as ReturnType<typeof counters>;
}

function verifyCheckpoint(
  input: unknown,
  expectedHash: string,
  plan: JsonRecord,
  strategyPin: JsonRecord,
) {
  const parsed = StrategyCheckpointV1Schema.safeParse(boundedDataSnapshot(input, 'closure'));
  if (!parsed.success) invalidCheckpoint('$.checkpoint', 'checkpoint failed its closed contract');
  const checkpoint = parsed.data;
  const actual = canonicalSha256ExcludingRootKeys(checkpoint, ['checkpoint_hash']);
  if (
    checkpoint.checkpoint_hash !== actual ||
    actual !== expectedHash ||
    checkpoint.resolved_agent_plan_hash !== plan.plan_hash ||
    checkpoint.capability_closure_hash !== plan.capability_closure_hash ||
    checkpoint.strategy_release_id !== strategyPin.strategy_release_id ||
    checkpoint.implementation_digest !== strategyPin.implementation_digest ||
    checkpoint.state_schema_hash !== strategyPin.state_schema_hash
  )
    invalidCheckpoint('$.checkpoint', 'checkpoint does not extend the exact compiled AgentPlan');
  return checkpoint;
}

export function prepareStrategyStart(input: {
  readonly plan: unknown;
  readonly expected_plan_hash: string;
  readonly run_id: string;
  readonly root_step_id: string;
  readonly input_snapshot_ref: string;
  readonly conversation_projection_ref?: string;
}) {
  const safe = boundedDataSnapshot(input, 'closure') as typeof input;
  const { plan, strategyPin } = trustedPlan(safe.plan, safe.expected_plan_hash);
  const candidate = {
    schema_version: 'agent-strategy-start/1' as const,
    run_id: safe.run_id,
    root_step_id: safe.root_step_id,
    resolved_agent_plan_hash: String(plan.plan_hash),
    capability_closure_hash: String(plan.capability_closure_hash),
    strategy_pin: strategyPin,
    input_snapshot_ref: safe.input_snapshot_ref,
    role_context_hash: String(plan.role_context_hash),
    ...(safe.conversation_projection_ref === undefined
      ? {}
      : { conversation_projection_ref: safe.conversation_projection_ref }),
    model_catalog: plan.model_catalog,
    capability_catalog: plan.capability_catalog,
    instruction_skills: plan.instruction_skills,
    limits: {
      schema_version: 'strategy-runtime-limits/1',
      strategy: plan.strategy_limits,
      models: plan.model_limits,
      runtime: plan.runtime_limits,
    },
  };
  const parsed = StrategyStartV1Schema.safeParse(candidate);
  if (!parsed.success) invalidCheckpoint('$.strategy_start', 'StrategyStart is not representable');
  return deepFreezeJson(parsed.data);
}

export async function prepareInitialStrategyCheckpoint(input: {
  readonly plan: unknown;
  readonly expected_plan_hash: string;
  readonly checkpoint_id: string;
  readonly run_id: string;
  readonly root_step_id: string;
  readonly durable_state: unknown;
  readonly counters: unknown;
}) {
  const safe = boundedDataSnapshot(input, 'closure') as typeof input;
  const { plan, strategyPin, schemas } = trustedPlan(safe.plan, safe.expected_plan_hash);
  const state = await validateJsonSchemaInstance(schemas.state, safe.durable_state);
  if (canonicalSha256(schemas.state) !== strategyPin.state_schema_hash)
    invalidCheckpoint('$.plan.strategy.schemas.state', 'state schema hash drifted');
  const candidate = {
    schema_version: 'agent-strategy-checkpoint/1' as const,
    checkpoint_id: safe.checkpoint_id,
    run_id: safe.run_id,
    root_step_id: safe.root_step_id,
    strategy_release_id: String(strategyPin.strategy_release_id),
    implementation_digest: String(strategyPin.implementation_digest),
    resolved_agent_plan_hash: String(plan.plan_hash),
    capability_closure_hash: String(plan.capability_closure_hash),
    transition_sequence: 0,
    iteration: 0,
    phase: 'READY' as const,
    durable_state: state,
    state_schema_hash: String(strategyPin.state_schema_hash),
    accepted_observation_refs: [],
    completed_model_attempt_ids: [],
    completed_capability_call_ids: [],
    instruction_skill_activation_ids: [],
    counters: counters(safe.counters),
  };
  const result = { ...candidate, checkpoint_hash: canonicalSha256(candidate) };
  const parsed = StrategyCheckpointV1Schema.safeParse(result);
  if (!parsed.success) invalidCheckpoint('$.checkpoint', 'initial checkpoint is not representable');
  return deepFreezeJson(parsed.data);
}

export function determineStrategyLimitTermination(
  planInput: unknown,
  counterInput: unknown,
  iteration: number,
  nextAction?: 'model' | 'capability',
): StrategyTerminationReasonV1 | undefined {
  const plan = record(planInput, '$.plan');
  const limits = record(plan.strategy_limits, '$.plan.strategy_limits');
  const facts = counters(counterInput);
  if (facts.budget_exhausted) return 'BUDGET_EXHAUSTED';
  if (iteration >= Number(limits.max_iterations)) return 'MAX_ITERATIONS';
  if (nextAction === 'model' && facts.model_attempts >= Number(limits.max_model_attempts))
    return 'MAX_MODEL_ATTEMPTS';
  if (nextAction === 'capability' && facts.capability_calls >= Number(limits.max_tool_calls))
    return 'MAX_TOOL_CALLS';
  return undefined;
}

export async function prepareStrategyDecisionTransition(input: {
  readonly plan: unknown;
  readonly expected_plan_hash: string;
  readonly checkpoint: unknown;
  readonly expected_checkpoint_hash: string;
  readonly checkpoint_id: string;
  readonly decision: unknown;
  readonly durable_state: unknown;
  readonly counters: unknown;
}) {
  const safe = boundedDataSnapshot(input, 'closure') as typeof input;
  const { plan, strategyPin, schemas } = trustedPlan(safe.plan, safe.expected_plan_hash);
  const current = verifyCheckpoint(
    safe.checkpoint,
    safe.expected_checkpoint_hash,
    plan,
    strategyPin,
  );
  if (current.phase !== 'READY' && current.phase !== 'RESUMING')
    invalidCheckpoint('$.checkpoint.phase', 'only READY or RESUMING can compute a Decision');
  const facts = counters(safe.counters);
  const terminal = determineStrategyLimitTermination(plan, facts, current.iteration);
  if (terminal !== undefined)
    invalidDecision('$.decision', `Strategy limit requires terminal reason ${terminal}`);
  const parsed = StrategyDecisionV1Schema.safeParse(safe.decision);
  if (!parsed.success) invalidDecision('$.decision', 'Decision failed its closed ABI contract');
  try {
    await validateJsonSchemaInstance(schemas.decision, parsed.data);
  } catch (error) {
    return invalidDecision(
      '$.decision',
      `Decision failed its published Strategy schema (${error instanceof Error ? error.message : 'invalid'})`,
    );
  }
  const state = await validateJsonSchemaInstance(schemas.state, safe.durable_state);
  const decision = parsed.data;
  if (canonicalSha256(schemas.decision) !== strategyPin.decision_schema_hash)
    invalidCheckpoint('$.plan.strategy.schemas.decision', 'decision schema hash drifted');
  const actionLimit = determineStrategyLimitTermination(
    plan,
    facts,
    current.iteration,
    decision.kind === 'request_model'
      ? 'model'
      : decision.kind === 'invoke_capability'
        ? 'capability'
        : undefined,
  );
  if (actionLimit !== undefined)
    invalidDecision('$.decision', `Strategy action requires terminal reason ${actionLimit}`);
  const transitionSequence = current.transition_sequence + 1;
  const operationId = canonicalSha256({
    schema_version: 'strategy-logical-action-id/1',
    run_id: current.run_id,
    root_step_id: current.root_step_id,
    transition_sequence: transitionSequence,
    decision_kind: decision.kind,
  });
  let phase: StrategyCheckpointV1['phase'];
  let pendingAction: JsonRecord | undefined;
  switch (decision.kind) {
    case 'request_model': {
      const model = (plan.model_catalog as unknown[]).find(
        (value) =>
          record(value, '$.plan.model_catalog').descriptor_id === decision.model_descriptor_id,
      );
      if (model === undefined)
        invalidDecision('$.decision.model_descriptor_id', 'model is outside the compiled catalog');
      phase = 'MODEL_PENDING';
      pendingAction = {
        schema_version: 'pending-strategy-action/1',
        action_kind: 'model',
        operation_id: operationId,
        model_descriptor_id: decision.model_descriptor_id,
        request_hash: canonicalSha256(decision.request),
        retry_policy_ref: decision.retry_policy_ref,
      };
      break;
    }
    case 'invoke_capability': {
      const capability = (plan.capability_catalog as unknown[]).find((value) => {
        const descriptor = record(value, '$.plan.capability_catalog');
        return descriptor.binding_path === decision.binding_path;
      });
      if (capability === undefined)
        invalidDecision(
          '$.decision.binding_path',
          'capability path is outside the compiled catalog',
        );
      const descriptor = record(capability, '$.plan.capability_catalog');
      const operation = (descriptor.operations as unknown[]).find(
        (value) =>
          record(value, '$.plan.capability_catalog.operations').contract_hash ===
          decision.operation_contract_hash,
      );
      if (operation === undefined)
        invalidDecision('$.decision.operation_contract_hash', 'operation is outside the catalog');
      const operationRecord = record(operation, '$.plan.capability_catalog.operations');
      if (operationRecord.input_schema === undefined)
        invalidCheckpoint('$.plan.capability_catalog.operations', 'input schema is absent');
      try {
        await validateJsonSchemaInstance(operationRecord.input_schema, decision.input);
      } catch {
        invalidDecision('$.decision.input', 'capability input failed its compiled schema');
      }
      phase = 'CAPABILITY_PENDING';
      pendingAction = {
        schema_version: 'pending-strategy-action/1',
        action_kind: 'capability',
        operation_id: operationId,
        binding_path: decision.binding_path,
        operation_contract_hash: decision.operation_contract_hash,
        input_hash: canonicalSha256(decision.input),
      };
      break;
    }
    case 'activate_instruction_skill': {
      const skill = (plan.instruction_skills as unknown[]).find(
        (value) =>
          record(value, '$.plan.instruction_skills').binding_id === decision.skill_binding_id,
      );
      if (skill === undefined || record(skill, '$.plan.instruction_skills').script_mode !== 'inert')
        invalidDecision(
          '$.decision.skill_binding_id',
          'Skill is outside the inert compiled catalog',
        );
      phase = 'CAPABILITY_PENDING';
      pendingAction = {
        schema_version: 'pending-strategy-action/1',
        action_kind: 'instruction_skill',
        operation_id: operationId,
        skill_binding_id: decision.skill_binding_id,
      };
      break;
    }
    case 'suspend_for_human': {
      const gate = (plan.gates as unknown[]).find((value) => {
        const descriptor = record(value, '$.plan.gates');
        return (
          descriptor.gate_spec_id === decision.gate.gate_spec_id &&
          descriptor.gate_spec_hash === decision.gate.gate_spec_hash
        );
      });
      if (gate === undefined)
        invalidDecision('$.decision.gate', 'Gate is outside the compiled catalog');
      const gateRecord = record(gate, '$.plan.gates');
      const intent = decision.gate.operation_intent;
      if (
        intent.operation_intent_hash !==
        canonicalSha256ExcludingRootKeys(intent, ['operation_intent_hash'])
      )
        invalidDecision('$.decision.gate.operation_intent_hash', 'Gate intent hash drifted');
      if (intent.intent_kind === 'collect_input') {
        if (
          gateRecord.kind !== 'input' ||
          gateRecord.decision_schema_hash !== intent.requested_input_contract_hash
        )
          invalidDecision('$.decision.gate', 'input Gate contract does not match');
      } else {
        if (gateRecord.kind !== 'approval')
          invalidDecision('$.decision.gate', 'approval intent requires an approval Gate');
        const capability = (plan.capability_catalog as unknown[]).find(
          (value) =>
            record(value, '$.plan.capability_catalog').binding_path === intent.binding_path,
        );
        const protectedHashes = gateRecord.protected_operation_contract_hashes;
        if (
          capability === undefined ||
          !Array.isArray(protectedHashes) ||
          !protectedHashes.includes(intent.operation_contract_hash) ||
          !(record(capability, '$.plan.capability_catalog').operations as unknown[]).some(
            (value) =>
              record(value, '$.plan.capability_catalog.operations').contract_hash ===
              intent.operation_contract_hash,
          )
        )
          invalidDecision('$.decision.gate', 'approval Gate operation is outside the catalog');
      }
      phase = 'SUSPENDED';
      pendingAction = {
        schema_version: 'pending-strategy-action/1',
        action_kind: 'human_gate',
        operation_id: operationId,
        gate_spec_id: decision.gate.gate_spec_id,
        gate_spec_hash: decision.gate.gate_spec_hash,
        operation_intent_hash: intent.operation_intent_hash,
      };
      break;
    }
    case 'complete':
      if (
        plan.output_schema === undefined ||
        decision.output_schema_hash !== plan.output_schema_hash
      )
        invalidDecision('$.decision.output_schema_hash', 'output schema does not match AgentPlan');
      try {
        await validateJsonSchemaInstance(plan.output_schema, decision.output);
      } catch {
        invalidDecision('$.decision.output', 'output failed the compiled Agent schema');
      }
      phase = 'TERMINATING';
      break;
    case 'fail':
      phase = 'TERMINATING';
      break;
  }
  const nextCandidate = {
    schema_version: 'agent-strategy-checkpoint/1' as const,
    checkpoint_id: safe.checkpoint_id,
    previous_checkpoint_hash: current.checkpoint_hash,
    run_id: current.run_id,
    root_step_id: current.root_step_id,
    strategy_release_id: current.strategy_release_id,
    implementation_digest: current.implementation_digest,
    resolved_agent_plan_hash: current.resolved_agent_plan_hash,
    capability_closure_hash: current.capability_closure_hash,
    transition_sequence: transitionSequence,
    iteration: current.iteration + 1,
    phase,
    durable_state: state,
    state_schema_hash: current.state_schema_hash,
    accepted_observation_refs: current.accepted_observation_refs,
    completed_model_attempt_ids: current.completed_model_attempt_ids,
    completed_capability_call_ids: current.completed_capability_call_ids,
    instruction_skill_activation_ids: current.instruction_skill_activation_ids,
    ...(pendingAction === undefined ? {} : { pending_action: pendingAction }),
    counters: facts,
    ...(decision.kind === 'complete'
      ? { termination_reason: 'COMPLETED' as const }
      : decision.kind === 'fail'
        ? { termination_reason: decision.reason }
        : {}),
  };
  const next = {
    ...nextCandidate,
    checkpoint_hash: canonicalSha256(nextCandidate),
  };
  const checked = StrategyCheckpointV1Schema.safeParse(next);
  if (!checked.success) invalidCheckpoint('$.checkpoint', 'next checkpoint is not representable');
  return deepFreezeJson({
    checkpoint: checked.data,
    decision_hash: canonicalSha256(decision),
    outbox: {
      schema_version: 'strategy-action-outbox/1',
      operation_id: operationId,
      decision_kind: decision.kind,
      decision_hash: canonicalSha256(decision),
    },
  });
}

export async function prepareStrategyActionObservation(input: {
  readonly plan: unknown;
  readonly expected_plan_hash: string;
  readonly checkpoint: unknown;
  readonly expected_checkpoint_hash: string;
  readonly checkpoint_id: string;
  readonly action_result: unknown;
  readonly observation?: unknown;
  readonly counters: unknown;
}) {
  const safe = boundedDataSnapshot(input, 'closure') as typeof input;
  const { plan, strategyPin, schemas } = trustedPlan(safe.plan, safe.expected_plan_hash);
  const current = verifyCheckpoint(
    safe.checkpoint,
    safe.expected_checkpoint_hash,
    plan,
    strategyPin,
  );
  if (current.phase !== 'MODEL_PENDING' && current.phase !== 'CAPABILITY_PENDING')
    invalidObservation('$.checkpoint.phase', 'checkpoint has no reconcilable action');
  const pending = record(current.pending_action, '$.checkpoint.pending_action');
  const result = record(safe.action_result, '$.action_result');
  const baseKeys = ['action_kind', 'completion_id', 'operation_id', 'schema_version', 'status'];
  const status = result.status;
  const expectedKeys =
    status === 'SUCCEEDED'
      ? [...baseKeys, 'observation_hash', 'observation_ref', 'receipt_hash']
      : status === 'FAILED'
        ? [...baseKeys, 'safe_error']
        : baseKeys;
  const actualKeys = Object.keys(result).sort();
  expectedKeys.sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    result.schema_version !== 'strategy-action-result/1' ||
    !['model', 'capability', 'instruction_skill'].includes(String(result.action_kind)) ||
    !['SUCCEEDED', 'FAILED', 'OUTCOME_UNKNOWN'].includes(String(status)) ||
    typeof result.operation_id !== 'string' ||
    typeof result.completion_id !== 'string' ||
    result.completion_id.length === 0
  )
    invalidObservation('$.action_result', 'action result failed its closed contract');
  if (result.operation_id !== pending.operation_id || result.action_kind !== pending.action_kind)
    invalidObservation('$.action_result', 'foreign action result cannot satisfy pending work');
  if (result.action_kind === 'model' && current.phase !== 'MODEL_PENDING')
    invalidObservation('$.action_result.action_kind', 'model result requires MODEL_PENDING');
  if (result.action_kind !== 'model' && current.phase !== 'CAPABILITY_PENDING')
    invalidObservation(
      '$.action_result.action_kind',
      'capability or Skill result requires CAPABILITY_PENDING',
    );
  if (result.action_kind === 'instruction_skill' && status === 'OUTCOME_UNKNOWN')
    invalidObservation(
      '$.action_result.status',
      'inert Skill activation cannot have unknown outcome',
    );

  const facts = counters(safe.counters);
  let phase: StrategyCheckpointV1['phase'] = 'READY';
  let terminationReason: StrategyTerminationReasonV1 | undefined;
  let acceptedObservationRefs = current.accepted_observation_refs;
  if (status === 'SUCCEEDED') {
    if (
      safe.observation === undefined ||
      typeof result.observation_ref !== 'string' ||
      result.observation_ref.length === 0 ||
      typeof result.observation_hash !== 'string' ||
      typeof result.receipt_hash !== 'string' ||
      canonicalSha256(safe.observation) !== result.observation_hash
    )
      invalidObservation('$.observation', 'successful action requires exact durable observation');
    try {
      await validateJsonSchemaInstance(schemas.observation, safe.observation);
    } catch {
      invalidObservation('$.observation', 'observation failed the published Strategy schema');
    }
    if (canonicalSha256(schemas.observation) !== strategyPin.observation_schema_hash)
      invalidCheckpoint('$.plan.strategy.schemas.observation', 'observation schema hash drifted');
    acceptedObservationRefs = [...current.accepted_observation_refs, result.observation_ref];
  } else {
    if (safe.observation !== undefined)
      invalidObservation('$.observation', 'non-successful action cannot inject an observation');
    phase = 'TERMINATING';
    terminationReason =
      status === 'OUTCOME_UNKNOWN'
        ? result.action_kind === 'model'
          ? 'MODEL_OUTCOME_UNKNOWN'
          : 'SIDE_EFFECT_UNKNOWN'
        : result.action_kind === 'model'
          ? 'MODEL_FAILED'
          : result.action_kind === 'capability'
            ? 'CAPABILITY_FAILED'
            : 'INTERNAL_FAILURE';
  }

  const completedModelAttempts =
    result.action_kind === 'model'
      ? [...current.completed_model_attempt_ids, result.completion_id]
      : current.completed_model_attempt_ids;
  const completedCapabilityCalls =
    result.action_kind === 'capability'
      ? [...current.completed_capability_call_ids, result.completion_id]
      : current.completed_capability_call_ids;
  const completedSkillActivations =
    result.action_kind === 'instruction_skill'
      ? [...current.instruction_skill_activation_ids, result.completion_id]
      : current.instruction_skill_activation_ids;
  const candidate = {
    schema_version: 'agent-strategy-checkpoint/1' as const,
    checkpoint_id: safe.checkpoint_id,
    previous_checkpoint_hash: current.checkpoint_hash,
    run_id: current.run_id,
    root_step_id: current.root_step_id,
    strategy_release_id: current.strategy_release_id,
    implementation_digest: current.implementation_digest,
    resolved_agent_plan_hash: current.resolved_agent_plan_hash,
    capability_closure_hash: current.capability_closure_hash,
    transition_sequence: current.transition_sequence,
    iteration: current.iteration,
    phase,
    durable_state: current.durable_state,
    state_schema_hash: current.state_schema_hash,
    accepted_observation_refs: acceptedObservationRefs,
    completed_model_attempt_ids: completedModelAttempts,
    completed_capability_call_ids: completedCapabilityCalls,
    instruction_skill_activation_ids: completedSkillActivations,
    counters: facts,
    ...(terminationReason === undefined ? {} : { termination_reason: terminationReason }),
  };
  const checkpoint = { ...candidate, checkpoint_hash: canonicalSha256(candidate) };
  const parsed = StrategyCheckpointV1Schema.safeParse(checkpoint);
  if (!parsed.success)
    invalidObservation('$.checkpoint', 'reconciled checkpoint failed its closed contract');
  return deepFreezeJson(parsed.data);
}

export function decideStrategyRecovery(checkpoint: Pick<StrategyCheckpointV1, 'phase'>) {
  return {
    READY: 'COMPUTE_DECISION',
    MODEL_PENDING: 'RECONCILE_MODEL',
    CAPABILITY_PENDING: 'RECONCILE_CAPABILITY',
    SUSPENDED: 'WAIT_FOR_HUMAN',
    RESUMING: 'COMPUTE_DECISION',
    TERMINATING: 'FINALIZE',
    TERMINAL: 'STOP',
  }[checkpoint.phase];
}

export function decideStrategyModelAttemptRecovery(input: {
  readonly status:
    | 'ABSENT'
    | 'PREPARED'
    | 'DISPATCHED'
    | 'SUCCEEDED'
    | 'FAILED'
    | 'OUTCOME_UNKNOWN';
  readonly provider_supports_idempotency_key: boolean;
  readonly provider_supports_result_query: boolean;
}) {
  const safe = boundedDataSnapshot(input, 'closure') as typeof input;
  if (
    !['ABSENT', 'PREPARED', 'DISPATCHED', 'SUCCEEDED', 'FAILED', 'OUTCOME_UNKNOWN'].includes(
      safe.status,
    ) ||
    typeof safe.provider_supports_idempotency_key !== 'boolean' ||
    typeof safe.provider_supports_result_query !== 'boolean'
  )
    invalidObservation('$.model_attempt', 'model recovery facts are invalid');
  switch (safe.status) {
    case 'ABSENT':
      return 'PREPARE_ATTEMPT' as const;
    case 'PREPARED':
      return safe.provider_supports_idempotency_key
        ? ('DISPATCH_WITH_STABLE_KEY' as const)
        : ('DISPATCH_ONCE' as const);
    case 'DISPATCHED':
      if (safe.provider_supports_result_query) return 'QUERY_ORIGINAL_ATTEMPT' as const;
      return safe.provider_supports_idempotency_key
        ? ('RETRY_WITH_STABLE_KEY' as const)
        : ('MARK_OUTCOME_UNKNOWN' as const);
    case 'SUCCEEDED':
      return 'ACCEPT_COMMITTED_RECEIPT' as const;
    case 'FAILED':
      return 'APPLY_FIXED_RETRY_POLICY' as const;
    case 'OUTCOME_UNKNOWN':
      return 'TERMINATE_OUTCOME_UNKNOWN' as const;
  }
}
