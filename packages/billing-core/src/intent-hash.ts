import type { BillingIntentV1 } from '@better-agent/domain-contracts';
import { BillingIntentV1Schema, Sha256HexV1Schema } from '@better-agent/domain-contracts';
import { canonicalSha256, type CanonicalSha256V1 } from '@better-agent/release-core';

import { BillingCoreError } from './errors.js';
import { deepFreezeFactV1 } from './freeze.js';

export type BillingIntentHashRoleV1 = 'PROPOSED' | 'PERSISTED' | 'LEDGER';

export function prepareBillingIntentHashV1(intentInput: BillingIntentV1): CanonicalSha256V1 {
  return canonicalSha256(parseBillingIntentForHashV1(intentInput));
}

export function assertBillingIntentHashV1(input: {
  readonly intent: BillingIntentV1;
  readonly billing_intent_hash: string;
  readonly hash_role: BillingIntentHashRoleV1;
}): BillingIntentV1 {
  const intent = parseBillingIntentForHashV1(input.intent);
  const expectedHash = canonicalSha256(intent);
  if (
    !Sha256HexV1Schema.safeParse(input.billing_intent_hash).success ||
    input.billing_intent_hash !== expectedHash
  ) {
    throw new BillingCoreError(
      'BILLING_FACT_INVALID',
      'billing intent hash does not match the canonical billing intent',
      {
        charge_key: intent.charge_key,
        intent_kind: intent.intent_kind,
        hash_role: input.hash_role,
      },
    );
  }
  return intent;
}

function parseBillingIntentForHashV1(intent: BillingIntentV1): BillingIntentV1 {
  const result = BillingIntentV1Schema.safeParse(intent);
  if (!result.success) {
    throw new BillingCoreError('BILLING_FACT_INVALID', 'billing intent is invalid');
  }
  return deepFreezeFactV1(result.data);
}
