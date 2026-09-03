import { describe, expect, it } from 'vitest';

import {
  BindingPathSegmentV1Schema,
  CapabilityInvocationRequirementsV1Schema,
  CapabilityRequirementExpressionV1Schema,
  ClosureResourceNodeV1Schema,
  CompiledBindingEntryV1Schema,
  CompiledCapabilityClosureV1Schema,
  CompiledGateSpecEntryV1Schema,
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
const secondBindingPath = `bp1.${'d'.repeat(43)}`;

const rootPin = {
  workspace_id: 'workspace-1',
  published_resource_kind: 'AGENT_RELEASE',
  resource_id: 'agent-1',
  resource_version_id: 'agent-release-1',
  contract_hash: hash,
  binding_mode: 'pinned',
} as const;

const flowPin = {
  ...rootPin,
  published_resource_kind: 'FLOW_VERSION',
  resource_id: 'flow-1',
  resource_version_id: 'flow-release-1',
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

const intrinsicExpression = {
  schema_version: 'capability-requirement-expression/1',
  expression_kind: 'leaf',
  requirements: intrinsicRequirements,
} as const;

const invocationRequirements = {
  ...intrinsicRequirements,
  minimum_limits: { ...intrinsicRequirements.minimum_limits, calls: 1, parallelism: 1 },
} as const;

const invocationSourceRequirements = {
  schema_version: 'capability-invocation-requirements/1',
  credential_requirements: invocationRequirements.credential_requirements,
  principal_modes: invocationRequirements.principal_modes,
  egress: invocationRequirements.egress,
  readable_data_classification: invocationRequirements.readable_data_classification,
  output_data_classification: invocationRequirements.output_data_classification,
  minimum_limits: invocationRequirements.minimum_limits,
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
  it('keeps invocation source demands nonzero and forbids self-authorized operation facts', () => {
    expect(
      CapabilityInvocationRequirementsV1Schema.safeParse(invocationSourceRequirements).success,
    ).toBe(true);
    expect(
      CapabilityInvocationRequirementsV1Schema.safeParse({
        ...invocationSourceRequirements,
        minimum_limits: { ...invocationSourceRequirements.minimum_limits, calls: 0 },
      }).success,
    ).toBe(false);
    expect(
      CapabilityInvocationRequirementsV1Schema.safeParse({
        ...invocationSourceRequirements,
        approval_required: false,
      }).success,
    ).toBe(false);
  });

  it('requires every resource node to carry a topology-preserving requirement expression', () => {
    const node = {
      node_id: rootNodeId,
      intrinsic_policy: intrinsicExpression,
      dependency_manifest_hash: hash,
      node_role: 'root',
      pin: rootPin,
    } as const;
    expect(ClosureResourceNodeV1Schema.safeParse(node).success).toBe(true);
    expect(
      ClosureResourceNodeV1Schema.safeParse({
        ...node,
        intrinsic_policy: intrinsicRequirements,
      }).success,
    ).toBe(false);
    expect(ClosureResourceNodeV1Schema.safeParse({ ...node, intrinsic_policy: {} }).success).toBe(
      false,
    );
    expect(
      ClosureResourceNodeV1Schema.safeParse({
        ...node,
        intrinsic_policy: { ...intrinsicExpression, trusted: true },
      }).success,
    ).toBe(false);
  });

  it('preserves alternatives and bounds expression fanout and depth', () => {
    const servicePrincipalLeaf = {
      ...intrinsicExpression,
      requirements: { ...intrinsicRequirements, principal_modes: ['service_principal'] },
    } as const;
    const delegatedLeaf = {
      ...intrinsicExpression,
      requirements: { ...intrinsicRequirements, principal_modes: ['caller_delegated'] },
    } as const;
    const alternative = {
      schema_version: 'capability-requirement-expression/1',
      expression_kind: 'alternative',
      children: [servicePrincipalLeaf, delegatedLeaf],
    } as const;
    expect(CapabilityRequirementExpressionV1Schema.safeParse(alternative).success).toBe(true);
    expect(
      CapabilityRequirementExpressionV1Schema.safeParse({
        ...alternative,
        children: Array.from({ length: 129 }, () => intrinsicExpression),
      }).success,
    ).toBe(false);

    let tooDeep: unknown = intrinsicExpression;
    for (let index = 0; index < 32; index += 1) {
      tooDeep = {
        schema_version: 'capability-requirement-expression/1',
        expression_kind: 'nested_call',
        invocation: invocationRequirements,
        child: tooDeep,
      };
    }
    expect(CapabilityRequirementExpressionV1Schema.safeParse(tooDeep).success).toBe(false);

    let hostileDepth: unknown = intrinsicExpression;
    for (let index = 0; index < 2_048; index += 1) {
      hostileDepth = {
        schema_version: 'capability-requirement-expression/1',
        expression_kind: 'nested_call',
        invocation: invocationRequirements,
        child: hostileDepth,
      };
    }
    expect(() => CapabilityRequirementExpressionV1Schema.safeParse(hostileDepth)).not.toThrow();
    expect(CapabilityRequirementExpressionV1Schema.safeParse(hostileDepth).success).toBe(false);
    expect(
      CapabilityRequirementExpressionV1Schema.safeParse({
        schema_version: 'capability-requirement-expression/1',
        expression_kind: 'nested_call',
        invocation: intrinsicRequirements,
        child: intrinsicExpression,
      }).success,
    ).toBe(false);
  });

  const binding = {
    binding_path_encoding_version: 'binding-path-lp-utf8/1',
    binding_path: bindingPath,
    binding_path_segments: [{ segment_kind: 'root', pin: rootPin }],
    binding_id: 'knowledge-1',
    binding_kind: 'knowledge',
    admission_requirement: 'optional',
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
    requirement_expression: intrinsicExpression,
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
    const { requirement_expression: _requirementExpression, ...withoutRequirement } = binding;
    expect(CompiledBindingEntryV1Schema.safeParse(withoutRequirement).success).toBe(false);
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
          intrinsic_policy: intrinsicExpression,
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

describe('Compiled Flow GateSpec path identity', () => {
  const gateSegments = (mountId: string) => [
    { segment_kind: 'root' as const, pin: rootPin },
    {
      segment_kind: 'binding' as const,
      owner: { owner_kind: 'root' as const, pin: rootPin },
      binding_kind: 'flow' as const,
      local_binding_id: mountId,
    },
    {
      segment_kind: 'flow_node' as const,
      owner: { owner_kind: 'published_dependency' as const, pin: flowPin },
      graph_id: 'root',
      node_id: 'gate-1',
    },
  ];
  const gate = {
    schema_version: 'compiled-gate-spec/1' as const,
    gate_spec_id: 'approval',
    gate_spec_hash: hash,
    kind: 'input' as const,
    decision_schema_hash: hash,
    approver_policy_ref: 'policy',
    approver_policy_hash: hash,
    on_reject: 'fail_run' as const,
    on_expire: 'cancel_run' as const,
    protected_operation_contract_hashes: [],
    source_kind: 'flow_node' as const,
    source_node_id: missingNodeId,
    source_binding_path: bindingPath,
    source_binding_path_segments: gateSegments('mount-a'),
    source_flow_node_id: 'gate-1',
  };

  it('requires retained root-to-node segments and an exact final Flow node ID', () => {
    expect(CompiledGateSpecEntryV1Schema.safeParse(gate).success).toBe(true);
    const { source_binding_path_segments: _segments, ...withoutSegments } = gate;
    expect(CompiledGateSpecEntryV1Schema.safeParse(withoutSegments).success).toBe(false);
    expect(
      CompiledGateSpecEntryV1Schema.safeParse({
        ...gate,
        source_binding_path_segments: gate.source_binding_path_segments.slice(1),
      }).success,
    ).toBe(false);
    expect(
      CompiledGateSpecEntryV1Schema.safeParse({ ...gate, source_flow_node_id: 'other' }).success,
    ).toBe(false);
  });

  it('allows one source Gate per distinct mount but rejects same-mount duplicates and kind flips', () => {
    const secondGate = {
      ...gate,
      source_binding_path: secondBindingPath,
      source_binding_path_segments: gateSegments('mount-b'),
    };
    const closure = {
      schema_version: 'compiled-capability-closure/1' as const,
      root: { pin: rootPin, semantic_seed_hash: hash },
      assembly_pins: [flowPin],
      bindings: [],
      gate_specs: [gate, secondGate],
      resource_nodes: [
        {
          node_id: rootNodeId,
          intrinsic_policy: intrinsicExpression,
          dependency_manifest_hash: hash,
          node_role: 'root' as const,
          pin: rootPin,
        },
        {
          node_id: missingNodeId,
          intrinsic_policy: intrinsicExpression,
          dependency_manifest_hash: hash,
          node_role: 'dependency' as const,
          pin: flowPin,
          nested_closure_hash: hash,
        },
      ],
      dependency_edges: [],
      disabled_binding_paths: [],
      aggregate_limits: effectivePolicy,
      closure_hash: hash,
    };
    expect(CompiledCapabilityClosureV1Schema.safeParse(closure).success).toBe(true);
    expect(
      CompiledCapabilityClosureV1Schema.safeParse({
        ...closure,
        gate_specs: [gate, { ...gate }],
      }).success,
    ).toBe(false);
    const {
      source_binding_path: _path,
      source_binding_path_segments: _pathSegments,
      source_flow_node_id: _flowNodeId,
      ...pathless
    } = gate;
    expect(
      CompiledCapabilityClosureV1Schema.safeParse({
        ...closure,
        gate_specs: [{ ...pathless, source_kind: 'agent_release' }],
      }).success,
    ).toBe(false);
  });

  it('rejects a nested Flow Gate that borrows its ancestor Flow as the source', () => {
    const nestedFlowPin = {
      ...flowPin,
      resource_id: 'flow-2',
      resource_version_id: 'flow-release-2',
    };
    const nestedNodeId = `rn1.${'d'.repeat(43)}`;
    const borrowedGate = {
      ...gate,
      source_binding_path_segments: [
        ...gate.source_binding_path_segments.slice(0, -1),
        {
          segment_kind: 'flow_node' as const,
          owner: { owner_kind: 'published_dependency' as const, pin: flowPin },
          graph_id: 'root',
          node_id: 'call-child',
        },
        {
          segment_kind: 'flow_node' as const,
          owner: { owner_kind: 'published_dependency' as const, pin: nestedFlowPin },
          graph_id: 'nested',
          node_id: 'gate-1',
        },
      ],
    };
    const closure = {
      schema_version: 'compiled-capability-closure/1' as const,
      root: { pin: rootPin, semantic_seed_hash: hash },
      assembly_pins: [flowPin, nestedFlowPin],
      bindings: [],
      gate_specs: [borrowedGate],
      resource_nodes: [
        {
          node_id: rootNodeId,
          intrinsic_policy: intrinsicExpression,
          dependency_manifest_hash: hash,
          node_role: 'root' as const,
          pin: rootPin,
        },
        {
          node_id: missingNodeId,
          intrinsic_policy: intrinsicExpression,
          dependency_manifest_hash: hash,
          node_role: 'dependency' as const,
          pin: flowPin,
          nested_closure_hash: hash,
        },
        {
          node_id: nestedNodeId,
          intrinsic_policy: intrinsicExpression,
          dependency_manifest_hash: hash,
          node_role: 'dependency' as const,
          pin: nestedFlowPin,
          nested_closure_hash: hash,
        },
      ],
      dependency_edges: [],
      disabled_binding_paths: [],
      aggregate_limits: effectivePolicy,
      closure_hash: hash,
    };
    expect(CompiledGateSpecEntryV1Schema.safeParse(borrowedGate).success).toBe(true);
    expect(
      CompiledCapabilityClosureV1Schema.safeParse({
        ...closure,
        gate_specs: [{ ...borrowedGate, source_node_id: nestedNodeId }],
      }).success,
    ).toBe(true);
    expect(CompiledCapabilityClosureV1Schema.safeParse(closure).success).toBe(false);
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
