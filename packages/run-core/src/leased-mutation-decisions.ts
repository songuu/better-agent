import {
  boundedNonBlankStringSchema,
  type RunDispatchRetirementReceiptV1,
  RunDispatchRetirementReceiptV1Schema,
  type RunEventV1,
  RunEventV1Schema,
  RunExecutionCheckpointV1Schema,
  type RunRecoveryTicketDispositionV1,
  RunRecoveryTicketDispositionV1Schema,
  RunRecoveryTicketV1Schema,
  type RunRetryEffectEnvelopeV1,
  RunRetryEffectEnvelopeV1Schema,
  RunSideEffectReceiptV1Schema,
  RunTerminationIntentV1Schema,
  RunUsageAttributionV1Schema,
  Sha256HexV1Schema,
} from '@better-agent/domain-contracts';
import { canonicalJsonBytes } from '@better-agent/release-core';

import {
  type AssertRunAttemptLeaseAuthorityInputV1,
  assertRunAttemptLeaseAuthority,
  readRunLeaseFencingToken,
} from './attempt-lease.js';
import { failRunCore } from './errors.js';
import { readPostgresInstantMicroseconds } from './postgres-instant.js';
import { prepareRunRecoveryEffectDecisionSet } from './recovery-decision.js';

export const LeasedExecutionEventKindsV1 = [
  'RUN_STARTED',
  'RUN_RETRY_WAIT',
  'RUN_RECOVERING',
  'ATTEMPT_LEASED',
  'ATTEMPT_FINISHED',
  'STEP_STARTED',
  'STEP_FINISHED',
] as const;

export type LeasedExecutionEventKindV1 = (typeof LeasedExecutionEventKindsV1)[number];

const maximumSafeDispatchGeneration = BigInt(Number.MAX_SAFE_INTEGER);
const canonicalNonnegativeGenerationPattern = /^(?:0|[1-9][0-9]*)$/;
const DispatchErrorCodeV1Schema = boundedNonBlankStringSchema(200, 'dispatch error code');

const leasedExecutionEventKinds = new Set<string>(LeasedExecutionEventKindsV1);

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    failRunCore('RUN_DISPATCH_INVALID', path, 'expected a non-empty string');
  }
  return value;
}

