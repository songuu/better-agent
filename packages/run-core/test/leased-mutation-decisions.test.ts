import { describe, expect, it } from 'vitest';

import {
  decideRunDispatchClaim,
  decideRunDispatchCompletion,
  decideRunDispatchFailure,
  decideRunDispatchRecoveryClaim,
  decideRunDispatchRecoveryFence,
  decideRunDispatchRenewal,
  decideRunDispatchRetirement,
  prepareLeasedEffectEnvelope,
  prepareLeasedEffectReceipt,
  prepareLeasedExecutionCheckpoint,
  prepareLeasedExecutionEvent,
  prepareLeasedTerminationIntent,
  prepareLeasedUsageAttribution,
} from '../src/index.js';
import {
  attemptId,
  checkpointId,
  dispatchRetirementReceiptId,
  effectEnvelopeId,
  effectReceiptId,
  hashA,
  hashB,
  leaseTokenA,
  leaseTokenB,
  outboxMessageId,
  recoveryDispositionId,
  recoveryTicketId,
  runId,
  stepId,
  terminalSourceId,
  workspaceId,
} from './fixtures.js';

const owner = 'ba_execution_login_a';
const startedAt = '2026-08-28T00:00:00Z';
const leaseExpiresAt = '2026-08-28T00:00:30Z';

function runningAttempt(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'run-attempt-lease-state/1',
    workspace_id: workspaceId,
    run_id: runId,
    attempt_id: attemptId,
    attempt_number: 1,
    status: 'RUNNING',
    lease_owner: owner,
    lease_token: leaseTokenA,
    lease_fencing_token: '1',
    lease_expires_at: leaseExpiresAt,
    started_at: startedAt,
    updated_at: startedAt,
    ...overrides,
  };
}

function attemptAuthority(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'run-attempt-lease-authority/1',
    workspace_id: workspaceId,
    run_id: runId,
    attempt_id: attemptId,
    step_id: stepId,
    session_user: owner,
    lease_owner: owner,
    lease_token: leaseTokenA,
    lease_fencing_token: '1',
    lease_expires_at: leaseExpiresAt,
    authorized_at: startedAt,
    ...overrides,
  };
}

function executionEvent(eventKind = 'STEP_STARTED') {
  return {
    schema_version: 'run-event/1',
    event_id: '018f47f2-c541-7cc6-9292-4a2c35303e24',
    workspace_id: workspaceId,
    run_id: runId,
    attempt_id: attemptId,
    step_id: stepId,
    sequence: '3',
    event_kind: eventKind,
    sse_visible: false,
    payload_redacted: {},
    created_at: startedAt,
  };
}

function checkpoint(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'run-execution-checkpoint/1',
    checkpoint_id: checkpointId,
    workspace_id: workspaceId,
    run_id: runId,
    attempt_id: attemptId,
    step_id: stepId,
    checkpoint_sequence: '1',
    checkpoint_ref: 'checkpoint://run/1',
    checkpoint_sha256: hashA,
    producer_session_user: owner,
    lease_owner: owner,
    lease_token: leaseTokenA,
    lease_fencing_token: '1',
    lease_expires_at: leaseExpiresAt,
    authorized_at: startedAt,
    ...overrides,
  };
}

function effectEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'run-retry-effect-envelope/1',
    envelope_id: effectEnvelopeId,
    workspace_id: workspaceId,
    run_id: runId,
    attempt_id: attemptId,
    step_id: stepId,
    accepted_plan_hash: hashA,
    operation_intent_sha256: hashB,
    effect_payload_sha256: hashA,
    effect_class: 'SAFE',
    recovery_decision: 'REPLAY_SAFE',
    created_at: startedAt,
    ...overrides,
  };
}

