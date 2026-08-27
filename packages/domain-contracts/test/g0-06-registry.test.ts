import { describe, expect, it } from 'vitest';

import {
  BillingIntentV1Schema,
  ConversationV1Schema,
  domainContractSchemaVersions,
  HumanGateV1Schema,
  RunAcceptanceV1Schema,
  RunRetentionHorizonsV1Schema,
  safeParseDomainContract,
} from '../src/index.js';

const g006SchemaVersions = [
  'conversation-principal/1',
  'conversation/1',
  'conversation-state-cas/1',
  'run-target/1',
  'run-acceptance/1',
  'run-snapshot/1',
  'run-idempotency-namespace/1',
  'run-idempotency-request/1',
  'run-event/1',
  'run-outbox-message/1',
  'run-outbox-message-set/1',
  'human-gate-instance/1',
  'human-gate-resume-intent/1',
  'credit-reservation/1',
  'credit-ledger-entry/1',
  'run-billing-state/1',
  'billing-intent/1',
  'run-archive-manifest/1',
  'run-archive-verification-receipt/1',
  'run-archive-approval-receipt/1',
  'run-archive-evidence/1',
  'run-retention-horizons/1',
  'run-retention-purge-receipt/1',
] as const;

describe('G0-06 domain registry projection', () => {
  it('exports the public schema modules and registers every version exactly once', () => {
    expect(ConversationV1Schema).toBeDefined();
    expect(RunAcceptanceV1Schema).toBeDefined();
    expect(HumanGateV1Schema).toBeDefined();
    expect(BillingIntentV1Schema).toBeDefined();
    expect(RunRetentionHorizonsV1Schema).toBeDefined();
    expect(domainContractSchemaVersions).toEqual(expect.arrayContaining([...g006SchemaVersions]));
    expect(new Set(domainContractSchemaVersions).size).toBe(domainContractSchemaVersions.length);
  });

  it('continues to fail closed on a future Run contract version', () => {
    const result = safeParseDomainContract({ schema_version: 'run-acceptance/2' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('DOMAIN_SCHEMA_VERSION_UNKNOWN');
  });
});
