import { z } from 'zod';

import { StrategyTerminationReasonV1Schema } from './agent-strategy-v1.js';
import { UuidV1Schema } from './auth-v1.js';
import { CreditAmountV1Schema } from './billing-v1.js';
import {
  addCustomIssue,
  boundedNonBlankStringSchema,
  comparePostgresInstants,
  hasUniqueStrings,
  JsonObjectSchema,
  NonEmptyStringSchema,
  PostgresInstantV1Schema,
  Sha256HexV1Schema,
} from './primitives.js';

const MaximumSafeIntegerV1 = 9_007_199_254_740_991n;
const PostgresSessionUserV1Schema = NonEmptyStringSchema.max(63);
const InstantV1Schema = PostgresInstantV1Schema;
const CanonicalPositiveIntegerPattern = /^[1-9][0-9]*$/u;
const CanonicalNonnegativeIntegerPattern = /^(?:0|[1-9][0-9]*)$/u;
const DurableFactRefV1Schema = boundedNonBlankStringSchema(2_048, 'durable fact ref').refine(
  (value) => !value.includes('?') && !value.includes('#'),
  'durable fact refs must not contain query parameters or fragments',
);
const StableOperationKeyV1Schema = boundedNonBlankStringSchema(300, 'operation key');
const MeteringUnitV1Schema = boundedNonBlankStringSchema(200, 'metering unit');
const ReasonCodeV1Schema = boundedNonBlankStringSchema(200, 'reason code');

export const RunLeaseDurationSecondsV1Schema = z.number().int().min(1).max(300);

export const RunLeaseFencingTokenV1Schema = z
  .string()
  .regex(CanonicalPositiveIntegerPattern, 'expected a canonical positive fencing decimal string')
  .refine(
    (value) => CanonicalPositiveIntegerPattern.test(value) && BigInt(value) <= MaximumSafeIntegerV1,
    'fencing token exceeds the JavaScript safe-integer boundary',
  );

export const RunDispatchGenerationV1Schema = z
  .string()
  .regex(CanonicalNonnegativeIntegerPattern, 'expected a canonical non-negative generation string')
  .refine(
    (value) =>
      CanonicalNonnegativeIntegerPattern.test(value) && BigInt(value) <= MaximumSafeIntegerV1,
    'dispatch generation exceeds the JavaScript safe-integer boundary',
  );

export const RunPositiveSequenceV1Schema = RunLeaseFencingTokenV1Schema;

