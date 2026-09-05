import { formatAccessKey } from '@better-agent/auth';
import { describe, expect, it, vi } from 'vitest';

import { createAuthBoundary } from '../src/modules/auth/index.js';
import {
  createRunEventsStreamBoundary,
  type RunDatabaseTransaction,
  type RunEventsStreamBoundaryDependencies,
} from '../src/modules/runs/index.js';

const workspaceId = '01900000-0000-7000-8000-000000000001';
const runId = '01900000-0000-7000-8000-000000000002';
const requestId = '01900000-0000-7000-8000-000000000003';
const credentialId = '01900000-0000-7000-8000-000000000004';
const keyId = '01900000-0000-7000-8000-000000000005';
const deploymentId = '01900000-0000-7000-8000-000000000006';
const accessKey = formatAccessKey({ keyId, secret: Buffer.alloc(32, 3) });
const event = {
  schema_version: 'run-event/1',
  event_id: '01900000-0000-7000-8000-000000000007',
  sequence: '2',
  occurred_at: '2026-09-05T00:00:00.000Z',
  accepted_request_id: requestId,
  run_id: runId,
  type: 'run.started',
  data: { status: 'RUNNING' },
} as const;

function fixture() {
  const transaction = {
    authenticateCredential: vi.fn(async () => ({
      credentialId,
      credentialAuthorizationEpoch: 1,
      credentialKind: 'service_api' as const,
      scopes: ['run:events:read'] as const,
      workspaceId,
      workspaceAuthorizationEpoch: 2,
    })),
    authorizeServiceOriginalRun: vi.fn(async () => ({
      acceptedPrincipal: {
        schema_version: 'conversation-principal/1' as const,
        kind: 'credential' as const,
        credential_id: credentialId,
      },
      authorizedScope: 'run:events:read' as const,
      deploymentId,
      runId,
      targetKind: 'agent' as const,
      workspaceId,
    })),
    readPublicRunEvents: vi.fn(async () => ({ accepted_request_id: requestId, events: [event] })),
  };
  const withTransaction = vi.fn(async (callback) =>
    callback(
      transaction as unknown as RunDatabaseTransaction & {
        readPublicRunEvents(): Promise<unknown>;
      },
    ),
  );
  const boundary = createRunEventsStreamBoundary({
    authBoundary: createAuthBoundary({ accessKeyPepper: async () => Buffer.alloc(32, 4) }),
    withTransaction:
      withTransaction as unknown as RunEventsStreamBoundaryDependencies['withTransaction'],
  });
  return { boundary, transaction, withTransaction };
}

describe('G1-A6 service Run event stream boundary', () => {
  it('authenticates the reviewed route, authorizes the original Run and reads after the cursor', async () => {
    const { boundary, transaction, withTransaction } = fixture();
    const result = await boundary.streamServiceEvents({
      accessKey,
      declaredWorkspaceId: workspaceId,
      runId,
      accept: 'text/event-stream',
      cursor: '1',
      lastEventId: '1',
    });
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(transaction.authorizeServiceOriginalRun).toHaveBeenCalledWith({
      workspaceId,
      credentialId,
      runId,
      requiredScope: 'run:events:read',
    });
    expect(transaction.readPublicRunEvents).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, runId, cursor: '1' }),
    );
    expect(result.frames[0]).toContain('event: run.started');
  });

  it.each([
    [{ accept: 'application/json' }],
    [{ cursor: '01' }],
    [{ cursor: '1', lastEventId: '2' }],
  ])('rejects invalid SSE negotiation or cursor before authentication', async (override) => {
    const { boundary, transaction } = fixture();
    await expect(
      boundary.streamServiceEvents({
        accessKey,
        declaredWorkspaceId: workspaceId,
        runId,
        accept: 'text/event-stream',
        ...override,
      }),
    ).rejects.toThrow('RUN_EVENTS_INPUT_INVALID');
    expect(transaction.authenticateCredential).not.toHaveBeenCalled();
  });
});
