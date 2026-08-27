import { z } from 'zod';

import { UuidV1Schema } from './auth-v1.js';
import { ConversationPrincipalV1Schema } from './conversation-v1.js';

export const RunFixedRouteV1Schema = z.enum([
  '/v1/oapi/agent/chat',
  '/v1/oapi/flow/run',
  '/v1/oapi/runs/{run_id}/cancel',
  '/v1/oapi/runs/{run_id}/gates/{gate_id}/resume',
]);

export const RunIdempotencyKeyV1Schema = z.string().min(1).max(128);

/** A durable key exists only when the optional request key is non-null. */
export const RunIdempotencyNamespaceV1Schema = z.strictObject({
  schema_version: z.literal('run-idempotency-namespace/1'),
  workspace_id: UuidV1Schema,
  authenticated_principal: ConversationPrincipalV1Schema,
  fixed_route: RunFixedRouteV1Schema,
  idempotency_key: RunIdempotencyKeyV1Schema,
});

const optionalKeyRequestShape = {
  schema_version: z.literal('run-idempotency-request/1'),
  idempotency_key: RunIdempotencyKeyV1Schema.nullish(),
};

/**
 * Run create and cancel may explicitly carry null (no replay guarantee).
 * Human Gate resume always requires a non-empty key.
 */
export const RunIdempotencyRequestV1Schema = z.discriminatedUnion('fixed_route', [
  z.strictObject({
    ...optionalKeyRequestShape,
    fixed_route: z.literal('/v1/oapi/agent/chat'),
  }),
  z.strictObject({
    ...optionalKeyRequestShape,
    fixed_route: z.literal('/v1/oapi/flow/run'),
  }),
  z.strictObject({
    ...optionalKeyRequestShape,
    fixed_route: z.literal('/v1/oapi/runs/{run_id}/cancel'),
  }),
  z.strictObject({
    schema_version: z.literal('run-idempotency-request/1'),
    fixed_route: z.literal('/v1/oapi/runs/{run_id}/gates/{gate_id}/resume'),
    idempotency_key: RunIdempotencyKeyV1Schema,
  }),
]);

export type RunFixedRouteV1 = z.infer<typeof RunFixedRouteV1Schema>;
export type RunIdempotencyNamespaceV1 = z.infer<typeof RunIdempotencyNamespaceV1Schema>;
export type RunIdempotencyRequestV1 = z.infer<typeof RunIdempotencyRequestV1Schema>;
