import type {
  CompiledFlowPlanV1,
  FlowModelUsageReceiptV1,
  FlowStepCheckpointV1,
} from '@better-agent/domain-contracts';
import { canonicalSha256ExcludingRootKeys } from '@better-agent/release-core';
import { describe, expect, it, vi } from 'vitest';
import type { G1SourceSqlQueryClient } from '../src/modules/releases/g1-source-postgres-readback.js';
import { createFlowExecutionPostgresAdapter } from '../src/modules/runs/index.js';

const id = (suffix: string) => `018f47f2-c541-7cc6-9292-4a2c3530${suffix}`;
const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const verifier = 'ab'.repeat(32);
const flowExecutionId = id('3102');
const runId = id('3101');

function pin<K extends 'FLOW_VERSION' | 'SYSTEM_RELEASE'>(kind: K, suffix: string) {
  return {
    workspace_id: id('3eee'),
    published_resource_kind: kind,
    resource_id: id(suffix),
    resource_version_id: id(`${Number(suffix) + 1}`.padStart(4, '0')),
    contract_hash: hash('a'),
    binding_mode: 'pinned' as const,
  };
}

const baseStep = {
  input_bindings: {},
  output_schema_hash: hash('b'),
  error_policy: { mode: 'fail' as const },
  timeout_ms: 1000,
};

const planDraft = {
  schema_version: 'compiled-flow-plan/1',
  flow_version: pin('FLOW_VERSION', '3201'),
  source_semantic_hash: hash('c'),
  capability_closure_hash: hash('d'),
  resolved_execution_plan_hash: hash('e'),
  input_schema_hash: hash('f'),
  output_schema_hash: hash('1'),
  checkpoint_contract_version: 'flow-step-checkpoint/1',
  steps: [
    {
      ...baseStep,
      node_id: 'start',
      node_key: 'start',
      node_type: 'start',
      canonical_node_path_hash: hash('2'),
      topology_rank: 0,
      predecessor_node_ids: [],
    },
    {
      ...baseStep,
      node_id: 'llm',
      node_key: 'llm',
      node_type: 'llm',
      canonical_node_path_hash: hash('3'),
      topology_rank: 1,
      predecessor_node_ids: ['start'],
      model: pin('SYSTEM_RELEASE', '3301'),
      credential_requirement_id: 'model-credential',
      credential_mapping_hash: hash('4'),
      credential_material_identity_hash: hash('5'),
      prompt: { role: 'user' },
      temperature: 0,
      budget: {
        schema_version: 'capability-budget/1',
        amount_credits: '100',
        input_tokens: 100,
        output_tokens: 100,
        total_tokens: 200,
        duration_ms: 1000,
      },
      retry: { max_attempts: 2, backoff: 'fixed' },
    },
    {
      ...baseStep,
      node_id: 'output',
      node_key: 'output',
      node_type: 'output',
      canonical_node_path_hash: hash('6'),
      topology_rank: 2,
      predecessor_node_ids: ['llm'],
    },
  ],
  compiled_hash: hash('7'),
};
const plan = {
  ...planDraft,
  compiled_hash: canonicalSha256ExcludingRootKeys(planDraft, ['compiled_hash']),
} as CompiledFlowPlanV1;

const receiptDraft = {
  schema_version: 'flow-model-usage-receipt/1',
  model_usage_receipt_id: id('3401'),
  run_id: runId,
  flow_execution_id: flowExecutionId,
  flow_plan_hash: plan.compiled_hash,
  node_id: 'llm',
  canonical_node_path_hash: hash('3'),
  model: pin('SYSTEM_RELEASE', '3301'),
  model_attempt_number: 1,
  operation_key: `flow-llm:v1:${'8'.repeat(64)}`,
  provider_request_hash: hash('9'),
  result_payload_hash: hash('a'),
  usage: {
    schema_version: 'capability-budget/1',
    amount_credits: '10',
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    duration_ms: 500,
  },
  receipt_hash: hash('b'),
};
const receipt = {
  ...receiptDraft,
  receipt_hash: canonicalSha256ExcludingRootKeys(receiptDraft, ['receipt_hash']),
} as FlowModelUsageReceiptV1;

const checkpointDraft = {
  schema_version: 'flow-step-checkpoint/1',
  run_id: runId,
  flow_execution_id: flowExecutionId,
  flow_plan_hash: plan.compiled_hash,
  checkpoint_sequence: '1',
  execution_fence: '1',
  node_id: 'start',
  node_type: 'start',
  canonical_node_path_hash: hash('2'),
  attempt: 1,
  predecessor_checkpoint_hashes: [],
  output_ref: 'snapshot://start',
  output_hash: hash('c'),
  checkpoint_hash: hash('d'),
};
const checkpoint = {
  ...checkpointDraft,
  checkpoint_hash: canonicalSha256ExcludingRootKeys(checkpointDraft, ['checkpoint_hash']),
} as FlowStepCheckpointV1;

const lease = {
  run_id: runId,
  attempt_id: id('3501'),
  lease_token: id('3502'),
  lease_fencing_token: '1',
};

