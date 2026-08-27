export type RunCoreErrorCode =
  | 'RUN_INTENT_INVALID'
  | 'RUN_IDEMPOTENCY_INVALID'
  | 'RUN_ACCEPTANCE_RECEIPT_INVALID'
  | 'RUN_ACCEPTANCE_INVALID'
  | 'RUN_ADMISSION_SNAPSHOT_INVALID'
  | 'RUN_CONVERSATION_CAS_INVALID'
  | 'RUN_CONVERSATION_CAS_STALE'
  | 'RUN_CONVERSATION_CAS_OVERFLOW'
  | 'RUN_CONVERSATION_IDENTITY_MISMATCH'
  | 'RUN_STATE_INVALID'
  | 'RUN_STATE_TRANSITION_INVALID'
  | 'RUN_TERMINAL_IMMUTABLE'
  | 'RUN_OUTPUT_VALIDATOR_UNAVAILABLE'
  | 'RUN_OUTPUT_INVALID'
  | 'RUN_HUMAN_GATE_APPLY_UNAVAILABLE'
  | 'RUN_RETENTION_INVALID';

export class RunCoreError extends Error {
  constructor(
    readonly code: RunCoreErrorCode,
    readonly path: string,
    readonly reason: string,
    options: { cause?: unknown } = {},
  ) {
    super(`${code}: ${reason} at ${path}`, options);
    this.name = 'RunCoreError';
  }
}

export function failRunCore(
  code: RunCoreErrorCode,
  path: string,
  reason: string,
  options?: { cause?: unknown },
): never {
  throw new RunCoreError(code, path, reason, options);
}
