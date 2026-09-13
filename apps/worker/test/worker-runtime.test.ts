import type {
  AgentActionDecisionResult,
  AgentModelGenerationInput,
} from '@better-agent/agent-runtime';
import { describe, expect, it, vi } from 'vitest';

import { PostgresWorkerJobStore } from '../src/postgres-worker-store.js';
import {
  runWorkerCycle,
  WorkerLeaseLostError,
  type WorkerJobStore,
} from '../src/worker-runtime.js';

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
        outputText: expect.stringContaining('evidence'),
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
        outputText: expect.stringContaining('evidence'),
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

  it('stops a lost lease without failing the worker or continuing a late recursive decision', async () => {
    const job = await createStore().claim();
    if (job === undefined) throw new Error('fixture job missing');
    const parent = job.chains[0]?.[0];
    if (parent === undefined) throw new Error('fixture parent missing');
    const leaseConflict = Object.assign(new Error('async SubAgent lease conflict'), {
      code: '40001',
    });
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('claim_agent_product')) {
        return {
          rows: [
            {
              job: {
                ...job,
                chains: [
                  [
                    {
                      ...parent,
                      strategyProfile: { ...strategy, maxIterations: 2, maxToolCalls: 1 },
                    },
                    { ...parent, agentId: '00000000-0000-4000-8000-000000000005', depth: 2 },
                  ],
                ],
              },
            },
          ],
        };
      }
      throw leaseConflict;
    });
    let resolveDecision: ((decision: AgentActionDecisionResult) => void) | undefined;
    let decisionInput: AgentModelGenerationInput | undefined;
    const generate = vi.fn();
    const cycle = runWorkerCycle(
      new PostgresWorkerJobStore({ query }, 'worker-test'),
      {
        decideAction: async (input) => {
          decisionInput = input;
          return await new Promise<AgentActionDecisionResult>((resolve) => {
            resolveDecision = resolve;
          });
        },
        generate,
      },
      { heartbeatIntervalMs: 1, sleep: async () => {} },
    );
    const outcome = await cycle.then(
      (value) => value,
      (error: unknown) => error,
    );
    resolveDecision?.({
      action: 'tool',
      capability: 'subagent',
      toolInput: 'late request',
      inputTokens: 1,
      outputTokens: 1,
      outputText: 'delegate',
      providerRequestId: 'late-decision',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(outcome).toBe(true);
    expect(decisionInput?.signal?.aborted).toBe(true);
    expect(generate).not.toHaveBeenCalled();
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining('claim_agent_product'),
      expect.stringContaining('renew_agent_product'),
    ]);
  });

  it.each(['renew', 'recordInvocation', 'complete'] as const)(
    'propagates an unknown %s storage error without relabeling it as a model failure',
    async (operation) => {
      const storageError = Object.assign(new Error('database connection lost'), { code: '08006' });
      const store = createStore({ [operation]: vi.fn().mockRejectedValue(storageError) });
      const generate =
        operation === 'renew'
          ? vi.fn(async () => await new Promise<never>(() => {}))
          : vi.fn().mockResolvedValue({
              inputTokens: 4,
              outputTokens: 2,
              outputText: 'evidence',
              providerRequestId: 'response-1',
            });

      await expect(
        runWorkerCycle(store, { generate }, { heartbeatIntervalMs: 1, sleep: async () => {} }),
      ).rejects.toBe(storageError);
      expect(store.fail).not.toHaveBeenCalled();
    },
  );

  it.each(['recordInvocation', 'complete', 'fail'] as const)(
    'continues the worker when %s discovers that the job lease was lost',
    async (operation) => {
      const store = createStore({
        [operation]: vi
          .fn()
          .mockRejectedValue(new WorkerLeaseLostError(new Error('lease expired'))),
      });
      const generate =
        operation === 'fail'
          ? vi.fn().mockRejectedValue(new Error('provider failed'))
          : vi.fn().mockResolvedValue({
              inputTokens: 4,
              outputTokens: 2,
              outputText: 'evidence',
              providerRequestId: 'response-1',
            });

      await expect(runWorkerCycle(store, { generate })).resolves.toBe(true);
      expect(store[operation]).toHaveBeenCalledOnce();
      if (operation !== 'fail') expect(store.fail).not.toHaveBeenCalled();
      if (operation === 'recordInvocation') expect(store.complete).not.toHaveBeenCalled();
    },
  );

  it('propagates an unknown error while recording a model failure', async () => {
    const storageError = new Error('database unavailable');
    const store = createStore({ fail: vi.fn().mockRejectedValue(storageError) });

    await expect(
      runWorkerCycle(store, { generate: vi.fn().mockRejectedValue(new Error('provider failed')) }),
    ).rejects.toBe(storageError);
  });

  it('records oversized aggregate context as an execution failure without stopping the worker', async () => {
    const store = createStore();
    const job = await store.claim();
    const node = job?.chains[0]?.[0];
    if (job === undefined || node === undefined) throw new Error('fixture job missing');
    vi.mocked(store.claim).mockResolvedValue({
      ...job,
      chains: [[node], [{ ...node, agentId: '00000000-0000-4000-8000-000000000005', branch: 2 }]],
    });
    // Each branch succeeds within its limits, but their combined UTF-8 context exceeds 49 KB.
    const outputText = '验'.repeat(9_000);
    expect(Buffer.byteLength(outputText.repeat(2), 'utf8')).toBeGreaterThan(49_000);

    await expect(
      runWorkerCycle(store, {
        generate: vi.fn().mockResolvedValue({
          inputTokens: 4,
          outputTokens: 2,
          outputText,
          providerRequestId: 'response-1',
        }),
      }),
    ).resolves.toBe(true);

    expect(store.recordInvocation).toHaveBeenCalledTimes(2);
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.fail).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        errorCode: 'async_subagent_execution_failed',
        leaseGeneration: 7,
      }),
    );
  });

  it.each(['microtask', 'later turn'] as const)(
    'does not hide a %s storage failure behind an earlier lease conflict',
    async (settlement) => {
      const store = createStore();
      const job = await store.claim();
      const node = job?.chains[0]?.[0];
      if (job === undefined || node === undefined) throw new Error('fixture job missing');
      vi.mocked(store.claim).mockResolvedValue({
        ...job,
        chains: [[node], [{ ...node, agentId: '00000000-0000-4000-8000-000000000005', branch: 2 }]],
      });
      const storageError = new Error('connection lost');
      const rejectWrites: ((error: unknown) => void)[] = [];
      vi.mocked(store.recordInvocation).mockImplementation(
        async () =>
          await new Promise<void>((_resolve, reject) => {
            rejectWrites.push(reject);
            if (rejectWrites.length === 2) {
              rejectWrites[0]?.(new WorkerLeaseLostError(new Error('lease expired')));
              const rejectConcurrentWrite = (): void => rejectWrites[1]?.(storageError);
              if (settlement === 'microtask') queueMicrotask(rejectConcurrentWrite);
              else setImmediate(rejectConcurrentWrite);
            }
          }),
      );

      await expect(
        runWorkerCycle(store, {
          generate: vi.fn().mockResolvedValue({
            inputTokens: 4,
            outputTokens: 2,
            outputText: 'evidence',
            providerRequestId: 'response-1',
          }),
        }),
      ).rejects.toBe(storageError);

      expect(store.recordInvocation).toHaveBeenCalledTimes(2);
      expect(store.complete).not.toHaveBeenCalled();
      expect(store.fail).not.toHaveBeenCalled();
    },
  );

  it.each(['stalled', 'settled'] as const)(
    'bounds %s storage drainage and clears its timer after losing a lease',
    async (settlement) => {
      vi.useFakeTimers();
      const rejectWrites: ((error: unknown) => void)[] = [];
      try {
        const store = createStore();
        const job = await store.claim();
        const node = job?.chains[0]?.[0];
        if (job === undefined || node === undefined) throw new Error('fixture job missing');
        vi.mocked(store.claim).mockResolvedValue({
          ...job,
          chains: [
            [node],
            [{ ...node, agentId: '00000000-0000-4000-8000-000000000005', branch: 2 }],
          ],
        });
        let writesStarted: (() => void) | undefined;
        const bothWritesStarted = new Promise<void>((resolve) => {
          writesStarted = resolve;
        });
        vi.mocked(store.recordInvocation).mockImplementation(
          async () =>
            await new Promise<void>((resolve, reject) => {
              rejectWrites.push(reject);
              if (rejectWrites.length === 2) {
                rejectWrites[0]?.(new WorkerLeaseLostError(new Error('lease expired')));
                if (settlement === 'settled') setTimeout(resolve, 1);
                writesStarted?.();
              }
            }),
        );
        let outcome: unknown = 'pending';
        const cycle = runWorkerCycle(
          store,
          {
            generate: vi.fn().mockResolvedValue({
              inputTokens: 4,
              outputTokens: 2,
              outputText: 'evidence',
              providerRequestId: 'response-1',
            }),
          },
          { storageDrainTimeoutMs: 20 },
        ).then(
          (value) => {
            outcome = value;
          },
          (error: unknown) => {
            outcome = error;
          },
        );
        await bothWritesStarted;
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(20);

        if (settlement === 'stalled')
          expect(outcome).toMatchObject({ message: 'worker_storage_drain_timeout' });
        else expect(outcome).toBe(true);
        expect(store.complete).not.toHaveBeenCalled();
        expect(store.fail).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        // The database call can reject after the worker has left; its rejection must stay observed.
        rejectWrites[1]?.(new Error('late database failure'));
        await vi.advanceTimersByTimeAsync(0);
        await cycle;
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        rejectWrites[1]?.(new Error('test cleanup'));
        vi.useRealTimers();
      }
    },
  );

  it('rejects invalid drain deadlines before claiming a job', async () => {
    const store = createStore();
    const generate = vi.fn();
    for (const storageDrainTimeoutMs of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      30_001,
    ]) {
      await expect(runWorkerCycle(store, { generate }, { storageDrainTimeoutMs })).rejects.toThrow(
        'worker_storage_drain_timeout_invalid',
      );
    }
    expect(store.claim).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});
