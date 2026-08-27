import { type JsonObject, JsonObjectSchema, UuidV1Schema } from '@better-agent/domain-contracts';
import {
  type CanonicalSha256V1,
  canonicalJsonBytes,
  canonicalSha256,
} from '@better-agent/release-core';

import { failRunCore } from './errors.js';

export type RunIntentRouteV1 =
  | '/v1/oapi/agent/chat'
  | '/v1/oapi/flow/run'
  | '/v1/oapi/runs/{run_id}/cancel'
  | '/v1/oapi/runs/{run_id}/gates/{gate_id}/resume';

export type ResponseModeV1 = 'blocking' | 'streaming';

export type CanonicalRunIntentInputV1 =
  | {
      readonly route: '/v1/oapi/agent/chat';
      readonly request: {
        readonly robot_id: string;
        readonly conversation_id: string;
        readonly content: string;
        readonly inputs: JsonObject;
        readonly response_mode?: ResponseModeV1;
      };
    }
  | {
      readonly route: '/v1/oapi/flow/run';
      readonly request: {
        readonly inputs: JsonObject;
        readonly response_mode?: ResponseModeV1;
      };
    }
  | {
      readonly route: '/v1/oapi/runs/{run_id}/cancel';
      readonly request: { readonly run_id: string };
    }
  | {
      readonly route: '/v1/oapi/runs/{run_id}/gates/{gate_id}/resume';
      readonly request:
        | {
            readonly run_id: string;
            readonly gate_id: string;
            readonly action: 'submit';
            readonly input: JsonObject;
          }
        | {
            readonly run_id: string;
            readonly gate_id: string;
            readonly action: 'approve' | 'reject';
          };
    };

export interface PreparedCanonicalRunIntentV1 {
  readonly preimage: Readonly<Record<string, unknown>>;
  readonly canonical_json: string;
  readonly intent_hash: CanonicalSha256V1;
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    failRunCore('RUN_INTENT_INVALID', path, 'expected a plain JSON object');
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      failRunCore('RUN_INTENT_INVALID', `${path}.${key}`, 'field is not part of this route intent');
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      failRunCore('RUN_INTENT_INVALID', `${path}.${key}`, 'required field is missing');
    }
  }
}

function readString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    failRunCore('RUN_INTENT_INVALID', path, 'expected a non-empty string');
  }
  return value;
}

function readUuid(value: unknown, path: string): string {
  const parsed = UuidV1Schema.safeParse(value);
  if (!parsed.success) failRunCore('RUN_INTENT_INVALID', path, 'expected a canonical UUID');
  return parsed.data;
}

function readInputs(value: unknown, path: string): JsonObject {
  const parsed = JsonObjectSchema.safeParse(value);
  if (!parsed.success) failRunCore('RUN_INTENT_INVALID', path, 'expected a JSON object');
  return parsed.data;
}

function readResponseMode(value: unknown, path: string): ResponseModeV1 {
  if (value === undefined) return 'blocking';
  if (value !== 'blocking' && value !== 'streaming') {
    failRunCore('RUN_INTENT_INVALID', path, 'expected blocking or streaming');
  }
  return value;
}

function prepareChatRequest(value: unknown) {
  const request = readRecord(value, '$.request');
  assertExactKeys(
    request,
    ['robot_id', 'conversation_id', 'content', 'inputs', 'response_mode'],
    ['robot_id', 'conversation_id', 'content', 'inputs'],
    '$.request',
  );
  return {
    robot_id: readString(request.robot_id, '$.request.robot_id'),
    conversation_id: readUuid(request.conversation_id, '$.request.conversation_id'),
    content: readString(request.content, '$.request.content'),
    inputs: readInputs(request.inputs, '$.request.inputs'),
    response_mode: readResponseMode(request.response_mode, '$.request.response_mode'),
  };
}

function prepareFlowRequest(value: unknown) {
  const request = readRecord(value, '$.request');
  assertExactKeys(request, ['inputs', 'response_mode'], ['inputs'], '$.request');
  return {
    inputs: readInputs(request.inputs, '$.request.inputs'),
    response_mode: readResponseMode(request.response_mode, '$.request.response_mode'),
  };
}

function prepareCancelRequest(value: unknown) {
  const request = readRecord(value, '$.request');
  assertExactKeys(request, ['run_id'], ['run_id'], '$.request');
  return { run_id: readUuid(request.run_id, '$.request.run_id'), body: {} };
}

function prepareResumeRequest(value: unknown) {
  const request = readRecord(value, '$.request');
  const action = readString(request.action, '$.request.action');
  if (action === 'submit') {
    assertExactKeys(
      request,
      ['run_id', 'gate_id', 'action', 'input'],
      ['run_id', 'gate_id', 'action', 'input'],
      '$.request',
    );
    return {
      run_id: readUuid(request.run_id, '$.request.run_id'),
      gate_id: readUuid(request.gate_id, '$.request.gate_id'),
      action,
      input: readInputs(request.input, '$.request.input'),
    };
  }
  if (action !== 'approve' && action !== 'reject') {
    failRunCore('RUN_INTENT_INVALID', '$.request.action', 'unknown HumanGate resume action');
  }
  assertExactKeys(
    request,
    ['run_id', 'gate_id', 'action'],
    ['run_id', 'gate_id', 'action'],
    '$.request',
  );
  return {
    run_id: readUuid(request.run_id, '$.request.run_id'),
    gate_id: readUuid(request.gate_id, '$.request.gate_id'),
    action,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export function prepareCanonicalRunIntent(
  input: CanonicalRunIntentInputV1,
): PreparedCanonicalRunIntentV1 {
  const envelope = readRecord(input, '$');
  assertExactKeys(envelope, ['route', 'request'], ['route', 'request'], '$');

  const route = envelope.route;
  let request: Record<string, unknown>;
  if (route === '/v1/oapi/agent/chat') request = prepareChatRequest(envelope.request);
  else if (route === '/v1/oapi/flow/run') request = prepareFlowRequest(envelope.request);
  else if (route === '/v1/oapi/runs/{run_id}/cancel') {
    request = prepareCancelRequest(envelope.request);
  } else if (route === '/v1/oapi/runs/{run_id}/gates/{gate_id}/resume') {
    request = prepareResumeRequest(envelope.request);
  } else {
    failRunCore('RUN_INTENT_INVALID', '$.route', 'unknown fixed route template');
  }

  const preimage = deepFreeze({ intent_schema: 'intent/1', route, request });
  return Object.freeze({
    preimage,
    canonical_json: canonicalJsonBytes(preimage).toString('utf8'),
    intent_hash: canonicalSha256(preimage),
  });
}
