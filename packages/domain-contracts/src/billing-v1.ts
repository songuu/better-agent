import { z } from 'zod';

import { UuidV1Schema } from './auth-v1.js';
import {
  addCustomIssue,
  JsonObjectSchema,
  NonEmptyStringSchema,
  Sha256HexV1Schema,
} from './primitives.js';

const PostgreSqlBigintMaxV1 = 9_223_372_036_854_775_807n;
const PostgreSqlBigintMinV1 = -9_223_372_036_854_775_808n;

export const CreditAmountV1Schema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/u, 'expected a canonical non-negative credit decimal string')
  .refine(
    (value) => /^(?:0|[1-9][0-9]*)$/u.test(value) && BigInt(value) <= PostgreSqlBigintMaxV1,
    'credit amount exceeds the PostgreSQL bigint boundary',
  );

export const SignedCreditDeltaV1Schema = z
  .string()
  .regex(
    /^(?:0|-?[1-9][0-9]*)$/u,
    'expected a canonical signed credit decimal string without plus signs or negative zero',
  )
  .refine((value) => {
    if (!/^(?:0|-?[1-9][0-9]*)$/u.test(value)) return false;
    const parsed = BigInt(value);
    return parsed >= PostgreSqlBigintMinV1 && parsed <= PostgreSqlBigintMaxV1;
  }, 'credit delta exceeds the PostgreSQL bigint boundary');

const BalanceVersionV1Schema = z.number().int().nonnegative().safe();
const LeaseFencingTokenV1Schema = z.number().int().positive().safe();
const DurableEvidenceRefV1Schema = NonEmptyStringSchema.max(2_048).refine(
  (value) => !value.includes('?') && !value.includes('#'),
  'durable evidence refs must not contain query parameters or fragments',
);

export const CreditReservationStatusV1Schema = z.enum(['HELD', 'SETTLED', 'RELEASED', 'EXPIRED']);

export const CreditReservationV1Schema = z
  .strictObject({
    schema_version: z.literal('credit-reservation/1'),
    reservation_id: UuidV1Schema,
    workspace_id: UuidV1Schema,
    run_id: UuidV1Schema,
    accepted_plan_hash: Sha256HexV1Schema,
    status: CreditReservationStatusV1Schema,
    reserved_credits: CreditAmountV1Schema,
    settled_credits: CreditAmountV1Schema,
    released_credits: CreditAmountV1Schema,
    balance_version: BalanceVersionV1Schema,
    expires_at: z.iso.datetime({ offset: true }),
    status_reason_code: NonEmptyStringSchema.max(200).optional(),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
    settled_at: z.iso.datetime({ offset: true }).optional(),
    released_at: z.iso.datetime({ offset: true }).optional(),
  })
  .superRefine((reservation, ctx) => {
    const reserved = BigInt(reservation.reserved_credits);
    const settled = BigInt(reservation.settled_credits);
    const released = BigInt(reservation.released_credits);
    const accounted = settled + released;
    const createdAt = Date.parse(reservation.created_at);
    const updatedAt = Date.parse(reservation.updated_at);

    if (Date.parse(reservation.expires_at) <= createdAt) {
      addCustomIssue(ctx, ['expires_at'], 'reservation expiry must be later than creation');
    }
    if (updatedAt < createdAt) {
      addCustomIssue(ctx, ['updated_at'], 'reservation update cannot precede creation');
    }
    for (const [field, value] of [
      ['settled_at', reservation.settled_at],
      ['released_at', reservation.released_at],
    ] as const) {
      if (value !== undefined) {
        const timestamp = Date.parse(value);
        if (timestamp < createdAt || timestamp > updatedAt) {
          addCustomIssue(
            ctx,
            [field],
            'reservation terminal timestamp must be within its audit interval',
          );
        }
      }
    }

    if (accounted > reserved) {
      addCustomIssue(
        ctx,
        ['settled_credits'],
        'settled and released credits cannot exceed the reservation',
      );
    }

    if (reservation.status === 'HELD') {
      if (reservation.settled_at !== undefined || reservation.released_at !== undefined) {
        addCustomIssue(ctx, ['status'], 'HELD reservation cannot carry terminal timestamps');
      }
      if (reserved > 0n && accounted >= reserved) {
        addCustomIssue(
          ctx,
          ['status'],
          'positive HELD reservation must retain unaccounted reserved credits',
        );
      }
      return;
    }

    if (accounted !== reserved) {
      addCustomIssue(ctx, ['status'], 'terminal reservation must account for the full reserve');
    }

    if (reservation.status === 'SETTLED') {
      if (reservation.settled_at === undefined) {
        addCustomIssue(ctx, ['settled_at'], 'SETTLED reservation requires settled_at');
      }
      if (reserved > 0n && settled === 0n) {
        addCustomIssue(
          ctx,
          ['settled_credits'],
          'positive SETTLED reservation requires settled credits',
        );
      }
      if (released > 0n && reservation.released_at === undefined) {
        addCustomIssue(
          ctx,
          ['released_at'],
          'SETTLED reservation with released credits requires released_at',
        );
      }
      return;
    }

    if (settled !== 0n || released !== reserved) {
      addCustomIssue(
        ctx,
        ['status'],
        'RELEASED and EXPIRED reservations must release the entire unconsumed reserve',
      );
    }
    if (reservation.settled_at !== undefined) {
      addCustomIssue(
        ctx,
        ['settled_at'],
        'RELEASED and EXPIRED reservations cannot carry settled_at',
      );
    }
    if (reservation.released_at === undefined) {
      addCustomIssue(ctx, ['released_at'], 'RELEASED and EXPIRED reservations require released_at');
    }
  });

