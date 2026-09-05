import { describe, expect, it } from 'vitest';
import {
  canonicalSha256,
  canonicalSha256ExcludingRootKeys,
  verifyCompiledFlowPlan,
} from '@better-agent/release-core';

import {
  canonicalFlowLlmOperationKey,
  decideFlowLlmRecovery,
  prepareFlowModelUsageReceipt,
  verifyFlowModelUsageReceipt,
} from '../src/flow-llm-execution.js';
import { hashA, hashB, workspaceId } from './fixtures.js';

const runId = '018f47f2-c541-7cc6-9292-4a2c35303101';
const flowExecutionId = '018f47f2-c541-7cc6-9292-4a2c35303102';
const receiptId = '018f47f2-c541-7cc6-9292-4a2c35303103';
const model = {
  workspace_id: workspaceId,
  published_resource_kind: 'SYSTEM_RELEASE',
  resource_id: '018f47f2-c541-7cc6-9292-4a2c35303104',
  resource_version_id: '018f47f2-c541-7cc6-9292-4a2c35303105',
  contract_hash: hashA,
  binding_mode: 'pinned',
} as const;

function flowPlan() {
  const flowVersion = {
    workspace_id: workspaceId,
    published_resource_kind: 'FLOW_VERSION',
    resource_id: '018f47f2-c541-7cc6-9292-4a2c35303106',
    resource_version_id: '018f47f2-c541-7cc6-9292-4a2c35303107',
    contract_hash: hashA,
    binding_mode: 'pinned',
  } as const;
  const draft = {
    schema_version: 'compiled-flow-plan/1' as const,
    flow_version: flowVersion,
    source_semantic_hash: hashA,
    capability_closure_hash: hashA,
    resolved_execution_plan_hash: hashA,
    input_schema_hash: hashA,
    output_schema_hash: hashB,
    checkpoint_contract_version: 'flow-step-checkpoint/1' as const,
    steps: [
      {
        node_id: 'start-1',
        node_key: 'start',
        node_type: 'start' as const,
        canonical_node_path_hash: canonicalSha256({ node: 'start-1' }),
        topology_rank: 0 as const,
        predecessor_node_ids: [] as const,
        input_bindings: {},
        output_schema_hash: hashA,
        timeout_ms: 300_000,
      },
      {
        node_id: 'llm-1',
        node_key: 'llm_1',
        node_type: 'llm' as const,
        canonical_node_path_hash: canonicalSha256({ node: 'llm-1' }),
        topology_rank: 1 as const,
        predecessor_node_ids: ['start-1'] as const,
        input_bindings: {},
        output_schema_hash: hashA,
        timeout_ms: 45_000,
        retry: { max_attempts: 2, backoff: 'fixed' as const },
        model,
        credential_requirement_id: 'model-provider',
        credential_mapping_hash: hashA,
        credential_material_identity_hash: hashB,
        prompt: '{{start.content}}',
        temperature: 0.2,
        budget: {
          schema_version: 'capability-budget/1' as const,
          amount_credits: '1000',
          input_tokens: 4096,
          output_tokens: 512,
          total_tokens: 4608,
          duration_ms: 45_000,
        },
      },
      {
        node_id: 'output-1',
        node_key: 'output',
        node_type: 'output' as const,
        canonical_node_path_hash: canonicalSha256({ node: 'output-1' }),
        topology_rank: 2 as const,
        predecessor_node_ids: ['llm-1'] as const,
        input_bindings: {},
        output_schema_hash: hashB,
        timeout_ms: 300_000,
      },
    ] as const,
  };
  const plan = {
    ...draft,
    compiled_hash: canonicalSha256ExcludingRootKeys(draft, ['compiled_hash']),
  };
  return verifyCompiledFlowPlan(plan, plan.compiled_hash);
}

