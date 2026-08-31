import {
  type RunAttemptLeaseAuthorityV1,
  RunAttemptLeaseAuthorityV1Schema,
  type RunAttemptLeaseStateV1,
  RunAttemptLeaseStateV1Schema,
  type RunRecoveryTicketDispositionV1,
  RunRecoveryTicketDispositionV1Schema,
  type RunRecoveryTicketV1,
  RunRecoveryTicketV1Schema,
  RunTerminalSourceKindV1Schema,
  Sha256HexV1Schema,
  UuidV1Schema,
} from '@better-agent/domain-contracts';

import { failRunCore } from './errors.js';
import { readPostgresInstantMicroseconds } from './postgres-instant.js';

const maximumSafeFencingToken = BigInt(Number.MAX_SAFE_INTEGER);
const canonicalPositiveIntegerPattern = /^[1-9][0-9]*$/;

interface DatabaseLeaseAuthorityV1 {
  readonly now: string;
  readonly session_user: string;
}

interface DatabaseLeaseGrantV1 extends DatabaseLeaseAuthorityV1 {
  readonly lease_token: string;
  readonly lease_expires_at: string;
}

interface DatabaseRecoveryDispositionV1 {
  readonly disposition_id: string;
  readonly disposed_at: string;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    failRunCore('RUN_LEASE_INVALID', path, 'expected a non-empty string');
  }
  return value;
}

