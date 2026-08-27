import { describe, expect, it } from 'vitest';

import type {
  BillingIntentV1,
  CreditLedgerEntryV1,
  CreditReservationV1,
} from '@better-agent/domain-contracts';

import {
  applyReservationIntentV1,
  assertBillingIntentHashV1,
  assertLedgerEntryMatchesIntentV1,
  BillingCoreError,
  billingLockOrderKeysV1,
  classifyBillingIntentReplayV1,
  createInitialRunBillingStateV1,
  formatCreditAmountV1,
  formatSignedCreditDeltaV1,
  parseCreditAmountV1,
  parseSignedCreditDeltaV1,
  prepareChildAllocationV1,
  prepareBillingIntentHashV1,
  prepareCreditLedgerEntryV1,
  prepareInitialReservationV1,
  prepareLedgerDeltaV1,
  transitionRunBillingStateV1,
} from '../src/index.js';

const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303eee';
const runId = '018f47f2-c541-7cc6-9292-4a2c35303e01';
const producerRunId = '018f47f2-c541-7cc6-9292-4a2c35303e02';
const reservationId = '018f47f2-c541-7cc6-9292-4a2c35303e03';
const attemptId = '018f47f2-c541-7cc6-9292-4a2c35303e04';
const stepId = '018f47f2-c541-7cc6-9292-4a2c35303e05';
const reconciliationId = '018f47f2-c541-7cc6-9292-4a2c35303e06';
const ledgerEntryId = '018f47f2-c541-7cc6-9292-4a2c35303e07';
const hashA = `sha256:${'a'.repeat(64)}`;
const hashB = `sha256:${'b'.repeat(64)}`;
const hashC = `sha256:${'c'.repeat(64)}`;
const createdAt = '2026-08-27T01:00:00.000Z';
const expiresAt = '2026-08-28T01:00:00.000Z';

const reserveIntent = {
  schema_version: 'billing-intent/1',
  intent_kind: 'RESERVE',
  workspace_id: workspaceId,
  billing_owner_run_id: runId,
  reservation_id: reservationId,
  charge_key: `reserve/${runId}`,
  amount_credits: '5',
  accepted_plan_hash: hashA,
  expires_at: expiresAt,
} as const satisfies BillingIntentV1;

const settleIntent = {
  schema_version: 'billing-intent/1',
  intent_kind: 'SETTLE',
  workspace_id: workspaceId,
  billing_owner_run_id: runId,
  reservation_id: reservationId,
  charge_key: `settle/${runId}/1`,
  producer_run_id: producerRunId,
  producer_attempt_id: attemptId,
  producer_lease_fencing_token: 3,
  step_id: stepId,
  amount_credits: '2',
  charge_attribution_hash: hashB,
} as const satisfies BillingIntentV1;

const releaseIntent = {
  ...settleIntent,
  intent_kind: 'RELEASE',
  charge_key: `release/${runId}/1`,
  amount_credits: '3',
} as const satisfies BillingIntentV1;

const expiredIntent = {
  schema_version: 'billing-intent/1',
  intent_kind: 'EXPIRED',
  workspace_id: workspaceId,
  billing_owner_run_id: runId,
  reservation_id: reservationId,
  charge_key: `expired/${runId}`,
  remaining_credits: '5',
  expires_at: expiresAt,
  charge_attribution_hash: hashB,
} as const satisfies BillingIntentV1;

const reconciliationIntent = {
  schema_version: 'billing-intent/1',
  intent_kind: 'RECONCILIATION',
  workspace_id: workspaceId,
  billing_owner_run_id: runId,
  reservation_id: reservationId,
  charge_key: `reconciliation/${runId}`,
  reconciliation_id: reconciliationId,
  release_credits: '3',
  settle_credits: '2',
  evidence_ref: 'object://billing/reconciliation.json',
  evidence_sha256: hashC,
} as const satisfies BillingIntentV1;

const allIntents = [
  reserveIntent,
  settleIntent,
  releaseIntent,
  expiredIntent,
  reconciliationIntent,
] as const;

