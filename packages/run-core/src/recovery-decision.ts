import {
  type RunAttemptLeaseStateV1,
  RunAttemptLeaseStateV1Schema,
  type RunRecoveryEffectDecisionV1,
  RunRecoveryEffectDecisionV1Schema,
  type RunRecoveryHoldIntentV1,
  RunRecoveryHoldIntentV1Schema,
  type RunRecoveryTicketV1,
  RunRecoveryTicketV1Schema,
  type RunRetryEffectEnvelopeV1,
  RunRetryEffectEnvelopeV1Schema,
  type RunSideEffectReceiptV1,
  RunSideEffectReceiptV1Schema,
  Sha256HexV1Schema,
  type RunTerminationIntentV1,
  RunTerminationIntentV1Schema,
} from '@better-agent/domain-contracts';
import { canonicalSha256 } from '@better-agent/release-core';

import { advanceRunLeaseFencingToken, readRunLeaseFencingToken } from './attempt-lease.js';
import { failRunCore } from './errors.js';
import { readPostgresInstantMicroseconds } from './postgres-instant.js';

export type RunEffectRecoveryDecisionV1 =
  | 'REPLAY_SAFE'
  | 'REPLAY_WITH_KEY'
  | 'RESUME_FROM_RECEIPT'
  | 'OPERATOR_HOLD';

export type RunRecoveryHoldReasonV1 =
  | 'MISSING_ENVELOPE'
  | 'UNSAFE_EFFECT'
  | 'SIDE_EFFECT_UNKNOWN'
  | 'EFFECT_CLOSURE_OPEN'
  | 'EFFECT_CLOSURE_UNKNOWN';

export interface RunRecoveryIdentityV1 {
  readonly workspace_id: string;
  readonly run_id: string;
  readonly attempt_id: string;
  readonly step_id: string;
  readonly accepted_plan_hash: string;
  readonly lease_fencing_token: string;
  readonly lease_owner: string;
  readonly lease_token: string;
  readonly lease_expires_at: string;
}

export interface DecideRunEffectRecoveryInputV1 {
  readonly expected: RunRecoveryIdentityV1;
  readonly envelope?: unknown;
  readonly envelope_sha256?: string;
  readonly receipt?: unknown;
  readonly receipt_sha256?: string;
}

export interface RunEffectRecoveryDecisionIntentV1 {
  readonly decision: RunEffectRecoveryDecisionV1;
  readonly hold_reason?: RunRecoveryHoldReasonV1;
  readonly envelope?: Readonly<RunRetryEffectEnvelopeV1>;
  readonly envelope_sha256?: string;
  readonly receipt?: Readonly<RunSideEffectReceiptV1>;
  readonly receipt_sha256?: string;
  readonly effect_closure_disposition?: 'OPEN' | 'UNKNOWN';
  readonly effect_closure_sha256?: string;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    failRunCore('RUN_RECOVERY_INVALID', path, 'expected a non-empty string');
  }
  return value;
}

function assertExpectedIdentity(expected: RunRecoveryIdentityV1): void {
  requireString(expected.workspace_id, '$.expected.workspace_id');
  requireString(expected.run_id, '$.expected.run_id');
  requireString(expected.attempt_id, '$.expected.attempt_id');
  requireString(expected.step_id, '$.expected.step_id');
  requireString(expected.accepted_plan_hash, '$.expected.accepted_plan_hash');
  requireString(expected.lease_owner, '$.expected.lease_owner');
  requireString(expected.lease_token, '$.expected.lease_token');
  requireString(expected.lease_expires_at, '$.expected.lease_expires_at');
  readRunLeaseFencingToken(expected.lease_fencing_token, '$.expected.lease_fencing_token');
}

