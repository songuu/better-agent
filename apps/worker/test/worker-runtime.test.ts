import { describe, expect, it, vi } from 'vitest';

import { runWorkerCycle, type WorkerJobStore } from '../src/worker-runtime.js';

const strategy = Object.freeze({
  forcedCapability: 'none' as const,
  maxInputTokens: 1_000,
  maxIterations: 1 as const,
  maxOutputTokens: 1_000,
  maxToolCalls: 0,
  schemaVersion: 'product-agent-strategy/5' as const,
  temperature: 0,
});

function createStore(overrides: Partial<WorkerJobStore> = {}): WorkerJobStore {
  return {
    claim: vi.fn().mockResolvedValue({
      chains: [
        [
          {
            agentId: '00000000-0000-4000-8000-000000000002',
            branch: 1,
            depth: 1,
            instructions: 'child',
            maxOutputTokens: 100,
            model: 'gpt-5.4-mini',
            name: 'Researcher',
            releaseVersion: 1,
            strategyProfile: strategy,
            temperature: 0,
          },
        ],
      ],
      childRunId: '00000000-0000-4000-8000-000000000003',
      leaseGeneration: 7,
      leaseToken: '00000000-0000-4000-8000-000000000004',
      parentIteration: 2,
      prompt: 'investigate',
    }),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    recordInvocation: vi.fn().mockResolvedValue(undefined),
    renew: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('runWorkerCycle', () => {
  it('claims one job and completes it with exact lease fencing and aggregate output', async () => {
    const store = createStore();
    const worked = await runWorkerCycle(store, {
      generate: vi.fn().mockResolvedValue({
        inputTokens: 4,
        outputText: 'evidence',
        outputTokens: 2,
        providerRequestId: 'response-1',
      }),
    });

    expect(worked).toBe(true);
    expect(store.recordInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ childRunId: expect.any(String), leaseGeneration: 7 }),
    );
    expect(store.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateInputTokens: 4,
        aggregateOutputTokens: 2,
        leaseGeneration: 7,
        outputText: 'evidence',
      }),
    );
    expect(store.fail).not.toHaveBeenCalled();
  });

  it('records a bounded failure through the same lease instead of completing', async () => {
    const store = createStore();
    const worked = await runWorkerCycle(store, {
      generate: vi.fn().mockRejectedValue(new Error('provider secret must not leak')),
    });

    expect(worked).toBe(true);
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'async_subagent_execution_failed',
        leaseGeneration: 7,
      }),
    );
    expect(store.fail).toHaveBeenCalledWith(
      expect.not.objectContaining({
        errorCode: expect.stringContaining('secret'),
      }),
    );
  });

  it('returns false without model activity when no job can be leased', async () => {
    const store = createStore({ claim: vi.fn().mockResolvedValue(undefined) });
    const generate = vi.fn();

    expect(await runWorkerCycle(store, { generate })).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });

  it('renews the exact lease while model execution remains in flight', async () => {
    let finishGeneration: (() => void) | undefined;
    const store = createStore();
    vi.mocked(store.renew).mockImplementationOnce(async () => finishGeneration?.());
    const generate = vi.fn(
      async () =>
        await new Promise<{
          inputTokens: number;
          outputText: string;
          outputTokens: number;
          providerRequestId: string;
        }>((resolve) => {
          finishGeneration = () =>
            resolve({
              inputTokens: 4,
              outputText: 'renewed evidence',
              outputTokens: 2,
              providerRequestId: 'response-renewed',
            });
        }),
    );

    await runWorkerCycle(store, { generate }, { heartbeatIntervalMs: 1, sleep: async () => {} });

    expect(store.renew).toHaveBeenCalledWith(
      expect.objectContaining({ leaseGeneration: 7, leaseToken: expect.any(String) }),
    );
    expect(store.complete).toHaveBeenCalledOnce();
  });
});
