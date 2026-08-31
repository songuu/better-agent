import { describe, expect, it } from 'vitest';

import {
  assertRunAttemptLeaseAuthority,
  advanceRunLeaseFencingToken,
  decideRunAttemptClaim,
  decideRunAttemptLeaseRelinquish,
  decideRunAttemptLeaseRenewal,
  decideRunAttemptRecoveryClaim,
  decideRunInitialAttemptTerminalRetirement,
  decideRunRecoveryTicketTerminalRetirement,
} from '../src/index.js';
import {
  attemptId,
  hashA,
  hashB,
  holdIntentId,
  leaseTokenA,
  leaseTokenB,
  recoveryDispositionId,
  recoveryTicketId,
  runId,
  workspaceId,
} from './fixtures.js';

const now = '2026-08-28T00:00:00.000000Z';
const expiresAt = '2026-08-28T00:00:30.000000Z';
const owner = 'ba_execution_login_a';

function pendingAttempt(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'run-attempt-lease-state/1',
    workspace_id: workspaceId,
    run_id: runId,
    attempt_id: attemptId,
    attempt_number: 1,
    status: 'PENDING',
    pending_kind: 'INITIAL',
    updated_at: now,
    ...overrides,
  };
}

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
    lease_expires_at: expiresAt,
    started_at: now,
    updated_at: now,
    ...overrides,
  };
}

function authority(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'run-attempt-lease-authority/1',
    workspace_id: workspaceId,
    run_id: runId,
    attempt_id: attemptId,
    session_user: owner,
    lease_owner: owner,
    lease_token: leaseTokenA,
    lease_fencing_token: '1',
    lease_expires_at: expiresAt,
    authorized_at: now,
    ...overrides,
  };
}

function recoveryTicket(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'run-recovery-ticket/1',
    recovery_ticket_id: recoveryTicketId,
    workspace_id: workspaceId,
    run_id: runId,
    resource_kind: 'ATTEMPT',
    resource_id: attemptId,
    old_fencing_token: '1',
    new_fencing_token: '2',
    created_generation: '2',
    checkpoint_sha256: hashA,
    checkpoint_id: '018f47f2-c541-7cc6-9292-4a2c35303e18',
    effect_decisions: [
      {
        retry_effect_envelope_id: '018f47f2-c541-7cc6-9292-4a2c35303e1c',
        retry_effect_envelope_sha256: hashB,
        effect_class: 'SAFE',
        recovery_decision: 'REPLAY_SAFE',
      },
    ],
    effect_decisions_sha256: hashA,
    created_at: now,
    ...overrides,
  };
}

