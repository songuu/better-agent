import { createHash } from 'node:crypto';

import type {
  BillingAuthorityKindV2,
  BillingAuthoritySourceV2,
  BillingIntentV2,
} from '@better-agent/domain-contracts';
import {
  BillingAuthoritySourceV2Schema,
  BillingIntentV2Schema,
  Sha256HexV1Schema,
} from '@better-agent/domain-contracts';
import {
  canonicalJsonBytes,
  type CanonicalSha256V1,
  canonicalSha256,
} from '@better-agent/release-core';

import { BillingCoreError } from './errors.js';
import { deepFreezeFactV1 } from './freeze.js';

export const BillingSourceHashDomainsV2 = Object.freeze({
  USAGE_ATTRIBUTION: 'better-agent/execution-usage-source/1',
  TERMINATION_ATTRIBUTION: 'better-agent/execution-termination-source/1',
  CANCELLATION_RELEASE: 'better-agent/run-cancellation-release-source/1',
} as const);

export interface PreparedBillingAuthorityBindingV2 {
  readonly source: BillingAuthoritySourceV2;
  readonly authority_kind: BillingAuthorityKindV2;
  readonly source_authority_hash: CanonicalSha256V1;
  readonly charge_attribution_hash: CanonicalSha256V1;
  readonly charge_key: string;
  readonly intent: BillingIntentV2;
  readonly billing_intent_hash: CanonicalSha256V1;
}

export type BillingIntentHashRoleV2 = 'PROPOSED' | 'PERSISTED' | 'LEDGER';

export function prepareBillingSourceAuthorityHashV2(
  sourceInput: BillingAuthoritySourceV2,
): CanonicalSha256V1 {
  const source = parseBillingAuthoritySourceV2(sourceInput);
  const domain = sourceDescriptorV2(source).hash_domain;
  const digest = createHash('sha256')
    .update(domain, 'utf8')
    .update(Uint8Array.of(0))
    .update(canonicalJsonBytes(prepareBillingSourcePreimageV2(source)))
    .digest('hex');
  return `sha256:${digest}`;
}

export function prepareBillingSourcePreimageV2(
  sourceInput: BillingAuthoritySourceV2,
): Readonly<Record<string, unknown>> {
  const source = parseBillingAuthoritySourceV2(sourceInput);
  switch (source.schema_version) {
    case 'run-usage-attribution/1':
      return deepFreezeFactV1({
        schema_version: source.schema_version,
        workspace_id: source.workspace_id,
        billing_owner_run_id: source.billing_owner_run_id,
        run_id: source.run_id,
        reservation_id: source.reservation_id,
        usage_attribution_id: source.usage_attribution_id,
        attempt_id: source.attempt_id,
        step_id: source.step_id,
        lease_token: source.lease_token,
        lease_fencing_token: source.lease_fencing_token,
        producer_session_user: source.producer_session_user,
        producer_operation_key: source.producer_operation_key,
        metering_unit: source.metering_unit,
        metering_quantity: source.metering_quantity,
        amount_credits: source.amount_credits,
        settlement_operation_key: source.settlement_operation_key,
        operation_intent_sha256: source.operation_intent_sha256,
        lease_expires_at: source.lease_expires_at,
        authorized_at: source.authorized_at,
        execution_effect_payload_sha256: source.execution_effect_payload_sha256,
      });
    case 'run-termination-intent/1':
      return deepFreezeFactV1({
        schema_version: source.schema_version,
        workspace_id: source.workspace_id,
        billing_owner_run_id: source.billing_owner_run_id,
        run_id: source.run_id,
        reservation_id: source.reservation_id,
        termination_intent_id: source.termination_intent_id,
        attempt_id: source.attempt_id,
        step_id: source.step_id,
        lease_token: source.lease_token,
        lease_fencing_token: source.lease_fencing_token,
        producer_session_user: source.producer_session_user,
        producer_operation_key: source.producer_operation_key,
        terminal_status: source.terminal_status,
        termination_reason: source.termination_reason,
        effect_disposition: source.effect_disposition,
        effect_closure_sha256: source.effect_closure_sha256,
        usage_attribution_ids: source.usage_attribution_ids,
        intended_settle_credits: source.intended_settle_credits,
        settlement_operation_key: source.settlement_operation_key,
        intended_release_credits: source.intended_release_credits,
        release_operation_key: source.release_operation_key,
        release_reason_code: source.release_reason_code,
        operation_intent_sha256: source.operation_intent_sha256,
        lease_expires_at: source.lease_expires_at,
        authorized_at: source.authorized_at,
      });
    case 'run-cancellation-release-authority/1':
      return deepFreezeFactV1({
        schema_version: source.schema_version,
        workspace_id: source.workspace_id,
        run_id: source.run_id,
        billing_owner_run_id: source.billing_owner_run_id,
        reservation_id: source.reservation_id,
        cancel_event_id: source.cancel_event_id,
        cancel_event_sequence: source.cancel_event_sequence,
        cancel_intent_sha256: source.cancel_intent_sha256,
        terminal_intent_sha256: source.terminal_intent_sha256,
        effect_closure_sha256: source.effect_closure_sha256,
        remaining_credits: source.remaining_credits,
        release_operation_key: source.release_operation_key,
        release_reason_code: source.release_reason_code,
        authorized_at: source.authorized_at,
      });
  }
}

