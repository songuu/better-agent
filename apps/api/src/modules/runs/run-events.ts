import { UuidV1Schema } from '@better-agent/domain-contracts';
import {
  formatPublicRunEventSse,
  preparePublicRunEventBatch,
  type PublicRunEventV1,
} from '@better-agent/run-core';

import { hasExactKeys, type OriginalRunAuthorizationFacts } from './run-transaction.js';

export class RunEventsBoundaryError extends Error {
  constructor(readonly code: 'RUN_EVENTS_NOT_FOUND' | 'RUN_EVENTS_PROJECTION_INVALID') {
    super(code);
    this.name = 'RunEventsBoundaryError';
  }
}

export interface PublicRunEventsReadCommand {
  readonly workspaceId: string;
  readonly runId: string;
  readonly cursor: string | null;
  readonly authorization: OriginalRunAuthorizationFacts;
}

export interface PublicRunEventsReadTransaction {
  readPublicRunEvents(command: PublicRunEventsReadCommand): Promise<unknown>;
}

export interface AuthorizedPublicRunEvents {
  readonly events: readonly PublicRunEventV1[];
  readonly frames: readonly string[];
}

export async function readAuthorizedPublicRunEvents(input: {
  readonly transaction: PublicRunEventsReadTransaction;
  readonly authorization: OriginalRunAuthorizationFacts;
  readonly runId: string;
  readonly cursor: string | null;
}): Promise<AuthorizedPublicRunEvents> {
  if (
    !UuidV1Schema.safeParse(input.runId).success ||
    input.authorization.runId !== input.runId ||
    input.authorization.authorizedScope !== 'run:events:read'
  ) {
    throw new RunEventsBoundaryError('RUN_EVENTS_NOT_FOUND');
  }
  const raw = await input.transaction.readPublicRunEvents({
    workspaceId: input.authorization.workspaceId,
    runId: input.runId,
    cursor: input.cursor,
    authorization: input.authorization,
  });
  if (
    !hasExactKeys(raw, ['accepted_request_id', 'events']) ||
    !UuidV1Schema.safeParse(raw.accepted_request_id).success ||
    !Array.isArray(raw.events)
  ) {
    throw new RunEventsBoundaryError(
      raw === null ? 'RUN_EVENTS_NOT_FOUND' : 'RUN_EVENTS_PROJECTION_INVALID',
    );
  }
  try {
    const events = preparePublicRunEventBatch({
      runId: input.runId,
      acceptedRequestId: raw.accepted_request_id as string,
      cursor: input.cursor,
      events: raw.events,
    });
    return Object.freeze({
      events,
      frames: Object.freeze(events.map(formatPublicRunEventSse)),
    });
  } catch {
    throw new RunEventsBoundaryError('RUN_EVENTS_PROJECTION_INVALID');
  }
}
