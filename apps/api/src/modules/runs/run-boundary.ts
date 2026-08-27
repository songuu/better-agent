import type { ServiceCredentialRouteBindingInput } from '@better-agent/auth';
import {
  type ConversationPrincipalV1,
  type JsonObject,
  JsonObjectSchema,
  RunIdempotencyKeyV1Schema,
  type RunIdempotencyNamespaceV1,
  RunIdempotencyNamespaceV1Schema,
  Sha256HexV1Schema,
  UuidV1Schema,
} from '@better-agent/domain-contracts';
import {
  type CanonicalAcceptanceReceiptV1,
  type CanonicalRunIntentInputV1,
  decideIdempotency,
  prepareCanonicalAcceptanceReceipt,
  prepareCanonicalRunIntent,
} from '@better-agent/run-core';

import type { AuthBoundary, AuthenticatedAccessKeyContext } from '../auth/index.js';
import {
  authenticateBrowserRunIdentityInTransaction,
  authorizeBrowserOriginalRunInTransaction,
} from './browser-run-auth.js';
import {
  assertCancellationContext,
  authorizeServiceOriginalRunInTransaction,
} from './original-run-authorization.js';
import {
  type ExistingRunIdempotencyRecord,
  deepFreeze,
  hasExactKeys,
  RunBoundaryError,
  type RunCancellationCommand,
  type RunDatabaseTransaction,
  RunTransactionError,
  samePrincipal,
} from './run-transaction.js';

const agentCreateRoute = {
  method: 'POST',
  operationId: 'createAgentChatRun',
  routeTemplate: '/v1/oapi/agent/chat',
} as const satisfies ServiceCredentialRouteBindingInput;
const flowCreateRoute = {
  method: 'POST',
  operationId: 'createFlowRun',
  routeTemplate: '/v1/oapi/flow/run',
} as const satisfies ServiceCredentialRouteBindingInput;
const readRoute = {
  method: 'GET',
  operationId: 'getRun',
  routeTemplate: '/v1/oapi/runs/{run_id}',
} as const satisfies ServiceCredentialRouteBindingInput;
const cancelRoute = {
  method: 'POST',
  operationId: 'requestRunCancellation',
  routeTemplate: '/v1/oapi/runs/{run_id}/cancel',
} as const satisfies ServiceCredentialRouteBindingInput;

export interface RunBoundaryDependencies {
  readonly authBoundary: AuthBoundary;
  browserSessionPepper(): Promise<Uint8Array>;
  currentRequestId(): string;
  currentUnixTime(): number;
  withTransaction<T>(callback: (transaction: RunDatabaseTransaction) => Promise<T>): Promise<T>;
}

export interface ServiceAgentChatReplayInput {
  readonly accessKey: string;
  readonly declaredWorkspaceId: string;
  readonly idempotencyKey?: string;
  readonly request: Extract<CanonicalRunIntentInputV1, { route: '/v1/oapi/agent/chat' }>['request'];
}

export interface ServiceFlowReplayInput {
  readonly accessKey: string;
  readonly declaredWorkspaceId: string;
  readonly idempotencyKey?: string;
  readonly request: Extract<CanonicalRunIntentInputV1, { route: '/v1/oapi/flow/run' }>['request'];
}

export interface BrowserAgentChatReplayInput {
  readonly browserSessionToken: string;
  readonly declaredWorkspaceId: string;
  readonly idempotencyKey?: string;
  readonly request: Extract<CanonicalRunIntentInputV1, { route: '/v1/oapi/agent/chat' }>['request'];
}

export interface ServiceRunCancellationInput {
  readonly accessKey: string;
  readonly declaredWorkspaceId: string;
  readonly idempotencyKey?: string;
  readonly runId: string;
}

export interface BrowserRunCancellationInput {
  readonly browserSessionToken: string;
  readonly declaredWorkspaceId: string;
  readonly idempotencyKey?: string;
  readonly runId: string;
}

export interface RunAcceptedExchange {
  readonly code: 202;
  readonly success: true;
  readonly message: 'accepted';
  readonly request_id: string;
  readonly data: CanonicalAcceptanceReceiptV1['data'];
  readonly now_time: number;
}

export interface RunMutationExchange {
  readonly code: 202;
  readonly success: true;
  readonly message: 'accepted';
  readonly request_id: string;
  readonly data: Readonly<{
    run_id: string;
    accepted_request_id: string;
    status: 'QUEUED' | 'RUNNING' | 'CANCEL_REQUESTED';
    operation_url: string;
    events_url: string;
  }>;
  readonly now_time: number;
}

interface RunTerminalSnapshotCommonData {
  readonly run_id: string;
  readonly accepted_request_id: string;
  readonly last_sequence: string;
  readonly billing_pending: false;
}

interface RunSettledTerminalBillingData {
  readonly billing_state: 'SETTLED';
  readonly billing_settled_at: string;
}

