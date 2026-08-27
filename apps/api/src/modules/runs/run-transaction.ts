import type {
  BrowserClientChannelV1,
  ConversationPrincipalV1,
  RunIdempotencyNamespaceV1,
} from '@better-agent/domain-contracts';

import type { AuthDatabaseTransaction } from '../auth/auth-boundary.js';

export type RunBoundaryErrorCode =
  | 'RUN_BOUNDARY_INPUT_INVALID'
  | 'RUN_AUTHORIZATION_FAILED'
  | 'RUN_NOT_FOUND'
  | 'RUN_PLAN_PROVIDER_UNAVAILABLE'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'RUN_REPLAY_FACT_INVALID'
  | 'RUN_REPLAY_RECEIPT_INVALID'
  | 'RUN_CANCELLATION_FAILED';

export class RunBoundaryError extends Error {
  constructor(readonly code: RunBoundaryErrorCode) {
    super('run boundary rejected the request');
    this.name = 'RunBoundaryError';
  }
}

export type RunTransactionOperation =
  | 'lockExistingRunIdempotencyNamespace'
  | 'requestRunCancellation';

export type RunTransactionFailureKind =
  | 'ORIGINAL_RUN_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'DATABASE_OPERATION_FAILED';

export class RunTransactionError extends Error {
  constructor(
    readonly operation: RunTransactionOperation,
    readonly failureKind: RunTransactionFailureKind,
    readonly sqlState: string,
  ) {
    super('run transaction port rejected the database result');
    this.name = 'RunTransactionError';
  }
}

export function mapRunTransactionSqlState(
  operation: RunTransactionOperation,
  sqlState: string,
): RunTransactionError {
  if (sqlState === 'P0002' || sqlState === '42501') {
    return new RunTransactionError(operation, 'ORIGINAL_RUN_NOT_FOUND', sqlState);
  }
  if (operation === 'requestRunCancellation' && sqlState === '23505') {
    return new RunTransactionError(operation, 'IDEMPOTENCY_CONFLICT', sqlState);
  }
  return new RunTransactionError(operation, 'DATABASE_OPERATION_FAILED', sqlState);
}

export interface ExistingRunIdempotencyRecord {
  readonly namespace: RunIdempotencyNamespaceV1;
  readonly intentHash: string;
  readonly runId: string;
  readonly receipt: unknown;
}

export interface ServiceOriginalRunAuthorizationCommand {
  readonly workspaceId: string;
  readonly credentialId: string;
  readonly runId: string;
  readonly targetKind: 'agent' | 'flow';
  readonly requiredScope: 'run:read';
}

export interface BrowserSessionIdentityCommand {
  readonly browserSessionId: string;
  readonly declaredWorkspaceId: string;
  readonly verifier: Uint8Array;
  readonly actualOrigin: string;
  readonly tokenAudience: 'agent_browser_api';
  readonly clientChannel: BrowserClientChannelV1;
}

export interface BrowserTrustedRequestContext {
  readonly actualOrigin: string;
  readonly tokenAudience: 'agent_browser_api';
  readonly clientChannel: BrowserClientChannelV1;
}

export interface BrowserSessionIdentityFacts {
  readonly workspaceId: string;
  readonly browserSessionId: string;
  readonly endUserPrincipalId: string;
  readonly agentDeploymentId: string;
  readonly sessionAuthorizationEpoch: number;
  readonly principalAuthorizationEpoch: number;
  readonly deploymentAuthorizationEpoch: number;
}

export interface BrowserOriginalRunAuthorizationCommand {
  readonly workspaceId: string;
  readonly browserSessionId: string;
  readonly endUserPrincipalId: string;
  readonly agentDeploymentId: string;
  readonly sessionAuthorizationEpoch: number;
  readonly principalAuthorizationEpoch: number;
  readonly deploymentAuthorizationEpoch: number;
  readonly runId: string;
  readonly targetKind: 'agent';
  readonly requiredScope: 'run:read' | 'run:cancel';
}

export interface OriginalRunAuthorizationFacts {
  readonly workspaceId: string;
  readonly runId: string;
  readonly acceptedPrincipal: ConversationPrincipalV1;
  readonly targetKind: 'agent' | 'flow';
  readonly deploymentId: string;
  readonly authorizedScope: 'run:read' | 'run:cancel';
  readonly browserSessionId?: string;
  readonly sessionAuthorizationEpoch?: number;
  readonly principalAuthorizationEpoch?: number;
  readonly deploymentAuthorizationEpoch?: number;
}

export interface RunCancellationCommand {
  readonly workspaceId: string;
  readonly authenticatedPrincipal: ConversationPrincipalV1;
  readonly browserIdentity: BrowserSessionIdentityFacts | null;
  readonly idempotencyKey: string | null;
  readonly runId: string;
  readonly requiredScope: 'run:cancel';
}

export interface ExistingRunIdempotencyLookupCommand {
  readonly namespace: RunIdempotencyNamespaceV1;
  readonly browserIdentity: BrowserSessionIdentityFacts | null;
}

export interface BrowserIdentityDatabaseTransaction extends AuthDatabaseTransaction {
  trustedBrowserRequestContext(): BrowserTrustedRequestContext;
  authenticateBrowserSessionIdentity(command: BrowserSessionIdentityCommand): Promise<unknown>;
}

export interface RunDatabaseTransaction extends BrowserIdentityDatabaseTransaction {
  lockExistingRunIdempotencyNamespace(
    command: ExistingRunIdempotencyLookupCommand,
  ): Promise<ExistingRunIdempotencyRecord | null>;
  authorizeServiceOriginalRun(command: ServiceOriginalRunAuthorizationCommand): Promise<unknown>;
  authorizeBrowserOriginalRun(command: BrowserOriginalRunAuthorizationCommand): Promise<unknown>;
  requestRunCancellation(command: RunCancellationCommand): Promise<unknown>;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export function samePrincipal(
  left: ConversationPrincipalV1,
  right: ConversationPrincipalV1,
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'credential' && right.kind === 'credential'
    ? left.credential_id === right.credential_id
    : left.kind === 'end_user' && right.kind === 'end_user'
      ? left.end_user_principal_id === right.end_user_principal_id
      : false;
}