function effectReceipt(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'run-side-effect-receipt/1',
    effect_receipt_id: effectReceiptId,
    workspace_id: workspaceId,
    run_id: runId,
    attempt_id: attemptId,
    step_id: stepId,
    retry_effect_envelope_id: effectEnvelopeId,
    retry_effect_envelope_sha256: hashA,
    effect_class: 'SAFE',
    outcome: 'CONFIRMED',
    external_receipt_ref: 'provider://receipt/1',
    external_receipt_sha256: hashB,
    result_payload_sha256: hashA,
    producer_session_user: owner,
    lease_owner: owner,
    lease_token: leaseTokenA,
    lease_fencing_token: '1',
    lease_expires_at: leaseExpiresAt,
    authorized_at: startedAt,
    ...overrides,
  };
}

function terminationIntent(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'run-termination-intent/1',
    termination_intent_id: '018f47f2-c541-7cc6-9292-4a2c35303e25',
    workspace_id: workspaceId,
    billing_owner_run_id: runId,
    run_id: runId,
    reservation_id: '018f47f2-c541-7cc6-9292-4a2c35303e26',
    attempt_id: attemptId,
    step_id: stepId,
    producer_session_user: owner,
    lease_owner: owner,
    lease_token: leaseTokenA,
    lease_fencing_token: '1',
    lease_expires_at: leaseExpiresAt,
    authorized_at: startedAt,
    producer_operation_key: 'worker:termination:request-1',
    terminal_status: 'FAILED',
    termination_reason: 'INTERNAL_FAILURE',
    effect_disposition: 'CLOSED',
    effect_closure_sha256: hashA,
    usage_attribution_ids: [],
    intended_settle_credits: '0',
    settlement_operation_key: 'settle:termination:1',
    intended_release_credits: '1',
    release_operation_key: 'release:termination:1',
    release_reason_code: 'INTERNAL_FAILURE',
    operation_intent_sha256: hashB,
    consumption_generation: '1',
    ...overrides,
  };
}

function pendingDispatch(overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: workspaceId,
    run_id: runId,
    outbox_id: outboxMessageId,
    message_type: 'RUN_DISPATCH',
    status: 'PENDING',
    delivery_generation: '1',
    updated_at: startedAt,
    ...overrides,
  };
}

function leasedDispatch(overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: workspaceId,
    run_id: runId,
    outbox_id: outboxMessageId,
    message_type: 'RUN_DISPATCH',
    status: 'LEASED',
    delivery_generation: '2',
    lease_owner: owner,
    lease_token: leaseTokenB,
    lease_fencing_token: '2',
    lease_expires_at: leaseExpiresAt,
    updated_at: startedAt,
    ...overrides,
  };
}

function dispatchAuthority(overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: workspaceId,
    run_id: runId,
    outbox_id: outboxMessageId,
    message_type: 'RUN_DISPATCH',
    session_user: owner,
    lease_owner: owner,
    lease_token: leaseTokenB,
    lease_fencing_token: '2',
    delivery_generation: '2',
    lease_expires_at: leaseExpiresAt,
    authorized_at: startedAt,
    ...overrides,
  };
}

const terminalSource = {
  kind: 'DURABLE_CANCEL',
  id: terminalSourceId,
  sha256: hashA,
  terminal_intent_sha256: hashB,
} as const;

