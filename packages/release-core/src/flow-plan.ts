import {
  CompiledFlowPlanV1Schema,
  FlowLlmNodeConfigV1Schema,
  FlowModelUsageReceiptV1Schema,
  FlowStepCheckpointV1Schema,
  type CompiledFlowPlanV1,
  type FlowIrV1,
  type FlowModelUsageReceiptV1,
  type FlowStepCheckpointV1,
} from '@better-agent/domain-contracts';

import { credentialMaterialIdentityHash } from './admission-credential.js';
import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import { canonicalJsonBytes } from './canonical-json.js';
import { deepFreezeJson } from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { prepareExecutableSource } from './executable-source.js';
import { prepareFlowCapabilityClosure } from './flow-capability-closure.js';
import { canonicalSha256, canonicalSha256ExcludingRootKeys } from './hash.js';
import { verifyResolvedExecutionPlan } from './resolved-plan.js';
import { prepareCompiledCapabilityClosure } from './compiled-capability-closure.js';

function fail(path: string, reason: string): never {
  throw new ReleaseCoreError('RELEASE_RESOLVED_PLAN_INVALID', path, reason);
}

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

function optionalNodePolicy(node: FlowIrV1['entry_graph']['nodes'][number]) {
  return {
    ...(node.retry === undefined ? {} : { retry: node.retry }),
    ...(node.error_policy === undefined ? {} : { error_policy: node.error_policy }),
    timeout_ms: node.timeout_ms ?? 300_000,
  };
}

function nodePathHash(flowVersion: Record<string, unknown>, nodeId: string) {
  return canonicalSha256({
    schema_version: 'flow-node-path/1',
    flow_version: flowVersion,
    graph_id: 'root',
    node_id: nodeId,
  });
}

export interface PrepareCompiledFlowPlanInput {
  readonly executable_source: unknown;
  readonly pinned_graph: unknown;
  readonly closure: unknown;
  readonly resolved_execution_plan: unknown;
  readonly expected_resolved_execution_plan_hash: string;
}

