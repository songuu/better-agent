import type {
  BillingIntentV1,
  CreditLedgerEntryV1,
  JsonObject,
  SignedCreditDeltaV1,
} from '@better-agent/domain-contracts';
import { BillingIntentV1Schema, CreditLedgerEntryV1Schema } from '@better-agent/domain-contracts';

import { formatSignedCreditDeltaV1, parseCreditAmountV1 } from './amount.js';
import { BillingCoreError } from './errors.js';
import { deepFreezeFactV1 } from './freeze.js';
import { assertBillingIntentHashV1, prepareBillingIntentHashV1 } from './intent-hash.js';

export interface CreditLedgerDeltaV1 {
  readonly available_delta_credits: SignedCreditDeltaV1;
  readonly reserved_delta_credits: SignedCreditDeltaV1;
  readonly settled_delta_credits: SignedCreditDeltaV1;
}

export interface PersistedBillingIntentV1 {
  readonly intent: BillingIntentV1;
  readonly billing_intent_hash: string;
}

export type BillingIntentReplayOutcomeV1 = 'NEW' | 'REPLAY';

export function classifyBillingIntentReplayV1(input: {
  readonly existing: PersistedBillingIntentV1 | undefined;
  readonly proposed_intent: BillingIntentV1;
  readonly proposed_intent_hash: string;
}): BillingIntentReplayOutcomeV1 {
  const proposed = assertBillingIntentHashV1({
    intent: input.proposed_intent,
    billing_intent_hash: input.proposed_intent_hash,
    hash_role: 'PROPOSED',
  });
  if (input.existing === undefined) return 'NEW';

  const existing = assertBillingIntentHashV1({
    intent: input.existing.intent,
    billing_intent_hash: input.existing.billing_intent_hash,
    hash_role: 'PERSISTED',
  });
  if (existing.charge_key !== proposed.charge_key) {
    throw new BillingCoreError(
      'BILLING_FACT_INVALID',
      'persisted billing intent lookup returned a different charge key',
      { existing_charge_key: existing.charge_key, proposed_charge_key: proposed.charge_key },
    );
  }

  if (
    input.existing.billing_intent_hash !== input.proposed_intent_hash ||
    !billingIntentsEqualV1(existing, proposed)
  ) {
    throw new BillingCoreError(
      'BILLING_INTENT_CONFLICT',
      'the charge key is already bound to a different billing intent',
      { charge_key: proposed.charge_key, intent_kind: proposed.intent_kind },
    );
  }
  return 'REPLAY';
}

function billingIntentsEqualV1(existing: BillingIntentV1, proposed: BillingIntentV1): boolean {
  if (
    existing.intent_kind !== proposed.intent_kind ||
    existing.schema_version !== proposed.schema_version ||
    existing.workspace_id !== proposed.workspace_id ||
    existing.billing_owner_run_id !== proposed.billing_owner_run_id ||
    existing.reservation_id !== proposed.reservation_id ||
    existing.charge_key !== proposed.charge_key
  ) {
    return false;
  }

  switch (existing.intent_kind) {
    case 'RESERVE':
      return (
        proposed.intent_kind === 'RESERVE' &&
        existing.amount_credits === proposed.amount_credits &&
        existing.accepted_plan_hash === proposed.accepted_plan_hash &&
        existing.expires_at === proposed.expires_at
      );
    case 'SETTLE':
    case 'RELEASE':
      return (
        proposed.intent_kind === existing.intent_kind &&
        existing.producer_run_id === proposed.producer_run_id &&
        existing.producer_attempt_id === proposed.producer_attempt_id &&
        existing.producer_lease_fencing_token === proposed.producer_lease_fencing_token &&
        existing.step_id === proposed.step_id &&
        existing.amount_credits === proposed.amount_credits &&
        existing.charge_attribution_hash === proposed.charge_attribution_hash
      );
    case 'EXPIRED':
      return (
        proposed.intent_kind === 'EXPIRED' &&
        existing.remaining_credits === proposed.remaining_credits &&
        existing.expires_at === proposed.expires_at &&
        existing.charge_attribution_hash === proposed.charge_attribution_hash
      );
    case 'RECONCILIATION':
      return (
        proposed.intent_kind === 'RECONCILIATION' &&
        existing.reconciliation_id === proposed.reconciliation_id &&
        existing.release_credits === proposed.release_credits &&
        existing.settle_credits === proposed.settle_credits &&
        existing.evidence_ref === proposed.evidence_ref &&
        existing.evidence_sha256 === proposed.evidence_sha256
      );
  }
}

