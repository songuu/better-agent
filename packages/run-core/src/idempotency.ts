import {
  JsonObjectSchema,
  type RunIdempotencyNamespaceV1,
  RunIdempotencyNamespaceV1Schema,
  Sha256HexV1Schema,
  UuidV1Schema,
} from '@better-agent/domain-contracts';

import {
  type CanonicalAcceptanceReceiptV1,
  prepareCanonicalAcceptanceReceipt,
} from './acceptance-receipt.js';
import { failRunCore } from './errors.js';

export interface IdempotencyTargetV1 {
  readonly run_id: string;
  readonly gate_id?: string;
}

export interface IdempotencyFactV1 {
  readonly namespace: RunIdempotencyNamespaceV1;
  readonly intent_hash: string;
  readonly target: IdempotencyTargetV1;
  readonly receipt: CanonicalAcceptanceReceiptV1;
}

export type IdempotencyDecisionV1 =
  | { readonly decision: 'MISS' }
  | { readonly decision: 'CONFLICT' }
  | { readonly decision: 'REPLAY'; readonly receipt: CanonicalAcceptanceReceiptV1 };

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

function readJsonObject(value: unknown, path: string): Record<string, unknown> {
  const parsed = JsonObjectSchema.safeParse(value);
  if (!parsed.success) {
    failRunCore('RUN_IDEMPOTENCY_INVALID', path, 'expected a canonical JSON object', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    failRunCore('RUN_IDEMPOTENCY_INVALID', path, 'object does not have the canonical shape');
  }
}

function readUuid(value: unknown, path: string): string {
  const parsed = UuidV1Schema.safeParse(value);
  if (!parsed.success) {
    failRunCore('RUN_IDEMPOTENCY_INVALID', path, 'invalid canonical UUID');
  }
  return parsed.data;
}

function readTarget(value: unknown, path: string): IdempotencyTargetV1 {
  const target = readJsonObject(value, path);
  assertExactKeys(target, ['run_id'], ['gate_id'], path);
  const runId = readUuid(target.run_id, `${path}.run_id`);
  const gateId =
    target.gate_id === undefined ? undefined : readUuid(target.gate_id, `${path}.gate_id`);
  return {
    run_id: runId,
    ...(gateId === undefined ? {} : { gate_id: gateId }),
  };
}

function readReceipt(
  value: unknown,
  targetRunId: string,
  fixedRoute: '/v1/oapi/agent/chat' | '/v1/oapi/flow/run',
  path: string,
): CanonicalAcceptanceReceiptV1 {
  const receipt = readJsonObject(value, path);
  assertExactKeys(receipt, ['http_status', 'data'], [], path);
  if (receipt.http_status !== 202) {
    failRunCore(
      'RUN_IDEMPOTENCY_INVALID',
      `${path}.http_status`,
      'idempotency receipt must be the canonical 202 projection',
    );
  }

  const dataPath = `${path}.data`;
  const data = readJsonObject(receipt.data, dataPath);
  const requiresConversation = fixedRoute === '/v1/oapi/agent/chat';
  assertExactKeys(
    data,
    [
      'status',
      'run_id',
      'accepted_request_id',
      'operation_url',
      'events_url',
      'cancel_url',
      ...(requiresConversation ? ['conversation_id'] : []),
    ],
    [],
    dataPath,
  );
  const runId = readUuid(data.run_id, `${dataPath}.run_id`);
  const acceptedRequestId = readUuid(data.accepted_request_id, `${dataPath}.accepted_request_id`);
  const conversationId = requiresConversation
    ? readUuid(data.conversation_id, `${dataPath}.conversation_id`)
    : undefined;
  const canonical = prepareCanonicalAcceptanceReceipt({
    http_status: 202,
    run_id: runId,
    accepted_request_id: acceptedRequestId,
    ...(conversationId === undefined ? {} : { conversation_id: conversationId }),
  });
  if (
    runId !== targetRunId ||
    data.status !== canonical.data.status ||
    data.operation_url !== canonical.data.operation_url ||
    data.events_url !== canonical.data.events_url ||
    data.cancel_url !== canonical.data.cancel_url
  ) {
    failRunCore(
      'RUN_IDEMPOTENCY_INVALID',
      dataPath,
      'receipt does not match its canonical target projection',
    );
  }
  return canonical;
}

function readFact(value: unknown, path: string): IdempotencyFactV1 {
  const fact = readJsonObject(value, path);
  assertExactKeys(fact, ['namespace', 'intent_hash', 'target', 'receipt'], [], path);
  const namespace = RunIdempotencyNamespaceV1Schema.safeParse(fact.namespace);
  if (!namespace.success) {
    failRunCore('RUN_IDEMPOTENCY_INVALID', `${path}.namespace`, 'invalid idempotency namespace');
  }
  const intentHash = Sha256HexV1Schema.safeParse(fact.intent_hash);
  if (!intentHash.success) {
    failRunCore('RUN_IDEMPOTENCY_INVALID', `${path}.intent_hash`, 'invalid canonical intent hash');
  }
  const fixedRoute = namespace.data.fixed_route;
  if (fixedRoute !== '/v1/oapi/agent/chat' && fixedRoute !== '/v1/oapi/flow/run') {
    failRunCore(
      'RUN_IDEMPOTENCY_INVALID',
      `${path}.namespace.fixed_route`,
      'this decision supports only Agent Chat and Flow Run creation',
    );
  }
  const target = readTarget(fact.target, `${path}.target`);
  if (target.gate_id !== undefined) {
    failRunCore(
      'RUN_IDEMPOTENCY_INVALID',
      `${path}.target.gate_id`,
      'Run creation idempotency cannot carry a Gate target',
    );
  }
  const receipt = readReceipt(fact.receipt, target.run_id, fixedRoute, `${path}.receipt`);
  return deepFreeze({
    namespace: namespace.data,
    intent_hash: intentHash.data,
    target,
    receipt,
  });
}

function principalId(namespace: RunIdempotencyNamespaceV1): string {
  return namespace.authenticated_principal.kind === 'credential'
    ? namespace.authenticated_principal.credential_id
    : namespace.authenticated_principal.end_user_principal_id;
}

function sameNamespace(left: RunIdempotencyNamespaceV1, right: RunIdempotencyNamespaceV1): boolean {
  return (
    left.workspace_id === right.workspace_id &&
    left.authenticated_principal.kind === right.authenticated_principal.kind &&
    principalId(left) === principalId(right) &&
    left.fixed_route === right.fixed_route &&
    left.idempotency_key === right.idempotency_key
  );
}

function sameTarget(left: IdempotencyTargetV1, right: IdempotencyTargetV1): boolean {
  return left.run_id === right.run_id && left.gate_id === right.gate_id;
}

/** This create-route equality decision intentionally performs no authorization or read-gate work. */
export function decideIdempotency(input: {
  readonly current: IdempotencyFactV1;
  readonly stored?: IdempotencyFactV1;
}): IdempotencyDecisionV1 {
  const current = readFact(input.current, '$.current');
  if (input.stored === undefined) return Object.freeze({ decision: 'MISS' });
  const stored = readFact(input.stored, '$.stored');
  if (!sameNamespace(current.namespace, stored.namespace)) {
    return Object.freeze({ decision: 'MISS' });
  }
  if (!sameTarget(current.target, stored.target) || current.intent_hash !== stored.intent_hash) {
    return Object.freeze({ decision: 'CONFLICT' });
  }
  return Object.freeze({ decision: 'REPLAY', receipt: stored.receipt });
}
