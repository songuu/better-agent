import { describe, expect, it, vi } from 'vitest';

import {
  assertRunStateTransition,
  prepareTerminalSnapshot,
  projectPublicRunStatus,
  projectRunStatus,
} from '../src/index.js';
import { makeAcceptance, runId, workspaceId } from './fixtures.js';

describe('Run state boundaries', () => {
  it('maps scheduling and public states without making projections authoritative', () => {
    expect(projectRunStatus('RECOVERING')).toBe('QUEUED');
    expect(projectRunStatus('CANCELLING')).toBe('CANCEL_REQUESTED');
    expect(projectPublicRunStatus('WAITING_FOR_INPUT')).toBe('RUNNING');
    expect(projectPublicRunStatus('NEEDS_ATTENTION')).toBe('FAILED');
  });

  it('accepts listed edges and rejects illegal or terminal rewrites', () => {
    expect(assertRunStateTransition('QUEUED', 'RUNNING')).toBe('TRANSITION');
    expect(assertRunStateTransition('RUNNING', 'WAITING_FOR_APPROVAL')).toBe('TRANSITION');
    expect(assertRunStateTransition('WAITING_FOR_APPROVAL', 'RESUMING')).toBe('TRANSITION');
    expect(() => assertRunStateTransition('QUEUED', 'SUCCEEDED')).toThrowError(
      /RUN_STATE_TRANSITION_INVALID/,
    );
    expect(() => assertRunStateTransition('SUCCEEDED', 'FAILED')).toThrowError(
      /RUN_TERMINAL_IMMUTABLE/,
    );
  });
});

