import { describe, expect, it, vi } from 'vitest';

import { PostgresWorkerJobStore } from '../src/postgres-worker-store.js';

const lease = Object.freeze({
  childRunId: '00000000-0000-4000-8000-000000000003',
  leaseGeneration: 7,
  leaseToken: '00000000-0000-4000-8000-000000000004',
});

describe('PostgresWorkerJobStore', () => {
  it('claims through the execution-owner function and validates the returned envelope', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          job: {
            ...lease,
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
                  strategyProfile: {
                    forcedCapability: 'none',
                    maxInputTokens: 1000,
                    maxIterations: 1,
                    maxOutputTokens: 1000,
                    maxToolCalls: 0,
                    schemaVersion: 'product-agent-strategy/5',
                    temperature: 0,
                  },
                  temperature: 0,
                },
              ],
            ],
            parentIteration: 2,
            prompt: 'investigate',
          },
        },
      ],
    });
    const store = new PostgresWorkerJobStore({ query }, 'worker-a', 45);

    await expect(store.claim()).resolves.toMatchObject(lease);
    expect(query).toHaveBeenCalledWith(
      'SELECT app.claim_agent_product_async_subagent_job($1::text, $2::integer) AS job',
      ['worker-a', 45],
    );
  });

  it('writes receipts and terminal state only through lease-fenced functions', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{}] });
    const store = new PostgresWorkerJobStore({ query }, 'worker-a', 45);
    const invocation = {
      agentId: '00000000-0000-4000-8000-000000000002',
      aggregateInputTokens: 4,
      aggregateOutputTokens: 2,
      branch: 1 as const,
      depth: 1 as const,
      exclusiveInputTokens: 4,
      exclusiveOutputTokens: 2,
      inputText: 'investigate',
      model: 'gpt-5.4-mini' as const,
      name: 'Researcher',
      outputText: 'evidence',
      parentIteration: 2,
      providerRequestId: 'response-1',
      releaseVersion: 1,
    };

    await store.recordInvocation({ ...lease, invocation });
    await store.complete({
      ...lease,
      aggregateInputTokens: 4,
      aggregateOutputTokens: 2,
      outputText: 'evidence',
      providerRequestId: 'response-1',
    });
    await store.fail({ ...lease, errorCode: 'async_subagent_execution_failed' });

    expect(query.mock.calls.map((call) => call[0])).toEqual([
      'SELECT app.record_agent_product_async_subagent_invocation($1::uuid, $2::uuid, $3::bigint, $4::jsonb)',
      'SELECT app.complete_agent_product_async_subagent_job($1::uuid, $2::uuid, $3::bigint, $4::bigint, $5::bigint, $6::text, $7::text)',
      'SELECT app.fail_agent_product_async_subagent_job($1::uuid, $2::uuid, $3::bigint, $4::text)',
    ]);
    expect(query.mock.calls[0]?.[1]?.[3]).toBe(JSON.stringify(invocation));
  });

  it('fails closed on a malformed claim instead of executing an untrusted job', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ job: { chains: [] } }] });
    const store = new PostgresWorkerJobStore({ query }, 'worker-a', 45);

    await expect(store.claim()).rejects.toThrow('async_subagent_job_invalid');
  });
});
