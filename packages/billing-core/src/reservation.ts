import type {
  BillingIntentV1,
  CreditLedgerEntryV1,
  CreditReservationV1,
  RunBillingStateV1,
} from '@better-agent/domain-contracts';
import { BillingIntentV1Schema, CreditReservationV1Schema } from '@better-agent/domain-contracts';

import { formatCreditAmountV1, parseCreditAmountV1, parseSignedCreditDeltaV1 } from './amount.js';
import { createInitialRunBillingStateV1 } from './billing-state.js';
import { BillingCoreError } from './errors.js';
import { deepFreezeFactV1 } from './freeze.js';
import {
  assertLedgerEntryMatchesIntentV1,
  billingLockOrderKeysV1,
  classifyBillingIntentReplayV1,
  prepareCreditLedgerEntryV1,
  type PersistedBillingIntentV1,
} from './ledger.js';

type ReserveBillingIntentV1 = Extract<BillingIntentV1, { readonly intent_kind: 'RESERVE' }>;
type ReservationMutationIntentV1 = Exclude<BillingIntentV1, { readonly intent_kind: 'RESERVE' }>;

export interface WorkspaceCreditBalancesV1 {
  readonly available_credits: bigint;
  readonly reserved_credits: bigint;
  readonly settled_credits: bigint;
  readonly balance_version: number;
}

export interface ExistingBillingMutationV1 extends PersistedBillingIntentV1 {
  readonly ledger_entry: CreditLedgerEntryV1;
}

export interface PreparedInitialReservationV1 {
  readonly outcome: 'NEW';
  readonly reservation: CreditReservationV1;
  readonly ledger_entry: CreditLedgerEntryV1;
  readonly balances: WorkspaceCreditBalancesV1;
  readonly billing_state: RunBillingStateV1;
  readonly lock_order_keys: readonly string[];
}

export interface PreparedReservationMutationV1 {
  readonly outcome: 'NEW' | 'REPLAY';
  readonly reservation: CreditReservationV1;
  readonly ledger_entry: CreditLedgerEntryV1;
  readonly balances: WorkspaceCreditBalancesV1;
  readonly lock_order_keys: readonly string[];
}

export function prepareInitialReservationV1(input: {
  readonly intent: ReserveBillingIntentV1;
  readonly ledger_entry_id: string;
  readonly billing_intent_hash: string;
  readonly balances: WorkspaceCreditBalancesV1;
  readonly created_at: string;
}): PreparedInitialReservationV1 {
  const intent = parseReserveIntent(input.intent);
  const createdAt = parseTimestamp(input.created_at, 'created_at');
  const expiresAt = parseTimestamp(intent.expires_at, 'RESERVE expires_at');
  if (expiresAt <= createdAt) {
    throw new BillingCoreError(
      'BILLING_FACT_INVALID',
      'reservation expiry must be later than its creation time',
      { charge_key: intent.charge_key, intent_kind: intent.intent_kind },
    );
  }
  const balances = parseBalances(input.balances);
  const amount = parseCreditAmountV1(intent.amount_credits);
  if (balances.available_credits < amount) {
    throw new BillingCoreError(
      'BILLING_BALANCE_INSUFFICIENT',
      'available credits are insufficient for the requested reservation',
      { charge_key: intent.charge_key },
    );
  }

  const preparedLedger = prepareCreditLedgerEntryV1({
    intent,
    ledger_entry_id: input.ledger_entry_id,
    billing_intent_hash: input.billing_intent_hash,
    current_balance_version: balances.balance_version,
    metering_detail_redacted: {},
    created_at: input.created_at,
  });
  const nextBalances = applyLedgerEntryToBalances(balances, preparedLedger.ledger_entry);
  const reservation = parseReservation({
    schema_version: 'credit-reservation/1',
    reservation_id: intent.reservation_id,
    workspace_id: intent.workspace_id,
    run_id: intent.billing_owner_run_id,
    accepted_plan_hash: intent.accepted_plan_hash,
    status: 'HELD',
    reserved_credits: intent.amount_credits,
    settled_credits: '0',
    released_credits: '0',
    balance_version: preparedLedger.next_balance_version,
    expires_at: intent.expires_at,
    created_at: input.created_at,
    updated_at: input.created_at,
  });

  return Object.freeze({
    outcome: 'NEW',
    reservation,
    ledger_entry: preparedLedger.ledger_entry,
    balances: nextBalances,
    billing_state: createInitialRunBillingStateV1(intent.workspace_id, intent.billing_owner_run_id),
    lock_order_keys: billingLockOrderKeysV1(intent),
  });
}

