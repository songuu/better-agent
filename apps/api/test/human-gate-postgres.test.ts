import { describe, expect, it, vi } from 'vitest';

import type { G1SourceSqlQueryClient } from '../src/modules/releases/g1-source-postgres-readback.js';
import { createHumanGatePostgresAdapter } from '../src/modules/runs/index.js';

const runId = '018f47f2-c541-7cc6-9292-4a2c35304001';
const gateId = '018f47f2-c541-7cc6-9292-4a2c35304002';
const command = {
  workspaceId: '018f47f2-c541-7cc6-9292-4a2c35304003',
  authenticatedPrincipal: {
    schema_version: 'conversation-principal/1' as const,
    kind: 'credential' as const,
    credential_id: '018f47f2-c541-7cc6-9292-4a2c35304004',
  },
  browserIdentity: null,
  idempotencyKey: 'resume-1',
  runId,
  gateId,
  action: 'approve' as const,
  requiredScope: 'run:resume' as const,
};

describe('Human Gate PostgreSQL adapter', () => {
  it('calls only the atomic definer function and accepts every closed outcome', async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          result: {
            outcome: 'ACCEPTED',
            receipt: {
              http_status: 202,
              data: {
                run_id: runId,
                accepted_request_id: '018f47f2-c541-7cc6-9292-4a2c35304005',
                status: 'RUNNING',
                outcome: 'RUN_RESUMED',
                operation_url: `/v1/oapi/runs/${runId}`,
                events_url: `/v1/oapi/runs/${runId}/events`,
              },
            },
          },
        },
      ],
    }));
    const adapter = createHumanGatePostgresAdapter({ query } as G1SourceSqlQueryClient);
    await expect(adapter.resume(command)).resolves.toMatchObject({ outcome: 'ACCEPTED' });
    expect(query).toHaveBeenCalledWith('SELECT app.resume_human_gate($1::jsonb) AS result', [
      JSON.stringify(command),
    ]);
  });

  it('rejects open or action/input-drifting commands before SQL', async () => {
    const query = vi.fn();
    const adapter = createHumanGatePostgresAdapter({ query } as G1SourceSqlQueryClient);
    await expect(adapter.resume({ ...command, action: 'submit' })).rejects.toMatchObject({
      code: 'INPUT_INVALID',
    });
    await expect(adapter.resume({ ...command, injected: true } as never)).rejects.toMatchObject({
      code: 'INPUT_INVALID',
    });
    await expect(
      adapter.resume({
        ...command,
        authenticatedPrincipal: { ...command.authenticatedPrincipal, injected: true } as never,
      }),
    ).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects malformed database projections and normalizes query errors', async () => {
    const malformed = createHumanGatePostgresAdapter({
      query: vi.fn(async () => ({ rows: [{ result: { outcome: 'MAYBE' } }] })),
    } as unknown as G1SourceSqlQueryClient);
    await expect(malformed.resume(command)).rejects.toMatchObject({ code: 'PROJECTION_INVALID' });
    const failed = createHumanGatePostgresAdapter({
      query: vi.fn(async () => {
        throw new Error('private SQL detail');
      }),
    } as unknown as G1SourceSqlQueryClient);
    await expect(failed.resume(command)).rejects.toMatchObject({ code: 'QUERY_FAILED' });
  });
});
