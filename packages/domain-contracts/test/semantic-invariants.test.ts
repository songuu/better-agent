import { describe, expect, it } from 'vitest';

import {
  BindingPathSegmentV1Schema,
  CompiledBindingEntryV1Schema,
  CompiledCapabilityClosureV1Schema,
  ClosureResourceNodeV1Schema,
  FlowGraphV1Schema,
  FlowIrV1Schema,
  ProductionPromotionGateDecisionV1Schema,
} from '../src/index.js';

const hash = 'sha256:semantic-invariant';
const operationHashA = `sha256:${'a'.repeat(64)}`;
const operationHashB = `sha256:${'b'.repeat(64)}`;
const bindingPath = `bp1.${'a'.repeat(43)}`;
const rootNodeId = `rn1.${'b'.repeat(43)}`;
const missingNodeId = `rn1.${'c'.repeat(43)}`;

const rootPin = {
  workspace_id: 'workspace-1',
  published_resource_kind: 'AGENT_RELEASE',
  resource_id: 'agent-1',
  resource_version_id: 'agent-release-1',
  contract_hash: hash,
  binding_mode: 'pinned',
} as const;

const effectivePolicy = {
  credential_requirements: [],
  principal_modes: ['none'],
  egress: [],
  readable_data_classification_ceiling: 'public',
  output_data_classification: 'public',
  side_effect: { maximum_class: 'safe', approval: 'none' },
  operation_contract_hashes: [],
  max_calls: 0,
  max_depth: 0,
  max_parallelism: 0,
  budget: {
    schema_version: 'capability-budget/1',
    amount_credits: '0',
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    duration_ms: 0,
  },
} as const;

const intrinsicRequirements = {
  schema_version: 'capability-requirements/1',
  credential_requirements: [],
  principal_modes: ['none'],
  egress: [],
  readable_data_classification: 'public',
  output_data_classification: 'public',
  side_effect_class: 'safe',
  approval_required: false,
  operation_contract_hashes: [],
  minimum_limits: {
    calls: 0,
    depth: 0,
    parallelism: 0,
    budget: effectivePolicy.budget,
  },
} as const;

function actionNode(nodeId: string, key: string, type: 'output' | 'start' | 'text') {
  return {
    node_id: nodeId,
    key,
    type,
    config: {},
    inputs: {},
    output_schema: { type: 'object' },
  } as const;
}

