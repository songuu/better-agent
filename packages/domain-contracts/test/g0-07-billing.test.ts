import { describe, expect, it } from 'vitest';

import {
  BillingIntentV2Schema,
  CreditLedgerEntryV2Schema,
  RunCancellationReleaseAuthorityV1Schema,
} from '../src/billing-v2.js';

const ids = {
  workspace: '018f47f2-c541-7cc6-9292-4a2c35303101',
  run: '018f47f2-c541-7cc6-9292-4a2c35303102',
  attempt: '018f47f2-c541-7cc6-9292-4a2c35303103',
  step: '018f47f2-c541-7cc6-9292-4a2c35303104',
  reservation: '018f47f2-c541-7cc6-9292-4a2c35303105',
  source: '018f47f2-c541-7cc6-9292-4a2c35303106',
  receipt: '018f47f2-c541-7cc6-9292-4a2c35303107',
  ledger: '018f47f2-c541-7cc6-9292-4a2c35303108',
  event: '018f47f2-c541-7cc6-9292-4a2c35303109',
} as const;

const sourceHash = `sha256:${'a'.repeat(64)}`;
const intentHash = `sha256:${'b'.repeat(64)}`;
const instant = '2026-08-28T01:00:00.000Z';

const usageAuthority = {
  schema_version: 'billing-authority-reference/1',
  authority_kind: 'USAGE_ATTRIBUTION',
  source_schema_version: 'run-usage-attribution/1',
  source_id: ids.source,
  source_authority_hash: sourceHash,
  producer_run_id: ids.run,
  producer_attempt_id: ids.attempt,
  producer_lease_fencing_token: '7',
  step_id: ids.step,
} as const;

const settleIntent = {
  schema_version: 'billing-intent/2',
  workspace_id: ids.workspace,
  billing_owner_run_id: ids.run,
  reservation_id: ids.reservation,
  intent_kind: 'SETTLE',
  amount_credits: '3',
  charge_key: 'billing-v2:usage:stable',
  charge_attribution_hash: sourceHash,
  authority: usageAuthority,
} as const;

function ledgerAuthority(kind: 'USAGE_ATTRIBUTION' | 'TERMINATION_ATTRIBUTION') {
  return {
    ...usageAuthority,
    schema_version: 'billing-authority-receipt-reference/1' as const,
    authority_kind: kind,
    source_schema_version:
      kind === 'USAGE_ATTRIBUTION'
        ? ('run-usage-attribution/1' as const)
        : ('run-termination-intent/1' as const),
    authority_receipt_id: ids.receipt,
  };
}