export const CreditLedgerEntryKindsV1 = [
  'RESERVE',
  'SETTLE',
  'RELEASE',
  'EXPIRED',
  'RECONCILIATION',
] as const;

export const CreditLedgerEntryKindV1Schema = z.enum(CreditLedgerEntryKindsV1);

function addLedgerDeltaIssues(
  entry: {
    entry_kind: (typeof CreditLedgerEntryKindsV1)[number];
    available_delta_credits: string;
    reserved_delta_credits: string;
    settled_delta_credits: string;
  },
  ctx: z.RefinementCtx,
): void {
  const available = BigInt(entry.available_delta_credits);
  const reserved = BigInt(entry.reserved_delta_credits);
  const settled = BigInt(entry.settled_delta_credits);

  let valid = false;
  switch (entry.entry_kind) {
    case 'RESERVE':
      valid = available <= 0n && reserved >= 0n && settled === 0n && available === -reserved;
      break;
    case 'SETTLE':
      valid = available === 0n && reserved <= 0n && settled >= 0n && settled === -reserved;
      break;
    case 'RELEASE':
    case 'EXPIRED':
      valid = available >= 0n && reserved <= 0n && settled === 0n && available === -reserved;
      break;
    case 'RECONCILIATION':
      valid =
        available >= 0n && reserved <= 0n && settled >= 0n && available + settled === -reserved;
      break;
  }

  if (!valid) {
    addCustomIssue(
      ctx,
      ['available_delta_credits'],
      `${entry.entry_kind} ledger entry has an invalid credit delta triangle`,
    );
  }
}

export const CreditLedgerEntryV1Schema = z
  .strictObject({
    schema_version: z.literal('credit-ledger-entry/1'),
    ledger_entry_id: UuidV1Schema,
    workspace_id: UuidV1Schema,
    run_id: UuidV1Schema,
    producer_run_id: UuidV1Schema,
    producer_attempt_id: UuidV1Schema.optional(),
    producer_lease_fencing_token: LeaseFencingTokenV1Schema.optional(),
    step_id: UuidV1Schema.optional(),
    reservation_id: UuidV1Schema,
    entry_kind: CreditLedgerEntryKindV1Schema,
    available_delta_credits: SignedCreditDeltaV1Schema,
    reserved_delta_credits: SignedCreditDeltaV1Schema,
    settled_delta_credits: SignedCreditDeltaV1Schema,
    billing_intent_hash: Sha256HexV1Schema,
    charge_attribution_hash: Sha256HexV1Schema,
    charge_key: NonEmptyStringSchema.max(300),
    balance_version: BalanceVersionV1Schema,
    metering_detail_redacted: JsonObjectSchema,
    created_at: z.iso.datetime({ offset: true }),
  })
  .superRefine((entry, ctx) => {
    addLedgerDeltaIssues(entry, ctx);

    if (entry.step_id !== undefined && entry.producer_attempt_id === undefined) {
      addCustomIssue(ctx, ['step_id'], 'metered Step requires a producer Attempt');
    }

    const isLeasedExecution = entry.entry_kind === 'SETTLE' || entry.entry_kind === 'RELEASE';
    if (isLeasedExecution) {
      if (
        entry.producer_attempt_id === undefined ||
        entry.producer_lease_fencing_token === undefined
      ) {
        addCustomIssue(
          ctx,
          ['producer_attempt_id'],
          `${entry.entry_kind} requires producer Attempt and fencing facts`,
        );
      }
      return;
    }

    if (
      entry.producer_run_id !== entry.run_id ||
      entry.producer_attempt_id !== undefined ||
      entry.producer_lease_fencing_token !== undefined ||
      entry.step_id !== undefined
    ) {
      addCustomIssue(
        ctx,
        ['producer_run_id'],
        `${entry.entry_kind} must be attributed directly to the billing-owner Run`,
      );
    }
  });

