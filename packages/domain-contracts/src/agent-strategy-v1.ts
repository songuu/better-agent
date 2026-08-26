import { z } from 'zod';

import { AgentStrategyPinV1Schema } from './agent-release-v1.js';
import {
  CanonicalBindingPathV1Schema,
  ContractHashSchema,
  hasUniqueStrings,
  JsonObjectSchema,
  JsonValueSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
} from './primitives.js';

export const StrategyTerminationReasonV1Schema = z.enum([
  'COMPLETED',
  'MAX_ITERATIONS',
  'MAX_MODEL_ATTEMPTS',
  'MAX_TOOL_CALLS',
  'BUDGET_EXHAUSTED',
  'USER_CANCELLED',
  'RUN_TIMED_OUT',
  'AUTHORIZATION_REVALIDATION_FAILED',
  'RESOURCE_REVOKED',
  'MODEL_FAILED',
  'MODEL_OUTCOME_UNKNOWN',
  'CAPABILITY_FAILED',
  'SIDE_EFFECT_UNKNOWN',
  'HUMAN_REJECTED',
  'HUMAN_GATE_EXPIRED',
  'INVALID_DECISION',
  'STRATEGY_IMPLEMENTATION_UNAVAILABLE',
  'INTERNAL_FAILURE',
]);

export const StrategyPhaseV1Schema = z.enum([
  'READY',
  'MODEL_PENDING',
  'CAPABILITY_PENDING',
  'SUSPENDED',
  'RESUMING',
  'TERMINATING',
  'TERMINAL',
]);

export const StrategyGateOperationIntentV1Schema = z.union([
  z.strictObject({
    intent_kind: z.literal('collect_input'),
    prompt_arguments_ref: NonEmptyStringSchema,
    prompt_arguments_hash: ContractHashSchema,
    requested_input_contract_hash: ContractHashSchema,
    operation_intent_hash: ContractHashSchema,
  }),
  z.strictObject({
    intent_kind: z.literal('approve_capability'),
    binding_path: CanonicalBindingPathV1Schema,
    operation_contract_hash: ContractHashSchema,
    canonical_input_hash: ContractHashSchema,
    operation_key_hash: ContractHashSchema.optional(),
    operation_intent_hash: ContractHashSchema,
  }),
]);

export const StrategyGateRequestV1Schema = z.strictObject({
  schema_version: z.literal('strategy-gate-request/1'),
  gate_spec_id: NonEmptyStringSchema,
  gate_spec_hash: ContractHashSchema,
  operation_intent: StrategyGateOperationIntentV1Schema,
});

export const StrategyDecisionV1Schema = z.union([
  z.strictObject({
    kind: z.literal('request_model'),
    model_descriptor_id: NonEmptyStringSchema,
    request: JsonObjectSchema,
    retry_policy_ref: NonEmptyStringSchema,
  }),
  z.strictObject({
    kind: z.literal('invoke_capability'),
    binding_path: CanonicalBindingPathV1Schema,
    operation_contract_hash: ContractHashSchema,
    input: JsonValueSchema,
  }),
  z.strictObject({
    kind: z.literal('activate_instruction_skill'),
    skill_binding_id: NonEmptyStringSchema,
  }),
  z.strictObject({
    kind: z.literal('suspend_for_human'),
    gate: StrategyGateRequestV1Schema,
  }),
  z.strictObject({
    kind: z.literal('complete'),
    output: JsonValueSchema,
    output_schema_hash: ContractHashSchema,
  }),
  z.strictObject({
    kind: z.literal('fail'),
    reason: StrategyTerminationReasonV1Schema,
    safe_error: JsonObjectSchema,
  }),
]);

export const StrategyStartV1Schema = z.strictObject({
  schema_version: z.literal('agent-strategy-start/1'),
  run_id: NonEmptyStringSchema,
  root_step_id: NonEmptyStringSchema,
  resolved_agent_plan_hash: ContractHashSchema,
  capability_closure_hash: ContractHashSchema,
  strategy_pin: AgentStrategyPinV1Schema,
  input_snapshot_ref: NonEmptyStringSchema,
  role_context_hash: ContractHashSchema,
  conversation_projection_ref: NonEmptyStringSchema.optional(),
  // Catalog descriptor vocabularies are independent contracts and never include secret material.
  model_catalog: z.array(JsonObjectSchema),
  capability_catalog: z.array(JsonObjectSchema),
  instruction_skills: z.array(JsonObjectSchema),
  limits: JsonObjectSchema,
});

export const StrategyCheckpointV1Schema = z.strictObject({
  schema_version: z.literal('agent-strategy-checkpoint/1'),
  checkpoint_id: NonEmptyStringSchema,
  previous_checkpoint_hash: ContractHashSchema.optional(),
  run_id: NonEmptyStringSchema,
  root_step_id: NonEmptyStringSchema,
  strategy_release_id: NonEmptyStringSchema,
  implementation_digest: ContractHashSchema,
  resolved_agent_plan_hash: ContractHashSchema,
  capability_closure_hash: ContractHashSchema,
  transition_sequence: NonNegativeIntegerSchema,
  iteration: NonNegativeIntegerSchema,
  phase: StrategyPhaseV1Schema,
  durable_state: JsonValueSchema,
  state_schema_hash: ContractHashSchema,
  accepted_observation_refs: z
    .array(NonEmptyStringSchema)
    .refine(hasUniqueStrings, 'accepted observation refs must be unique'),
  completed_model_attempt_ids: z
    .array(NonEmptyStringSchema)
    .refine(hasUniqueStrings, 'completed model attempt ids must be unique'),
  completed_capability_call_ids: z
    .array(NonEmptyStringSchema)
    .refine(hasUniqueStrings, 'completed capability call ids must be unique'),
  instruction_skill_activation_ids: z
    .array(NonEmptyStringSchema)
    .refine(hasUniqueStrings, 'instruction skill activation ids must be unique'),
  // Pending action and counters are persisted projections with their own versioned schemas.
  pending_action: JsonObjectSchema.optional(),
  resume_cursor: NonEmptyStringSchema.optional(),
  counters: JsonObjectSchema,
  termination_reason: StrategyTerminationReasonV1Schema.optional(),
  checkpoint_hash: ContractHashSchema,
});

export type StrategyStartV1 = z.infer<typeof StrategyStartV1Schema>;
export type StrategyDecisionV1 = z.infer<typeof StrategyDecisionV1Schema>;
export type StrategyCheckpointV1 = z.infer<typeof StrategyCheckpointV1Schema>;
