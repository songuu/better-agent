import {
  type PublicRunStatusV1,
  type RunExecutionStatusV1,
  RunExecutionStatusV1Schema,
  type RunStatusV1,
  RunStatusV1Schema,
} from '@better-agent/domain-contracts';

import { failRunCore } from './errors.js';

const schedulingToRunStatus = {
  ACCEPTED: 'QUEUED',
  QUEUED: 'QUEUED',
  RETRY_WAIT: 'QUEUED',
  RECOVERING: 'QUEUED',
  RUNNING: 'RUNNING',
  WAITING_FOR_INPUT: 'WAITING_FOR_INPUT',
  WAITING_FOR_APPROVAL: 'WAITING_FOR_APPROVAL',
  RESUMING: 'RESUMING',
  CANCELLING: 'CANCEL_REQUESTED',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'TIMED_OUT',
  NEEDS_ATTENTION: 'NEEDS_ATTENTION',
} as const satisfies Record<RunExecutionStatusV1, RunStatusV1>;

const publicStatus = {
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  WAITING_FOR_INPUT: 'RUNNING',
  WAITING_FOR_APPROVAL: 'RUNNING',
  RESUMING: 'RUNNING',
  CANCEL_REQUESTED: 'CANCEL_REQUESTED',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  TIMED_OUT: 'TIMED_OUT',
  NEEDS_ATTENTION: 'FAILED',
} as const satisfies Record<RunStatusV1, PublicRunStatusV1>;

const terminalStatuses = new Set<RunStatusV1>([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
  'NEEDS_ATTENTION',
]);

const allowedTransitions: Readonly<Record<RunStatusV1, ReadonlySet<RunStatusV1>>> = {
  QUEUED: new Set([
    'RUNNING',
    'CANCEL_REQUESTED',
    'FAILED',
    'CANCELLED',
    'TIMED_OUT',
    'NEEDS_ATTENTION',
  ]),
  RUNNING: new Set([
    'WAITING_FOR_INPUT',
    'WAITING_FOR_APPROVAL',
    'CANCEL_REQUESTED',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'TIMED_OUT',
    'NEEDS_ATTENTION',
  ]),
  WAITING_FOR_INPUT: new Set([
    'RESUMING',
    'CANCEL_REQUESTED',
    'FAILED',
    'CANCELLED',
    'TIMED_OUT',
    'NEEDS_ATTENTION',
  ]),
  WAITING_FOR_APPROVAL: new Set([
    'RESUMING',
    'CANCEL_REQUESTED',
    'FAILED',
    'CANCELLED',
    'TIMED_OUT',
    'NEEDS_ATTENTION',
  ]),
  RESUMING: new Set([
    'QUEUED',
    'CANCEL_REQUESTED',
    'FAILED',
    'CANCELLED',
    'TIMED_OUT',
    'NEEDS_ATTENTION',
  ]),
  CANCEL_REQUESTED: new Set(['CANCELLED', 'FAILED', 'TIMED_OUT', 'NEEDS_ATTENTION']),
  SUCCEEDED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
  TIMED_OUT: new Set(),
  NEEDS_ATTENTION: new Set(),
};

function readRunStatus(value: unknown, path: string): RunStatusV1 {
  const parsed = RunStatusV1Schema.safeParse(value);
  if (!parsed.success) failRunCore('RUN_STATE_INVALID', path, 'unknown Run status');
  return parsed.data;
}

export function projectRunStatus(executionStatus: RunExecutionStatusV1): RunStatusV1 {
  const parsed = RunExecutionStatusV1Schema.safeParse(executionStatus);
  if (!parsed.success) {
    failRunCore('RUN_STATE_INVALID', '$.execution_status', 'unknown scheduling status');
  }
  return schedulingToRunStatus[parsed.data];
}

export function projectPublicRunStatus(status: RunStatusV1): PublicRunStatusV1 {
  return publicStatus[readRunStatus(status, '$.status')];
}

export function isTerminalRunStatus(status: RunStatusV1): boolean {
  return terminalStatuses.has(readRunStatus(status, '$.status'));
}

export function assertRunStateTransition(
  current: RunStatusV1,
  next: RunStatusV1,
): 'NOOP' | 'TRANSITION' {
  const currentStatus = readRunStatus(current, '$.current');
  const nextStatus = readRunStatus(next, '$.next');
  if (currentStatus === nextStatus) return 'NOOP';
  if (terminalStatuses.has(currentStatus)) {
    failRunCore(
      'RUN_TERMINAL_IMMUTABLE',
      '$.current',
      'terminal Run cannot transition to another state',
    );
  }
  if (!allowedTransitions[currentStatus].has(nextStatus)) {
    failRunCore(
      'RUN_STATE_TRANSITION_INVALID',
      '$.next',
      `transition ${currentStatus} -> ${nextStatus} is not allowed`,
    );
  }
  return 'TRANSITION';
}