describe('Attempt lease authority', () => {
  it('claims once with a DB-derived owner/token/expiry and increments the generation', () => {
    const decision = decideRunAttemptClaim({
      current: pendingAttempt(),
      duration_seconds: 30,
      database: {
        now,
        session_user: owner,
        lease_token: leaseTokenA,
        lease_expires_at: expiresAt,
      },
    });

    expect(decision.kind).toBe('CLAIM');
    expect(decision.next_state).toMatchObject({
      status: 'RUNNING',
      lease_owner: owner,
      lease_token: leaseTokenA,
      lease_fencing_token: '1',
      lease_expires_at: expiresAt,
    });
    expect(decision.authority).toMatchObject({
      lease_owner: owner,
      lease_token: leaseTokenA,
      lease_fencing_token: '1',
    });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(() =>
      decideRunAttemptClaim({
        current: decision.next_state,
        duration_seconds: 30,
        database: {
          now,
          session_user: owner,
          lease_token: leaseTokenB,
          lease_expires_at: expiresAt,
        },
      }),
    ).toThrowError(/RUN_LEASE_TRANSITION_INVALID/);
  });

  it('rejects a non-exact duration and safe-integer generation overflow', () => {
    expect(() =>
      decideRunAttemptClaim({
        current: pendingAttempt(),
        duration_seconds: 30,
        database: {
          now,
          session_user: owner,
          lease_token: leaseTokenA,
          lease_expires_at: '2026-08-28T00:00:31Z',
        },
      }),
    ).toThrowError(/RUN_LEASE_INVALID/);
    expect(() =>
      advanceRunLeaseFencingToken('9007199254740991', '$.current.lease_fencing_token'),
    ).toThrowError(/RUN_LEASE_FENCING_OVERFLOW/);
  });

  it('requires the exact active tuple, current session user, and unexpired DB time', () => {
    expect(
      assertRunAttemptLeaseAuthority({
        current: runningAttempt(),
        authority: authority(),
        database: { now, session_user: owner },
      }).lease_token,
    ).toBe(leaseTokenA);

    for (const mismatch of [
      { authority: authority({ run_id: '018f47f2-c541-7cc6-9292-4a2c35303eff' }) },
      { authority: authority({ lease_token: leaseTokenB }) },
      { authority: authority({ lease_fencing_token: '2' }) },
      { database: { now, session_user: 'ba_execution_login_b' } },
    ]) {
      expect(() =>
        assertRunAttemptLeaseAuthority({
          current: runningAttempt(),
          authority: mismatch.authority ?? authority(),
          database: mismatch.database ?? { now, session_user: owner },
        }),
      ).toThrowError(/RUN_LEASE_AUTHORITY_MISMATCH/);
    }

    expect(() =>
      assertRunAttemptLeaseAuthority({
        current: runningAttempt(),
        authority: authority(),
        database: { now: expiresAt, session_user: owner },
      }),
    ).toThrowError(/RUN_LEASE_EXPIRED/);
  });

  it('renews only before expiry, strictly forward, and at most DB now plus five minutes', () => {
    const renewed = decideRunAttemptLeaseRenewal({
      current: runningAttempt(),
      authority: authority({ authorized_at: '2026-08-28T00:00:10Z' }),
      duration_seconds: 60,
      database: {
        now: '2026-08-28T00:00:10Z',
        session_user: owner,
        lease_expires_at: '2026-08-28T00:01:10Z',
      },
    });
    expect(renewed.next_state.lease_expires_at).toBe('2026-08-28T00:01:10Z');

    expect(() =>
      decideRunAttemptLeaseRenewal({
        current: runningAttempt(),
        authority: authority({ authorized_at: '2026-08-28T00:00:10Z' }),
        duration_seconds: 10,
        database: {
          now: '2026-08-28T00:00:10Z',
          session_user: owner,
          lease_expires_at: '2026-08-28T00:00:20Z',
        },
      }),
    ).toThrowError(/RUN_LEASE_TRANSITION_INVALID/);
    expect(() =>
      decideRunAttemptLeaseRenewal({
        current: runningAttempt(),
        authority: authority(),
        duration_seconds: 301,
        database: {
          now: '2026-08-28T00:00:10Z',
          session_user: owner,
          lease_expires_at: '2026-08-28T00:05:11Z',
        },
      }),
    ).toThrowError(/RUN_LEASE_INVALID/);
  });

  it('relinquishes only a CLOSED effect set and otherwise leaves the lease untouched', () => {
    const current = runningAttempt();
    const relinquished = decideRunAttemptLeaseRelinquish({
      current,
      authority: authority(),
      database: { now, session_user: owner },
      effect_closure: { disposition: 'CLOSED', effect_closure_sha256: hashA },
    });
    expect(relinquished.next_state).toMatchObject({
      status: 'RELINQUISHED',
      lease_fencing_token: '1',
    });
    expect(relinquished.next_state).not.toHaveProperty('lease_owner');

    for (const disposition of ['MISSING', 'UNSAFE', 'UNKNOWN'] as const) {
      expect(() =>
        decideRunAttemptLeaseRelinquish({
          current,
          authority: authority(),
          database: { now, session_user: owner },
          effect_closure: { disposition, effect_closure_sha256: hashA },
        }),
      ).toThrowError(/RUN_EFFECT_CLOSURE_UNSAFE/);
      expect(current).toEqual(runningAttempt());
    }
  });

  it('lets either initial claim or terminal retirement win without manufacturing a start or fence', () => {
    const current = pendingAttempt();
    const claimed = decideRunAttemptClaim({
      current,
      duration_seconds: 30,
      database: {
        now,
        session_user: owner,
        lease_token: leaseTokenA,
        lease_expires_at: expiresAt,
      },
    });
    const retired = decideRunInitialAttemptTerminalRetirement({
      current,
      terminal_source: {
        kind: 'DURABLE_CANCEL',
        id: holdIntentId,
        sha256: hashB,
        terminal_intent_sha256: hashA,
      },
      terminal_resource_status: 'CANCELLED',
      database: { retired_at: now },
    });

    expect(retired.next_state).toMatchObject({ status: 'CANCELLED', finished_at: now });
    expect(retired.next_state).not.toHaveProperty('started_at');
    expect(retired.next_state).not.toHaveProperty('lease_fencing_token');
    expect(() =>
      decideRunInitialAttemptTerminalRetirement({
        current,
        terminal_source: {
          kind: 'DURABLE_CANCEL',
          id: holdIntentId,
          sha256: hashB,
          terminal_intent_sha256: hashA,
        },
        terminal_resource_status: 'FAILED',
        database: { retired_at: now },
      }),
    ).toThrowError(/RUN_RECOVERY_INVALID/);
    expect(() =>
      decideRunAttemptClaim({
        current: retired.next_state,
        duration_seconds: 30,
        database: {
          now,
          session_user: owner,
          lease_token: leaseTokenA,
          lease_expires_at: expiresAt,
        },
      }),
    ).toThrowError(/RUN_LEASE_TRANSITION_INVALID/);
    expect(() =>
      decideRunInitialAttemptTerminalRetirement({
        current: claimed.next_state,
        terminal_source: {
          kind: 'DURABLE_CANCEL',
          id: holdIntentId,
          sha256: hashB,
          terminal_intent_sha256: hashA,
        },
        terminal_resource_status: 'CANCELLED',
        database: { retired_at: now },
      }),
    ).toThrowError(/RUN_LEASE_TRANSITION_INVALID/);
  });
});