describe('terminal snapshot preparation', () => {
  const current = {
    schema_version: 'run-snapshot/1',
    workspace_id: workspaceId,
    run_id: runId,
    status: 'RUNNING',
    execution_status: 'RUNNING',
    billing_state: 'PENDING',
  } as const;

  it('refuses SUCCEEDED until a registry-backed output validator is supplied', () => {
    expect(() =>
      prepareTerminalSnapshot({
        current,
        acceptance: makeAcceptance(),
        termination_reason: 'COMPLETED',
        finished_at: '2026-08-27T00:00:00Z',
        result_redacted: { answer: 'ok' },
        billing_settled_at: '2026-08-27T00:00:00Z',
      }),
    ).toThrowError(/RUN_OUTPUT_VALIDATOR_UNAVAILABLE/);

    const validateOutput = vi.fn(() => true);
    const terminal = prepareTerminalSnapshot({
      current,
      acceptance: makeAcceptance(),
      termination_reason: 'COMPLETED',
      finished_at: '2026-08-27T00:00:00Z',
      result_redacted: { answer: 'ok' },
      billing_settled_at: '2026-08-27T00:00:00Z',
      validate_output: validateOutput,
    });
    expect(terminal.status).toBe('SUCCEEDED');
    expect(terminal.billing_state).toBe('SETTLED');
    expect(validateOutput).toHaveBeenCalledWith({
      schema_ref: 'registry://agent-output/1',
      schema_hash: makeAcceptance().accepted_output_schema_hash,
      result: { answer: 'ok' },
    });
  });

  it('validates and returns the same deeply frozen canonical result clone', () => {
    const callerResult = {
      nested: { answer: 'ok' },
      items: [{ value: 1 }],
    };
    let validatedResult: Record<string, unknown> | undefined;
    let validatorMutationSucceeded: boolean | undefined;

    const terminal = prepareTerminalSnapshot({
      current,
      acceptance: makeAcceptance(),
      termination_reason: 'COMPLETED',
      finished_at: '2026-08-27T00:00:00Z',
      result_redacted: callerResult,
      billing_settled_at: '2026-08-27T00:00:00Z',
      validate_output: ({ result }) => {
        validatedResult = result;
        validatorMutationSucceeded = Reflect.set(
          result.nested as Record<string, unknown>,
          'answer',
          'validator-tampered',
        );
        return true;
      },
    });

    const terminalResult = terminal.terminal_result_redacted as unknown as {
      nested: Record<string, unknown>;
      items: readonly Record<string, unknown>[];
    };
    expect(validatorMutationSucceeded).toBe(false);
    expect(validatedResult).toBe(terminalResult);
    expect(terminalResult.nested.answer).toBe('ok');
    expect(terminalResult).not.toBe(callerResult);
    expect(Object.isFrozen(terminalResult)).toBe(true);
    expect(Object.isFrozen(terminalResult.nested)).toBe(true);
    expect(Object.isFrozen(terminalResult.items)).toBe(true);
    expect(Object.isFrozen(terminalResult.items[0])).toBe(true);

    callerResult.nested.answer = 'caller-tampered';
    expect(terminalResult.nested.answer).toBe('ok');
    expect(Reflect.set(terminalResult.nested, 'answer', 'post-return-tampered')).toBe(false);
    expect(terminalResult.nested.answer).toBe('ok');
  });

  it('does not let terminal preparation bypass the Run transition graph', () => {
    expect(() =>
      prepareTerminalSnapshot({
        current: { ...current, status: 'QUEUED', execution_status: 'QUEUED' },
        acceptance: makeAcceptance(),
        termination_reason: 'COMPLETED',
        finished_at: '2026-08-27T00:00:00Z',
        result_redacted: { answer: 'ok' },
        billing_settled_at: '2026-08-27T00:00:00Z',
        validate_output: () => true,
      }),
    ).toThrowError(/RUN_STATE_TRANSITION_INVALID/);
  });

  it('requires ordinary terminal settlement to occur at the same instant as finalization', () => {
    expect(() =>
      prepareTerminalSnapshot({
        current,
        acceptance: makeAcceptance(),
        termination_reason: 'INTERNAL_FAILURE',
        finished_at: '2026-08-27T00:00:00Z',
        billing_settled_at: '2026-08-27T00:00:01Z',
      }),
    ).toThrowError(/RUN_STATE_INVALID/);

    const sameInstant = prepareTerminalSnapshot({
      current,
      acceptance: makeAcceptance(),
      termination_reason: 'INTERNAL_FAILURE',
      finished_at: '2026-08-27T00:00:00Z',
      billing_settled_at: '2026-08-27T08:00:00+08:00',
    });
    expect(sameInstant.billing_settled_at).toBe('2026-08-27T08:00:00+08:00');
  });

  it('compares terminal settlement instants at PostgreSQL microsecond precision', () => {
    expect(() =>
      prepareTerminalSnapshot({
        current,
        acceptance: makeAcceptance(),
        termination_reason: 'INTERNAL_FAILURE',
        finished_at: '2026-08-27T00:00:00.000001Z',
        billing_settled_at: '2026-08-27T00:00:00.000002Z',
      }),
    ).toThrowError(/RUN_STATE_INVALID/);

    const sameInstant = prepareTerminalSnapshot({
      current,
      acceptance: makeAcceptance(),
      termination_reason: 'INTERNAL_FAILURE',
      finished_at: '2026-08-27T00:00:00.123456Z',
      billing_settled_at: '2026-08-27T08:00:00.123456+08:00',
    });
    expect(sameInstant.billing_settled_at).toBe('2026-08-27T08:00:00.123456+08:00');
  });

  it('rejects terminal timestamps beyond PostgreSQL microsecond precision', () => {
    expect(() =>
      prepareTerminalSnapshot({
        current,
        acceptance: makeAcceptance(),
        termination_reason: 'INTERNAL_FAILURE',
        finished_at: '2026-08-27T00:00:00.0000001Z',
        billing_settled_at: '2026-08-27T00:00:00.0000001Z',
      }),
    ).toThrowError(/RUN_STATE_INVALID/);
  });

  it.each([
    '2026-08-27T00:00:00+16:00',
    '2026-08-27T00:00:00+23:59',
    '2026-08-27T00:00:00-16:00',
    '0000-01-01T00:00:00Z',
  ])('rejects terminal timestamp %s outside the PostgreSQL timestamptz input domain', (value) => {
    expect(() =>
      prepareTerminalSnapshot({
        current,
        acceptance: makeAcceptance(),
        termination_reason: 'SIDE_EFFECT_UNKNOWN',
        finished_at: value,
      }),
    ).toThrowError(/RUN_STATE_INVALID/);
  });

  it.each(['1970-01-01T15:58:59.999999+15:59', '1969-12-31T08:00:59.999999-15:59'])(
    'accepts PostgreSQL maximum numeric offset boundary %s',
    (billingSettledAt) => {
      const terminal = prepareTerminalSnapshot({
        current,
        acceptance: makeAcceptance(),
        termination_reason: 'INTERNAL_FAILURE',
        finished_at: '1969-12-31T23:59:59.999999Z',
        billing_settled_at: billingSettledAt,
      });

      expect(terminal.billing_settled_at).toBe(billingSettledAt);
    },
  );

  it.each(['0001-01-01T00:00:00Z', '9999-12-31T23:59:59.999999Z'])(
    'accepts supported PostgreSQL ISO year boundary %s',
    (finishedAt) => {
      const terminal = prepareTerminalSnapshot({
        current,
        acceptance: makeAcceptance(),
        termination_reason: 'SIDE_EFFECT_UNKNOWN',
        finished_at: finishedAt,
      });

      expect(terminal.finished_at).toBe(finishedAt);
    },
  );

  it('maps SIDE_EFFECT_UNKNOWN only to internal and billing NEEDS_ATTENTION', () => {
    const terminal = prepareTerminalSnapshot({
      current,
      acceptance: makeAcceptance(),
      termination_reason: 'SIDE_EFFECT_UNKNOWN',
      finished_at: '2026-08-27T00:00:00Z',
    });

    expect(terminal).toMatchObject({
      status: 'NEEDS_ATTENTION',
      execution_status: 'NEEDS_ATTENTION',
      billing_state: 'NEEDS_ATTENTION',
      terminal_billing_pending: false,
      terminal_error_redacted: {
        code: 'SIDE_EFFECT_UNKNOWN',
        retryable: false,
        category: 'EXECUTION',
        requires_operator_action: true,
      },
    });
    expect(projectPublicRunStatus(terminal.status)).toBe('FAILED');
  });

  it('does not permit a second terminal intent', () => {
    const terminal = {
      ...current,
      status: 'FAILED',
      execution_status: 'FAILED',
      termination_reason: 'INTERNAL_FAILURE',
      finished_at: '2026-08-27T00:00:00Z',
      terminal_billing_pending: false,
      terminal_billing_pending_at: '2026-08-27T00:00:00Z',
      terminal_error_redacted: {
        code: 'INTERNAL_FAILURE',
        retryable: false,
        category: 'EXECUTION',
      },
      billing_state: 'SETTLED',
      billing_settled_at: '2026-08-27T00:00:00Z',
    } as const;
    expect(() =>
      prepareTerminalSnapshot({
        current: terminal,
        acceptance: makeAcceptance(),
        termination_reason: 'USER_CANCELLED',
        finished_at: '2026-08-27T00:01:00Z',
        billing_settled_at: '2026-08-27T00:01:00Z',
      }),
    ).toThrowError(/RUN_TERMINAL_IMMUTABLE/);
  });

  it('keeps HumanGate-derived terminal mutation unavailable without a published disposition', () => {
    expect(() =>
      prepareTerminalSnapshot({
        current,
        acceptance: makeAcceptance(),
        termination_reason: 'HUMAN_REJECTED',
        finished_at: '2026-08-27T00:00:00Z',
        billing_settled_at: '2026-08-27T00:00:00Z',
      }),
    ).toThrowError(/RUN_HUMAN_GATE_APPLY_UNAVAILABLE/);
  });
});