export function prepareBillingChargeKeyV2(
  sourceInput: BillingAuthoritySourceV2,
  sourceAuthorityHashInput?: string,
): string {
  const source = parseBillingAuthoritySourceV2(sourceInput);
  const descriptor = sourceDescriptorV2(source);
  const sourceAuthorityHash = prepareBillingSourceAuthorityHashV2(source);
  if (sourceAuthorityHashInput !== undefined && sourceAuthorityHashInput !== sourceAuthorityHash) {
    throw new BillingCoreError(
      'BILLING_FACT_INVALID',
      'source authority hash does not match the canonical source layer',
      { authority_kind: descriptor.authority_kind, source_id: descriptor.source_id },
    );
  }
  return `billing-v2/${descriptor.authority_kind.toLowerCase()}/${descriptor.source_id}/${sourceAuthorityHash.slice('sha256:'.length)}`;
}

export function prepareBillingAuthorityBindingV2(
  sourceInput: BillingAuthoritySourceV2,
): PreparedBillingAuthorityBindingV2 {
  const source = parseBillingAuthoritySourceV2(sourceInput);
  const descriptor = sourceDescriptorV2(source);
  const sourceAuthorityHash = prepareBillingSourceAuthorityHashV2(source);
  const chargeKey = prepareBillingChargeKeyV2(source, sourceAuthorityHash);
  const common = {
    schema_version: 'billing-intent/2' as const,
    workspace_id: source.workspace_id,
    billing_owner_run_id: source.billing_owner_run_id,
    reservation_id: source.reservation_id,
    charge_key: chargeKey,
    charge_attribution_hash: sourceAuthorityHash,
  };

  let candidate: unknown;
  switch (source.schema_version) {
    case 'run-usage-attribution/1':
      candidate = {
        ...common,
        intent_kind: 'SETTLE',
        amount_credits: source.amount_credits,
        authority: {
          schema_version: 'billing-authority-reference/1',
          authority_kind: 'USAGE_ATTRIBUTION',
          source_schema_version: source.schema_version,
          source_id: source.usage_attribution_id,
          source_authority_hash: sourceAuthorityHash,
          producer_run_id: source.run_id,
          producer_attempt_id: source.attempt_id,
          producer_lease_fencing_token: source.lease_fencing_token,
          step_id: source.step_id,
        },
      };
      break;
    case 'run-termination-intent/1':
      candidate = {
        ...common,
        intent_kind: 'RELEASE',
        amount_credits: source.intended_release_credits,
        authority: {
          schema_version: 'billing-authority-reference/1',
          authority_kind: 'TERMINATION_ATTRIBUTION',
          source_schema_version: source.schema_version,
          source_id: source.termination_intent_id,
          source_authority_hash: sourceAuthorityHash,
          producer_run_id: source.run_id,
          producer_attempt_id: source.attempt_id,
          producer_lease_fencing_token: source.lease_fencing_token,
          step_id: source.step_id,
        },
      };
      break;
    case 'run-cancellation-release-authority/1':
      candidate = {
        ...common,
        intent_kind: 'RELEASE',
        amount_credits: source.remaining_credits,
        authority: {
          schema_version: 'billing-authority-reference/1',
          authority_kind: 'CANCELLATION_RELEASE',
          source_schema_version: source.schema_version,
          source_id: source.cancel_event_id,
          source_authority_hash: sourceAuthorityHash,
        },
      };
      break;
  }

  const result = BillingIntentV2Schema.safeParse(candidate);
  if (!result.success) {
    throw new BillingCoreError('BILLING_FACT_INVALID', 'derived billing v2 intent is invalid', {
      authority_kind: descriptor.authority_kind,
      source_id: descriptor.source_id,
    });
  }
  const intent = deepFreezeFactV1(result.data);
  return deepFreezeFactV1({
    source,
    authority_kind: descriptor.authority_kind,
    source_authority_hash: sourceAuthorityHash,
    charge_attribution_hash: sourceAuthorityHash,
    charge_key: chargeKey,
    intent,
    billing_intent_hash: canonicalSha256(intent),
  });
}