interface RunNeedsAttentionTerminalBillingData {
  readonly billing_state: 'NEEDS_ATTENTION';
  readonly billing_settled_at?: never;
}

const failedTerminalReasonValues = [
  'MAX_ITERATIONS',
  'MAX_MODEL_ATTEMPTS',
  'MAX_TOOL_CALLS',
  'BUDGET_EXHAUSTED',
  'AUTHORIZATION_REVALIDATION_FAILED',
  'RESOURCE_REVOKED',
  'MODEL_FAILED',
  'MODEL_OUTCOME_UNKNOWN',
  'CAPABILITY_FAILED',
  'HUMAN_REJECTED',
  'HUMAN_GATE_EXPIRED',
  'INVALID_DECISION',
  'STRATEGY_IMPLEMENTATION_UNAVAILABLE',
  'INTERNAL_FAILURE',
] as const;
const cancelledTerminalReasonValues = [
  'USER_CANCELLED',
  'HUMAN_REJECTED',
  'HUMAN_GATE_EXPIRED',
] as const;

type FailedTerminalReason = (typeof failedTerminalReasonValues)[number];
type CancelledTerminalReason = (typeof cancelledTerminalReasonValues)[number];

interface RunTerminalErrorCommonData {
  readonly retryable: false;
  readonly category: 'EXECUTION';
}

interface RunFailedReasonTerminalErrorData extends RunTerminalErrorCommonData {
  readonly code: FailedTerminalReason;
  readonly requires_operator_action?: never;
}

interface RunSideEffectUnknownTerminalErrorData extends RunTerminalErrorCommonData {
  readonly code: 'SIDE_EFFECT_UNKNOWN';
  readonly requires_operator_action: true;
}

interface RunCancelledTerminalErrorData extends RunTerminalErrorCommonData {
  readonly code: CancelledTerminalReason;
  readonly requires_operator_action?: never;
}

interface RunTimedOutTerminalErrorData extends RunTerminalErrorCommonData {
  readonly code: 'RUN_TIMED_OUT';
  readonly requires_operator_action?: never;
}

type RunSucceededTerminalData = RunSettledTerminalBillingData & {
  readonly status: 'SUCCEEDED';
  readonly result: JsonObject;
  readonly error?: never;
};

interface RunFailedReasonTerminalData {
  readonly status: 'FAILED';
  readonly result?: never;
  readonly error: RunFailedReasonTerminalErrorData;
}

interface RunSideEffectUnknownTerminalData {
  readonly status: 'FAILED';
  readonly result?: never;
  readonly error: RunSideEffectUnknownTerminalErrorData;
}

type RunFailedTerminalData =
  | (RunFailedReasonTerminalData & RunSettledTerminalBillingData)
  | (RunSideEffectUnknownTerminalData &
      (RunSettledTerminalBillingData | RunNeedsAttentionTerminalBillingData));

type RunCancelledTerminalData = RunSettledTerminalBillingData & {
  readonly status: 'CANCELLED';
  readonly result?: never;
  readonly error: RunCancelledTerminalErrorData;
};

type RunTimedOutTerminalData = RunSettledTerminalBillingData & {
  readonly status: 'TIMED_OUT';
  readonly result?: never;
  readonly error: RunTimedOutTerminalErrorData;
};

interface RunFailedReasonTerminalErrorVariant {
  readonly status: 'FAILED';
  readonly result?: never;
  readonly error: RunFailedReasonTerminalErrorData;
}

interface RunSideEffectUnknownTerminalErrorVariant {
  readonly status: 'FAILED';
  readonly result?: never;
  readonly error: RunSideEffectUnknownTerminalErrorData;
}

interface RunCancelledTerminalErrorVariant {
  readonly status: 'CANCELLED';
  readonly result?: never;
  readonly error: RunCancelledTerminalErrorData;
}

interface RunTimedOutTerminalErrorVariant {
  readonly status: 'TIMED_OUT';
  readonly result?: never;
  readonly error: RunTimedOutTerminalErrorData;
}

type RunNonSuccessTerminalErrorVariant =
  | RunFailedReasonTerminalErrorVariant
  | RunSideEffectUnknownTerminalErrorVariant
  | RunCancelledTerminalErrorVariant
  | RunTimedOutTerminalErrorVariant;

type RunNonSuccessTerminalData =
  | RunFailedTerminalData
  | RunCancelledTerminalData
  | RunTimedOutTerminalData;

export type RunTerminalSnapshotData = RunTerminalSnapshotCommonData &
  (RunSucceededTerminalData | RunNonSuccessTerminalData);

export interface RunSnapshotExchange {
  readonly code: 200;
  readonly success: true;
  readonly message: '';
  readonly request_id: string;
  readonly data: RunTerminalSnapshotData;
  readonly now_time: number;
}

export type RunCancellationExchange = RunMutationExchange | RunSnapshotExchange;