function requireSha256(value: unknown, path: string): string {
  const parsed = Sha256HexV1Schema.safeParse(value);
  if (!parsed.success) {
    failRunCore('RUN_DISPATCH_INVALID', path, 'expected a canonical SHA-256 digest', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function requireDispatchFailureDisposition(value: unknown): 'RETRY' | 'DEAD' {
  if (value !== 'RETRY' && value !== 'DEAD') {
    failRunCore(
      'RUN_DISPATCH_INVALID',
      '$.disposition',
      'expected RETRY or DEAD dispatch failure disposition',
    );
  }
  return value;
}

function requireDispatchErrorCode(value: unknown): string {
  const parsed = DispatchErrorCodeV1Schema.safeParse(value);
  if (!parsed.success) {
    failRunCore('RUN_DISPATCH_INVALID', '$.error_code', 'invalid dispatch error code', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function sameInstant(left: string, right: string): boolean {
  return (
    readPostgresInstantMicroseconds(left, '$.left', 'RUN_DISPATCH_INVALID') ===
    readPostgresInstantMicroseconds(right, '$.right', 'RUN_DISPATCH_INVALID')
  );
}

function assertEventBinding(
  event: RunEventV1,
  authority: ReturnType<typeof assertRunAttemptLeaseAuthority>,
  databaseNow: string,
): void {
  const stepMatches =
    event.step_id === undefined ||
    (authority.step_id !== undefined && event.step_id === authority.step_id);
  if (
    event.workspace_id !== authority.workspace_id ||
    event.run_id !== authority.run_id ||
    event.attempt_id !== authority.attempt_id ||
    !stepMatches ||
    !sameInstant(event.created_at, databaseNow)
  ) {
    failRunCore(
      'RUN_LEASED_MUTATION_INVALID',
      '$.event',
      'execution event does not bind the current Attempt authority and database time',
    );
  }
}

export interface PrepareLeasedExecutionEventInputV1 extends AssertRunAttemptLeaseAuthorityInputV1 {
  readonly event: unknown;
}

export function prepareLeasedExecutionEvent(input: PrepareLeasedExecutionEventInputV1) {
  const authority = assertRunAttemptLeaseAuthority(input);
  const parsed = RunEventV1Schema.safeParse(input.event);
  if (!parsed.success || !leasedExecutionEventKinds.has(parsed.data?.event_kind ?? '')) {
    failRunCore(
      'RUN_LEASED_MUTATION_INVALID',
      '$.event.event_kind',
      'only fixed execution progress events may use a Worker lease',
      { cause: parsed.success ? undefined : parsed.error },
    );
  }
  assertEventBinding(parsed.data, authority, input.database.now);
  return deepFreeze({ kind: 'APPEND_EXECUTION_EVENT' as const, event: parsed.data, authority });
}

function assertHistoricalProducerBinding(
  fact: {
    readonly workspace_id: string;
    readonly run_id: string;
    readonly attempt_id: string;
    readonly step_id?: string | undefined;
    readonly producer_session_user: string;
    readonly lease_owner: string;
    readonly lease_token: string;
    readonly lease_fencing_token: string;
    readonly lease_expires_at: string;
    readonly authorized_at: string;
  },
  authority: ReturnType<typeof assertRunAttemptLeaseAuthority>,
  path: string,
): void {
  if (
    fact.workspace_id !== authority.workspace_id ||
    fact.run_id !== authority.run_id ||
    fact.attempt_id !== authority.attempt_id ||
    fact.step_id !== authority.step_id ||
    fact.producer_session_user !== authority.session_user ||
    fact.lease_owner !== authority.lease_owner ||
    fact.lease_token !== authority.lease_token ||
    fact.lease_fencing_token !== authority.lease_fencing_token ||
    fact.lease_expires_at !== authority.lease_expires_at ||
    !sameInstant(fact.authorized_at, authority.authorized_at)
  ) {
    failRunCore(
      'RUN_LEASED_MUTATION_INVALID',
      path,
      'producer fact does not bind the exact current lease authority',
    );
  }
}

interface PrepareLeasedProducerFactInputV1 extends AssertRunAttemptLeaseAuthorityInputV1 {
  readonly [key: string]: unknown;
}

export function prepareLeasedExecutionCheckpoint(
  input: PrepareLeasedProducerFactInputV1 & { readonly checkpoint: unknown },
) {
  const authority = assertRunAttemptLeaseAuthority(input);
  const parsed = RunExecutionCheckpointV1Schema.safeParse(input.checkpoint);
  if (!parsed.success) {
    failRunCore(
      'RUN_LEASED_MUTATION_INVALID',
      '$.checkpoint',
      'execution checkpoint contract is invalid',
      { cause: parsed.error },
    );
  }
  assertHistoricalProducerBinding(parsed.data, authority, '$.checkpoint');
  return deepFreeze({
    kind: 'RECORD_EXECUTION_CHECKPOINT' as const,
    checkpoint: parsed.data,
    authority,
  });
}

function assertEffectEnvelopeBinding(
  envelope: RunRetryEffectEnvelopeV1,
  authority: ReturnType<typeof assertRunAttemptLeaseAuthority>,
  databaseNow: string,
): void {
  if (
    envelope.workspace_id !== authority.workspace_id ||
    envelope.run_id !== authority.run_id ||
    envelope.attempt_id !== authority.attempt_id ||
    envelope.step_id !== authority.step_id ||
    !sameInstant(envelope.created_at, databaseNow)
  ) {
    failRunCore(
      'RUN_LEASED_MUTATION_INVALID',
      '$.envelope',
      'effect envelope does not bind the current Attempt authority, Step, and database time',
    );
  }
}

export function prepareLeasedEffectEnvelope(
  input: PrepareLeasedProducerFactInputV1 & { readonly envelope: unknown },
) {
  const authority = assertRunAttemptLeaseAuthority(input);
  const parsed = RunRetryEffectEnvelopeV1Schema.safeParse(input.envelope);
  if (!parsed.success) {
    failRunCore(
      'RUN_LEASED_MUTATION_INVALID',
      '$.envelope',
      'retry effect envelope contract is invalid',
      { cause: parsed.error },
    );
  }
  assertEffectEnvelopeBinding(parsed.data, authority, input.database.now);
  return deepFreeze({ kind: 'RECORD_EFFECT_ENVELOPE' as const, envelope: parsed.data, authority });
}

export function prepareLeasedEffectReceipt(
  input: PrepareLeasedProducerFactInputV1 & { readonly receipt: unknown },
) {
  const authority = assertRunAttemptLeaseAuthority(input);
  const parsed = RunSideEffectReceiptV1Schema.safeParse(input.receipt);
  if (!parsed.success) {
    failRunCore(
      'RUN_LEASED_MUTATION_INVALID',
      '$.receipt',
      'side-effect receipt contract is invalid',
      { cause: parsed.error },
    );
  }
  assertHistoricalProducerBinding(parsed.data, authority, '$.receipt');
  return deepFreeze({ kind: 'RECORD_EFFECT_RECEIPT' as const, receipt: parsed.data, authority });
}

export function prepareLeasedUsageAttribution(
  input: PrepareLeasedProducerFactInputV1 & { readonly attribution: unknown },
) {
  const authority = assertRunAttemptLeaseAuthority(input);
  const parsed = RunUsageAttributionV1Schema.safeParse(input.attribution);
  if (!parsed.success) {
    failRunCore(
      'RUN_LEASED_MUTATION_INVALID',
      '$.attribution',
      'usage attribution contract is invalid',
      { cause: parsed.error },
    );
  }
  assertHistoricalProducerBinding(parsed.data, authority, '$.attribution');
  return deepFreeze({
    kind: 'RECORD_USAGE_ATTRIBUTION' as const,
    attribution: parsed.data,
    authority,
  });
}

export function prepareLeasedTerminationIntent(
  input: PrepareLeasedProducerFactInputV1 & { readonly termination_intent: unknown },
) {
  const authority = assertRunAttemptLeaseAuthority(input);
  const parsed = RunTerminationIntentV1Schema.safeParse(input.termination_intent);
  if (!parsed.success) {
    failRunCore(
      'RUN_LEASED_MUTATION_INVALID',
      '$.termination_intent',
      'termination intent contract is invalid or its effect closure is not CLOSED',
      { cause: parsed.error },
    );
  }
  assertHistoricalProducerBinding(parsed.data, authority, '$.termination_intent');
  return deepFreeze({
    kind: 'RECORD_TERMINATION_INTENT' as const,
    termination_intent: parsed.data,
    authority,
  });
}

export type RunDispatchStatusV1 = 'PENDING' | 'LEASED' | 'DELIVERED' | 'DEAD';

export interface RunDispatchStateV1 {
  readonly workspace_id: string;
  readonly run_id: string;
  readonly outbox_id: string;
  readonly message_type: 'RUN_DISPATCH';
  readonly status: RunDispatchStatusV1;
  readonly delivery_generation: string;
  readonly lease_owner?: string;
  readonly lease_token?: string;
  readonly lease_fencing_token?: string;
  readonly lease_expires_at?: string;
  readonly delivered_at?: string;
  readonly recovery_ticket_id?: string;
  readonly last_error_code?: string;
  readonly retirement_receipt_id?: string;
  readonly retirement_receipt?: RunDispatchRetirementReceiptV1;
  readonly delivery_failure_evidence_sha256?: string;
  readonly updated_at: string;
  readonly [key: string]: unknown;
}

export interface RunDispatchLeaseAuthorityV1 {
  readonly workspace_id: string;
  readonly run_id: string;
  readonly outbox_id: string;
  readonly message_type: 'RUN_DISPATCH';
  readonly session_user: string;
  readonly lease_owner: string;
  readonly lease_token: string;
  readonly lease_fencing_token: string;
  readonly delivery_generation: string;
  readonly lease_expires_at: string;
  readonly authorized_at: string;
}

function parseDispatchState(value: unknown): RunDispatchStateV1 {
  const record =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (
    record === undefined ||
    typeof record.workspace_id !== 'string' ||
    typeof record.run_id !== 'string' ||
    typeof record.outbox_id !== 'string' ||
    typeof record.updated_at !== 'string' ||
    typeof record.delivery_generation !== 'string' ||
    (record.status !== 'PENDING' &&
      record.status !== 'LEASED' &&
      record.status !== 'DELIVERED' &&
      record.status !== 'DEAD')
  ) {
    failRunCore('RUN_DISPATCH_INVALID', '$.current', 'RUN_DISPATCH state is incomplete');
  }
  if (record.message_type !== 'RUN_DISPATCH') {
    failRunCore(
      'RUN_DISPATCH_INVALID',
      '$.current.message_type',
      'only RUN_DISPATCH may use execution delivery authority',
    );
  }
  readRunDispatchGeneration(record.delivery_generation, '$.current.delivery_generation');
  const hasAnyLease =
    record.lease_owner !== undefined ||
    record.lease_token !== undefined ||
    record.lease_fencing_token !== undefined ||
    record.lease_expires_at !== undefined;
  const hasCompleteLease =
    typeof record.lease_owner === 'string' &&
    typeof record.lease_token === 'string' &&
    typeof record.lease_fencing_token === 'string' &&
    typeof record.lease_expires_at === 'string';
  if (record.status === 'LEASED' && hasCompleteLease) {
    try {
      readRunLeaseFencingToken(record.lease_fencing_token, '$.current.lease_fencing_token');
    } catch (error) {
      if (error instanceof Error && error.message.includes('RUN_LEASE_FENCING_OVERFLOW')) {
        throw error;
      }
      failRunCore(
        'RUN_DISPATCH_INVALID',
        '$.current.lease_fencing_token',
        'lease fence is invalid',
        {
          cause: error,
        },
      );
    }
  }
  if (
    (record.status === 'LEASED' &&
      (!hasCompleteLease ||
        record.lease_fencing_token !== record.delivery_generation ||
        record.delivered_at !== undefined ||
        record.recovery_ticket_id !== undefined)) ||
    (record.status !== 'LEASED' && hasAnyLease) ||
    (record.status === 'DELIVERED' && typeof record.delivered_at !== 'string') ||
    (record.status !== 'DELIVERED' && record.delivered_at !== undefined)
  ) {
    failRunCore('RUN_DISPATCH_INVALID', '$.current.status', 'RUN_DISPATCH state shape is invalid');
  }
  const hasRetirementEvidence = record.retirement_receipt_id !== undefined;
  const hasFailureEvidence = record.delivery_failure_evidence_sha256 !== undefined;
  if (
    (hasRetirementEvidence && typeof record.retirement_receipt_id !== 'string') ||
    (hasFailureEvidence &&
      !Sha256HexV1Schema.safeParse(record.delivery_failure_evidence_sha256).success) ||
    (record.status === 'DEAD' && hasRetirementEvidence === hasFailureEvidence) ||
    (record.status !== 'DEAD' && (hasRetirementEvidence || hasFailureEvidence)) ||
    (record.status === 'DEAD' && typeof record.last_error_code !== 'string') ||
    (hasRetirementEvidence && record.last_error_code !== 'RUN_TERMINATED_BEFORE_DISPATCH')
  ) {
    failRunCore(
      'RUN_DISPATCH_INVALID',
      '$.current.status',
      'DEAD dispatch requires exactly one state-bound failure or retirement evidence',
    );
  }
  if (hasRetirementEvidence) {
    const parsedReceipt = RunDispatchRetirementReceiptV1Schema.safeParse(record.retirement_receipt);
    if (
      !parsedReceipt.success ||
      parsedReceipt.data.retirement_receipt_id !== record.retirement_receipt_id ||
      parsedReceipt.data.workspace_id !== record.workspace_id ||
      parsedReceipt.data.run_id !== record.run_id ||
      parsedReceipt.data.outbox_id !== record.outbox_id ||
      parsedReceipt.data.new_delivery_generation !== record.delivery_generation ||
      parsedReceipt.data.last_error_code !== record.last_error_code ||
      !sameInstant(parsedReceipt.data.retired_at, record.updated_at)
    ) {
      failRunCore(
        'RUN_DISPATCH_INVALID',
        '$.current.retirement_receipt',
        'retired DEAD dispatch requires its exact immutable receipt projection',
        { cause: parsedReceipt.success ? undefined : parsedReceipt.error },
      );
    }
  } else if (record.retirement_receipt !== undefined) {
    failRunCore(
      'RUN_DISPATCH_INVALID',
      '$.current.retirement_receipt',
      'only retirement-backed DEAD dispatch carries a retirement receipt projection',
    );
  }
  return structuredClone(record) as unknown as RunDispatchStateV1;
}

function readRunDispatchGeneration(value: unknown, path: string): bigint {
  if (typeof value !== 'string' || !canonicalNonnegativeGenerationPattern.test(value)) {
    failRunCore('RUN_DISPATCH_INVALID', path, 'delivery generation is invalid');
  }
  const generation = BigInt(value);
  if (generation > maximumSafeDispatchGeneration) {
    failRunCore(
      'RUN_LEASE_FENCING_OVERFLOW',
      path,
      'delivery generation exceeds the JavaScript safe-integer boundary',
    );
  }
  return generation;
}

function advanceRunDispatchGeneration(value: unknown, path: string): string {
  const generation = readRunDispatchGeneration(value, path);
  if (generation === maximumSafeDispatchGeneration) {
    failRunCore(
      'RUN_LEASE_FENCING_OVERFLOW',
      path,
      'delivery generation cannot advance beyond the safe-integer boundary',
    );
  }
  return String(generation + 1n);
}

function clearDispatchLease(state: RunDispatchStateV1): Record<string, unknown> {
  const next = structuredClone(state) as Record<string, unknown>;
  delete next.lease_owner;
  delete next.lease_token;
  delete next.lease_fencing_token;
  delete next.lease_expires_at;
  delete next.recovery_ticket_id;
  return next;
}

function readDurationSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 300) {
    failRunCore(
      'RUN_DISPATCH_INVALID',
      '$.duration_seconds',
      'dispatch lease duration must be an integer from 1 to 300 seconds',
    );
  }
  return value;
}

function assertDispatchExpiry(now: string, expiresAt: string, durationSeconds: number): void {
  const start = readPostgresInstantMicroseconds(now, '$.database.now', 'RUN_DISPATCH_INVALID');
  const end = readPostgresInstantMicroseconds(
    expiresAt,
    '$.database.lease_expires_at',
    'RUN_DISPATCH_INVALID',
  );
  if (end - start !== BigInt(durationSeconds) * 1_000_000n) {
    failRunCore(
      'RUN_DISPATCH_INVALID',
      '$.database.lease_expires_at',
      'dispatch expiry must equal locked database time plus duration',
    );
  }
}

function sealRecoveryDisposition(value: unknown): Readonly<RunRecoveryTicketDispositionV1> {
  const parsed = RunRecoveryTicketDispositionV1Schema.safeParse(value);
  if (!parsed.success) {
    failRunCore(
      'RUN_DISPATCH_INVALID',
      '$.recovery_ticket_disposition',
      'dispatch recovery disposition is invalid',
      { cause: parsed.error },
    );
  }
  return deepFreeze(parsed.data);
}

function assertNonterminal(runIsTerminal: boolean): void {
  if (runIsTerminal) {
    failRunCore(
      'RUN_DISPATCH_INVALID',
      '$.run_is_terminal',
      'terminal Run cannot acquire or mutate a dispatch lease',
    );
  }
}

function parseDispatchAuthority(value: unknown): RunDispatchLeaseAuthorityV1 {
  const record =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (
    record === undefined ||
    record.message_type !== 'RUN_DISPATCH' ||
    typeof record.workspace_id !== 'string' ||
    typeof record.run_id !== 'string' ||
    typeof record.outbox_id !== 'string' ||
    typeof record.session_user !== 'string' ||
    typeof record.lease_owner !== 'string' ||
    typeof record.lease_token !== 'string' ||
    typeof record.lease_fencing_token !== 'string' ||
    typeof record.delivery_generation !== 'string' ||
    typeof record.lease_expires_at !== 'string' ||
    typeof record.authorized_at !== 'string'
  ) {
    failRunCore('RUN_DISPATCH_INVALID', '$.authority', 'dispatch authority is incomplete');
  }
  return structuredClone(record) as unknown as RunDispatchLeaseAuthorityV1;
}

function assertRunDispatchAuthority(input: {
  readonly current: unknown;
  readonly authority: unknown;
  readonly run_is_terminal: boolean;
  readonly database: { readonly now: string; readonly session_user: string };
}): { state: RunDispatchStateV1; authority: RunDispatchLeaseAuthorityV1 } {
  assertNonterminal(input.run_is_terminal);
  const state = parseDispatchState(input.current);
  const authority = parseDispatchAuthority(input.authority);
  const now = readPostgresInstantMicroseconds(
    input.database.now,
    '$.database.now',
    'RUN_DISPATCH_INVALID',
  );
  if (
    state.status !== 'LEASED' ||
    authority.workspace_id !== state.workspace_id ||
    authority.run_id !== state.run_id ||
    authority.outbox_id !== state.outbox_id ||
    authority.session_user !== input.database.session_user ||
    authority.lease_owner !== input.database.session_user ||
    authority.lease_owner !== state.lease_owner ||
    authority.lease_token !== state.lease_token ||
    authority.lease_fencing_token !== state.lease_fencing_token ||
    authority.delivery_generation !== state.delivery_generation ||
    authority.lease_expires_at !== state.lease_expires_at
  ) {
    failRunCore(
      'RUN_DISPATCH_INVALID',
      '$.authority',
      'dispatch authority does not match the current delivery generation and session user',
    );
  }
  const expiry = readPostgresInstantMicroseconds(
    authority.lease_expires_at,
    '$.authority.lease_expires_at',
    'RUN_DISPATCH_INVALID',
  );
  if (now >= expiry || !sameInstant(authority.authorized_at, input.database.now)) {
    failRunCore(
      'RUN_DISPATCH_INVALID',
      '$.authority.lease_expires_at',
      'dispatch authority is expired or was not established at locked database time',
    );
  }
  return { state, authority };
}

export function decideRunDispatchClaim(input: {
  readonly current: unknown;
  readonly run_is_terminal: boolean;
  readonly duration_seconds: unknown;
  readonly database: {
    readonly now: string;
    readonly session_user: string;
    readonly lease_token: string;
    readonly lease_expires_at: string;
  };
}) {
  assertNonterminal(input.run_is_terminal);
  const state = parseDispatchState(input.current);
  if (state.status !== 'PENDING' || state.recovery_ticket_id !== undefined) {
    failRunCore(
      'RUN_DISPATCH_INVALID',
      '$.current.status',
      'initial dispatch claim requires PENDING without a recovery ticket',
    );
  }
  const duration = readDurationSeconds(input.duration_seconds);
  assertDispatchExpiry(input.database.now, input.database.lease_expires_at, duration);
  const generation = advanceRunDispatchGeneration(
    state.delivery_generation,
    '$.current.delivery_generation',
  );
  requireString(input.database.session_user, '$.database.session_user');
  requireString(input.database.lease_token, '$.database.lease_token');
  const nextState = deepFreeze({
    ...clearDispatchLease(state),
    status: 'LEASED' as const,
    delivery_generation: generation,
    lease_owner: input.database.session_user,
    lease_token: input.database.lease_token,
    lease_fencing_token: generation,
    lease_expires_at: input.database.lease_expires_at,
    updated_at: input.database.now,
  }) as Readonly<RunDispatchStateV1>;
  const authority = deepFreeze({
    workspace_id: state.workspace_id,
    run_id: state.run_id,
    outbox_id: state.outbox_id,
    message_type: 'RUN_DISPATCH' as const,
    session_user: input.database.session_user,
    lease_owner: input.database.session_user,
    lease_token: input.database.lease_token,
    lease_fencing_token: generation,
    delivery_generation: generation,
    lease_expires_at: input.database.lease_expires_at,
    authorized_at: input.database.now,
  });
  return deepFreeze({ kind: 'CLAIM' as const, next_state: nextState, authority });
}

export function decideRunDispatchRenewal(input: {
  readonly current: unknown;
  readonly authority: unknown;
  readonly run_is_terminal: boolean;
  readonly duration_seconds: unknown;
  readonly database: {
    readonly now: string;
    readonly session_user: string;
    readonly lease_expires_at: string;
  };
}) {
  const duration = readDurationSeconds(input.duration_seconds);
  const { state, authority } = assertRunDispatchAuthority(input);
  assertDispatchExpiry(input.database.now, input.database.lease_expires_at, duration);
  if (
    readPostgresInstantMicroseconds(
      input.database.lease_expires_at,
      '$.database.lease_expires_at',
      'RUN_DISPATCH_INVALID',
    ) <=
    readPostgresInstantMicroseconds(
      authority.lease_expires_at,
      '$.authority.lease_expires_at',
      'RUN_DISPATCH_INVALID',
    )
  ) {
    failRunCore(
      'RUN_DISPATCH_INVALID',
      '$.database.lease_expires_at',
      'dispatch renewal must strictly extend expiry',
    );
  }
  return deepFreeze({
    kind: 'RENEW' as const,
    next_state: deepFreeze({
      ...state,
      lease_expires_at: input.database.lease_expires_at,
      updated_at: input.database.now,
    }),
    authority: deepFreeze({
      ...authority,
      lease_expires_at: input.database.lease_expires_at,
      authorized_at: input.database.now,
    }),
  });
}

export function decideRunDispatchCompletion(input: {
  readonly current: unknown;
  readonly authority: unknown;
  readonly run_is_terminal: boolean;
  readonly database: { readonly now: string; readonly session_user: string };
}) {
  const { state } = assertRunDispatchAuthority(input);
  return deepFreeze({
    kind: 'COMPLETE' as const,
    next_state: deepFreeze({
      ...clearDispatchLease(state),
      status: 'DELIVERED' as const,
      delivered_at: input.database.now,
      updated_at: input.database.now,
    }) as Readonly<RunDispatchStateV1>,
  });
}

export function decideRunDispatchFailure(input: {
  readonly current: unknown;
  readonly authority: unknown;
  readonly run_is_terminal: boolean;
  readonly disposition: 'RETRY' | 'DEAD';
  readonly error_code: string;
  readonly delivery_failure_evidence_sha256?: string;
  readonly database: { readonly now: string; readonly session_user: string };
}) {
  const { state } = assertRunDispatchAuthority(input);
  const disposition = requireDispatchFailureDisposition(input.disposition);
  const errorCode = requireDispatchErrorCode(input.error_code);
  if (disposition === 'DEAD' && input.delivery_failure_evidence_sha256 === undefined) {
    failRunCore(
      'RUN_DISPATCH_INVALID',
      '$.delivery_failure_evidence_sha256',
      'DEAD delivery failure requires immutable evidence',
    );
  }
  if (disposition === 'RETRY' && input.delivery_failure_evidence_sha256 !== undefined) {
    failRunCore(
      'RUN_DISPATCH_INVALID',
      '$.delivery_failure_evidence_sha256',
      'retryable delivery failure cannot claim terminal DEAD evidence',
    );
  }
  const failureEvidence =
    input.delivery_failure_evidence_sha256 === undefined
      ? undefined
      : requireSha256(input.delivery_failure_evidence_sha256, '$.delivery_failure_evidence_sha256');
  return deepFreeze({
    kind: 'FAIL' as const,
    next_state: deepFreeze({
      ...clearDispatchLease(state),
      status: disposition === 'RETRY' ? ('PENDING' as const) : ('DEAD' as const),
      last_error_code: errorCode,
      ...(failureEvidence === undefined
        ? {}
        : { delivery_failure_evidence_sha256: failureEvidence }),
      updated_at: input.database.now,
    }) as Readonly<RunDispatchStateV1>,
  });
}

export function decideRunDispatchRecoveryFence(input: {
  readonly current: unknown;
  readonly run_is_terminal: boolean;
  readonly retry_effect_envelope_id: string;
  readonly retry_effect_envelope_sha256: string;
  readonly recovery_decision: 'REPLAY_SAFE' | 'REPLAY_WITH_KEY';
  readonly operation_key?: string;
  readonly database: {
    readonly now: string;
    readonly recovery_ticket_id: string;
    readonly created_at: string;
  };
}) {
  assertNonterminal(input.run_is_terminal);
  const state = parseDispatchState(input.current);
  if (state.status !== 'LEASED' || state.lease_expires_at === undefined) {
    failRunCore(
      'RUN_DISPATCH_INVALID',
      '$.current.status',
      'dispatch recovery fence requires an active LEASED generation',
    );
  }
  if (
    readPostgresInstantMicroseconds(input.database.now, '$.database.now', 'RUN_DISPATCH_INVALID') <
    readPostgresInstantMicroseconds(
      state.lease_expires_at,
      '$.current.lease_expires_at',
      'RUN_DISPATCH_INVALID',
    )
  ) {
    failRunCore(
      'RUN_DISPATCH_INVALID',
      '$.current.lease_expires_at',
      'dispatch recovery fence cannot run before expiry',
    );
  }
  const generation = advanceRunDispatchGeneration(
    state.delivery_generation,
    '$.current.delivery_generation',
  );
  const effectDecisionSet = prepareRunRecoveryEffectDecisionSet([
    {
      retry_effect_envelope_id: input.retry_effect_envelope_id,
      retry_effect_envelope_sha256: input.retry_effect_envelope_sha256,
      effect_class: input.recovery_decision === 'REPLAY_SAFE' ? 'SAFE' : 'REQUIRES_KEY',
      recovery_decision: input.recovery_decision,
      ...(input.operation_key === undefined ? {} : { operation_key: input.operation_key }),
    },
  ]);
  const ticketResult = RunRecoveryTicketV1Schema.safeParse({
    schema_version: 'run-recovery-ticket/1',
    recovery_ticket_id: input.database.recovery_ticket_id,
    workspace_id: state.workspace_id,
    run_id: state.run_id,
    resource_kind: 'RUN_DISPATCH',
    resource_id: state.outbox_id,
    old_fencing_token: state.delivery_generation,
    new_fencing_token: generation,
    created_generation: generation,
    ...effectDecisionSet,
    created_at: input.database.created_at,
  });
  if (!ticketResult.success) {
    failRunCore('RUN_DISPATCH_INVALID', '$.recovery_ticket', 'dispatch ticket is invalid', {
      cause: ticketResult.error,
    });
  }
  return deepFreeze({
    kind: 'RECOVERY_FENCE' as const,
    next_state: deepFreeze({
      ...clearDispatchLease(state),
      status: 'PENDING' as const,
      delivery_generation: generation,
      recovery_ticket_id: input.database.recovery_ticket_id,
      updated_at: input.database.now,
    }) as Readonly<RunDispatchStateV1>,
    recovery_ticket: ticketResult.data,
  });
}

export function decideRunDispatchRecoveryClaim(input: {
  readonly current: unknown;
  readonly recovery_ticket: unknown;
  readonly recovery_ticket_sha256: string;
  readonly existing_disposition?: unknown;
  readonly run_is_terminal: boolean;
  readonly duration_seconds: unknown;
  readonly database: {
    readonly now: string;
    readonly session_user: string;
    readonly lease_token: string;
    readonly lease_expires_at: string;
    readonly disposition_id: string;
    readonly disposed_at: string;
  };
}) {
  assertNonterminal(input.run_is_terminal);
  const state = parseDispatchState(input.current);
  const ticketResult = RunRecoveryTicketV1Schema.safeParse(input.recovery_ticket);
  if (!ticketResult.success) {
    failRunCore(
      'RUN_DISPATCH_INVALID',
      '$.recovery_ticket',
      'dispatch recovery ticket is invalid',
      { cause: ticketResult.error },
    );
  }
  const ticket = ticketResult.data;
  if (
    state.status !== 'PENDING' ||
    state.recovery_ticket_id === undefined ||
    ticket.resource_kind !== 'RUN_DISPATCH' ||
    ticket.workspace_id !== state.workspace_id ||
    ticket.run_id !== state.run_id ||
    ticket.resource_id !== state.outbox_id ||
    ticket.recovery_ticket_id !== state.recovery_ticket_id ||
    ticket.new_fencing_token !== state.delivery_generation ||
    ticket.created_generation !== state.delivery_generation
  ) {
    failRunCore(
      'RUN_DISPATCH_INVALID',
      '$.recovery_ticket',
      'ticket does not bind the PENDING dispatch generation',
    );
  }
  if (input.existing_disposition !== undefined) {
    failRunCore(
      'RUN_DISPATCH_RETIREMENT_CONFLICT',
      '$.existing_disposition',
      'dispatch recovery ticket was already consumed',
    );
  }
  const duration = readDurationSeconds(input.duration_seconds);
  assertDispatchExpiry(input.database.now, input.database.lease_expires_at, duration);
  const sessionUser = requireString(input.database.session_user, '$.database.session_user');
  const leaseToken = requireString(input.database.lease_token, '$.database.lease_token');
  const claimedGeneration = advanceRunDispatchGeneration(
    state.delivery_generation,
    '$.current.delivery_generation',
  );
  const disposition = sealRecoveryDisposition({
    schema_version: 'run-recovery-ticket-disposition/1',
    disposition_id: input.database.disposition_id,
    recovery_ticket_id: ticket.recovery_ticket_id,
    recovery_ticket_sha256: input.recovery_ticket_sha256,
    workspace_id: ticket.workspace_id,
    run_id: ticket.run_id,
    resource_kind: 'RUN_DISPATCH',
    resource_id: ticket.resource_id,
    ticket_fencing_token: ticket.new_fencing_token,
    disposition_kind: 'CLAIMED',
    claim_fencing_token: claimedGeneration,
    claim_session_user: sessionUser,
    claim_lease_owner: sessionUser,
    claim_lease_token: leaseToken,
    claim_lease_expires_at: input.database.lease_expires_at,
    disposed_at: input.database.disposed_at,
  });
  const nextState = deepFreeze({
    ...clearDispatchLease(state),
    status: 'LEASED' as const,
    delivery_generation: claimedGeneration,
    lease_owner: sessionUser,
    lease_token: leaseToken,
    lease_fencing_token: claimedGeneration,
    lease_expires_at: input.database.lease_expires_at,
    updated_at: input.database.now,
  }) as Readonly<RunDispatchStateV1>;
  const authority = deepFreeze({
    workspace_id: state.workspace_id,
    run_id: state.run_id,
    outbox_id: state.outbox_id,
    message_type: 'RUN_DISPATCH' as const,
    session_user: sessionUser,
    lease_owner: sessionUser,
    lease_token: leaseToken,
    lease_fencing_token: claimedGeneration,
    delivery_generation: claimedGeneration,
    lease_expires_at: input.database.lease_expires_at,
    authorized_at: input.database.now,
  });
  return deepFreeze({
    kind: 'RECOVERY_CLAIM' as const,
    next_state: nextState,
    authority,
    disposition,
  });
}

export interface RunDispatchTerminalSourceV1 {
  readonly kind: 'TERMINATION_ATTRIBUTION' | 'DURABLE_CANCEL' | 'RECOVERY_HOLD';
  readonly id: string;
  readonly sha256: string;
  readonly terminal_intent_sha256: string;
}

function retirementMatches(
  receipt: RunDispatchRetirementReceiptV1,
  state: RunDispatchStateV1,
  source: RunDispatchTerminalSourceV1,
  requestedReceiptId: string,
  requestedRetiredAt: string,
): boolean {
  return (
    receipt.retirement_receipt_id === requestedReceiptId &&
    state.retirement_receipt_id === receipt.retirement_receipt_id &&
    state.last_error_code === receipt.last_error_code &&
    receipt.workspace_id === state.workspace_id &&
    receipt.run_id === state.run_id &&
    receipt.outbox_id === state.outbox_id &&
    receipt.new_delivery_generation === state.delivery_generation &&
    receipt.terminal_source_kind === source.kind &&
    receipt.terminal_source_id === source.id &&
    receipt.terminal_source_sha256 === source.sha256 &&
    receipt.terminal_intent_sha256 === source.terminal_intent_sha256 &&
    sameInstant(receipt.retired_at, requestedRetiredAt) &&
    state.retirement_receipt !== undefined &&
    canonicalJsonBytes(receipt).equals(canonicalJsonBytes(state.retirement_receipt))
  );
}

export function decideRunDispatchRetirement(input: {
  readonly current: unknown;
  readonly terminal_source: RunDispatchTerminalSourceV1;
  readonly existing_retirement_receipt?: unknown;
  readonly existing_delivery_failure_evidence_sha256?: string;
  readonly recovery_ticket?: unknown;
  readonly recovery_ticket_sha256?: string;
  readonly database: {
    readonly receipt_id: string;
    readonly retired_at: string;
    readonly recovery_disposition_id?: string;
  };
}) {
  const state = parseDispatchState(input.current);
  if (state.status === 'DELIVERED') {
    return deepFreeze({
      kind: 'ALREADY_DELIVERED' as const,
      next_state: deepFreeze(state),
      receipt: undefined,
      recovery_ticket_disposition: undefined,
    });
  }
  if (state.status === 'DEAD') {
    const hasRetirementEvidence = input.existing_retirement_receipt !== undefined;
    const hasFailureEvidence = input.existing_delivery_failure_evidence_sha256 !== undefined;
    if (hasRetirementEvidence === hasFailureEvidence) {
      failRunCore(
        'RUN_DISPATCH_RETIREMENT_CONFLICT',
        '$.current.status',
        'DEAD replay requires exactly one matching retirement or delivery-failure evidence',
      );
    }
    if (input.existing_retirement_receipt !== undefined) {
      const parsed = RunDispatchRetirementReceiptV1Schema.safeParse(
        input.existing_retirement_receipt,
      );
      if (
        !parsed.success ||
        !retirementMatches(
          parsed.data,
          state,
          input.terminal_source,
          input.database.receipt_id,
          input.database.retired_at,
        )
      ) {
        failRunCore(
          'RUN_DISPATCH_RETIREMENT_CONFLICT',
          '$.existing_retirement_receipt',
          'DEAD dispatch carries a different retirement intent',
          { cause: parsed.success ? undefined : parsed.error },
        );
      }
      return deepFreeze({
        kind: 'REPLAY' as const,
        next_state: deepFreeze(state),
        receipt: deepFreeze(parsed.data),
        recovery_ticket_disposition: undefined,
      });
    }
    if (input.existing_delivery_failure_evidence_sha256 !== undefined) {
      const failureEvidence = requireSha256(
        input.existing_delivery_failure_evidence_sha256,
        '$.existing_delivery_failure_evidence_sha256',
      );
      if (
        state.retirement_receipt_id !== undefined ||
        state.delivery_failure_evidence_sha256 !== failureEvidence
      ) {
        failRunCore(
          'RUN_DISPATCH_RETIREMENT_CONFLICT',
          '$.existing_delivery_failure_evidence_sha256',
          'delivery failure evidence does not match the immutable DEAD state',
        );
      }
      return deepFreeze({
        kind: 'ALREADY_DEAD' as const,
        next_state: deepFreeze(state),
        receipt: undefined,
        recovery_ticket_disposition: undefined,
      });
    }
    failRunCore(
      'RUN_DISPATCH_RETIREMENT_CONFLICT',
      '$.current.status',
      'DEAD dispatch requires protocol-v5 failure or retirement evidence',
    );
  }
  let recoveryDisposition: Readonly<RunRecoveryTicketDispositionV1> | undefined;
  if (state.recovery_ticket_id !== undefined) {
    const ticketResult = RunRecoveryTicketV1Schema.safeParse(input.recovery_ticket);
    if (
      !ticketResult.success ||
      input.recovery_ticket_sha256 === undefined ||
      input.database.recovery_disposition_id === undefined
    ) {
      failRunCore(
        'RUN_DISPATCH_RETIREMENT_CONFLICT',
        '$.recovery_ticket',
        'dispatch ticket retirement requires the exact ticket, hash and disposition ID',
        { cause: ticketResult.success ? undefined : ticketResult.error },
      );
    }
    const ticket = ticketResult.data;
    if (
      ticket.resource_kind !== 'RUN_DISPATCH' ||
      ticket.workspace_id !== state.workspace_id ||
      ticket.run_id !== state.run_id ||
      ticket.resource_id !== state.outbox_id ||
      ticket.recovery_ticket_id !== state.recovery_ticket_id ||
      ticket.new_fencing_token !== state.delivery_generation
    ) {
      failRunCore(
        'RUN_DISPATCH_RETIREMENT_CONFLICT',
        '$.recovery_ticket',
        'dispatch recovery ticket does not bind the retired generation',
      );
    }
    recoveryDisposition = sealRecoveryDisposition({
      schema_version: 'run-recovery-ticket-disposition/1',
      disposition_id: input.database.recovery_disposition_id,
      recovery_ticket_id: ticket.recovery_ticket_id,
      recovery_ticket_sha256: input.recovery_ticket_sha256,
      workspace_id: ticket.workspace_id,
      run_id: ticket.run_id,
      resource_kind: 'RUN_DISPATCH',
      resource_id: ticket.resource_id,
      ticket_fencing_token: ticket.new_fencing_token,
      disposition_kind: 'TERMINAL_RETIRED',
      terminal_source_kind: input.terminal_source.kind,
      terminal_source_id: input.terminal_source.id,
      terminal_source_sha256: input.terminal_source.sha256,
      terminal_intent_sha256: input.terminal_source.terminal_intent_sha256,
      terminal_resource_status: 'DEAD',
      disposed_at: input.database.retired_at,
    });
  }
  const newGeneration =
    state.status === 'LEASED'
      ? advanceRunDispatchGeneration(state.delivery_generation, '$.current.delivery_generation')
      : state.delivery_generation;
  const receiptResult = RunDispatchRetirementReceiptV1Schema.safeParse({
    schema_version: 'run-dispatch-retirement-receipt/1',
    retirement_receipt_id: input.database.receipt_id,
    workspace_id: state.workspace_id,
    run_id: state.run_id,
    outbox_id: state.outbox_id,
    old_status: state.status,
    ...(state.status === 'LEASED'
      ? {
          old_lease_owner: state.lease_owner,
          old_lease_token: state.lease_token,
          old_lease_fencing_token: state.lease_fencing_token,
          old_lease_expires_at: state.lease_expires_at,
        }
      : {}),
    old_delivery_generation: state.delivery_generation,
    new_delivery_generation: newGeneration,
    retired_status: 'DEAD',
    last_error_code: 'RUN_TERMINATED_BEFORE_DISPATCH',
    terminal_source_kind: input.terminal_source.kind,
    terminal_source_id: input.terminal_source.id,
    terminal_source_sha256: input.terminal_source.sha256,
    terminal_intent_sha256: input.terminal_source.terminal_intent_sha256,
    retired_at: input.database.retired_at,
  });
  if (!receiptResult.success) {
    failRunCore(
      'RUN_DISPATCH_INVALID',
      '$.retirement_receipt',
      'derived dispatch retirement receipt is invalid',
      { cause: receiptResult.error },
    );
  }
  return deepFreeze({
    kind: 'RETIRE' as const,
    next_state: deepFreeze({
      ...clearDispatchLease(state),
      // Terminal retirement consumes the ticket disposition, but the durable
      // outbox row keeps the ticket FK as provenance just like PostgreSQL.
      ...(state.recovery_ticket_id === undefined
        ? {}
        : { recovery_ticket_id: state.recovery_ticket_id }),
      status: 'DEAD' as const,
      delivery_generation: newGeneration,
      last_error_code: 'RUN_TERMINATED_BEFORE_DISPATCH',
      retirement_receipt_id: input.database.receipt_id,
      retirement_receipt: receiptResult.data,
      updated_at: input.database.retired_at,
    }) as Readonly<RunDispatchStateV1>,
    receipt: deepFreeze(receiptResult.data),
    recovery_ticket_disposition: recoveryDisposition,
  });
}
