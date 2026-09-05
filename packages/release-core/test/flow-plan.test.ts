import { describe, expect, it } from 'vitest';

import {
  canonicalSha256,
  canonicalSha256ExcludingRootKeys,
  deriveDependencyManifest,
  prepareCompiledFlowPlan,
  prepareExecutableSource,
  prepareFlowStepCheckpoint,
  preparePinnedDependencyGraph,
  verifyCompiledFlowPlan,
  verifyFlowStepCheckpoint,
} from '../src/index.js';
import { credentialMaterialIdentityHash } from '../src/admission-credential.js';
import { prepareFlowCapabilityClosure } from '../src/flow-capability-closure.js';
import { hashA, hashB, makeFlowIr, workspaceId } from './fixtures.js';

function linearLlmFlow() {
  const flow = structuredClone(makeFlowIr()) as unknown as Record<string, unknown> & {
    entry_graph: { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] };
  };
  const model = {
    workspace_id: workspaceId,
    published_resource_kind: 'SYSTEM_RELEASE',
    resource_id: '018f47f2-c541-7cc6-9292-4a2c35303e71',
    resource_version_id: '018f47f2-c541-7cc6-9292-4a2c35303e72',
    contract_hash: hashA,
    binding_mode: 'pinned',
  } as const;
  flow.resources = [model];
  flow.credential_requirements = [
    {
      schema_version: 'credential-requirement/1',
      requirement_id: 'model-provider',
      provider_id: 'model-provider',
      audience: 'model-runtime',
      required_scopes: ['model:invoke'],
      allowed_principal_modes: ['service_principal'],
    },
  ];
  flow.entry_graph.nodes.splice(1, 0, {
    node_id: 'llm-1',
    key: 'llm_1',
    type: 'llm',
    inputs: { content: '{{start.content}}' },
    output_schema: { type: 'object' },
    timeout_ms: 45_000,
    config: {
      schema_version: 'flow-llm-node-config/1',
      model,
      credential_requirement_id: 'model-provider',
      prompt: '{{start.content}}',
      max_amount_credits: '1000',
      max_input_tokens: 4096,
      max_output_tokens: 512,
      temperature: 0.2,
    },
  });
  flow.entry_graph.edges = [
    {
      edge_id: 'edge-1',
      from: { node_id: 'start-1', port: 'control' },
      to: { node_id: 'llm-1', port: 'control' },
      kind: 'control',
    },
    {
      edge_id: 'edge-2',
      from: { node_id: 'llm-1', port: 'control' },
      to: { node_id: 'output-1', port: 'control' },
      kind: 'control',
    },
  ];
  return flow;
}

function executableSource() {
  return {
    schema_version: 'executable-source-candidate/1',
    workspace_id: workspaceId,
    document: linearLlmFlow(),
  } as const;
}

function graph(source = executableSource()) {
  const prepared = prepareExecutableSource(source);
  const dependencies = prepared.dependency_manifest.dependencies;
  return preparePinnedDependencyGraph({
    schema_version: 'pinned-dependency-graph-candidate/1',
    root: prepared.root,
    root_dependencies: dependencies,
    resources: dependencies.map((pin) => ({
      schema_version: 'pinned-dependency-record/1',
      pin,
      publication_state: 'sealed',
      dependency_manifest: deriveDependencyManifest(
        {
          workspace_id: pin.workspace_id,
          published_resource_kind: pin.published_resource_kind,
          resource_id: pin.resource_id,
          resource_version_id: pin.resource_version_id,
        },
        [],
      ),
    })),
  });
}

function admittedFixture() {
  const source = executableSource();
  const pinnedGraph = graph(source);
  const closure = prepareFlowCapabilityClosure(source, pinnedGraph);
  const material = {
    principal_mode: 'service_principal' as const,
    credential_subject_id: 'service-principal-1',
    credential_id: 'credential-1',
    credential_version_id: 'credential-version-1',
    provider_id: 'model-provider',
    audience: 'model-runtime',
    granted_scopes: ['model:invoke'],
    credential_handle_hash: hashA,
    material_fingerprint_hash: hashB,
  };
  const credential = {
    requirement_id: 'model-provider',
    mapping_hash: hashA,
    ...material,
    epoch_source: {
      source_kind: 'credential' as const,
      source_id: material.credential_id,
      source_subkey: credentialMaterialIdentityHash(material),
      observed_epoch: 1,
    },
  };
  const effectivePolicy = closure.aggregate_limits;
  const draft = {
    schema_version: 'resolved-execution-plan/1' as const,
    workspace_id: workspaceId,
    deployment_revision_id: 'flow-deployment-revision-1',
    deployment_revision_contract_hash: hashA,
    root_release: closure.root.pin,
    capability_closure_hash: closure.closure_hash,
    admission_snapshot_hash: hashA,
    admission_activation_epoch: 1,
    observed_revoke_epoch: 1,
    authorization_decision_id: 'decision-1',
    authorization_decision_hash: hashA,
    authorization_epoch_vector_hash: hashA,
    authorization_expires_at: '2026-09-05T00:00:00+00:00',
    root_authority: {
      effective_policy: effectivePolicy,
      effective_policy_hash: canonicalSha256(effectivePolicy),
      credential_mapping_hashes: [hashA],
      credential_bindings: [credential],
    },
    enabled_bindings: [],
    disabled_binding_paths: [],
    required_binding_paths: [],
    required_calls: [],
    plan_kind: 'flow' as const,
    flow_deployment_id: 'flow-deployment-1',
    flow_version_id: closure.root.pin.resource_version_id,
  };
  const resolvedPlan = {
    ...draft,
    plan_hash: canonicalSha256ExcludingRootKeys(draft, ['plan_hash']),
  };
  return { source, pinnedGraph, closure, resolvedPlan };
}