function assertPresentIdentityFieldsDoNotMix(
  value: unknown,
  expected: RunRecoveryIdentityV1,
  path: '$.envelope' | '$.receipt',
): void {
  const record = asRecord(value);
  if (record === undefined) return;
  const fields = ['workspace_id', 'run_id', 'attempt_id', 'step_id'] as const;
  for (const field of fields) {
    if (record[field] !== undefined && record[field] !== expected[field]) {
      failRunCore(
        'RUN_RECOVERY_IDENTITY_MISMATCH',
        `${path}.${field}`,
        'recovery fact belongs to a different execution identity',
      );
    }
  }
  if (
    path === '$.envelope' &&
    record.accepted_plan_hash !== undefined &&
    record.accepted_plan_hash !== expected.accepted_plan_hash
  ) {
    failRunCore(
      'RUN_RECOVERY_IDENTITY_MISMATCH',
      '$.envelope.accepted_plan_hash',
      'effect envelope belongs to a different accepted Plan',
    );
  }
  if (path === '$.receipt') {
    const producerFields = {
      lease_fencing_token: expected.lease_fencing_token,
      lease_owner: expected.lease_owner,
      producer_session_user: expected.lease_owner,
      lease_token: expected.lease_token,
      lease_expires_at: expected.lease_expires_at,
    } as const;
    for (const [field, expectedValue] of Object.entries(producerFields)) {
      if (record[field] !== undefined && record[field] !== expectedValue) {
        failRunCore(
          'RUN_RECOVERY_IDENTITY_MISMATCH',
          `$.receipt.${field}`,
          'effect receipt belongs to a different producer lease tuple',
        );
      }
    }
  }
}

function operatorHold(
  reason: RunRecoveryHoldReasonV1,
  evidence: Partial<RunEffectRecoveryDecisionIntentV1> = {},
): Readonly<RunEffectRecoveryDecisionIntentV1> {
  return deepFreeze({ decision: 'OPERATOR_HOLD' as const, hold_reason: reason, ...evidence });
}

export function decideRunEffectRecovery(
  input: DecideRunEffectRecoveryInputV1,
): Readonly<RunEffectRecoveryDecisionIntentV1> {
  assertExpectedIdentity(input.expected);
  assertPresentIdentityFieldsDoNotMix(input.envelope, input.expected, '$.envelope');
  assertPresentIdentityFieldsDoNotMix(input.receipt, input.expected, '$.receipt');

  const envelopeResult = RunRetryEffectEnvelopeV1Schema.safeParse(input.envelope);
  if (!envelopeResult.success || input.envelope_sha256 === undefined) {
    return operatorHold('MISSING_ENVELOPE');
  }
  const envelope = envelopeResult.data;
  const envelopeHash = requireString(input.envelope_sha256, '$.envelope_sha256');
  if (
    envelope.workspace_id !== input.expected.workspace_id ||
    envelope.run_id !== input.expected.run_id ||
    envelope.attempt_id !== input.expected.attempt_id ||
    envelope.step_id !== input.expected.step_id ||
    envelope.accepted_plan_hash !== input.expected.accepted_plan_hash
  ) {
    failRunCore(
      'RUN_RECOVERY_IDENTITY_MISMATCH',
      '$.envelope',
      'effect envelope does not bind the expected Attempt, Step, and Plan',
    );
  }

  if (envelope.effect_class === 'UNSAFE') {
    return operatorHold('UNSAFE_EFFECT', { envelope, envelope_sha256: envelopeHash });
  }
  if (input.receipt === undefined) {
    return deepFreeze({
      decision:
        envelope.effect_class === 'SAFE' ? ('REPLAY_SAFE' as const) : ('REPLAY_WITH_KEY' as const),
      envelope,
      envelope_sha256: envelopeHash,
    });
  }

  const receiptResult = RunSideEffectReceiptV1Schema.safeParse(input.receipt);
  if (!receiptResult.success || input.receipt_sha256 === undefined) {
    return operatorHold('SIDE_EFFECT_UNKNOWN', { envelope, envelope_sha256: envelopeHash });
  }
  const receipt = receiptResult.data;
  const receiptHash = requireString(input.receipt_sha256, '$.receipt_sha256');
  if (
    receipt.workspace_id !== input.expected.workspace_id ||
    receipt.run_id !== input.expected.run_id ||
    receipt.attempt_id !== input.expected.attempt_id ||
    receipt.step_id !== input.expected.step_id ||
    receipt.lease_fencing_token !== input.expected.lease_fencing_token ||
    receipt.lease_owner !== input.expected.lease_owner ||
    receipt.producer_session_user !== input.expected.lease_owner ||
    receipt.lease_token !== input.expected.lease_token ||
    receipt.lease_expires_at !== input.expected.lease_expires_at ||
    receipt.retry_effect_envelope_id !== envelope.envelope_id ||
    receipt.retry_effect_envelope_sha256 !== envelopeHash ||
    receipt.effect_class !== envelope.effect_class ||
    receipt.operation_key !== envelope.operation_key
  ) {
    failRunCore(
      'RUN_RECOVERY_IDENTITY_MISMATCH',
      '$.receipt',
      'effect receipt does not bind the exact envelope and historical producer tuple',
    );
  }
  if (receipt.outcome === 'UNKNOWN') {
    return operatorHold('SIDE_EFFECT_UNKNOWN', {
      envelope,
      envelope_sha256: envelopeHash,
      receipt,
      receipt_sha256: receiptHash,
    });
  }
  return deepFreeze({
    decision: 'RESUME_FROM_RECEIPT' as const,
    envelope,
    envelope_sha256: envelopeHash,
    receipt,
    receipt_sha256: receiptHash,
  });
}

