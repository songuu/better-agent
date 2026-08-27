import { z } from 'zod';

import { StrategyTerminationReasonV1Schema } from './agent-strategy-v1.js';
import { UuidV1Schema } from './auth-v1.js';
import { RunBillingStateValueV1Schema } from './billing-v1.js';
import {
  ConversationPrincipalV1Schema,
  ConversationStateVersionV1Schema,
} from './conversation-v1.js';
import {
  addCustomIssue,
  JsonObjectSchema,
  NonEmptyStringSchema,
  Sha256HexV1Schema,
} from './primitives.js';

export const RunStatusV1Schema = z.enum([
  'QUEUED',
  'RUNNING',
  'WAITING_FOR_INPUT',
  'WAITING_FOR_APPROVAL',
  'RESUMING',
  'CANCEL_REQUESTED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
  'NEEDS_ATTENTION',
]);

export const PublicRunStatusV1Schema = z.enum([
  'QUEUED',
  'RUNNING',
  'CANCEL_REQUESTED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
]);

export const RunExecutionStatusV1Schema = z.enum([
  'ACCEPTED',
  'QUEUED',
  'RUNNING',
  'WAITING_FOR_INPUT',
  'WAITING_FOR_APPROVAL',
  'RESUMING',
  'RETRY_WAIT',
  'RECOVERING',
  'CANCELLING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
  'NEEDS_ATTENTION',
]);

export const RunTargetV1Schema = z.discriminatedUnion('target_kind', [
  z.strictObject({
    schema_version: z.literal('run-target/1'),
    target_kind: z.literal('agent'),
    agent_deployment_id: UuidV1Schema,
    agent_deployment_revision_id: UuidV1Schema,
    agent_id: UuidV1Schema,
    agent_release_id: UuidV1Schema,
    experience_release_id: UuidV1Schema,
    conversation_id: UuidV1Schema,
    conversation_contract_hash: Sha256HexV1Schema,
    accepted_conversation_state_version: ConversationStateVersionV1Schema,
    user_message_id: UuidV1Schema,
  }),
  z.strictObject({
    schema_version: z.literal('run-target/1'),
    target_kind: z.literal('flow'),
    flow_deployment_id: UuidV1Schema,
    flow_deployment_revision_id: UuidV1Schema,
    flow_id: UuidV1Schema,
    flow_version_id: UuidV1Schema,
  }),
]);

export const RunAcceptanceV1Schema = z
  .strictObject({
    schema_version: z.literal('run-acceptance/1'),
    workspace_id: UuidV1Schema,
    run_id: UuidV1Schema,
    accepted_request_id: UuidV1Schema,
    accepted_principal: ConversationPrincipalV1Schema,
    admission_snapshot_hash: Sha256HexV1Schema,
    accepted_plan_hash: Sha256HexV1Schema,
    accepted_output_schema_ref: NonEmptyStringSchema.max(1024),
    accepted_output_schema_hash: Sha256HexV1Schema,
    dependency_pins_hash: Sha256HexV1Schema,
    status: z.literal('QUEUED'),
    execution_status: z.literal('ACCEPTED'),
    billing_state: z.literal('PENDING'),
    target: RunTargetV1Schema,
  })
  .superRefine((acceptance, ctx) => {
    if (acceptance.admission_snapshot_hash === acceptance.accepted_plan_hash) {
      addCustomIssue(
        ctx,
        ['accepted_plan_hash'],
        'accepted Plan identity must be independent from the admission snapshot',
      );
    }
    if (
      acceptance.target.target_kind === 'flow' &&
      acceptance.accepted_principal.kind !== 'credential'
    ) {
      addCustomIssue(
        ctx,
        ['accepted_principal'],
        'direct Flow Run requires a credential principal',
      );
    }
  });

export const RunTerminalErrorV1Schema = z.strictObject({
  code: StrategyTerminationReasonV1Schema,
  retryable: z.literal(false),
  category: z.literal('EXECUTION'),
  requires_operator_action: z.boolean().optional(),
});

const runSnapshotBaseSchema = z.strictObject({
  schema_version: z.literal('run-snapshot/1'),
  workspace_id: UuidV1Schema,
  run_id: UuidV1Schema,
  status: RunStatusV1Schema,
  execution_status: RunExecutionStatusV1Schema,
  termination_reason: StrategyTerminationReasonV1Schema.optional(),
  finished_at: z.iso.datetime({ offset: true }).optional(),
  terminal_billing_pending: z.literal(false).optional(),
  terminal_billing_pending_at: z.iso.datetime({ offset: true }).optional(),
  terminal_result_redacted: JsonObjectSchema.optional(),
  terminal_error_redacted: RunTerminalErrorV1Schema.optional(),
  billing_state: RunBillingStateValueV1Schema,
  billing_settled_at: z.iso.datetime({ offset: true }).optional(),
});

const terminalStatuses = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
  'NEEDS_ATTENTION',
]);

const failedTerminationReasons = new Set([
  'MAX_ITERATIONS',
  'MAX_MODEL_ATTEMPTS',
  'MAX_TOOL_CALLS',
  'BUDGET_EXHAUSTED',
  'AUTHORIZATION_REVALIDATION_FAILED',
  'RESOURCE_REVOKED',
  'MODEL_FAILED',
  'MODEL_OUTCOME_UNKNOWN',
  'CAPABILITY_FAILED',
  'HUMAN_REJECTED',
  'HUMAN_GATE_EXPIRED',
  'INVALID_DECISION',
  'STRATEGY_IMPLEMENTATION_UNAVAILABLE',
  'INTERNAL_FAILURE',
]);

const cancelledTerminationReasons = new Set([
  'USER_CANCELLED',
  'HUMAN_REJECTED',
  'HUMAN_GATE_EXPIRED',
]);