export function applyReservationIntentV1(input: {
  readonly intent: ReservationMutationIntentV1;
  readonly reservation: CreditReservationV1;
  readonly ledger_entry_id: string;
  readonly billing_intent_hash: string;
  readonly balances: WorkspaceCreditBalancesV1;
  readonly now_at: string;
  readonly existing?: ExistingBillingMutationV1;
}): PreparedReservationMutationV1 {
  const intent = parseMutationIntent(input.intent);
  const reservation = parseReservation(input.reservation);
  const balances = parseBalances(input.balances);
  assertIntentTargetsReservation(intent, reservation);
  if (balances.balance_version < reservation.balance_version) {
    throw new BillingCoreError(
      'BILLING_FACT_INVALID',
      'workspace balance snapshot predates the reservation fact',
      {
        balances_balance_version: balances.balance_version.toString(),
        reservation_balance_version: reservation.balance_version.toString(),
      },
    );
  }
  const now = parseTimestamp(input.now_at, 'now_at');

  if (input.existing !== undefined) {
    const outcome = classifyBillingIntentReplayV1({
      existing: input.existing,
      proposed_intent: intent,
      proposed_intent_hash: input.billing_intent_hash,
    });
    if (outcome !== 'REPLAY') {
      throw new BillingCoreError('BILLING_FACT_INVALID', 'existing mutation was not a replay');
    }
    if (input.existing.ledger_entry.billing_intent_hash !== input.existing.billing_intent_hash) {
      throw new BillingCoreError(
        'BILLING_LEDGER_MISMATCH',
        'persisted ledger hash does not match the persisted intent hash',
        { charge_key: intent.charge_key },
      );
    }
    const ledgerEntry = assertLedgerEntryMatchesIntentV1(intent, input.existing.ledger_entry);
    if (balances.balance_version < ledgerEntry.balance_version) {
      throw new BillingCoreError(
        'BILLING_FACT_INVALID',
        'workspace balance snapshot predates the persisted ledger entry',
        {
          balances_balance_version: balances.balance_version.toString(),
          ledger_balance_version: ledgerEntry.balance_version.toString(),
        },
      );
    }
    return Object.freeze({
      outcome: 'REPLAY',
      reservation,
      ledger_entry: ledgerEntry,
      balances,
      lock_order_keys: billingLockOrderKeysV1(intent),
    });
  }

  const reservationUpdatedAt = parseTimestamp(reservation.updated_at, 'reservation updated_at');
  if (now < reservationUpdatedAt) {
    throw new BillingCoreError(
      'BILLING_FACT_INVALID',
      'billing mutation time cannot precede the current reservation update',
      { charge_key: intent.charge_key, intent_kind: intent.intent_kind },
    );
  }

  const reserved = parseCreditAmountV1(reservation.reserved_credits);
  const settled = parseCreditAmountV1(reservation.settled_credits);
  const released = parseCreditAmountV1(reservation.released_credits);
  const remaining = reserved - settled - released;
  const movement = movementForIntent(intent);
  const isEvidenceOnlyClosedReconciliation =
    intent.intent_kind === 'RECONCILIATION' &&
    reservation.status !== 'HELD' &&
    movement.settle === 0n &&
    movement.release === 0n;

  if (reservation.status !== 'HELD' && !isEvidenceOnlyClosedReconciliation) {
    throw new BillingCoreError(
      'BILLING_RESERVATION_STATE_INVALID',
      'a new billing mutation requires a HELD reservation',
      { reservation_status: reservation.status, intent_kind: intent.intent_kind },
    );
  }

  if (isEvidenceOnlyClosedReconciliation) {
    const preparedLedger = prepareCreditLedgerEntryV1({
      intent,
      ledger_entry_id: input.ledger_entry_id,
      billing_intent_hash: input.billing_intent_hash,
      current_balance_version: balances.balance_version,
      metering_detail_redacted: {},
      created_at: input.now_at,
    });
    return Object.freeze({
      outcome: 'NEW',
      reservation,
      ledger_entry: preparedLedger.ledger_entry,
      balances: applyLedgerEntryToBalances(balances, preparedLedger.ledger_entry),
      lock_order_keys: billingLockOrderKeysV1(intent),
    });
  }

  if (intent.intent_kind === 'EXPIRED') {
    const reservationExpiry = parseTimestamp(reservation.expires_at, 'reservation expires_at');
    if (intent.expires_at !== reservation.expires_at) {
      throw new BillingCoreError(
        'BILLING_FACT_INVALID',
        'EXPIRED intent must bind the reservation expiry exactly',
        { charge_key: intent.charge_key },
      );
    }
    if (now < reservationExpiry) {
      throw new BillingCoreError(
        'BILLING_EXPIRY_NOT_REACHED',
        'reservation cannot expire before expires_at',
        { charge_key: intent.charge_key },
      );
    }
    if (settled !== 0n || released !== 0n || remaining !== reserved) {
      throw new BillingCoreError(
        'BILLING_EXPIRED_RESERVATION_CONSUMED',
        'EXPIRED requires a fully unconsumed HELD reservation',
        { charge_key: intent.charge_key },
      );
    }
    if (movement.release !== remaining) {
      throw new BillingCoreError(
        'BILLING_RESERVATION_EXCEEDED',
        'EXPIRED must release the exact remaining reservation',
        { charge_key: intent.charge_key },
      );
    }
  }
  if (intent.intent_kind === 'RECONCILIATION' && movement.settle + movement.release !== remaining) {
    throw new BillingCoreError(
      'BILLING_RESERVATION_STATE_INVALID',
      'RECONCILIATION must account for the entire remaining reservation',
      { charge_key: intent.charge_key },
    );
  }
  if (movement.settle + movement.release > remaining) {
    throw new BillingCoreError(
      'BILLING_RESERVATION_EXCEEDED',
      'billing mutation exceeds the remaining reservation',
      { charge_key: intent.charge_key, intent_kind: intent.intent_kind },
    );
  }

  const nextSettled = settled + movement.settle;
  const nextReleased = released + movement.release;
  const nextAccounted = nextSettled + nextReleased;
  const preparedLedger = prepareCreditLedgerEntryV1({
    intent,
    ledger_entry_id: input.ledger_entry_id,
    billing_intent_hash: input.billing_intent_hash,
    current_balance_version: balances.balance_version,
    metering_detail_redacted: {},
    created_at: input.now_at,
  });
  const nextBalances = applyLedgerEntryToBalances(balances, preparedLedger.ledger_entry);
  const lifecycle = reservationLifecycle(
    intent,
    reserved,
    nextSettled,
    nextReleased,
    nextAccounted,
    input.now_at,
  );
  const nextReservation = parseReservation({
    ...reservation,
    status: lifecycle.status,
    settled_credits: formatCreditAmountV1(nextSettled),
    released_credits: formatCreditAmountV1(nextReleased),
    balance_version: preparedLedger.next_balance_version,
    updated_at: input.now_at,
    ...(lifecycle.status_reason_code === undefined
      ? {}
      : { status_reason_code: lifecycle.status_reason_code }),
    ...(lifecycle.settled_at === undefined ? {} : { settled_at: lifecycle.settled_at }),
    ...(lifecycle.released_at === undefined ? {} : { released_at: lifecycle.released_at }),
  });

  return Object.freeze({
    outcome: 'NEW',
    reservation: nextReservation,
    ledger_entry: preparedLedger.ledger_entry,
    balances: nextBalances,
    lock_order_keys: billingLockOrderKeysV1(intent),
  });
}

