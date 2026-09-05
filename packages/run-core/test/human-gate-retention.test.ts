import { describe, expect, it } from 'vitest';

import { canonicalSha256 } from '@better-agent/release-core';
import { applyHumanGateMutation, evaluateRunRetentionEligibility } from '../src/index.js';
import {
  archiveEvidence,
  eventsPurgeReceipt,
  retentionHorizons,
  runId,
  workspaceId,
} from './fixtures.js';

describe('HumanGate execution boundary', () => {
  const gate = {
    schema_version: 'human-gate-instance/1' as const,
    gate_id: '018f47f2-c541-7cc6-9292-4a2c35304001',
    workspace_id: workspaceId,
    run_id: runId,
    checkpoint_id: '018f47f2-c541-7cc6-9292-4a2c35304002',
    gate_type: 'approval' as const,
    resolved_plan_hash: `sha256:${'a'.repeat(64)}`,
    canonical_operation_hash: `sha256:${'b'.repeat(64)}`,
    public_schema: {},
    approver_policy_id: 'workspace-admin',
    status: 'PENDING' as const,
    barrier_generation: 1,
    expires_at: '2026-01-02T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };

  it('atomically claims and approves an exact live Gate', () => {
    const decision = { action: 'APPROVE', reason: 'reviewed' };
    const result = applyHumanGateMutation({
      gate,
      expected_plan_hash: gate.resolved_plan_hash,
      expected_operation_hash: gate.canonical_operation_hash,
      action: 'APPROVE',
      actor: 'user:reviewer',
      claim_ref: 'gate-claim://1',
      claim: { actor: 'user:reviewer' },
      decision_ref: 'gate-decision://1',
      decision,
      now: '2026-01-01T01:00:00.000Z',
    });
    expect(result.replayed).toBe(false);
    expect(result.gate).toMatchObject({ status: 'APPROVED', claimed_by: 'user:reviewer' });
    expect(result.gate.decision_sha256).toBe(canonicalSha256(decision));
  });

  it('replays the exact decision and rejects expiry or semantic drift', () => {
    const input = {
      gate,
      expected_plan_hash: gate.resolved_plan_hash,
      expected_operation_hash: gate.canonical_operation_hash,
      action: 'REJECT' as const,
      actor: 'user:reviewer',
      claim_ref: 'gate-claim://2',
      claim: { actor: 'user:reviewer' },
      decision_ref: 'gate-decision://2',
      decision: { action: 'REJECT', reason: 'unsafe' },
      now: '2026-01-01T01:00:00.000Z',
    };
    const first = applyHumanGateMutation(input);
    expect(applyHumanGateMutation({ ...input, gate: first.gate }).replayed).toBe(true);
    expect(() =>
      applyHumanGateMutation({ ...input, expected_plan_hash: `sha256:${'c'.repeat(64)}` }),
    ).toThrowError(/RUN_HUMAN_GATE_INVALID/);
    expect(() => applyHumanGateMutation({ ...input, now: gate.expires_at })).toThrowError(
      /RUN_HUMAN_GATE_EXPIRED/,
    );
    expect(() => applyHumanGateMutation({ ...input, extra: true } as never)).toThrowError(
      /RUN_HUMAN_GATE_INVALID/,
    );
    expect(() =>
      applyHumanGateMutation({
        ...input,
        gate: first.gate,
        decision: { action: 'REJECT', reason: 'changed' },
      }),
    ).toThrowError(/RUN_HUMAN_GATE_CONFLICT/);
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