describe('leased execution persistence intents', () => {
  it.each([
    'RUN_STARTED',
    'RUN_RETRY_WAIT',
    'RUN_RECOVERING',
    'ATTEMPT_LEASED',
    'ATTEMPT_FINISHED',
    'STEP_STARTED',
    'STEP_FINISHED',
  ])('allows only execution progress event %s', (eventKind) => {
    expect(
      prepareLeasedExecutionEvent({
        current: runningAttempt(),
        authority: attemptAuthority(),
        database: { now: startedAt, session_user: owner },
        event: executionEvent(eventKind),
      }).event.event_kind,
    ).toBe(eventKind);
  });

  it.each([
    'RUN_ACCEPTED',
    'RUN_QUEUED',
    'RUN_FINISHED',
    'CREDIT_RESERVED',
    'CREDIT_SETTLED',
    'OUTBOX_ENQUEUED',
    'SSE_TASK',
  ])('rejects non-execution event %s', (eventKind) => {
    expect(() =>
      prepareLeasedExecutionEvent({
        current: runningAttempt(),
        authority: attemptAuthority(),
        database: { now: startedAt, session_user: owner },
        event: executionEvent(eventKind),
      }),
    ).toThrowError(/RUN_LEASED_MUTATION_INVALID/);
  });

  it('binds checkpoints and both effect stages to the exact current lease authority', () => {
    const preparedCheckpoint = prepareLeasedExecutionCheckpoint({
      current: runningAttempt(),
      authority: attemptAuthority(),
      database: { now: startedAt, session_user: owner },
      checkpoint: checkpoint(),
    });
    expect(preparedCheckpoint.checkpoint).toEqual(checkpoint());
    expect(preparedCheckpoint.checkpoint.checkpoint_id).toBe(checkpointId);
    expect(
      prepareLeasedEffectEnvelope({
        current: runningAttempt(),
        authority: attemptAuthority(),
        database: { now: startedAt, session_user: owner },
        envelope: effectEnvelope(),
      }).envelope.envelope_id,
    ).toBe(effectEnvelopeId);
    expect(
      prepareLeasedEffectReceipt({
        current: runningAttempt(),
        authority: attemptAuthority(),
        database: { now: startedAt, session_user: owner },
        receipt: effectReceipt(),
      }).receipt.effect_receipt_id,
    ).toBe(effectReceiptId);

    for (const mutation of [
      () =>
        prepareLeasedExecutionCheckpoint({
          current: runningAttempt(),
          authority: attemptAuthority(),
          database: { now: startedAt, session_user: 'ba_execution_login_b' },
          checkpoint: checkpoint(),
        }),
      () =>
        prepareLeasedExecutionCheckpoint({
          current: runningAttempt(),
          authority: attemptAuthority(),
          database: { now: startedAt, session_user: owner },
          checkpoint: checkpoint({ lease_fencing_token: '2' }),
        }),
      () =>
        prepareLeasedEffectEnvelope({
          current: runningAttempt(),
          authority: attemptAuthority(),
          database: { now: startedAt, session_user: owner },
          envelope: effectEnvelope({ step_id: '018f47f2-c541-7cc6-9292-4a2c35303eff' }),
        }),
      () =>
        prepareLeasedEffectReceipt({
          current: runningAttempt(),
          authority: attemptAuthority(),
          database: { now: startedAt, session_user: owner },
          receipt: effectReceipt({ attempt_id: '018f47f2-c541-7cc6-9292-4a2c35303eff' }),
        }),
    ]) {
      expect(mutation).toThrowError(/RUN_(LEASE_AUTHORITY_MISMATCH|LEASED_MUTATION_INVALID)/);
    }
  });

  it('rejects an invalid effect envelope contract or a pre-call fact from another database instant', () => {
    expect(() =>
      prepareLeasedEffectEnvelope({
        current: runningAttempt(),
        authority: attemptAuthority(),
        database: { now: startedAt, session_user: owner },
        envelope: effectEnvelope({
          effect_class: 'REQUIRES_KEY',
          recovery_decision: 'REPLAY_WITH_KEY',
        }),
      }),
    ).toThrowError(/RUN_LEASED_MUTATION_INVALID/);
    expect(() =>
      prepareLeasedEffectEnvelope({
        current: runningAttempt(),
        authority: attemptAuthority(),
        database: { now: startedAt, session_user: owner },
        envelope: effectEnvelope({ created_at: '2026-08-28T00:00:01Z' }),
      }),
    ).toThrowError(/RUN_LEASED_MUTATION_INVALID/);
  });

  it('keeps effect receipt outcome closure aligned with the frozen domain contract', () => {
    expect(
      prepareLeasedEffectReceipt({
        current: runningAttempt(),
        authority: attemptAuthority(),
        database: { now: startedAt, session_user: owner },
        receipt: effectReceipt({
          outcome: 'UNKNOWN',
          external_receipt_ref: undefined,
          external_receipt_sha256: undefined,
          unknown_reason_code: 'PROVIDER_RESPONSE_LOST',
        }),
      }).receipt.outcome,
    ).toBe('UNKNOWN');

    for (const receipt of [
      effectReceipt({ unknown_reason_code: 'CONTRADICTS_CONFIRMED' }),
      effectReceipt({ result_payload_sha256: undefined }),
    ]) {
      expect(() =>
        prepareLeasedEffectReceipt({
          current: runningAttempt(),
          authority: attemptAuthority(),
          database: { now: startedAt, session_user: owner },
          receipt,
        }),
      ).toThrowError(/RUN_LEASED_MUTATION_INVALID/);
    }
  });

  it('accepts only a strict CLOSED termination fact and rejects the unsupported timeout vocabulary', () => {
    expect(
      prepareLeasedTerminationIntent({
        current: runningAttempt(),
        authority: attemptAuthority(),
        database: { now: startedAt, session_user: owner },
        termination_intent: terminationIntent(),
      }).termination_intent.terminal_status,
    ).toBe('FAILED');
    expect(() =>
      prepareLeasedTerminationIntent({
        current: runningAttempt(),
        authority: attemptAuthority(),
        database: { now: startedAt, session_user: owner },
        termination_intent: terminationIntent({
          terminal_status: 'TIMED_OUT',
          termination_reason: 'RUN_TIMED_OUT',
        }),
      }),
    ).toThrowError(/RUN_LEASED_MUTATION_INVALID/);
  });

  it('keeps stable producer operation keys in usage and termination persistence intents', () => {
    const attribution = {
      schema_version: 'run-usage-attribution/1',
      usage_attribution_id: '018f47f2-c541-7cc6-9292-4a2c35303e23',
      workspace_id: workspaceId,
      billing_owner_run_id: runId,
      run_id: runId,
      reservation_id: '018f47f2-c541-7cc6-9292-4a2c35303e26',
      attempt_id: attemptId,
      step_id: stepId,
      producer_session_user: owner,
      lease_owner: owner,
      lease_token: leaseTokenA,
      lease_fencing_token: '1',
      lease_expires_at: leaseExpiresAt,
      authorized_at: startedAt,
      producer_operation_key: 'worker:usage:request-1',
      metering_unit: 'tokens',
      metering_quantity: '12',
      amount_credits: '3',
      settlement_operation_key: 'settle:usage:1',
      operation_intent_sha256: hashA,
      execution_effect_payload_sha256: hashB,
      consumption_generation: '1',
    } as const;
    expect(
      prepareLeasedUsageAttribution({
        current: runningAttempt(),
        authority: attemptAuthority(),
        database: { now: startedAt, session_user: owner },
        attribution,
      }).attribution.producer_operation_key,
    ).toBe('worker:usage:request-1');
    expect(
      prepareLeasedTerminationIntent({
        current: runningAttempt(),
        authority: attemptAuthority(),
        database: { now: startedAt, session_user: owner },
        termination_intent: terminationIntent(),
      }).termination_intent.producer_operation_key,
    ).toBe('worker:termination:request-1');
  });
});

