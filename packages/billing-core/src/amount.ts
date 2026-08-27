import type { CreditAmountV1, SignedCreditDeltaV1 } from '@better-agent/domain-contracts';
import { CreditAmountV1Schema, SignedCreditDeltaV1Schema } from '@better-agent/domain-contracts';

import { BillingCoreError } from './errors.js';

export function parseCreditAmountV1(value: string): bigint {
  const result = CreditAmountV1Schema.safeParse(value);
  if (!result.success) {
    throw new BillingCoreError(
      'BILLING_AMOUNT_INVALID',
      'credit amount must be a canonical non-negative decimal string',
    );
  }
  return BigInt(result.data);
}

export function formatCreditAmountV1(value: bigint): CreditAmountV1 {
  if (value < 0n) {
    throw new BillingCoreError(
      'BILLING_AMOUNT_INVALID',
      'a non-negative credit amount cannot represent a negative bigint',
    );
  }
  const result = CreditAmountV1Schema.safeParse(value.toString());
  if (!result.success) {
    throw new BillingCoreError(
      'BILLING_AMOUNT_INVALID',
      'credit amount exceeds the supported PostgreSQL bigint boundary',
    );
  }
  return result.data;
}

export function parseSignedCreditDeltaV1(value: string): bigint {
  const result = SignedCreditDeltaV1Schema.safeParse(value);
  if (!result.success) {
    throw new BillingCoreError(
      'BILLING_AMOUNT_INVALID',
      'credit delta must be a canonical signed decimal string',
    );
  }
  return BigInt(result.data);
}

export function formatSignedCreditDeltaV1(value: bigint): SignedCreditDeltaV1 {
  const result = SignedCreditDeltaV1Schema.safeParse(value.toString());
  if (!result.success) {
    throw new BillingCoreError(
      'BILLING_AMOUNT_INVALID',
      'credit delta exceeds the supported PostgreSQL bigint boundary',
    );
  }
  return result.data;
}