export const RunBillingStatesV1 = ['PENDING', 'SETTLED', 'NEEDS_ATTENTION'] as const;
export const RunBillingStateValueV1Schema = z.enum(RunBillingStatesV1);

export const RunBillingStateV1Schema = z
  .strictObject({
    schema_version: z.literal('run-billing-state/1'),
    workspace_id: UuidV1Schema,
    run_id: UuidV1Schema,
    billing_state: RunBillingStateValueV1Schema,
    billing_settled_at: z.iso.datetime({ offset: true }).nullable(),
  })
  .superRefine((billing, ctx) => {
    if (billing.billing_state === 'SETTLED' && billing.billing_settled_at === null) {
      addCustomIssue(ctx, ['billing_settled_at'], 'SETTLED billing requires billing_settled_at');
    }
    if (billing.billing_state !== 'SETTLED' && billing.billing_settled_at !== null) {
      addCustomIssue(
        ctx,
        ['billing_settled_at'],
        'only SETTLED billing may carry billing_settled_at',
      );
    }
  });

const billingIntentBaseShape = {
  schema_version: z.literal('billing-intent/1'),
  workspace_id: UuidV1Schema,
  billing_owner_run_id: UuidV1Schema,
  reservation_id: UuidV1Schema,
  charge_key: NonEmptyStringSchema.max(300),
};

const ReserveBillingIntentV1Schema = z.strictObject({
  ...billingIntentBaseShape,
  intent_kind: z.literal('RESERVE'),
  amount_credits: CreditAmountV1Schema,
  accepted_plan_hash: Sha256HexV1Schema,
  expires_at: z.iso.datetime({ offset: true }),
});

const meteredBillingIntentBaseShape = {
  ...billingIntentBaseShape,
  producer_run_id: UuidV1Schema,
  producer_attempt_id: UuidV1Schema,
  producer_lease_fencing_token: LeaseFencingTokenV1Schema,
  step_id: UuidV1Schema.optional(),
  amount_credits: CreditAmountV1Schema,
  charge_attribution_hash: Sha256HexV1Schema,
};

const SettleBillingIntentV1Schema = z.strictObject({
  ...meteredBillingIntentBaseShape,
  intent_kind: z.literal('SETTLE'),
});

const ReleaseBillingIntentV1Schema = z.strictObject({
  ...meteredBillingIntentBaseShape,
  intent_kind: z.literal('RELEASE'),
});

const ExpiredBillingIntentV1Schema = z.strictObject({
  ...billingIntentBaseShape,
  intent_kind: z.literal('EXPIRED'),
  remaining_credits: CreditAmountV1Schema,
  expires_at: z.iso.datetime({ offset: true }),
  charge_attribution_hash: Sha256HexV1Schema,
});

const ReconciliationBillingIntentV1Schema = z
  .strictObject({
    ...billingIntentBaseShape,
    intent_kind: z.literal('RECONCILIATION'),
    reconciliation_id: UuidV1Schema,
    release_credits: CreditAmountV1Schema,
    settle_credits: CreditAmountV1Schema,
    evidence_ref: DurableEvidenceRefV1Schema,
    evidence_sha256: Sha256HexV1Schema,
  })
  .superRefine((intent, ctx) => {
    if (BigInt(intent.release_credits) + BigInt(intent.settle_credits) > PostgreSqlBigintMaxV1) {
      addCustomIssue(
        ctx,
        ['release_credits'],
        'reconciliation total exceeds the PostgreSQL bigint boundary',
      );
    }
  });

export const BillingIntentV1Schema = z.discriminatedUnion('intent_kind', [
  ReserveBillingIntentV1Schema,
  SettleBillingIntentV1Schema,
  ReleaseBillingIntentV1Schema,
  ExpiredBillingIntentV1Schema,
  ReconciliationBillingIntentV1Schema,
]);

export type CreditAmountV1 = z.infer<typeof CreditAmountV1Schema>;
export type SignedCreditDeltaV1 = z.infer<typeof SignedCreditDeltaV1Schema>;
export type CreditReservationStatusV1 = z.infer<typeof CreditReservationStatusV1Schema>;
export type CreditReservationV1 = z.infer<typeof CreditReservationV1Schema>;
export type CreditLedgerEntryKindV1 = z.infer<typeof CreditLedgerEntryKindV1Schema>;
export type CreditLedgerEntryV1 = z.infer<typeof CreditLedgerEntryV1Schema>;
export type RunBillingStateValueV1 = z.infer<typeof RunBillingStateValueV1Schema>;
export type RunBillingStateV1 = z.infer<typeof RunBillingStateV1Schema>;
export type BillingIntentV1 = z.infer<typeof BillingIntentV1Schema>;
