import type { RunTerminalSnapshotData } from '../src/modules/runs/index.js';

type Assert<T extends true> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type IsNotAssignable<From, To> = IsAssignable<From, To> extends true ? false : true;

interface TerminalIdentityFields {
  readonly run_id: '018f47f2-c541-7cc6-9292-4a2c35303ee6';
  readonly accepted_request_id: '018f47f2-c541-7cc6-9292-4a2c35303ee7';
  readonly last_sequence: '10';
  readonly billing_pending: false;
}

type CommonTerminalFields = TerminalIdentityFields & {
  readonly billing_state: 'SETTLED';
  readonly billing_settled_at: '2026-08-27T00:00:00.000Z';
};

type NeedsAttentionTerminalFields = TerminalIdentityFields & {
  readonly billing_state: 'NEEDS_ATTENTION';
};

type SettledWithoutTimestampTerminalFields = TerminalIdentityFields & {
  readonly billing_state: 'SETTLED';
};

interface StrictExecutionError {
  readonly code: 'INTERNAL_FAILURE';
  readonly retryable: false;
  readonly category: 'EXECUTION';
}

type RunTerminalSnapshotTypeAssertions = [
  Assert<
    IsAssignable<
      CommonTerminalFields & { readonly status: 'SUCCEEDED'; readonly result: { ok: true } },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsAssignable<
      CommonTerminalFields & { readonly status: 'FAILED'; readonly error: StrictExecutionError },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsAssignable<
      CommonTerminalFields & {
        readonly status: 'FAILED';
        readonly error: {
          readonly code: 'SIDE_EFFECT_UNKNOWN';
          readonly retryable: false;
          readonly category: 'EXECUTION';
          readonly requires_operator_action: true;
        };
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      NeedsAttentionTerminalFields & {
        readonly status: 'SUCCEEDED';
        readonly result: { ok: true };
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      NeedsAttentionTerminalFields & {
        readonly status: 'FAILED';
        readonly error: StrictExecutionError;
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      NeedsAttentionTerminalFields & {
        readonly status: 'CANCELLED';
        readonly error: {
          readonly code: 'USER_CANCELLED';
          readonly retryable: false;
          readonly category: 'EXECUTION';
        };
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      NeedsAttentionTerminalFields & {
        readonly status: 'TIMED_OUT';
        readonly error: {
          readonly code: 'RUN_TIMED_OUT';
          readonly retryable: false;
          readonly category: 'EXECUTION';
        };
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      NeedsAttentionTerminalFields & {
        readonly billing_settled_at: '2026-08-27T00:00:00.000Z';
        readonly status: 'FAILED';
        readonly error: {
          readonly code: 'SIDE_EFFECT_UNKNOWN';
          readonly retryable: false;
          readonly category: 'EXECUTION';
          readonly requires_operator_action: true;
        };
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      SettledWithoutTimestampTerminalFields & {
        readonly status: 'SUCCEEDED';
        readonly result: { ok: true };
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      SettledWithoutTimestampTerminalFields & {
        readonly status: 'FAILED';
        readonly error: StrictExecutionError;
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      SettledWithoutTimestampTerminalFields & {
        readonly status: 'FAILED';
        readonly error: {
          readonly code: 'SIDE_EFFECT_UNKNOWN';
          readonly retryable: false;
          readonly category: 'EXECUTION';
          readonly requires_operator_action: true;
        };
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      SettledWithoutTimestampTerminalFields & {
        readonly status: 'CANCELLED';
        readonly error: {
          readonly code: 'USER_CANCELLED';
          readonly retryable: false;
          readonly category: 'EXECUTION';
        };
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      SettledWithoutTimestampTerminalFields & {
        readonly status: 'TIMED_OUT';
        readonly error: {
          readonly code: 'RUN_TIMED_OUT';
          readonly retryable: false;
          readonly category: 'EXECUTION';
        };
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsAssignable<
      NeedsAttentionTerminalFields & {
        readonly status: 'FAILED';
        readonly error: {
          readonly code: 'SIDE_EFFECT_UNKNOWN';
          readonly retryable: false;
          readonly category: 'EXECUTION';
          readonly requires_operator_action: true;
        };
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsAssignable<
      CommonTerminalFields & {
        readonly status: 'CANCELLED';
        readonly error: {
          readonly code: 'USER_CANCELLED';
          readonly retryable: false;
          readonly category: 'EXECUTION';
        };
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsAssignable<
      CommonTerminalFields & {
        readonly status: 'TIMED_OUT';
        readonly error: {
          readonly code: 'RUN_TIMED_OUT';
          readonly retryable: false;
          readonly category: 'EXECUTION';
        };
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      CommonTerminalFields & { readonly status: 'SUCCEEDED' },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      CommonTerminalFields & { readonly status: 'SUCCEEDED'; readonly result: 'not-json-object' },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      CommonTerminalFields & { readonly status: 'SUCCEEDED'; readonly result: readonly [true] },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      CommonTerminalFields & {
        readonly status: 'SUCCEEDED';
        readonly result: { ok: true };
        readonly error: StrictExecutionError;
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      CommonTerminalFields & {
        readonly status: 'CANCELLED';
        readonly error: StrictExecutionError;
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      CommonTerminalFields & {
        readonly status: 'FAILED';
        readonly error: {
          readonly code: 'USER_CANCELLED';
          readonly retryable: false;
          readonly category: 'EXECUTION';
        };
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      CommonTerminalFields & {
        readonly status: 'TIMED_OUT';
        readonly error: StrictExecutionError;
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      CommonTerminalFields & {
        readonly status: 'FAILED';
        readonly error: {
          readonly code: 'INTERNAL_FAILURE';
          readonly retryable: false;
          readonly category: 'EXECUTION';
          readonly requires_operator_action: true;
        };
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      CommonTerminalFields & {
        readonly status: 'FAILED';
        readonly error: {
          readonly code: 'SIDE_EFFECT_UNKNOWN';
          readonly retryable: false;
          readonly category: 'EXECUTION';
        };
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      CommonTerminalFields & {
        readonly status: 'CANCELLED';
        readonly error: {
          readonly code: 'USER_CANCELLED';
          readonly retryable: false;
          readonly category: 'EXECUTION';
          readonly requires_operator_action: true;
        };
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<CommonTerminalFields & { readonly status: 'FAILED' }, RunTerminalSnapshotData>
  >,
  Assert<
    IsNotAssignable<
      CommonTerminalFields & {
        readonly status: 'FAILED';
        readonly result: { ok: true };
        readonly error: StrictExecutionError;
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      CommonTerminalFields & { readonly status: 'CANCELLED' },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      CommonTerminalFields & {
        readonly status: 'CANCELLED';
        readonly error: {
          readonly code: 'USER_CANCELLED';
          readonly retryable: true;
          readonly category: 'EXECUTION';
        };
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      CommonTerminalFields & {
        readonly status: 'FAILED';
        readonly error: {
          readonly code: 'INTERNAL_FAILURE';
          readonly retryable: false;
          readonly category: 'INTERNAL';
        };
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      CommonTerminalFields & {
        readonly status: 'TIMED_OUT';
        readonly error: {
          readonly code: 'RUN_TIMED_OUT';
          readonly retryable: false;
          readonly category: 'EXECUTION';
          readonly requires_operator_action: false;
        };
      },
      RunTerminalSnapshotData
    >
  >,
  Assert<
    IsNotAssignable<
      CommonTerminalFields & {
        readonly status: 'TIMED_OUT';
        readonly result: { ok: true };
        readonly error: StrictExecutionError;
      },
      RunTerminalSnapshotData
    >
  >,
];

export type { RunTerminalSnapshotTypeAssertions };