const schedulingToRunStatus = {
  ACCEPTED: 'QUEUED',
  QUEUED: 'QUEUED',
  RETRY_WAIT: 'QUEUED',
  RECOVERING: 'QUEUED',
  RUNNING: 'RUNNING',
  WAITING_FOR_INPUT: 'WAITING_FOR_INPUT',
  WAITING_FOR_APPROVAL: 'WAITING_FOR_APPROVAL',
  RESUMING: 'RESUMING',
  CANCELLING: 'CANCEL_REQUESTED',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'TIMED_OUT',
  NEEDS_ATTENTION: 'NEEDS_ATTENTION',
} as const;

export const RunSnapshotV1Schema = runSnapshotBaseSchema.superRefine((snapshot, ctx) => {
  if (schedulingToRunStatus[snapshot.execution_status] !== snapshot.status) {
    addCustomIssue(ctx, ['execution_status'], 'execution status does not map to Run status');
  }

  const isTerminal = terminalStatuses.has(snapshot.status);
  const terminalFields = [
    snapshot.termination_reason,
    snapshot.finished_at,
    snapshot.terminal_billing_pending,
    snapshot.terminal_billing_pending_at,
    snapshot.terminal_result_redacted,
    snapshot.terminal_error_redacted,
  ];

  if (!isTerminal) {
    if (terminalFields.some((value) => value !== undefined)) {
      addCustomIssue(ctx, ['status'], 'non-terminal Run cannot carry terminal facts');
    }
    if (snapshot.billing_state !== 'PENDING' || snapshot.billing_settled_at !== undefined) {
      addCustomIssue(ctx, ['billing_state'], 'non-terminal Run billing must remain PENDING');
    }
    return;
  }

  if (
    snapshot.termination_reason === undefined ||
    snapshot.finished_at === undefined ||
    snapshot.terminal_billing_pending !== false ||
    snapshot.terminal_billing_pending_at === undefined
  ) {
    addCustomIssue(ctx, ['status'], 'terminal Run requires its immutable terminal snapshot');
  }

  if (snapshot.status === 'SUCCEEDED') {
    if (
      snapshot.termination_reason !== 'COMPLETED' ||
      snapshot.terminal_result_redacted === undefined ||
      snapshot.terminal_error_redacted !== undefined
    ) {
      addCustomIssue(ctx, ['status'], 'SUCCEEDED requires COMPLETED and exactly one result');
    }
  } else if (
    snapshot.terminal_error_redacted === undefined ||
    snapshot.terminal_result_redacted !== undefined
  ) {
    addCustomIssue(ctx, ['status'], 'non-success terminal Run requires exactly one error');
  }

  if (
    snapshot.terminal_error_redacted !== undefined &&
    snapshot.termination_reason !== snapshot.terminal_error_redacted.code
  ) {
    addCustomIssue(
      ctx,
      ['terminal_error_redacted'],
      'terminal error must match termination reason',
    );
  }

  const hasValidTerminationMapping =
    (snapshot.status === 'SUCCEEDED' && snapshot.termination_reason === 'COMPLETED') ||
    (snapshot.status === 'FAILED' &&
      snapshot.termination_reason !== undefined &&
      failedTerminationReasons.has(snapshot.termination_reason)) ||
    (snapshot.status === 'CANCELLED' &&
      snapshot.termination_reason !== undefined &&
      cancelledTerminationReasons.has(snapshot.termination_reason)) ||
    (snapshot.status === 'TIMED_OUT' && snapshot.termination_reason === 'RUN_TIMED_OUT') ||
    (snapshot.status === 'NEEDS_ATTENTION' &&
      snapshot.termination_reason === 'SIDE_EFFECT_UNKNOWN');
  if (!hasValidTerminationMapping) {
    addCustomIssue(ctx, ['termination_reason'], 'termination reason does not map to Run status');
  }

  if (snapshot.status === 'NEEDS_ATTENTION') {
    if (
      snapshot.termination_reason !== 'SIDE_EFFECT_UNKNOWN' ||
      snapshot.terminal_error_redacted?.requires_operator_action !== true
    ) {
      addCustomIssue(
        ctx,
        ['termination_reason'],
        'NEEDS_ATTENTION requires SIDE_EFFECT_UNKNOWN operator action',
      );
    }
    if (
      !(
        (snapshot.billing_state === 'NEEDS_ATTENTION' &&
          snapshot.billing_settled_at === undefined) ||
        (snapshot.billing_state === 'SETTLED' && snapshot.billing_settled_at !== undefined)
      )
    ) {
      addCustomIssue(ctx, ['billing_state'], 'operator-hold billing must be held or reconciled');
    }
  } else {
    if (snapshot.terminal_error_redacted?.requires_operator_action !== undefined) {
      addCustomIssue(
        ctx,
        ['terminal_error_redacted', 'requires_operator_action'],
        'only operator-hold terminal errors carry requires_operator_action',
      );
    }
    if (snapshot.billing_state !== 'SETTLED' || snapshot.billing_settled_at === undefined) {
      addCustomIssue(ctx, ['billing_state'], 'normal terminal Run billing must be SETTLED');
    }
  }
});

export type RunStatusV1 = z.infer<typeof RunStatusV1Schema>;
export type PublicRunStatusV1 = z.infer<typeof PublicRunStatusV1Schema>;
export type RunExecutionStatusV1 = z.infer<typeof RunExecutionStatusV1Schema>;
export type RunTargetV1 = z.infer<typeof RunTargetV1Schema>;
export type RunAcceptanceV1 = z.infer<typeof RunAcceptanceV1Schema>;
export type RunSnapshotV1 = z.infer<typeof RunSnapshotV1Schema>;
