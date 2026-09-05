import { formatBrowserSessionToken } from '@better-agent/auth';
import { describe, expect, it, vi } from 'vitest';

import {
  createBrowserRunEventSessionBoundary,
  type BrowserRunEventSessionBoundaryDependencies,
  type BrowserRunEventSessionTransaction,
} from '../src/modules/runs/index.js';

const workspaceId = '01900000-0000-7000-8000-000000000001';
const runId = '01900000-0000-7000-8000-000000000002';
const requestId = '01900000-0000-7000-8000-000000000003';
const browserSessionId = '01900000-0000-7000-8000-000000000004';
const principalId = '01900000-0000-7000-8000-000000000005';
const deploymentId = '01900000-0000-7000-8000-000000000006';
const eventSessionId = '01900000-0000-7000-8000-000000000007';
const browserSecret = Buffer.alloc(32, 3);
const eventSecret = Buffer.alloc(32, 5);
const browserToken = formatBrowserSessionToken({ browserSessionId, secret: browserSecret });
const event = {
  schema_version: 'run-event/1',
  event_id: '01900000-0000-7000-8000-000000000008',
  sequence: '2',
  occurred_at: '2026-09-05T00:00:00.000Z',
  accepted_request_id: requestId,
  run_id: runId,
  type: 'run.started',
  data: { status: 'RUNNING' },
} as const;

function identity() {
  return {
    workspace_id: workspaceId,
    run_id: runId,
    browser_session_id: browserSessionId,
    end_user_principal_id: principalId,
    agent_deployment_id: deploymentId,
    session_epoch: 1,
    observed_principal_session_epoch: 2,
    observed_deployment_revoke_epoch: 3,
  };
}

function authorization() {
  return {
    workspaceId,
    runId,
    acceptedPrincipal: {
      schema_version: 'conversation-principal/1' as const,
      kind: 'end_user' as const,
      end_user_principal_id: principalId,
    },
    targetKind: 'agent' as const,
    deploymentId,
    authorizedScope: 'run:events:read' as const,
    browserSessionId,
    sessionAuthorizationEpoch: 1,
    principalAuthorizationEpoch: 2,
    deploymentAuthorizationEpoch: 3,
  };
}

function fixture() {
  const transaction = {
    trustedBrowserRequestContext: vi.fn(() => ({
      actualOrigin: 'https://agent.example.com',
      tokenAudience: 'agent_browser_api' as const,
      clientChannel: 'WEB_SDK' as const,
    })),
    authenticateBrowserSessionIdentity: vi.fn(async () => {
      const { run_id: _, ...browserIdentity } = identity();
      return browserIdentity;
    }),
    authorizeBrowserOriginalRun: vi.fn(async () => authorization()),
    issueRunEventSession: vi.fn(async (_command: unknown) => ({
      event_session_id: eventSessionId,
      run_id: runId,
      expires_at: '2026-09-05T00:00:59.000Z',
      max_age_seconds: 59,
      cookie_path: `/v1/oapi/runs/${runId}/events`,
    })),
    authenticateRunEventSession: vi.fn(async () => identity()),
    readPublicRunEvents: vi.fn(async () => ({ accepted_request_id: requestId, events: [event] })),
  };
  const withTransaction = vi.fn(async (callback) =>
    callback(transaction as unknown as BrowserRunEventSessionTransaction),
  );
  const boundary = createBrowserRunEventSessionBoundary({
    browserSessionPepper: async () => Buffer.alloc(32, 4),
    eventSessionPepper: async () => Buffer.alloc(32, 6),
    randomBytes: () => eventSecret,
    randomUuid: () => eventSessionId,
    withTransaction:
      withTransaction as unknown as BrowserRunEventSessionBoundaryDependencies['withTransaction'],
  });
  return { boundary, transaction };
}

describe('G1-A6 browser Run event session boundary', () => {
  it('returns the capability only in a host-only, Run-path-limited no-store cookie', async () => {
    const { boundary, transaction } = fixture();
    const response = await boundary.createSession({
      browserSessionToken: browserToken,
      declaredWorkspaceId: workspaceId,
      runId,
    });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(response.headers['Set-Cookie']).toMatch(
      new RegExp(
        `^__Secure-ba_run_event_session=res1\\.${eventSessionId}\\.[A-Za-z0-9_-]{43}; Path=/v1/oapi/runs/${runId}/events; Max-Age=59; HttpOnly; Secure; SameSite=Strict$`,
        'u',
      ),
    );
    expect(response.headers['Set-Cookie']).not.toContain('Domain=');
    const issued = transaction.issueRunEventSession.mock.calls[0]?.[0];
    expect(issued).toMatchObject({ eventSessionId, runId, authorization: authorization() });
    expect(JSON.stringify(issued)).not.toContain(eventSecret.toString('base64url'));
  });

  it('authenticates the cookie against the actual origin and streams only its bound Run', async () => {
    const { boundary, transaction } = fixture();
    const issued = await boundary.createSession({
      browserSessionToken: browserToken,
      declaredWorkspaceId: workspaceId,
      runId,
    });
    const eventSessionToken = issued.headers['Set-Cookie'].split(';', 1)[0]?.split('=', 2)[1];
    expect(eventSessionToken).toBeDefined();
    const result = await boundary.streamEvents({
      eventSessionToken: eventSessionToken as string,
      runId,
      actualOrigin: 'https://agent.example.com',
      accept: 'text/event-stream',
      cursor: '1',
    });
    expect(transaction.authenticateRunEventSession).toHaveBeenCalledWith(
      expect.objectContaining({ eventSessionId, actualOrigin: 'https://agent.example.com' }),
    );
    expect(transaction.authorizeBrowserOriginalRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ runId, requiredScope: 'run:events:read' }),
    );
    expect(result.frames[0]).toContain('event: run.started');
  });

  it('hides a crossed Run before projection readback', async () => {
    const { boundary, transaction } = fixture();
    const issued = await boundary.createSession({
      browserSessionToken: browserToken,
      declaredWorkspaceId: workspaceId,
      runId,
    });
    const token = issued.headers['Set-Cookie'].split(';', 1)[0]?.split('=', 2)[1] as string;
    await expect(
      boundary.streamEvents({
        eventSessionToken: token,
        runId: '01900000-0000-7000-8000-000000000099',
        actualOrigin: 'https://agent.example.com',
        accept: 'text/event-stream',
      }),
    ).rejects.toThrow('RUN_EVENTS_NOT_FOUND');
    expect(transaction.readPublicRunEvents).not.toHaveBeenCalled();
  });

  it.each(['null', 'https://agent.example.com/path', 'http://agent.example.com'])(
    'rejects non-canonical event origins before database authentication: %s',
    async (actualOrigin) => {
      const { boundary, transaction } = fixture();
      await expect(
        boundary.streamEvents({
          eventSessionToken: 'invalid',
          runId,
          actualOrigin,
          accept: 'text/event-stream',
        }),
      ).rejects.toThrow('RUN_EVENT_SESSION_INVALID');
      expect(transaction.authenticateRunEventSession).not.toHaveBeenCalled();
    },
  );
});
