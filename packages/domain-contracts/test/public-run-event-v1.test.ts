import { describe, expect, it } from 'vitest';

import { PublicRunEventV1Schema } from '../src/public-run-event-v1.js';

const base = {
  schema_version: 'run-event/1',
  event_id: '01900000-0000-7000-8000-000000000001',
  sequence: '42',
  occurred_at: '2026-09-05T00:00:00.000Z',
  accepted_request_id: '01900000-0000-7000-8000-000000000002',
  run_id: '01900000-0000-7000-8000-000000000003',
} as const;

describe('public Run event v1', () => {
  it.each([
    ['run.accepted', { status: 'QUEUED', robot_id: 'robot-public', conversation_id: 'chat-1' }],
    ['run.started', { status: 'RUNNING' }],
    ['task.delta', { task: { name: 'answer', type: 'TEXT', status: 'STARTED' }, delta: 'hello' }],
    ['task.completed', { task: { name: 'answer', type: 'TEXT', status: 'SUCCEEDED' } }],
    ['run.usage', { reserved: '10', consumed: '3.5', currency: 'credits' }],
    ['run.cancel_requested', { requested_at: '2026-09-05T00:00:01.000Z' }],
    [
      'run.waiting',
      {
        pending_action: {
          gate_id: '01900000-0000-7000-8000-000000000004',
          type: 'approval',
          actions: ['approve', 'reject'],
          expires_at: '2026-09-05T01:00:00.000Z',
        },
      },
    ],
    [
      'run.resumed',
      {
        gate_id: '01900000-0000-7000-8000-000000000004',
        action: 'approve',
        resumed_at: '2026-09-05T00:00:02.000Z',
      },
    ],
    [
      'run.terminal',
      {
        status: 'SUCCEEDED',
        duration_time: 2.5,
        result: { answer: 'safe' },
        last_sequence: '42',
        billing_pending: false,
      },
    ],
  ] as const)('accepts the %s discriminator branch', (type, data) => {
    expect(PublicRunEventV1Schema.safeParse({ ...base, type, data }).success).toBe(true);
  });

  it.each([
    [
      'node.started',
      { attempt: 1, timeout_ms: 5_000 },
      { node_id: 'public-node-1', key: 'llm_1', type: 'llm' },
    ],
    [
      'node.completed',
      { attempt: 1, output: { text: 'safe' }, usage: { total_units: '3', unit: 'tokens' } },
      { node_id: 'public-node-1', key: 'llm_1', type: 'llm' },
    ],
    [
      'node.failed',
      {
        attempt: 1,
        error: { code: 'MODEL_FAILED', retryable: false, category: 'EXECUTION' },
        will_retry: false,
      },
      { node_id: 'public-node-1', key: 'llm_1', type: 'llm' },
    ],
  ] as const)('requires a public node for %s', (type, data, node) => {
    expect(PublicRunEventV1Schema.safeParse({ ...base, type, node, data }).success).toBe(true);
    expect(PublicRunEventV1Schema.safeParse({ ...base, type, data }).success).toBe(false);
  });

  it('rejects internal authority fields and discriminator/data mismatches', () => {
    expect(
      PublicRunEventV1Schema.safeParse({
        ...base,
        type: 'run.started',
        data: { status: 'RUNNING' },
        workspace_id: '01900000-0000-7000-8000-000000000009',
      }).success,
    ).toBe(false);
    expect(
      PublicRunEventV1Schema.safeParse({
        ...base,
        type: 'run.started',
        data: { status: 'QUEUED' },
      }).success,
    ).toBe(false);
  });

  it('enforces terminal result/error exclusivity and immutable billing snapshot', () => {
    expect(
      PublicRunEventV1Schema.safeParse({
        ...base,
        type: 'run.terminal',
        data: {
          status: 'FAILED',
          duration_time: 2,
          result: {},
          error: { code: 'MODEL_FAILED', retryable: false, category: 'EXECUTION' },
          last_sequence: '42',
          billing_pending: false,
        },
      }).success,
    ).toBe(false);
    expect(
      PublicRunEventV1Schema.safeParse({
        ...base,
        type: 'run.terminal',
        data: {
          status: 'SUCCEEDED',
          duration_time: 2,
          result: {},
          last_sequence: '42',
          billing_pending: true,
        },
      }).success,
    ).toBe(false);
  });
});