describe('G0-07 billing v2 authority contracts', () => {
  it('closes the DB-authored durable cancellation source layer', () => {
    const cancellation = {
      schema_version: 'run-cancellation-release-authority/1',
      workspace_id: ids.workspace,
      run_id: ids.run,
      billing_owner_run_id: ids.run,
      reservation_id: ids.reservation,
      cancel_event_id: ids.event,
      cancel_event_sequence: '4',
      cancel_intent_sha256: sourceHash,
      terminal_intent_sha256: intentHash,
      effect_closure_sha256: sourceHash,
      remaining_credits: '2',
      release_operation_key: 'release:cancel:4',
      release_reason_code: 'USER_CANCELLED',
      authorized_at: instant,
    } as const;
    expect(RunCancellationReleaseAuthorityV1Schema.safeParse(cancellation).success).toBe(true);
    expect(
      RunCancellationReleaseAuthorityV1Schema.safeParse({
        ...cancellation,
        billing_owner_run_id: ids.source,
      }).success,
    ).toBe(false);
    expect(
      RunCancellationReleaseAuthorityV1Schema.safeParse({
        ...cancellation,
        billing_intent_hash: intentHash,
      }).success,
    ).toBe(false);
    expect(
      RunCancellationReleaseAuthorityV1Schema.safeParse({
        ...cancellation,
        release_operation_key: '   ',
      }).success,
    ).toBe(false);
    expect(
      RunCancellationReleaseAuthorityV1Schema.safeParse({
        ...cancellation,
        release_reason_code: '   ',
      }).success,
    ).toBe(false);
    for (const authorized_at of [
      '2026-08-28T01:00:00.0000001Z',
      '2026-08-28T01:00:00+16:00',
      '0000-01-01T00:00:00Z',
    ]) {
      expect(
        RunCancellationReleaseAuthorityV1Schema.safeParse({ ...cancellation, authorized_at })
          .success,
      ).toBe(false);
    }
    expect(
      RunCancellationReleaseAuthorityV1Schema.safeParse({
        ...cancellation,
        authorized_at: '0001-01-01T00:00:00Z',
      }).success,
    ).toBe(true);
  });

  it('allows only usage SETTLE and termination/cancellation RELEASE branches', () => {
    expect(BillingIntentV2Schema.safeParse(settleIntent).success).toBe(true);
    expect(
      BillingIntentV2Schema.safeParse({ ...settleIntent, intent_kind: 'RELEASE' }).success,
    ).toBe(false);
    expect(
      BillingIntentV2Schema.safeParse({
        ...settleIntent,
        authority: {
          ...usageAuthority,
          authority_kind: 'CANCELLATION_RELEASE',
          source_schema_version: 'run-cancellation-release-authority/1',
          producer_run_id: undefined,
          producer_attempt_id: undefined,
          producer_lease_fencing_token: undefined,
          step_id: undefined,
        },
      }).success,
    ).toBe(false);
    expect(
      BillingIntentV2Schema.safeParse({
        ...settleIntent,
        charge_attribution_hash: intentHash,
      }).success,
    ).toBe(false);
    expect(BillingIntentV2Schema.safeParse({ ...settleIntent, charge_key: '   ' }).success).toBe(
      false,
    );
    for (const blank of ['\t', '\n', '\u00a0']) {
      expect(BillingIntentV2Schema.safeParse({ ...settleIntent, charge_key: blank }).success).toBe(
        false,
      );
    }
  });

  it('requires a strict ledger XOR between historical producers and keyless cancellation', () => {
    const usageLedger = {
      schema_version: 'credit-ledger-entry/2',
      ledger_entry_id: ids.ledger,
      workspace_id: ids.workspace,
      run_id: ids.run,
      billing_owner_run_id: ids.run,
      producer_run_id: ids.run,
      producer_attempt_id: ids.attempt,
      producer_lease_fencing_token: '7',
      step_id: ids.step,
      reservation_id: ids.reservation,
      entry_kind: 'SETTLE',
      available_delta_credits: '0',
      reserved_delta_credits: '-3',
      settled_delta_credits: '3',
      billing_intent_hash: intentHash,
      charge_attribution_hash: sourceHash,
      charge_key: settleIntent.charge_key,
      balance_version: 2,
      metering_detail_redacted: {},
      authority: ledgerAuthority('USAGE_ATTRIBUTION'),
      created_at: instant,
    } as const;
    expect(CreditLedgerEntryV2Schema.safeParse(usageLedger).success).toBe(true);
    for (const field of [
      'available_delta_credits',
      'reserved_delta_credits',
      'settled_delta_credits',
    ] as const) {
      const parseInvalidDelta = () =>
        CreditLedgerEntryV2Schema.safeParse({ ...usageLedger, [field]: 'abc' });
      expect(parseInvalidDelta).not.toThrow();
      expect(parseInvalidDelta().success).toBe(false);
    }
    expect(
      CreditLedgerEntryV2Schema.safeParse({
        ...usageLedger,
        producer_lease_fencing_token: '9007199254740992',
      }).success,
    ).toBe(false);
    expect(CreditLedgerEntryV2Schema.safeParse({ ...usageLedger, charge_key: '   ' }).success).toBe(
      false,
    );

    const cancelLedger = {
      ...usageLedger,
      entry_kind: 'RELEASE',
      producer_attempt_id: undefined,
      producer_lease_fencing_token: undefined,
      step_id: undefined,
      available_delta_credits: '3',
      settled_delta_credits: '0',
      authority: {
        schema_version: 'billing-authority-receipt-reference/1',
        authority_kind: 'CANCELLATION_RELEASE',
        source_schema_version: 'run-cancellation-release-authority/1',
        authority_receipt_id: ids.receipt,
        source_id: ids.event,
        source_authority_hash: sourceHash,
      },
    } as const;
    expect(CreditLedgerEntryV2Schema.safeParse(cancelLedger).success).toBe(true);
    expect(
      CreditLedgerEntryV2Schema.safeParse({
        ...cancelLedger,
        producer_attempt_id: ids.attempt,
      }).success,
    ).toBe(false);
    expect(
      CreditLedgerEntryV2Schema.safeParse({
        ...cancelLedger,
        authority: ledgerAuthority('TERMINATION_ATTRIBUTION'),
      }).success,
    ).toBe(false);
    expect(
      CreditLedgerEntryV2Schema.safeParse({
        ...usageLedger,
        schema_version: 'credit-ledger-entry/1',
        authority: undefined,
      }).success,
    ).toBe(false);
  });
});