export function prepareBillingIntentHashV2(intentInput: BillingIntentV2): CanonicalSha256V1 {
  return canonicalSha256(parseBillingIntentForHashV2(intentInput));
}

export function assertBillingIntentHashV2(input: {
  readonly intent: BillingIntentV2;
  readonly billing_intent_hash: string;
  readonly hash_role: BillingIntentHashRoleV2;
}): BillingIntentV2 {
  const intent = parseBillingIntentForHashV2(input.intent);
  const expectedHash = canonicalSha256(intent);
  if (
    !Sha256HexV1Schema.safeParse(input.billing_intent_hash).success ||
    input.billing_intent_hash !== expectedHash
  ) {
    throw new BillingCoreError(
      'BILLING_FACT_INVALID',
      'billing v2 intent hash does not match the canonical intent',
      {
        authority_kind: intent.authority.authority_kind,
        charge_key: intent.charge_key,
        hash_role: input.hash_role,
      },
    );
  }
  return intent;
}

export function assertBillingIntentSourceBindingV2(input: {
  readonly source: BillingAuthoritySourceV2;
  readonly intent: BillingIntentV2;
  readonly billing_intent_hash: string;
}): PreparedBillingAuthorityBindingV2 {
  const proposedIntent = assertBillingIntentHashV2({
    intent: input.intent,
    billing_intent_hash: input.billing_intent_hash,
    hash_role: 'PROPOSED',
  });
  const expected = prepareBillingAuthorityBindingV2(input.source);
  if (
    input.billing_intent_hash !== expected.billing_intent_hash ||
    !canonicalJsonBytes(proposedIntent).equals(canonicalJsonBytes(expected.intent))
  ) {
    throw new BillingCoreError(
      'BILLING_FACT_INVALID',
      'billing v2 intent is not the downstream binding of its authority source',
      {
        authority_kind: expected.authority_kind,
        source_id: expected.intent.authority.source_id,
      },
    );
  }
  return expected;
}

function parseBillingAuthoritySourceV2(
  sourceInput: BillingAuthoritySourceV2,
): BillingAuthoritySourceV2 {
  const result = BillingAuthoritySourceV2Schema.safeParse(sourceInput);
  if (!result.success) {
    throw new BillingCoreError('BILLING_FACT_INVALID', 'billing authority source is invalid');
  }
  return deepFreezeFactV1(result.data);
}

function parseBillingIntentForHashV2(intentInput: BillingIntentV2): BillingIntentV2 {
  const result = BillingIntentV2Schema.safeParse(intentInput);
  if (!result.success) {
    throw new BillingCoreError('BILLING_FACT_INVALID', 'billing v2 intent is invalid');
  }
  return deepFreezeFactV1(result.data);
}

function sourceDescriptorV2(source: BillingAuthoritySourceV2): {
  readonly authority_kind: BillingAuthorityKindV2;
  readonly source_id: string;
  readonly hash_domain: (typeof BillingSourceHashDomainsV2)[BillingAuthorityKindV2];
} {
  switch (source.schema_version) {
    case 'run-usage-attribution/1':
      return {
        authority_kind: 'USAGE_ATTRIBUTION',
        source_id: source.usage_attribution_id,
        hash_domain: BillingSourceHashDomainsV2.USAGE_ATTRIBUTION,
      };
    case 'run-termination-intent/1':
      return {
        authority_kind: 'TERMINATION_ATTRIBUTION',
        source_id: source.termination_intent_id,
        hash_domain: BillingSourceHashDomainsV2.TERMINATION_ATTRIBUTION,
      };
    case 'run-cancellation-release-authority/1':
      return {
        authority_kind: 'CANCELLATION_RELEASE',
        source_id: source.cancel_event_id,
        hash_domain: BillingSourceHashDomainsV2.CANCELLATION_RELEASE,
      };
  }
}