describe('Flow graph semantic invariants', () => {
  it('rejects unreachable nodes and ordinary control cycles', () => {
    const unreachable = FlowGraphV1Schema.safeParse({
      graph_id: 'graph-unreachable',
      entry_node_id: 'start',
      exit_node_ids: ['output'],
      nodes: [
        actionNode('start', 'start', 'start'),
        actionNode('output', 'output', 'output'),
        actionNode('orphan', 'orphan', 'text'),
      ],
      edges: [
        {
          edge_id: 'edge-start-output',
          from: { node_id: 'start', port: 'control' },
          to: { node_id: 'output', port: 'control' },
          kind: 'control',
        },
      ],
    });
    expect(unreachable.success).toBe(false);
    if (!unreachable.success) expect(unreachable.error.message).toContain('unreachable');

    const cyclic = FlowGraphV1Schema.safeParse({
      graph_id: 'graph-cycle',
      entry_node_id: 'start',
      exit_node_ids: ['output'],
      nodes: [actionNode('start', 'start', 'start'), actionNode('output', 'output', 'output')],
      edges: [
        {
          edge_id: 'edge-start-output',
          from: { node_id: 'start', port: 'control' },
          to: { node_id: 'output', port: 'control' },
          kind: 'control',
        },
        {
          edge_id: 'edge-output-start',
          from: { node_id: 'output', port: 'control' },
          to: { node_id: 'start', port: 'control' },
          kind: 'control',
        },
      ],
    });
    expect(cyclic.success).toBe(false);
    if (!cyclic.success) expect(cyclic.error.message).toContain('acyclic');
  });

  it('rejects duplicate graph IDs across the complete Flow document', () => {
    const body = {
      graph_id: 'root',
      entry_node_id: 'body-output',
      exit_node_ids: ['body-output'],
      nodes: [actionNode('body-output', 'body_output', 'output')],
      edges: [],
    };
    const result = FlowIrV1Schema.safeParse({
      schema_version: 'flow-ir/1',
      flow_id: 'flow',
      flow_version_id: 'version',
      title: 'Flow',
      entry_graph: {
        graph_id: 'root',
        entry_node_id: 'start',
        exit_node_ids: ['loop'],
        nodes: [
          actionNode('start', 'start', 'start'),
          {
            node_id: 'loop',
            key: 'loop',
            type: 'loop',
            inputs: {},
            output_schema: {},
            config: {
              mode: 'condition',
              continue_when: 'true',
              max_iterations: 1,
              body,
              exports: {},
            },
          },
        ],
        edges: [
          {
            edge_id: 'edge',
            from: { node_id: 'start', port: 'control' },
            to: { node_id: 'loop', port: 'control' },
            kind: 'control',
          },
        ],
      },
      input_schema: {},
      output_schema: {},
      resources: [],
      credential_requirements: [],
      execution_defaults: {},
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('globally unique');
  });

  it('requires the canonical root graph namespace', () => {
    const graph = {
      graph_id: 'not-root',
      entry_node_id: 'start',
      exit_node_ids: ['start'],
      nodes: [actionNode('start', 'start', 'start')],
      edges: [],
    };
    const result = FlowIrV1Schema.safeParse({
      schema_version: 'flow-ir/1',
      flow_id: 'flow',
      flow_version_id: 'version',
      title: 'Flow',
      entry_graph: graph,
      input_schema: {},
      output_schema: {},
      resources: [],
      credential_requirements: [],
      execution_defaults: {},
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('root graph id must be root');
  });
});

describe('Compiled closure reference integrity', () => {
  it('requires every resource node to carry typed intrinsic capability requirements', () => {
    const node = {
      node_id: rootNodeId,
      intrinsic_policy: intrinsicRequirements,
      dependency_manifest_hash: hash,
      node_role: 'root',
      pin: rootPin,
    } as const;
    expect(ClosureResourceNodeV1Schema.safeParse(node).success).toBe(true);
    expect(ClosureResourceNodeV1Schema.safeParse({ ...node, intrinsic_policy: {} }).success).toBe(
      false,
    );
    expect(
      ClosureResourceNodeV1Schema.safeParse({
        ...node,
        intrinsic_policy: { ...intrinsicRequirements, trusted: true },
      }).success,
    ).toBe(false);
  });

  const binding = {
    binding_path_encoding_version: 'binding-path-lp-utf8/1',
    binding_path: bindingPath,
    binding_path_segments: [{ segment_kind: 'root', pin: rootPin }],
    binding_id: 'knowledge-1',
    binding_kind: 'knowledge',
    target: {
      workspace_id: 'workspace-1',
      published_resource_kind: 'KNOWLEDGE_INDEX_GENERATION',
      resource_id: 'knowledge-1',
      resource_version_id: 'generation-1',
      contract_hash: hash,
      binding_mode: 'pinned',
    },
    config_schema_version: 'knowledge-binding/1',
    config_hash: hash,
    source_contract_hash: hash,
    effective_policy: effectivePolicy,
    operation_contracts: [],
    dependency_node_ids: [missingNodeId],
  } as const;

  it('rejects unknown binding config versions', () => {
    expect(
      CompiledBindingEntryV1Schema.safeParse({
        ...binding,
        config_schema_version: 'future-binding/1',
      }).success,
    ).toBe(false);
  });

  it('binds config version and operation kind to the Binding discriminator', () => {
    expect(
      CompiledBindingEntryV1Schema.safeParse({
        ...binding,
        config_schema_version: 'plugin-binding/1',
      }).success,
    ).toBe(false);
    expect(
      CompiledBindingEntryV1Schema.safeParse({
        ...binding,
        operation_contracts: [
          {
            operation_kind: 'plugin_tool',
            operation_id: 'wrong-kind',
            input_schema_hash: hash,
            side_effect_class: 'safe',
            operation_key_required: false,
            approval_required: false,
            contract_hash: operationHashA,
          },
        ],
        effective_policy: { ...effectivePolicy, operation_contract_hashes: [operationHashA] },
      }).success,
    ).toBe(false);
  });

  it('requires canonical unique operation/dependency sets and exact policy hash coverage', () => {
    const operation = (contractHash: string) => ({
      operation_kind: 'knowledge_query' as const,
      operation_id: contractHash,
      input_schema_hash: hash,
      side_effect_class: 'safe' as const,
      operation_key_required: false,
      approval_required: false,
      contract_hash: contractHash,
    });
    const operations = [operation(operationHashA), operation(operationHashB)];
    const complete = {
      ...binding,
      operation_contracts: operations,
      dependency_node_ids: [rootNodeId, missingNodeId],
      effective_policy: {
        ...effectivePolicy,
        operation_contract_hashes: operations.map((item) => item.contract_hash),
      },
    };
    expect(CompiledBindingEntryV1Schema.safeParse(complete).success).toBe(true);
    expect(
      CompiledBindingEntryV1Schema.safeParse({
        ...complete,
        operation_contracts: [...operations].reverse(),
      }).success,
    ).toBe(false);
    expect(
      CompiledBindingEntryV1Schema.safeParse({
        ...complete,
        operation_contracts: [operations[0], operations[0]],
      }).success,
    ).toBe(false);
    expect(
      CompiledBindingEntryV1Schema.safeParse({
        ...complete,
        dependency_node_ids: [missingNodeId, rootNodeId],
      }).success,
    ).toBe(false);
    expect(
      CompiledBindingEntryV1Schema.safeParse({
        ...complete,
        effective_policy: {
          ...effectivePolicy,
          operation_contract_hashes: [operationHashA],
        },
      }).success,
    ).toBe(false);
    expect(
      CompiledBindingEntryV1Schema.safeParse({
        ...complete,
        operation_contracts: [{ ...operations[0], side_effect_class: 'unsafe' }, operations[1]],
      }).success,
    ).toBe(false);
  });

  it('binds approval evidence and async child hashes to their exact semantics', () => {
    const required = {
      ...binding,
      effective_policy: {
        ...effectivePolicy,
        side_effect: { maximum_class: 'safe', approval: 'required' },
      },
    } as const;
    expect(CompiledBindingEntryV1Schema.safeParse(required).success).toBe(false);
    expect(
      CompiledBindingEntryV1Schema.safeParse({
        ...required,
        approval_gate_spec: { gate_spec_id: 'approval', gate_spec_hash: hash },
      }).success,
    ).toBe(true);
    expect(
      CompiledBindingEntryV1Schema.safeParse({
        ...binding,
        approval_gate_spec: { gate_spec_id: 'approval', gate_spec_hash: hash },
      }).success,
    ).toBe(false);
    expect(
      CompiledBindingEntryV1Schema.safeParse({
        ...binding,
        async_child_policy_hash: hash,
      }).success,
    ).toBe(false);
    expect(
      CompiledBindingEntryV1Schema.safeParse({
        ...binding,
        binding_kind: 'flow',
        target: { ...binding.target, published_resource_kind: 'FLOW_VERSION' },
        config_schema_version: 'flow-binding/1',
        async_child_policy_hash: hash,
      }).success,
    ).toBe(true);
  });

  it('binds every Skill Pack operation route to this path and one compiled operation', () => {
    const operation = {
      operation_kind: 'knowledge_query' as const,
      operation_id: 'query',
      input_schema_hash: hash,
      side_effect_class: 'safe' as const,
      operation_key_required: false,
      approval_required: false,
      contract_hash: operationHashA,
    };
    const pack = {
      ...binding,
      binding_kind: 'skill_pack',
      target: { ...binding.target, published_resource_kind: 'SKILL_PACK_RELEASE' },
      config_schema_version: 'skill-pack-binding/1',
      operation_contracts: [operation],
      effective_policy: {
        ...effectivePolicy,
        operation_contract_hashes: [operationHashA],
      },
      skill_pack_operation_routes: [
        {
          pack_binding_path: bindingPath,
          exposed_operation_id: 'query',
          exposed_operation_contract_hash: operationHashA,
          member_binding_path: `bp1.${'d'.repeat(43)}`,
          member_target: binding.target,
          member_operation_contract_hash: operationHashA,
          route_hash: hash,
        },
      ],
    } as const;
    expect(CompiledBindingEntryV1Schema.safeParse(pack).success).toBe(true);
    expect(
      CompiledBindingEntryV1Schema.safeParse({
        ...pack,
        skill_pack_operation_routes: [
          { ...pack.skill_pack_operation_routes[0], pack_binding_path: `bp1.${'e'.repeat(43)}` },
        ],
      }).success,
    ).toBe(false);
    expect(
      CompiledBindingEntryV1Schema.safeParse({
        ...pack,
        skill_pack_operation_routes: [],
      }).success,
    ).toBe(false);
  });

  it('rejects binding and gate references outside the closure node set', () => {
    const result = CompiledCapabilityClosureV1Schema.safeParse({
      schema_version: 'compiled-capability-closure/1',
      root: { pin: rootPin, semantic_seed_hash: hash },
      assembly_pins: [],
      bindings: [binding],
      gate_specs: [
        {
          schema_version: 'compiled-gate-spec/1',
          gate_spec_id: 'gate-1',
          gate_spec_hash: hash,
          kind: 'input',
          decision_schema_hash: hash,
          approver_policy_ref: 'policy-1',
          approver_policy_hash: hash,
          on_reject: 'fail_run',
          on_expire: 'fail_run',
          protected_operation_contract_hashes: [],
          source_kind: 'agent_release',
          source_node_id: missingNodeId,
        },
      ],
      resource_nodes: [
        {
          node_id: rootNodeId,
          intrinsic_policy: intrinsicRequirements,
          dependency_manifest_hash: hash,
          node_role: 'root',
          pin: rootPin,
        },
      ],
      dependency_edges: [],
      disabled_binding_paths: [],
      aggregate_limits: effectivePolicy,
      closure_hash: hash,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('unknown dependency node');
      expect(result.error.message).toContain('unknown source node');
    }
  });
});

describe('Flow node path namespace', () => {
  const flowPin = { ...rootPin, published_resource_kind: 'FLOW_VERSION' as const };
  const segment = {
    segment_kind: 'flow_node',
    owner: { owner_kind: 'root', pin: flowPin },
    graph_id: 'nested-graph',
    node_id: 'shared-node',
  } as const;

  it('requires both graph and node identity in a closed Flow node segment', () => {
    expect(BindingPathSegmentV1Schema.safeParse(segment).success).toBe(true);
    const { graph_id: _graphId, ...withoutGraph } = segment;
    expect(BindingPathSegmentV1Schema.safeParse(withoutGraph).success).toBe(false);
    expect(BindingPathSegmentV1Schema.safeParse({ ...segment, graph_id: '' }).success).toBe(false);
    expect(BindingPathSegmentV1Schema.safeParse({ ...segment, extra: true }).success).toBe(false);
  });
});

describe('Production promotion decision shape', () => {
  const decision = {
    schema_version: 'production-promotion-gate-decision/1',
    decision_id: 'decision-1',
    key: {
      schema_version: 'production-promotion-gate-key/1',
      workspace_id: 'workspace-1',
      deployment_kind: 'agent',
      deployment_id: 'deployment-1',
      candidate_deployment_revision_id: 'revision-1',
      candidate_revision_contract_hash: hash,
      executable_target: rootPin,
      dependency_manifest_hash: hash,
      capability_closure_hash: hash,
      evaluation_suite_release_id: 'suite-1',
      evaluation_policy_hash: hash,
      evaluation_run_ids: ['evaluation-1'],
      evidence_bundle_hash: hash,
      observed_evidence_epoch_hash: hash,
      expected_activation_epoch: 0,
    },
    key_hash: hash,
    status: 'PENDING',
    decision_version: 1,
    expires_at: '2026-08-27T00:00:00Z',
  } as const;

  it('requires ISO timestamps and status-consistent transition fields', () => {
    expect(
      ProductionPromotionGateDecisionV1Schema.safeParse({
        ...decision,
        expires_at: 'not-a-timestamp',
      }).success,
    ).toBe(false);
    expect(
      ProductionPromotionGateDecisionV1Schema.safeParse({
        ...decision,
        status: 'APPROVED',
      }).success,
    ).toBe(false);
    expect(
      ProductionPromotionGateDecisionV1Schema.safeParse({
        ...decision,
        decided_at: '2026-08-26T12:00:00Z',
        decided_by: 'reviewer-1',
        status: 'APPROVED',
      }).success,
    ).toBe(true);
  });
});