describe('Attempt recovery ticket disposition', () => {
  it('claims an undisposed exact ticket at N+2 and seals CLAIMED disposition', () => {
    const decision = decideRunAttemptRecoveryClaim({
      current: pendingAttempt({
        pending_kind: 'RECOVERY',
        lease_fencing_token: '2',
        recovery_ticket_id: recoveryTicketId,
        started_at: now,
      }),
      ticket: recoveryTicket(),
      recovery_ticket_sha256: hashB,
      duration_seconds: 30,
      database: {
        now,
        session_user: owner,
        lease_token: leaseTokenB,
        lease_expires_at: expiresAt,
        disposition_id: recoveryDispositionId,
        disposed_at: now,
      },
    });

    expect(decision.next_state).toMatchObject({
      status: 'RUNNING',
      lease_fencing_token: '3',
      lease_owner: owner,
      lease_token: leaseTokenB,
    });
    expect(decision.disposition).toMatchObject({
      disposition_kind: 'CLAIMED',
      recovery_ticket_id: recoveryTicketId,
      claim_fencing_token: '3',
    });
  });

  it('lets one terminal intent retire the ticket and rejects a different replay or stale claim', () => {
    const current = pendingAttempt({
      pending_kind: 'RECOVERY',
      lease_fencing_token: '2',
      recovery_ticket_id: recoveryTicketId,
      started_at: now,
    });
    const first = decideRunRecoveryTicketTerminalRetirement({
      current,
      ticket: recoveryTicket(),
      recovery_ticket_sha256: hashB,
      existing_disposition: undefined,
      terminal_source: {
        kind: 'RECOVERY_HOLD',
        id: holdIntentId,
        sha256: hashB,
        terminal_intent_sha256: hashA,
      },
      terminal_resource_status: 'RELINQUISHED',
      database: { disposition_id: recoveryDispositionId, disposed_at: now },
    });
    expect(first.kind).toBe('RETIRE');
    expect(first.disposition.disposition_kind).toBe('TERMINAL_RETIRED');
    expect(first.next_state.status).toBe('RELINQUISHED');

    const replay = decideRunRecoveryTicketTerminalRetirement({
      current: first.next_state,
      ticket: recoveryTicket(),
      recovery_ticket_sha256: hashB,
      existing_disposition: first.disposition,
      terminal_source: {
        kind: 'RECOVERY_HOLD',
        id: holdIntentId,
        sha256: hashB,
        terminal_intent_sha256: hashA,
      },
      terminal_resource_status: 'RELINQUISHED',
      database: { disposition_id: recoveryDispositionId, disposed_at: now },
    });
    expect(replay.kind).toBe('REPLAY');

    expect(() =>
      decideRunRecoveryTicketTerminalRetirement({
        current: { ...first.next_state, attempt_id: recoveryDispositionId },
        ticket: recoveryTicket(),
        recovery_ticket_sha256: hashB,
        existing_disposition: first.disposition,
        terminal_source: {
          kind: 'RECOVERY_HOLD',
          id: holdIntentId,
          sha256: hashB,
          terminal_intent_sha256: hashA,
        },
        terminal_resource_status: 'RELINQUISHED',
        database: { disposition_id: recoveryDispositionId, disposed_at: now },
      }),
    ).toThrowError(/RUN_RECOVERY_DISPOSITION_CONFLICT/);
    expect(() =>
      decideRunRecoveryTicketTerminalRetirement({
        current: first.next_state,
        ticket: recoveryTicket(),
        recovery_ticket_sha256: hashB,
        existing_disposition: first.disposition,
        terminal_source: {
          kind: 'RECOVERY_HOLD',
          id: holdIntentId,
          sha256: hashB,
          terminal_intent_sha256: hashA,
        },
        terminal_resource_status: 'RELINQUISHED',
        database: {
          disposition_id: '018f47f2-c541-7cc6-9292-4a2c35303eff',
          disposed_at: now,
        },
      }),
    ).toThrowError(/RUN_RECOVERY_DISPOSITION_CONFLICT/);
    expect(() =>
      decideRunRecoveryTicketTerminalRetirement({
        current: first.next_state,
        ticket: recoveryTicket(),
        recovery_ticket_sha256: hashB,
        existing_disposition: first.disposition,
        terminal_source: {
          kind: 'RECOVERY_HOLD',
          id: holdIntentId,
          sha256: hashB,
          terminal_intent_sha256: hashA,
        },
        terminal_resource_status: 'RELINQUISHED',
        database: { disposition_id: recoveryDispositionId, disposed_at: expiresAt },
      }),
    ).toThrowError(/RUN_RECOVERY_DISPOSITION_CONFLICT/);

    expect(() =>
      decideRunRecoveryTicketTerminalRetirement({
        current: first.next_state,
        ticket: recoveryTicket(),
        recovery_ticket_sha256: hashB,
        existing_disposition: first.disposition,
        terminal_source: {
          kind: 'RECOVERY_HOLD',
          id: holdIntentId,
          sha256: hashB,
          terminal_intent_sha256: hashB,
        },
        terminal_resource_status: 'RELINQUISHED',
        database: { disposition_id: recoveryDispositionId, disposed_at: now },
      }),
    ).toThrowError(/RUN_RECOVERY_DISPOSITION_CONFLICT/);

    expect(() =>
      decideRunAttemptRecoveryClaim({
        current,
        ticket: recoveryTicket(),
        recovery_ticket_sha256: hashB,
        existing_disposition: first.disposition,
        duration_seconds: 30,
        database: {
          now,
          session_user: owner,
          lease_token: leaseTokenB,
          lease_expires_at: expiresAt,
          disposition_id: recoveryDispositionId,
          disposed_at: now,
        },
      }),
    ).toThrowError(/RUN_RECOVERY_DISPOSITION_CONFLICT/);

    expect(() =>
      decideRunRecoveryTicketTerminalRetirement({
        current,
        ticket: recoveryTicket(),
        recovery_ticket_sha256: hashB,
        terminal_source: {
          kind: 'RECOVERY_HOLD',
          id: holdIntentId,
          sha256: hashB,
          terminal_intent_sha256: hashA,
        },
        terminal_resource_status: 'CANCELLED',
        database: { disposition_id: recoveryDispositionId, disposed_at: now },
      }),
    ).toThrowError(/RUN_RECOVERY_INVALID/);
    expect(() =>
      decideRunRecoveryTicketTerminalRetirement({
        current,
        ticket: recoveryTicket(),
        recovery_ticket_sha256: hashB,
        terminal_source: {
          kind: 'DURABLE_CANCEL',
          id: holdIntentId,
          sha256: hashB,
          terminal_intent_sha256: hashA,
        },
        terminal_resource_status: 'RELINQUISHED',
        database: { disposition_id: recoveryDispositionId, disposed_at: now },
      }),
    ).toThrowError(/RUN_RECOVERY_INVALID/);
  });
});
