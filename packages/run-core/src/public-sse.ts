import {
  type PublicRunEventV1,
  PublicRunEventV1Schema,
  UuidV1Schema,
} from '@better-agent/domain-contracts';

export type { PublicRunEventV1 } from '@better-agent/domain-contracts';

const maximumPostgreSqlBigint = '9223372036854775807';

function fail(
  code: 'PUBLIC_RUN_EVENT_INVALID' | 'PUBLIC_RUN_EVENT_BATCH_INVALID' | 'RUN_EVENT_CURSOR_INVALID',
): never {
  throw new Error(code);
}

function freeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function readCursorValue(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    return fail('RUN_EVENT_CURSOR_INVALID');
  }
  if (
    value.length > maximumPostgreSqlBigint.length ||
    (value.length === maximumPostgreSqlBigint.length && value > maximumPostgreSqlBigint)
  ) {
    return fail('RUN_EVENT_CURSOR_INVALID');
  }
  return value;
}

export function readRunEventCursor(input: {
  readonly cursor?: string | undefined;
  readonly lastEventId?: string | undefined;
}): string | null {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== 'cursor' && key !== 'lastEventId')
  ) {
    return fail('RUN_EVENT_CURSOR_INVALID');
  }
  const cursor = readCursorValue(input.cursor);
  const lastEventId = readCursorValue(input.lastEventId);
  if (cursor !== null && lastEventId !== null && cursor !== lastEventId) {
    return fail('RUN_EVENT_CURSOR_INVALID');
  }
  return cursor ?? lastEventId;
}

export function formatPublicRunEventSse(value: unknown): string {
  const parsed = PublicRunEventV1Schema.safeParse(value);
  if (!parsed.success) return fail('PUBLIC_RUN_EVENT_INVALID');
  const event: PublicRunEventV1 = parsed.data;
  return `id: ${event.sequence}\nevent: ${event.type}\nretry: 1500\ndata: ${JSON.stringify(event)}\n\n`;
}

export function preparePublicRunEventBatch(input: {
  readonly runId: string;
  readonly acceptedRequestId: string;
  readonly cursor: string | null;
  readonly events: readonly unknown[];
}): readonly PublicRunEventV1[] {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(',') !== 'acceptedRequestId,cursor,events,runId' ||
    !UuidV1Schema.safeParse(input.runId).success ||
    !UuidV1Schema.safeParse(input.acceptedRequestId).success ||
    !Array.isArray(input.events) ||
    input.events.length > 1_000
  ) {
    return fail('PUBLIC_RUN_EVENT_BATCH_INVALID');
  }
  let previous = input.cursor === null ? 0n : BigInt(readCursorValue(input.cursor) ?? '0');
  const events: PublicRunEventV1[] = [];
  for (const value of input.events) {
    const parsed = PublicRunEventV1Schema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.run_id !== input.runId ||
      parsed.data.accepted_request_id !== input.acceptedRequestId
    ) {
      return fail('PUBLIC_RUN_EVENT_BATCH_INVALID');
    }
    const sequence = BigInt(parsed.data.sequence);
    if (sequence <= previous) return fail('PUBLIC_RUN_EVENT_BATCH_INVALID');
    previous = sequence;
    events.push(freeze(parsed.data));
  }
  return Object.freeze(events);
}
