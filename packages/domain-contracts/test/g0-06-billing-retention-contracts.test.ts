import { describe, expect, it } from 'vitest';

import { HumanGateResumeIntentV1Schema, HumanGateV1Schema } from '../src/human-gate-v1.js';
import { OutboxMessageSetV1Schema, RunEventV1Schema } from '../src/run-event-outbox-v1.js';
import {
  BillingIntentV1Schema,
  CreditAmountV1Schema,
  CreditLedgerEntryV1Schema,
  CreditReservationV1Schema,
  RunBillingStateV1Schema,
} from '../src/billing-v1.js';
import {
  ArchiveApprovalReceiptV1Schema,
  ArchiveManifestV1Schema,
  ArchiveVerificationReceiptV1Schema,
  RunArchiveEvidenceV1Schema,
  RunRetentionHorizonsV1Schema,
  RunRetentionPurgeReceiptV1Schema,
} from '../src/retention-v1.js';

const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303eee';
const runId = '018f47f2-c541-7cc6-9292-4a2c35303e01';
const reservationId = '018f47f2-c541-7cc6-9292-4a2c35303e02';
const eventId = '018f47f2-c541-7cc6-9292-4a2c35303e03';
const gateId = '018f47f2-c541-7cc6-9292-4a2c35303e04';
const checkpointId = '018f47f2-c541-7cc6-9292-4a2c35303e0d';
const manifestId = '018f47f2-c541-7cc6-9292-4a2c35303e06';
const verificationReceiptId = '018f47f2-c541-7cc6-9292-4a2c35303e07';
const approvalReceiptId = '018f47f2-c541-7cc6-9292-4a2c35303e08';
const hashA = `sha256:${'a'.repeat(64)}`;
const hashB = `sha256:${'b'.repeat(64)}`;
const hashC = `sha256:${'c'.repeat(64)}`;

const manifest = {
  schema_version: 'run-archive-manifest/1',
  manifest_id: manifestId,
  workspace_id: workspaceId,
  run_id: runId,
  archive_ref: 'object://run-archives/manifest.json',
  archive_sha256: hashA,
  created_at: '2026-08-27T00:00:00.000Z',
} as const;

const verificationReceipt = {
  schema_version: 'run-archive-verification-receipt/1',
  verification_receipt_id: verificationReceiptId,
  manifest_id: manifestId,
  workspace_id: workspaceId,
  run_id: runId,
  archive_ref: manifest.archive_ref,
  archive_sha256: hashA,
  receipt_ref: 'object://run-archives/verification.json',
  receipt_sha256: hashB,
  status: 'VERIFIED',
  verified_at: '2026-08-27T00:01:00.000Z',
} as const;

const approvalReceipt = {
  schema_version: 'run-archive-approval-receipt/1',
  approval_receipt_id: approvalReceiptId,
  manifest_id: manifestId,
  verification_receipt_id: verificationReceiptId,
  verification_receipt_sha256: hashB,
  workspace_id: workspaceId,
  run_id: runId,
  receipt_ref: 'object://run-archives/approval.json',
  receipt_sha256: hashC,
  status: 'APPROVED',
  approved_at: '2026-08-27T00:02:00.000Z',
} as const;

