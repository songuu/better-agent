import { z } from 'zod';

import { UuidV1Schema } from './auth-v1.js';
import { CreditAmountV1Schema, SignedCreditDeltaV1Schema } from './billing-v1.js';
import {
  addCustomIssue,
  boundedNonBlankStringSchema,
  JsonObjectSchema,
  PostgresInstantV1Schema,
  Sha256HexV1Schema,
} from './primitives.js';
import {
  RunLeaseFencingTokenV1Schema,
  RunPositiveSequenceV1Schema,
  RunTerminationIntentV1Schema,
  RunUsageAttributionV1Schema,
} from './run-execution-v1.js';

const InstantV1Schema = PostgresInstantV1Schema;
const CanonicalSignedCreditDeltaPattern = /^(?:0|-?[1-9][0-9]*)$/u;
const BalanceVersionV2Schema = z.number().int().nonnegative().safe();
const OperationKeyV2Schema = boundedNonBlankStringSchema(300, 'billing operation key');
const ReasonCodeV2Schema = boundedNonBlankStringSchema(200, 'billing reason code');

export const RunCancellationReleaseAuthorityV1Schema = z
  .strictObject({
    schema_version: z.literal('run-cancellation-release-authority/1'),
    workspace_id: UuidV1Schema,
    run_id: UuidV1Schema,
    billing_owner_run_id: UuidV1Schema,
    reservation_id: UuidV1Schema,
    cancel_event_id: UuidV1Schema,
    cancel_event_sequence: RunPositiveSequenceV1Schema,
    cancel_intent_sha256: Sha256HexV1Schema,
    terminal_intent_sha256: Sha256HexV1Schema,
    effect_closure_sha256: Sha256HexV1Schema,
    remaining_credits: CreditAmountV1Schema,
    release_operation_key: OperationKeyV2Schema,
    release_reason_code: ReasonCodeV2Schema,
    authorized_at: InstantV1Schema,
  })
  .superRefine((authority, ctx) => {
    if (authority.run_id !== authority.billing_owner_run_id) {
      addCustomIssue(
        ctx,
        ['billing_owner_run_id'],
        'durable cancellation release must belong directly to its billing-owner Run',
      );
    }
  });

export const BillingAuthoritySourceV2Schema = z.union([
  RunUsageAttributionV1Schema,
  RunTerminationIntentV1Schema,
  RunCancellationReleaseAuthorityV1Schema,
]);

export const BillingAuthorityKindV2Schema = z.enum([
  'USAGE_ATTRIBUTION',
  'TERMINATION_ATTRIBUTION',
  'CANCELLATION_RELEASE',
]);

const UsageBillingIntentAuthorityV2Schema = z.strictObject({
  schema_version: z.literal('billing-authority-reference/1'),
  authority_kind: z.literal('USAGE_ATTRIBUTION'),
  source_schema_version: z.literal('run-usage-attribution/1'),
  source_id: UuidV1Schema,
  source_authority_hash: Sha256HexV1Schema,
  producer_run_id: UuidV1Schema,
  producer_attempt_id: UuidV1Schema,
  producer_lease_fencing_token: RunLeaseFencingTokenV1Schema,
  step_id: UuidV1Schema,
});

const TerminationBillingIntentAuthorityV2Schema = z.strictObject({
  schema_version: z.literal('billing-authority-reference/1'),
  authority_kind: z.literal('TERMINATION_ATTRIBUTION'),
  source_schema_version: z.literal('run-termination-intent/1'),
  source_id: UuidV1Schema,
  source_authority_hash: Sha256HexV1Schema,
  producer_run_id: UuidV1Schema,
  producer_attempt_id: UuidV1Schema,
  producer_lease_fencing_token: RunLeaseFencingTokenV1Schema,
  step_id: UuidV1Schema,
});

const CancellationBillingIntentAuthorityV2Schema = z.strictObject({
  schema_version: z.literal('billing-authority-reference/1'),
  authority_kind: z.literal('CANCELLATION_RELEASE'),
  source_schema_version: z.literal('run-cancellation-release-authority/1'),
  source_id: UuidV1Schema,
  source_authority_hash: Sha256HexV1Schema,
});

export const BillingIntentAuthorityV2Schema = z.union([
  UsageBillingIntentAuthorityV2Schema,
  TerminationBillingIntentAuthorityV2Schema,
  CancellationBillingIntentAuthorityV2Schema,
]);

const billingIntentV2BaseShape = {
  schema_version: z.literal('billing-intent/2'),
  workspace_id: UuidV1Schema,
  billing_owner_run_id: UuidV1Schema,
  reservation_id: UuidV1Schema,
  amount_credits: CreditAmountV1Schema,
  charge_key: OperationKeyV2Schema,
  charge_attribution_hash: Sha256HexV1Schema,
};