export const RunAttemptStatusV1Schema = z.enum([
  'PENDING',
  'RUNNING',
  'RELINQUISHED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);

const activeLeaseShape = {
  lease_owner: PostgresSessionUserV1Schema,
  lease_token: UuidV1Schema,
  lease_fencing_token: RunLeaseFencingTokenV1Schema,
  lease_expires_at: InstantV1Schema,
};

export const RunAttemptLeaseStateV1Schema = z
  .strictObject({
    schema_version: z.literal('run-attempt-lease-state/1'),
    workspace_id: UuidV1Schema,
    run_id: UuidV1Schema,
    attempt_id: UuidV1Schema,
    attempt_number: z.number().int().positive().safe(),
    status: RunAttemptStatusV1Schema,
    pending_kind: z.enum(['INITIAL', 'RECOVERY']).optional(),
    lease_owner: activeLeaseShape.lease_owner.optional(),
    lease_token: activeLeaseShape.lease_token.optional(),
    lease_fencing_token: activeLeaseShape.lease_fencing_token.optional(),
    lease_expires_at: activeLeaseShape.lease_expires_at.optional(),
    recovery_ticket_id: UuidV1Schema.optional(),
    started_at: InstantV1Schema.optional(),
    finished_at: InstantV1Schema.optional(),
    updated_at: InstantV1Schema,
  })
  .superRefine((state, ctx) => {
    const liveLeaseFields = [state.lease_owner, state.lease_token, state.lease_expires_at];
    const activeLeaseFields = [...liveLeaseFields, state.lease_fencing_token];
    const hasAnyLiveLeaseField = liveLeaseFields.some((value) => value !== undefined);
    const hasCompleteActiveLease = activeLeaseFields.every((value) => value !== undefined);

    if (state.status === 'PENDING') {
      if (
        state.pending_kind === undefined ||
        hasAnyLiveLeaseField ||
        state.finished_at !== undefined
      ) {
        addCustomIssue(ctx, ['status'], 'PENDING Attempt requires a lease-free pending shape');
      }
      if (state.pending_kind === 'INITIAL') {
        if (
          state.lease_fencing_token !== undefined ||
          state.recovery_ticket_id !== undefined ||
          state.started_at !== undefined
        ) {
          addCustomIssue(
            ctx,
            ['pending_kind'],
            'INITIAL pending Attempt has no recovery generation',
          );
        }
      }
      if (
        state.pending_kind === 'RECOVERY' &&
        (state.lease_fencing_token === undefined || state.recovery_ticket_id === undefined)
      ) {
        addCustomIssue(
          ctx,
          ['recovery_ticket_id'],
          'RECOVERY pending Attempt requires its fenced generation and ticket',
        );
      }
      return;
    }

    if (state.pending_kind !== undefined || state.recovery_ticket_id !== undefined) {
      addCustomIssue(ctx, ['pending_kind'], 'only a PENDING recovery shape carries a ticket');
    }

    if (state.status === 'RUNNING') {
      if (
        !hasCompleteActiveLease ||
        state.started_at === undefined ||
        state.finished_at !== undefined
      ) {
        addCustomIssue(ctx, ['status'], 'RUNNING Attempt requires one complete active lease');
      }
      if (
        state.lease_expires_at !== undefined &&
        comparePostgresInstants(state.lease_expires_at, state.updated_at) !== 1
      ) {
        addCustomIssue(ctx, ['lease_expires_at'], 'active lease must expire after its state time');
      }
      return;
    }

    const hasAnyExecutionHistory =
      state.lease_fencing_token !== undefined || state.started_at !== undefined;
    const hasCompleteExecutionHistory =
      state.lease_fencing_token !== undefined && state.started_at !== undefined;
    const mayBeNeverStartedTerminal = state.status === 'FAILED' || state.status === 'CANCELLED';
    if (
      hasAnyLiveLeaseField ||
      state.finished_at === undefined ||
      (hasAnyExecutionHistory && !hasCompleteExecutionHistory) ||
      (!hasAnyExecutionHistory && !mayBeNeverStartedTerminal)
    ) {
      addCustomIssue(
        ctx,
        ['status'],
        'terminal or relinquished Attempt requires a lease-free, consistently fenced execution history',
      );
      return;
    }
    if (state.started_at !== undefined) {
      const finishOrdering = comparePostgresInstants(state.finished_at, state.started_at);
      if (finishOrdering !== 0 && finishOrdering !== 1) {
        addCustomIssue(ctx, ['finished_at'], 'Attempt cannot finish before it starts');
      }
    }
  });

export const RunAttemptLeaseAuthorityV1Schema = z
  .strictObject({
    schema_version: z.literal('run-attempt-lease-authority/1'),
    workspace_id: UuidV1Schema,
    run_id: UuidV1Schema,
    attempt_id: UuidV1Schema,
    step_id: UuidV1Schema.optional(),
    session_user: PostgresSessionUserV1Schema,
    ...activeLeaseShape,
    authorized_at: InstantV1Schema,
  })
  .superRefine((authority, ctx) => {
    if (authority.session_user !== authority.lease_owner) {
      addCustomIssue(ctx, ['session_user'], 'lease authority session_user must equal lease_owner');
    }
    if (comparePostgresInstants(authority.authorized_at, authority.lease_expires_at) !== -1) {
      addCustomIssue(ctx, ['authorized_at'], 'lease authority must be established before expiry');
    }
  });

export const RunEffectClassV1Schema = z.enum(['SAFE', 'REQUIRES_KEY', 'UNSAFE']);
export const RunRecoveryDecisionV1Schema = z.enum(['REPLAY_SAFE', 'REPLAY_WITH_KEY', 'HOLD']);

export const RunRetryEffectEnvelopeV1Schema = z
  .strictObject({
    schema_version: z.literal('run-retry-effect-envelope/1'),
    envelope_id: UuidV1Schema,
    workspace_id: UuidV1Schema,
    run_id: UuidV1Schema,
    attempt_id: UuidV1Schema,
    step_id: UuidV1Schema,
    accepted_plan_hash: Sha256HexV1Schema,
    operation_intent_sha256: Sha256HexV1Schema,
    effect_payload_sha256: Sha256HexV1Schema,
    effect_class: RunEffectClassV1Schema,
    recovery_decision: RunRecoveryDecisionV1Schema,
    operation_key: StableOperationKeyV1Schema.optional(),
    created_at: InstantV1Schema,
  })
  .superRefine((envelope, ctx) => {
    const valid =
      (envelope.effect_class === 'SAFE' &&
        envelope.recovery_decision === 'REPLAY_SAFE' &&
        envelope.operation_key === undefined) ||
      (envelope.effect_class === 'REQUIRES_KEY' &&
        envelope.recovery_decision === 'REPLAY_WITH_KEY' &&
        envelope.operation_key !== undefined) ||
      (envelope.effect_class === 'UNSAFE' &&
        envelope.recovery_decision === 'HOLD' &&
        envelope.operation_key === undefined);
    if (!valid) {
      addCustomIssue(ctx, ['recovery_decision'], 'effect class does not authorize that recovery');
    }
  });

const historicalProducerShape = {
  producer_session_user: PostgresSessionUserV1Schema,
  lease_owner: PostgresSessionUserV1Schema,
  lease_token: UuidV1Schema,
  lease_fencing_token: RunLeaseFencingTokenV1Schema,
  lease_expires_at: InstantV1Schema,
  authorized_at: InstantV1Schema,
};

function addHistoricalProducerIssues(
  producer: {
    producer_session_user: string;
    lease_owner: string;
    lease_expires_at: string;
    authorized_at: string;
  },
  ctx: z.RefinementCtx,
): void {
  if (producer.producer_session_user !== producer.lease_owner) {
    addCustomIssue(
      ctx,
      ['producer_session_user'],
      'historical producer session_user must equal the lease owner',
    );
  }
  if (comparePostgresInstants(producer.authorized_at, producer.lease_expires_at) !== -1) {
    addCustomIssue(
      ctx,
      ['authorized_at'],
      'historical producer fact must be authorized before expiry',
    );
  }
}

export const RunSideEffectReceiptV1Schema = z
  .strictObject({
    schema_version: z.literal('run-side-effect-receipt/1'),
    effect_receipt_id: UuidV1Schema,
    workspace_id: UuidV1Schema,
    run_id: UuidV1Schema,
    attempt_id: UuidV1Schema,
    step_id: UuidV1Schema,
    retry_effect_envelope_id: UuidV1Schema,
    retry_effect_envelope_sha256: Sha256HexV1Schema,
    effect_class: RunEffectClassV1Schema,
    operation_key: StableOperationKeyV1Schema.optional(),
    outcome: z.enum(['CONFIRMED', 'UNKNOWN']),
    external_receipt_ref: DurableFactRefV1Schema.optional(),
    external_receipt_sha256: Sha256HexV1Schema.optional(),
    unknown_reason_code: ReasonCodeV1Schema.optional(),
    result_payload_sha256: Sha256HexV1Schema,
    ...historicalProducerShape,
  })
  .superRefine((receipt, ctx) => {
    addHistoricalProducerIssues(receipt, ctx);
    if ((receipt.effect_class === 'REQUIRES_KEY') !== (receipt.operation_key !== undefined)) {
      addCustomIssue(
        ctx,
        ['operation_key'],
        'receipt operation key is present if and only if the effect requires a key',
      );
    }

    if (receipt.outcome === 'CONFIRMED') {
      if (
        receipt.external_receipt_ref === undefined ||
        receipt.external_receipt_sha256 === undefined ||
        receipt.unknown_reason_code !== undefined
      ) {
        addCustomIssue(
          ctx,
          ['external_receipt_ref'],
          'CONFIRMED effect requires an exact external receipt ref/hash pair',
        );
      }
      return;
    }
    if (
      receipt.unknown_reason_code === undefined ||
      receipt.external_receipt_ref !== undefined ||
      receipt.external_receipt_sha256 !== undefined
    ) {
      addCustomIssue(
        ctx,
        ['unknown_reason_code'],
        'UNKNOWN effect requires a reason and cannot claim an external receipt',
      );
    }
  });

export const RunExecutionCheckpointV1Schema = z
  .strictObject({
    schema_version: z.literal('run-execution-checkpoint/1'),
    checkpoint_id: UuidV1Schema,
    workspace_id: UuidV1Schema,
    run_id: UuidV1Schema,
    attempt_id: UuidV1Schema,
    step_id: UuidV1Schema.optional(),
    checkpoint_sequence: RunPositiveSequenceV1Schema,
    checkpoint_ref: DurableFactRefV1Schema,
    checkpoint_sha256: Sha256HexV1Schema,
    ...historicalProducerShape,
  })
  .superRefine(addHistoricalProducerIssues);

const runUsageAttributionShape = {
  schema_version: z.literal('run-usage-attribution/1'),
  usage_attribution_id: UuidV1Schema,
  workspace_id: UuidV1Schema,
  billing_owner_run_id: UuidV1Schema,
  run_id: UuidV1Schema,
  reservation_id: UuidV1Schema,
  attempt_id: UuidV1Schema,
  step_id: UuidV1Schema,
  ...historicalProducerShape,
  producer_operation_key: StableOperationKeyV1Schema,
  metering_unit: MeteringUnitV1Schema,
  metering_quantity: CreditAmountV1Schema,
  amount_credits: CreditAmountV1Schema,
  settlement_operation_key: StableOperationKeyV1Schema,
  operation_intent_sha256: Sha256HexV1Schema,
  execution_effect_payload_sha256: Sha256HexV1Schema,
  consumption_generation: RunLeaseFencingTokenV1Schema,
};

export const RunUsageAttributionV1Schema = z
  .strictObject(runUsageAttributionShape)
  .superRefine(addHistoricalProducerIssues);

const FailedTerminationReasonsV1 = new Set([
  'MAX_ITERATIONS',
  'MAX_MODEL_ATTEMPTS',
  'MAX_TOOL_CALLS',
  'BUDGET_EXHAUSTED',
  'AUTHORIZATION_REVALIDATION_FAILED',
  'RESOURCE_REVOKED',
  'MODEL_FAILED',
  'MODEL_OUTCOME_UNKNOWN',
  'CAPABILITY_FAILED',
  'INVALID_DECISION',
  'STRATEGY_IMPLEMENTATION_UNAVAILABLE',
  'INTERNAL_FAILURE',
]);

const runTerminationIntentShape = {
  schema_version: z.literal('run-termination-intent/1'),
  termination_intent_id: UuidV1Schema,
  workspace_id: UuidV1Schema,
  billing_owner_run_id: UuidV1Schema,
  run_id: UuidV1Schema,
  reservation_id: UuidV1Schema,
  attempt_id: UuidV1Schema,
  step_id: UuidV1Schema,
  ...historicalProducerShape,
  producer_operation_key: StableOperationKeyV1Schema,
  terminal_status: z.enum(['FAILED', 'CANCELLED']),
  termination_reason: StrategyTerminationReasonV1Schema,
  effect_disposition: z.literal('CLOSED'),
  effect_closure_sha256: Sha256HexV1Schema,
  usage_attribution_ids: z.array(UuidV1Schema),
  intended_settle_credits: CreditAmountV1Schema,
  settlement_operation_key: StableOperationKeyV1Schema,
  intended_release_credits: CreditAmountV1Schema,
  release_operation_key: StableOperationKeyV1Schema,
  release_reason_code: ReasonCodeV1Schema,
  operation_intent_sha256: Sha256HexV1Schema,
  consumption_generation: RunLeaseFencingTokenV1Schema,
};

export const RunTerminationIntentV1Schema = z
  .strictObject(runTerminationIntentShape)
  .superRefine((intent, ctx) => {
    addHistoricalProducerIssues(intent, ctx);
    if (
      !hasUniqueStrings(intent.usage_attribution_ids) ||
      [...intent.usage_attribution_ids]
        .sort()
        .some((value, index) => value !== intent.usage_attribution_ids[index])
    ) {
      addCustomIssue(
        ctx,
        ['usage_attribution_ids'],
        'usage attribution identities must be unique and lexically sorted',
      );
    }
    const validMapping =
      (intent.terminal_status === 'CANCELLED' && intent.termination_reason === 'USER_CANCELLED') ||
      (intent.terminal_status === 'FAILED' &&
        FailedTerminationReasonsV1.has(intent.termination_reason));
    if (!validMapping) {
      addCustomIssue(
        ctx,
        ['termination_reason'],
        'termination reason does not map to terminal status',
      );
    }
  });

export const RunUsageAttributionRecordResultV1Schema = z.strictObject({
  schema_version: z.literal('run-usage-attribution-record-result/1'),
  source: RunUsageAttributionV1Schema,
  source_authority_hash: Sha256HexV1Schema,
  detail_redacted: JsonObjectSchema,
  replayed: z.boolean(),
});

export const RunTerminationIntentRecordResultV1Schema = z.strictObject({
  schema_version: z.literal('run-termination-intent-record-result/1'),
  intent: RunTerminationIntentV1Schema,
  terminal_intent_hash: Sha256HexV1Schema,
  source_authority_hash: Sha256HexV1Schema,
  billing_close_intent_redacted: JsonObjectSchema,
  replayed: z.boolean(),
});

export const RunRecoveryResourceKindV1Schema = z.enum(['ATTEMPT', 'RUN_DISPATCH']);

function addFenceIncrementIssue(
  oldValue: string,
  newValue: string,
  path: PropertyKey[],
  ctx: z.RefinementCtx,
): void {
  // Child lexical schemas already report malformed values. Keep the parent refinement from
  // turning untrusted input into an escaping BigInt SyntaxError.
  if (
    !CanonicalPositiveIntegerPattern.test(oldValue) ||
    !CanonicalPositiveIntegerPattern.test(newValue)
  ) {
    return;
  }
  if (BigInt(newValue) !== BigInt(oldValue) + 1n) {
    addCustomIssue(ctx, path, 'fenced recovery generation must advance exactly once');
  }
}

function addOptionalPairIssue(
  left: unknown,
  right: unknown,
  path: PropertyKey[],
  message: string,
  ctx: z.RefinementCtx,
): void {
  if ((left === undefined) !== (right === undefined)) addCustomIssue(ctx, path, message);
}

export const RunRecoveryEffectDecisionV1Schema = z
  .strictObject({
    retry_effect_envelope_id: UuidV1Schema,
    retry_effect_envelope_sha256: Sha256HexV1Schema,
    effect_class: RunEffectClassV1Schema.exclude(['UNSAFE']),
    recovery_decision: z.enum(['REPLAY_SAFE', 'REPLAY_WITH_KEY', 'RESUME_FROM_RECEIPT']),
    operation_key: StableOperationKeyV1Schema.optional(),
    effect_receipt_id: UuidV1Schema.optional(),
    effect_receipt_sha256: Sha256HexV1Schema.optional(),
  })
  .superRefine((decision, ctx) => {
    addOptionalPairIssue(
      decision.effect_receipt_id,
      decision.effect_receipt_sha256,
      ['effect_receipt_id'],
      'effect receipt identity and hash must be present together',
      ctx,
    );
    const hasReceipt = decision.effect_receipt_id !== undefined;
    const valid =
      (decision.effect_class === 'SAFE' &&
        decision.recovery_decision === 'REPLAY_SAFE' &&
        decision.operation_key === undefined &&
        !hasReceipt) ||
      (decision.effect_class === 'REQUIRES_KEY' &&
        decision.recovery_decision === 'REPLAY_WITH_KEY' &&
        decision.operation_key !== undefined &&
        !hasReceipt) ||
      (decision.recovery_decision === 'RESUME_FROM_RECEIPT' &&
        hasReceipt &&
        (decision.effect_class === 'REQUIRES_KEY'
          ? decision.operation_key !== undefined
          : decision.operation_key === undefined));
    if (!valid) {
      addCustomIssue(
        ctx,
        ['recovery_decision'],
        'effect class, receipt evidence, and recovery decision are inconsistent',
      );
    }
  });

export const RunRecoveryTicketV1Schema = z
  .strictObject({
    schema_version: z.literal('run-recovery-ticket/1'),
    recovery_ticket_id: UuidV1Schema,
    workspace_id: UuidV1Schema,
    run_id: UuidV1Schema,
    resource_kind: RunRecoveryResourceKindV1Schema,
    resource_id: UuidV1Schema,
    old_fencing_token: RunLeaseFencingTokenV1Schema,
    new_fencing_token: RunLeaseFencingTokenV1Schema,
    created_generation: RunLeaseFencingTokenV1Schema,
    checkpoint_id: UuidV1Schema.optional(),
    checkpoint_sha256: Sha256HexV1Schema.optional(),
    effect_decisions: z.array(RunRecoveryEffectDecisionV1Schema).min(1),
    effect_decisions_sha256: Sha256HexV1Schema,
    created_at: InstantV1Schema,
  })
  .superRefine((ticket, ctx) => {
    addFenceIncrementIssue(
      ticket.old_fencing_token,
      ticket.new_fencing_token,
      ['new_fencing_token'],
      ctx,
    );
    if (ticket.created_generation !== ticket.new_fencing_token) {
      addCustomIssue(
        ctx,
        ['created_generation'],
        'ticket generation must equal the fenced generation',
      );
    }
    addOptionalPairIssue(
      ticket.checkpoint_id,
      ticket.checkpoint_sha256,
      ['checkpoint_id'],
      'checkpoint identity and hash must be present together',
      ctx,
    );
    const envelopeIds = ticket.effect_decisions.map(
      (decision) => decision.retry_effect_envelope_id,
    );
    if (
      !hasUniqueStrings(envelopeIds) ||
      [...envelopeIds].sort().some((value, index) => value !== envelopeIds[index])
    ) {
      addCustomIssue(
        ctx,
        ['effect_decisions'],
        'recovery effect decisions must have unique envelope IDs in lexical order',
      );
    }
  });

const recoveryDispositionBaseShape = {
  schema_version: z.literal('run-recovery-ticket-disposition/1'),
  disposition_id: UuidV1Schema,
  recovery_ticket_id: UuidV1Schema,
  recovery_ticket_sha256: Sha256HexV1Schema,
  workspace_id: UuidV1Schema,
  run_id: UuidV1Schema,
  resource_kind: RunRecoveryResourceKindV1Schema,
  resource_id: UuidV1Schema,
  ticket_fencing_token: RunLeaseFencingTokenV1Schema,
  disposed_at: InstantV1Schema,
};

const ClaimedRecoveryTicketDispositionV1Schema = z
  .strictObject({
    ...recoveryDispositionBaseShape,
    disposition_kind: z.literal('CLAIMED'),
    claim_fencing_token: RunLeaseFencingTokenV1Schema,
    claim_session_user: PostgresSessionUserV1Schema,
    claim_lease_owner: PostgresSessionUserV1Schema,
    claim_lease_token: UuidV1Schema,
    claim_lease_expires_at: InstantV1Schema,
  })
  .superRefine((disposition, ctx) => {
    addFenceIncrementIssue(
      disposition.ticket_fencing_token,
      disposition.claim_fencing_token,
      ['claim_fencing_token'],
      ctx,
    );
    if (disposition.claim_session_user !== disposition.claim_lease_owner) {
      addCustomIssue(ctx, ['claim_session_user'], 'claim session_user must equal lease owner');
    }
    if (
      comparePostgresInstants(disposition.disposed_at, disposition.claim_lease_expires_at) !== -1
    ) {
      addCustomIssue(
        ctx,
        ['claim_lease_expires_at'],
        'claimed lease must expire after disposition',
      );
    }
  });

const TerminalRecoveryTicketDispositionV1Schema = z
  .strictObject({
    ...recoveryDispositionBaseShape,
    disposition_kind: z.literal('TERMINAL_RETIRED'),
    terminal_source_kind: z.enum(['TERMINATION_ATTRIBUTION', 'DURABLE_CANCEL', 'RECOVERY_HOLD']),
    terminal_source_id: UuidV1Schema,
    terminal_source_sha256: Sha256HexV1Schema,
    terminal_intent_sha256: Sha256HexV1Schema,
    terminal_resource_status: z.enum(['CANCELLED', 'FAILED', 'RELINQUISHED', 'DEAD']),
  })
  .superRefine((disposition, ctx) => {
    const validStatus =
      (disposition.resource_kind === 'ATTEMPT' &&
        disposition.terminal_resource_status !== 'DEAD') ||
      (disposition.resource_kind === 'RUN_DISPATCH' &&
        disposition.terminal_resource_status === 'DEAD');
    if (!validStatus) {
      addCustomIssue(
        ctx,
        ['terminal_resource_status'],
        'terminal resource status must match the ticket resource kind',
      );
      return;
    }
    if (disposition.resource_kind === 'ATTEMPT') {
      const validAttemptMapping =
        (disposition.terminal_source_kind === 'RECOVERY_HOLD' &&
          disposition.terminal_resource_status === 'RELINQUISHED') ||
        (disposition.terminal_source_kind === 'DURABLE_CANCEL' &&
          disposition.terminal_resource_status === 'CANCELLED') ||
        (disposition.terminal_source_kind === 'TERMINATION_ATTRIBUTION' &&
          (disposition.terminal_resource_status === 'CANCELLED' ||
            disposition.terminal_resource_status === 'FAILED'));
      if (!validAttemptMapping) {
        addCustomIssue(
          ctx,
          ['terminal_resource_status'],
          'Attempt terminal status must match its terminal source authority',
        );
      }
    }
  });

export const RunRecoveryTicketDispositionV1Schema = z.union([
  ClaimedRecoveryTicketDispositionV1Schema,
  TerminalRecoveryTicketDispositionV1Schema,
]);

export const RunRecoveryHoldIntentV1Schema = z
  .strictObject({
    schema_version: z.literal('run-recovery-hold-intent/1'),
    recovery_hold_intent_id: UuidV1Schema,
    workspace_id: UuidV1Schema,
    run_id: UuidV1Schema,
    resource_kind: RunRecoveryResourceKindV1Schema,
    resource_id: UuidV1Schema,
    old_fencing_token: RunLeaseFencingTokenV1Schema,
    new_fencing_token: RunLeaseFencingTokenV1Schema,
    created_generation: RunLeaseFencingTokenV1Schema,
    hold_reason: z.enum([
      'MISSING_ENVELOPE',
      'UNSAFE_EFFECT',
      'SIDE_EFFECT_UNKNOWN',
      'EFFECT_CLOSURE_OPEN',
      'EFFECT_CLOSURE_UNKNOWN',
    ]),
    retry_effect_envelope_id: UuidV1Schema.optional(),
    retry_effect_envelope_sha256: Sha256HexV1Schema.optional(),
    effect_receipt_id: UuidV1Schema.optional(),
    effect_receipt_sha256: Sha256HexV1Schema.optional(),
    effect_closure_disposition: z.enum(['OPEN', 'UNKNOWN']).optional(),
    effect_closure_sha256: Sha256HexV1Schema.optional(),
    hold_evidence_sha256: Sha256HexV1Schema,
    checkpoint_id: UuidV1Schema.optional(),
    checkpoint_sha256: Sha256HexV1Schema.optional(),
    created_at: InstantV1Schema,
  })
  .superRefine((hold, ctx) => {
    addFenceIncrementIssue(
      hold.old_fencing_token,
      hold.new_fencing_token,
      ['new_fencing_token'],
      ctx,
    );
    if (hold.created_generation !== hold.new_fencing_token) {
      addCustomIssue(
        ctx,
        ['created_generation'],
        'hold generation must equal the fenced generation',
      );
    }
    addOptionalPairIssue(
      hold.retry_effect_envelope_id,
      hold.retry_effect_envelope_sha256,
      ['retry_effect_envelope_id'],
      'effect envelope identity and hash must be present together',
      ctx,
    );
    addOptionalPairIssue(
      hold.effect_receipt_id,
      hold.effect_receipt_sha256,
      ['effect_receipt_id'],
      'effect receipt identity and hash must be present together',
      ctx,
    );
    addOptionalPairIssue(
      hold.checkpoint_id,
      hold.checkpoint_sha256,
      ['checkpoint_id'],
      'checkpoint identity and hash must be present together',
      ctx,
    );
    addOptionalPairIssue(
      hold.effect_closure_disposition,
      hold.effect_closure_sha256,
      ['effect_closure_disposition'],
      'aggregate effect closure disposition and hash must be present together',
      ctx,
    );

    if (
      hold.hold_reason === 'MISSING_ENVELOPE' &&
      (hold.retry_effect_envelope_id !== undefined ||
        hold.effect_receipt_id !== undefined ||
        hold.effect_closure_disposition !== undefined)
    ) {
      addCustomIssue(
        ctx,
        ['hold_reason'],
        'missing-envelope HOLD cannot cite an envelope or receipt',
      );
    }
    if (
      hold.hold_reason === 'UNSAFE_EFFECT' &&
      (hold.retry_effect_envelope_id === undefined ||
        hold.effect_receipt_id !== undefined ||
        hold.effect_closure_disposition !== undefined)
    ) {
      addCustomIssue(
        ctx,
        ['hold_reason'],
        'unsafe-effect HOLD requires only its envelope evidence',
      );
    }
    if (
      hold.hold_reason === 'SIDE_EFFECT_UNKNOWN' &&
      (hold.retry_effect_envelope_id === undefined ||
        hold.effect_receipt_id === undefined ||
        hold.effect_closure_disposition !== undefined)
    ) {
      addCustomIssue(
        ctx,
        ['hold_reason'],
        'unknown-effect HOLD requires envelope and receipt evidence',
      );
    }
    if (
      (hold.hold_reason === 'EFFECT_CLOSURE_OPEN' ||
        hold.hold_reason === 'EFFECT_CLOSURE_UNKNOWN') &&
      (hold.retry_effect_envelope_id !== undefined ||
        hold.effect_receipt_id !== undefined ||
        hold.effect_closure_disposition !==
          (hold.hold_reason === 'EFFECT_CLOSURE_OPEN' ? 'OPEN' : 'UNKNOWN'))
    ) {
      addCustomIssue(
        ctx,
        ['hold_reason'],
        'aggregate-closure HOLD requires only its exact OPEN or UNKNOWN closure evidence',
      );
    }
  });

export const RunTerminalSourceKindV1Schema = z.enum([
  'TERMINATION_ATTRIBUTION',
  'DURABLE_CANCEL',
  'RECOVERY_HOLD',
]);

export const RunDispatchRetirementReceiptV1Schema = z
  .strictObject({
    schema_version: z.literal('run-dispatch-retirement-receipt/1'),
    retirement_receipt_id: UuidV1Schema,
    workspace_id: UuidV1Schema,
    run_id: UuidV1Schema,
    outbox_id: UuidV1Schema,
    old_status: z.enum(['PENDING', 'LEASED']),
    old_lease_owner: PostgresSessionUserV1Schema.optional(),
    old_lease_token: UuidV1Schema.optional(),
    old_lease_fencing_token: RunLeaseFencingTokenV1Schema.optional(),
    old_lease_expires_at: InstantV1Schema.optional(),
    old_delivery_generation: RunDispatchGenerationV1Schema,
    new_delivery_generation: RunDispatchGenerationV1Schema,
    retired_status: z.literal('DEAD'),
    last_error_code: z.literal('RUN_TERMINATED_BEFORE_DISPATCH'),
    terminal_source_kind: RunTerminalSourceKindV1Schema,
    terminal_source_id: UuidV1Schema,
    terminal_source_sha256: Sha256HexV1Schema,
    terminal_intent_sha256: Sha256HexV1Schema,
    retired_at: InstantV1Schema,
  })
  .superRefine((receipt, ctx) => {
    const leaseFields = [
      receipt.old_lease_owner,
      receipt.old_lease_token,
      receipt.old_lease_fencing_token,
      receipt.old_lease_expires_at,
    ];
    if (receipt.old_status === 'PENDING') {
      if (leaseFields.some((value) => value !== undefined)) {
        addCustomIssue(ctx, ['old_status'], 'PENDING dispatch cannot carry an old active lease');
      }
      if (receipt.new_delivery_generation !== receipt.old_delivery_generation) {
        addCustomIssue(
          ctx,
          ['new_delivery_generation'],
          'PENDING retirement preserves its durable delivery generation',
        );
      }
      return;
    }

    if (!leaseFields.every((value) => value !== undefined)) {
      addCustomIssue(ctx, ['old_status'], 'LEASED dispatch retirement requires the full old lease');
    }
    if (receipt.old_lease_fencing_token !== receipt.old_delivery_generation) {
      addCustomIssue(
        ctx,
        ['old_delivery_generation'],
        'LEASED dispatch generation must equal its old lease fencing token',
      );
    }
    addFenceIncrementIssue(
      receipt.old_delivery_generation,
      receipt.new_delivery_generation,
      ['new_delivery_generation'],
      ctx,
    );
  });

export type RunLeaseDurationSecondsV1 = z.infer<typeof RunLeaseDurationSecondsV1Schema>;
export type RunLeaseFencingTokenV1 = z.infer<typeof RunLeaseFencingTokenV1Schema>;
export type RunDispatchGenerationV1 = z.infer<typeof RunDispatchGenerationV1Schema>;
export type RunPositiveSequenceV1 = z.infer<typeof RunPositiveSequenceV1Schema>;
export type RunAttemptStatusV1 = z.infer<typeof RunAttemptStatusV1Schema>;
export type RunAttemptLeaseStateV1 = z.infer<typeof RunAttemptLeaseStateV1Schema>;
export type RunAttemptLeaseAuthorityV1 = z.infer<typeof RunAttemptLeaseAuthorityV1Schema>;
export type RunEffectClassV1 = z.infer<typeof RunEffectClassV1Schema>;
export type RunRecoveryDecisionV1 = z.infer<typeof RunRecoveryDecisionV1Schema>;
export type RunRetryEffectEnvelopeV1 = z.infer<typeof RunRetryEffectEnvelopeV1Schema>;
export type RunSideEffectReceiptV1 = z.infer<typeof RunSideEffectReceiptV1Schema>;
export type RunExecutionCheckpointV1 = z.infer<typeof RunExecutionCheckpointV1Schema>;
export type RunUsageAttributionV1 = z.infer<typeof RunUsageAttributionV1Schema>;
export type RunTerminationIntentV1 = z.infer<typeof RunTerminationIntentV1Schema>;
export type RunUsageAttributionRecordResultV1 = z.infer<
  typeof RunUsageAttributionRecordResultV1Schema
>;
export type RunTerminationIntentRecordResultV1 = z.infer<
  typeof RunTerminationIntentRecordResultV1Schema
>;
export type RunRecoveryResourceKindV1 = z.infer<typeof RunRecoveryResourceKindV1Schema>;
export type RunRecoveryEffectDecisionV1 = z.infer<typeof RunRecoveryEffectDecisionV1Schema>;
export type RunRecoveryTicketV1 = z.infer<typeof RunRecoveryTicketV1Schema>;
export type RunRecoveryTicketDispositionV1 = z.infer<typeof RunRecoveryTicketDispositionV1Schema>;
export type RunRecoveryHoldIntentV1 = z.infer<typeof RunRecoveryHoldIntentV1Schema>;
export type RunTerminalSourceKindV1 = z.infer<typeof RunTerminalSourceKindV1Schema>;
export type RunDispatchRetirementReceiptV1 = z.infer<typeof RunDispatchRetirementReceiptV1Schema>;
