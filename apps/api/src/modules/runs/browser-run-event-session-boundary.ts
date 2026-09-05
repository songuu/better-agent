import { randomBytes as cryptoRandomBytes, randomUUID } from 'node:crypto';

import {
  deriveRunEventSessionVerifier,
  formatRunEventSessionToken,
  withRunEventSessionVerifier,
} from '@better-agent/auth';
import { UuidV1Schema } from '@better-agent/domain-contracts';
import { readRunEventCursor } from '@better-agent/run-core';

import {
  authenticateBrowserRunIdentityInTransaction,
  authorizeBrowserOriginalRunInTransaction,
} from './browser-run-auth.js';
import {
  type AuthorizedPublicRunEvents,
  type PublicRunEventsReadTransaction,
  readAuthorizedPublicRunEvents,
} from './run-events.js';
import {
  type BrowserSessionIdentityFacts,
  hasExactKeys,
  type OriginalRunAuthorizationFacts,
  type RunDatabaseTransaction,
} from './run-transaction.js';

export class BrowserRunEventSessionBoundaryError extends Error {
  constructor(readonly code: 'RUN_EVENT_SESSION_INVALID' | 'RUN_EVENTS_NOT_FOUND') {
    super(code);
    this.name = 'BrowserRunEventSessionBoundaryError';
  }
}

export interface IssueRunEventSessionCommand {
  readonly eventSessionId: string;
  readonly verifier: Uint8Array;
  readonly runId: string;
  readonly authorization: OriginalRunAuthorizationFacts;
}

export interface AuthenticateRunEventSessionCommand {
  readonly eventSessionId: string;
  readonly verifier: Uint8Array;
  readonly actualOrigin: string;
}

export interface BrowserRunEventSessionTransaction
  extends RunDatabaseTransaction,
    PublicRunEventsReadTransaction {
  issueRunEventSession(command: IssueRunEventSessionCommand): Promise<unknown>;
  authenticateRunEventSession(command: AuthenticateRunEventSessionCommand): Promise<unknown>;
}

export interface BrowserRunEventSessionBoundaryDependencies {
  browserSessionPepper(): Promise<Uint8Array>;
  eventSessionPepper(): Promise<Uint8Array>;
  withTransaction<T>(
    callback: (transaction: BrowserRunEventSessionTransaction) => Promise<T>,
  ): Promise<T>;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly randomUuid?: () => string;
}

export interface CreateBrowserRunEventSessionInput {
  readonly browserSessionToken: string;
  readonly declaredWorkspaceId: string;
  readonly runId: string;
}

export interface StreamBrowserRunEventsInput {
  readonly eventSessionToken: string;
  readonly runId: string;
  readonly actualOrigin: string;
  readonly accept: string;
  readonly cursor?: string;
  readonly lastEventId?: string;
}

export interface BrowserRunEventSessionResponse {
  readonly status: 204;
  readonly body: null;
  readonly headers: Readonly<{
    'Cache-Control': 'no-store';
    Pragma: 'no-cache';
    'Set-Cookie': string;
  }>;
}

export interface BrowserRunEventSessionBoundary {
  createSession(input: CreateBrowserRunEventSessionInput): Promise<BrowserRunEventSessionResponse>;
  streamEvents(input: StreamBrowserRunEventsInput): Promise<AuthorizedPublicRunEvents>;
}

function isCanonicalHttpsOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.origin === value &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
}

function readEventIdentity(
  value: unknown,
): BrowserSessionIdentityFacts & { readonly runId: string } {
  if (
    !hasExactKeys(value, [
      'agent_deployment_id',
      'browser_session_id',
      'end_user_principal_id',
      'observed_deployment_revoke_epoch',
      'observed_principal_session_epoch',
      'run_id',
      'session_epoch',
      'workspace_id',
    ]) ||
    !UuidV1Schema.safeParse(value.workspace_id).success ||
    !UuidV1Schema.safeParse(value.run_id).success ||
    !UuidV1Schema.safeParse(value.browser_session_id).success ||
    !UuidV1Schema.safeParse(value.end_user_principal_id).success ||
    !UuidV1Schema.safeParse(value.agent_deployment_id).success ||
    ![
      value.session_epoch,
      value.observed_principal_session_epoch,
      value.observed_deployment_revoke_epoch,
    ].every((epoch) => Number.isSafeInteger(epoch) && (epoch as number) >= 0)
  ) {
    throw new BrowserRunEventSessionBoundaryError('RUN_EVENT_SESSION_INVALID');
  }
  return Object.freeze({
    workspaceId: value.workspace_id as string,
    runId: value.run_id as string,
    browserSessionId: value.browser_session_id as string,
    endUserPrincipalId: value.end_user_principal_id as string,
    agentDeploymentId: value.agent_deployment_id as string,
    sessionAuthorizationEpoch: value.session_epoch as number,
    principalAuthorizationEpoch: value.observed_principal_session_epoch as number,
    deploymentAuthorizationEpoch: value.observed_deployment_revoke_epoch as number,
  });
}

