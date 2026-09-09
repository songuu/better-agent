import {
  createAgentModelRuntimeFromEnvironment,
  type AgentModelRuntime,
} from '@better-agent/agent-runtime';

import type { WorkerJobStore } from './worker-runtime.js';
import { runWorkerCycle } from './worker-runtime.js';

type WorkerEnvironment = Readonly<Record<string, string | undefined>>;

export interface WorkerConfiguration {
  readonly idleDelayMs: number;
  readonly leaseSeconds: number;
  readonly modelRuntime: AgentModelRuntime;
  readonly workerId: string;
}

interface WorkerLoopOptions {
  readonly cycle: () => Promise<boolean>;
  readonly idleDelayMs: number;
  readonly signal: AbortSignal;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  errorCode: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(errorCode);
  }
  return parsed;
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

export function workerConfigurationFromEnvironment(
  environment: WorkerEnvironment = process.env,
): WorkerConfiguration {
  const modelRuntime = createAgentModelRuntimeFromEnvironment(environment);
  if (modelRuntime === undefined) throw new Error('worker_model_runtime_unconfigured');
  const workerId = environment.BETTER_AGENT_WORKER_ID ?? `worker-${process.pid}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(workerId)) {
    throw new Error('worker_id_invalid');
  }
  return Object.freeze({
    idleDelayMs: boundedInteger(
      environment.BETTER_AGENT_WORKER_POLL_MS,
      1_000,
      100,
      10_000,
      'worker_poll_ms_invalid',
    ),
    leaseSeconds: boundedInteger(
      environment.BETTER_AGENT_WORKER_LEASE_SECONDS,
      45,
      15,
      300,
      'worker_lease_seconds_invalid',
    ),
    modelRuntime,
    workerId,
  });
}

export async function runWorkerLoop(options: WorkerLoopOptions): Promise<void> {
  const sleep = options.sleep ?? abortableSleep;
  while (!options.signal.aborted) {
    const worked = await options.cycle();
    if (!worked && !options.signal.aborted) {
      await sleep(options.idleDelayMs, options.signal);
    }
  }
}

export function createWorkerCycle(
  store: WorkerJobStore,
  modelRuntime: AgentModelRuntime,
  leaseSeconds: number,
): () => Promise<boolean> {
  return async () =>
    await runWorkerCycle(store, modelRuntime, {
      heartbeatIntervalMs: Math.max(1_000, Math.floor((leaseSeconds * 1_000) / 3)),
    });
}