function heldReservation(overrides: Partial<CreditReservationV1> = {}): CreditReservationV1 {
  return {
    schema_version: 'credit-reservation/1',
    reservation_id: reservationId,
    workspace_id: workspaceId,
    run_id: runId,
    accepted_plan_hash: hashA,
    status: 'HELD',
    reserved_credits: '5',
    settled_credits: '0',
    released_credits: '0',
    balance_version: 4,
    expires_at: expiresAt,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };
}

function closedReservation(
  status: Extract<CreditReservationV1['status'], 'SETTLED' | 'RELEASED' | 'EXPIRED'>,
): CreditReservationV1 {
  if (status === 'SETTLED') {
    return heldReservation({
      status,
      settled_credits: '5',
      settled_at: createdAt,
    });
  }
  return heldReservation({
    status,
    released_credits: '5',
    released_at: createdAt,
    ...(status === 'EXPIRED' ? { status_reason_code: 'RESERVATION_EXPIRED' } : {}),
  });
}

describe('canonical credit amounts', () => {
  it('round-trips the PostgreSQL bigint range beyond JavaScript safe integers', () => {
    const value = '9223372036854775807';
    expect(parseCreditAmountV1(value)).toBe(9223372036854775807n);
    expect(formatCreditAmountV1(parseCreditAmountV1(value))).toBe(value);
    expect(parseSignedCreditDeltaV1('-9223372036854775808')).toBe(-9223372036854775808n);
    expect(formatSignedCreditDeltaV1(-5n)).toBe('-5');
  });

  it('rejects non-canonical and negative boundary amounts', () => {
    for (const invalid of ['-1', '00', '01', '1e3', '+1', ' 1']) {
      expect(() => parseCreditAmountV1(invalid)).toThrowError(BillingCoreError);
    }
    expect(() => formatCreditAmountV1(-1n)).toThrowError(BillingCoreError);
    expect(() => parseSignedCreditDeltaV1('-0')).toThrowError(BillingCoreError);
    expect(() => parseCreditAmountV1('9223372036854775808')).toThrowError(BillingCoreError);
    expect(() => formatCreditAmountV1(9223372036854775808n)).toThrowError(BillingCoreError);
    expect(() => parseSignedCreditDeltaV1('9223372036854775808')).toThrowError(BillingCoreError);
    expect(() => parseSignedCreditDeltaV1('-9223372036854775809')).toThrowError(BillingCoreError);
  });
});