export interface RunBoundary {
  replayServiceAgentChat(input: ServiceAgentChatReplayInput): Promise<RunAcceptedExchange>;
  replayServiceFlowRun(input: ServiceFlowReplayInput): Promise<RunAcceptedExchange>;
  replayBrowserAgentChat(input: BrowserAgentChatReplayInput): Promise<RunAcceptedExchange>;
  requestServiceCancellation(input: ServiceRunCancellationInput): Promise<RunCancellationExchange>;
  requestBrowserCancellation(input: BrowserRunCancellationInput): Promise<RunCancellationExchange>;
}

const dependencyKeys = Object.freeze([
  'authBoundary',
  'browserSessionPepper',
  'currentRequestId',
  'currentUnixTime',
  'withTransaction',
]);
const serviceReplayKeys = new Set([
  'accessKey',
  'declaredWorkspaceId',
  'idempotencyKey',
  'request',
]);
const browserReplayKeys = new Set([
  'browserSessionToken',
  'declaredWorkspaceId',
  'idempotencyKey',
  'request',
]);
const cancelKeys = new Set(['accessKey', 'declaredWorkspaceId', 'idempotencyKey', 'runId']);
const browserCancelKeys = new Set([
  'browserSessionToken',
  'declaredWorkspaceId',
  'idempotencyKey',
  'runId',
]);

function hasAllowedKeys(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.every((key) => allowed.has(key)) && required.every((key) => Object.hasOwn(value, key))
  );
}

function readPreparedIntent(route: CanonicalRunIntentInputV1['route'], request: unknown) {
  try {
    return prepareCanonicalRunIntent({ route, request } as CanonicalRunIntentInputV1);
  } catch {
    throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
  }
}

function readPreparedConversationId(prepared: ReturnType<typeof readPreparedIntent>): string {
  const request = prepared.preimage.request;
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
  }
  const parsed = UuidV1Schema.safeParse((request as Record<string, unknown>).conversation_id);
  if (!parsed.success) throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
  return parsed.data;
}

function readReplayIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string') {
    throw new RunBoundaryError('RUN_PLAN_PROVIDER_UNAVAILABLE');
  }
  const parsed = RunIdempotencyKeyV1Schema.safeParse(value);
  if (!parsed.success) throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
  return parsed.data;
}

function snapshotServiceReplayInput(
  input: ServiceAgentChatReplayInput | ServiceFlowReplayInput,
  targetKind: 'agent' | 'flow',
) {
  if (
    !hasAllowedKeys(input, serviceReplayKeys, ['accessKey', 'declaredWorkspaceId', 'request']) ||
    typeof input.accessKey !== 'string' ||
    typeof input.declaredWorkspaceId !== 'string'
  ) {
    throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
  }
  const route: RunIdempotencyNamespaceV1['fixed_route'] =
    targetKind === 'agent' ? '/v1/oapi/agent/chat' : '/v1/oapi/flow/run';
  const prepared = readPreparedIntent(route, input.request);
  return deepFreeze({
    accessKey: input.accessKey,
    declaredWorkspaceId: input.declaredWorkspaceId,
    idempotencyKey: readReplayIdempotencyKey(input.idempotencyKey),
    prepared,
    route,
    ...(targetKind === 'agent'
      ? { expectedConversationId: readPreparedConversationId(prepared) }
      : {}),
  });
}

function snapshotBrowserReplayInput(input: BrowserAgentChatReplayInput) {
  if (
    !hasAllowedKeys(input, browserReplayKeys, [
      'browserSessionToken',
      'declaredWorkspaceId',
      'request',
    ]) ||
    typeof input.browserSessionToken !== 'string' ||
    typeof input.declaredWorkspaceId !== 'string'
  ) {
    throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
  }
  const prepared = readPreparedIntent('/v1/oapi/agent/chat', input.request);
  return deepFreeze({
    browserSessionToken: input.browserSessionToken,
    declaredWorkspaceId: input.declaredWorkspaceId,
    idempotencyKey: readReplayIdempotencyKey(input.idempotencyKey),
    prepared,
    expectedConversationId: readPreparedConversationId(prepared),
  });
}

function readCancellationIdempotencyKey(value: unknown): string | null {
  if (value === undefined) return null;
  const parsed = RunIdempotencyKeyV1Schema.safeParse(value);
  if (!parsed.success) throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
  return parsed.data;
}

function snapshotServiceCancellationInput(input: ServiceRunCancellationInput) {
  if (
    !hasAllowedKeys(input, cancelKeys, ['accessKey', 'declaredWorkspaceId', 'runId']) ||
    typeof input.accessKey !== 'string' ||
    typeof input.declaredWorkspaceId !== 'string'
  ) {
    throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
  }
  const parsedRunId = UuidV1Schema.safeParse(input.runId);
  if (!parsedRunId.success) throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
  return Object.freeze({
    accessKey: input.accessKey,
    declaredWorkspaceId: input.declaredWorkspaceId,
    idempotencyKey: readCancellationIdempotencyKey(input.idempotencyKey),
    runId: parsedRunId.data,
  });
}