function addIntentAttributionHashIssue(
  intent: { charge_attribution_hash: string; authority: { source_authority_hash: string } },
  ctx: z.RefinementCtx,
): void {
  if (intent.charge_attribution_hash !== intent.authority.source_authority_hash) {
    addCustomIssue(
      ctx,
      ['charge_attribution_hash'],
      'charge attribution must equal the immutable source authority hash',
    );
  }
}

const UsageSettlementBillingIntentV2Schema = z
  .strictObject({
    ...billingIntentV2BaseShape,
    intent_kind: z.literal('SETTLE'),
    authority: UsageBillingIntentAuthorityV2Schema,
  })
  .superRefine(addIntentAttributionHashIssue);

const TerminationReleaseBillingIntentV2Schema = z
  .strictObject({
    ...billingIntentV2BaseShape,
    intent_kind: z.literal('RELEASE'),
    authority: TerminationBillingIntentAuthorityV2Schema,
  })
  .superRefine(addIntentAttributionHashIssue);

const CancellationReleaseBillingIntentV2Schema = z
  .strictObject({
    ...billingIntentV2BaseShape,
    intent_kind: z.literal('RELEASE'),
    authority: CancellationBillingIntentAuthorityV2Schema,
  })
  .superRefine(addIntentAttributionHashIssue);

export const BillingIntentV2Schema = z.union([
  UsageSettlementBillingIntentV2Schema,
  TerminationReleaseBillingIntentV2Schema,
  CancellationReleaseBillingIntentV2Schema,
]);

const ledgerAuthorityReceiptBaseShape = {
  schema_version: z.literal('billing-authority-receipt-reference/1'),
  authority_receipt_id: UuidV1Schema,
  source_id: UuidV1Schema,
  source_authority_hash: Sha256HexV1Schema,
};

const UsageLedgerAuthorityV2Schema = z.strictObject({
  ...ledgerAuthorityReceiptBaseShape,
  authority_kind: z.literal('USAGE_ATTRIBUTION'),
  source_schema_version: z.literal('run-usage-attribution/1'),
  producer_run_id: UuidV1Schema,
  producer_attempt_id: UuidV1Schema,
  producer_lease_fencing_token: RunLeaseFencingTokenV1Schema,
  step_id: UuidV1Schema,
});

const TerminationLedgerAuthorityV2Schema = z.strictObject({
  ...ledgerAuthorityReceiptBaseShape,
  authority_kind: z.literal('TERMINATION_ATTRIBUTION'),
  source_schema_version: z.literal('run-termination-intent/1'),
  producer_run_id: UuidV1Schema,
  producer_attempt_id: UuidV1Schema,
  producer_lease_fencing_token: RunLeaseFencingTokenV1Schema,
  step_id: UuidV1Schema,
});

const CancellationLedgerAuthorityV2Schema = z.strictObject({
  ...ledgerAuthorityReceiptBaseShape,
  authority_kind: z.literal('CANCELLATION_RELEASE'),
  source_schema_version: z.literal('run-cancellation-release-authority/1'),
});

export const CreditLedgerAuthorityV2Schema = z.union([
  UsageLedgerAuthorityV2Schema,
  TerminationLedgerAuthorityV2Schema,
  CancellationLedgerAuthorityV2Schema,
]);

const creditLedgerEntryV2BaseShape = {
  schema_version: z.literal('credit-ledger-entry/2'),
  ledger_entry_id: UuidV1Schema,
  workspace_id: UuidV1Schema,
  run_id: UuidV1Schema,
  billing_owner_run_id: UuidV1Schema,
  producer_run_id: UuidV1Schema,
  producer_attempt_id: UuidV1Schema.optional(),
  producer_lease_fencing_token: RunLeaseFencingTokenV1Schema.optional(),
  step_id: UuidV1Schema.optional(),
  reservation_id: UuidV1Schema,
  available_delta_credits: SignedCreditDeltaV1Schema,
  reserved_delta_credits: SignedCreditDeltaV1Schema,
  settled_delta_credits: SignedCreditDeltaV1Schema,
  billing_intent_hash: Sha256HexV1Schema,
  charge_attribution_hash: Sha256HexV1Schema,
  charge_key: OperationKeyV2Schema,
  balance_version: BalanceVersionV2Schema,
  metering_detail_redacted: JsonObjectSchema,
  created_at: InstantV1Schema,
};