interface ExpiredAttemptCheckpointV1 {
  readonly checkpoint_id: string;
  readonly checkpoint_sha256: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly attempt_id: string;
}

interface ExpiredAttemptRecoveryDatabaseV1 {
  readonly now: string;
  readonly recovery_ticket_id: string;
  readonly hold_intent_id: string;
  readonly hold_evidence_sha256: string;
  readonly created_at: string;
}

export interface DecideExpiredRunAttemptRecoveryInputV1 {
  readonly current: unknown;
  readonly accepted_plan_hash: string;
  readonly checkpoint?: ExpiredAttemptCheckpointV1;
  readonly effects: readonly DecideRunEffectRecoveryInputV1[];
  readonly effect_closure: unknown;
  readonly termination_intent?: unknown;
  readonly database: ExpiredAttemptRecoveryDatabaseV1;
}

function readOptionalExpiredAttemptCheckpoint(
  value: unknown,
): ExpiredAttemptCheckpointV1 | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    failRunCore('RUN_RECOVERY_INVALID', '$.checkpoint', 'checkpoint must be an identity/hash pair');
  }
  const record = value as Record<string, unknown>;
  return {
    checkpoint_id: requireString(record.checkpoint_id, '$.checkpoint.checkpoint_id'),
    checkpoint_sha256: requireString(record.checkpoint_sha256, '$.checkpoint.checkpoint_sha256'),
    workspace_id: requireString(record.workspace_id, '$.checkpoint.workspace_id'),
    run_id: requireString(record.run_id, '$.checkpoint.run_id'),
    attempt_id: requireString(record.attempt_id, '$.checkpoint.attempt_id'),
  };
}

function assertExpiredAttemptCheckpointBinding(
  checkpoint: ExpiredAttemptCheckpointV1 | undefined,
  current: RunAttemptLeaseStateV1,
): void {
  if (
    checkpoint !== undefined &&
    (checkpoint.workspace_id !== current.workspace_id ||
      checkpoint.run_id !== current.run_id ||
      checkpoint.attempt_id !== current.attempt_id)
  ) {
    failRunCore(
      'RUN_RECOVERY_IDENTITY_MISMATCH',
      '$.checkpoint',
      'checkpoint does not belong to the expired Attempt',
    );
  }
}