export function prepareLedgerDeltaV1(intentInput: BillingIntentV1): CreditLedgerDeltaV1 {
  const intent = parseIntent(intentInput);
  switch (intent.intent_kind) {
    case 'RESERVE': {
      const amount = parseCreditAmountV1(intent.amount_credits);
      return creditDelta(-amount, amount, 0n);
    }
    case 'SETTLE': {
      const amount = parseCreditAmountV1(intent.amount_credits);
      return creditDelta(0n, -amount, amount);
    }
    case 'RELEASE': {
      const amount = parseCreditAmountV1(intent.amount_credits);
      return creditDelta(amount, -amount, 0n);
    }
    case 'EXPIRED': {
      const amount = parseCreditAmountV1(intent.remaining_credits);
      return creditDelta(amount, -amount, 0n);
    }
    case 'RECONCILIATION': {
      const released = parseCreditAmountV1(intent.release_credits);
      const settled = parseCreditAmountV1(intent.settle_credits);
      return creditDelta(released, -(released + settled), settled);
    }
  }
}

export function prepareCreditLedgerEntryV1(input: {
  readonly intent: BillingIntentV1;
  readonly ledger_entry_id: string;
  readonly billing_intent_hash: string;
  readonly current_balance_version: number;
  readonly metering_detail_redacted: JsonObject;
  readonly created_at: string;
}): { readonly ledger_entry: CreditLedgerEntryV1; readonly next_balance_version: number } {
  const intent = assertBillingIntentHashV1({
    intent: input.intent,
    billing_intent_hash: input.billing_intent_hash,
    hash_role: 'LEDGER',
  });
  assertBalanceVersion(input.current_balance_version);
  const delta = prepareLedgerDeltaV1(intent);
  const movesFunds = Object.values(delta).some((value) => value !== '0');
  const nextBalanceVersion = movesFunds
    ? incrementBalanceVersion(input.current_balance_version)
    : input.current_balance_version;

  const executionAttribution =
    intent.intent_kind === 'SETTLE' || intent.intent_kind === 'RELEASE'
      ? {
          producer_run_id: intent.producer_run_id,
          producer_attempt_id: intent.producer_attempt_id,
          producer_lease_fencing_token: intent.producer_lease_fencing_token,
          ...(intent.step_id === undefined ? {} : { step_id: intent.step_id }),
        }
      : { producer_run_id: intent.billing_owner_run_id };
  const chargeAttributionHash =
    intent.intent_kind === 'RESERVE'
      ? intent.accepted_plan_hash
      : intent.intent_kind === 'RECONCILIATION'
        ? intent.evidence_sha256
        : intent.charge_attribution_hash;

  const candidate = {
    schema_version: 'credit-ledger-entry/1',
    ledger_entry_id: input.ledger_entry_id,
    workspace_id: intent.workspace_id,
    run_id: intent.billing_owner_run_id,
    ...executionAttribution,
    reservation_id: intent.reservation_id,
    entry_kind: intent.intent_kind,
    ...delta,
    billing_intent_hash: input.billing_intent_hash,
    charge_attribution_hash: chargeAttributionHash,
    charge_key: intent.charge_key,
    balance_version: nextBalanceVersion,
    metering_detail_redacted: input.metering_detail_redacted,
    created_at: input.created_at,
  };
  const result = CreditLedgerEntryV1Schema.safeParse(candidate);
  if (!result.success) {
    throw new BillingCoreError('BILLING_FACT_INVALID', 'prepared ledger entry is invalid');
  }
  return Object.freeze({
    ledger_entry: deepFreezeFactV1(result.data),
    next_balance_version: nextBalanceVersion,
  });
}