function addLedgerCommonIssues(
  entry: {
    run_id: string;
    billing_owner_run_id: string;
    charge_attribution_hash: string;
    authority: { source_authority_hash: string };
    entry_kind: 'SETTLE' | 'RELEASE';
    available_delta_credits: string;
    reserved_delta_credits: string;
    settled_delta_credits: string;
  },
  ctx: z.RefinementCtx,
): void {
  if (entry.run_id !== entry.billing_owner_run_id) {
    addCustomIssue(ctx, ['run_id'], 'ledger Run must be the billing-owner Run');
  }
  if (entry.charge_attribution_hash !== entry.authority.source_authority_hash) {
    addCustomIssue(
      ctx,
      ['charge_attribution_hash'],
      'ledger source authority hash is inconsistent',
    );
  }
  if (
    !CanonicalSignedCreditDeltaPattern.test(entry.available_delta_credits) ||
    !CanonicalSignedCreditDeltaPattern.test(entry.reserved_delta_credits) ||
    !CanonicalSignedCreditDeltaPattern.test(entry.settled_delta_credits)
  ) {
    return;
  }
  const available = BigInt(entry.available_delta_credits);
  const reserved = BigInt(entry.reserved_delta_credits);
  const settled = BigInt(entry.settled_delta_credits);
  const valid =
    entry.entry_kind === 'SETTLE'
      ? available === 0n && reserved <= 0n && settled >= 0n && settled === -reserved
      : available >= 0n && reserved <= 0n && settled === 0n && available === -reserved;
  if (!valid) {
    addCustomIssue(
      ctx,
      ['available_delta_credits'],
      'ledger entry has an invalid credit delta triangle',
    );
  }
}

function addHistoricalLedgerProducerIssues(
  entry: {
    producer_run_id: string;
    producer_attempt_id?: string;
    producer_lease_fencing_token?: string;
    step_id?: string;
    authority: {
      producer_run_id: string;
      producer_attempt_id: string;
      producer_lease_fencing_token: string;
      step_id: string;
    };
  },
  ctx: z.RefinementCtx,
): void {
  if (
    entry.producer_run_id !== entry.authority.producer_run_id ||
    entry.producer_attempt_id !== entry.authority.producer_attempt_id ||
    entry.producer_lease_fencing_token !== entry.authority.producer_lease_fencing_token ||
    entry.step_id !== entry.authority.step_id
  ) {
    addCustomIssue(
      ctx,
      ['producer_run_id'],
      'ledger producer tuple must match its authority receipt',
    );
  }
}

const UsageSettlementLedgerEntryV2Schema = z
  .strictObject({
    ...creditLedgerEntryV2BaseShape,
    entry_kind: z.literal('SETTLE'),
    producer_attempt_id: UuidV1Schema,
    producer_lease_fencing_token: RunLeaseFencingTokenV1Schema,
    step_id: UuidV1Schema,
    authority: UsageLedgerAuthorityV2Schema,
  })
  .superRefine((entry, ctx) => {
    addLedgerCommonIssues(entry, ctx);
    addHistoricalLedgerProducerIssues(entry, ctx);
  });

const TerminationReleaseLedgerEntryV2Schema = z
  .strictObject({
    ...creditLedgerEntryV2BaseShape,
    entry_kind: z.literal('RELEASE'),
    producer_attempt_id: UuidV1Schema,
    producer_lease_fencing_token: RunLeaseFencingTokenV1Schema,
    step_id: UuidV1Schema,
    authority: TerminationLedgerAuthorityV2Schema,
  })
  .superRefine((entry, ctx) => {
    addLedgerCommonIssues(entry, ctx);
    addHistoricalLedgerProducerIssues(entry, ctx);
  });

const CancellationReleaseLedgerEntryV2Schema = z
  .strictObject({
    ...creditLedgerEntryV2BaseShape,
    entry_kind: z.literal('RELEASE'),
    authority: CancellationLedgerAuthorityV2Schema,
  })
  .superRefine((entry, ctx) => {
    addLedgerCommonIssues(entry, ctx);
    if (
      entry.producer_run_id !== entry.billing_owner_run_id ||
      entry.producer_attempt_id !== undefined ||
      entry.producer_lease_fencing_token !== undefined ||
      entry.step_id !== undefined
    ) {
      addCustomIssue(
        ctx,
        ['producer_run_id'],
        'cancellation release is attributed directly to the billing-owner Run',
      );
    }
  });

export const CreditLedgerEntryV2Schema = z.union([
  UsageSettlementLedgerEntryV2Schema,
  TerminationReleaseLedgerEntryV2Schema,
  CancellationReleaseLedgerEntryV2Schema,
]);

export type RunCancellationReleaseAuthorityV1 = z.infer<
  typeof RunCancellationReleaseAuthorityV1Schema
>;
export type BillingAuthoritySourceV2 = z.infer<typeof BillingAuthoritySourceV2Schema>;
export type BillingAuthorityKindV2 = z.infer<typeof BillingAuthorityKindV2Schema>;
export type BillingIntentAuthorityV2 = z.infer<typeof BillingIntentAuthorityV2Schema>;
export type BillingIntentV2 = z.infer<typeof BillingIntentV2Schema>;
export type CreditLedgerAuthorityV2 = z.infer<typeof CreditLedgerAuthorityV2Schema>;
export type CreditLedgerEntryV2 = z.infer<typeof CreditLedgerEntryV2Schema>;
