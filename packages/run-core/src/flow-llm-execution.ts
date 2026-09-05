import {
  FlowModelUsageReceiptV1Schema,
  PositiveIntegerSchema,
  Sha256HexV1Schema,
  UuidV1Schema,
  type CompiledFlowPlanV1,
  type FlowModelUsageReceiptV1,
} from '@better-agent/domain-contracts';
import {
  boundedDataSnapshot,
  canonicalSha256,
  canonicalSha256ExcludingRootKeys,
  deepFreezeJson,
  verifyCompiledFlowPlan,
} from '@better-agent/release-core';

import { failRunCore } from './errors.js';

function samePin(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return [
    'workspace_id',
    'published_resource_kind',
    'resource_id',
    'resource_version_id',
    'contract_hash',
    'binding_mode',
  ].every((key) => left[key] === right[key]);
}

function invalid(path: string, reason: string): never {
  return failRunCore('RUN_FLOW_LLM_INVALID', path, reason);
}

export function canonicalFlowLlmOperationKey(input: {
  readonly run_id: string;
  readonly flow_execution_id: string;
  readonly flow_plan_hash: string;
  readonly canonical_node_path_hash: string;
  readonly model_attempt_number: number;
}) {
  const bounded = boundedDataSnapshot(input, 'closure') as typeof input;
  if (
    !UuidV1Schema.safeParse(bounded.run_id).success ||
    !UuidV1Schema.safeParse(bounded.flow_execution_id).success ||
    !Sha256HexV1Schema.safeParse(bounded.flow_plan_hash).success ||
    !Sha256HexV1Schema.safeParse(bounded.canonical_node_path_hash).success ||
    !PositiveIntegerSchema.safeParse(bounded.model_attempt_number).success
  )
    invalid('$.operation_key', 'model operation key facts are invalid');
  const digest = canonicalSha256({
    schema_version: 'flow-llm-operation-key/1',
    ...bounded,
  }).slice('sha256:'.length);
  return `flow-llm:v1:${digest}`;
}

function verifyReceiptAgainstPlan(
  input: unknown,
  expectedReceiptHash: string,
  plan: CompiledFlowPlanV1,
  expectedFlowPlanHash: string,
) {
  const trustedPlan = verifyCompiledFlowPlan(plan, expectedFlowPlanHash);
  const parsed = FlowModelUsageReceiptV1Schema.safeParse(boundedDataSnapshot(input, 'closure'));
  if (!parsed.success) invalid('$.receipt', 'model usage receipt failed its closed contract');
  const receipt = parsed.data;
  const actualHash = canonicalSha256ExcludingRootKeys(receipt, ['receipt_hash']);
  if (receipt.receipt_hash !== actualHash || actualHash !== expectedReceiptHash)
    invalid('$.receipt.receipt_hash', 'model usage receipt differs from its trusted hash');
  const step = trustedPlan.steps.find((candidate) => candidate.node_id === receipt.node_id);
  if (
    step?.node_type !== 'llm' ||
    receipt.flow_plan_hash !== trustedPlan.compiled_hash ||
    receipt.canonical_node_path_hash !== step.canonical_node_path_hash ||
    !samePin(receipt.model, step.model) ||
    receipt.model_attempt_number > (step.retry?.max_attempts ?? 1) ||
    receipt.operation_key !==
      canonicalFlowLlmOperationKey({
        run_id: receipt.run_id,
        flow_execution_id: receipt.flow_execution_id,
        flow_plan_hash: receipt.flow_plan_hash,
        canonical_node_path_hash: receipt.canonical_node_path_hash,
        model_attempt_number: receipt.model_attempt_number,
      })
  )
    invalid('$.receipt', 'model usage receipt does not bind the exact FlowPlan LLM attempt');
  if (
    BigInt(receipt.usage.amount_credits) > BigInt(step.budget.amount_credits) ||
    receipt.usage.input_tokens > step.budget.input_tokens ||
    receipt.usage.output_tokens > step.budget.output_tokens ||
    receipt.usage.total_tokens > step.budget.total_tokens ||
    receipt.usage.duration_ms > step.budget.duration_ms
  )
    invalid('$.receipt.usage', 'model usage exceeds the compiled LLM budget');
  return deepFreezeJson(receipt);
}

export function prepareFlowModelUsageReceipt(
  input: Omit<FlowModelUsageReceiptV1, 'receipt_hash'>,
  plan: CompiledFlowPlanV1,
  expectedFlowPlanHash: string,
) {
  const candidate = boundedDataSnapshot(input, 'closure') as Omit<
    FlowModelUsageReceiptV1,
    'receipt_hash'
  >;
  const receipt = {
    ...candidate,
    receipt_hash: canonicalSha256(candidate),
  };
  return verifyReceiptAgainstPlan(receipt, receipt.receipt_hash, plan, expectedFlowPlanHash);
}