describe('billing intent replay, locks, and ledger triangles', () => {
  it('uses the shared JCS profile for a stable BillingIntent digest', () => {
    expect(prepareBillingIntentHashV1(reserveIntent)).toBe(
      'sha256:cf997fbf9d293164ba288a97a8285277d074c15b160ca9320525e78562ea9db2',
    );
    expect(
      prepareBillingIntentHashV1({
        workspace_id: workspaceId,
        schema_version: 'billing-intent/1',
        reservation_id: reservationId,
        intent_kind: 'RESERVE',
        expires_at: expiresAt,
        charge_key: `reserve/${runId}`,
        billing_owner_run_id: runId,
        amount_credits: '5',
        accepted_plan_hash: hashA,
      }),
    ).toBe(prepareBillingIntentHashV1(reserveIntent));
  });

  it('rejects a syntactically valid hash that does not belong to the proposed intent', () => {
    expect(() =>
      classifyBillingIntentReplayV1({
        existing: undefined,
        proposed_intent: reserveIntent,
        proposed_intent_hash: hashB,
      }),
    ).toThrowError(/BILLING_FACT_INVALID/u);
  });

  it('classifies all five intent kinds as NEW, REPLAY, or conflict by full intent and hash', () => {
    for (const intent of allIntents) {
      const intentHash = prepareBillingIntentHashV1(intent);
      expect(
        classifyBillingIntentReplayV1({
          existing: undefined,
          proposed_intent: intent,
          proposed_intent_hash: intentHash,
        }),
      ).toBe('NEW');
      expect(
        classifyBillingIntentReplayV1({
          existing: { intent: structuredClone(intent), billing_intent_hash: intentHash },
          proposed_intent: intent,
          proposed_intent_hash: intentHash,
        }),
      ).toBe('REPLAY');
      expect(() =>
        classifyBillingIntentReplayV1({
          existing: { intent, billing_intent_hash: hashB },
          proposed_intent: intent,
          proposed_intent_hash: intentHash,
        }),
      ).toThrowError(/BILLING_FACT_INVALID/u);
    }

    const changedReserveIntent = { ...reserveIntent, amount_credits: '6' } as const;
    expect(() =>
      classifyBillingIntentReplayV1({
        existing: {
          intent: reserveIntent,
          billing_intent_hash: prepareBillingIntentHashV1(reserveIntent),
        },
        proposed_intent: changedReserveIntent,
        proposed_intent_hash: prepareBillingIntentHashV1(changedReserveIntent),
      }),
    ).toThrowError(/BILLING_INTENT_CONFLICT/u);
  });

  it('derives exact deltas including EXPIRED and RECONCILIATION', () => {
    expect(prepareLedgerDeltaV1(reserveIntent)).toEqual({
      available_delta_credits: '-5',
      reserved_delta_credits: '5',
      settled_delta_credits: '0',
    });
    expect(prepareLedgerDeltaV1(settleIntent)).toEqual({
      available_delta_credits: '0',
      reserved_delta_credits: '-2',
      settled_delta_credits: '2',
    });
    expect(prepareLedgerDeltaV1(releaseIntent)).toEqual({
      available_delta_credits: '3',
      reserved_delta_credits: '-3',
      settled_delta_credits: '0',
    });
    expect(prepareLedgerDeltaV1(expiredIntent)).toEqual({
      available_delta_credits: '5',
      reserved_delta_credits: '-5',
      settled_delta_credits: '0',
    });
    expect(prepareLedgerDeltaV1(reconciliationIntent)).toEqual({
      available_delta_credits: '3',
      reserved_delta_credits: '-5',
      settled_delta_credits: '2',
    });
  });

  it('rejects a persisted ledger entry whose triangle differs from its intent', () => {
    const prepared = prepareCreditLedgerEntryV1({
      intent: expiredIntent,
      ledger_entry_id: ledgerEntryId,
      billing_intent_hash: prepareBillingIntentHashV1(expiredIntent),
      current_balance_version: 4,
      metering_detail_redacted: {},
      created_at: createdAt,
    });
    expect(prepared.next_balance_version).toBe(5);
    expect(() =>
      assertLedgerEntryMatchesIntentV1(expiredIntent, {
        ...prepared.ledger_entry,
        reserved_delta_credits: '-4',
      }),
    ).toThrowError(/BILLING_LEDGER_MISMATCH/u);
    expect(() =>
      assertLedgerEntryMatchesIntentV1(expiredIntent, {
        ...prepared.ledger_entry,
        billing_intent_hash: hashA,
      }),
    ).toThrowError(/BILLING_LEDGER_MISMATCH/u);
    expect(() =>
      prepareCreditLedgerEntryV1({
        intent: expiredIntent,
        ledger_entry_id: ledgerEntryId,
        billing_intent_hash: hashA,
        current_balance_version: 4,
        metering_detail_redacted: {},
        created_at: createdAt,
      }),
    ).toThrowError(/BILLING_FACT_INVALID/u);
  });

  it('schema-clones and recursively freezes prepared financial facts', () => {
    const mutableIntent = structuredClone(settleIntent) as BillingIntentV1;
    const parsedIntent = assertBillingIntentHashV1({
      intent: mutableIntent,
      billing_intent_hash: prepareBillingIntentHashV1(mutableIntent),
      hash_role: 'PROPOSED',
    });
    expect(parsedIntent).not.toBe(mutableIntent);
    expect(Object.isFrozen(parsedIntent)).toBe(true);

    const mutableMetering = {
      usage: { input_tokens: 7 },
      segments: [{ name: 'prompt' }],
    };
    const prepared = prepareCreditLedgerEntryV1({
      intent: settleIntent,
      ledger_entry_id: ledgerEntryId,
      billing_intent_hash: prepareBillingIntentHashV1(settleIntent),
      current_balance_version: 4,
      metering_detail_redacted: mutableMetering,
      created_at: createdAt,
    });
    const metering = prepared.ledger_entry.metering_detail_redacted as {
      usage: { input_tokens: number };
      segments: Array<{ name: string }>;
    };
    expect(prepared.ledger_entry.metering_detail_redacted).not.toBe(mutableMetering);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.ledger_entry)).toBe(true);
    expect(Object.isFrozen(metering)).toBe(true);
    expect(Object.isFrozen(metering.usage)).toBe(true);
    expect(Object.isFrozen(metering.segments)).toBe(true);
    expect(Object.isFrozen(metering.segments[0])).toBe(true);

    mutableMetering.usage.input_tokens = 99;
    mutableMetering.segments[0] = { name: 'mutated' };
    expect(metering).toEqual({
      usage: { input_tokens: 7 },
      segments: [{ name: 'prompt' }],
    });
  });

  it('returns the stable global lock order', () => {
    expect(billingLockOrderKeysV1(settleIntent)).toEqual([
      `workspace:${workspaceId}`,
      `run:${runId}`,
      `run:${producerRunId}`,
      `attempt:${producerRunId}:${attemptId}:3`,
      `reservation:${reservationId}`,
      `charge:${workspaceId}:${settleIntent.charge_key}`,
    ]);
    expect(billingLockOrderKeysV1(structuredClone(settleIntent))).toEqual(
      billingLockOrderKeysV1(settleIntent),
    );
  });
});

