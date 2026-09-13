import {
  type AgentModelRuntime,
  executeParallelSubagents,
  type SubagentInvocationReceipt,
  type SubagentNode,
  withParallelSubagentContext,
  withSubagentContext,
} from '@better-agent/agent-runtime';

export interface WorkerLeaseIdentity {
  readonly childRunId: string;
  readonly leaseGeneration: number;
  readonly leaseToken: string;
}

export interface ClaimedSubagentJob extends WorkerLeaseIdentity {
  readonly chains: readonly (readonly SubagentNode[])[];
  readonly parentIteration: number;
  readonly prompt: string;
}

export interface WorkerInvocationReceipt extends WorkerLeaseIdentity {
  readonly invocation: SubagentInvocationReceipt;
}

export interface WorkerCompletion extends WorkerLeaseIdentity {
  readonly aggregateInputTokens: number;
  readonly aggregateOutputTokens: number;
  readonly outputText: string;
  readonly providerRequestId: string;
}

export interface WorkerFailure extends WorkerLeaseIdentity {
  readonly errorCode: 'async_subagent_execution_failed';
}

export interface WorkerJobStore {
  claim(): Promise<ClaimedSubagentJob | undefined>;
  complete(completion: WorkerCompletion): Promise<void>;
  fail(failure: WorkerFailure): Promise<void>;
  recordInvocation(receipt: WorkerInvocationReceipt): Promise<void>;
  renew(lease: WorkerLeaseIdentity): Promise<void>;
}

export class WorkerLeaseLostError extends Error {
  constructor(cause: unknown) {
    super('worker_lease_lost', { cause });
    this.name = 'WorkerLeaseLostError';
  }
}

interface WorkerCycleOptions {
  readonly heartbeatIntervalMs?: number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly storageDrainTimeoutMs?: number;
}

async function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function leaseIdentity(job: ClaimedSubagentJob): WorkerLeaseIdentity {
  return Object.freeze({
    childRunId: job.childRunId,
    leaseGeneration: job.leaseGeneration,
    leaseToken: job.leaseToken,
  });
}

export async function runWorkerCycle(
  store: WorkerJobStore,
  modelRuntime: AgentModelRuntime,
  options: WorkerCycleOptions = {},
): Promise<boolean> {
  const storageDrainTimeoutMs = options.storageDrainTimeoutMs ?? 5_000;
  if (
    !Number.isSafeInteger(storageDrainTimeoutMs) ||
    storageDrainTimeoutMs < 1 ||
    storageDrainTimeoutMs > 30_000
  ) {
    throw new Error('worker_storage_drain_timeout_invalid');
  }
  const job = await store.claim();
  if (job === undefined) return false;
  const lease = leaseIdentity(job);
  const executionController = new AbortController();
  const pendingMutations = new Set<Promise<void>>();
  const storageFailures: unknown[] = [];
  const mutateStore = async (operation: () => Promise<void>): Promise<void> => {
    executionController.signal.throwIfAborted();
    const mutation = (async () => {
      try {
        await operation();
      } catch (error) {
        storageFailures.push(error);
        // Losing storage authority must stop sibling and nested model calls immediately.
        executionController.abort(error);
        throw error;
      }
    })();
    pendingMutations.add(mutation);
    try {
      await mutation;
    } finally {
      pendingMutations.delete(mutation);
    }
  };

  try {
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1) {
      throw new Error('worker_heartbeat_interval_invalid');
    }
    const sleep = options.sleep ?? abortableSleep;
    const execution = executeParallelSubagents(
      job.chains,
      job.prompt,
      job.parentIteration,
      modelRuntime,
      async (invocation) =>
        await mutateStore(() => store.recordInvocation({ ...lease, invocation })),
      executionController.signal,
    ).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ reason, status: 'rejected' as const }),
    );
    let result: Awaited<ReturnType<typeof executeParallelSubagents>>;
    while (true) {
      const waitController = new AbortController();
      const outcome = await (async () => {
        try {
          return await Promise.race([
            execution,
            sleep(heartbeatIntervalMs, waitController.signal).then(() => undefined),
          ]);
        } finally {
          waitController.abort();
        }
      })();
      if (outcome === undefined) {
        await mutateStore(() => store.renew(lease));
        continue;
      }
      if (outcome.status === 'rejected') throw outcome.reason;
      result = outcome.value;
      break;
    }
    const singleBranch = result.branches.length === 1 ? result.branches[0] : undefined;
    const completion: WorkerCompletion = {
      ...lease,
      aggregateInputTokens: result.aggregateInputTokens,
      aggregateOutputTokens: result.aggregateOutputTokens,
      outputText:
        singleBranch === undefined
          ? withParallelSubagentContext(result.branches)
          : withSubagentContext(singleBranch.name, singleBranch.outputText),
      providerRequestId: result.providerRequestId,
    };
    await mutateStore(() => store.complete(completion));
  } catch (error) {
    executionController.abort(error);
    // Observe already-started writes; a lease conflict cannot hide another branch's outage.
    // Model promises may ignore cancellation, so only storage mutations join this boundary.
    if (pendingMutations.size > 0) {
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...pendingMutations]),
          new Promise<never>((_resolve, reject) => {
            drainTimer = setTimeout(
              () => reject(new Error('worker_storage_drain_timeout', { cause: error })),
              storageDrainTimeoutMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(drainTimer);
      }
    }
    if (storageFailures.length > 0) {
      const unexpected = storageFailures.findIndex(
        (failure) => !(failure instanceof WorkerLeaseLostError),
      );
      if (unexpected !== -1) throw storageFailures[unexpected];
      return true;
    }
    try {
      await store.fail({ ...lease, errorCode: 'async_subagent_execution_failed' });
    } catch (failure) {
      if (!(failure instanceof WorkerLeaseLostError)) throw failure;
    }
  }
  return true;
}
