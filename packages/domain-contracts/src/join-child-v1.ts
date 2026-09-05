import { z } from 'zod';

import { AsyncChildPolicyV1Schema } from './agent-release-v1.js';
import { G1JoinChildCeilingV1Schema } from './agent-plan-v1.js';
import { UuidV1Schema } from './auth-v1.js';
import {
  addCustomIssue,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  PostgresInstantV1Schema,
  Sha256HexV1Schema,
} from './primitives.js';

const uniqueNonEmptyStrings = z
  .array(NonEmptyStringSchema)
  .min(1)
  .refine((values) => new Set(values).size === values.length, 'values must be unique');

export const G1BoundedChildDelegationV1Schema = z.strictObject({
  schema_version: z.literal('g1-bounded-child-delegation/1'),
  policy_hash: Sha256HexV1Schema,
  allowed_target_refs: uniqueNonEmptyStrings,
  max_calls: PositiveIntegerSchema,
  max_depth: PositiveIntegerSchema,
  max_budget_credits: NonNegativeIntegerSchema,
  issued_at: PostgresInstantV1Schema,
  expires_at: PostgresInstantV1Schema,
});

export const G1JoinChildAdmissionV1Schema = z
  .strictObject({
    schema_version: z.literal('g1-join-child-admission/1'),
    workspace_id: UuidV1Schema,
    parent_run_id: UuidV1Schema,
    child_run_id: UuidV1Schema,
    link_id: UuidV1Schema,
    billing_owner_run_id: UuidV1Schema,
    parent_plan_hash: Sha256HexV1Schema,
    parent_checkpoint_id: UuidV1Schema,
    parent_checkpoint_object_ref: NonEmptyStringSchema.max(2048),
    parent_checkpoint_sha256: Sha256HexV1Schema,
    child_plan_hash: Sha256HexV1Schema,
    canonical_operation_hash: Sha256HexV1Schema,
    binding_id: NonEmptyStringSchema,
    target_agent_id: UuidV1Schema,
    target_agent_release_id: UuidV1Schema,
    target_ref: NonEmptyStringSchema,
    ancestor_target_refs: uniqueNonEmptyStrings,
    parent_depth: NonNegativeIntegerSchema,
    child_depth: PositiveIntegerSchema,
    completed_child_calls: NonNegativeIntegerSchema,
    call_sequence: PositiveIntegerSchema,
    allocated_credits: NonNegativeIntegerSchema,
    admission_snapshot_hash: Sha256HexV1Schema,
    accepted_output_schema_ref: NonEmptyStringSchema.max(1024),
    accepted_output_schema_hash: Sha256HexV1Schema,
    dependency_pins_hash: Sha256HexV1Schema,
    context_projection_object_ref: NonEmptyStringSchema.max(2048),
    context_projection_sha256: Sha256HexV1Schema,
    delegation_reason: NonEmptyStringSchema.max(1024),
    delegation: G1BoundedChildDelegationV1Schema,
    compiled_child_ceiling: G1JoinChildCeilingV1Schema,
    async_child_policy: AsyncChildPolicyV1Schema,
    created_at: PostgresInstantV1Schema,
  })
  .superRefine((admission, ctx) => {
    if (admission.parent_run_id === admission.child_run_id)
      addCustomIssue(ctx, ['child_run_id'], 'child Run must differ from its parent');
    if (admission.child_depth !== admission.parent_depth + 1)
      addCustomIssue(ctx, ['child_depth'], 'child depth must be exactly parent depth plus one');
    if (admission.call_sequence !== admission.completed_child_calls + 1)
      addCustomIssue(ctx, ['call_sequence'], 'call sequence must follow completed child calls');
    if (admission.parent_plan_hash === admission.child_plan_hash)
      addCustomIssue(ctx, ['child_plan_hash'], 'child Plan must have an independent identity');
  });

export type G1BoundedChildDelegationV1 = z.infer<typeof G1BoundedChildDelegationV1Schema>;
export type G1JoinChildAdmissionV1 = z.infer<typeof G1JoinChildAdmissionV1Schema>;

export const G1JoinChildSettlementV1Schema = z.strictObject({
  schema_version: z.literal('g1-join-child-settlement/1'),
  workspace_id: UuidV1Schema,
  settlement_id: UuidV1Schema,
  parent_run_id: UuidV1Schema,
  child_run_id: UuidV1Schema,
  child_terminal_status: z.enum([
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'TIMED_OUT',
    'NEEDS_ATTENTION',
  ]),
  child_terminal_intent_hash: Sha256HexV1Schema,
  terminal_payload_object_ref: NonEmptyStringSchema.max(2048),
  terminal_payload_sha256: Sha256HexV1Schema,
  child_billing_state: z.literal('SETTLED'),
  allocation_status: z.enum(['SETTLED', 'RELEASED']),
  settled_at: PostgresInstantV1Schema,
});

export type G1JoinChildSettlementV1 = z.infer<typeof G1JoinChildSettlementV1Schema>;