/** Compile the closed G1-A2 Start to LLM to Output subset from independently verified facts. */
export function prepareCompiledFlowPlan(input: PrepareCompiledFlowPlanInput) {
  const safeInput = boundedDataSnapshot(input, 'closure') as PrepareCompiledFlowPlanInput;
  const source = prepareExecutableSource(safeInput.executable_source);
  if (source.root.pin.published_resource_kind !== 'FLOW_VERSION')
    fail('$.executable_source', 'compiled FlowPlan requires a Flow source');
  const expectedClosure = prepareFlowCapabilityClosure(
    safeInput.executable_source,
    safeInput.pinned_graph,
  );
  const suppliedClosure = prepareCompiledCapabilityClosure(safeInput.closure);
  if (!canonicalJsonBytes(expectedClosure).equals(canonicalJsonBytes(suppliedClosure)))
    fail('$.closure', 'FlowPlan closure differs from the independently compiled closure');
  const resolved = verifyResolvedExecutionPlan(
    safeInput.resolved_execution_plan,
    safeInput.expected_resolved_execution_plan_hash,
  );
  if (
    resolved.plan_kind !== 'flow' ||
    !samePin(resolved.root_release, source.root.pin) ||
    resolved.capability_closure_hash !== expectedClosure.closure_hash
  )
    fail('$.resolved_execution_plan', 'FlowPlan admission does not bind this source and closure');

  const document = source.preimage.document as unknown as FlowIrV1;
  const start = document.entry_graph.nodes.find((node) => node.type === 'start');
  const llm = document.entry_graph.nodes.find((node) => node.type === 'llm');
  const output = document.entry_graph.nodes.find((node) => node.type === 'output');
  if (start === undefined || llm === undefined || llm.type !== 'llm' || output === undefined)
    fail('$.executable_source.document.entry_graph', 'FlowPlan requires Start, LLM and Output');
  const llmConfigResult = FlowLlmNodeConfigV1Schema.safeParse(llm.config);
  if (!llmConfigResult.success)
    fail('$.executable_source.document.entry_graph', 'LLM config is not a closed v1 contract');
  const llmConfig = llmConfigResult.data;
  const rootAuthority = resolved.root_authority;
  const credential = rootAuthority?.credential_bindings.find(
    (binding) => binding.requirement_id === llmConfig.credential_requirement_id,
  );
  const requirement = rootAuthority?.effective_policy.credential_requirements.find(
    (candidate) => candidate.requirement_id === llmConfig.credential_requirement_id,
  );
  if (
    rootAuthority === undefined ||
    rootAuthority.credential_bindings.length !== 1 ||
    rootAuthority.effective_policy.credential_requirements.length !== 1 ||
    credential === undefined ||
    requirement === undefined
  )
    fail(
      '$.resolved_execution_plan.root_authority',
      'LLM step requires one exact admitted root credential',
    );
  const policyBudget = rootAuthority.effective_policy.budget;
  if (
    BigInt(policyBudget.amount_credits) < BigInt(llmConfig.max_amount_credits) ||
    policyBudget.input_tokens < llmConfig.max_input_tokens ||
    policyBudget.output_tokens < llmConfig.max_output_tokens ||
    policyBudget.total_tokens < llmConfig.max_input_tokens + llmConfig.max_output_tokens ||
    policyBudget.duration_ms < (llm.timeout_ms ?? 300_000) ||
    rootAuthority.effective_policy.max_calls < 1 ||
    rootAuthority.effective_policy.max_parallelism < 1
  )
    fail('$.resolved_execution_plan.root_authority', 'admitted root budget is below LLM demand');

  const stepBase = (node: typeof start, topologyRank: number, predecessors: string[]) => ({
    node_id: node.node_id,
    node_key: node.key,
    canonical_node_path_hash: nodePathHash(source.root.pin, node.node_id),
    topology_rank: topologyRank,
    predecessor_node_ids: predecessors,
    input_bindings: node.inputs,
    output_schema_hash: canonicalSha256(node.output_schema),
    ...optionalNodePolicy(node),
  });
  const candidate = {
    schema_version: 'compiled-flow-plan/1' as const,
    flow_version: source.root.pin,
    source_semantic_hash: source.root.semantic_seed_hash,
    capability_closure_hash: expectedClosure.closure_hash,
    resolved_execution_plan_hash: resolved.plan_hash,
    input_schema_hash: canonicalSha256(document.input_schema),
    output_schema_hash: canonicalSha256(document.output_schema),
    checkpoint_contract_version: 'flow-step-checkpoint/1' as const,
    steps: [
      { ...stepBase(start, 0, []), node_type: 'start' as const },
      {
        ...stepBase(llm, 1, [start.node_id]),
        node_type: 'llm' as const,
        model: llmConfig.model,
        credential_requirement_id: llmConfig.credential_requirement_id,
        credential_mapping_hash: credential.mapping_hash,
        credential_material_identity_hash: credentialMaterialIdentityHash(credential),
        prompt: llmConfig.prompt,
        temperature: llmConfig.temperature,
        budget: {
          schema_version: 'capability-budget/1' as const,
          amount_credits: llmConfig.max_amount_credits,
          input_tokens: llmConfig.max_input_tokens,
          output_tokens: llmConfig.max_output_tokens,
          total_tokens: llmConfig.max_input_tokens + llmConfig.max_output_tokens,
          duration_ms: llm.timeout_ms ?? 300_000,
        },
      },
      { ...stepBase(output, 2, [llm.node_id]), node_type: 'output' as const },
    ],
  };
  return verifyCompiledFlowPlan(
    { ...candidate, compiled_hash: canonicalSha256ExcludingRootKeys(candidate, ['compiled_hash']) },
    canonicalSha256ExcludingRootKeys(candidate, ['compiled_hash']),
  );
}

export function verifyCompiledFlowPlan(input: unknown, expectedCompiledHash: unknown) {
  const parsed = CompiledFlowPlanV1Schema.safeParse(boundedDataSnapshot(input, 'closure'));
  if (!parsed.success) fail('$.flow_plan', 'compiled FlowPlan failed its closed contract');
  const actual = canonicalSha256ExcludingRootKeys(parsed.data, ['compiled_hash']);
  if (parsed.data.compiled_hash !== actual || actual !== expectedCompiledHash)
    throw new ReleaseCoreError(
      'RELEASE_HASH_MISMATCH',
      '$.flow_plan.compiled_hash',
      'compiled FlowPlan differs from its trusted hash',
    );
  return deepFreezeJson(parsed.data);
}

