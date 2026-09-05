import { z } from 'zod';

import { UuidV1Schema } from './auth-v1.js';
import { JsonValueSchema, NonEmptyStringSchema } from './primitives.js';

const PositiveDecimalSchema = z.string().regex(/^[1-9][0-9]*$/u);
const UnsignedAmountSchema = z.string().regex(/^[0-9]+(?:\.[0-9]+)?$/u);
const SignedAmountSchema = z.string().regex(/^-?[0-9]+(?:\.[0-9]+)?$/u);
const OccurredAtSchema = z.iso.datetime({ offset: true });

const PublicPayloadSchema = JsonValueSchema;

const PublicErrorSchema = z
  .strictObject({
    code: NonEmptyStringSchema.max(200),
    retryable: z.boolean(),
    category: z.enum([
      'VALIDATION',
      'AUTH',
      'AUTHORIZATION',
      'CREDITS',
      'CONFLICT',
      'RATE_LIMIT',
      'EXECUTION',
      'INTERNAL',
      'UPSTREAM',
    ]),
    flow_category: z
      .enum([
        'VALIDATION',
        'RESOLUTION',
        'POLICY',
        'CANCELLED',
        'TIMEOUT',
        'UPSTREAM_TRANSIENT',
        'UPSTREAM_PERMANENT',
        'SIDE_EFFECT_UNKNOWN',
        'INTERNAL',
      ])
      .optional(),
    requires_operator_action: z.boolean().optional(),
  })
  .superRefine((error, ctx) => {
    if (
      error.code === 'SIDE_EFFECT_UNKNOWN' &&
      (error.retryable !== false ||
        error.category !== 'EXECUTION' ||
        error.requires_operator_action !== true)
    ) {
      ctx.addIssue({ code: 'custom', message: 'SIDE_EFFECT_UNKNOWN must require operator action' });
    }
  });

const PublicNodeSchema = z.strictObject({
  node_id: NonEmptyStringSchema.max(300),
  key: NonEmptyStringSchema.max(300),
  type: NonEmptyStringSchema.max(100),
});

const PublicTaskSchema = z.strictObject({
  name: NonEmptyStringSchema.max(300),
  type: z.enum(['TEXT', 'FUNCTION', 'RELATED_QUESTIONS']),
  tool_type: z.enum(['dataset', 'flow', 'plugin', 'system']).optional(),
  tool_id: NonEmptyStringSchema.max(300).optional(),
  status: z.enum(['STARTED', 'SUCCEEDED', 'FAILED']),
  content: PublicPayloadSchema.optional(),
  duration_time: z.number().finite().nonnegative().optional(),
  metadata: z
    .strictObject({
      icon: z.string().max(2_048).optional(),
      color: z.string().max(64).optional(),
      label: z.string().max(256).optional(),
      capability_kind: z
        .enum(['knowledge', 'flow', 'plugin', 'database', 'subagent', 'skill_pack'])
        .optional(),
      redacted_fields: z.array(z.string().max(256)).max(256).optional(),
    })
    .optional(),
  upgrade_consume: z.number().finite().optional(),
});

const PendingHumanInputSchema = z.strictObject({
  gate_id: UuidV1Schema,
  type: z.literal('input'),
  schema: z.record(z.string(), JsonValueSchema),
  actions: z.tuple([z.literal('submit')]),
  expires_at: OccurredAtSchema,
});
const PendingHumanApprovalSchema = z.strictObject({
  gate_id: UuidV1Schema,
  type: z.literal('approval'),
  actions: z
    .array(z.enum(['approve', 'reject']))
    .min(1)
    .max(2)
    .refine((actions) => new Set(actions).size === actions.length),
  expires_at: OccurredAtSchema,
});
const PendingHumanActionSchema = z.discriminatedUnion('type', [
  PendingHumanInputSchema,
  PendingHumanApprovalSchema,
]);

const baseShape = {
  schema_version: z.literal('run-event/1'),
  event_id: UuidV1Schema,
  sequence: PositiveDecimalSchema,
  occurred_at: OccurredAtSchema,
  accepted_request_id: UuidV1Schema,
  run_id: UuidV1Schema,
  scope_path: NonEmptyStringSchema.max(1_024).optional(),
  node: PublicNodeSchema.optional(),
} as const;