describe('G0-06 Event, Outbox, HumanGate, billing, and retention contracts', () => {
  it('keeps Run Event and per-kind Outbox intents closed and unique', () => {
    const event = {
      schema_version: 'run-event/1',
      event_id: eventId,
      workspace_id: workspaceId,
      run_id: runId,
      sequence: '1',
      event_kind: 'RUN_ACCEPTED',
      sse_visible: true,
      payload_redacted: {},
      created_at: '2026-08-27T00:00:00.000Z',
    } as const;
    expect(RunEventV1Schema.safeParse(event).success).toBe(true);
    expect(RunEventV1Schema.safeParse({ ...event, secret: 'must-not-pass' }).success).toBe(false);

    const message = {
      schema_version: 'run-outbox-message/1',
      outbox_message_id: '018f47f2-c541-7cc6-9292-4a2c35303e09',
      workspace_id: workspaceId,
      run_id: runId,
      message_type: 'RUN_DISPATCH',
      dedupe_key: `run/${runId}/dispatch`,
      delivery_status: 'PENDING',
      lease_fencing_token: '0',
      attempt_count: '0',
      next_attempt_at: '2026-08-27T00:00:00.000Z',
      last_error_detail_redacted: {},
      payload_object_ref: 'object://run-outbox/dispatch.json',
      payload_sha256: hashA,
      payload_metadata_redacted: {},
      created_at: '2026-08-27T00:00:00.000Z',
      updated_at: '2026-08-27T00:00:00.000Z',
    } as const;
    const set = {
      schema_version: 'run-outbox-message-set/1',
      workspace_id: workspaceId,
      run_id: runId,
      messages: [message],
    } as const;
    expect(OutboxMessageSetV1Schema.safeParse(set).success).toBe(true);
    expect(
      OutboxMessageSetV1Schema.safeParse({ ...set, messages: [message, message] }).success,
    ).toBe(false);
  });

  it('freezes HumanGate facts without accepting an empty resume idempotency key', () => {
    const gate = {
      schema_version: 'human-gate-instance/1',
      gate_id: gateId,
      workspace_id: workspaceId,
      run_id: runId,
      checkpoint_id: checkpointId,
      gate_type: 'approval',
      resolved_plan_hash: hashA,
      canonical_operation_hash: hashB,
      public_schema: { type: 'object' },
      approver_policy_id: 'publish-approvers',
      status: 'PENDING',
      barrier_generation: 1,
      expires_at: '2026-08-28T00:00:00.000Z',
      created_at: '2026-08-27T00:00:00.000Z',
      updated_at: '2026-08-27T00:00:00.000Z',
    } as const;
    expect(HumanGateV1Schema.safeParse(gate).success).toBe(true);

    const resume = {
      schema_version: 'human-gate-resume-intent/1',
      workspace_id: workspaceId,
      run_id: runId,
      gate_id: gateId,
      action: 'APPROVE',
      idempotency_key: 'approve-once',
      input: {},
    } as const;
    expect(HumanGateResumeIntentV1Schema.safeParse(resume).success).toBe(true);
    expect(
      HumanGateResumeIntentV1Schema.safeParse({ ...resume, idempotency_key: 'k'.repeat(128) })
        .success,
    ).toBe(true);
    expect(
      HumanGateResumeIntentV1Schema.safeParse({ ...resume, idempotency_key: 'k'.repeat(129) })
        .success,
    ).toBe(false);
    expect(
      HumanGateResumeIntentV1Schema.safeParse({ ...resume, idempotency_key: '' }).success,
    ).toBe(false);
    expect(HumanGateResumeIntentV1Schema.safeParse({ ...resume, actor: 'caller' }).success).toBe(
      false,
    );
  });

  it('accepts canonical zero through the PostgreSQL bigint maximum only', () => {
    expect(CreditAmountV1Schema.safeParse('0').success).toBe(true);
    expect(CreditAmountV1Schema.safeParse('9223372036854775807').success).toBe(true);
    for (const invalid of ['-1', '00', '01', '1e3', '+1', '9223372036854775808', 1]) {
      expect(CreditAmountV1Schema.safeParse(invalid).success).toBe(false);
    }
  });

  it('preserves the zero reservation and exact ledger triangle', () => {
    const reservation = {
      schema_version: 'credit-reservation/1',
      reservation_id: reservationId,
      workspace_id: workspaceId,
      run_id: runId,
      accepted_plan_hash: hashA,
      status: 'HELD',
      reserved_credits: '0',
      settled_credits: '0',
      released_credits: '0',
      balance_version: 7,
      expires_at: '2026-08-28T00:00:00.000Z',
      created_at: '2026-08-27T00:00:00.000Z',
      updated_at: '2026-08-27T00:00:00.000Z',
    } as const;
    expect(CreditReservationV1Schema.safeParse(reservation).success).toBe(true);
    const parseInvalidReservationAmount = () =>
      CreditReservationV1Schema.safeParse({ ...reservation, reserved_credits: 'abc' });
    expect(parseInvalidReservationAmount).not.toThrow();
    expect(parseInvalidReservationAmount().success).toBe(false);

    const entry = {
      schema_version: 'credit-ledger-entry/1',
      ledger_entry_id: '018f47f2-c541-7cc6-9292-4a2c35303e0a',
      workspace_id: workspaceId,
      run_id: runId,
      producer_run_id: runId,
      reservation_id: reservationId,
      entry_kind: 'RESERVE',
      available_delta_credits: '0',
      reserved_delta_credits: '0',
      settled_delta_credits: '0',
      billing_intent_hash: hashB,
      charge_attribution_hash: hashA,
      charge_key: `reserve/${runId}`,
      balance_version: 7,
      metering_detail_redacted: {},
      created_at: '2026-08-27T00:00:00.000Z',
    } as const;
    expect(CreditLedgerEntryV1Schema.safeParse(entry).success).toBe(true);
    const parseInvalidLedgerDelta = () =>
      CreditLedgerEntryV1Schema.safeParse({ ...entry, reserved_delta_credits: 'abc' });
    expect(parseInvalidLedgerDelta).not.toThrow();
    expect(parseInvalidLedgerDelta().success).toBe(false);
    expect(
      CreditLedgerEntryV1Schema.safeParse({ ...entry, reserved_delta_credits: '1' }).success,
    ).toBe(false);

    const expired = {
      ...entry,
      ledger_entry_id: '018f47f2-c541-7cc6-9292-4a2c35303e0c',
      entry_kind: 'EXPIRED',
      available_delta_credits: '5',
      reserved_delta_credits: '-5',
      charge_key: `expire/${runId}`,
    } as const;
    expect(CreditLedgerEntryV1Schema.safeParse(expired).success).toBe(true);
    expect(
      CreditLedgerEntryV1Schema.safeParse({ ...expired, reserved_delta_credits: '-4' }).success,
    ).toBe(false);

    expect(
      RunBillingStateV1Schema.safeParse({
        schema_version: 'run-billing-state/1',
        workspace_id: workspaceId,
        run_id: runId,
        billing_state: 'PENDING',
        billing_settled_at: null,
      }).success,
    ).toBe(true);
  });

  it('rejects reservation expiry and audit timestamps that move backward', () => {
    const held = {
      schema_version: 'credit-reservation/1',
      reservation_id: reservationId,
      workspace_id: workspaceId,
      run_id: runId,
      accepted_plan_hash: hashA,
      status: 'HELD',
      reserved_credits: '5',
      settled_credits: '0',
      released_credits: '0',
      balance_version: 7,
      expires_at: '2026-08-29T00:00:00.000Z',
      created_at: '2026-08-28T00:00:00.000Z',
      updated_at: '2026-08-28T00:00:00.000Z',
    } as const;

    expect(CreditReservationV1Schema.safeParse(held).success).toBe(true);
    expect(
      CreditReservationV1Schema.safeParse({
        ...held,
        expires_at: '2026-08-27T00:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      CreditReservationV1Schema.safeParse({
        ...held,
        updated_at: '2026-08-27T00:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      CreditReservationV1Schema.safeParse({
        ...held,
        status: 'SETTLED',
        settled_credits: '5',
        settled_at: '2026-08-30T00:00:00.000Z',
        updated_at: '2026-08-29T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('keeps each billing intent closed and rejects child allocation input', () => {
    const reserve = {
      schema_version: 'billing-intent/1',
      intent_kind: 'RESERVE',
      workspace_id: workspaceId,
      billing_owner_run_id: runId,
      reservation_id: reservationId,
      charge_key: `reserve/${runId}`,
      amount_credits: '0',
      accepted_plan_hash: hashA,
      expires_at: '2026-08-28T00:00:00.000Z',
    } as const;
    expect(BillingIntentV1Schema.safeParse(reserve).success).toBe(true);
    const parseInvalidReconciliationAmount = () =>
      BillingIntentV1Schema.safeParse({
        schema_version: 'billing-intent/1',
        intent_kind: 'RECONCILIATION',
        workspace_id: workspaceId,
        billing_owner_run_id: runId,
        reservation_id: reservationId,
        charge_key: `reconciliation/${runId}`,
        reconciliation_id: gateId,
        release_credits: 'abc',
        settle_credits: '1',
        evidence_ref: 'object://billing/reconciliation.json',
        evidence_sha256: hashA,
      });
    expect(parseInvalidReconciliationAmount).not.toThrow();
    expect(parseInvalidReconciliationAmount().success).toBe(false);
    expect(BillingIntentV1Schema.safeParse({ ...reserve, child_run_id: gateId }).success).toBe(
      false,
    );
    expect(
      BillingIntentV1Schema.safeParse({
        schema_version: 'billing-intent/1',
        intent_kind: 'RECONCILIATION',
        workspace_id: workspaceId,
        billing_owner_run_id: runId,
        reservation_id: reservationId,
        charge_key: `reconciliation/${runId}`,
        reconciliation_id: gateId,
        release_credits: '9223372036854775807',
        settle_credits: '1',
        evidence_ref: 'object://billing/reconciliation.json',
        evidence_sha256: hashA,
      }).success,
    ).toBe(false);
  });

  it('requires separate exact archive receipts and ordered retention horizons', () => {
    expect(ArchiveManifestV1Schema.safeParse(manifest).success).toBe(true);
    expect(ArchiveVerificationReceiptV1Schema.safeParse(verificationReceipt).success).toBe(true);
    expect(ArchiveApprovalReceiptV1Schema.safeParse(approvalReceipt).success).toBe(true);

    const evidence = {
      schema_version: 'run-archive-evidence/1',
      manifest,
      verification_receipt: verificationReceipt,
      approval_receipt: approvalReceipt,
    } as const;
    expect(RunArchiveEvidenceV1Schema.safeParse(evidence).success).toBe(true);
    expect(RunArchiveEvidenceV1Schema.safeParse({ ...evidence, verified: true }).success).toBe(
      false,
    );
    expect(
      RunArchiveEvidenceV1Schema.safeParse({
        ...evidence,
        verification_receipt: { ...verificationReceipt, archive_sha256: hashC },
      }).success,
    ).toBe(false);

    const horizons = {
      schema_version: 'run-retention-horizons/1',
      workspace_id: workspaceId,
      run_id: runId,
      finished_at: '2026-08-01T00:00:00.000Z',
      events_retention_until: '2026-08-08T00:00:00.000Z',
      recovery_retention_until: '2026-08-31T00:00:00.000Z',
      retention_until: '2026-09-30T00:00:00.000Z',
    } as const;
    expect(RunRetentionHorizonsV1Schema.safeParse(horizons).success).toBe(true);
    expect(
      RunRetentionHorizonsV1Schema.safeParse({
        ...horizons,
        recovery_retention_until: '2026-08-07T00:00:00.000Z',
      }).success,
    ).toBe(false);

    const eventPurgeReceipt = {
      schema_version: 'run-retention-purge-receipt/1',
      purge_receipt_id: '018f47f2-c541-7cc6-9292-4a2c35303e0b',
      workspace_id: workspaceId,
      run_id: runId,
      manifest_id: manifestId,
      material_kind: 'EVENTS',
      purged_checkpoints: '0',
      purged_events: '1',
      purged_outbox: '0',
      financial_ledger_purged: false,
      purged_at: '2026-08-27T00:03:00.000Z',
    } as const;
    expect(RunRetentionPurgeReceiptV1Schema.safeParse(eventPurgeReceipt).success).toBe(true);
    expect(
      RunRetentionPurgeReceiptV1Schema.safeParse({
        ...eventPurgeReceipt,
        purged_checkpoints: '1',
      }).success,
    ).toBe(false);
    expect(
      RunRetentionPurgeReceiptV1Schema.safeParse({
        ...eventPurgeReceipt,
        material_kind: 'RECOVERY',
        purged_events: '1',
      }).success,
    ).toBe(false);
  });
});