describe('RUN_DISPATCH lease decisions', () => {
  it('claims the SQL initial PENDING generation zero as generation one', () => {
    const claimed = decideRunDispatchClaim({
      current: pendingDispatch({ delivery_generation: '0' }),
      run_is_terminal: false,
      duration_seconds: 30,
      database: {
        now: startedAt,
        session_user: owner,
        lease_token: leaseTokenB,
        lease_expires_at: leaseExpiresAt,
      },
    });

    expect(claimed.next_state).toMatchObject({
      status: 'LEASED',
      delivery_generation: '1',
      lease_fencing_token: '1',
    });
    expect(claimed.authority).toMatchObject({
      delivery_generation: '1',
      lease_fencing_token: '1',
    });
  });

  it('claims, renews, and completes only one nonterminal RUN_DISPATCH generation', () => {
    const claimed = decideRunDispatchClaim({
      current: pendingDispatch(),
      run_is_terminal: false,
      duration_seconds: 30,
      database: {
        now: startedAt,
        session_user: owner,
        lease_token: leaseTokenB,
        lease_expires_at: leaseExpiresAt,
      },
    });
    expect(claimed.next_state).toMatchObject({
      status: 'LEASED',
      delivery_generation: '2',
      lease_fencing_token: '2',
    });

    const renewed = decideRunDispatchRenewal({
      current: claimed.next_state,
      authority: dispatchAuthority({ authorized_at: '2026-08-28T00:00:10Z' }),
      duration_seconds: 30,
      run_is_terminal: false,
      database: {
        now: '2026-08-28T00:00:10Z',
        session_user: owner,
        lease_expires_at: '2026-08-28T00:00:40Z',
      },
    });
    expect(renewed.next_state.lease_expires_at).toBe('2026-08-28T00:00:40Z');

    const completed = decideRunDispatchCompletion({
      current: claimed.next_state,
      authority: dispatchAuthority({ authorized_at: '2026-08-28T00:00:10Z' }),
      run_is_terminal: false,
      database: { now: '2026-08-28T00:00:10Z', session_user: owner },
    });
    expect(completed.next_state).toMatchObject({
      status: 'DELIVERED',
      delivery_generation: '2',
      delivered_at: '2026-08-28T00:00:10Z',
    });
    expect(completed.next_state).not.toHaveProperty('lease_token');
    expect(() =>
      decideRunDispatchCompletion({
        current: completed.next_state,
        authority: dispatchAuthority({ authorized_at: '2026-08-28T00:00:10Z' }),
        run_is_terminal: false,
        database: { now: '2026-08-28T00:00:10Z', session_user: owner },
      }),
    ).toThrowError(/RUN_DISPATCH_INVALID/);
  });

  it('rejects terminal runs, non-dispatch messages, stolen tuples, expiry, and fence-domain mixing', () => {
    expect(() =>
      decideRunDispatchClaim({
        current: pendingDispatch(),
        run_is_terminal: true,
        duration_seconds: 30,
        database: {
          now: startedAt,
          session_user: owner,
          lease_token: leaseTokenB,
          lease_expires_at: leaseExpiresAt,
        },
      }),
    ).toThrowError(/RUN_DISPATCH_INVALID/);
    expect(() =>
      decideRunDispatchClaim({
        current: pendingDispatch({ message_type: 'SSE_WAKE' }),
        run_is_terminal: false,
        duration_seconds: 30,
        database: {
          now: startedAt,
          session_user: owner,
          lease_token: leaseTokenB,
          lease_expires_at: leaseExpiresAt,
        },
      }),
    ).toThrowError(/RUN_DISPATCH_INVALID/);
    expect(() =>
      decideRunDispatchCompletion({
        current: leasedDispatch(),
        authority: dispatchAuthority({ session_user: 'ba_execution_login_b' }),
        run_is_terminal: false,
        database: { now: startedAt, session_user: 'ba_execution_login_b' },
      }),
    ).toThrowError(/RUN_DISPATCH_INVALID/);
    expect(() =>
      decideRunDispatchCompletion({
        current: leasedDispatch(),
        authority: dispatchAuthority({ authorized_at: leaseExpiresAt }),
        run_is_terminal: false,
        database: { now: leaseExpiresAt, session_user: owner },
      }),
    ).toThrowError(/RUN_DISPATCH_INVALID/);
    expect(() =>
      decideRunDispatchCompletion({
        current: leasedDispatch(),
        authority: attemptAuthority(),
        run_is_terminal: false,
        database: { now: startedAt, session_user: owner },
      }),
    ).toThrowError(/RUN_DISPATCH_INVALID/);
  });

  it('fails or recovery-fences a dispatch without leaving a live lease', () => {
    const failed = decideRunDispatchFailure({
      current: leasedDispatch(),
      authority: dispatchAuthority(),
      run_is_terminal: false,
      disposition: 'RETRY',
      error_code: 'DELIVERY_FAILED',
      database: { now: startedAt, session_user: owner },
    });
    expect(failed.next_state).toMatchObject({ status: 'PENDING', delivery_generation: '2' });
    expect(failed.next_state).not.toHaveProperty('lease_owner');
    expect(() =>
      decideRunDispatchFailure({
        current: leasedDispatch(),
        authority: dispatchAuthority(),
        run_is_terminal: false,
        disposition: 'RETRY',
        error_code: 'DELIVERY_FAILED',
        delivery_failure_evidence_sha256: hashA,
        database: { now: startedAt, session_user: owner },
      }),
    ).toThrowError(/RUN_DISPATCH_INVALID/);
    expect(() =>
      decideRunDispatchFailure({
        current: leasedDispatch(),
        authority: dispatchAuthority(),
        run_is_terminal: false,
        disposition: 'DEAD',
        error_code: 'DELIVERY_ATTEMPTS_EXHAUSTED',
        delivery_failure_evidence_sha256: 'not-a-sha256',
        database: { now: startedAt, session_user: owner },
      }),
    ).toThrowError(/RUN_DISPATCH_INVALID/);
    for (const disposition of ['BOGUS', undefined]) {
      expect(() =>
        decideRunDispatchFailure({
          current: leasedDispatch(),
          authority: dispatchAuthority(),
          run_is_terminal: false,
          disposition: disposition as never,
          error_code: 'DELIVERY_FAILED',
          database: { now: startedAt, session_user: owner },
        }),
      ).toThrowError(/RUN_DISPATCH_INVALID/);
    }
    for (const error_code of ['x'.repeat(201), 'DELIVERY\u0000FAILED']) {
      expect(() =>
        decideRunDispatchFailure({
          current: leasedDispatch(),
          authority: dispatchAuthority(),
          run_is_terminal: false,
          disposition: 'RETRY',
          error_code,
          database: { now: startedAt, session_user: owner },
        }),
      ).toThrowError(/RUN_DISPATCH_INVALID/);
    }

    const recovered = decideRunDispatchRecoveryFence({
      current: leasedDispatch(),
      run_is_terminal: false,
      retry_effect_envelope_id: effectEnvelopeId,
      retry_effect_envelope_sha256: hashA,
      recovery_decision: 'REPLAY_SAFE',
      database: {
        now: leaseExpiresAt,
        recovery_ticket_id: recoveryTicketId,
        created_at: leaseExpiresAt,
      },
    });
    expect(recovered.next_state).toMatchObject({
      status: 'PENDING',
      delivery_generation: '3',
      recovery_ticket_id: recoveryTicketId,
    });
    expect(recovered.recovery_ticket).toMatchObject({
      resource_kind: 'RUN_DISPATCH',
      old_fencing_token: '2',
      new_fencing_token: '3',
    });

    const claimed = decideRunDispatchRecoveryClaim({
      current: recovered.next_state,
      recovery_ticket: recovered.recovery_ticket,
      recovery_ticket_sha256: hashB,
      run_is_terminal: false,
      duration_seconds: 30,
      database: {
        now: leaseExpiresAt,
        session_user: owner,
        lease_token: leaseTokenA,
        lease_expires_at: '2026-08-28T00:01:00Z',
        disposition_id: recoveryDispositionId,
        disposed_at: leaseExpiresAt,
      },
    });
    expect(claimed.next_state).toMatchObject({
      status: 'LEASED',
      delivery_generation: '4',
      lease_fencing_token: '4',
    });
    expect(claimed.disposition).toMatchObject({
      disposition_kind: 'CLAIMED',
      ticket_fencing_token: '3',
      claim_fencing_token: '4',
    });
  });
});

