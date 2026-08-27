import { describe, expect, it } from 'vitest';

import { applyHumanGateMutation, evaluateRunRetentionEligibility } from '../src/index.js';
import {
  archiveEvidence,
  eventsPurgeReceipt,
  retentionHorizons,
  runId,
  workspaceId,
} from './fixtures.js';

describe('HumanGate execution boundary', () => {
  it('keeps every positive apply path unavailable in G0-06', () => {
    expect(() => applyHumanGateMutation({ action: 'APPROVE' })).toThrowError(
      /RUN_HUMAN_GATE_APPLY_UNAVAILABLE/,
    );
  });
});

describe('retention eligibility', () => {
  const eligibleEventsInput = {
    material_kind: 'EVENTS',
    workspace_id: workspaceId,
    run_id: runId,
    run_status: 'SUCCEEDED',
    billing_state: 'SETTLED',
    now: '2026-01-10T00:00:00Z',
    horizons: retentionHorizons,
    archive_evidence: archiveEvidence,
    existing_purge_receipts: [],
    reconciliation_evidence_present: false,
    held_reservation_present: false,
    pending_or_leased_outbox_present: false,
  } as const;

  it('uses the EVENTS horizon without waiting for RECOVERY', () => {
    expect(evaluateRunRetentionEligibility(eligibleEventsInput)).toEqual({
      eligible: true,
      material_kind: 'EVENTS',
    });
    expect(
      evaluateRunRetentionEligibility({
        ...eligibleEventsInput,
        material_kind: 'RECOVERY',
      }),
    ).toEqual({ eligible: false, reason: 'HORIZON_NOT_REACHED' });
  });

  it('rejects unsettled, missing evidence and duplicate purge receipts', () => {
    expect(
      evaluateRunRetentionEligibility({ ...eligibleEventsInput, billing_state: 'PENDING' }),
    ).toEqual({ eligible: false, reason: 'BILLING_NOT_SETTLED' });
    expect(
      evaluateRunRetentionEligibility({
        ...eligibleEventsInput,
        archive_evidence: undefined,
      }),
    ).toEqual({ eligible: false, reason: 'ARCHIVE_EVIDENCE_MISSING' });
    expect(
      evaluateRunRetentionEligibility({
        ...eligibleEventsInput,
        existing_purge_receipts: [eventsPurgeReceipt],
      }),
    ).toEqual({ eligible: false, reason: 'PURGE_ALREADY_RECORDED' });
  });

  it('requires reconciliation evidence for an operator-hold terminal Run', () => {
    expect(
      evaluateRunRetentionEligibility({
        ...eligibleEventsInput,
        run_status: 'NEEDS_ATTENTION',
      }),
    ).toEqual({ eligible: false, reason: 'RECONCILIATION_EVIDENCE_MISSING' });
  });

  it('blocks RECOVERY on live billing or delivery state without blocking EVENTS', () => {
    const recoveryInput = {
      ...eligibleEventsInput,
      material_kind: 'RECOVERY',
      now: '2026-03-01T00:00:00Z',
    } as const;

    expect(
      evaluateRunRetentionEligibility({
        ...recoveryInput,
        held_reservation_present: true,
      }),
    ).toEqual({ eligible: false, reason: 'HELD_RESERVATION_PRESENT' });
    expect(
      evaluateRunRetentionEligibility({
        ...recoveryInput,
        pending_or_leased_outbox_present: true,
      }),
    ).toEqual({ eligible: false, reason: 'OUTBOX_DELIVERY_IN_PROGRESS' });
    expect(
      evaluateRunRetentionEligibility({
        ...eligibleEventsInput,
        held_reservation_present: true,
        pending_or_leased_outbox_present: true,
      }),
    ).toEqual({ eligible: true, material_kind: 'EVENTS' });
  });
});
