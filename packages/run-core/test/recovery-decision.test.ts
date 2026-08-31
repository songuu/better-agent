import { describe, expect, it } from 'vitest';

import {
  type DecideRunEffectRecoveryInputV1,
  decideExpiredRunAttemptRecovery,
  decideRunEffectRecovery,
} from '../src/index.js';
import {
  attemptId,
  checkpointId,
  effectEnvelopeId,
  effectReceiptId,
  hashA,
  hashB,
  hashC,
  holdIntentId,
  leaseTokenA,
  recoveryTicketId,
  runId,
  stepId,
  workspaceId,
} from './fixtures.js';

const acceptedPlanHash = hashA;
const startedAt = '2026-08-28T00:00:00Z';
const now = '2026-08-28T00:00:30Z';
const leaseOwner = 'ba_execution_login_a';
const secondStepId = '018f47f2-c541-7cc6-9292-4a2c35303e19';
const secondEnvelopeId = '018f47f2-c541-7cc6-9292-4a2c35303e1b';
const terminationIntentId = '018f47f2-c541-7cc6-9292-4a2c35303e23';
const reservationId = '018f47f2-c541-7cc6-9292-4a2c35303e25';

function recoveryCheckpoint(overrides: Record<string, unknown> = {}) {
  return {
    checkpoint_id: checkpointId,
    checkpoint_sha256: hashA,
    workspace_id: workspaceId,
    run_id: runId,
    attempt_id: attemptId,
    ...overrides,
  };
}

const expectedIdentity = {
  workspace_id: workspaceId,
  run_id: runId,
  attempt_id: attemptId,
  step_id: stepId,
  accepted_plan_hash: acceptedPlanHash,
  lease_fencing_token: '2',
  lease_owner: leaseOwner,
  lease_token: leaseTokenA,
  lease_expires_at: now,
} as const;

const secondExpectedIdentity = {
  ...expectedIdentity,
  step_id: secondStepId,
} as const;

function envelope(overrides: Record<string, unknown> = {}) {
  const effectClass = overrides.effect_class ?? 'SAFE';
  return {
    schema_version: 'run-retry-effect-envelope/1',
    envelope_id: effectEnvelopeId,
    workspace_id: workspaceId,
    run_id: runId,
    attempt_id: attemptId,
    step_id: stepId,
    accepted_plan_hash: acceptedPlanHash,
    operation_intent_sha256: hashA,
    effect_payload_sha256: hashB,
    effect_class: effectClass,
    recovery_decision:
      effectClass === 'UNSAFE'
        ? 'HOLD'
        : effectClass === 'REQUIRES_KEY'
          ? 'REPLAY_WITH_KEY'
          : 'REPLAY_SAFE',
    created_at: startedAt,
    ...overrides,
  };
}

function receipt(overrides: Record<string, unknown> = {}) {
  const outcome = overrides.outcome ?? 'CONFIRMED';
  const effectClass = overrides.effect_class ?? 'SAFE';
  return {
    schema_version: 'run-side-effect-receipt/1',
    effect_receipt_id: effectReceiptId,
    workspace_id: workspaceId,
    run_id: runId,
    attempt_id: attemptId,
    step_id: stepId,
    retry_effect_envelope_id: effectEnvelopeId,
    retry_effect_envelope_sha256: hashC,
    effect_class: effectClass,
    outcome,
    ...(outcome === 'CONFIRMED'
      ? {
          external_receipt_ref: 'receipt://execution/effect-1',
          external_receipt_sha256: hashB,
        }
      : { unknown_reason_code: 'PROVIDER_RESPONSE_LOST' }),
    result_payload_sha256: hashA,
    producer_session_user: leaseOwner,
    lease_owner: leaseOwner,
    lease_token: leaseTokenA,
    lease_fencing_token: '2',
    lease_expires_at: now,
    authorized_at: startedAt,
    ...overrides,
  };
}

