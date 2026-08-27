import { describe, expect, it } from 'vitest';

import { createHumanGateBoundary, type HumanGateBoundaryError } from '../src/modules/runs/index.js';

const runId = '018f47f2-c541-7cc6-9292-4a2c35303ee2';
const gateId = '018f47f2-c541-7cc6-9292-4a2c35303ee3';

describe('G0-06 HumanGate paused boundary', () => {
  it('validates submit/approve/reject intents but keeps every positive resume unavailable', async () => {
    const boundary = createHumanGateBoundary();
    for (const input of [
      { runId, gateId, idempotencyKey: 'gate-key', action: 'approve' as const },
      { runId, gateId, idempotencyKey: 'gate-key', action: 'reject' as const },
      {
        runId,
        gateId,
        idempotencyKey: 'gate-key',
        action: 'submit' as const,
        input: { answer: 'yes' },
      },
    ]) {
      await expect(boundary.resume(input)).rejects.toEqual(
        expect.objectContaining<Partial<HumanGateBoundaryError>>({
          code: 'RUN_HUMAN_GATE_APPLY_UNAVAILABLE',
        }),
      );
    }
  });

  it('keeps expiry unavailable and exposes no claim/decision/attempt/finalizer seam', async () => {
    const boundary = createHumanGateBoundary();

    await expect(boundary.expire({ runId, gateId })).rejects.toEqual(
      expect.objectContaining({ code: 'RUN_HUMAN_GATE_APPLY_UNAVAILABLE' }),
    );
    expect(boundary).not.toHaveProperty('claim');
    expect(boundary).not.toHaveProperty('decide');
    expect(boundary).not.toHaveProperty('createAttempt');
    expect(boundary).not.toHaveProperty('finalize');
    expect(boundary).not.toHaveProperty('withTransaction');
  });

  it('rejects authority fields and malformed intent before the unavailable result', async () => {
    const boundary = createHumanGateBoundary();

    await expect(
      boundary.resume({
        runId,
        gateId,
        idempotencyKey: 'gate-key',
        action: 'approve',
        principal: { kind: 'credential' },
      } as never),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_BOUNDARY_INPUT_INVALID' }));
    await expect(
      boundary.resume({
        runId: 'not-a-uuid',
        gateId,
        idempotencyKey: 'gate-key',
        action: 'approve',
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_BOUNDARY_INPUT_INVALID' }));
    await expect(boundary.expire({ runId, gateId, transaction: {} } as never)).rejects.toEqual(
      expect.objectContaining({ code: 'RUN_BOUNDARY_INPUT_INVALID' }),
    );
    await expect(
      boundary.resume({
        runId,
        gateId,
        idempotencyKey: 'gate-key',
        action: 'submit',
        input: undefined,
      } as unknown as Parameters<typeof boundary.resume>[0]),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_BOUNDARY_INPUT_INVALID' }));
    await expect(
      boundary.resume({
        runId,
        gateId,
        idempotencyKey: 1,
        action: 'approve',
      } as never),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_BOUNDARY_INPUT_INVALID' }));
    await expect(boundary.expire({ runId: 'not-a-uuid', gateId })).rejects.toEqual(
      expect.objectContaining({ code: 'RUN_BOUNDARY_INPUT_INVALID' }),
    );
    await expect(boundary.expire({ runId, gateId: 'not-a-uuid' })).rejects.toEqual(
      expect.objectContaining({ code: 'RUN_BOUNDARY_INPUT_INVALID' }),
    );
  });
});