export function prepareChildAllocationV1(_input: unknown): never {
  throw new BillingCoreError(
    'BILLING_CHILD_ALLOCATION_UNSUPPORTED',
    'child allocation is unavailable until its dedicated schema and migration exist',
  );
}

function movementForIntent(intent: ReservationMutationIntentV1): {
  readonly settle: bigint;
  readonly release: bigint;
} {
  switch (intent.intent_kind) {
    case 'SETTLE':
      return { settle: parseCreditAmountV1(intent.amount_credits), release: 0n };
    case 'RELEASE':
      return { settle: 0n, release: parseCreditAmountV1(intent.amount_credits) };
    case 'EXPIRED':
      return { settle: 0n, release: parseCreditAmountV1(intent.remaining_credits) };
    case 'RECONCILIATION':
      return {
        settle: parseCreditAmountV1(intent.settle_credits),
        release: parseCreditAmountV1(intent.release_credits),
      };
  }
}

function reservationLifecycle(
  intent: ReservationMutationIntentV1,
  reserved: bigint,
  settled: bigint,
  released: bigint,
  accounted: bigint,
  nowAt: string,
): {
  readonly status: CreditReservationV1['status'];
  readonly status_reason_code?: string;
  readonly settled_at?: string;
  readonly released_at?: string;
} {
  if (accounted < reserved) return { status: 'HELD' };
  if (intent.intent_kind === 'EXPIRED') {
    return {
      status: 'EXPIRED',
      status_reason_code: 'RESERVATION_EXPIRED',
      released_at: nowAt,
    };
  }
  if (settled > 0n || (reserved === 0n && intent.intent_kind !== 'RELEASE')) {
    return {
      status: 'SETTLED',
      settled_at: nowAt,
      ...(released === 0n ? {} : { released_at: nowAt }),
    };
  }
  return { status: 'RELEASED', released_at: nowAt };
}