function expiredAttempt(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'run-attempt-lease-state/1',
    workspace_id: workspaceId,
    run_id: runId,
    attempt_id: attemptId,
    attempt_number: 1,
    status: 'RUNNING',
    lease_owner: leaseOwner,
    lease_token: leaseTokenA,
    lease_fencing_token: '2',
    lease_expires_at: now,
    started_at: startedAt,
    updated_at: startedAt,
    ...overrides,
  };
}

function terminationIntent(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'run-termination-intent/1',
    termination_intent_id: terminationIntentId,
    workspace_id: workspaceId,
    billing_owner_run_id: runId,
    run_id: runId,
    reservation_id: reservationId,
    attempt_id: attemptId,
    step_id: stepId,
    producer_session_user: leaseOwner,
    lease_owner: leaseOwner,
    lease_token: leaseTokenA,
    lease_fencing_token: '2',
    lease_expires_at: now,
    authorized_at: startedAt,
    producer_operation_key: 'worker:termination:request-1',
    terminal_status: 'FAILED',
    termination_reason: 'INTERNAL_FAILURE',
    effect_disposition: 'CLOSED',
    effect_closure_sha256: hashB,
    usage_attribution_ids: [],
    intended_settle_credits: '0',
    settlement_operation_key: 'settle:termination:1',
    intended_release_credits: '1',
    release_operation_key: 'release:termination:1',
    release_reason_code: 'INTERNAL_FAILURE',
    operation_intent_sha256: hashA,
    consumption_generation: '1',
    ...overrides,
  };
}

function recoveryDatabase() {
  return {
    now,
    recovery_ticket_id: recoveryTicketId,
    hold_intent_id: holdIntentId,
    hold_evidence_sha256: hashB,
    created_at: now,
  };
}

describe('per-effect recovery policy', () => {
  it.each([
    {
      name: 'missing envelope',
      envelope: undefined,
      receipt: undefined,
      decision: 'OPERATOR_HOLD',
    },
    {
      name: 'unsafe without receipt',
      envelope: envelope({ effect_class: 'UNSAFE' }),
      receipt: undefined,
      decision: 'OPERATOR_HOLD',
    },
    {
      name: 'unsafe confirmed',
      envelope: envelope({ effect_class: 'UNSAFE' }),
      receipt: receipt({ effect_class: 'UNSAFE' }),
      decision: 'OPERATOR_HOLD',
    },
    {
      name: 'safe missing receipt',
      envelope: envelope(),
      receipt: undefined,
      decision: 'REPLAY_SAFE',
    },
    {
      name: 'safe confirmed',
      envelope: envelope(),
      receipt: receipt(),
      decision: 'RESUME_FROM_RECEIPT',
    },
    {
      name: 'safe unknown',
      envelope: envelope(),
      receipt: receipt({ outcome: 'UNKNOWN' }),
      decision: 'OPERATOR_HOLD',
    },
    {
      name: 'keyed missing receipt',
      envelope: envelope({ effect_class: 'REQUIRES_KEY', operation_key: 'operation-1' }),
      receipt: undefined,
      decision: 'REPLAY_WITH_KEY',
    },
    {
      name: 'keyed confirmed',
      envelope: envelope({ effect_class: 'REQUIRES_KEY', operation_key: 'operation-1' }),
      receipt: receipt({ effect_class: 'REQUIRES_KEY', operation_key: 'operation-1' }),
      decision: 'RESUME_FROM_RECEIPT',
    },
    {
      name: 'keyed missing committed key',
      envelope: envelope({ effect_class: 'REQUIRES_KEY' }),
      receipt: undefined,
      decision: 'OPERATOR_HOLD',
    },
  ])(
    'maps $name to $decision',
    ({ envelope: effectEnvelope, receipt: effectReceipt, decision }) => {
      expect(
        decideRunEffectRecovery({
          expected: expectedIdentity,
          envelope: effectEnvelope,
          envelope_sha256: hashC,
          receipt: effectReceipt,
          ...(effectReceipt === undefined ? {} : { receipt_sha256: hashB }),
        }).decision,
      ).toBe(decision);
    },
  );

  it('hard-rejects identity, Plan, fence, envelope-hash, and operation-key mixing', () => {
    for (const mixed of [
      { envelope: envelope({ run_id: '018f47f2-c541-7cc6-9292-4a2c35303eff' }) },
      { envelope: envelope({ accepted_plan_hash: hashB }) },
      { envelope: envelope(), receipt: receipt({ lease_fencing_token: '3' }) },
      { envelope: envelope(), receipt: receipt({ retry_effect_envelope_sha256: hashA }) },
      {
        envelope: envelope({ effect_class: 'REQUIRES_KEY', operation_key: 'operation-1' }),
        receipt: receipt({ effect_class: 'REQUIRES_KEY', operation_key: 'operation-2' }),
      },
    ]) {
      expect(() =>
        decideRunEffectRecovery({
          expected: expectedIdentity,
          envelope: mixed.envelope,
          envelope_sha256: hashC,
          receipt: mixed.receipt,
          ...(mixed.receipt === undefined ? {} : { receipt_sha256: hashB }),
        }),
      ).toThrowError(/RUN_RECOVERY_IDENTITY_MISMATCH/);
    }
  });
});

