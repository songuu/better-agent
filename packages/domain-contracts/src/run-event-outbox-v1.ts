import { z } from 'zod';

import { UuidV1Schema } from './auth-v1.js';
import {
  addCustomIssue,
  hasUniqueBy,
  JsonObjectSchema,
  NonEmptyStringSchema,
  Sha256HexV1Schema,
} from './primitives.js';

const CanonicalNonNegativeIntegerStringV1Schema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/u, 'expected a canonical non-negative decimal integer string');

const CanonicalPositiveIntegerStringV1Schema = z
  .string()
  .regex(/^[1-9][0-9]*$/u, 'expected a canonical positive decimal integer string');

const DurableObjectRefV1Schema = NonEmptyStringSchema.max(2_048).refine(
  (value) => !value.includes('?') && !value.includes('#'),
  'durable object refs must not contain query parameters or fragments',
);

export const RunEventKindsV1 = [
  'RUN_ACCEPTED',
  'RUN_QUEUED',
  'RUN_STARTED',
  'RUN_RETRY_WAIT',
  'RUN_RECOVERING',
  'RUN_CANCEL_REQUESTED',
  'RUN_FINISHED',
  'ATTEMPT_LEASED',
  'ATTEMPT_FINISHED',
  'STEP_STARTED',
  'STEP_FINISHED',
  'CREDIT_RESERVED',
  'CREDIT_SETTLED',
  'OUTBOX_ENQUEUED',
  'SSE_TASK',
] as const;

export const RunEventKindV1Schema = z.enum(RunEventKindsV1);

export const RunEventV1Schema = z
  .strictObject({
    schema_version: z.literal('run-event/1'),
    event_id: UuidV1Schema,
    workspace_id: UuidV1Schema,
    run_id: UuidV1Schema,
    attempt_id: UuidV1Schema.optional(),
    step_id: UuidV1Schema.optional(),
    sequence: CanonicalPositiveIntegerStringV1Schema,
    event_kind: RunEventKindV1Schema,
    sse_visible: z.boolean(),
    payload_object_ref: DurableObjectRefV1Schema.optional(),
    payload_sha256: Sha256HexV1Schema.optional(),
    payload_redacted: JsonObjectSchema,
    created_at: z.iso.datetime({ offset: true }),
  })
  .superRefine((event, ctx) => {
    if ((event.payload_object_ref === undefined) !== (event.payload_sha256 === undefined)) {
      addCustomIssue(
        ctx,
        ['payload_object_ref'],
        'payload object ref and hash must be present or absent together',
      );
    }
    if (event.step_id !== undefined && event.attempt_id === undefined) {
      addCustomIssue(ctx, ['step_id'], 'step events must identify their attempt');
    }
  });

export const OutboxMessageTypesV1 = [
  'RUN_DISPATCH',
  'SSE_WAKE',
  'WEBHOOK_DELIVERY',
  'ANALYTICS_PROJECTION',
] as const;

export const OutboxMessageTypeV1Schema = z.enum(OutboxMessageTypesV1);
export const OutboxDeliveryStatusV1Schema = z.enum(['PENDING', 'LEASED', 'DELIVERED', 'DEAD']);

export const OutboxMessageV1Schema = z
  .strictObject({
    schema_version: z.literal('run-outbox-message/1'),
    outbox_message_id: UuidV1Schema,
    workspace_id: UuidV1Schema,
    run_id: UuidV1Schema,
    message_type: OutboxMessageTypeV1Schema,
    dedupe_key: NonEmptyStringSchema.max(300),
    delivery_status: OutboxDeliveryStatusV1Schema,
    lease_owner: NonEmptyStringSchema.max(300).optional(),
    lease_token: UuidV1Schema.optional(),
    lease_fencing_token: CanonicalNonNegativeIntegerStringV1Schema,
    lease_expires_at: z.iso.datetime({ offset: true }).optional(),
    attempt_count: CanonicalNonNegativeIntegerStringV1Schema,
    next_attempt_at: z.iso.datetime({ offset: true }),
    delivered_at: z.iso.datetime({ offset: true }).optional(),
    last_error_code: NonEmptyStringSchema.max(200).optional(),
    last_error_detail_redacted: JsonObjectSchema,
    payload_object_ref: DurableObjectRefV1Schema,
    payload_sha256: Sha256HexV1Schema,
    payload_metadata_redacted: JsonObjectSchema,
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
  })
  .superRefine((message, ctx) => {
    const hasCompleteLease =
      message.lease_owner !== undefined &&
      message.lease_token !== undefined &&
      message.lease_expires_at !== undefined;
    if (message.delivery_status === 'LEASED' && !hasCompleteLease) {
      addCustomIssue(
        ctx,
        ['delivery_status'],
        'LEASED outbox messages require owner, token, and expiry',
      );
    }
    if (message.delivery_status === 'DELIVERED' && message.delivered_at === undefined) {
      addCustomIssue(ctx, ['delivered_at'], 'DELIVERED outbox messages require delivered_at');
    }
    if (message.delivery_status !== 'DELIVERED' && message.delivered_at !== undefined) {
      addCustomIssue(
        ctx,
        ['delivered_at'],
        'only DELIVERED outbox messages may carry delivered_at',
      );
    }
  });

export const OutboxMessageSetV1Schema = z
  .strictObject({
    schema_version: z.literal('run-outbox-message-set/1'),
    workspace_id: UuidV1Schema,
    run_id: UuidV1Schema,
    messages: z.array(OutboxMessageV1Schema).min(1),
  })
  .superRefine((set, ctx) => {
    if (
      !set.messages.every(
        (message) => message.workspace_id === set.workspace_id && message.run_id === set.run_id,
      )
    ) {
      addCustomIssue(
        ctx,
        ['messages'],
        'every outbox message must belong to the enclosing workspace and Run',
      );
    }
    if (
      !hasUniqueBy(set.messages, (message) => `${message.message_type}\u0000${message.dedupe_key}`)
    ) {
      addCustomIssue(ctx, ['messages'], 'outbox message type and dedupe key pairs must be unique');
    }
  });

export type RunEventKindV1 = z.infer<typeof RunEventKindV1Schema>;
export type RunEventV1 = z.infer<typeof RunEventV1Schema>;
export type OutboxMessageTypeV1 = z.infer<typeof OutboxMessageTypeV1Schema>;
export type OutboxDeliveryStatusV1 = z.infer<typeof OutboxDeliveryStatusV1Schema>;
export type OutboxMessageV1 = z.infer<typeof OutboxMessageV1Schema>;
export type OutboxMessageSetV1 = z.infer<typeof OutboxMessageSetV1Schema>;
