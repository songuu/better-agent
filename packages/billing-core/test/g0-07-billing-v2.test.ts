import { createHash } from 'node:crypto';

import type {
  BillingAuthoritySourceV2,
  BillingIntentV2,
  RunCancellationReleaseAuthorityV1,
  RunTerminationIntentV1,
  RunUsageAttributionV1,
} from '@better-agent/domain-contracts';
import { describe, expect, it } from 'vitest';

import {
  assertBillingIntentSourceBindingV2,
  assertCreditLedgerEntryMatchesIntentV2,
  classifyCreditLedgerReplayV2,
  prepareBillingAuthorityBindingV2,
  prepareBillingIntentHashV2,
  prepareCreditLedgerEntryV2,
} from '../src/index.js';

const ids = {
  workspace: '018f47f2-c541-7cc6-9292-4a2c35303201',
  billingRun: '018f47f2-c541-7cc6-9292-4a2c35303202',
  meteredRun: '018f47f2-c541-7cc6-9292-4a2c35303203',
  reservation: '018f47f2-c541-7cc6-9292-4a2c35303204',
  attempt: '018f47f2-c541-7cc6-9292-4a2c35303205',
  step: '018f47f2-c541-7cc6-9292-4a2c35303206',
  token: '018f47f2-c541-7cc6-9292-4a2c35303207',
  usage: '018f47f2-c541-7cc6-9292-4a2c35303208',
  termination: '018f47f2-c541-7cc6-9292-4a2c35303209',
  cancelEvent: '018f47f2-c541-7cc6-9292-4a2c3530320a',
  ledger: '018f47f2-c541-7cc6-9292-4a2c3530320b',
  authorityReceipt: '018f47f2-c541-7cc6-9292-4a2c3530320c',
} as const;

const hashA = `sha256:${'a'.repeat(64)}`;
const hashB = `sha256:${'b'.repeat(64)}`;
const authorizedAt = '2026-08-28T01:00:00.000Z';
const leaseExpiresAt = '2026-08-28T01:00:30.000Z';

const usageSource: RunUsageAttributionV1 = {
  schema_version: 'run-usage-attribution/1',
  usage_attribution_id: ids.usage,
  workspace_id: ids.workspace,
  billing_owner_run_id: ids.billingRun,
  run_id: ids.meteredRun,
  reservation_id: ids.reservation,
  attempt_id: ids.attempt,
  step_id: ids.step,
  producer_session_user: 'ba_execution_worker_a',
  lease_owner: 'ba_execution_worker_a',
  lease_token: ids.token,
  lease_fencing_token: '7',
  lease_expires_at: leaseExpiresAt,
  authorized_at: authorizedAt,
  producer_operation_key: 'usage:test-vector',
  metering_unit: 'tokens',
  metering_quantity: '12',
  amount_credits: '3',
  settlement_operation_key: 'settle:usage:12',
  operation_intent_sha256: hashA,
  execution_effect_payload_sha256: hashB,
  consumption_generation: '1',
};

const terminationSource: RunTerminationIntentV1 = {
  schema_version: 'run-termination-intent/1',
  termination_intent_id: ids.termination,
  workspace_id: ids.workspace,
  billing_owner_run_id: ids.billingRun,
  run_id: ids.meteredRun,
  reservation_id: ids.reservation,
  attempt_id: ids.attempt,
  step_id: ids.step,
  producer_session_user: 'ba_execution_worker_a',
  lease_owner: 'ba_execution_worker_a',
  lease_token: ids.token,
  lease_fencing_token: '7',
  lease_expires_at: leaseExpiresAt,
  authorized_at: authorizedAt,
  producer_operation_key: 'termination:test-vector',
  terminal_status: 'CANCELLED',
  termination_reason: 'USER_CANCELLED',
  effect_disposition: 'CLOSED',
  effect_closure_sha256: hashA,
  usage_attribution_ids: [ids.usage],
  intended_settle_credits: '3',
  settlement_operation_key: 'settle:terminal:usage-set',
  intended_release_credits: '2',
  release_operation_key: 'release:terminal:remainder',
  release_reason_code: 'USER_CANCELLED',
  operation_intent_sha256: hashB,
  consumption_generation: '1',
};