function compileFixture() {
  const value = admittedFixture();
  const plan = prepareCompiledFlowPlan({
    executable_source: value.source,
    pinned_graph: value.pinnedGraph,
    closure: value.closure,
    resolved_execution_plan: value.resolvedPlan,
    expected_resolved_execution_plan_hash: value.resolvedPlan.plan_hash,
  });
  return { ...value, plan };
}

describe('compiled FlowPlan and checkpoint', () => {
  it('compiles exact Start to LLM to Output facts deterministically', () => {
    const left = compileFixture();
    const right = compileFixture();
    expect(left.plan).toEqual(right.plan);
    expect(left.plan.steps.map((step) => step.node_type)).toEqual(['start', 'llm', 'output']);
    expect(left.plan.steps[1]).toMatchObject({
      credential_requirement_id: 'model-provider',
      credential_mapping_hash: hashA,
      budget: { amount_credits: '1000', total_tokens: 4608, duration_ms: 45_000 },
    });
  });

  it('rejects missing root credential authority before producing a FlowPlan', () => {
    const value = admittedFixture();
    const { root_authority: _removed, ...withoutAuthority } = value.resolvedPlan;
    const changed = {
      ...withoutAuthority,
      plan_hash: canonicalSha256ExcludingRootKeys(withoutAuthority, ['plan_hash']),
    };
    expect(() =>
      prepareCompiledFlowPlan({
        executable_source: value.source,
        pinned_graph: value.pinnedGraph,
        closure: value.closure,
        resolved_execution_plan: changed,
        expected_resolved_execution_plan_hash: changed.plan_hash,
      }),
    ).toThrow('one exact admitted root credential');
  });

  it('rejects stale FlowPlan content and independently compiled closure drift', () => {
    const value = compileFixture();
    const changedPlan = structuredClone(value.plan);
    changedPlan.steps[1].temperature = 1.7;
    expect(() => verifyCompiledFlowPlan(changedPlan, value.plan.compiled_hash)).toThrow(
      'RELEASE_HASH_MISMATCH',
    );
    const changedClosure = { ...value.closure, closure_hash: hashA };
    expect(() =>
      prepareCompiledFlowPlan({
        executable_source: value.source,
        pinned_graph: value.pinnedGraph,
        closure: changedClosure,
        resolved_execution_plan: value.resolvedPlan,
        expected_resolved_execution_plan_hash: value.resolvedPlan.plan_hash,
      }),
    ).toThrow('CLOSURE');
  });

  it('seals causal checkpoints and requires LLM usage evidence', () => {
    const { plan } = compileFixture();
    const startStep = plan.steps[0];
    const start = prepareFlowStepCheckpoint(
      {
        schema_version: 'flow-step-checkpoint/1',
        run_id: '018f47f2-c541-7cc6-9292-4a2c35303101',
        flow_execution_id: '018f47f2-c541-7cc6-9292-4a2c35303102',
        flow_plan_hash: plan.compiled_hash,
        checkpoint_sequence: '1',
        execution_fence: '1',
        node_id: startStep.node_id,
        node_type: 'start',
        canonical_node_path_hash: startStep.canonical_node_path_hash,
        attempt: 1,
        predecessor_checkpoint_hashes: [],
        output_ref: 'snapshot://start',
        output_hash: hashA,
      },
      plan,
      plan.compiled_hash,
    );
    expect(
      verifyFlowStepCheckpoint(start, start.checkpoint_hash, plan, plan.compiled_hash),
    ).toEqual(start);

    const llmStep = plan.steps[1];
    if (llmStep.node_type !== 'llm') throw new Error('fixture LLM step is unavailable');
    const usageDraft = {
      schema_version: 'flow-model-usage-receipt/1' as const,
      model_usage_receipt_id: '018f47f2-c541-7cc6-9292-4a2c35303104',
      run_id: '018f47f2-c541-7cc6-9292-4a2c35303101',
      flow_execution_id: '018f47f2-c541-7cc6-9292-4a2c35303102',
      flow_plan_hash: plan.compiled_hash,
      node_id: llmStep.node_id,
      canonical_node_path_hash: llmStep.canonical_node_path_hash,
      model: llmStep.model,
      model_attempt_number: 1,
      operation_key: 'flow-llm:v1:test',
      provider_request_hash: hashA,
      result_payload_hash: hashB,
      usage: {
        schema_version: 'capability-budget/1' as const,
        amount_credits: '40',
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        duration_ms: 800,
      },
    };
    const usage = {
      ...usageDraft,
      receipt_hash: canonicalSha256ExcludingRootKeys(usageDraft, ['receipt_hash']),
    };
    const llm = prepareFlowStepCheckpoint(
      {
        schema_version: 'flow-step-checkpoint/1',
        run_id: '018f47f2-c541-7cc6-9292-4a2c35303101',
        flow_execution_id: '018f47f2-c541-7cc6-9292-4a2c35303102',
        flow_plan_hash: plan.compiled_hash,
        checkpoint_sequence: '2',
        previous_checkpoint_hash: start.checkpoint_hash,
        execution_fence: '1',
        node_id: llmStep.node_id,
        node_type: 'llm',
        canonical_node_path_hash: llmStep.canonical_node_path_hash,
        attempt: 1,
        predecessor_checkpoint_hashes: [start.checkpoint_hash],
        output_ref: 'snapshot://llm',
        output_hash: hashB,
        model_usage_receipt_id: usage.model_usage_receipt_id,
        model_usage_receipt_hash: usage.receipt_hash,
      },
      plan,
      plan.compiled_hash,
      [start],
      start,
      usage,
    );
    expect(
      verifyFlowStepCheckpoint(
        llm,
        llm.checkpoint_hash,
        plan,
        plan.compiled_hash,
        [start],
        start,
        usage,
      ),
    ).toEqual(llm);
    expect(() =>
      verifyFlowStepCheckpoint(llm, llm.checkpoint_hash, plan, plan.compiled_hash, [start], start),
    ).toThrow();
    const overBudgetDraft = {
      ...usage,
      usage: { ...usage.usage, input_tokens: 9_999, total_tokens: 10_019 },
    };
    const overBudget = {
      ...overBudgetDraft,
      receipt_hash: canonicalSha256ExcludingRootKeys(overBudgetDraft, ['receipt_hash']),
    };
    const { checkpoint_hash: _overBudgetCheckpointHash, ...llmCheckpointInput } = llm;
    expect(() =>
      prepareFlowStepCheckpoint(
        {
          ...llmCheckpointInput,
          model_usage_receipt_hash: overBudget.receipt_hash,
        },
        plan,
        plan.compiled_hash,
        [start],
        start,
        overBudget,
      ),
    ).toThrow('exact usage receipt');
    const overDurationDraft = {
      ...usage,
      usage: { ...usage.usage, duration_ms: llmStep.budget.duration_ms + 1 },
    };
    const overDuration = {
      ...overDurationDraft,
      receipt_hash: canonicalSha256ExcludingRootKeys(overDurationDraft, ['receipt_hash']),
    };
    expect(() =>
      prepareFlowStepCheckpoint(
        {
          ...llmCheckpointInput,
          model_usage_receipt_hash: overDuration.receipt_hash,
        },
        plan,
        plan.compiled_hash,
        [start],
        start,
        overDuration,
      ),
    ).toThrow('exact usage receipt');
    const {
      checkpoint_hash: _checkpointHash,
      model_usage_receipt_id: _usageId,
      model_usage_receipt_hash: _usageHash,
      ...missingUsage
    } = llm;
    expect(() =>
      prepareFlowStepCheckpoint(
        missingUsage as never,
        plan,
        plan.compiled_hash,
        [start],
        start,
        usage,
      ),
    ).toThrow('closed contract');
    expect(() =>
      verifyFlowStepCheckpoint(
        llm,
        llm.checkpoint_hash,
        plan,
        plan.compiled_hash,
        [],
        start,
        usage,
      ),
    ).toThrow('exact Plan predecessor');
    const foreignDraft = {
      ...start,
      run_id: '018f47f2-c541-7cc6-9292-4a2c35303103',
      checkpoint_hash: hashA,
    };
    const foreign = {
      ...foreignDraft,
      checkpoint_hash: canonicalSha256ExcludingRootKeys(foreignDraft, ['checkpoint_hash']),
    };
    expect(() =>
      verifyFlowStepCheckpoint(
        llm,
        llm.checkpoint_hash,
        plan,
        plan.compiled_hash,
        [foreign],
        start,
        usage,
      ),
    ).toThrow('stale, foreign');
    let getterCalls = 0;
    const accessor = structuredClone(start) as Record<string, unknown>;
    Object.defineProperty(accessor, 'node_id', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return start.node_id;
      },
    });
    expect(() =>
      verifyFlowStepCheckpoint(
        llm,
        llm.checkpoint_hash,
        plan,
        plan.compiled_hash,
        [accessor as never],
        start,
        usage,
      ),
    ).toThrow();
    expect(getterCalls).toBe(0);
  });
});