describe('Flow execution PostgreSQL adapter', () => {
  it('uses only fixed parameterized reviewer and execution SQL', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('issue_flow_execution')) return { rows: [{ issued: null }] };
      if (sql.includes('register_flow_execution'))
        return {
          rows: [
            {
              result: {
                schema_version: 'flow-execution-registration-result/1',
                flow_execution_id: flowExecutionId,
                compiled_flow_plan_hash: plan.compiled_hash,
                replayed: false,
              },
            },
          ],
        };
      if (sql.includes('model_usage_receipt'))
        return {
          rows: [
            {
              result: {
                schema_version: 'flow-model-usage-record-result/1',
                receipt,
                usage_attribution_id: id('3601'),
                replayed: false,
              },
            },
          ],
        };
      return {
        rows: [
          {
            result: {
              schema_version: 'flow-step-checkpoint-record-result/1',
              run_checkpoint_id: id('3701'),
              checkpoint,
              replayed: false,
            },
          },
        ],
      };
    });
    const adapter = createFlowExecutionPostgresAdapter({
      query,
    } as unknown as G1SourceSqlQueryClient);
    await adapter.issuePlanAttestation({
      attestation_id: id('3801'),
      workspace_id: id('3eee'),
      run_id: runId,
      flow_execution_id: flowExecutionId,
      bound_session_user: 'ba_execution_login',
      compiled_flow_plan: plan,
      verifier_hex: verifier,
      expires_at: '2026-09-04T06:00:00.000Z',
    });
    await expect(
      adapter.registerExecution({
        ...lease,
        flow_execution_id: flowExecutionId,
        compiled_flow_plan: plan,
        plan_attestation_id: id('3801'),
        plan_attestation_verifier: verifier,
      }),
    ).resolves.toMatchObject({ replayed: false });
    await expect(
      adapter.recordModelUsage({
        ...lease,
        reservation_id: id('3901'),
        step_id: id('3902'),
        receipt,
      }),
    ).resolves.toMatchObject({ usage_attribution_id: id('3601') });
    await expect(
      adapter.recordCheckpoint({ ...lease, step_id: id('3902'), checkpoint }),
    ).resolves.toMatchObject({ run_checkpoint_id: id('3701') });
    expect(query).toHaveBeenCalledTimes(4);
    for (const [sql, values] of query.mock.calls as unknown as [string, readonly unknown[]][]) {
      expect(sql).toMatch(/^SELECT (?:auth|app)\./u);
      expect(sql).toContain('$1');
      expect(values).toBeInstanceOf(Array);
    }
  });

  it('rejects malformed or open input before database authority', async () => {
    const query = vi.fn();
    const adapter = createFlowExecutionPostgresAdapter({
      query,
    } as unknown as G1SourceSqlQueryClient);
    await expect(
      adapter.registerExecution({
        ...lease,
        flow_execution_id: 'bad',
        compiled_flow_plan: plan,
        plan_attestation_id: id('3801'),
        plan_attestation_verifier: verifier,
      }),
    ).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    await expect(
      adapter.recordCheckpoint({ ...lease, step_id: id('3902'), checkpoint, extra: true } as never),
    ).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a mismatched or open database projection', async () => {
    const adapter = createFlowExecutionPostgresAdapter({
      query: vi.fn(async () => ({
        rows: [
          {
            result: {
              schema_version: 'flow-execution-registration-result/1',
              flow_execution_id: id('9999'),
              compiled_flow_plan_hash: plan.compiled_hash,
              replayed: false,
              extra: true,
            },
          },
        ],
      })),
    } as unknown as G1SourceSqlQueryClient);
    await expect(
      adapter.registerExecution({
        ...lease,
        flow_execution_id: flowExecutionId,
        compiled_flow_plan: plan,
        plan_attestation_id: id('3801'),
        plan_attestation_verifier: verifier,
      }),
    ).rejects.toMatchObject({ code: 'PROJECTION_INVALID' });
  });

  it('normalizes database failures without leaking their message', async () => {
    const adapter = createFlowExecutionPostgresAdapter({
      query: vi.fn(async () => {
        throw new Error('database-secret');
      }),
    } as unknown as G1SourceSqlQueryClient);
    await expect(
      adapter.recordCheckpoint({ ...lease, step_id: id('3902'), checkpoint }),
    ).rejects.toMatchObject({
      code: 'QUERY_FAILED',
      message: 'Flow execution PostgreSQL query failed',
    });
  });

  it('snapshots the compiled plan before the first database await', async () => {
    let release: ((value: { rows: unknown[] }) => void) | undefined;
    const query = vi.fn(
      async () =>
        new Promise<{ rows: unknown[] }>((resolve) => {
          release = resolve;
        }),
    );
    const adapter = createFlowExecutionPostgresAdapter({
      query,
    } as unknown as G1SourceSqlQueryClient);
    const mutable = structuredClone(plan);
    const pending = adapter.registerExecution({
      ...lease,
      flow_execution_id: flowExecutionId,
      compiled_flow_plan: mutable,
      plan_attestation_id: id('3801'),
      plan_attestation_verifier: verifier,
    });
    mutable.steps[1].node_id = 'mutated';
    release?.({
      rows: [
        {
          result: {
            schema_version: 'flow-execution-registration-result/1',
            flow_execution_id: flowExecutionId,
            compiled_flow_plan_hash: plan.compiled_hash,
            replayed: false,
          },
        },
      ],
    });
    await expect(pending).resolves.toMatchObject({ compiled_flow_plan_hash: plan.compiled_hash });
    const firstCall = query.mock.calls[0] as unknown as [string, readonly string[]] | undefined;
    expect(firstCall?.[1]?.[0]).toContain('"node_id":"llm"');
  });
});