const cancellationSource: RunCancellationReleaseAuthorityV1 = {
  schema_version: 'run-cancellation-release-authority/1',
  workspace_id: ids.workspace,
  run_id: ids.billingRun,
  billing_owner_run_id: ids.billingRun,
  reservation_id: ids.reservation,
  cancel_event_id: ids.cancelEvent,
  cancel_event_sequence: '4',
  cancel_intent_sha256: hashA,
  terminal_intent_sha256: hashB,
  effect_closure_sha256: hashA,
  remaining_credits: '2',
  release_operation_key: 'release:cancel:4',
  release_reason_code: 'USER_CANCELLED',
  authorized_at: authorizedAt,
};

const knownSourceHashes = {
  'run-usage-attribution/1':
    'sha256:367977effd85124e39490e5d18b586c251e44e4d29d34a6c6a27169072c62dd2',
  'run-termination-intent/1':
    'sha256:b92e3d1381c68ee6cbe7921494e72edc4a609fb67841cf1c6c6b7d7d2ba1c375',
  'run-cancellation-release-authority/1':
    'sha256:0d71b017793fdaf4e92db810b99dd5a2c10dd7dbf739915d9edf56324d36ba2d',
} as const;

const knownIntentHashes = {
  'run-usage-attribution/1':
    'sha256:e632bb5a5893c1779563bd0ee268c225aa038fd28d8a1349d638a75251e8adf8',
  'run-termination-intent/1':
    'sha256:26a38e9d30c50ca8739117e3a3df6a977f9772228beca3ce82aeaaaeb724504e',
  'run-cancellation-release-authority/1':
    'sha256:721b9de33a2eee3688cfe00a62ac3a183672e3296dd1c4777e6607241650d4e3',
} as const;

const sourceHashDomains = {
  'run-usage-attribution/1': 'better-agent/execution-usage-source/1',
  'run-termination-intent/1': 'better-agent/execution-termination-source/1',
  'run-cancellation-release-authority/1': 'better-agent/run-cancellation-release-source/1',
} as const;

function independentCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(independentCanonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${independentCanonicalJson(object[key])}`)
    .join(',')}}`;
}

