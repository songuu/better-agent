import type {
  BillingAuthoritySourceV2,
  BillingIntentV2,
  CreditLedgerEntryV2,
  JsonObject,
  SignedCreditDeltaV1,
} from '@better-agent/domain-contracts';
import { BillingIntentV2Schema, CreditLedgerEntryV2Schema } from '@better-agent/domain-contracts';
import { canonicalJsonBytes } from '@better-agent/release-core';

import { formatSignedCreditDeltaV1, parseCreditAmountV1 } from './amount.js';
import { BillingCoreError } from './errors.js';
import { deepFreezeFactV1 } from './freeze.js';
import {
  assertBillingIntentSourceBindingV2,
  type PreparedBillingAuthorityBindingV2,
} from './intent-hash-v2.js';

export interface CreditLedgerDeltaV2 {
  readonly available_delta_credits: SignedCreditDeltaV1;
  readonly reserved_delta_credits: SignedCreditDeltaV1;
  readonly settled_delta_credits: SignedCreditDeltaV1;
}

export type CreditLedgerReplayOutcomeV2 = 'REPLAY';

export function prepareLedgerDeltaV2(intent: BillingIntentV2): CreditLedgerDeltaV2 {
  const parsed = BillingIntentV2Schema.safeParse(intent);
  if (!parsed.success) {
    throw new BillingCoreError('BILLING_FACT_INVALID', 'billing v2 intent is invalid');
  }
  const amount = parseCreditAmountV1(parsed.data.amount_credits);
  return parsed.data.intent_kind === 'SETTLE'
    ? creditDeltaV2(0n, -amount, amount)
    : creditDeltaV2(amount, -amount, 0n);
}

export function prepareCreditLedgerEntryV2(input: {
  readonly source: BillingAuthoritySourceV2;
  readonly intent: BillingIntentV2;
  readonly billing_intent_hash: string;
  readonly ledger_entry_id: string;
  readonly authority_receipt_id: string;
  readonly current_balance_version: number;
  readonly metering_detail_redacted: JsonObject;
  readonly created_at: string;
}): { readonly ledger_entry: CreditLedgerEntryV2; readonly next_balance_version: number } {
  const binding = assertBillingIntentSourceBindingV2({
    source: input.source,
    intent: input.intent,
    billing_intent_hash: input.billing_intent_hash,
  });
  assertBalanceVersionV2(input.current_balance_version);
  const delta = prepareLedgerDeltaV2(binding.intent);
  const movesFunds = Object.values(delta).some((value) => value !== '0');
  const nextBalanceVersion = movesFunds
    ? incrementBalanceVersionV2(input.current_balance_version)
    : input.current_balance_version;
  const authority = prepareLedgerAuthorityV2(binding, input.authority_receipt_id);
  const producer =
    binding.intent.authority.authority_kind === 'CANCELLATION_RELEASE'
      ? { producer_run_id: binding.intent.billing_owner_run_id }
      : {
          producer_run_id: binding.intent.authority.producer_run_id,
          producer_attempt_id: binding.intent.authority.producer_attempt_id,
          producer_lease_fencing_token: binding.intent.authority.producer_lease_fencing_token,
          step_id: binding.intent.authority.step_id,
        };
  const candidate = {
    schema_version: 'credit-ledger-entry/2',
    ledger_entry_id: input.ledger_entry_id,
    workspace_id: binding.intent.workspace_id,
    run_id: binding.intent.billing_owner_run_id,
    billing_owner_run_id: binding.intent.billing_owner_run_id,
    ...producer,
    reservation_id: binding.intent.reservation_id,
    entry_kind: binding.intent.intent_kind,
    ...delta,
    billing_intent_hash: input.billing_intent_hash,
    charge_attribution_hash: binding.source_authority_hash,
    charge_key: binding.charge_key,
    balance_version: nextBalanceVersion,
    metering_detail_redacted: input.metering_detail_redacted,
    authority,
    created_at: input.created_at,
  };
  const result = CreditLedgerEntryV2Schema.safeParse(candidate);
  if (!result.success) {
    throw new BillingCoreError(
      'BILLING_FACT_INVALID',
      'prepared billing v2 ledger entry is invalid',
    );
  }
  return deepFreezeFactV1({
    ledger_entry: result.data,
    next_balance_version: nextBalanceVersion,
  });
}