export function prepareFlowStepCheckpoint(
  input: Omit<FlowStepCheckpointV1, 'checkpoint_hash'>,
  plan: CompiledFlowPlanV1,
  expectedFlowPlanHash: string,
  predecessorCheckpoints: readonly FlowStepCheckpointV1[] = [],
  previousCommittedCheckpoint?: FlowStepCheckpointV1,
  modelUsageReceipt?: FlowModelUsageReceiptV1,
) {
  const candidate = boundedDataSnapshot(input, 'closure') as Omit<
    FlowStepCheckpointV1,
    'checkpoint_hash'
  >;
  return verifyFlowStepCheckpoint(
    { ...candidate, checkpoint_hash: canonicalSha256(candidate) },
    canonicalSha256(candidate),
    plan,
    expectedFlowPlanHash,
    predecessorCheckpoints,
    previousCommittedCheckpoint,
    modelUsageReceipt,
  );
}

export function verifyFlowStepCheckpoint(
  input: unknown,
  expectedCheckpointHash: unknown,
  plan: CompiledFlowPlanV1,
  expectedFlowPlanHash: string,
  predecessorCheckpoints: readonly FlowStepCheckpointV1[] = [],
  previousCommittedCheckpoint?: FlowStepCheckpointV1,
  modelUsageReceipt?: FlowModelUsageReceiptV1,
) {
  const parsed = FlowStepCheckpointV1Schema.safeParse(boundedDataSnapshot(input, 'closure'));
  if (!parsed.success) fail('$.checkpoint', 'Flow checkpoint failed its closed contract');
  const actual = canonicalSha256ExcludingRootKeys(parsed.data, ['checkpoint_hash']);
  if (parsed.data.checkpoint_hash !== actual || actual !== expectedCheckpointHash)
    throw new ReleaseCoreError(
      'RELEASE_HASH_MISMATCH',
      '$.checkpoint.checkpoint_hash',
      'Flow checkpoint differs from its trusted hash',
    );
  const trustedPlan = verifyCompiledFlowPlan(plan, expectedFlowPlanHash);
  const step = trustedPlan.steps.find((candidate) => candidate.node_id === parsed.data.node_id);
  if (
    parsed.data.flow_plan_hash !== trustedPlan.compiled_hash ||
    step === undefined ||
    step.node_type !== parsed.data.node_type ||
    step.canonical_node_path_hash !== parsed.data.canonical_node_path_hash
  )
    fail('$.checkpoint', 'checkpoint does not match its exact trusted FlowPlan step');
  if (parsed.data.node_type === 'llm') {
    if (step.node_type !== 'llm')
      fail('$.checkpoint', 'LLM checkpoint does not name an LLM FlowPlan step');
    if (modelUsageReceipt === undefined)
      fail(
        '$.checkpoint.model_usage_receipt_hash',
        'LLM checkpoint requires its exact usage receipt',
      );
    const usageResult = FlowModelUsageReceiptV1Schema.safeParse(
      boundedDataSnapshot(modelUsageReceipt, 'closure'),
    );
    if (
      !usageResult.success ||
      usageResult.data.receipt_hash !==
        canonicalSha256ExcludingRootKeys(usageResult.data, ['receipt_hash']) ||
      parsed.data.model_usage_receipt_id !== usageResult.data.model_usage_receipt_id ||
      parsed.data.model_usage_receipt_hash !== usageResult.data.receipt_hash ||
      usageResult.data.run_id !== parsed.data.run_id ||
      usageResult.data.flow_execution_id !== parsed.data.flow_execution_id ||
      usageResult.data.flow_plan_hash !== parsed.data.flow_plan_hash ||
      usageResult.data.node_id !== parsed.data.node_id ||
      usageResult.data.canonical_node_path_hash !== parsed.data.canonical_node_path_hash ||
      !samePin(usageResult.data.model, step.model) ||
      usageResult.data.model_attempt_number > (step.retry?.max_attempts ?? 1) ||
      BigInt(usageResult.data.usage.amount_credits) > BigInt(step.budget.amount_credits) ||
      usageResult.data.usage.input_tokens > step.budget.input_tokens ||
      usageResult.data.usage.output_tokens > step.budget.output_tokens ||
      usageResult.data.usage.total_tokens > step.budget.total_tokens ||
      usageResult.data.usage.duration_ms > step.budget.duration_ms
    )
      fail(
        '$.checkpoint.model_usage_receipt_hash',
        'LLM checkpoint requires its exact usage receipt',
      );
  } else if (modelUsageReceipt !== undefined) {
    fail('$.checkpoint', 'non-LLM checkpoint cannot consume a model usage receipt');
  }
  const safePredecessors = predecessorCheckpoints.map((checkpoint, index) => {
    const result = FlowStepCheckpointV1Schema.safeParse(boundedDataSnapshot(checkpoint, 'closure'));
    if (!result.success)
      fail(
        `$.checkpoint.predecessor_checkpoint_hashes[${index}]`,
        'predecessor checkpoint failed its closed contract',
      );
    return result.data;
  });
  const predecessorByNode = new Map(
    safePredecessors.map((checkpoint) => [checkpoint.node_id, checkpoint]),
  );
  if (
    predecessorByNode.size !== step.predecessor_node_ids.length ||
    step.predecessor_node_ids.some((nodeId) => !predecessorByNode.has(nodeId))
  )
    fail(
      '$.checkpoint.predecessor_checkpoint_hashes',
      'checkpoint omits an exact Plan predecessor',
    );
  const predecessorHashes = safePredecessors
    .map((checkpoint) => {
      if (
        canonicalSha256ExcludingRootKeys(checkpoint, ['checkpoint_hash']) !==
          checkpoint.checkpoint_hash ||
        checkpoint.run_id !== parsed.data.run_id ||
        checkpoint.flow_execution_id !== parsed.data.flow_execution_id ||
        checkpoint.flow_plan_hash !== parsed.data.flow_plan_hash ||
        checkpoint.execution_fence !== parsed.data.execution_fence ||
        BigInt(checkpoint.checkpoint_sequence) >= BigInt(parsed.data.checkpoint_sequence)
      )
        fail(
          '$.checkpoint.predecessor_checkpoint_hashes',
          'predecessor is stale, foreign or not committed before this checkpoint',
        );
      return checkpoint.checkpoint_hash;
    })
    .sort();
  if (
    predecessorHashes.length !== parsed.data.predecessor_checkpoint_hashes.length ||
    predecessorHashes.some(
      (hash, index) => hash !== parsed.data.predecessor_checkpoint_hashes[index],
    )
  )
    fail(
      '$.checkpoint.predecessor_checkpoint_hashes',
      'checkpoint predecessor hashes differ from the exact committed predecessors',
    );
  const safePrevious =
    previousCommittedCheckpoint === undefined
      ? undefined
      : (() => {
          const result = FlowStepCheckpointV1Schema.safeParse(
            boundedDataSnapshot(previousCommittedCheckpoint, 'closure'),
          );
          if (!result.success)
            fail(
              '$.checkpoint.previous_checkpoint_hash',
              'previous checkpoint failed its closed contract',
            );
          return result.data;
        })();
  if (parsed.data.checkpoint_sequence === '1') {
    if (parsed.data.previous_checkpoint_hash !== undefined || safePrevious !== undefined)
      fail('$.checkpoint.previous_checkpoint_hash', 'first checkpoint cannot name a prior commit');
  } else if (
    safePrevious === undefined ||
    parsed.data.previous_checkpoint_hash !== safePrevious.checkpoint_hash ||
    safePrevious.run_id !== parsed.data.run_id ||
    safePrevious.flow_execution_id !== parsed.data.flow_execution_id ||
    safePrevious.flow_plan_hash !== parsed.data.flow_plan_hash ||
    safePrevious.execution_fence !== parsed.data.execution_fence ||
    BigInt(safePrevious.checkpoint_sequence) + 1n !== BigInt(parsed.data.checkpoint_sequence) ||
    canonicalSha256ExcludingRootKeys(safePrevious, ['checkpoint_hash']) !==
      safePrevious.checkpoint_hash
  )
    fail(
      '$.checkpoint.previous_checkpoint_hash',
      'checkpoint does not extend the exact prior committed sequence',
    );
  return deepFreezeJson(parsed.data);
}
