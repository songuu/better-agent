import { z } from 'zod';
import { UuidV1Schema } from './auth-v1.js';
import {
  hasUniqueBy,
  hasUniqueStrings,
  JsonObjectSchema,
  PostgresTextV1Schema,
  Sha256HexV1Schema,
} from './primitives.js';

const Text = PostgresTextV1Schema.min(1).max(4_096);
const Id = UuidV1Schema.refine((value) => value === value.toLowerCase());
const Hash = Sha256HexV1Schema.length(71);
const Count = z.number().int().nonnegative().max(1_000_000);
const Names = z.array(Text).max(128).refine(hasUniqueStrings);

export const StrategyModelPolicyV1Schema = z.strictObject({
  schema_version: z.literal('strategy-model-policy/1'),
  models: z
    .array(
      z.strictObject({
        descriptor_id: Text,
        provider_id: Text,
        model_id: Text,
        model_revision: Text.refine(
          (value) => !['latest', 'floating_latest'].includes(value.toLowerCase()),
        ),
        model_contract_hash: Hash,
      }),
    )
    .max(128)
    .refine((values) => hasUniqueBy(values, (value) => value.descriptor_id)),
  maximum_input_tokens: Count,
  maximum_output_tokens: Count,
});

export const StrategySandboxProfileV1Schema = z.strictObject({
  schema_version: z.literal('strategy-sandbox-profile/1'),
  profile_id: Text,
  host_abi: z.literal('agent-strategy-abi/1'),
  network: z.literal('deny'),
  filesystem: z.literal('deny'),
  database: z.literal('deny'),
  secrets: z.literal('deny'),
  maximum_memory_bytes: z.number().int().min(1).max(1_073_741_824),
  maximum_instruction_count: z.number().int().min(1).max(1_000_000_000),
});

export const AgentStrategySourceV1Schema = z.strictObject({
  schema_version: z.literal('agent-strategy-source/1'),
  strategy_id: Id,
  strategy_release_id: Id,
  abi_version: z.literal('agent-strategy-abi/1'),
  implementation_digest: Hash,
  config: JsonObjectSchema,
  config_schema: JsonObjectSchema,
  input_schema: JsonObjectSchema,
  state_schema: JsonObjectSchema,
  decision_schema: JsonObjectSchema,
  observation_schema: JsonObjectSchema,
  sandbox_profile: StrategySandboxProfileV1Schema,
  allowed_model_policy: StrategyModelPolicyV1Schema,
  allowed_capability_binding_ids: Names,
  allowed_gate_spec_ids: Names,
  max_iterations: Count.min(1),
  max_model_attempts: Count,
  max_tool_calls: Count,
});

export const AgentStrategySourceCandidateV1Schema = z.strictObject({
  schema_version: z.literal('agent-strategy-source-candidate/1'),
  workspace_id: Id,
  document: AgentStrategySourceV1Schema,
});

export type AgentStrategySourceV1 = z.infer<typeof AgentStrategySourceV1Schema>;
export type StrategyModelPolicyV1 = z.infer<typeof StrategyModelPolicyV1Schema>;
