import { z } from 'zod';

import {
  AgentReleasePinV1Schema,
  AgentStrategyPinV1Schema,
  BindingKindV1Schema,
  InstructionSkillReleasePinV1Schema,
  PublicCapabilityHandleV1Schema,
  PublishedResourcePinV1Schema,
} from './agent-release-v1.js';
import {
  CompiledGateSpecEntryV1Schema,
  OperationContractPinV1Schema,
} from './compiled-capability-closure-v1.js';
import { StrategyModelPolicyV1Schema } from './agent-strategy-source-v1.js';
import {
  CanonicalBindingPathV1Schema,
  ContractHashSchema,
  hasUniqueBy,
  hasUniqueStrings,
  JsonObjectSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
} from './primitives.js';

export const G1JoinChildCeilingV1Schema = z.strictObject({
  schema_version: z.literal('g1-join-child-ceiling/1'),
  target_ref: NonEmptyStringSchema,
  max_calls: NonNegativeIntegerSchema,
  max_depth: NonNegativeIntegerSchema,
  max_ttl_seconds: NonNegativeIntegerSchema,
  max_budget_credits: z.string().regex(/^(0|[1-9][0-9]*)$/u),
  delegation_policy_hash: ContractHashSchema,
});

const CompiledAgentCapabilityCatalogEntryV1Schema = z
  .strictObject({
    schema_version: z.literal('agent-capability-catalog-entry/1'),
    local_binding_id: NonEmptyStringSchema,
    binding_path: CanonicalBindingPathV1Schema,
    binding_kind: BindingKindV1Schema,
    target: PublishedResourcePinV1Schema,
    operations: z
      .array(OperationContractPinV1Schema.extend({ input_schema: JsonObjectSchema }))
      .min(1)
      .max(128)
      .refine((values) => hasUniqueBy(values, (value) => value.contract_hash)),
    effective_policy_hash: ContractHashSchema,
    async_child_policy_hash: ContractHashSchema.optional(),
    join_child_ceiling: G1JoinChildCeilingV1Schema.optional(),
    approval_gate_spec: z
      .strictObject({ gate_spec_id: NonEmptyStringSchema, gate_spec_hash: ContractHashSchema })
      .optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.async_child_policy_hash !== undefined && entry.binding_kind !== 'subagent')
      ctx.addIssue({
        code: 'custom',
        path: ['async_child_policy_hash'],
        message: 'only an async SubAgent capability may carry a child policy hash',
      });
    if ((entry.join_child_ceiling !== undefined) !== (entry.async_child_policy_hash !== undefined))
      ctx.addIssue({
        code: 'custom',
        path: ['join_child_ceiling'],
        message: 'an async SubAgent policy requires its compiled execution ceiling',
      });
  });

const CompiledAgentInstructionSkillCatalogEntryV1Schema = z.strictObject({
  schema_version: z.literal('agent-instruction-skill-catalog-entry/1'),
  binding_id: NonEmptyStringSchema,
  skill_pin: InstructionSkillReleasePinV1Schema,
  content_hash: ContractHashSchema,
  entry_content_hash: ContractHashSchema,
  activation: z.enum(['always', 'model_selected', 'explicit']),
  script_mode: z.literal('inert'),
  context_budget_tokens: NonNegativeIntegerSchema,
  allowed_capability_paths: z.array(CanonicalBindingPathV1Schema).max(128).refine(hasUniqueStrings),
});

const CompiledPublicCapabilityHandleV1Schema = PublicCapabilityHandleV1Schema.extend({
  binding_path: CanonicalBindingPathV1Schema,
  enabled: z.boolean(),
});

export const CompiledAgentPlanV1Schema = z
  .strictObject({
    schema_version: z.literal('compiled-agent-plan/1'),
    agent_release: AgentReleasePinV1Schema,
    source_semantic_hash: ContractHashSchema,
    capability_closure_hash: ContractHashSchema,
    resolved_execution_plan_hash: ContractHashSchema,
    strategy: z.strictObject({
      full_pin: PublishedResourcePinV1Schema.extend({
        published_resource_kind: z.literal('AGENT_STRATEGY_RELEASE'),
      }),
      strategy_pin: AgentStrategyPinV1Schema,
      component_hashes: z.record(z.string(), ContractHashSchema),
      config: JsonObjectSchema,
      schemas: z.strictObject({
        config: JsonObjectSchema,
        input: JsonObjectSchema,
        state: JsonObjectSchema,
        decision: JsonObjectSchema,
        observation: JsonObjectSchema,
      }),
    }),
    role_context_hash: ContractHashSchema,
    input_schema_hash: ContractHashSchema,
    output_schema: JsonObjectSchema.optional(),
    output_schema_hash: ContractHashSchema.optional(),
    model_catalog: StrategyModelPolicyV1Schema.shape.models,
    model_limits: z.strictObject({
      maximum_input_tokens: NonNegativeIntegerSchema,
      maximum_output_tokens: NonNegativeIntegerSchema,
    }),
    capability_catalog: z
      .array(CompiledAgentCapabilityCatalogEntryV1Schema)
      .max(128)
      .refine((values) => hasUniqueBy(values, (value) => value.binding_path))
      .refine((values) => hasUniqueBy(values, (value) => value.local_binding_id)),
    instruction_skills: z
      .array(CompiledAgentInstructionSkillCatalogEntryV1Schema)
      .max(128)
      .refine((values) => hasUniqueBy(values, (value) => value.binding_id)),
    gates: z
      .array(CompiledGateSpecEntryV1Schema)
      .max(128)
      .refine((values) => hasUniqueBy(values, (value) => value.gate_spec_id)),
    public_capability_handles: z
      .array(CompiledPublicCapabilityHandleV1Schema)
      .max(128)
      .refine((values) => hasUniqueBy(values, (value) => value.public_handle)),
    runtime_limits: JsonObjectSchema,
    strategy_limits: z.strictObject({
      max_iterations: NonNegativeIntegerSchema,
      max_model_attempts: NonNegativeIntegerSchema,
      max_tool_calls: NonNegativeIntegerSchema,
    }),
    checkpoint_contract_version: z.literal('agent-strategy-checkpoint/1'),
    plan_hash: ContractHashSchema,
  })
  .superRefine((plan, ctx) => {
    if ((plan.output_schema === undefined) !== (plan.output_schema_hash === undefined))
      ctx.addIssue({
        code: 'custom',
        path: ['output_schema_hash'],
        message: 'output schema and hash must be present together',
      });
    if (
      plan.strategy.full_pin.resource_id !== plan.strategy.strategy_pin.strategy_id ||
      plan.strategy.full_pin.resource_version_id !==
        plan.strategy.strategy_pin.strategy_release_id ||
      plan.strategy.full_pin.contract_hash !== plan.strategy.strategy_pin.contract_hash
    )
      ctx.addIssue({
        code: 'custom',
        path: ['strategy'],
        message: 'Strategy full pin and ABI pin must identify one release',
      });
  });

export type CompiledAgentPlanV1 = z.infer<typeof CompiledAgentPlanV1Schema>;