function parseAttemptState(value: unknown, path = '$.current'): RunAttemptLeaseStateV1 {
  const parsed = RunAttemptLeaseStateV1Schema.safeParse(value);
  if (!parsed.success) {
    failRunCore('RUN_LEASE_INVALID', path, 'Attempt lease state does not satisfy its contract', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function parseAuthority(value: unknown): RunAttemptLeaseAuthorityV1 {
  const parsed = RunAttemptLeaseAuthorityV1Schema.safeParse(value);
  if (!parsed.success) {
    failRunCore(
      'RUN_LEASE_INVALID',
      '$.authority',
      'Attempt lease authority does not satisfy its contract',
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function parseTicket(value: unknown): RunRecoveryTicketV1 {
  const parsed = RunRecoveryTicketV1Schema.safeParse(value);
  if (!parsed.success) {
    failRunCore('RUN_RECOVERY_INVALID', '$.ticket', 'recovery ticket contract is invalid', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function parseDisposition(value: unknown): RunRecoveryTicketDispositionV1 {
  const parsed = RunRecoveryTicketDispositionV1Schema.safeParse(value);
  if (!parsed.success) {
    failRunCore(
      'RUN_RECOVERY_INVALID',
      '$.existing_disposition',
      'recovery disposition contract is invalid',
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function sealAttemptState(value: unknown): Readonly<RunAttemptLeaseStateV1> {
  return deepFreeze(parseAttemptState(value, '$.next_state'));
}

function sealAuthority(value: unknown): Readonly<RunAttemptLeaseAuthorityV1> {
  const parsed = RunAttemptLeaseAuthorityV1Schema.safeParse(value);
  if (!parsed.success) {
    failRunCore('RUN_LEASE_INVALID', '$.authority', 'derived lease authority is invalid', {
      cause: parsed.error,
    });
  }
  return deepFreeze(parsed.data);
}

function sealDisposition(value: unknown): Readonly<RunRecoveryTicketDispositionV1> {
  const parsed = RunRecoveryTicketDispositionV1Schema.safeParse(value);
  if (!parsed.success) {
    failRunCore(
      'RUN_RECOVERY_INVALID',
      '$.disposition',
      'derived recovery disposition is invalid',
      { cause: parsed.error },
    );
  }
  return deepFreeze(parsed.data);
}

export function readRunLeaseFencingToken(value: unknown, path: string): bigint {
  if (typeof value !== 'string' || !canonicalPositiveIntegerPattern.test(value)) {
    failRunCore('RUN_LEASE_INVALID', path, 'expected a canonical positive decimal fencing token');
  }
  const token = BigInt(value);
  if (token > maximumSafeFencingToken) {
    failRunCore(
      'RUN_LEASE_FENCING_OVERFLOW',
      path,
      'fencing token exceeds the JavaScript safe-integer boundary',
    );
  }
  return token;
}

export function advanceRunLeaseFencingToken(value: unknown, path: string): string {
  const current = readRunLeaseFencingToken(value, path);
  if (current === maximumSafeFencingToken) {
    failRunCore(
      'RUN_LEASE_FENCING_OVERFLOW',
      path,
      'fencing generation cannot advance beyond the safe-integer boundary',
    );
  }
  return String(current + 1n);
}

function readDurationSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 300) {
    failRunCore(
      'RUN_LEASE_INVALID',
      '$.duration_seconds',
      'lease duration must be an integer between 1 and 300 seconds',
    );
  }
  return value;
}

function assertSameInstant(left: string, right: string, path: string): void {
  if (
    readPostgresInstantMicroseconds(left, path, 'RUN_LEASE_INVALID') !==
    readPostgresInstantMicroseconds(right, '$.database.now', 'RUN_LEASE_INVALID')
  ) {
    failRunCore(
      'RUN_LEASE_AUTHORITY_MISMATCH',
      path,
      'authority time must equal the locked database time',
    );
  }
}

function assertDerivedExpiry(
  now: string,
  expiresAt: string,
  durationSeconds: number,
  path: string,
): void {
  const nowMicroseconds = readPostgresInstantMicroseconds(
    now,
    '$.database.now',
    'RUN_LEASE_INVALID',
  );
  const expiresMicroseconds = readPostgresInstantMicroseconds(expiresAt, path, 'RUN_LEASE_INVALID');
  if (expiresMicroseconds - nowMicroseconds !== BigInt(durationSeconds) * 1_000_000n) {
    failRunCore(
      'RUN_LEASE_INVALID',
      path,
      'lease expiry must equal the locked database time plus the requested duration',
    );
  }
}

function buildAuthority(
  state: RunAttemptLeaseStateV1,
  database: DatabaseLeaseGrantV1,
  fencingToken: string,
  stepId?: string,
): Readonly<RunAttemptLeaseAuthorityV1> {
  return sealAuthority({
    schema_version: 'run-attempt-lease-authority/1',
    workspace_id: state.workspace_id,
    run_id: state.run_id,
    attempt_id: state.attempt_id,
    ...(stepId === undefined ? {} : { step_id: stepId }),
    session_user: database.session_user,
    lease_owner: database.session_user,
    lease_token: database.lease_token,
    lease_fencing_token: fencingToken,
    lease_expires_at: database.lease_expires_at,
    authorized_at: database.now,
  });
}

export interface AssertRunAttemptLeaseAuthorityInputV1 {
  readonly current: unknown;
  readonly authority: unknown;
  readonly database: DatabaseLeaseAuthorityV1;
}

export function assertRunAttemptLeaseAuthority(
  input: AssertRunAttemptLeaseAuthorityInputV1,
): Readonly<RunAttemptLeaseAuthorityV1> {
  const current = parseAttemptState(input.current);
  const authority = parseAuthority(input.authority);
  const databaseSessionUser = requireNonEmptyString(
    input.database.session_user,
    '$.database.session_user',
  );
  const now = readPostgresInstantMicroseconds(
    input.database.now,
    '$.database.now',
    'RUN_LEASE_INVALID',
  );
  if (current.status !== 'RUNNING') {
    failRunCore(
      'RUN_LEASE_TRANSITION_INVALID',
      '$.current.status',
      'leased mutation requires a RUNNING Attempt',
    );
  }
  if (
    authority.workspace_id !== current.workspace_id ||
    authority.run_id !== current.run_id ||
    authority.attempt_id !== current.attempt_id ||
    authority.lease_owner !== current.lease_owner ||
    authority.lease_token !== current.lease_token ||
    authority.lease_fencing_token !== current.lease_fencing_token ||
    authority.lease_expires_at !== current.lease_expires_at ||
    authority.session_user !== databaseSessionUser ||
    authority.lease_owner !== databaseSessionUser
  ) {
    failRunCore(
      'RUN_LEASE_AUTHORITY_MISMATCH',
      '$.authority',
      'authority must match the complete current lease and database session user',
    );
  }
  const expiry = readPostgresInstantMicroseconds(
    authority.lease_expires_at,
    '$.authority.lease_expires_at',
    'RUN_LEASE_INVALID',
  );
  if (now >= expiry) {
    failRunCore('RUN_LEASE_EXPIRED', '$.authority.lease_expires_at', 'Attempt lease has expired');
  }
  assertSameInstant(authority.authorized_at, input.database.now, '$.authority.authorized_at');
  return deepFreeze(structuredClone(authority));
}

export interface DecideRunAttemptClaimInputV1 {
  readonly current: unknown;
  readonly duration_seconds: unknown;
  readonly database: DatabaseLeaseGrantV1;
}

export function decideRunAttemptClaim(input: DecideRunAttemptClaimInputV1) {
  const current = parseAttemptState(input.current);
  if (current.status !== 'PENDING' || current.pending_kind !== 'INITIAL') {
    failRunCore(
      'RUN_LEASE_TRANSITION_INVALID',
      '$.current',
      'initial claim requires an INITIAL PENDING Attempt',
    );
  }
  const durationSeconds = readDurationSeconds(input.duration_seconds);
  const sessionUser = requireNonEmptyString(input.database.session_user, '$.database.session_user');
  requireNonEmptyString(input.database.lease_token, '$.database.lease_token');
  assertDerivedExpiry(
    input.database.now,
    input.database.lease_expires_at,
    durationSeconds,
    '$.database.lease_expires_at',
  );
  const database = { ...input.database, session_user: sessionUser };
  const nextState = sealAttemptState({
    schema_version: current.schema_version,
    workspace_id: current.workspace_id,
    run_id: current.run_id,
    attempt_id: current.attempt_id,
    attempt_number: current.attempt_number,
    status: 'RUNNING',
    lease_owner: sessionUser,
    lease_token: database.lease_token,
    lease_fencing_token: '1',
    lease_expires_at: database.lease_expires_at,
    started_at: database.now,
    updated_at: database.now,
  });
  return deepFreeze({
    kind: 'CLAIM' as const,
    next_state: nextState,
    authority: buildAuthority(current, database, '1'),
  });
}

export interface DecideRunAttemptLeaseRenewalInputV1 {
  readonly current: unknown;
  readonly authority: unknown;
  readonly duration_seconds: unknown;
  readonly database: DatabaseLeaseAuthorityV1 & { readonly lease_expires_at: string };
}

export function decideRunAttemptLeaseRenewal(input: DecideRunAttemptLeaseRenewalInputV1) {
  const current = parseAttemptState(input.current);
  const durationSeconds = readDurationSeconds(input.duration_seconds);
  const authority = assertRunAttemptLeaseAuthority({
    current,
    authority: input.authority,
    database: input.database,
  });
  assertDerivedExpiry(
    input.database.now,
    input.database.lease_expires_at,
    durationSeconds,
    '$.database.lease_expires_at',
  );
  if (
    readPostgresInstantMicroseconds(
      input.database.lease_expires_at,
      '$.database.lease_expires_at',
      'RUN_LEASE_INVALID',
    ) <=
    readPostgresInstantMicroseconds(
      authority.lease_expires_at,
      '$.authority.lease_expires_at',
      'RUN_LEASE_INVALID',
    )
  ) {
    failRunCore(
      'RUN_LEASE_TRANSITION_INVALID',
      '$.database.lease_expires_at',
      'renewal must strictly extend the current lease expiry',
    );
  }
  const nextState = sealAttemptState({
    ...current,
    lease_expires_at: input.database.lease_expires_at,
    updated_at: input.database.now,
  });
  return deepFreeze({
    kind: 'RENEW' as const,
    next_state: nextState,
    authority: sealAuthority({
      ...authority,
      lease_expires_at: input.database.lease_expires_at,
      authorized_at: input.database.now,
    }),
  });
}

export interface DecideRunAttemptLeaseRelinquishInputV1 {
  readonly current: unknown;
  readonly authority: unknown;
  readonly database: DatabaseLeaseAuthorityV1;
  readonly effect_closure: {
    readonly disposition: 'CLOSED' | 'MISSING' | 'UNSAFE' | 'UNKNOWN';
    readonly effect_closure_sha256: string;
  };
}

export function decideRunAttemptLeaseRelinquish(input: DecideRunAttemptLeaseRelinquishInputV1) {
  const current = parseAttemptState(input.current);
  assertRunAttemptLeaseAuthority({
    current,
    authority: input.authority,
    database: input.database,
  });
  if (input.effect_closure.disposition !== 'CLOSED') {
    failRunCore(
      'RUN_EFFECT_CLOSURE_UNSAFE',
      '$.effect_closure.disposition',
      'ordinary relinquish requires a database-recomputed CLOSED effect set',
    );
  }
  requireNonEmptyString(
    input.effect_closure.effect_closure_sha256,
    '$.effect_closure.effect_closure_sha256',
  );
  const nextState = sealAttemptState({
    schema_version: current.schema_version,
    workspace_id: current.workspace_id,
    run_id: current.run_id,
    attempt_id: current.attempt_id,
    attempt_number: current.attempt_number,
    status: 'RELINQUISHED',
    lease_fencing_token: current.lease_fencing_token,
    started_at: current.started_at,
    finished_at: input.database.now,
    updated_at: input.database.now,
  });
  return deepFreeze({
    kind: 'RELINQUISH' as const,
    next_state: nextState,
    effect_closure_sha256: input.effect_closure.effect_closure_sha256,
  });
}

function assertAttemptTicketBinding(
  current: RunAttemptLeaseStateV1,
  ticket: RunRecoveryTicketV1,
): void {
  if (
    current.status !== 'PENDING' ||
    current.pending_kind !== 'RECOVERY' ||
    ticket.resource_kind !== 'ATTEMPT' ||
    ticket.workspace_id !== current.workspace_id ||
    ticket.run_id !== current.run_id ||
    ticket.resource_id !== current.attempt_id ||
    ticket.recovery_ticket_id !== current.recovery_ticket_id ||
    ticket.new_fencing_token !== current.lease_fencing_token ||
    ticket.created_generation !== current.lease_fencing_token
  ) {
    failRunCore(
      'RUN_RECOVERY_IDENTITY_MISMATCH',
      '$.ticket',
      'recovery ticket does not bind the current PENDING Attempt generation',
    );
  }
}

export interface DecideRunAttemptRecoveryClaimInputV1 {
  readonly current: unknown;
  readonly ticket: unknown;
  readonly recovery_ticket_sha256: string;
  readonly existing_disposition?: unknown;
  readonly duration_seconds: unknown;
  readonly database: DatabaseLeaseGrantV1 & DatabaseRecoveryDispositionV1;
}

export function decideRunAttemptRecoveryClaim(input: DecideRunAttemptRecoveryClaimInputV1) {
  const current = parseAttemptState(input.current);
  const ticket = parseTicket(input.ticket);
  assertAttemptTicketBinding(current, ticket);
  if (input.existing_disposition !== undefined) {
    failRunCore(
      'RUN_RECOVERY_DISPOSITION_CONFLICT',
      '$.existing_disposition',
      'recovery ticket was already consumed',
    );
  }
  if (current.started_at === undefined || current.lease_fencing_token === undefined) {
    failRunCore(
      'RUN_LEASE_TRANSITION_INVALID',
      '$.current.started_at',
      'recovery claim requires the original Attempt start and fenced generation',
    );
  }
  const durationSeconds = readDurationSeconds(input.duration_seconds);
  assertDerivedExpiry(
    input.database.now,
    input.database.lease_expires_at,
    durationSeconds,
    '$.database.lease_expires_at',
  );
  const sessionUser = requireNonEmptyString(input.database.session_user, '$.database.session_user');
  requireNonEmptyString(input.database.lease_token, '$.database.lease_token');
  const claimedFence = advanceRunLeaseFencingToken(
    current.lease_fencing_token,
    '$.current.lease_fencing_token',
  );
  const nextState = sealAttemptState({
    schema_version: current.schema_version,
    workspace_id: current.workspace_id,
    run_id: current.run_id,
    attempt_id: current.attempt_id,
    attempt_number: current.attempt_number,
    status: 'RUNNING',
    lease_owner: sessionUser,
    lease_token: input.database.lease_token,
    lease_fencing_token: claimedFence,
    lease_expires_at: input.database.lease_expires_at,
    started_at: current.started_at,
    updated_at: input.database.now,
  });
  const ticketHash = requireNonEmptyString(
    input.recovery_ticket_sha256,
    '$.recovery_ticket_sha256',
  );
  const disposition = sealDisposition({
    schema_version: 'run-recovery-ticket-disposition/1',
    disposition_id: requireNonEmptyString(
      input.database.disposition_id,
      '$.database.disposition_id',
    ),
    recovery_ticket_id: ticket.recovery_ticket_id,
    recovery_ticket_sha256: ticketHash,
    workspace_id: ticket.workspace_id,
    run_id: ticket.run_id,
    resource_kind: 'ATTEMPT',
    resource_id: ticket.resource_id,
    ticket_fencing_token: ticket.new_fencing_token,
    disposition_kind: 'CLAIMED',
    claim_fencing_token: claimedFence,
    claim_session_user: sessionUser,
    claim_lease_owner: sessionUser,
    claim_lease_token: input.database.lease_token,
    claim_lease_expires_at: input.database.lease_expires_at,
    disposed_at: input.database.disposed_at,
  });
  return deepFreeze({
    kind: 'RECOVERY_CLAIM' as const,
    next_state: nextState,
    authority: buildAuthority(current, input.database, claimedFence),
    disposition,
  });
}

export interface RunTerminalRetirementSourceV1 {
  readonly kind: 'TERMINATION_ATTRIBUTION' | 'DURABLE_CANCEL' | 'RECOVERY_HOLD';
  readonly id: string;
  readonly sha256: string;
  readonly terminal_intent_sha256: string;
}

function assertTerminalSourceStatus(
  source: RunTerminalRetirementSourceV1,
  status: 'CANCELLED' | 'FAILED' | 'RELINQUISHED',
): void {
  if (typeof source !== 'object' || source === null) {
    failRunCore(
      'RUN_RECOVERY_INVALID',
      '$.terminal_source',
      'terminal source authority is required',
    );
  }
  const keys = Object.keys(source);
  if (
    keys.length !== 4 ||
    keys.some(
      (key) =>
        key !== 'kind' && key !== 'id' && key !== 'sha256' && key !== 'terminal_intent_sha256',
    ) ||
    !RunTerminalSourceKindV1Schema.safeParse(source.kind).success ||
    !UuidV1Schema.safeParse(source.id).success ||
    !Sha256HexV1Schema.safeParse(source.sha256).success ||
    !Sha256HexV1Schema.safeParse(source.terminal_intent_sha256).success
  ) {
    failRunCore(
      'RUN_RECOVERY_INVALID',
      '$.terminal_source',
      'terminal source authority must be an exact canonical source tuple',
    );
  }
  const valid =
    (source.kind === 'RECOVERY_HOLD' && status === 'RELINQUISHED') ||
    (source.kind === 'DURABLE_CANCEL' && status === 'CANCELLED') ||
    (source.kind === 'TERMINATION_ATTRIBUTION' && (status === 'CANCELLED' || status === 'FAILED'));
  if (!valid) {
    failRunCore(
      'RUN_RECOVERY_INVALID',
      '$.terminal_resource_status',
      'Attempt terminal status does not match its terminal source authority',
    );
  }
}

export interface DecideRunInitialAttemptTerminalRetirementInputV1 {
  readonly current: unknown;
  readonly terminal_source: RunTerminalRetirementSourceV1;
  readonly terminal_resource_status: 'CANCELLED' | 'FAILED';
  readonly database: { readonly retired_at: string };
}

export function decideRunInitialAttemptTerminalRetirement(
  input: DecideRunInitialAttemptTerminalRetirementInputV1,
) {
  const current = parseAttemptState(input.current);
  if (current.status !== 'PENDING' || current.pending_kind !== 'INITIAL') {
    failRunCore(
      'RUN_LEASE_TRANSITION_INVALID',
      '$.current',
      'initial terminal retirement requires an unclaimed INITIAL PENDING Attempt',
    );
  }
  assertTerminalSourceStatus(input.terminal_source, input.terminal_resource_status);
  const nextState = sealAttemptState({
    schema_version: current.schema_version,
    workspace_id: current.workspace_id,
    run_id: current.run_id,
    attempt_id: current.attempt_id,
    attempt_number: current.attempt_number,
    status: input.terminal_resource_status,
    finished_at: input.database.retired_at,
    updated_at: input.database.retired_at,
  });
  return deepFreeze({
    kind: 'RETIRE_INITIAL' as const,
    next_state: nextState,
    terminal_source: structuredClone(input.terminal_source),
  });
}

export interface DecideRunRecoveryTicketTerminalRetirementInputV1 {
  readonly current: unknown;
  readonly ticket: unknown;
  readonly recovery_ticket_sha256: string;
  readonly existing_disposition?: unknown;
  readonly terminal_source: RunTerminalRetirementSourceV1;
  readonly terminal_resource_status: 'CANCELLED' | 'FAILED' | 'RELINQUISHED';
  readonly database: DatabaseRecoveryDispositionV1;
}

function isSameTerminalRetirement(
  disposition: RunRecoveryTicketDispositionV1,
  current: RunAttemptLeaseStateV1,
  ticket: RunRecoveryTicketV1,
  ticketHash: string,
  input: DecideRunRecoveryTicketTerminalRetirementInputV1,
): boolean {
  const disposedAtMatches =
    readPostgresInstantMicroseconds(
      disposition.disposed_at,
      '$.existing_disposition.disposed_at',
      'RUN_RECOVERY_INVALID',
    ) ===
    readPostgresInstantMicroseconds(
      input.database.disposed_at,
      '$.database.disposed_at',
      'RUN_RECOVERY_INVALID',
    );
  const currentTimeMatches =
    current.finished_at !== undefined &&
    readPostgresInstantMicroseconds(
      current.finished_at,
      '$.current.finished_at',
      'RUN_RECOVERY_INVALID',
    ) ===
      readPostgresInstantMicroseconds(
        disposition.disposed_at,
        '$.existing_disposition.disposed_at',
        'RUN_RECOVERY_INVALID',
      ) &&
    readPostgresInstantMicroseconds(
      current.updated_at,
      '$.current.updated_at',
      'RUN_RECOVERY_INVALID',
    ) ===
      readPostgresInstantMicroseconds(
        disposition.disposed_at,
        '$.existing_disposition.disposed_at',
        'RUN_RECOVERY_INVALID',
      );
  return (
    disposition.disposition_kind === 'TERMINAL_RETIRED' &&
    disposition.disposition_id === input.database.disposition_id &&
    disposedAtMatches &&
    disposition.recovery_ticket_id === ticket.recovery_ticket_id &&
    disposition.recovery_ticket_sha256 === ticketHash &&
    disposition.workspace_id === ticket.workspace_id &&
    disposition.run_id === ticket.run_id &&
    disposition.resource_kind === 'ATTEMPT' &&
    disposition.resource_id === ticket.resource_id &&
    disposition.ticket_fencing_token === ticket.new_fencing_token &&
    disposition.terminal_source_kind === input.terminal_source.kind &&
    disposition.terminal_source_id === input.terminal_source.id &&
    disposition.terminal_source_sha256 === input.terminal_source.sha256 &&
    disposition.terminal_intent_sha256 === input.terminal_source.terminal_intent_sha256 &&
    disposition.terminal_resource_status === input.terminal_resource_status &&
    current.workspace_id === ticket.workspace_id &&
    current.run_id === ticket.run_id &&
    current.attempt_id === ticket.resource_id &&
    current.status === input.terminal_resource_status &&
    current.lease_fencing_token === ticket.new_fencing_token &&
    current.started_at !== undefined &&
    currentTimeMatches
  );
}

export function decideRunRecoveryTicketTerminalRetirement(
  input: DecideRunRecoveryTicketTerminalRetirementInputV1,
) {
  const current = parseAttemptState(input.current);
  const ticket = parseTicket(input.ticket);
  const ticketHash = requireNonEmptyString(
    input.recovery_ticket_sha256,
    '$.recovery_ticket_sha256',
  );
  assertTerminalSourceStatus(input.terminal_source, input.terminal_resource_status);
  if (input.existing_disposition !== undefined) {
    const existing = parseDisposition(input.existing_disposition);
    if (!isSameTerminalRetirement(existing, current, ticket, ticketHash, input)) {
      failRunCore(
        'RUN_RECOVERY_DISPOSITION_CONFLICT',
        '$.existing_disposition',
        'recovery ticket has a different terminal disposition',
      );
    }
    return deepFreeze({
      kind: 'REPLAY' as const,
      next_state: deepFreeze(structuredClone(current)),
      disposition: deepFreeze(structuredClone(existing)),
    });
  }
  assertAttemptTicketBinding(current, ticket);
  if (current.started_at === undefined || current.lease_fencing_token === undefined) {
    failRunCore(
      'RUN_RECOVERY_INVALID',
      '$.current.started_at',
      'terminal ticket retirement requires the original Attempt start',
    );
  }
  const nextState = sealAttemptState({
    schema_version: current.schema_version,
    workspace_id: current.workspace_id,
    run_id: current.run_id,
    attempt_id: current.attempt_id,
    attempt_number: current.attempt_number,
    status: input.terminal_resource_status,
    lease_fencing_token: current.lease_fencing_token,
    started_at: current.started_at,
    finished_at: input.database.disposed_at,
    updated_at: input.database.disposed_at,
  });
  const disposition = sealDisposition({
    schema_version: 'run-recovery-ticket-disposition/1',
    disposition_id: requireNonEmptyString(
      input.database.disposition_id,
      '$.database.disposition_id',
    ),
    recovery_ticket_id: ticket.recovery_ticket_id,
    recovery_ticket_sha256: ticketHash,
    workspace_id: ticket.workspace_id,
    run_id: ticket.run_id,
    resource_kind: 'ATTEMPT',
    resource_id: ticket.resource_id,
    ticket_fencing_token: ticket.new_fencing_token,
    disposition_kind: 'TERMINAL_RETIRED',
    terminal_source_kind: input.terminal_source.kind,
    terminal_source_id: input.terminal_source.id,
    terminal_source_sha256: input.terminal_source.sha256,
    terminal_intent_sha256: input.terminal_source.terminal_intent_sha256,
    terminal_resource_status: input.terminal_resource_status,
    disposed_at: input.database.disposed_at,
  });
  return deepFreeze({ kind: 'RETIRE' as const, next_state: nextState, disposition });
}
