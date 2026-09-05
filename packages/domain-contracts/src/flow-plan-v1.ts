import { z } from 'zod';

import { PublishedResourcePinV1Schema } from './agent-release-v1.js';
import { UuidV1Schema } from './auth-v1.js';
import { CapabilityBudgetV1Schema } from './capability-policy-v1.js';
import { ErrorPolicyV1Schema, RetryPolicyV1Schema } from './flow-ir-v1.js';
import {
  boundedNonBlankStringSchema,
  ContractHashSchema,
  hasUniqueStrings,
  JsonValueSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  PositiveMillisecondsSchema,
  Sha256HexV1Schema,
} from './primitives.js';
import { RunLeaseFencingTokenV1Schema, RunPositiveSequenceV1Schema } from './run-execution-v1.js';

const flowPlanStepBase = {
  node_id: NonEmptyStringSchema,
  node_key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u),
  canonical_node_path_hash: Sha256HexV1Schema,
  topology_rank: NonNegativeIntegerSchema,
  predecessor_node_ids: z.array(NonEmptyStringSchema).max(64).refine(hasUniqueStrings),
  input_bindings: z.record(z.string(), JsonValueSchema),
  output_schema_hash: Sha256HexV1Schema,
  retry: RetryPolicyV1Schema.optional(),
  error_policy: ErrorPolicyV1Schema.optional(),
  timeout_ms: PositiveMillisecondsSchema,
};

export const CompiledFlowPlanV1Schema = z
  .strictObject({
    schema_version: z.literal('compiled-flow-plan/1'),
    flow_version: PublishedResourcePinV1Schema.extend({
      published_resource_kind: z.literal('FLOW_VERSION'),
    }),
    source_semantic_hash: ContractHashSchema,
    capability_closure_hash: Sha256HexV1Schema,
    resolved_execution_plan_hash: Sha256HexV1Schema,
    input_schema_hash: Sha256HexV1Schema,
    output_schema_hash: Sha256HexV1Schema,
    checkpoint_contract_version: z.literal('flow-step-checkpoint/1'),
    steps: z.tuple([
      z.strictObject({
        ...flowPlanStepBase,
        node_type: z.literal('start'),
        topology_rank: z.literal(0),
        predecessor_node_ids: z.tuple([]),
      }),
      z.strictObject({
        ...flowPlanStepBase,
        node_type: z.literal('llm'),
        topology_rank: z.literal(1),
        predecessor_node_ids: z.tuple([NonEmptyStringSchema]),
        model: PublishedResourcePinV1Schema.extend({
          published_resource_kind: z.literal('SYSTEM_RELEASE'),
        }),
        credential_requirement_id: NonEmptyStringSchema,
        credential_mapping_hash: Sha256HexV1Schema,
        credential_material_identity_hash: Sha256HexV1Schema,
        prompt: JsonValueSchema,
        temperature: z.number().min(0).max(2),
        budget: CapabilityBudgetV1Schema,
      }),
      z.strictObject({
        ...flowPlanStepBase,
        node_type: z.literal('output'),
        topology_rank: z.literal(2),
        predecessor_node_ids: z.tuple([NonEmptyStringSchema]),
      }),
    ]),
    compiled_hash: Sha256HexV1Schema,
  })
  .superRefine((plan, ctx) => {
    const [start, llm, output] = plan.steps;
    if (
      llm.predecessor_node_ids[0] !== start.node_id ||
      output.predecessor_node_ids[0] !== llm.node_id
    )
      ctx.addIssue({
        code: 'custom',
        path: ['steps'],
        message: 'compiled Flow steps must retain the exact Start to LLM to Output causality',
      });
    if (
      new Set(plan.steps.map((step) => step.node_id)).size !== plan.steps.length ||
      new Set(plan.steps.map((step) => step.canonical_node_path_hash)).size !== plan.steps.length
    )
      ctx.addIssue({
        code: 'custom',
        path: ['steps'],
        message: 'compiled Flow step identities and paths must be unique',
      });
  });

const checkpointBase = {
  schema_version: z.literal('flow-step-checkpoint/1'),
  run_id: UuidV1Schema,
  flow_execution_id: UuidV1Schema,
  flow_plan_hash: Sha256HexV1Schema,
  checkpoint_sequence: RunPositiveSequenceV1Schema,
  previous_checkpoint_hash: Sha256HexV1Schema.optional(),
  execution_fence: RunLeaseFencingTokenV1Schema,
  node_id: NonEmptyStringSchema,
  canonical_node_path_hash: Sha256HexV1Schema,
  attempt: PositiveIntegerSchema,
  predecessor_checkpoint_hashes: z
    .array(Sha256HexV1Schema)
    .max(64)
    .refine(hasUniqueStrings)
    .refine((values) =>
      values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value),
    ),
  output_ref: NonEmptyStringSchema,
  output_hash: Sha256HexV1Schema,
};

export const FlowStepCheckpointV1Schema = z.discriminatedUnion('node_type', [
  z.strictObject({
    ...checkpointBase,
    node_type: z.enum(['start', 'output']),
    model_usage_receipt_id: z.never().optional(),
    model_usage_receipt_hash: z.never().optional(),
    checkpoint_hash: Sha256HexV1Schema,
  }),
  z.strictObject({
    ...checkpointBase,
    node_type: z.literal('llm'),
    model_usage_receipt_id: UuidV1Schema,
    model_usage_receipt_hash: Sha256HexV1Schema,
    checkpoint_hash: Sha256HexV1Schema,
  }),
]);

export const FlowModelUsageReceiptV1Schema = z
  .strictObject({
    schema_version: z.literal('flow-model-usage-receipt/1'),
    model_usage_receipt_id: UuidV1Schema,
    run_id: UuidV1Schema,
    flow_execution_id: UuidV1Schema,
    flow_plan_hash: Sha256HexV1Schema,
    node_id: NonEmptyStringSchema,
    canonical_node_path_hash: Sha256HexV1Schema,
    model: PublishedResourcePinV1Schema.extend({
      published_resource_kind: z.literal('SYSTEM_RELEASE'),
    }),
    model_attempt_number: PositiveIntegerSchema,
    operation_key: boundedNonBlankStringSchema(300, 'model operation key'),
    provider_request_hash: Sha256HexV1Schema,
    result_payload_hash: Sha256HexV1Schema,
    usage: CapabilityBudgetV1Schema,
    receipt_hash: Sha256HexV1Schema,
  })
  .refine(
    (receipt) =>
      receipt.usage.total_tokens === receipt.usage.input_tokens + receipt.usage.output_tokens,
    'model usage total tokens must equal input plus output tokens',
  );

export type CompiledFlowPlanV1 = z.infer<typeof CompiledFlowPlanV1Schema>;
export type FlowStepCheckpointV1 = z.infer<typeof FlowStepCheckpointV1Schema>;
export type FlowModelUsageReceiptV1 = z.infer<typeof FlowModelUsageReceiptV1Schema>;