function snapshotBrowserCancellationInput(input: BrowserRunCancellationInput) {
  if (
    !hasAllowedKeys(input, browserCancelKeys, [
      'browserSessionToken',
      'declaredWorkspaceId',
      'runId',
    ]) ||
    typeof input.browserSessionToken !== 'string' ||
    typeof input.declaredWorkspaceId !== 'string'
  ) {
    throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
  }
  const parsedRunId = UuidV1Schema.safeParse(input.runId);
  if (!parsedRunId.success) throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
  return Object.freeze({
    browserSessionToken: input.browserSessionToken,
    declaredWorkspaceId: input.declaredWorkspaceId,
    idempotencyKey: readCancellationIdempotencyKey(input.idempotencyKey),
    runId: parsedRunId.data,
  });
}

function readExchangeFacts(dependencies: RunBoundaryDependencies): {
  requestId: string;
  nowTime: number;
} {
  const requestId = dependencies.currentRequestId();
  const nowTime = dependencies.currentUnixTime();
  if (!UuidV1Schema.safeParse(requestId).success || !Number.isSafeInteger(nowTime) || nowTime < 0) {
    throw new RunBoundaryError('RUN_REPLAY_FACT_INVALID');
  }
  return { requestId, nowTime };
}

function conversationPrincipal(context: AuthenticatedAccessKeyContext): ConversationPrincipalV1 {
  const principal = context.tenantAuthContext.caller_principal;
  if (principal.kind !== 'credential') throw new RunBoundaryError('RUN_AUTHORIZATION_FAILED');
  return {
    schema_version: 'conversation-principal/1',
    kind: 'credential',
    credential_id: principal.credential_id,
  };
}

function namespaceFor(input: {
  workspaceId: string;
  principal: ConversationPrincipalV1;
  route: RunIdempotencyNamespaceV1['fixed_route'];
  key: string;
}): RunIdempotencyNamespaceV1 {
  const result = RunIdempotencyNamespaceV1Schema.safeParse({
    schema_version: 'run-idempotency-namespace/1',
    workspace_id: input.workspaceId,
    authenticated_principal: input.principal,
    fixed_route: input.route,
    idempotency_key: input.key,
  });
  if (!result.success) throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
  return result.data;
}

function readExistingRunId(value: ExistingRunIdempotencyRecord): string {
  if (!UuidV1Schema.safeParse(value.runId).success) {
    throw new RunBoundaryError('RUN_REPLAY_FACT_INVALID');
  }
  return value.runId;
}

function sameNamespace(left: RunIdempotencyNamespaceV1, right: RunIdempotencyNamespaceV1): boolean {
  const parsedLeft = RunIdempotencyNamespaceV1Schema.safeParse(left);
  const parsedRight = RunIdempotencyNamespaceV1Schema.safeParse(right);
  return (
    parsedLeft.success &&
    parsedRight.success &&
    parsedLeft.data.schema_version === parsedRight.data.schema_version &&
    parsedLeft.data.workspace_id === parsedRight.data.workspace_id &&
    samePrincipal(
      parsedLeft.data.authenticated_principal,
      parsedRight.data.authenticated_principal,
    ) &&
    parsedLeft.data.fixed_route === parsedRight.data.fixed_route &&
    parsedLeft.data.idempotency_key === parsedRight.data.idempotency_key
  );
}

function parseAcceptanceReceipt(
  value: unknown,
  targetKind: 'agent' | 'flow',
): CanonicalAcceptanceReceiptV1 {
  if (!hasExactKeys(value, ['data', 'http_status']) || value.http_status !== 202) {
    throw new RunBoundaryError('RUN_REPLAY_RECEIPT_INVALID');
  }
  const requiredDataKeys = [
    'accepted_request_id',
    'cancel_url',
    'events_url',
    'operation_url',
    'run_id',
    'status',
  ];
  const expectedDataKeys =
    targetKind === 'agent' ? [...requiredDataKeys, 'conversation_id'] : requiredDataKeys;
  if (!hasExactKeys(value.data, expectedDataKeys)) {
    throw new RunBoundaryError('RUN_REPLAY_RECEIPT_INVALID');
  }
  try {
    const canonical = prepareCanonicalAcceptanceReceipt({
      http_status: value.http_status,
      run_id: value.data.run_id as string,
      accepted_request_id: value.data.accepted_request_id as string,
      ...(targetKind === 'agent' ? { conversation_id: value.data.conversation_id as string } : {}),
    });
    if (
      canonical.http_status !== value.http_status ||
      canonical.data.status !== value.data.status ||
      canonical.data.run_id !== value.data.run_id ||
      canonical.data.accepted_request_id !== value.data.accepted_request_id ||
      canonical.data.operation_url !== value.data.operation_url ||
      canonical.data.events_url !== value.data.events_url ||
      canonical.data.cancel_url !== value.data.cancel_url ||
      canonical.data.conversation_id !== value.data.conversation_id
    ) {
      throw new RunBoundaryError('RUN_REPLAY_RECEIPT_INVALID');
    }
    return canonical;
  } catch (error) {
    if (error instanceof RunBoundaryError) throw error;
    throw new RunBoundaryError('RUN_REPLAY_RECEIPT_INVALID');
  }
}