function parseExpiredAttempt(value: unknown): RunAttemptLeaseStateV1 {
  const parsed = RunAttemptLeaseStateV1Schema.safeParse(value);
  if (!parsed.success) {
    failRunCore('RUN_RECOVERY_INVALID', '$.current', 'expired Attempt contract is invalid', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function assertExpiredAttempt(current: RunAttemptLeaseStateV1, nowValue: string): void {
  if (current.status !== 'RUNNING' || current.lease_expires_at === undefined) {
    failRunCore(
      'RUN_LEASE_TRANSITION_INVALID',
      '$.current',
      'recovery fencing requires a complete RUNNING lease',
    );
  }
  const now = readPostgresInstantMicroseconds(nowValue, '$.database.now', 'RUN_RECOVERY_INVALID');
  const expiry = readPostgresInstantMicroseconds(
    current.lease_expires_at,
    '$.current.lease_expires_at',
    'RUN_RECOVERY_INVALID',
  );
  if (now < expiry) {
    failRunCore(
      'RUN_LEASE_TRANSITION_INVALID',
      '$.current.lease_expires_at',
      'recovery fencing cannot run before the locked database expiry',
    );
  }
}

function sealAttemptState(value: unknown): Readonly<RunAttemptLeaseStateV1> {
  const parsed = RunAttemptLeaseStateV1Schema.safeParse(value);
  if (!parsed.success) {
    failRunCore('RUN_RECOVERY_INVALID', '$.next_state', 'derived recovery state is invalid', {
      cause: parsed.error,
    });
  }
  return deepFreeze(parsed.data);
}

function sealTicket(value: unknown): Readonly<RunRecoveryTicketV1> {
  const parsed = RunRecoveryTicketV1Schema.safeParse(value);
  if (!parsed.success) {
    failRunCore('RUN_RECOVERY_INVALID', '$.recovery_ticket', 'derived ticket is invalid', {
      cause: parsed.error,
    });
  }
  return deepFreeze(parsed.data);
}

export function prepareRunRecoveryEffectDecisionSet(
  decisions: readonly RunRecoveryEffectDecisionV1[],
) {
  if (decisions.length === 0) {
    failRunCore(
      'RUN_RECOVERY_INVALID',
      '$.effects',
      'recovery ticket requires at least one effect',
    );
  }
  const parsed = decisions.map((decision, index) => {
    const result = RunRecoveryEffectDecisionV1Schema.safeParse(decision);
    if (!result.success) {
      failRunCore(
        'RUN_RECOVERY_INVALID',
        `$.effects[${index}]`,
        'recovery effect decision contract is invalid',
        { cause: result.error },
      );
    }
    return result.data;
  });
  const effectDecisions = parsed
    .map((decision) => structuredClone(decision))
    .sort((left, right) =>
      left.retry_effect_envelope_id < right.retry_effect_envelope_id
        ? -1
        : left.retry_effect_envelope_id > right.retry_effect_envelope_id
          ? 1
          : 0,
    );
  const envelopeIds = effectDecisions.map((decision) => decision.retry_effect_envelope_id);
  if (new Set(envelopeIds).size !== envelopeIds.length) {
    failRunCore(
      'RUN_RECOVERY_INVALID',
      '$.effects',
      'recovery effect decisions must bind unique envelopes',
    );
  }
  const frozenDecisions = deepFreeze(effectDecisions);
  return deepFreeze({
    effect_decisions: frozenDecisions,
    effect_decisions_sha256: canonicalSha256({
      schema_version: 'run-recovery-effect-decision-set/1',
      effect_decisions: frozenDecisions,
    }),
  });
}

function sealHold(value: unknown): Readonly<RunRecoveryHoldIntentV1> {
  const parsed = RunRecoveryHoldIntentV1Schema.safeParse(value);
  if (!parsed.success) {
    failRunCore('RUN_RECOVERY_INVALID', '$.hold_intent', 'derived HOLD intent is invalid', {
      cause: parsed.error,
    });
  }
  return deepFreeze(parsed.data);
}

function assertEffectExpectedMatchesAttempt(
  expected: RunRecoveryIdentityV1,
  current: RunAttemptLeaseStateV1,
  acceptedPlanHash: string,
): void {
  if (
    expected.workspace_id !== current.workspace_id ||
    expected.run_id !== current.run_id ||
    expected.attempt_id !== current.attempt_id ||
    expected.accepted_plan_hash !== acceptedPlanHash ||
    expected.lease_fencing_token !== current.lease_fencing_token ||
    expected.lease_owner !== current.lease_owner ||
    expected.lease_token !== current.lease_token ||
    expected.lease_expires_at !== current.lease_expires_at
  ) {
    failRunCore(
      'RUN_RECOVERY_IDENTITY_MISMATCH',
      '$.effects.expected',
      'effect identity differs from the expired Attempt generation or accepted Plan',
    );
  }
}

function holdEvidence(decision: RunEffectRecoveryDecisionIntentV1) {
  if (decision.hold_reason === 'MISSING_ENVELOPE') return {};
  if (
    decision.hold_reason === 'EFFECT_CLOSURE_OPEN' ||
    decision.hold_reason === 'EFFECT_CLOSURE_UNKNOWN'
  ) {
    if (
      decision.effect_closure_disposition === undefined ||
      decision.effect_closure_sha256 === undefined
    ) {
      failRunCore(
        'RUN_RECOVERY_INVALID',
        '$.effect_closure',
        'aggregate HOLD evidence is incomplete',
      );
    }
    return {
      effect_closure_disposition: decision.effect_closure_disposition,
      effect_closure_sha256: decision.effect_closure_sha256,
    };
  }
  if (decision.envelope === undefined || decision.envelope_sha256 === undefined) {
    failRunCore('RUN_RECOVERY_INVALID', '$.effects', 'HOLD evidence is incomplete');
  }
  const envelopeEvidence = {
    retry_effect_envelope_id: decision.envelope.envelope_id,
    retry_effect_envelope_sha256: decision.envelope_sha256,
  };
  if (decision.hold_reason === 'UNSAFE_EFFECT') return envelopeEvidence;
  if (decision.receipt === undefined || decision.receipt_sha256 === undefined) {
    failRunCore('RUN_RECOVERY_INVALID', '$.effects', 'UNKNOWN HOLD requires its receipt');
  }
  return {
    ...envelopeEvidence,
    effect_receipt_id: decision.receipt.effect_receipt_id,
    effect_receipt_sha256: decision.receipt_sha256,
  };
}

function parseTerminationIntent(value: unknown): RunTerminationIntentV1 {
  const parsed = RunTerminationIntentV1Schema.safeParse(value);
  if (!parsed.success) {
    failRunCore(
      'RUN_RECOVERY_INVALID',
      '$.termination_intent',
      'termination intent contract is invalid',
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function parseEffectClosure(value: unknown): {
  readonly disposition: 'CLOSED' | 'OPEN' | 'UNKNOWN';
  readonly effect_closure_sha256: string;
} {
  const record = asRecord(value);
  if (
    record === undefined ||
    Object.keys(record).some((key) => key !== 'disposition' && key !== 'effect_closure_sha256') ||
    (record.disposition !== 'CLOSED' &&
      record.disposition !== 'OPEN' &&
      record.disposition !== 'UNKNOWN')
  ) {
    failRunCore(
      'RUN_RECOVERY_INVALID',
      '$.effect_closure',
      'effect closure must be an exact CLOSED, OPEN, or UNKNOWN aggregate',
    );
  }
  const closureHash = Sha256HexV1Schema.safeParse(record.effect_closure_sha256);
  if (!closureHash.success) {
    failRunCore(
      'RUN_RECOVERY_INVALID',
      '$.effect_closure.effect_closure_sha256',
      'effect closure requires a canonical SHA-256 digest',
      { cause: closureHash.error },
    );
  }
  return {
    disposition: record.disposition,
    effect_closure_sha256: closureHash.data,
  };
}

function assertTerminationIntentBinding(
  termination: RunTerminationIntentV1,
  current: RunAttemptLeaseStateV1,
  effects: readonly DecideRunEffectRecoveryInputV1[],
): void {
  const exactProducerTuple =
    termination.workspace_id === current.workspace_id &&
    termination.run_id === current.run_id &&
    termination.attempt_id === current.attempt_id &&
    termination.producer_session_user === current.lease_owner &&
    termination.lease_owner === current.lease_owner &&
    termination.lease_token === current.lease_token &&
    termination.lease_fencing_token === current.lease_fencing_token &&
    termination.lease_expires_at === current.lease_expires_at;
  const bindsLockedStep = effects.some((effect) => effect.expected.step_id === termination.step_id);
  if (!exactProducerTuple || !bindsLockedStep) {
    failRunCore(
      'RUN_RECOVERY_IDENTITY_MISMATCH',
      '$.termination_intent',
      'termination intent does not bind the expired Attempt producer tuple and locked Step',
    );
  }
}

function toRecoveryEffectDecision(
  decision: RunEffectRecoveryDecisionIntentV1,
): RunRecoveryEffectDecisionV1 {
  if (
    decision.decision === 'OPERATOR_HOLD' ||
    decision.envelope === undefined ||
    decision.envelope_sha256 === undefined
  ) {
    failRunCore(
      'RUN_RECOVERY_INVALID',
      '$.effects',
      'recovery ticket requires a complete non-HOLD effect decision',
    );
  }
  if (decision.decision === 'RESUME_FROM_RECEIPT') {
    if (decision.receipt === undefined || decision.receipt_sha256 === undefined) {
      failRunCore(
        'RUN_RECOVERY_INVALID',
        '$.effects',
        'confirmed recovery requires its exact receipt evidence',
      );
    }
    return {
      retry_effect_envelope_id: decision.envelope.envelope_id,
      retry_effect_envelope_sha256: decision.envelope_sha256,
      effect_class: decision.envelope.effect_class as 'SAFE' | 'REQUIRES_KEY',
      recovery_decision: 'RESUME_FROM_RECEIPT',
      ...(decision.envelope.operation_key === undefined
        ? {}
        : { operation_key: decision.envelope.operation_key }),
      effect_receipt_id: decision.receipt.effect_receipt_id,
      effect_receipt_sha256: decision.receipt_sha256,
    };
  }
  return {
    retry_effect_envelope_id: decision.envelope.envelope_id,
    retry_effect_envelope_sha256: decision.envelope_sha256,
    effect_class: decision.envelope.effect_class as 'SAFE' | 'REQUIRES_KEY',
    recovery_decision: decision.decision,
    ...(decision.envelope.operation_key === undefined
      ? {}
      : { operation_key: decision.envelope.operation_key }),
  };
}

export function decideExpiredRunAttemptRecovery(input: DecideExpiredRunAttemptRecoveryInputV1) {
  const current = parseExpiredAttempt(input.current);
  assertExpiredAttempt(current, input.database.now);
  requireString(input.accepted_plan_hash, '$.accepted_plan_hash');
  const checkpoint = readOptionalExpiredAttemptCheckpoint(input.checkpoint);
  assertExpiredAttemptCheckpointBinding(checkpoint, current);
  const effectClosure = parseEffectClosure(input.effect_closure);
  if (
    current.lease_fencing_token === undefined ||
    current.started_at === undefined ||
    current.lease_owner === undefined ||
    current.lease_token === undefined ||
    current.lease_expires_at === undefined
  ) {
    failRunCore('RUN_RECOVERY_INVALID', '$.current', 'expired Attempt lease tuple is incomplete');
  }
  const decisions = input.effects.map((effect) => {
    assertEffectExpectedMatchesAttempt(effect.expected, current, input.accepted_plan_hash);
    return decideRunEffectRecovery(effect);
  });
  const termination =
    input.termination_intent === undefined
      ? undefined
      : parseTerminationIntent(input.termination_intent);
  if (termination !== undefined)
    assertTerminationIntentBinding(termination, current, input.effects);
  const nextFence = advanceRunLeaseFencingToken(
    current.lease_fencing_token,
    '$.current.lease_fencing_token',
  );
  // PostgreSQL locks and classifies effect rows by envelope UUID. Mirror that
  // order so the pure decision records the same first actionable HOLD evidence.
  const holdDecision =
    decisions
      .filter((decision) => decision.decision === 'OPERATOR_HOLD')
      .sort((left, right) => {
        const leftId = left.envelope?.envelope_id;
        const rightId = right.envelope?.envelope_id;
        if (leftId === undefined) return rightId === undefined ? 0 : 1;
        if (rightId === undefined) return -1;
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
      })[0] ??
    (decisions.length === 0
      ? operatorHold('MISSING_ENVELOPE')
      : effectClosure.disposition === 'OPEN'
        ? operatorHold('EFFECT_CLOSURE_OPEN', {
            effect_closure_disposition: 'OPEN',
            effect_closure_sha256: effectClosure.effect_closure_sha256,
          })
        : effectClosure.disposition === 'UNKNOWN'
          ? operatorHold('EFFECT_CLOSURE_UNKNOWN', {
              effect_closure_disposition: 'UNKNOWN',
              effect_closure_sha256: effectClosure.effect_closure_sha256,
            })
          : undefined);
  if (holdDecision !== undefined) {
    const reason = holdDecision.hold_reason;
    if (reason === undefined) {
      failRunCore('RUN_RECOVERY_INVALID', '$.effects', 'operator HOLD requires a reason');
    }
    const nextState = sealAttemptState({
      schema_version: current.schema_version,
      workspace_id: current.workspace_id,
      run_id: current.run_id,
      attempt_id: current.attempt_id,
      attempt_number: current.attempt_number,
      status: 'RELINQUISHED',
      lease_fencing_token: nextFence,
      started_at: current.started_at,
      finished_at: input.database.now,
      updated_at: input.database.now,
    });
    const holdIntent = sealHold({
      schema_version: 'run-recovery-hold-intent/1',
      recovery_hold_intent_id: requireString(
        input.database.hold_intent_id,
        '$.database.hold_intent_id',
      ),
      workspace_id: current.workspace_id,
      run_id: current.run_id,
      resource_kind: 'ATTEMPT',
      resource_id: current.attempt_id,
      old_fencing_token: current.lease_fencing_token,
      new_fencing_token: nextFence,
      created_generation: nextFence,
      hold_reason: reason,
      ...holdEvidence(holdDecision),
      hold_evidence_sha256: requireString(
        input.database.hold_evidence_sha256,
        '$.database.hold_evidence_sha256',
      ),
      ...(checkpoint === undefined
        ? {}
        : {
            checkpoint_id: checkpoint.checkpoint_id,
            checkpoint_sha256: checkpoint.checkpoint_sha256,
          }),
      created_at: input.database.created_at,
    });
    return deepFreeze({
      kind: 'OPERATOR_HOLD' as const,
      next_state: nextState,
      hold_intent: holdIntent,
    });
  }

  if (
    termination !== undefined &&
    effectClosure.disposition === 'CLOSED' &&
    effectClosure.effect_closure_sha256 === termination.effect_closure_sha256
  ) {
    const nextState = sealAttemptState({
      schema_version: current.schema_version,
      workspace_id: current.workspace_id,
      run_id: current.run_id,
      attempt_id: current.attempt_id,
      attempt_number: current.attempt_number,
      status: 'RELINQUISHED',
      lease_fencing_token: nextFence,
      started_at: current.started_at,
      finished_at: input.database.now,
      updated_at: input.database.now,
    });
    return deepFreeze({
      kind: 'PRESERVE_TERMINATION' as const,
      next_state: nextState,
      preserved_termination_intent: structuredClone(termination),
    });
  }
  if (
    termination !== undefined &&
    effectClosure.disposition === 'CLOSED' &&
    effectClosure.effect_closure_sha256 !== termination.effect_closure_sha256
  ) {
    failRunCore(
      'RUN_RECOVERY_IDENTITY_MISMATCH',
      '$.effect_closure.effect_closure_sha256',
      'termination intent does not bind the recomputed effect closure',
    );
  }

  const effectDecisionSet = prepareRunRecoveryEffectDecisionSet(
    decisions.map(toRecoveryEffectDecision),
  );
  const ticketId = requireString(
    input.database.recovery_ticket_id,
    '$.database.recovery_ticket_id',
  );
  const ticket = sealTicket({
    schema_version: 'run-recovery-ticket/1',
    recovery_ticket_id: ticketId,
    workspace_id: current.workspace_id,
    run_id: current.run_id,
    resource_kind: 'ATTEMPT',
    resource_id: current.attempt_id,
    old_fencing_token: current.lease_fencing_token,
    new_fencing_token: nextFence,
    created_generation: nextFence,
    ...(checkpoint === undefined
      ? {}
      : {
          checkpoint_id: checkpoint.checkpoint_id,
          checkpoint_sha256: checkpoint.checkpoint_sha256,
        }),
    ...effectDecisionSet,
    created_at: input.database.created_at,
  });
  const nextState = sealAttemptState({
    schema_version: current.schema_version,
    workspace_id: current.workspace_id,
    run_id: current.run_id,
    attempt_id: current.attempt_id,
    attempt_number: current.attempt_number,
    status: 'PENDING',
    pending_kind: 'RECOVERY',
    lease_fencing_token: nextFence,
    recovery_ticket_id: ticketId,
    started_at: current.started_at,
    updated_at: input.database.now,
  });
  return deepFreeze({
    kind: 'RECOVERY_TICKET' as const,
    next_state: nextState,
    recovery_ticket: ticket,
  });
}