function readIssueReceipt(value: unknown, eventSessionId: string, runId: string) {
  if (
    !hasExactKeys(value, [
      'cookie_path',
      'event_session_id',
      'expires_at',
      'max_age_seconds',
      'run_id',
    ]) ||
    value.event_session_id !== eventSessionId ||
    value.run_id !== runId ||
    value.cookie_path !== `/v1/oapi/runs/${runId}/events` ||
    !Number.isSafeInteger(value.max_age_seconds) ||
    (value.max_age_seconds as number) < 1 ||
    (value.max_age_seconds as number) > 60 ||
    typeof value.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(value.expires_at))
  ) {
    throw new BrowserRunEventSessionBoundaryError('RUN_EVENT_SESSION_INVALID');
  }
  return { path: value.cookie_path as string, maxAge: value.max_age_seconds as number };
}

function readCursor(input: { cursor?: string; lastEventId?: string }): string | null {
  try {
    return readRunEventCursor({
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.lastEventId === undefined ? {} : { lastEventId: input.lastEventId }),
    });
  } catch {
    throw new BrowserRunEventSessionBoundaryError('RUN_EVENT_SESSION_INVALID');
  }
}

export function createBrowserRunEventSessionBoundary(
  dependencies: BrowserRunEventSessionBoundaryDependencies,
): BrowserRunEventSessionBoundary {
  return Object.freeze({
    async createSession(input: CreateBrowserRunEventSessionInput) {
      if (
        !hasExactKeys(input, ['browserSessionToken', 'declaredWorkspaceId', 'runId']) ||
        typeof input.browserSessionToken !== 'string' ||
        !UuidV1Schema.safeParse(input.declaredWorkspaceId).success ||
        !UuidV1Schema.safeParse(input.runId).success
      ) {
        throw new BrowserRunEventSessionBoundaryError('RUN_EVENT_SESSION_INVALID');
      }
      let secret: Buffer | undefined;
      let pepper: Buffer | undefined;
      let verifier: Buffer | undefined;
      try {
        const eventSessionId = (dependencies.randomUuid ?? randomUUID)();
        secret = Buffer.from((dependencies.randomBytes ?? cryptoRandomBytes)(32));
        pepper = Buffer.from(await dependencies.eventSessionPepper());
        verifier = deriveRunEventSessionVerifier(secret, pepper);
        const token = formatRunEventSessionToken({ eventSessionId, secret });
        const receipt = await dependencies.withTransaction(async (transaction) => {
          const identity = await authenticateBrowserRunIdentityInTransaction({
            transaction,
            token: input.browserSessionToken,
            declaredWorkspaceId: input.declaredWorkspaceId,
            browserSessionPepper: dependencies.browserSessionPepper,
          });
          const authorization = await authorizeBrowserOriginalRunInTransaction({
            transaction,
            identity,
            runId: input.runId,
            requiredScope: 'run:events:read',
          });
          return transaction.issueRunEventSession({
            eventSessionId,
            verifier: verifier as Buffer,
            runId: input.runId,
            authorization,
          });
        });
        const issued = readIssueReceipt(receipt, eventSessionId, input.runId);
        return Object.freeze({
          status: 204 as const,
          body: null,
          headers: Object.freeze({
            'Cache-Control': 'no-store' as const,
            Pragma: 'no-cache' as const,
            'Set-Cookie': `__Secure-ba_run_event_session=${token}; Path=${issued.path}; Max-Age=${issued.maxAge}; HttpOnly; Secure; SameSite=Strict`,
          }),
        });
      } catch (error) {
        if (error instanceof BrowserRunEventSessionBoundaryError) throw error;
        throw new BrowserRunEventSessionBoundaryError('RUN_EVENTS_NOT_FOUND');
      } finally {
        secret?.fill(0);
        pepper?.fill(0);
        verifier?.fill(0);
      }
    },
    async streamEvents(input: StreamBrowserRunEventsInput) {
      if (
        typeof input !== 'object' ||
        input === null ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (key) =>
            ![
              'accept',
              'actualOrigin',
              'cursor',
              'eventSessionToken',
              'lastEventId',
              'runId',
            ].includes(key),
        ) ||
        typeof input.eventSessionToken !== 'string' ||
        !UuidV1Schema.safeParse(input.runId).success ||
        input.accept !== 'text/event-stream' ||
        typeof input.actualOrigin !== 'string' ||
        !isCanonicalHttpsOrigin(input.actualOrigin)
      ) {
        throw new BrowserRunEventSessionBoundaryError('RUN_EVENT_SESSION_INVALID');
      }
      const cursor = readCursor(input);
      let pepper: Buffer | undefined;
      try {
        pepper = Buffer.from(await dependencies.eventSessionPepper());
        return await withRunEventSessionVerifier(input.eventSessionToken, pepper, async (proof) =>
          dependencies.withTransaction(async (transaction) => {
            const identity = readEventIdentity(
              await transaction.authenticateRunEventSession({
                eventSessionId: proof.eventSessionId,
                verifier: proof.verifier,
                actualOrigin: input.actualOrigin,
              }),
            );
            if (identity.runId !== input.runId) {
              throw new BrowserRunEventSessionBoundaryError('RUN_EVENTS_NOT_FOUND');
            }
            const authorization = await authorizeBrowserOriginalRunInTransaction({
              transaction,
              identity,
              runId: input.runId,
              requiredScope: 'run:events:read',
            });
            return readAuthorizedPublicRunEvents({
              transaction,
              authorization,
              runId: input.runId,
              cursor,
            });
          }),
        );
      } catch (error) {
        if (error instanceof BrowserRunEventSessionBoundaryError) throw error;
        throw new BrowserRunEventSessionBoundaryError('RUN_EVENTS_NOT_FOUND');
      } finally {
        pepper?.fill(0);
      }
    },
  });
}