function validateStoredRecord(input: {
  record: ExistingRunIdempotencyRecord;
  namespace: RunIdempotencyNamespaceV1;
}): { intentHash: string; runId: string } {
  if (
    !sameNamespace(input.record.namespace, input.namespace) ||
    !Sha256HexV1Schema.safeParse(input.record.intentHash).success
  ) {
    throw new RunBoundaryError('RUN_REPLAY_FACT_INVALID');
  }
  const runId = readExistingRunId(input.record);
  return { intentHash: input.record.intentHash, runId };
}

function replayDecision(input: {
  namespace: RunIdempotencyNamespaceV1;
  intentHash: string;
  record: ExistingRunIdempotencyRecord;
  targetKind: 'agent' | 'flow';
  expectedConversationId?: string;
}): CanonicalAcceptanceReceiptV1 {
  const stored = validateStoredRecord({ namespace: input.namespace, record: input.record });
  if (input.intentHash !== stored.intentHash) {
    throw new RunBoundaryError('IDEMPOTENCY_KEY_REUSED');
  }
  const receipt = parseAcceptanceReceipt(input.record.receipt, input.targetKind);
  if (
    receipt.data.run_id !== stored.runId ||
    (input.targetKind === 'agent' && receipt.data.conversation_id !== input.expectedConversationId)
  ) {
    throw new RunBoundaryError('RUN_REPLAY_RECEIPT_INVALID');
  }
  const decision = decideIdempotency({
    current: {
      namespace: input.namespace,
      intent_hash: input.intentHash,
      target: { run_id: stored.runId },
      receipt,
    },
    stored: {
      namespace: input.record.namespace,
      intent_hash: stored.intentHash,
      target: { run_id: stored.runId },
      receipt,
    },
  });
  if (decision.decision === 'CONFLICT') {
    throw new RunBoundaryError('IDEMPOTENCY_KEY_REUSED');
  }
  if (decision.decision !== 'REPLAY') throw new RunBoundaryError('RUN_REPLAY_FACT_INVALID');
  return decision.receipt;
}

function acceptanceExchange(
  dependencies: RunBoundaryDependencies,
  receipt: CanonicalAcceptanceReceiptV1,
): RunAcceptedExchange {
  const exchange = readExchangeFacts(dependencies);
  return Object.freeze({
    code: 202,
    success: true,
    message: 'accepted',
    request_id: exchange.requestId,
    data: receipt.data,
    now_time: exchange.nowTime,
  });
}

const failedTerminalReasons: ReadonlySet<string> = new Set(failedTerminalReasonValues);
const cancelledTerminalReasons: ReadonlySet<string> = new Set(cancelledTerminalReasonValues);

function isFailedTerminalReason(value: string): value is FailedTerminalReason {
  return failedTerminalReasons.has(value);
}

function isCancelledTerminalReason(value: string): value is CancelledTerminalReason {
  return cancelledTerminalReasons.has(value);
}

function isRunTerminalStatus(value: unknown): value is RunTerminalSnapshotData['status'] {
  return (
    value === 'SUCCEEDED' || value === 'FAILED' || value === 'CANCELLED' || value === 'TIMED_OUT'
  );
}

const isoDateTimePattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u;
const postgreSqlBigintMaxText = '9223372036854775807';

function isCanonicalPositivePostgreSqlBigint(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]*$/u.test(value) &&
    (value.length < postgreSqlBigintMaxText.length ||
      (value.length === postgreSqlBigintMaxText.length && value <= postgreSqlBigintMaxText))
  );
}

function isStrictIsoDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = isoDateTimePattern.exec(value);
  if (match === null) return false;
  const [yearText, monthText, dayText, hourText, minuteText, secondText] = match.slice(1, 7);
  if (
    yearText === undefined ||
    monthText === undefined ||
    dayText === undefined ||
    hourText === undefined ||
    minuteText === undefined ||
    secondText === undefined
  ) {
    return false;
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  if (
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (offsetHour !== 0 && offsetHour > 23) ||
    (offsetMinute !== 0 && offsetMinute > 59)
  ) {
    return false;
  }
  const calendar = new Date(0);
  calendar.setUTCHours(0, 0, 0, 0);
  calendar.setUTCFullYear(year, month - 1, day);
  return (
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day
  );
}