describe('terminal RUN_DISPATCH retirement', () => {
  it('retires PENDING without advancing generation and LEASED with one durable fence', () => {
    const pending = decideRunDispatchRetirement({
      current: pendingDispatch({ delivery_generation: '0' }),
      terminal_source: terminalSource,
      database: { receipt_id: dispatchRetirementReceiptId, retired_at: startedAt },
    });
    expect(pending.next_state).toMatchObject({ status: 'DEAD', delivery_generation: '0' });
    expect(pending.receipt).toMatchObject({
      old_status: 'PENDING',
      old_delivery_generation: '0',
      new_delivery_generation: '0',
    });

    const leased = decideRunDispatchRetirement({
      current: leasedDispatch(),
      terminal_source: terminalSource,
      database: { receipt_id: dispatchRetirementReceiptId, retired_at: startedAt },
    });
    expect(leased.next_state).toMatchObject({ status: 'DEAD', delivery_generation: '3' });
    expect(leased.next_state).not.toHaveProperty('lease_owner');
    expect(leased.receipt).toMatchObject({
      old_status: 'LEASED',
      old_delivery_generation: '2',
      new_delivery_generation: '3',
    });
  });

  it('leaves DELIVERED unchanged and requires exact evidence for DEAD replay', () => {
    const delivered = decideRunDispatchRetirement({
      current: pendingDispatch({
        status: 'DELIVERED',
        delivered_at: startedAt,
      }),
      terminal_source: terminalSource,
      database: { receipt_id: dispatchRetirementReceiptId, retired_at: startedAt },
    });
    expect(delivered.kind).toBe('ALREADY_DELIVERED');

    const first = decideRunDispatchRetirement({
      current: leasedDispatch(),
      terminal_source: terminalSource,
      database: { receipt_id: dispatchRetirementReceiptId, retired_at: startedAt },
    });
    const replay = decideRunDispatchRetirement({
      current: first.next_state,
      terminal_source: terminalSource,
      existing_retirement_receipt: first.receipt,
      database: { receipt_id: dispatchRetirementReceiptId, retired_at: startedAt },
    });
    expect(replay.kind).toBe('REPLAY');
    expect(first.receipt).toBeDefined();
    if (first.receipt === undefined) throw new Error('expected the first retirement receipt');
    const {
      old_lease_owner: _oldLeaseOwner,
      old_lease_token: _oldLeaseToken,
      old_lease_fencing_token: _oldLeaseFence,
      old_lease_expires_at: _oldLeaseExpiry,
      ...receiptWithoutOldLease
    } = first.receipt;
    expect(() =>
      decideRunDispatchRetirement({
        current: first.next_state,
        terminal_source: terminalSource,
        existing_retirement_receipt: {
          ...receiptWithoutOldLease,
          old_status: 'PENDING',
          old_delivery_generation: '3',
          new_delivery_generation: '3',
          retired_at: leaseExpiresAt,
        },
        database: { receipt_id: dispatchRetirementReceiptId, retired_at: leaseExpiresAt },
      }),
    ).toThrowError(/RUN_DISPATCH_RETIREMENT_CONFLICT/);
    expect(() =>
      decideRunDispatchRetirement({
        current: first.next_state,
        terminal_source: terminalSource,
        existing_retirement_receipt: first.receipt,
        database: {
          receipt_id: '018f47f2-c541-7cc6-9292-4a2c35303eff',
          retired_at: startedAt,
        },
      }),
    ).toThrowError(/RUN_DISPATCH_RETIREMENT_CONFLICT/);
    expect(() =>
      decideRunDispatchRetirement({
        current: first.next_state,
        terminal_source: { ...terminalSource, terminal_intent_sha256: hashA },
        existing_retirement_receipt: first.receipt,
        database: { receipt_id: dispatchRetirementReceiptId, retired_at: startedAt },
      }),
    ).toThrowError(/RUN_DISPATCH_RETIREMENT_CONFLICT/);
    expect(() =>
      decideRunDispatchRetirement({
        current: first.next_state,
        terminal_source: terminalSource,
        database: { receipt_id: dispatchRetirementReceiptId, retired_at: startedAt },
      }),
    ).toThrowError(/RUN_DISPATCH_RETIREMENT_CONFLICT/);

    const failed = decideRunDispatchFailure({
      current: leasedDispatch(),
      authority: dispatchAuthority(),
      run_is_terminal: false,
      disposition: 'DEAD',
      error_code: 'DELIVERY_ATTEMPTS_EXHAUSTED',
      delivery_failure_evidence_sha256: hashA,
      database: { now: startedAt, session_user: owner },
    });
    expect(
      decideRunDispatchRetirement({
        current: failed.next_state,
        terminal_source: terminalSource,
        existing_delivery_failure_evidence_sha256: hashA,
        database: { receipt_id: dispatchRetirementReceiptId, retired_at: startedAt },
      }).kind,
    ).toBe('ALREADY_DEAD');
    expect(() =>
      decideRunDispatchRetirement({
        current: failed.next_state,
        terminal_source: terminalSource,
        existing_delivery_failure_evidence_sha256: hashB,
        database: { receipt_id: dispatchRetirementReceiptId, retired_at: startedAt },
      }),
    ).toThrowError(/RUN_DISPATCH_RETIREMENT_CONFLICT/);
    expect(() =>
      decideRunDispatchRetirement({
        current: {
          ...first.next_state,
          delivery_failure_evidence_sha256: hashA,
        },
        terminal_source: terminalSource,
        existing_retirement_receipt: first.receipt,
        existing_delivery_failure_evidence_sha256: hashA,
        database: { receipt_id: dispatchRetirementReceiptId, retired_at: startedAt },
      }),
    ).toThrowError(/RUN_DISPATCH_(INVALID|RETIREMENT_CONFLICT)/);
  });

  it('terminal-retires a pending dispatch recovery ticket in the same intent', () => {
    const recovered = decideRunDispatchRecoveryFence({
      current: leasedDispatch(),
      run_is_terminal: false,
      retry_effect_envelope_id: effectEnvelopeId,
      retry_effect_envelope_sha256: hashA,
      recovery_decision: 'REPLAY_SAFE',
      database: {
        now: leaseExpiresAt,
        recovery_ticket_id: recoveryTicketId,
        created_at: leaseExpiresAt,
      },
    });
    const retired = decideRunDispatchRetirement({
      current: recovered.next_state,
      terminal_source: terminalSource,
      recovery_ticket: recovered.recovery_ticket,
      recovery_ticket_sha256: hashB,
      database: {
        receipt_id: dispatchRetirementReceiptId,
        retired_at: leaseExpiresAt,
        recovery_disposition_id: recoveryDispositionId,
      },
    });
    expect(retired.next_state).toMatchObject({ status: 'DEAD', delivery_generation: '3' });
    expect(retired.next_state.recovery_ticket_id).toBe(recoveryTicketId);
    expect(retired.recovery_ticket_disposition).toMatchObject({
      disposition_kind: 'TERMINAL_RETIRED',
      resource_kind: 'RUN_DISPATCH',
      terminal_resource_status: 'DEAD',
    });
  });

  it('fails closed before overflowing a LEASED delivery generation', () => {
    expect(() =>
      decideRunDispatchRetirement({
        current: leasedDispatch({
          delivery_generation: '9007199254740991',
          lease_fencing_token: '9007199254740991',
        }),
        terminal_source: terminalSource,
        database: { receipt_id: dispatchRetirementReceiptId, retired_at: startedAt },
      }),
    ).toThrowError(/RUN_LEASE_FENCING_OVERFLOW/);
  });
});
