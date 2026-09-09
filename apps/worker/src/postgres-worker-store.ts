import type { SubagentNode } from '@better-agent/agent-runtime';

import type {
  ClaimedSubagentJob,
  WorkerCompletion,
  WorkerFailure,
  WorkerInvocationReceipt,
  WorkerJobStore,
} from './worker-runtime.js';

interface QueryResult<Row> {
  readonly rows: readonly Row[];
}

interface Queryable {
  query<Row>(sql: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function parseClaim(value: unknown): ClaimedSubagentJob {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('async_subagent_job_invalid');
  }
  const job = value as Record<string, unknown>;
  if (
    typeof job.childRunId !== 'string' ||
    !UUID.test(job.childRunId) ||
    typeof job.leaseToken !== 'string' ||
    !UUID.test(job.leaseToken) ||
    !Number.isSafeInteger(job.leaseGeneration) ||
    Number(job.leaseGeneration) < 1 ||
    !Number.isSafeInteger(job.parentIteration) ||
    Number(job.parentIteration) < 1 ||
    typeof job.prompt !== 'string' ||
    job.prompt.length < 1 ||
    job.prompt.length > 50_000 ||
    !Array.isArray(job.chains) ||
    job.chains.length < 1 ||
    job.chains.length > 3 ||
    job.chains.some((chain) => !Array.isArray(chain) || chain.length < 1 || chain.length > 3)
  ) {
    throw new Error('async_subagent_job_invalid');
  }
  return Object.freeze({
    chains: job.chains as readonly (readonly SubagentNode[])[],
    childRunId: job.childRunId,
    leaseGeneration: Number(job.leaseGeneration),
    leaseToken: job.leaseToken,
    parentIteration: Number(job.parentIteration),
    prompt: job.prompt,
  });
}

export class PostgresWorkerJobStore implements WorkerJobStore {
  readonly #leaseSeconds: number;
  readonly #pool: Queryable;
  readonly #workerId: string;

  constructor(pool: Queryable, workerId: string, leaseSeconds = 45) {
    if (workerId.length < 1 || workerId.length > 200) throw new Error('worker_id_invalid');
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 300) {
      throw new Error('worker_lease_seconds_invalid');
    }
    this.#pool = pool;
    this.#workerId = workerId;
    this.#leaseSeconds = leaseSeconds;
  }

  async claim(): Promise<ClaimedSubagentJob | undefined> {
    const result = await this.#pool.query<{ readonly job: unknown }>(
      'SELECT app.claim_agent_product_async_subagent_job($1::text, $2::integer) AS job',
      [this.#workerId, this.#leaseSeconds],
    );
    const value = result.rows[0]?.job;
    return value === null || value === undefined ? undefined : parseClaim(value);
  }

  async recordInvocation(receipt: WorkerInvocationReceipt): Promise<void> {
    await this.#pool.query(
      'SELECT app.record_agent_product_async_subagent_invocation($1::uuid, $2::uuid, $3::bigint, $4::jsonb)',
      [
        receipt.childRunId,
        receipt.leaseToken,
        receipt.leaseGeneration,
        JSON.stringify(receipt.invocation),
      ],
    );
  }

  async complete(completion: WorkerCompletion): Promise<void> {
    await this.#pool.query(
      'SELECT app.complete_agent_product_async_subagent_job($1::uuid, $2::uuid, $3::bigint, $4::bigint, $5::bigint, $6::text, $7::text)',
      [
        completion.childRunId,
        completion.leaseToken,
        completion.leaseGeneration,
        completion.aggregateInputTokens,
        completion.aggregateOutputTokens,
        completion.outputText,
        completion.providerRequestId,
      ],
    );
  }

  async fail(failure: WorkerFailure): Promise<void> {
    await this.#pool.query(
      'SELECT app.fail_agent_product_async_subagent_job($1::uuid, $2::uuid, $3::bigint, $4::text)',
      [failure.childRunId, failure.leaseToken, failure.leaseGeneration, failure.errorCode],
    );
  }
}