function parsePublicRunError(
  value: unknown,
  status: Exclude<RunTerminalSnapshotData['status'], 'SUCCEEDED'>,
): RunNonSuccessTerminalErrorVariant {
  if (
    !hasAllowedKeys(value, new Set(['category', 'code', 'requires_operator_action', 'retryable']), [
      'category',
      'code',
      'retryable',
    ]) ||
    typeof value.code !== 'string' ||
    value.code.length < 1 ||
    value.retryable !== false ||
    value.category !== 'EXECUTION'
  ) {
    throw new RunBoundaryError('RUN_CANCELLATION_FAILED');
  }
  const commonError = { retryable: false, category: 'EXECUTION' } as const;
  if (status === 'FAILED') {
    if (value.code === 'SIDE_EFFECT_UNKNOWN') {
      if (value.requires_operator_action !== true) {
        throw new RunBoundaryError('RUN_CANCELLATION_FAILED');
      }
      return deepFreeze({
        status,
        error: { ...commonError, code: value.code, requires_operator_action: true },
      });
    }
    if (!isFailedTerminalReason(value.code) || Object.hasOwn(value, 'requires_operator_action')) {
      throw new RunBoundaryError('RUN_CANCELLATION_FAILED');
    }
    return deepFreeze({ status, error: { ...commonError, code: value.code } });
  }
  if (Object.hasOwn(value, 'requires_operator_action')) {
    throw new RunBoundaryError('RUN_CANCELLATION_FAILED');
  }
  if (status === 'CANCELLED') {
    if (!isCancelledTerminalReason(value.code)) {
      throw new RunBoundaryError('RUN_CANCELLATION_FAILED');
    }
    return deepFreeze({ status, error: { ...commonError, code: value.code } });
  }
  if (value.code !== 'RUN_TIMED_OUT') {
    throw new RunBoundaryError('RUN_CANCELLATION_FAILED');
  }
  return deepFreeze({ status, error: { ...commonError, code: value.code } });
}

function parseTerminalCancellationReceipt(
  value: unknown,
  expectedRunId: string,
): RunTerminalSnapshotData {
  if (!hasExactKeys(value, ['data', 'http_status']) || value.http_status !== 200) {
    throw new RunBoundaryError('RUN_CANCELLATION_FAILED');
  }
  const data = value.data;
  if (
    !hasAllowedKeys(
      data,
      new Set([
        'accepted_request_id',
        'billing_pending',
        'billing_settled_at',
        'billing_state',
        'error',
        'last_sequence',
        'result',
        'run_id',
        'status',
      ]),
      [
        'accepted_request_id',
        'billing_pending',
        'billing_state',
        'last_sequence',
        'run_id',
        'status',
      ],
    )
  ) {
    throw new RunBoundaryError('RUN_CANCELLATION_FAILED');
  }
  const acceptedRequestId = UuidV1Schema.safeParse(data.accepted_request_id);
  if (
    data.run_id !== expectedRunId ||
    !acceptedRequestId.success ||
    !isCanonicalPositivePostgreSqlBigint(data.last_sequence) ||
    data.billing_pending !== false ||
    (data.billing_state !== 'SETTLED' && data.billing_state !== 'NEEDS_ATTENTION') ||
    !isRunTerminalStatus(data.status)
  ) {
    throw new RunBoundaryError('RUN_CANCELLATION_FAILED');
  }

  const status = data.status;
  const hasResult = Object.hasOwn(data, 'result');
  const hasError = Object.hasOwn(data, 'error');

  if (status === 'SUCCEEDED') {
    const parsedResult = JsonObjectSchema.safeParse(data.result);
    if (!hasResult || hasError || !parsedResult.success) {
      throw new RunBoundaryError('RUN_CANCELLATION_FAILED');
    }
    if (data.billing_state !== 'SETTLED' || !isStrictIsoDateTime(data.billing_settled_at)) {
      throw new RunBoundaryError('RUN_CANCELLATION_FAILED');
    }
    return deepFreeze({
      run_id: expectedRunId,
      accepted_request_id: acceptedRequestId.data,
      status,
      last_sequence: data.last_sequence,
      result: deepFreeze(parsedResult.data),
      billing_pending: false,
      billing_state: data.billing_state,
      billing_settled_at: data.billing_settled_at,
    });
  }

  if (hasResult || !hasError) {
    throw new RunBoundaryError('RUN_CANCELLATION_FAILED');
  }
  const terminal = parsePublicRunError(data.error, status);
  const common = {
    run_id: expectedRunId,
    accepted_request_id: acceptedRequestId.data,
    last_sequence: data.last_sequence,
    billing_pending: false,
  } as const;
  if (data.billing_state === 'NEEDS_ATTENTION') {
    if (
      terminal.status !== 'FAILED' ||
      terminal.error.code !== 'SIDE_EFFECT_UNKNOWN' ||
      Object.hasOwn(data, 'billing_settled_at')
    ) {
      throw new RunBoundaryError('RUN_CANCELLATION_FAILED');
    }
    return deepFreeze({
      ...common,
      status: terminal.status,
      error: terminal.error,
      billing_state: data.billing_state,
    });
  }
  if (!isStrictIsoDateTime(data.billing_settled_at)) {
    throw new RunBoundaryError('RUN_CANCELLATION_FAILED');
  }
  return deepFreeze({
    ...common,
    ...terminal,
    billing_state: data.billing_state,
    billing_settled_at: data.billing_settled_at,
  });
}