function event<T extends string, S extends z.ZodType>(type: T, data: S) {
  return z.strictObject({ ...baseShape, type: z.literal(type), data });
}

const RunAcceptedEventSchema = event(
  'run.accepted',
  z.strictObject({
    status: z.literal('QUEUED'),
    robot_id: NonEmptyStringSchema.max(300).optional(),
    conversation_id: NonEmptyStringSchema.max(300).optional(),
  }),
);
const RunStartedEventSchema = event(
  'run.started',
  z.strictObject({ status: z.literal('RUNNING') }),
);
const NodeStartedEventSchema = event(
  'node.started',
  z.strictObject({ attempt: z.number().int().positive(), timeout_ms: z.number().int().positive() }),
).refine((value) => value.node !== undefined, { message: 'node.started requires node' });
const TaskDeltaEventSchema = event(
  'task.delta',
  z.strictObject({ task: PublicTaskSchema, delta: z.string().max(1_048_576) }),
);
const TaskCompletedEventSchema = event(
  'task.completed',
  z.strictObject({ task: PublicTaskSchema }),
);
const NodeCompletedEventSchema = event(
  'node.completed',
  z.strictObject({
    attempt: z.number().int().positive(),
    output: PublicPayloadSchema.optional(),
    usage: z
      .strictObject({
        input_units: UnsignedAmountSchema.optional(),
        output_units: UnsignedAmountSchema.optional(),
        total_units: UnsignedAmountSchema.optional(),
        unit: z.string().max(64).optional(),
      })
      .optional(),
  }),
).refine((value) => value.node !== undefined, { message: 'node.completed requires node' });
const NodeFailedEventSchema = event(
  'node.failed',
  z.strictObject({
    attempt: z.number().int().positive(),
    error: PublicErrorSchema,
    will_retry: z.boolean(),
  }),
).refine((value) => value.node !== undefined, { message: 'node.failed requires node' });
const RunUsageEventSchema = event(
  'run.usage',
  z.strictObject({
    reserved: SignedAmountSchema,
    consumed: SignedAmountSchema,
    currency: NonEmptyStringSchema.max(16),
  }),
);
const RunWaitingEventSchema = event(
  'run.waiting',
  z.strictObject({ pending_action: PendingHumanActionSchema }),
);
const RunResumedEventSchema = event(
  'run.resumed',
  z.strictObject({
    gate_id: UuidV1Schema,
    action: z.enum(['submit', 'approve']),
    resumed_at: OccurredAtSchema,
  }),
);
const RunCancelRequestedEventSchema = event(
  'run.cancel_requested',
  z.strictObject({ requested_at: OccurredAtSchema }),
);
const RunTerminalEventSchema = event(
  'run.terminal',
  z
    .strictObject({
      status: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']),
      duration_time: z.number().finite().nonnegative(),
      result: PublicPayloadSchema.optional(),
      error: PublicErrorSchema.optional(),
      last_sequence: PositiveDecimalSchema,
      billing_pending: z.literal(false),
    })
    .superRefine((data, ctx) => {
      const succeeded = data.status === 'SUCCEEDED';
      if (succeeded !== (data.result !== undefined) || succeeded === (data.error !== undefined)) {
        ctx.addIssue({
          code: 'custom',
          message: 'terminal result and error are mutually exclusive',
        });
      }
    }),
);

export const PublicRunEventV1Schema = z.union([
  RunAcceptedEventSchema,
  RunStartedEventSchema,
  NodeStartedEventSchema,
  TaskDeltaEventSchema,
  TaskCompletedEventSchema,
  NodeCompletedEventSchema,
  NodeFailedEventSchema,
  RunUsageEventSchema,
  RunWaitingEventSchema,
  RunResumedEventSchema,
  RunCancelRequestedEventSchema,
  RunTerminalEventSchema,
]);

export type PublicRunEventV1 = z.infer<typeof PublicRunEventV1Schema>;