describe('expired Attempt recovery fencing', () => {
  it('applies HOLD-first and does not preserve a termination intent over unknown responsibility', () => {
    const decision = decideExpiredRunAttemptRecovery({
      current: expiredAttempt(),
      accepted_plan_hash: acceptedPlanHash,
      checkpoint: recoveryCheckpoint(),
      effects: [
        {
          expected: expectedIdentity,
          envelope: envelope(),
          envelope_sha256: hashC,
          receipt: receipt({ outcome: 'UNKNOWN' }),
          receipt_sha256: hashB,
        },
      ],
      termination_intent: {
        ...terminationIntent(),
        effect_closure_sha256: hashA,
      },
      effect_closure: { disposition: 'CLOSED', effect_closure_sha256: hashA },
      database: recoveryDatabase(),
    });

    expect(decision.kind).toBe('OPERATOR_HOLD');
    expect(decision.next_state).toMatchObject({
      status: 'RELINQUISHED',
      lease_fencing_token: '3',
    });
    expect(decision.next_state).not.toHaveProperty('lease_owner');
    expect(decision).toHaveProperty('hold_intent.hold_reason', 'SIDE_EFFECT_UNKNOWN');
    expect(decision).not.toHaveProperty('recovery_ticket');
    expect(decision).not.toHaveProperty('preserved_termination_intent');
  });

  it('creates a HOLD without inventing checkpoint evidence before the first checkpoint', () => {
    const decision = decideExpiredRunAttemptRecovery({
      current: expiredAttempt(),
      accepted_plan_hash: acceptedPlanHash,
      effects: [],
      effect_closure: { disposition: 'UNKNOWN', effect_closure_sha256: hashB },
      database: recoveryDatabase(),
    });

    expect(decision.kind).toBe('OPERATOR_HOLD');
    expect(decision).not.toHaveProperty('hold_intent.checkpoint_id');
    expect(decision).not.toHaveProperty('hold_intent.checkpoint_sha256');
  });

  it('rejects checkpoint evidence from a different Attempt', () => {
    expect(() =>
      decideExpiredRunAttemptRecovery({
        current: expiredAttempt(),
        accepted_plan_hash: acceptedPlanHash,
        checkpoint: recoveryCheckpoint({
          attempt_id: '018f47f2-c541-7cc6-9292-4a2c35303eff',
        }),
        effects: [],
        effect_closure: { disposition: 'UNKNOWN', effect_closure_sha256: hashB },
        database: recoveryDatabase(),
      }),
    ).toThrowError(/RUN_RECOVERY_IDENTITY_MISMATCH/);
  });

  it('selects HOLD evidence by lexical envelope UUID regardless of input order', () => {
    const lowerEnvelopeId = '018f47f2-c541-7cc6-9292-4a2c35303e10';
    const decide = (effects: readonly DecideRunEffectRecoveryInputV1[]) =>
      decideExpiredRunAttemptRecovery({
        current: expiredAttempt(),
        accepted_plan_hash: acceptedPlanHash,
        checkpoint: recoveryCheckpoint(),
        effects,
        effect_closure: { disposition: 'UNKNOWN', effect_closure_sha256: hashB },
        database: recoveryDatabase(),
      });
    const lower = {
      expected: expectedIdentity,
      envelope: envelope({ envelope_id: lowerEnvelopeId, effect_class: 'UNSAFE' }),
      envelope_sha256: hashA,
    };
    const higher = {
      expected: secondExpectedIdentity,
      envelope: envelope({
        envelope_id: secondEnvelopeId,
        step_id: secondStepId,
        effect_class: 'UNSAFE',
      }),
      envelope_sha256: hashC,
    };

    const forward = decide([higher, lower]);
    const reversed = decide([lower, higher]);
    expect(forward.kind).toBe('OPERATOR_HOLD');
    expect(reversed.kind).toBe('OPERATOR_HOLD');
    if (forward.kind !== 'OPERATOR_HOLD' || reversed.kind !== 'OPERATOR_HOLD') {
      throw new Error('expected operator HOLD decisions');
    }
    expect(forward.hold_intent).toEqual(reversed.hold_intent);
    expect(forward.hold_intent.retry_effect_envelope_id).toBe(lowerEnvelopeId);
    expect(forward.hold_intent.retry_effect_envelope_sha256).toBe(hashA);
  });

  it('preserves an exact CLOSED termination intent after fencing without creating a ticket', () => {
    const decision = decideExpiredRunAttemptRecovery({
      current: expiredAttempt(),
      accepted_plan_hash: acceptedPlanHash,
      checkpoint: recoveryCheckpoint(),
      effects: [
        {
          expected: expectedIdentity,
          envelope: envelope(),
          envelope_sha256: hashC,
          receipt: receipt(),
          receipt_sha256: hashB,
        },
      ],
      effect_closure: { disposition: 'CLOSED', effect_closure_sha256: hashB },
      termination_intent: terminationIntent(),
      database: recoveryDatabase(),
    });

    expect(decision.kind).toBe('PRESERVE_TERMINATION');
    expect(decision.next_state).toMatchObject({
      status: 'RELINQUISHED',
      lease_fencing_token: '3',
    });
    expect(decision).toHaveProperty(
      'preserved_termination_intent.termination_intent_id',
      terminationIntentId,
    );
    expect(decision).not.toHaveProperty('recovery_ticket');
  });

  it('creates a lease-free N+1 ticket for replayable recovery', () => {
    const decision = decideExpiredRunAttemptRecovery({
      current: expiredAttempt(),
      accepted_plan_hash: acceptedPlanHash,
      checkpoint: recoveryCheckpoint(),
      effects: [
        {
          expected: expectedIdentity,
          envelope: envelope(),
          envelope_sha256: hashC,
          receipt: undefined,
        },
      ],
      effect_closure: { disposition: 'CLOSED', effect_closure_sha256: hashB },
      database: recoveryDatabase(),
    });

    expect(decision.kind).toBe('RECOVERY_TICKET');
    expect(decision.next_state).toMatchObject({
      status: 'PENDING',
      lease_fencing_token: '3',
      recovery_ticket_id: recoveryTicketId,
    });
    expect(decision.next_state).not.toHaveProperty('lease_owner');
    expect(decision).toHaveProperty('recovery_ticket.old_fencing_token', '2');
    expect(decision).toHaveProperty('recovery_ticket.new_fencing_token', '3');
    expect(decision).not.toHaveProperty('hold_intent');
  });

  it('creates a replay ticket without inventing checkpoint evidence before the first checkpoint', () => {
    const decision = decideExpiredRunAttemptRecovery({
      current: expiredAttempt(),
      accepted_plan_hash: acceptedPlanHash,
      effects: [
        {
          expected: expectedIdentity,
          envelope: envelope(),
          envelope_sha256: hashC,
        },
      ],
      effect_closure: { disposition: 'CLOSED', effect_closure_sha256: hashB },
      database: recoveryDatabase(),
    });

    expect(decision.kind).toBe('RECOVERY_TICKET');
    expect(decision).not.toHaveProperty('recovery_ticket.checkpoint_id');
    expect(decision).not.toHaveProperty('recovery_ticket.checkpoint_sha256');
  });

  it.each(['OPEN', 'UNKNOWN'] as const)(
    'turns aggregate %s effect closure into HOLD even when each effect is replayable',
    (disposition) => {
      const decision = decideExpiredRunAttemptRecovery({
        current: expiredAttempt(),
        accepted_plan_hash: acceptedPlanHash,
        checkpoint: recoveryCheckpoint(),
        effects: [
          {
            expected: expectedIdentity,
            envelope: envelope(),
            envelope_sha256: hashC,
          },
        ],
        effect_closure: { disposition, effect_closure_sha256: hashB },
        database: recoveryDatabase(),
      });

      expect(decision.kind).toBe('OPERATOR_HOLD');
      if (decision.kind !== 'OPERATOR_HOLD') throw new Error('expected aggregate HOLD');
      expect(decision.hold_intent).toMatchObject({
        hold_reason: `EFFECT_CLOSURE_${disposition}`,
        effect_closure_disposition: disposition,
        effect_closure_sha256: hashB,
      });
      expect(decision).not.toHaveProperty('recovery_ticket');
    },
  );

  it('rejects a missing or caller-extended aggregate closure instead of replaying', () => {
    const base = {
      current: expiredAttempt(),
      accepted_plan_hash: acceptedPlanHash,
      checkpoint: recoveryCheckpoint(),
      effects: [
        {
          expected: expectedIdentity,
          envelope: envelope(),
          envelope_sha256: hashC,
        },
      ],
      database: recoveryDatabase(),
    };
    expect(() =>
      decideExpiredRunAttemptRecovery({ ...base, effect_closure: undefined }),
    ).toThrowError(/RUN_RECOVERY_INVALID/);
    expect(() =>
      decideExpiredRunAttemptRecovery({
        ...base,
        effect_closure: {
          disposition: 'CLOSED',
          effect_closure_sha256: hashB,
          caller_hint: 'trust me',
        },
      }),
    ).toThrowError(/RUN_RECOVERY_INVALID/);
  });

  it('seals every sorted effect decision into one stable aggregate without downgrading receipts', () => {
    const replayable = {
      expected: expectedIdentity,
      envelope: envelope(),
      envelope_sha256: hashC,
    } as const;
    const confirmed = {
      expected: secondExpectedIdentity,
      envelope: envelope({ envelope_id: secondEnvelopeId, step_id: secondStepId }),
      envelope_sha256: hashA,
      receipt: receipt({
        step_id: secondStepId,
        retry_effect_envelope_id: secondEnvelopeId,
        retry_effect_envelope_sha256: hashA,
      }),
      receipt_sha256: hashB,
    } as const;
    const decide = (effects: readonly (typeof replayable | typeof confirmed)[]) =>
      decideExpiredRunAttemptRecovery({
        current: expiredAttempt(),
        accepted_plan_hash: acceptedPlanHash,
        checkpoint: recoveryCheckpoint(),
        effects,
        effect_closure: { disposition: 'CLOSED', effect_closure_sha256: hashB },
        database: recoveryDatabase(),
      });

    const forward = decide([replayable, confirmed]);
    const reversed = decide([confirmed, replayable]);
    expect(forward.kind).toBe('RECOVERY_TICKET');
    expect(reversed.kind).toBe('RECOVERY_TICKET');
    if (forward.kind !== 'RECOVERY_TICKET' || reversed.kind !== 'RECOVERY_TICKET') {
      throw new Error('expected recovery tickets');
    }
    expect(forward.recovery_ticket.effect_decisions).toEqual(
      reversed.recovery_ticket.effect_decisions,
    );
    expect(forward.recovery_ticket.effect_decisions_sha256).toBe(
      reversed.recovery_ticket.effect_decisions_sha256,
    );
    expect(forward.recovery_ticket.effect_decisions).toEqual([
      expect.objectContaining({
        retry_effect_envelope_id: secondEnvelopeId,
        recovery_decision: 'RESUME_FROM_RECEIPT',
        effect_receipt_id: effectReceiptId,
      }),
      expect.objectContaining({
        retry_effect_envelope_id: effectEnvelopeId,
        recovery_decision: 'REPLAY_SAFE',
      }),
    ]);
  });

  it('requires a strict termination intent bound to the expired producer tuple and Step', () => {
    const base = {
      current: expiredAttempt(),
      accepted_plan_hash: acceptedPlanHash,
      checkpoint: recoveryCheckpoint(),
      effects: [
        {
          expected: expectedIdentity,
          envelope: envelope(),
          envelope_sha256: hashC,
          receipt: receipt(),
          receipt_sha256: hashB,
        },
      ],
      effect_closure: { disposition: 'CLOSED' as const, effect_closure_sha256: hashB },
      database: recoveryDatabase(),
    };

    expect(() =>
      decideExpiredRunAttemptRecovery({
        ...base,
        termination_intent: {
          termination_intent_id: terminationIntentId,
          workspace_id: workspaceId,
          run_id: runId,
          attempt_id: attemptId,
          effect_disposition: 'CLOSED',
          effect_closure_sha256: hashB,
        },
      }),
    ).toThrowError(/RUN_RECOVERY_INVALID/);

    for (const mixed of [
      { step_id: secondStepId },
      { lease_token: '018f47f2-c541-7cc6-9292-4a2c35303eff' },
      { lease_fencing_token: '3' },
      { lease_expires_at: '2026-08-28T00:00:31Z' },
      {
        producer_session_user: 'ba_execution_login_b',
        lease_owner: 'ba_execution_login_b',
      },
    ]) {
      expect(() =>
        decideExpiredRunAttemptRecovery({
          ...base,
          termination_intent: terminationIntent(mixed),
        }),
      ).toThrowError(/RUN_RECOVERY_IDENTITY_MISMATCH/);
    }
  });

  it('rejects recovery before expiry, stale identity, and N+1 overflow', () => {
    expect(() =>
      decideExpiredRunAttemptRecovery({
        current: expiredAttempt({ lease_expires_at: '2026-08-28T00:00:31Z' }),
        accepted_plan_hash: acceptedPlanHash,
        checkpoint: recoveryCheckpoint(),
        effects: [
          {
            expected: expectedIdentity,
            envelope: envelope(),
            envelope_sha256: hashC,
            receipt: undefined,
          },
        ],
        effect_closure: { disposition: 'CLOSED', effect_closure_sha256: hashB },
        database: recoveryDatabase(),
      }),
    ).toThrowError(/RUN_LEASE_TRANSITION_INVALID/);
    expect(() =>
      decideExpiredRunAttemptRecovery({
        current: expiredAttempt({ run_id: '018f47f2-c541-7cc6-9292-4a2c35303eff' }),
        accepted_plan_hash: acceptedPlanHash,
        checkpoint: recoveryCheckpoint(),
        effects: [
          {
            expected: expectedIdentity,
            envelope: envelope(),
            envelope_sha256: hashC,
            receipt: undefined,
          },
        ],
        effect_closure: { disposition: 'CLOSED', effect_closure_sha256: hashB },
        database: recoveryDatabase(),
      }),
    ).toThrowError(/RUN_RECOVERY_IDENTITY_MISMATCH/);
    expect(() =>
      decideExpiredRunAttemptRecovery({
        current: expiredAttempt({ lease_fencing_token: '9007199254740991' }),
        accepted_plan_hash: acceptedPlanHash,
        checkpoint: recoveryCheckpoint(),
        effects: [
          {
            expected: { ...expectedIdentity, lease_fencing_token: '9007199254740991' },
            envelope: envelope(),
            envelope_sha256: hashC,
            receipt: undefined,
          },
        ],
        effect_closure: { disposition: 'CLOSED', effect_closure_sha256: hashB },
        database: recoveryDatabase(),
      }),
    ).toThrowError(/RUN_LEASE_FENCING_OVERFLOW/);
  });
});