function parseMutationCancellationReceipt(
  value: unknown,
  expectedRunId: string,
): RunMutationExchange['data'] {
  if (
    !hasExactKeys(value, ['data', 'http_status']) ||
    value.http_status !== 202 ||
    !hasExactKeys(value.data, [
      'accepted_request_id',
      'events_url',
      'operation_url',
      'run_id',
      'status',
    ]) ||
    value.data.run_id !== expectedRunId ||
    !UuidV1Schema.safeParse(value.data.accepted_request_id).success ||
    !['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'].includes(value.data.status as string) ||
    value.data.operation_url !== `/v1/oapi/runs/${expectedRunId}` ||
    value.data.events_url !== `/v1/oapi/runs/${expectedRunId}/events`
  ) {
    throw new RunBoundaryError('RUN_CANCELLATION_FAILED');
  }
  return Object.freeze({ ...value.data }) as RunMutationExchange['data'];
}

function cancellationExchange(
  dependencies: RunBoundaryDependencies,
  outcome: unknown,
  runId: string,
): RunCancellationExchange {
  if (hasExactKeys(outcome, ['outcome']) && outcome.outcome === 'CONFLICT') {
    throw new RunBoundaryError('IDEMPOTENCY_KEY_REUSED');
  }
  if (hasExactKeys(outcome, ['outcome']) && outcome.outcome === 'NOT_FOUND') {
    throw new RunBoundaryError('RUN_NOT_FOUND');
  }
  if (
    !hasExactKeys(outcome, ['outcome', 'receipt']) ||
    (outcome.outcome !== 'ACCEPTED' && outcome.outcome !== 'REPLAY') ||
    !hasExactKeys(outcome.receipt, ['data', 'http_status'])
  ) {
    throw new RunBoundaryError('RUN_CANCELLATION_FAILED');
  }
  const exchange = readExchangeFacts(dependencies);
  if (outcome.receipt.http_status === 200) {
    return Object.freeze({
      code: 200,
      success: true,
      message: '',
      request_id: exchange.requestId,
      data: parseTerminalCancellationReceipt(outcome.receipt, runId),
      now_time: exchange.nowTime,
    });
  }
  return Object.freeze({
    code: 202,
    success: true,
    message: 'accepted',
    request_id: exchange.requestId,
    data: parseMutationCancellationReceipt(outcome.receipt, runId),
    now_time: exchange.nowTime,
  });
}

function normalizeRunError(error: unknown): never {
  if (error instanceof RunBoundaryError) throw error;
  if (error instanceof RunTransactionError) {
    if (error.failureKind === 'ORIGINAL_RUN_NOT_FOUND') {
      throw new RunBoundaryError('RUN_NOT_FOUND');
    }
    if (error.failureKind === 'IDEMPOTENCY_CONFLICT') {
      throw new RunBoundaryError('IDEMPOTENCY_KEY_REUSED');
    }
    throw new RunBoundaryError(
      error.operation === 'requestRunCancellation'
        ? 'RUN_CANCELLATION_FAILED'
        : 'RUN_REPLAY_FACT_INVALID',
    );
  }
  throw new RunBoundaryError('RUN_AUTHORIZATION_FAILED');
}

