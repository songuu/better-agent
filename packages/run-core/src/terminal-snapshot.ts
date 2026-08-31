import {
  type JsonObject,
  JsonObjectSchema,
  type RunAcceptanceV1,
  RunAcceptanceV1Schema,
  type RunExecutionStatusV1,
  type RunSnapshotV1,
  RunSnapshotV1Schema,
  type RunStatusV1,
  StrategyTerminationReasonV1Schema,
} from '@better-agent/domain-contracts';

import { failRunCore } from './errors.js';
import { readPostgresInstantMicroseconds } from './postgres-instant.js';
import { assertRunStateTransition, isTerminalRunStatus } from './run-state.js';

export interface RegistryOutputValidationInputV1 {
  readonly schema_ref: string;
  readonly schema_hash: string;
  readonly result: JsonObject;
}

export type RegistryOutputValidatorV1 = (input: RegistryOutputValidationInputV1) => boolean;

export interface PrepareTerminalSnapshotInputV1 {
  readonly current: unknown;
  readonly acceptance: unknown;
  readonly termination_reason: unknown;
  readonly finished_at: string;
  readonly result_redacted?: unknown;
  readonly billing_settled_at?: string;
  readonly validate_output?: RegistryOutputValidatorV1;
}

type TerminationReasonV1 = Exclude<RunSnapshotV1['termination_reason'], undefined>;

function terminalStatus(reason: TerminationReasonV1): {
  status: RunStatusV1;
  execution_status: RunExecutionStatusV1;
} {
  if (reason === 'COMPLETED') return { status: 'SUCCEEDED', execution_status: 'SUCCEEDED' };
  if (reason === 'USER_CANCELLED') {
    return { status: 'CANCELLED', execution_status: 'CANCELLED' };
  }
  if (reason === 'RUN_TIMED_OUT') return { status: 'TIMED_OUT', execution_status: 'EXPIRED' };
  if (reason === 'SIDE_EFFECT_UNKNOWN') {
    return { status: 'NEEDS_ATTENTION', execution_status: 'NEEDS_ATTENTION' };
  }
  return { status: 'FAILED', execution_status: 'FAILED' };
}

function parseCurrent(value: unknown): RunSnapshotV1 {
  const result = RunSnapshotV1Schema.safeParse(value);
  if (!result.success) {
    failRunCore('RUN_STATE_INVALID', '$.current', 'current Run snapshot is invalid', {
      cause: result.error,
    });
  }
  return result.data;
}

function parseAcceptance(value: unknown): RunAcceptanceV1 {
  const result = RunAcceptanceV1Schema.safeParse(value);
  if (!result.success) {
    failRunCore('RUN_ACCEPTANCE_INVALID', '$.acceptance', 'Run acceptance is invalid', {
      cause: result.error,
    });
  }
  return result.data;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export function prepareTerminalSnapshot(input: PrepareTerminalSnapshotInputV1): RunSnapshotV1 {
  const current = parseCurrent(input.current);
  const acceptance = parseAcceptance(input.acceptance);
  const finishedAtMicroseconds = readPostgresInstantMicroseconds(
    input.finished_at,
    '$.finished_at',
  );
  if (current.workspace_id !== acceptance.workspace_id || current.run_id !== acceptance.run_id) {
    failRunCore(
      'RUN_ACCEPTANCE_INVALID',
      '$.acceptance',
      'terminal intent acceptance does not belong to the current Run',
    );
  }
  if (isTerminalRunStatus(current.status)) {
    failRunCore(
      'RUN_TERMINAL_IMMUTABLE',
      '$.current.status',
      'Run already has a terminal snapshot',
    );
  }
  const reasonResult = StrategyTerminationReasonV1Schema.safeParse(input.termination_reason);
  if (!reasonResult.success) {
    failRunCore('RUN_STATE_INVALID', '$.termination_reason', 'unknown terminal reason');
  }
  const reason = reasonResult.data;
  if (reason === 'HUMAN_REJECTED' || reason === 'HUMAN_GATE_EXPIRED') {
    failRunCore(
      'RUN_HUMAN_GATE_APPLY_UNAVAILABLE',
      '$.termination_reason',
      'HumanGate-derived terminal mutation requires a published GateSpec disposition',
    );
  }
  const mapped = terminalStatus(reason);
  assertRunStateTransition(current.status, mapped.status);

  let terminalResult: JsonObject | undefined;
  if (mapped.status === 'SUCCEEDED') {
    if (input.validate_output === undefined) {
      failRunCore(
        'RUN_OUTPUT_VALIDATOR_UNAVAILABLE',
        '$.validate_output',
        'SUCCEEDED requires a registry-backed output validator',
      );
    }
    const parsedResult = JsonObjectSchema.safeParse(input.result_redacted);
    if (!parsedResult.success) {
      failRunCore(
        'RUN_OUTPUT_INVALID',
        '$.result_redacted',
        'successful result must be a JSON object',
      );
    }
    terminalResult = deepFreeze(parsedResult.data);
    if (
      !input.validate_output({
        schema_ref: acceptance.accepted_output_schema_ref,
        schema_hash: acceptance.accepted_output_schema_hash,
        result: terminalResult,
      })
    ) {
      failRunCore(
        'RUN_OUTPUT_INVALID',
        '$.result_redacted',
        'result failed its frozen registry schema validation',
      );
    }
  } else if (input.result_redacted !== undefined) {
    failRunCore(
      'RUN_OUTPUT_INVALID',
      '$.result_redacted',
      'non-success terminal cannot carry a result',
    );
  }

  const needsAttention = mapped.status === 'NEEDS_ATTENTION';
  if (!needsAttention && input.billing_settled_at === undefined) {
    failRunCore(
      'RUN_STATE_INVALID',
      '$.billing_settled_at',
      'normal terminal requires settled billing evidence',
    );
  }
  if (
    !needsAttention &&
    input.billing_settled_at !== undefined &&
    readPostgresInstantMicroseconds(input.billing_settled_at, '$.billing_settled_at') !==
      finishedAtMicroseconds
  ) {
    failRunCore(
      'RUN_STATE_INVALID',
      '$.billing_settled_at',
      'normal terminal billing settlement must share the finalization instant',
    );
  }

  const candidate = {
    schema_version: 'run-snapshot/1',
    workspace_id: current.workspace_id,
    run_id: current.run_id,
    status: mapped.status,
    execution_status: mapped.execution_status,
    termination_reason: reason,
    finished_at: input.finished_at,
    terminal_billing_pending: false,
    terminal_billing_pending_at: input.finished_at,
    ...(terminalResult === undefined
      ? {
          terminal_error_redacted: {
            code: reason,
            retryable: false,
            category: 'EXECUTION',
            ...(needsAttention ? { requires_operator_action: true } : {}),
          },
        }
      : { terminal_result_redacted: terminalResult }),
    billing_state: needsAttention ? 'NEEDS_ATTENTION' : 'SETTLED',
    ...(needsAttention ? {} : { billing_settled_at: input.billing_settled_at }),
  };
  const terminal = RunSnapshotV1Schema.safeParse(candidate);
  if (!terminal.success) {
    failRunCore('RUN_STATE_INVALID', '$.terminal', 'prepared terminal snapshot is invalid', {
      cause: terminal.error,
    });
  }
  // Zod clones nested JSON while parsing. Return the validated candidate so the
  // registry validator and persistence caller observe one immutable result fact.
  return deepFreeze(candidate) as RunSnapshotV1;
}