function independentSourceHash(source: BillingAuthoritySourceV2): string {
  const bytes = `${sourceHashDomains[source.schema_version]}\0${independentCanonicalJson(
    independentSourcePreimage(source),
  )}`;
  return `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
}

function independentIntentHash(intent: BillingIntentV2): string {
  return `sha256:${createHash('sha256')
    .update(independentCanonicalJson(intent), 'utf8')
    .digest('hex')}`;
}

function independentSourcePreimage(source: BillingAuthoritySourceV2): Record<string, unknown> {
  switch (source.schema_version) {
    case 'run-usage-attribution/1':
      return {
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
      };
    case 'run-termination-intent/1':
      return {
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
      };
    case 'run-cancellation-release-authority/1':
      return { ...source };
  }
}

function mutateOneSourceField(source: BillingAuthoritySourceV2): BillingAuthoritySourceV2 {
  switch (source.schema_version) {
    case 'run-usage-attribution/1':
      return { ...source, metering_quantity: '13' };
    case 'run-termination-intent/1':
      return { ...source, intended_release_credits: '3' };
    case 'run-cancellation-release-authority/1':
      return { ...source, remaining_credits: '3' };
  }
}

function historicalIntentSemantics(intent: BillingIntentV2): Record<string, unknown> {
  const authority = intent.authority;
  if (authority.authority_kind === 'CANCELLATION_RELEASE') {
    throw new Error('expected an execution-produced billing authority');
  }
  return {
    schema_version: intent.schema_version,
    workspace_id: intent.workspace_id,
    billing_owner_run_id: intent.billing_owner_run_id,
    reservation_id: intent.reservation_id,
    amount_credits: intent.amount_credits,
    intent_kind: intent.intent_kind,
    authority_kind: authority.authority_kind,
    source_schema_version: authority.source_schema_version,
    source_id: authority.source_id,
    producer_run_id: authority.producer_run_id,
    producer_attempt_id: authority.producer_attempt_id,
    producer_lease_fencing_token: authority.producer_lease_fencing_token,
    step_id: authority.step_id,
  };
}

describe('G0-07 billing authority hash DAG', () => {
  it.each([usageSource, terminationSource, cancellationSource] as const)(
    'matches an independent known vector for $schema_version',
    (source) => {
      const binding = prepareBillingAuthorityBindingV2(source);
      expect(binding.source_authority_hash).toBe(knownSourceHashes[source.schema_version]);
      expect(independentSourceHash(source)).toBe(knownSourceHashes[source.schema_version]);
      expect(binding.charge_attribution_hash).toBe(binding.source_authority_hash);
      expect(binding.intent.charge_attribution_hash).toBe(binding.source_authority_hash);
      expect(binding.billing_intent_hash).toBe(knownIntentHashes[source.schema_version]);
      expect(independentIntentHash(binding.intent)).toBe(knownIntentHashes[source.schema_version]);
      expect(binding.billing_intent_hash).toBe(prepareBillingIntentHashV2(binding.intent));
      expect(binding.intent.charge_key).toBe(binding.charge_key);
    },
  );

  it.each([usageSource, terminationSource, cancellationSource] as const)(
    'propagates a source-field tamper only downstream for $schema_version',
    (source) => {
      const first = prepareBillingAuthorityBindingV2(source);
      const tamperedSource = mutateOneSourceField(source);
      const tampered = prepareBillingAuthorityBindingV2(tamperedSource);

      expect(source).not.toEqual(tamperedSource);
      expect(first.source_authority_hash).not.toBe(tampered.source_authority_hash);
      expect(first.charge_key).not.toBe(tampered.charge_key);
      expect(first.billing_intent_hash).not.toBe(tampered.billing_intent_hash);
      expect(() =>
        assertBillingIntentSourceBindingV2({
          source: tamperedSource,
          intent: first.intent,
          billing_intent_hash: first.billing_intent_hash,
        }),
      ).toThrowError(/BILLING_FACT_INVALID/u);
    },
  );

  it('returns the same derived binding after a response-loss retry and freezes all facts', () => {
    const first = prepareBillingAuthorityBindingV2(structuredClone(usageSource));
    const retry = prepareBillingAuthorityBindingV2(structuredClone(usageSource));

    expect(retry).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.source)).toBe(true);
    expect(Object.isFrozen(first.intent)).toBe(true);
    expect(Object.isFrozen(first.intent.authority)).toBe(true);
  });

  it.each([usageSource, terminationSource] as const)(
    'binds $schema_version to its stable producer operation key without changing financial semantics',
    (source) => {
      const first = prepareBillingAuthorityBindingV2(source);
      const changed = prepareBillingAuthorityBindingV2({
        ...source,
        producer_operation_key: `${source.producer_operation_key}:different`,
      });

      expect(changed.source_authority_hash).not.toBe(first.source_authority_hash);
      expect(changed.charge_key).not.toBe(first.charge_key);
      expect(changed.billing_intent_hash).not.toBe(first.billing_intent_hash);
      expect(historicalIntentSemantics(changed.intent)).toEqual(
        historicalIntentSemantics(first.intent),
      );
    },
  );
});

describe('G0-07 billing v2 ledger projection and replay', () => {
  function prepare(source: BillingAuthoritySourceV2, amountVersion = 4) {
    const binding = prepareBillingAuthorityBindingV2(source);
    const projection = prepareCreditLedgerEntryV2({
      source,
      intent: binding.intent,
      billing_intent_hash: binding.billing_intent_hash,
      ledger_entry_id: ids.ledger,
      authority_receipt_id: ids.authorityReceipt,
      current_balance_version: amountVersion,
      metering_detail_redacted: { verified: true },
      created_at: authorizedAt,
    });
    return { binding, projection };
  }

  it.each([
    [usageSource, 'SETTLE', 'USAGE_ATTRIBUTION', '0', '-3', '3'],
    [terminationSource, 'RELEASE', 'TERMINATION_ATTRIBUTION', '2', '-2', '0'],
    [cancellationSource, 'RELEASE', 'CANCELLATION_RELEASE', '2', '-2', '0'],
  ] as const)(
    'projects $1/$2 with an exact source receipt binding',
    (source, entryKind, authorityKind, available, reserved, settled) => {
      const { binding, projection } = prepare(source);
      expect(projection.ledger_entry).toMatchObject({
        schema_version: 'credit-ledger-entry/2',
        entry_kind: entryKind,
        available_delta_credits: available,
        reserved_delta_credits: reserved,
        settled_delta_credits: settled,
        billing_intent_hash: binding.billing_intent_hash,
        charge_attribution_hash: binding.source_authority_hash,
        authority: {
          authority_kind: authorityKind,
          authority_receipt_id: ids.authorityReceipt,
          source_authority_hash: binding.source_authority_hash,
        },
      });
      expect(
        assertCreditLedgerEntryMatchesIntentV2({
          source,
          intent: binding.intent,
          billing_intent_hash: binding.billing_intent_hash,
          ledger_entry: projection.ledger_entry,
        }),
      ).toEqual(projection.ledger_entry);
      expect(Object.isFrozen(projection.ledger_entry)).toBe(true);
      expect(Object.isFrozen(projection.ledger_entry.metering_detail_redacted)).toBe(true);
    },
  );

  it('does not advance balance version for a zero-credit cancellation release', () => {
    const source = { ...cancellationSource, remaining_credits: '0' } as const;
    const { projection } = prepare(source, 9);
    expect(projection.next_balance_version).toBe(9);
    expect(projection.ledger_entry).toMatchObject({
      available_delta_credits: '0',
      reserved_delta_credits: '0',
      settled_delta_credits: '0',
      balance_version: 9,
    });
  });

  it('classifies only an exact authority+financial replay as REPLAY', () => {
    const { binding, projection } = prepare(usageSource);
    expect(
      classifyCreditLedgerReplayV2({
        existing_ledger_entry: projection.ledger_entry,
        proposed_source: usageSource,
        proposed_intent: binding.intent,
        proposed_billing_intent_hash: binding.billing_intent_hash,
      }),
    ).toBe('REPLAY');

    const changedSource = { ...usageSource, metering_quantity: '13' } as const;
    const changed = prepareBillingAuthorityBindingV2(changedSource);
    expect(() =>
      classifyCreditLedgerReplayV2({
        existing_ledger_entry: projection.ledger_entry,
        proposed_source: changedSource,
        proposed_intent: changed.intent,
        proposed_billing_intent_hash: changed.billing_intent_hash,
      }),
    ).toThrowError(/BILLING_(?:FACT_INVALID|INTENT_CONFLICT)/u);

    const forgedIntent = {
      ...binding.intent,
      amount_credits: '4',
    } as BillingIntentV2;
    expect(() =>
      classifyCreditLedgerReplayV2({
        existing_ledger_entry: projection.ledger_entry,
        proposed_source: usageSource,
        proposed_intent: forgedIntent,
        proposed_billing_intent_hash: prepareBillingIntentHashV2(forgedIntent),
      }),
    ).toThrowError(/BILLING_FACT_INVALID/u);
  });
});