export function createRunBoundary(dependencies: RunBoundaryDependencies): RunBoundary {
  if (!hasExactKeys(dependencies, dependencyKeys)) {
    throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
  }
  const agentCreate = dependencies.authBoundary.bindServiceRoute(agentCreateRoute);
  const flowCreate = dependencies.authBoundary.bindServiceRoute(flowCreateRoute);
  const read = dependencies.authBoundary.bindServiceRoute(readRoute);
  const cancel = dependencies.authBoundary.bindServiceRoute(cancelRoute);

  async function replayService(
    input: ServiceAgentChatReplayInput | ServiceFlowReplayInput,
    targetKind: 'agent' | 'flow',
  ): Promise<RunAcceptedExchange> {
    const snapshot = snapshotServiceReplayInput(input, targetKind);
    try {
      return await dependencies.withTransaction(async (transaction) => {
        const authenticator = targetKind === 'agent' ? agentCreate : flowCreate;
        const createContext = await authenticator.authenticateAccessKey({
          accessKey: snapshot.accessKey,
          declaredWorkspaceId: snapshot.declaredWorkspaceId,
          transaction,
        });
        const namespace = namespaceFor({
          workspaceId: createContext.tenantAuthContext.workspace_id,
          principal: conversationPrincipal(createContext),
          route: snapshot.route,
          key: snapshot.idempotencyKey,
        });
        const record = await transaction.lockExistingRunIdempotencyNamespace({
          namespace,
          browserIdentity: null,
        });
        if (record === null) throw new RunBoundaryError('RUN_PLAN_PROVIDER_UNAVAILABLE');
        const runId = readExistingRunId(record);
        const readContext = await read.authenticateAccessKey({
          accessKey: snapshot.accessKey,
          declaredWorkspaceId: snapshot.declaredWorkspaceId,
          transaction,
        });
        await authorizeServiceOriginalRunInTransaction({
          transaction,
          createContext,
          readContext,
          runId,
          targetKind,
        });
        const receipt = replayDecision({
          namespace,
          intentHash: snapshot.prepared.intent_hash,
          record,
          targetKind,
          ...(targetKind === 'agent'
            ? { expectedConversationId: snapshot.expectedConversationId }
            : {}),
        });
        return acceptanceExchange(dependencies, receipt);
      });
    } catch (error) {
      normalizeRunError(error);
    }
  }

  return Object.freeze({
    replayServiceAgentChat: (input: ServiceAgentChatReplayInput) => replayService(input, 'agent'),
    replayServiceFlowRun: (input: ServiceFlowReplayInput) => replayService(input, 'flow'),
    async replayBrowserAgentChat(input: BrowserAgentChatReplayInput) {
      const snapshot = snapshotBrowserReplayInput(input);
      try {
        return await dependencies.withTransaction(async (transaction) => {
          const identity = await authenticateBrowserRunIdentityInTransaction({
            transaction,
            token: snapshot.browserSessionToken,
            declaredWorkspaceId: snapshot.declaredWorkspaceId,
            browserSessionPepper: dependencies.browserSessionPepper,
          });
          const namespace = namespaceFor({
            workspaceId: identity.workspaceId,
            principal: {
              schema_version: 'conversation-principal/1',
              kind: 'end_user',
              end_user_principal_id: identity.endUserPrincipalId,
            },
            route: '/v1/oapi/agent/chat',
            key: snapshot.idempotencyKey,
          });
          const record = await transaction.lockExistingRunIdempotencyNamespace({
            namespace,
            browserIdentity: identity,
          });
          if (record === null) throw new RunBoundaryError('RUN_PLAN_PROVIDER_UNAVAILABLE');
          const runId = readExistingRunId(record);
          await authorizeBrowserOriginalRunInTransaction({ transaction, identity, runId });
          const receipt = replayDecision({
            namespace,
            intentHash: snapshot.prepared.intent_hash,
            record,
            targetKind: 'agent',
            expectedConversationId: snapshot.expectedConversationId,
          });
          return acceptanceExchange(dependencies, receipt);
        });
      } catch (error) {
        normalizeRunError(error);
      }
    },
    async requestServiceCancellation(input: ServiceRunCancellationInput) {
      const snapshot = snapshotServiceCancellationInput(input);
      try {
        return await dependencies.withTransaction(async (transaction) => {
          const context = await cancel.authenticateAccessKey({
            accessKey: snapshot.accessKey,
            declaredWorkspaceId: snapshot.declaredWorkspaceId,
            transaction,
          });
          const authenticatedPrincipal = assertCancellationContext(context);
          const command: RunCancellationCommand = {
            workspaceId: context.tenantAuthContext.workspace_id,
            authenticatedPrincipal,
            browserIdentity: null,
            idempotencyKey: snapshot.idempotencyKey,
            runId: snapshot.runId,
            requiredScope: 'run:cancel',
          };
          const outcome = await transaction.requestRunCancellation(command);
          return cancellationExchange(dependencies, outcome, snapshot.runId);
        });
      } catch (error) {
        normalizeRunError(error);
      }
    },
    async requestBrowserCancellation(input: BrowserRunCancellationInput) {
      const snapshot = snapshotBrowserCancellationInput(input);
      try {
        return await dependencies.withTransaction(async (transaction) => {
          const identity = await authenticateBrowserRunIdentityInTransaction({
            transaction,
            token: snapshot.browserSessionToken,
            declaredWorkspaceId: snapshot.declaredWorkspaceId,
            browserSessionPepper: dependencies.browserSessionPepper,
          });
          const command: RunCancellationCommand = {
            workspaceId: identity.workspaceId,
            authenticatedPrincipal: {
              schema_version: 'conversation-principal/1',
              kind: 'end_user',
              end_user_principal_id: identity.endUserPrincipalId,
            },
            browserIdentity: identity,
            idempotencyKey: snapshot.idempotencyKey,
            runId: snapshot.runId,
            requiredScope: 'run:cancel',
          };
          const outcome = await transaction.requestRunCancellation(command);
          return cancellationExchange(dependencies, outcome, snapshot.runId);
        });
      } catch (error) {
        normalizeRunError(error);
      }
    },
  });
}
