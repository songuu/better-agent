import {
  type AgentModelRuntime,
  executeParallelSubagents,
  type SubagentInvocationReceipt,
  type SubagentNode,
  withParallelSubagentContext,
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

interface WorkerCycleOptions {
  readonly heartbeatIntervalMs?: number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
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
  const job = await store.claim();
  if (job === undefined) return false;
  const lease = leaseIdentity(job);

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
      async (invocation) => await store.recordInvocation({ ...lease, invocation }),
    ).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ reason, status: 'rejected' as const }),
    );
    let result: Awaited<ReturnType<typeof executeParallelSubagents>>;
    while (true) {
      const waitController = new AbortController();
      const outcome = await Promise.race([
        execution,
        sleep(heartbeatIntervalMs, waitController.signal).then(() => undefined),
      ]);
      if (outcome === undefined) {
        await store.renew(lease);
        continue;
      }
      waitController.abort();
      if (outcome.status === 'rejected') throw outcome.reason;
      result = outcome.value;
      break;
    }
    const singleBranch = result.branches.length === 1 ? result.branches[0] : undefined;
    await store.complete({
      ...lease,
      aggregateInputTokens: result.aggregateInputTokens,
      aggregateOutputTokens: result.aggregateOutputTokens,
      outputText:
        singleBranch === undefined
          ? withParallelSubagentContext(result.branches)
          : singleBranch.outputText,
      providerRequestId: result.providerRequestId,
    });
  } catch {
    await store.fail({ ...lease, errorCode: 'async_subagent_execution_failed' });
  }
  return true;
}
