import { describe, expect, it } from 'vitest';

import {
  BillingIntentV2Schema,
  CreditLedgerEntryV2Schema,
  domainContractSchemaVersions,
  RunAttemptLeaseAuthorityV1Schema,
  RunAttemptLeaseStateV1Schema,
  RunCancellationReleaseAuthorityV1Schema,
  RunDispatchRetirementReceiptV1Schema,
  RunExecutionCheckpointV1Schema,
  RunRecoveryHoldIntentV1Schema,
  RunRecoveryTicketDispositionV1Schema,
  RunRecoveryTicketV1Schema,
  RunRetryEffectEnvelopeV1Schema,
  RunSideEffectReceiptV1Schema,
  RunTerminationIntentV1Schema,
  RunTerminationIntentRecordResultV1Schema,
  RunUsageAttributionV1Schema,
  RunUsageAttributionRecordResultV1Schema,
  safeParseDomainContract,
} from '../src/index.js';

const g007SchemaVersions = [
  'run-attempt-lease-state/1',
  'run-attempt-lease-authority/1',
  'run-retry-effect-envelope/1',
  'run-side-effect-receipt/1',
  'run-execution-checkpoint/1',
  'run-usage-attribution/1',
  'run-termination-intent/1',
  'run-usage-attribution-record-result/1',
  'run-termination-intent-record-result/1',
  'run-recovery-ticket/1',
  'run-recovery-ticket-disposition/1',
  'run-recovery-hold-intent/1',
  'run-dispatch-retirement-receipt/1',
  'run-cancellation-release-authority/1',
  'billing-intent/2',
  'credit-ledger-entry/2',
] as const;

describe('G0-07 domain registry projection', () => {
  it('exports and registers every execution and billing schema exactly once', () => {
    for (const schema of [
      RunAttemptLeaseStateV1Schema,
      RunAttemptLeaseAuthorityV1Schema,
      RunRetryEffectEnvelopeV1Schema,
      RunSideEffectReceiptV1Schema,
      RunExecutionCheckpointV1Schema,
      RunUsageAttributionV1Schema,
      RunTerminationIntentV1Schema,
      RunUsageAttributionRecordResultV1Schema,
      RunTerminationIntentRecordResultV1Schema,
      RunRecoveryTicketV1Schema,
      RunRecoveryTicketDispositionV1Schema,
      RunRecoveryHoldIntentV1Schema,
      RunDispatchRetirementReceiptV1Schema,
      RunCancellationReleaseAuthorityV1Schema,
      BillingIntentV2Schema,
      CreditLedgerEntryV2Schema,
    ]) {
      expect(schema).toBeDefined();
    }
    expect(domainContractSchemaVersions).toEqual(expect.arrayContaining([...g007SchemaVersions]));
    expect(new Set(domainContractSchemaVersions).size).toBe(domainContractSchemaVersions.length);
  });

  it('keeps future execution and billing versions fail-closed', () => {
    for (const schema_version of [
      'run-attempt-lease-state/2',
      'billing-intent/3',
      'credit-ledger-entry/3',
    ]) {
      const result = safeParseDomainContract({ schema_version });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('DOMAIN_SCHEMA_VERSION_UNKNOWN');
    }
  });
});
