import { describe, expect, it, vi } from 'vitest';

import { readAuthorizedPublicRunEvents } from '../src/modules/runs/index.js';

const workspaceId = '01900000-0000-7000-8000-000000000001';
const runId = '01900000-0000-7000-8000-000000000002';
const acceptedRequestId = '01900000-0000-7000-8000-000000000003';
const event = {
  schema_version: 'run-event/1',
  event_id: '01900000-0000-7000-8000-000000000004',
  sequence: '2',
  occurred_at: '2026-09-05T00:00:00.000Z',
  accepted_request_id: acceptedRequestId,
  run_id: runId,
  type: 'run.started',
  data: { status: 'RUNNING' },
} as const;

function authorization() {
  return {
    workspaceId,
    runId,
    acceptedPrincipal: {
      schema_version: 'conversation-principal/1' as const,
      kind: 'credential' as const,
      credential_id: '01900000-0000-7000-8000-000000000005',
    },
    targetKind: 'agent' as const,
    deploymentId: '01900000-0000-7000-8000-000000000006',
    authorizedScope: 'run:events:read' as const,
  };
}

describe('authorized public Run events', () => {
  it('reads a bounded projection and returns canonical frames', async () => {
    const readPublicRunEvents = vi.fn(async () => ({
      accepted_request_id: acceptedRequestId,
      events: [event],
    }));
    const result = await readAuthorizedPublicRunEvents({
      transaction: { readPublicRunEvents },
      authorization: authorization(),
      runId,
      cursor: '1',
    });
    expect(readPublicRunEvents).toHaveBeenCalledWith({
      workspaceId,
      runId,
      cursor: '1',
      authorization: authorization(),
    });
    expect(result.events).toEqual([event]);
    expect(result.frames[0]).toContain('id: 2\nevent: run.started\n');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    [{ ...authorization(), runId: '01900000-0000-7000-8000-000000000099' }],
    [{ ...authorization(), authorizedScope: 'run:read' as const }],
  ])('rejects authorization not bound to the requested event stream', async (facts) => {
    const readPublicRunEvents = vi.fn();
    await expect(
      readAuthorizedPublicRunEvents({
        transaction: { readPublicRunEvents },
        authorization: facts,
        runId,
        cursor: null,
      }),
    ).rejects.toThrow('RUN_EVENTS_NOT_FOUND');
    expect(readPublicRunEvents).not.toHaveBeenCalled();
  });

  it('rejects crossed or internal database projections', async () => {
    const readPublicRunEvents = vi.fn(async () => ({
      accepted_request_id: acceptedRequestId,
      events: [{ ...event, plan_hash: 'secret' }],
    }));
    await expect(
      readAuthorizedPublicRunEvents({
        transaction: { readPublicRunEvents },
        authorization: authorization(),
        runId,
        cursor: '1',
      }),
    ).rejects.toThrow('RUN_EVENTS_PROJECTION_INVALID');
  });

  it('maps a hidden database result to the indistinguishable not-found outcome', async () => {
    await expect(
      readAuthorizedPublicRunEvents({
        transaction: { readPublicRunEvents: vi.fn(async () => null) },
        authorization: authorization(),
        runId,
        cursor: null,
      }),
    ).rejects.toThrow('RUN_EVENTS_NOT_FOUND');
  });
});
