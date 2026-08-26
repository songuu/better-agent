import { z } from 'zod';

import { UuidV1Schema } from './auth-v1.js';
import {
  hasUniqueStrings,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256HexV1Schema,
} from './primitives.js';

export const AgentStrategyReleaseV1Schema = z.strictObject({
  schema_version: z.literal('agent-strategy-release/1'),
  strategy_id: UuidV1Schema,
  strategy_release_id: UuidV1Schema,
  source_draft_revision_id: UuidV1Schema,
  abi_version: z.literal('agent-strategy-abi/1'),
  implementation_digest: Sha256HexV1Schema,
  config_hash: Sha256HexV1Schema,
  input_schema_hash: Sha256HexV1Schema,
  state_schema_hash: Sha256HexV1Schema,
  decision_schema_hash: Sha256HexV1Schema,
  observation_schema_hash: Sha256HexV1Schema,
  sandbox_profile_id: NonEmptyStringSchema,
  allowed_model_policy_hash: Sha256HexV1Schema,
  allowed_capability_binding_ids: z
    .array(NonEmptyStringSchema)
    .refine(hasUniqueStrings, 'allowed capability binding ids must be unique'),
  allowed_gate_spec_ids: z
    .array(NonEmptyStringSchema)
    .refine(hasUniqueStrings, 'allowed gate spec ids must be unique'),
  max_iterations: PositiveIntegerSchema,
  max_model_attempts: NonNegativeIntegerSchema,
  max_tool_calls: NonNegativeIntegerSchema,
  contract_hash: Sha256HexV1Schema,
});

export type AgentStrategyReleaseV1 = z.infer<typeof AgentStrategyReleaseV1Schema>;