function applyLedgerEntryToBalances(
  balances: WorkspaceCreditBalancesV1,
  entry: CreditLedgerEntryV1,
): WorkspaceCreditBalancesV1 {
  const available =
    balances.available_credits + parseSignedCreditDeltaV1(entry.available_delta_credits);
  const reserved =
    balances.reserved_credits + parseSignedCreditDeltaV1(entry.reserved_delta_credits);
  const settled = balances.settled_credits + parseSignedCreditDeltaV1(entry.settled_delta_credits);
  if (available < 0n || reserved < 0n || settled < 0n) {
    throw new BillingCoreError(
      'BILLING_BALANCE_INSUFFICIENT',
      'ledger delta would make a workspace credit projection negative',
      { charge_key: entry.charge_key },
    );
  }
  formatCreditAmountV1(available);
  formatCreditAmountV1(reserved);
  formatCreditAmountV1(settled);
  return Object.freeze({
    available_credits: available,
    reserved_credits: reserved,
    settled_credits: settled,
    balance_version: entry.balance_version,
  });
}

function parseBalances(input: WorkspaceCreditBalancesV1): WorkspaceCreditBalancesV1 {
  const expectedKeys = new Set([
    'available_credits',
    'reserved_credits',
    'settled_credits',
    'balance_version',
  ]);
  const actualKeys =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? Reflect.ownKeys(input)
      : [];
  if (
    actualKeys.length !== expectedKeys.size ||
    !actualKeys.every((key) => typeof key === 'string' && expectedKeys.has(key)) ||
    typeof input.available_credits !== 'bigint' ||
    typeof input.reserved_credits !== 'bigint' ||
    typeof input.settled_credits !== 'bigint' ||
    input.available_credits < 0n ||
    input.reserved_credits < 0n ||
    input.settled_credits < 0n ||
    !Number.isSafeInteger(input.balance_version) ||
    input.balance_version < 0
  ) {
    throw new BillingCoreError(
      'BILLING_FACT_INVALID',
      'workspace credit balances must be non-negative bigint values with a safe version',
    );
  }
  formatCreditAmountV1(input.available_credits);
  formatCreditAmountV1(input.reserved_credits);
  formatCreditAmountV1(input.settled_credits);
  return Object.freeze({
    available_credits: input.available_credits,
    reserved_credits: input.reserved_credits,
    settled_credits: input.settled_credits,
    balance_version: input.balance_version,
  });
}

function parseReserveIntent(input: ReserveBillingIntentV1): ReserveBillingIntentV1 {
  const result = BillingIntentV1Schema.safeParse(input);
  if (!result.success || result.data.intent_kind !== 'RESERVE') {
    throw new BillingCoreError('BILLING_FACT_INVALID', 'initial reservation requires RESERVE');
  }
  return deepFreezeFactV1(result.data);
}

function parseMutationIntent(input: ReservationMutationIntentV1): ReservationMutationIntentV1 {
  const result = BillingIntentV1Schema.safeParse(input);
  if (!result.success || result.data.intent_kind === 'RESERVE') {
    throw new BillingCoreError(
      'BILLING_FACT_INVALID',
      'reservation mutation requires a non-RESERVE billing intent',
    );
  }
  return deepFreezeFactV1(result.data);
}

function parseReservation(input: unknown): CreditReservationV1 {
  const result = CreditReservationV1Schema.safeParse(input);
  if (!result.success) {
    throw new BillingCoreError('BILLING_FACT_INVALID', 'credit reservation fact is invalid');
  }
  return deepFreezeFactV1(result.data);
}

function assertIntentTargetsReservation(
  intent: ReservationMutationIntentV1,
  reservation: CreditReservationV1,
): void {
  if (
    intent.workspace_id !== reservation.workspace_id ||
    intent.billing_owner_run_id !== reservation.run_id ||
    intent.reservation_id !== reservation.reservation_id
  ) {
    throw new BillingCoreError(
      'BILLING_FACT_INVALID',
      'billing intent does not target the supplied reservation',
      { charge_key: intent.charge_key },
    );
  }
}

function parseTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new BillingCoreError('BILLING_FACT_INVALID', `${label} must be an ISO timestamp`);
  }
  return parsed;
}
