import { describe, expect, it } from 'vitest';

import {
  formatPublicRunEventSse,
  preparePublicRunEventBatch,
  readRunEventCursor,
} from '../src/public-sse.js';

const event = {
  schema_version: 'run-event/1',
  event_id: '01900000-0000-7000-8000-000000000001',
  sequence: '42',
  occurred_at: '2026-09-05T00:00:00.000Z',
  accepted_request_id: '01900000-0000-7000-8000-000000000002',
  run_id: '01900000-0000-7000-8000-000000000003',
  type: 'run.started',
  data: { status: 'RUNNING' },
} as const;

describe('public Run SSE', () => {
  it('emits a canonical single-frame event whose id equals its sequence', () => {
    const frame = formatPublicRunEventSse(event);
    expect(frame).toBe(
      `id: 42\nevent: run.started\nretry: 1500\ndata: ${JSON.stringify(event)}\n\n`,
    );
  });

  it('rejects unvalidated fields before serialization', () => {
    expect(() => formatPublicRunEventSse({ ...event, plan_hash: 'secret' } as never)).toThrow(
      'PUBLIC_RUN_EVENT_INVALID',
    );
  });

  it.each([
    [undefined, undefined, null],
    ['0', undefined, '0'],
    [undefined, '42', '42'],
    ['42', '42', '42'],
  ] as const)('normalizes cursor=%s and Last-Event-ID=%s', (cursor, lastEventId, expected) => {
    expect(readRunEventCursor({ cursor, lastEventId })).toBe(expected);
  });

  it.each([
    ['01', undefined],
    ['-1', undefined],
    ['42', '43'],
    [undefined, '9223372036854775808'],
  ] as const)('rejects invalid or conflicting cursor values', (cursor, lastEventId) => {
    expect(() => readRunEventCursor({ cursor, lastEventId })).toThrow('RUN_EVENT_CURSOR_INVALID');
  });

  it('accepts only a strictly ordered same-Run replay after the requested cursor', () => {
    const second = { ...event, event_id: '01900000-0000-7000-8000-000000000004', sequence: '43' };
    const batch = preparePublicRunEventBatch({
      runId: event.run_id,
      acceptedRequestId: event.accepted_request_id,
      cursor: '41',
      events: [event, second],
    });
    expect(batch.map(({ sequence }) => sequence)).toEqual(['42', '43']);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch[0])).toBe(true);
  });

  it.each([
    [[event, { ...event, sequence: '42' }]],
    [[{ ...event, sequence: '41' }]],
    [[{ ...event, run_id: '01900000-0000-7000-8000-000000000099' }]],
    [[{ ...event, accepted_request_id: '01900000-0000-7000-8000-000000000099' }]],
  ] as const)('rejects crossed, duplicate, or stale event batches', (events) => {
    expect(() =>
      preparePublicRunEventBatch({
        runId: event.run_id,
        acceptedRequestId: event.accepted_request_id,
        cursor: '41',
        events,
      }),
    ).toThrow('PUBLIC_RUN_EVENT_BATCH_INVALID');
  });
});
