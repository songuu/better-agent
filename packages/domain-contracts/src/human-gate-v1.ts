import { z } from 'zod';

import { UuidV1Schema } from './auth-v1.js';
import {
  addCustomIssue,
  JsonObjectSchema,
  NonEmptyStringSchema,
  Sha256HexV1Schema,
} from './primitives.js';
import { RunIdempotencyKeyV1Schema } from './run-idempotency-v1.js';

const DurableObjectRefV1Schema = NonEmptyStringSchema.max(2_048).refine(
  (value) => !value.includes('?') && !value.includes('#'),
  'durable object refs must not contain query parameters or fragments',
);

export const HumanGateTypeV1Schema = z.enum(['input', 'approval']);
export const HumanGateStatusV1Schema = z.enum([
  'PENDING',
  'CLAIMED',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
]);

export const HumanGateV1Schema = z
  .strictObject({
    schema_version: z.literal('human-gate-instance/1'),
    gate_id: UuidV1Schema,
    workspace_id: UuidV1Schema,
    run_id: UuidV1Schema,
    capability_call_id: UuidV1Schema.optional(),
    checkpoint_id: UuidV1Schema,
    gate_type: HumanGateTypeV1Schema,
    resolved_plan_hash: Sha256HexV1Schema,
    canonical_operation_hash: Sha256HexV1Schema,
    public_schema: JsonObjectSchema,
    approver_policy_id: NonEmptyStringSchema.max(300),
    status: HumanGateStatusV1Schema,
    barrier_generation: z.number().int().positive().safe(),
    expires_at: z.iso.datetime({ offset: true }),
    claimed_by: NonEmptyStringSchema.max(300).optional(),
    claimed_at: z.iso.datetime({ offset: true }).optional(),
    decision_object_ref: DurableObjectRefV1Schema.optional(),
    decision_sha256: Sha256HexV1Schema.optional(),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
    resolved_at: z.iso.datetime({ offset: true }).optional(),
  })
  .superRefine((gate, ctx) => {
    const createdAt = Date.parse(gate.created_at);
    const expiresAt = Date.parse(gate.expires_at);
    const updatedAt = Date.parse(gate.updated_at);
    if (expiresAt <= createdAt) {
      addCustomIssue(ctx, ['expires_at'], 'HumanGate expiry must be later than creation');
    }
    if (updatedAt < createdAt) {
      addCustomIssue(ctx, ['updated_at'], 'HumanGate update cannot precede creation');
    }

    const hasClaim = gate.claimed_by !== undefined && gate.claimed_at !== undefined;
    if ((gate.claimed_by === undefined) !== (gate.claimed_at === undefined)) {
      addCustomIssue(
        ctx,
        ['claimed_by'],
        'HumanGate claim actor and timestamp must be present or absent together',
      );
    }
    if ((gate.decision_object_ref === undefined) !== (gate.decision_sha256 === undefined)) {
      addCustomIssue(
        ctx,
        ['decision_object_ref'],
        'HumanGate decision ref and hash must be present or absent together',
      );
    }

    if (gate.status === 'PENDING') {
      if (hasClaim || gate.decision_object_ref !== undefined || gate.resolved_at !== undefined) {
        addCustomIssue(ctx, ['status'], 'PENDING HumanGate cannot carry claim or resolution facts');
      }
      return;
    }

    if (gate.status === 'CLAIMED') {
      if (!hasClaim) {
        addCustomIssue(ctx, ['claimed_by'], 'CLAIMED HumanGate requires claim facts');
      }
      if (gate.decision_object_ref !== undefined || gate.resolved_at !== undefined) {
        addCustomIssue(ctx, ['status'], 'CLAIMED HumanGate cannot carry resolution facts');
      }
      return;
    }

    if (gate.resolved_at === undefined) {
      addCustomIssue(ctx, ['resolved_at'], 'terminal HumanGate requires resolved_at');
    } else if (Date.parse(gate.resolved_at) < createdAt) {
      addCustomIssue(ctx, ['resolved_at'], 'HumanGate resolution cannot precede creation');
    }

    if (gate.status === 'APPROVED' || gate.status === 'REJECTED') {
      if (!hasClaim) {
        addCustomIssue(ctx, ['claimed_by'], 'decided HumanGate requires claim facts');
      }
      if (gate.decision_object_ref === undefined) {
        addCustomIssue(
          ctx,
          ['decision_object_ref'],
          'decided HumanGate requires decision evidence',
        );
      }
    } else if (gate.decision_object_ref !== undefined) {
      addCustomIssue(
        ctx,
        ['decision_object_ref'],
        'non-decision terminal HumanGate cannot carry decision evidence',
      );
    }
  });

export const HumanGateResumeActionV1Schema = z.enum(['SUBMIT_INPUT', 'APPROVE', 'REJECT']);

export const HumanGateResumeIntentV1Schema = z.strictObject({
  schema_version: z.literal('human-gate-resume-intent/1'),
  workspace_id: UuidV1Schema,
  run_id: UuidV1Schema,
  gate_id: UuidV1Schema,
  action: HumanGateResumeActionV1Schema,
  idempotency_key: RunIdempotencyKeyV1Schema,
  input: JsonObjectSchema,
});

export type HumanGateTypeV1 = z.infer<typeof HumanGateTypeV1Schema>;
export type HumanGateStatusV1 = z.infer<typeof HumanGateStatusV1Schema>;
export type HumanGateV1 = z.infer<typeof HumanGateV1Schema>;
export type HumanGateResumeActionV1 = z.infer<typeof HumanGateResumeActionV1Schema>;
export type HumanGateResumeIntentV1 = z.infer<typeof HumanGateResumeIntentV1Schema>;