export function assertLedgerEntryMatchesIntentV1(
  intentInput: BillingIntentV1,
  ledgerEntryInput: CreditLedgerEntryV1,
): CreditLedgerEntryV1 {
  const intent = parseIntent(intentInput);
  const parsedLedger = CreditLedgerEntryV1Schema.safeParse(ledgerEntryInput);
  if (!parsedLedger.success) {
    throw new BillingCoreError(
      'BILLING_LEDGER_MISMATCH',
      'persisted ledger entry does not satisfy the closed ledger contract',
    );
  }
  const entry = parsedLedger.data;
  const expectedDelta = prepareLedgerDeltaV1(intent);
  const expectedAttributionHash =
    intent.intent_kind === 'RESERVE'
      ? intent.accepted_plan_hash
      : intent.intent_kind === 'RECONCILIATION'
        ? intent.evidence_sha256
        : intent.charge_attribution_hash;
  const producerMatches =
    intent.intent_kind === 'SETTLE' || intent.intent_kind === 'RELEASE'
      ? entry.producer_run_id === intent.producer_run_id &&
        entry.producer_attempt_id === intent.producer_attempt_id &&
        entry.producer_lease_fencing_token === intent.producer_lease_fencing_token &&
        entry.step_id === intent.step_id
      : entry.producer_run_id === intent.billing_owner_run_id &&
        entry.producer_attempt_id === undefined &&
        entry.producer_lease_fencing_token === undefined &&
        entry.step_id === undefined;

  if (
    entry.workspace_id !== intent.workspace_id ||
    entry.run_id !== intent.billing_owner_run_id ||
    entry.reservation_id !== intent.reservation_id ||
    entry.entry_kind !== intent.intent_kind ||
    entry.billing_intent_hash !== prepareBillingIntentHashV1(intent) ||
    entry.charge_key !== intent.charge_key ||
    entry.charge_attribution_hash !== expectedAttributionHash ||
    !producerMatches ||
    entry.available_delta_credits !== expectedDelta.available_delta_credits ||
    entry.reserved_delta_credits !== expectedDelta.reserved_delta_credits ||
    entry.settled_delta_credits !== expectedDelta.settled_delta_credits
  ) {
    throw new BillingCoreError(
      'BILLING_LEDGER_MISMATCH',
      'persisted ledger entry does not match its billing intent',
      { charge_key: intent.charge_key, intent_kind: intent.intent_kind },
    );
  }
  return deepFreezeFactV1(entry);
}

export function billingLockOrderKeysV1(intentInput: BillingIntentV1): readonly string[] {
  const intent = parseIntent(intentInput);
  const keys = [`workspace:${intent.workspace_id}`, `run:${intent.billing_owner_run_id}`];
  if (intent.intent_kind === 'SETTLE' || intent.intent_kind === 'RELEASE') {
    if (intent.producer_run_id !== intent.billing_owner_run_id) {
      keys.push(`run:${intent.producer_run_id}`);
    }
    keys.push(
      `attempt:${intent.producer_run_id}:${intent.producer_attempt_id}:${intent.producer_lease_fencing_token}`,
    );
  }
  keys.push(
    `reservation:${intent.reservation_id}`,
    `charge:${intent.workspace_id}:${intent.charge_key}`,
  );
  return Object.freeze(keys);
}

function parseIntent(intent: BillingIntentV1): BillingIntentV1 {
  const result = BillingIntentV1Schema.safeParse(intent);
  if (!result.success) {
    throw new BillingCoreError('BILLING_FACT_INVALID', 'billing intent is invalid');
  }
  return deepFreezeFactV1(result.data);
}

function assertBalanceVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BillingCoreError(
      'BILLING_FACT_INVALID',
      'balance version must be a non-negative safe integer',
    );
  }
}

function incrementBalanceVersion(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new BillingCoreError(
      'BILLING_BALANCE_VERSION_EXHAUSTED',
      'balance version cannot advance beyond the safe-integer boundary',
    );
  }
  return value + 1;
}

function creditDelta(available: bigint, reserved: bigint, settled: bigint): CreditLedgerDeltaV1 {
  return Object.freeze({
    available_delta_credits: formatSignedCreditDeltaV1(available),
    reserved_delta_credits: formatSignedCreditDeltaV1(reserved),
    settled_delta_credits: formatSignedCreditDeltaV1(settled),
  });
}
