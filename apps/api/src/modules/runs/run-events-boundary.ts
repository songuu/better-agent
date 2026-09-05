import type { ServiceCredentialRouteBindingInput } from '@better-agent/auth';
import { UuidV1Schema } from '@better-agent/domain-contracts';
import { readRunEventCursor } from '@better-agent/run-core';

import type { AuthBoundary } from '../auth/index.js';
import { authorizeServiceEventStreamInTransaction } from './original-run-authorization.js';
import {
  type AuthorizedPublicRunEvents,
  type PublicRunEventsReadTransaction,
  readAuthorizedPublicRunEvents,
} from './run-events.js';
import type { RunDatabaseTransaction } from './run-transaction.js';

const streamRoute = {
  method: 'GET',
  operationId: 'streamRunEvents',
  routeTemplate: '/v1/oapi/runs/{run_id}/events',
} as const satisfies ServiceCredentialRouteBindingInput;

export class RunEventsStreamBoundaryError extends Error {
  constructor(readonly code: 'RUN_EVENTS_INPUT_INVALID') {
    super(code);
    this.name = 'RunEventsStreamBoundaryError';
  }
}

export interface ServiceRunEventsStreamInput {
  readonly accessKey: string;
  readonly declaredWorkspaceId: string;
  readonly runId: string;
  readonly accept: string;
  readonly cursor?: string;
  readonly lastEventId?: string;
}

type RunEventsStreamTransaction = RunDatabaseTransaction & PublicRunEventsReadTransaction;

export interface RunEventsStreamBoundaryDependencies {
  readonly authBoundary: AuthBoundary;
  withTransaction<T>(callback: (transaction: RunEventsStreamTransaction) => Promise<T>): Promise<T>;
}

export interface RunEventsStreamBoundary {
  streamServiceEvents(input: ServiceRunEventsStreamInput): Promise<AuthorizedPublicRunEvents>;
}

const allowedInputKeys = new Set([
  'accept',
  'accessKey',
  'cursor',
  'declaredWorkspaceId',
  'lastEventId',
  'runId',
]);

function snapshotInput(input: ServiceRunEventsStreamInput) {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowedInputKeys.has(key)) ||
    typeof input.accessKey !== 'string' ||
    typeof input.declaredWorkspaceId !== 'string' ||
    !UuidV1Schema.safeParse(input.runId).success ||
    input.accept !== 'text/event-stream'
  ) {
    throw new RunEventsStreamBoundaryError('RUN_EVENTS_INPUT_INVALID');
  }
  try {
    return Object.freeze({
      accessKey: input.accessKey,
      declaredWorkspaceId: input.declaredWorkspaceId,
      runId: input.runId,
      cursor: readRunEventCursor({
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.lastEventId === undefined ? {} : { lastEventId: input.lastEventId }),
      }),
    });
  } catch {
    throw new RunEventsStreamBoundaryError('RUN_EVENTS_INPUT_INVALID');
  }
}

export function createRunEventsStreamBoundary(
  dependencies: RunEventsStreamBoundaryDependencies,
): RunEventsStreamBoundary {
  const authenticate = dependencies.authBoundary.bindServiceRoute(streamRoute);
  return Object.freeze({
    async streamServiceEvents(input: ServiceRunEventsStreamInput) {
      const snapshot = snapshotInput(input);
      return dependencies.withTransaction(async (transaction) => {
        const readContext = await authenticate.authenticateAccessKey({
          accessKey: snapshot.accessKey,
          declaredWorkspaceId: snapshot.declaredWorkspaceId,
          transaction,
        });
        const authorization = await authorizeServiceEventStreamInTransaction({
          transaction,
          readContext,
          runId: snapshot.runId,
        });
        return readAuthorizedPublicRunEvents({
          transaction,
          authorization,
          runId: snapshot.runId,
          cursor: snapshot.cursor,
        });
      });
    },
  });
}