describe('reservation and current billing state', () => {
  it('requires a reservation expiry strictly after its creation time', () => {
    const nonFutureReserveIntent = { ...reserveIntent, expires_at: createdAt } as const;
    expect(() =>
      prepareInitialReservationV1({
        intent: nonFutureReserveIntent,
        ledger_entry_id: ledgerEntryId,
        billing_intent_hash: prepareBillingIntentHashV1(nonFutureReserveIntent),
        balances: {
          available_credits: 100n,
          reserved_credits: 0n,
          settled_credits: 0n,
          balance_version: 0,
        },
        created_at: createdAt,
      }),
    ).toThrowError(/BILLING_FACT_INVALID/u);
  });

  it('rejects a mutation timestamp before the current reservation update', () => {
    for (const currentCreatedAt of ['2026-08-28T01:00:00.000Z', '2026-08-26T01:00:00.000Z']) {
      expect(() =>
        applyReservationIntentV1({
          intent: settleIntent,
          reservation: heldReservation({
            created_at: currentCreatedAt,
            updated_at: '2026-08-28T01:00:00.000Z',
            expires_at: '2026-08-29T01:00:00.000Z',
          }),
          ledger_entry_id: ledgerEntryId,
          billing_intent_hash: prepareBillingIntentHashV1(settleIntent),
          balances: {
            available_credits: 10n,
            reserved_credits: 5n,
            settled_credits: 0n,
            balance_version: 4,
          },
          now_at: createdAt,
        }),
      ).toThrowError(/BILLING_FACT_INVALID/u);
    }
  });

  it('creates a zero HELD reservation and zero ledger without advancing balances or version', () => {
    const zeroReserveIntent = { ...reserveIntent, amount_credits: '0' } as const;
    const result = prepareInitialReservationV1({
      intent: zeroReserveIntent,
      ledger_entry_id: ledgerEntryId,
      billing_intent_hash: prepareBillingIntentHashV1(zeroReserveIntent),
      balances: {
        available_credits: 100n,
        reserved_credits: 9n,
        settled_credits: 3n,
        balance_version: 7,
      },
      created_at: createdAt,
    });

    expect(result.reservation.status).toBe('HELD');
    expect(result.reservation.reserved_credits).toBe('0');
    expect(result.ledger_entry).toMatchObject({
      entry_kind: 'RESERVE',
      available_delta_credits: '0',
      reserved_delta_credits: '0',
      settled_delta_credits: '0',
      balance_version: 7,
    });
    expect(result.balances).toEqual({
      available_credits: 100n,
      reserved_credits: 9n,
      settled_credits: 3n,
      balance_version: 7,
    });
    expect(result.billing_state).toEqual({
      schema_version: 'run-billing-state/1',
      workspace_id: workspaceId,
      run_id: runId,
      billing_state: 'PENDING',
      billing_settled_at: null,
    });
  });

  it('rejects insufficient reserve and settlement beyond the remaining amount', () => {
    expect(() =>
      prepareInitialReservationV1({
        intent: reserveIntent,
        ledger_entry_id: ledgerEntryId,
        billing_intent_hash: prepareBillingIntentHashV1(reserveIntent),
        balances: {
          available_credits: 4n,
          reserved_credits: 0n,
          settled_credits: 0n,
          balance_version: 0,
        },
        created_at: createdAt,
      }),
    ).toThrowError(/BILLING_BALANCE_INSUFFICIENT/u);

    const oversizedSettleIntent = { ...settleIntent, amount_credits: '6' } as const;
    expect(() =>
      applyReservationIntentV1({
        intent: oversizedSettleIntent,
        reservation: heldReservation(),
        ledger_entry_id: ledgerEntryId,
        billing_intent_hash: prepareBillingIntentHashV1(oversizedSettleIntent),
        balances: {
          available_credits: 10n,
          reserved_credits: 5n,
          settled_credits: 0n,
          balance_version: 4,
        },
        now_at: createdAt,
      }),
    ).toThrowError(/BILLING_RESERVATION_EXCEEDED/u);
  });

  it('rejects balance projections that would overflow PostgreSQL bigint', () => {
    const oneCreditRelease = { ...releaseIntent, amount_credits: '1' } as const;
    expect(() =>
      applyReservationIntentV1({
        intent: oneCreditRelease,
        reservation: heldReservation({ reserved_credits: '1' }),
        ledger_entry_id: ledgerEntryId,
        billing_intent_hash: prepareBillingIntentHashV1(oneCreditRelease),
        balances: {
          available_credits: 9223372036854775807n,
          reserved_credits: 1n,
          settled_credits: 0n,
          balance_version: 4,
        },
        now_at: createdAt,
      }),
    ).toThrowError(BillingCoreError);
  });

  it('does not apply a replayed settlement twice', () => {
    const first = applyReservationIntentV1({
      intent: settleIntent,
      reservation: heldReservation(),
      ledger_entry_id: ledgerEntryId,
      billing_intent_hash: prepareBillingIntentHashV1(settleIntent),
      balances: {
        available_credits: 10n,
        reserved_credits: 5n,
        settled_credits: 0n,
        balance_version: 4,
      },
      now_at: createdAt,
    });
    expect(first.outcome).toBe('NEW');
    expect(first.reservation.settled_credits).toBe('2');
    expect(first.balances.settled_credits).toBe(2n);

    const replay = applyReservationIntentV1({
      intent: settleIntent,
      reservation: first.reservation,
      ledger_entry_id: ledgerEntryId,
      billing_intent_hash: prepareBillingIntentHashV1(settleIntent),
      balances: first.balances,
      now_at: createdAt,
      existing: {
        intent: settleIntent,
        billing_intent_hash: prepareBillingIntentHashV1(settleIntent),
        ledger_entry: first.ledger_entry,
      },
    });
    expect(replay.outcome).toBe('REPLAY');
    expect(replay.reservation).toEqual(first.reservation);
    expect(replay.balances).toEqual(first.balances);
  });

  it('returns schema-cloned recursively frozen facts on replay', () => {
    const first = applyReservationIntentV1({
      intent: settleIntent,
      reservation: heldReservation(),
      ledger_entry_id: ledgerEntryId,
      billing_intent_hash: prepareBillingIntentHashV1(settleIntent),
      balances: {
        available_credits: 10n,
        reserved_credits: 5n,
        settled_credits: 0n,
        balance_version: 4,
      },
      now_at: createdAt,
    });
    const callerReservation = structuredClone(first.reservation);
    const callerLedger: CreditLedgerEntryV1 = {
      ...structuredClone(first.ledger_entry),
      metering_detail_redacted: { usage: { output_tokens: 2 } },
    };
    const replay = applyReservationIntentV1({
      intent: settleIntent,
      reservation: callerReservation,
      ledger_entry_id: ledgerEntryId,
      billing_intent_hash: prepareBillingIntentHashV1(settleIntent),
      balances: first.balances,
      now_at: createdAt,
      existing: {
        intent: settleIntent,
        billing_intent_hash: prepareBillingIntentHashV1(settleIntent),
        ledger_entry: callerLedger,
      },
    });
    const replayMetering = replay.ledger_entry.metering_detail_redacted as {
      usage: { output_tokens: number };
    };

    expect(replay.reservation).not.toBe(callerReservation);
    expect(replay.ledger_entry).not.toBe(callerLedger);
    expect(Object.isFrozen(replay.reservation)).toBe(true);
    expect(Object.isFrozen(replay.ledger_entry)).toBe(true);
    expect(Object.isFrozen(replayMetering)).toBe(true);
    expect(Object.isFrozen(replayMetering.usage)).toBe(true);

    callerReservation.updated_at = '2026-08-27T03:00:00.000Z';
    (
      callerLedger.metering_detail_redacted as { usage: { output_tokens: number } }
    ).usage.output_tokens = 99;
    expect(replay.reservation.updated_at).toBe(createdAt);
    expect(replayMetering.usage.output_tokens).toBe(2);
  });

  it('rejects an open balances shape instead of leaking nested caller references on replay', () => {
    const first = applyReservationIntentV1({
      intent: settleIntent,
      reservation: heldReservation(),
      ledger_entry_id: ledgerEntryId,
      billing_intent_hash: prepareBillingIntentHashV1(settleIntent),
      balances: {
        available_credits: 10n,
        reserved_credits: 5n,
        settled_credits: 0n,
        balance_version: 4,
      },
      now_at: createdAt,
    });
    const callerOnly = { secret: 'must-not-cross-the-boundary' };
    const balancesWithExtra = { ...first.balances, caller_only: callerOnly };

    expect(() =>
      applyReservationIntentV1({
        intent: settleIntent,
        reservation: first.reservation,
        ledger_entry_id: ledgerEntryId,
        billing_intent_hash: prepareBillingIntentHashV1(settleIntent),
        balances: balancesWithExtra,
        now_at: createdAt,
        existing: {
          intent: settleIntent,
          billing_intent_hash: prepareBillingIntentHashV1(settleIntent),
          ledger_entry: first.ledger_entry,
        },
      }),
    ).toThrowError(/BILLING_FACT_INVALID/u);
  });

  it('rejects balances older than the reservation or replayed canonical ledger', () => {
    expect(() =>
      applyReservationIntentV1({
        intent: settleIntent,
        reservation: heldReservation({ balance_version: 9 }),
        ledger_entry_id: ledgerEntryId,
        billing_intent_hash: prepareBillingIntentHashV1(settleIntent),
        balances: {
          available_credits: 10n,
          reserved_credits: 5n,
          settled_credits: 0n,
          balance_version: 4,
        },
        now_at: createdAt,
      }),
    ).toThrowError(/BILLING_FACT_INVALID/u);

    const first = applyReservationIntentV1({
      intent: settleIntent,
      reservation: heldReservation(),
      ledger_entry_id: ledgerEntryId,
      billing_intent_hash: prepareBillingIntentHashV1(settleIntent),
      balances: {
        available_credits: 10n,
        reserved_credits: 5n,
        settled_credits: 0n,
        balance_version: 4,
      },
      now_at: createdAt,
    });
    expect(first.ledger_entry.balance_version).toBe(5);
    expect(() =>
      applyReservationIntentV1({
        intent: settleIntent,
        reservation: { ...first.reservation, balance_version: 4 },
        ledger_entry_id: ledgerEntryId,
        billing_intent_hash: prepareBillingIntentHashV1(settleIntent),
        balances: {
          available_credits: 10n,
          reserved_credits: 3n,
          settled_credits: 2n,
          balance_version: 4,
        },
        now_at: createdAt,
        existing: {
          intent: settleIntent,
          billing_intent_hash: prepareBillingIntentHashV1(settleIntent),
          ledger_entry: first.ledger_entry,
        },
      }),
    ).toThrowError(/BILLING_FACT_INVALID/u);
  });

  it('replays an older charge after a later reservation mutation advanced updated_at', () => {
    const first = applyReservationIntentV1({
      intent: settleIntent,
      reservation: heldReservation(),
      ledger_entry_id: ledgerEntryId,
      billing_intent_hash: prepareBillingIntentHashV1(settleIntent),
      balances: {
        available_credits: 10n,
        reserved_credits: 5n,
        settled_credits: 0n,
        balance_version: 4,
      },
      now_at: createdAt,
    });
    const afterLaterMutation: CreditReservationV1 = {
      ...first.reservation,
      settled_credits: '3',
      updated_at: '2026-08-27T02:00:00.000Z',
    };

    const replay = applyReservationIntentV1({
      intent: settleIntent,
      reservation: afterLaterMutation,
      ledger_entry_id: ledgerEntryId,
      billing_intent_hash: prepareBillingIntentHashV1(settleIntent),
      balances: {
        available_credits: 10n,
        reserved_credits: 2n,
        settled_credits: 3n,
        balance_version: 5,
      },
      now_at: createdAt,
      existing: {
        intent: settleIntent,
        billing_intent_hash: prepareBillingIntentHashV1(settleIntent),
        ledger_entry: first.ledger_entry,
      },
    });

    expect(replay.outcome).toBe('REPLAY');
    expect(replay.reservation).toEqual(afterLaterMutation);
    expect(replay.balances).toEqual({
      available_credits: 10n,
      reserved_credits: 2n,
      settled_credits: 3n,
      balance_version: 5,
    });
  });

  it('allows EXPIRED only at expiry for a fully unconsumed HELD reservation', () => {
    const base = {
      intent: expiredIntent,
      reservation: heldReservation(),
      ledger_entry_id: ledgerEntryId,
      billing_intent_hash: prepareBillingIntentHashV1(expiredIntent),
      balances: {
        available_credits: 10n,
        reserved_credits: 5n,
        settled_credits: 0n,
        balance_version: 4,
      },
    } as const;

    expect(() =>
      applyReservationIntentV1({ ...base, now_at: '2026-08-28T00:59:59.999Z' }),
    ).toThrowError(/BILLING_EXPIRY_NOT_REACHED/u);
    expect(() =>
      applyReservationIntentV1({
        ...base,
        reservation: heldReservation({ settled_credits: '1' }),
        now_at: expiresAt,
      }),
    ).toThrowError(/BILLING_EXPIRED_RESERVATION_CONSUMED/u);

    const expired = applyReservationIntentV1({ ...base, now_at: expiresAt });
    expect(expired.reservation).toMatchObject({
      status: 'EXPIRED',
      released_credits: '5',
      released_at: expiresAt,
    });
    expect(expired.balances).toEqual({
      available_credits: 15n,
      reserved_credits: 0n,
      settled_credits: 0n,
      balance_version: 5,
    });
  });

  it('requires RECONCILIATION to account for the entire remaining reservation', () => {
    const base = {
      reservation: heldReservation(),
      ledger_entry_id: ledgerEntryId,
      billing_intent_hash: prepareBillingIntentHashV1(reconciliationIntent),
      balances: {
        available_credits: 10n,
        reserved_credits: 5n,
        settled_credits: 0n,
        balance_version: 4,
      },
      now_at: createdAt,
    } as const;
    expect(() =>
      applyReservationIntentV1({
        ...base,
        intent: { ...reconciliationIntent, release_credits: '2' },
      }),
    ).toThrowError(/BILLING_RESERVATION_STATE_INVALID/u);

    const result = applyReservationIntentV1({ ...base, intent: reconciliationIntent });
    expect(result.reservation).toMatchObject({
      status: 'SETTLED',
      settled_credits: '2',
      released_credits: '3',
      settled_at: createdAt,
      released_at: createdAt,
    });
    expect(result.balances).toEqual({
      available_credits: 13n,
      reserved_credits: 0n,
      settled_credits: 2n,
      balance_version: 5,
    });
  });

  it.each(['SETTLED', 'RELEASED', 'EXPIRED'] as const)(
    'accepts a strict zero-triangle RECONCILIATION as evidence for a closed %s reservation',
    (status) => {
      const reservation = closedReservation(status);
      const balances = {
        available_credits: 10n,
        reserved_credits: 0n,
        settled_credits: 5n,
        balance_version: 9,
      } as const;
      const evidenceOnlyIntent = {
        ...reconciliationIntent,
        release_credits: '0',
        settle_credits: '0',
      } as const;
      const result = applyReservationIntentV1({
        intent: evidenceOnlyIntent,
        reservation,
        ledger_entry_id: ledgerEntryId,
        billing_intent_hash: prepareBillingIntentHashV1(evidenceOnlyIntent),
        balances,
        now_at: createdAt,
      });

      expect(result.outcome).toBe('NEW');
      expect(result.reservation).toEqual(reservation);
      expect(result.balances).toEqual(balances);
      expect(result.ledger_entry).toMatchObject({
        entry_kind: 'RECONCILIATION',
        available_delta_credits: '0',
        reserved_delta_credits: '0',
        settled_delta_credits: '0',
        balance_version: 9,
      });
      expect(Object.isFrozen(result.reservation)).toBe(true);
      expect(Object.isFrozen(result.ledger_entry)).toBe(true);
    },
  );

  it.each(['SETTLED', 'RELEASED', 'EXPIRED'] as const)(
    'rejects a non-zero RECONCILIATION against a closed %s reservation',
    (status) => {
      const nonZeroIntent = {
        ...reconciliationIntent,
        release_credits: '1',
        settle_credits: '0',
      } as const;
      expect(() =>
        applyReservationIntentV1({
          intent: nonZeroIntent,
          reservation: closedReservation(status),
          ledger_entry_id: ledgerEntryId,
          billing_intent_hash: prepareBillingIntentHashV1(nonZeroIntent),
          balances: {
            available_credits: 10n,
            reserved_credits: 0n,
            settled_credits: 5n,
            balance_version: 9,
          },
          now_at: createdAt,
        }),
      ).toThrowError(/BILLING_RESERVATION_STATE_INVALID/u);
    },
  );

  it('keeps current billing state separate and monotonic', () => {
    const pending = createInitialRunBillingStateV1(workspaceId, runId);
    expect(pending.billing_state).toBe('PENDING');
    expect(Object.isFrozen(pending)).toBe(true);
    const attention = transitionRunBillingStateV1(pending, 'NEEDS_ATTENTION', null);
    expect(attention.billing_state).toBe('NEEDS_ATTENTION');
    expect(Object.isFrozen(attention)).toBe(true);
    const settled = transitionRunBillingStateV1(attention, 'SETTLED', '2026-08-27T02:00:00.000Z');
    expect(settled.billing_state).toBe('SETTLED');
    expect(Object.isFrozen(settled)).toBe(true);
    expect(() => transitionRunBillingStateV1(settled, 'PENDING', null)).toThrowError(
      /BILLING_STATE_TRANSITION_INVALID/u,
    );
  });

  it('fails closed for child allocation inputs', () => {
    expect(() =>
      prepareChildAllocationV1({
        workspace_id: workspaceId,
        billing_owner_run_id: runId,
        child_run_id: producerRunId,
        amount_credits: '1',
      }),
    ).toThrowError(/BILLING_CHILD_ALLOCATION_UNSUPPORTED/u);
  });
});
