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
): Promise<boolean> {
  const job = await store.claim();
  if (job === undefined) return false;
  const lease = leaseIdentity(job);

  try {
    const result = await executeParallelSubagents(
      job.chains,
      job.prompt,
      job.parentIteration,
      modelRuntime,
      async (invocation) => await store.recordInvocation({ ...lease, invocation }),
    );
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
