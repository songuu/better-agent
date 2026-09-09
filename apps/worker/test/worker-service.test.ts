import { describe, expect, it, vi } from 'vitest';

import { runWorkerLoop, workerConfigurationFromEnvironment } from '../src/worker-service.js';

describe('worker service loop', () => {
  it('polls again after an idle cycle and stops at the abort boundary', async () => {
    const controller = new AbortController();
    const cycle = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async () => {
        controller.abort();
        return true;
      });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await runWorkerLoop({ cycle, idleDelayMs: 250, signal: controller.signal, sleep });

    expect(cycle).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(250, controller.signal);
  });

  it('rejects an unconfigured model runtime before connecting to PostgreSQL', () => {
    expect(() => workerConfigurationFromEnvironment({ PGHOST: '127.0.0.1' })).toThrow(
      'worker_model_runtime_unconfigured',
    );
  });

  it('accepts bounded worker identity, lease and poll configuration', () => {
    expect(
      workerConfigurationFromEnvironment({
        BETTER_AGENT_MODEL_API_KEY: 'test-secret',
        BETTER_AGENT_WORKER_ID: 'production-worker-1',
        BETTER_AGENT_WORKER_LEASE_SECONDS: '60',
        BETTER_AGENT_WORKER_POLL_MS: '500',
      }),
    ).toMatchObject({
      idleDelayMs: 500,
      leaseSeconds: 60,
      workerId: 'production-worker-1',
    });
  });
});