export function assertCreditLedgerEntryMatchesIntentV2(input: {
  readonly source: BillingAuthoritySourceV2;
  readonly intent: BillingIntentV2;
  readonly billing_intent_hash: string;
  readonly ledger_entry: CreditLedgerEntryV2;
}): CreditLedgerEntryV2 {
  const binding = assertBillingIntentSourceBindingV2({
    source: input.source,
    intent: input.intent,
    billing_intent_hash: input.billing_intent_hash,
  });
  const parsed = CreditLedgerEntryV2Schema.safeParse(input.ledger_entry);
  if (!parsed.success) {
    throw new BillingCoreError(
      'BILLING_LEDGER_MISMATCH',
      'persisted billing v2 ledger entry does not satisfy its closed contract',
    );
  }
  const entry = parsed.data;
  const expectedDelta = prepareLedgerDeltaV2(binding.intent);
  const expectedAuthority = prepareLedgerAuthorityV2(binding, entry.authority.authority_receipt_id);
  const expectedProducer =
    binding.intent.authority.authority_kind === 'CANCELLATION_RELEASE'
      ? {
          producer_run_id: binding.intent.billing_owner_run_id,
          producer_attempt_id: undefined,
          producer_lease_fencing_token: undefined,
          step_id: undefined,
        }
      : {
          producer_run_id: binding.intent.authority.producer_run_id,
          producer_attempt_id: binding.intent.authority.producer_attempt_id,
          producer_lease_fencing_token: binding.intent.authority.producer_lease_fencing_token,
          step_id: binding.intent.authority.step_id,
        };

  if (
    entry.workspace_id !== binding.intent.workspace_id ||
    entry.run_id !== binding.intent.billing_owner_run_id ||
    entry.billing_owner_run_id !== binding.intent.billing_owner_run_id ||
    entry.reservation_id !== binding.intent.reservation_id ||
    entry.entry_kind !== binding.intent.intent_kind ||
    entry.billing_intent_hash !== input.billing_intent_hash ||
    entry.charge_attribution_hash !== binding.source_authority_hash ||
    entry.charge_key !== binding.charge_key ||
    entry.producer_run_id !== expectedProducer.producer_run_id ||
    entry.producer_attempt_id !== expectedProducer.producer_attempt_id ||
    entry.producer_lease_fencing_token !== expectedProducer.producer_lease_fencing_token ||
    entry.step_id !== expectedProducer.step_id ||
    entry.available_delta_credits !== expectedDelta.available_delta_credits ||
    entry.reserved_delta_credits !== expectedDelta.reserved_delta_credits ||
    entry.settled_delta_credits !== expectedDelta.settled_delta_credits ||
    !canonicalJsonBytes(entry.authority).equals(canonicalJsonBytes(expectedAuthority))
  ) {
    throw new BillingCoreError(
      'BILLING_LEDGER_MISMATCH',
      'persisted billing v2 ledger entry does not match its authority and intent',
      {
        authority_kind: binding.authority_kind,
        charge_key: binding.charge_key,
      },
    );
  }
  return deepFreezeFactV1(entry);
}

export function classifyCreditLedgerReplayV2(input: {
  readonly existing_ledger_entry: CreditLedgerEntryV2;
  readonly proposed_source: BillingAuthoritySourceV2;
  readonly proposed_intent: BillingIntentV2;
  readonly proposed_billing_intent_hash: string;
}): CreditLedgerReplayOutcomeV2 {
  const binding = assertBillingIntentSourceBindingV2({
    source: input.proposed_source,
    intent: input.proposed_intent,
    billing_intent_hash: input.proposed_billing_intent_hash,
  });
  const parsed = CreditLedgerEntryV2Schema.safeParse(input.existing_ledger_entry);
  if (!parsed.success) {
    throw new BillingCoreError(
      'BILLING_FACT_INVALID',
      'persisted billing v2 replay lookup returned an invalid ledger entry',
    );
  }
  if (parsed.data.charge_key !== binding.charge_key) {
    throw new BillingCoreError(
      'BILLING_FACT_INVALID',
      'persisted billing v2 replay lookup returned a different charge key',
      {
        existing_charge_key: parsed.data.charge_key,
        proposed_charge_key: binding.charge_key,
      },
    );
  }
  try {
    assertCreditLedgerEntryMatchesIntentV2({
      source: input.proposed_source,
      intent: binding.intent,
      billing_intent_hash: binding.billing_intent_hash,
      ledger_entry: parsed.data,
    });
  } catch (error) {
    if (error instanceof BillingCoreError) {
      throw new BillingCoreError(
        'BILLING_INTENT_CONFLICT',
        'the charge key is already bound to a different v2 authority or financial intent',
        { authority_kind: binding.authority_kind, charge_key: binding.charge_key },
      );
    }
    throw error;
  }
  return 'REPLAY';
}

function prepareLedgerAuthorityV2(
  binding: PreparedBillingAuthorityBindingV2,
  authorityReceiptId: string,
): CreditLedgerEntryV2['authority'] {
  return {
    ...binding.intent.authority,
    schema_version: 'billing-authority-receipt-reference/1',
    authority_receipt_id: authorityReceiptId,
  } as CreditLedgerEntryV2['authority'];
}

function creditDeltaV2(available: bigint, reserved: bigint, settled: bigint): CreditLedgerDeltaV2 {
  return Object.freeze({
    available_delta_credits: formatSignedCreditDeltaV1(available),
    reserved_delta_credits: formatSignedCreditDeltaV1(reserved),
    settled_delta_credits: formatSignedCreditDeltaV1(settled),
  });
}

function assertBalanceVersionV2(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BillingCoreError(
      'BILLING_FACT_INVALID',
      'balance version must be a non-negative safe integer',
    );
  }
}

function incrementBalanceVersionV2(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new BillingCoreError(
      'BILLING_BALANCE_VERSION_EXHAUSTED',
      'balance version cannot advance beyond the safe-integer boundary',
    );
  }
  return value + 1;
}