export function verifyFlowModelUsageReceipt(
  input: unknown,
  expectedReceiptHash: string,
  plan: CompiledFlowPlanV1,
  expectedFlowPlanHash: string,
) {
  return verifyReceiptAgainstPlan(input, expectedReceiptHash, plan, expectedFlowPlanHash);
}

export type FlowLlmRecoveryActionV1 =
  | 'INVOKE_WITH_KEY'
  | 'RETRY_WITH_SAME_KEY'
  | 'COMMIT_CHECKPOINT_FROM_RECEIPT'
  | 'ADVANCE_FROM_CHECKPOINT';

export function decideFlowLlmRecovery(input: {
  readonly plan: CompiledFlowPlanV1;
  readonly expected_flow_plan_hash: string;
  readonly run_id: string;
  readonly flow_execution_id: string;
  readonly node_id: string;
  readonly model_attempt_number: number;
  readonly effect_envelope_state: 'ABSENT' | 'COMMITTED';
  readonly receipt?: unknown;
  readonly expected_receipt_hash?: string;
  readonly committed_checkpoint?: {
    readonly flow_plan_hash: string;
    readonly node_id: string;
    readonly model_usage_receipt_hash: string;
    readonly checkpoint_hash: string;
  };
}) {
  const safe = boundedDataSnapshot(input, 'closure') as typeof input;
  const plan = verifyCompiledFlowPlan(safe.plan, safe.expected_flow_plan_hash);
  const step = plan.steps.find((candidate) => candidate.node_id === safe.node_id);
  if (step?.node_type !== 'llm') invalid('$.node_id', 'recovery target is not an LLM step');
  if (safe.model_attempt_number < 1 || safe.model_attempt_number > (step.retry?.max_attempts ?? 1))
    invalid('$.model_attempt_number', 'model attempt exceeds the compiled retry policy');
  const operationKey = canonicalFlowLlmOperationKey({
    run_id: safe.run_id,
    flow_execution_id: safe.flow_execution_id,
    flow_plan_hash: plan.compiled_hash,
    canonical_node_path_hash: step.canonical_node_path_hash,
    model_attempt_number: safe.model_attempt_number,
  });
  if ((safe.receipt === undefined) !== (safe.expected_receipt_hash === undefined))
    invalid('$.receipt', 'receipt and trusted receipt hash must be present together');
  const receipt =
    safe.receipt === undefined || safe.expected_receipt_hash === undefined
      ? undefined
      : verifyReceiptAgainstPlan(
          safe.receipt,
          safe.expected_receipt_hash,
          plan,
          plan.compiled_hash,
        );
  if (
    receipt !== undefined &&
    (receipt.run_id !== safe.run_id ||
      receipt.flow_execution_id !== safe.flow_execution_id ||
      receipt.node_id !== safe.node_id ||
      receipt.model_attempt_number !== safe.model_attempt_number ||
      receipt.operation_key !== operationKey)
  )
    invalid('$.receipt', 'receipt belongs to a different logical LLM invocation');
  if (receipt !== undefined && safe.effect_envelope_state !== 'COMMITTED')
    invalid('$.effect_envelope_state', 'a durable receipt requires its committed effect envelope');
  if (safe.committed_checkpoint !== undefined) {
    if (
      receipt === undefined ||
      safe.committed_checkpoint.flow_plan_hash !== plan.compiled_hash ||
      safe.committed_checkpoint.node_id !== step.node_id ||
      safe.committed_checkpoint.model_usage_receipt_hash !== receipt.receipt_hash
    )
      invalid(
        '$.committed_checkpoint',
        'checkpoint must bind the exact confirmed model usage receipt',
      );
    return deepFreezeJson({
      action: 'ADVANCE_FROM_CHECKPOINT' as const,
      operation_key: operationKey,
      receipt_hash: receipt.receipt_hash,
      checkpoint_hash: safe.committed_checkpoint.checkpoint_hash,
    });
  }
  if (receipt !== undefined)
    return deepFreezeJson({
      action: 'COMMIT_CHECKPOINT_FROM_RECEIPT' as const,
      operation_key: operationKey,
      receipt_hash: receipt.receipt_hash,
    });
  return deepFreezeJson({
    action:
      safe.effect_envelope_state === 'COMMITTED'
        ? ('RETRY_WITH_SAME_KEY' as const)
        : ('INVOKE_WITH_KEY' as const),
    operation_key: operationKey,
  });
}