function usageReceipt() {
  const plan = flowPlan();
  const llm = plan.steps[1];
  const operationKey = canonicalFlowLlmOperationKey({
    run_id: runId,
    flow_execution_id: flowExecutionId,
    flow_plan_hash: plan.compiled_hash,
    canonical_node_path_hash: llm.canonical_node_path_hash,
    model_attempt_number: 1,
  });
  const receipt = prepareFlowModelUsageReceipt(
    {
      schema_version: 'flow-model-usage-receipt/1',
      model_usage_receipt_id: receiptId,
      run_id: runId,
      flow_execution_id: flowExecutionId,
      flow_plan_hash: plan.compiled_hash,
      node_id: llm.node_id,
      canonical_node_path_hash: llm.canonical_node_path_hash,
      model,
      model_attempt_number: 1,
      operation_key: operationKey,
      provider_request_hash: hashA,
      result_payload_hash: hashB,
      usage: {
        schema_version: 'capability-budget/1',
        amount_credits: '40',
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        duration_ms: 800,
      },
    },
    plan,
    plan.compiled_hash,
  );
  return { plan, llm, operationKey, receipt };
}

describe('Flow LLM durable execution', () => {
  it('derives one stable operation key per logical model attempt', () => {
    const value = usageReceipt();
    expect(value.receipt.operation_key).toBe(value.operationKey);
    expect(value.operationKey).toMatch(/^flow-llm:v1:[0-9a-f]{64}$/u);
    expect(
      canonicalFlowLlmOperationKey({
        run_id: runId,
        flow_execution_id: flowExecutionId,
        flow_plan_hash: value.plan.compiled_hash,
        canonical_node_path_hash: value.llm.canonical_node_path_hash,
        model_attempt_number: 2,
      }),
    ).not.toBe(value.operationKey);
  });

  it('seals exact usage and rejects stale hashes or budget overrun', () => {
    const { plan, receipt } = usageReceipt();
    expect(
      verifyFlowModelUsageReceipt(receipt, receipt.receipt_hash, plan, plan.compiled_hash),
    ).toEqual(receipt);
    const stale = { ...receipt, result_payload_hash: hashA };
    expect(() =>
      verifyFlowModelUsageReceipt(stale, receipt.receipt_hash, plan, plan.compiled_hash),
    ).toThrow('trusted hash');
    const { receipt_hash: _receiptHash, ...receiptCandidate } = receipt;
    expect(() =>
      prepareFlowModelUsageReceipt(
        {
          ...receiptCandidate,
          usage: { ...receipt.usage, output_tokens: 600, total_tokens: 700 },
        },
        plan,
        plan.compiled_hash,
      ),
    ).toThrow('exceeds');
  });

  it('recovers every crash boundary without issuing a second logical operation key', () => {
    const { plan, llm, operationKey, receipt } = usageReceipt();
    const base = {
      plan,
      expected_flow_plan_hash: plan.compiled_hash,
      run_id: runId,
      flow_execution_id: flowExecutionId,
      node_id: llm.node_id,
      model_attempt_number: 1,
    } as const;
    expect(decideFlowLlmRecovery({ ...base, effect_envelope_state: 'ABSENT' })).toEqual({
      action: 'INVOKE_WITH_KEY',
      operation_key: operationKey,
    });
    expect(decideFlowLlmRecovery({ ...base, effect_envelope_state: 'COMMITTED' })).toEqual({
      action: 'RETRY_WITH_SAME_KEY',
      operation_key: operationKey,
    });
    expect(() =>
      decideFlowLlmRecovery({
        ...base,
        effect_envelope_state: 'ABSENT',
        receipt,
        expected_receipt_hash: receipt.receipt_hash,
      }),
    ).toThrow('committed effect envelope');
    expect(
      decideFlowLlmRecovery({
        ...base,
        effect_envelope_state: 'COMMITTED',
        receipt,
        expected_receipt_hash: receipt.receipt_hash,
      }),
    ).toEqual({
      action: 'COMMIT_CHECKPOINT_FROM_RECEIPT',
      operation_key: operationKey,
      receipt_hash: receipt.receipt_hash,
    });
    expect(
      decideFlowLlmRecovery({
        ...base,
        effect_envelope_state: 'COMMITTED',
        receipt,
        expected_receipt_hash: receipt.receipt_hash,
        committed_checkpoint: {
          flow_plan_hash: plan.compiled_hash,
          node_id: llm.node_id,
          model_usage_receipt_hash: receipt.receipt_hash,
          checkpoint_hash: hashA,
        },
      }),
    ).toEqual({
      action: 'ADVANCE_FROM_CHECKPOINT',
      operation_key: operationKey,
      receipt_hash: receipt.receipt_hash,
      checkpoint_hash: hashA,
    });
  });
});
