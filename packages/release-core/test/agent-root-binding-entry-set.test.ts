import { AgentExecutableSourceV1Schema } from '@better-agent/domain-contracts';
import { describe, expect, it } from 'vitest';

import {
  prepareNonRecursiveAgentCapabilityClosure,
  verifyAgentClosureApprovalCoverage,
} from '../src/agent-capability-closure.js';
import { prepareGraphBoundAgentLeafBindingEntrySet } from '../src/agent-leaf-binding-entries.js';
import {
  mergeDependencyIntrinsicPolicyEvidence,
  prepareAgentRootBindingEntrySet,
} from '../src/agent-root-binding-entry-set.js';
import { prepareAgentRootResourceGraph } from '../src/agent-root-resource-graph.js';
import {
  canonicalEmptyCapabilityRequirementExpression,
  normalizeCapabilityRequirementExpression,
} from '../src/capability-policy.js';
import { canonicalBindingPath, canonicalResourceNodeId } from '../src/closure-identity.js';
import { prepareCompiledCapabilityClosure } from '../src/compiled-capability-closure.js';
import { deriveDependencyManifest } from '../src/dependency-manifest.js';
import { prepareExecutableSource } from '../src/executable-source.js';
import { canonicalSha256ExcludingRootKeys } from '../src/hash.js';
import { prepareLeafResourceSource } from '../src/leaf-resource-source.js';
import { preparePinnedDependencyGraph } from '../src/pinned-dependency-graph.js';
import { prepareRootBindingPaths } from '../src/root-binding-paths.js';
import { richAgentSource } from './executable-source-fixtures.js';
import { workspaceId } from './fixtures.js';
import { leafCandidate, record } from './leaf-resource-source-fixtures.js';

function candidate(document: unknown) {
  return { schema_version: 'executable-source-candidate/1', workspace_id: workspaceId, document };
}

function fixture(disabled = false, secondMount = false, approval = false) {
  const dependency = leafCandidate(
    secondMount ? 'KNOWLEDGE_INDEX_GENERATION' : 'PLUGIN_TOOL_RELEASE',
  );
  if (approval) {
    record(dependency.document.operation).approval_required = true;
    const operations = record(dependency.document.tool_list).operations;
    if (!Array.isArray(operations) || operations[0] === undefined) {
      throw new Error('fixture tool-list operation is missing');
    }
    record(operations[0]).approval_required = true;
  }
  const leaf = prepareLeafResourceSource(dependency);
  const agent = richAgentSource();
  const binding = agent.capability_bindings.find((item) =>
    secondMount ? item.kind === 'knowledge' : item.kind === 'plugin',
  );
  if (binding === undefined) throw new Error('fixture leaf Binding is missing');
  const manualHash = leaf.component_hashes.manual;
  if (manualHash === undefined) throw new Error('fixture manual hash is missing');
  const operation = record(dependency.document.operation);
  binding.pin = leaf.full_pin;
  binding.enabled = !disabled;
  binding.manual = {
    ...record(dependency.document.manual),
    hash: manualHash,
  } as typeof binding.manual;
  binding.input_schema = structuredClone(operation.input_schema) as typeof binding.input_schema;
  if (operation.output_schema === undefined) delete binding.output_schema;
  else {
    binding.output_schema = structuredClone(
      operation.output_schema,
    ) as typeof binding.output_schema;
  }
  binding.data_classification = 'internal';
  if (approval) {
    binding.side_effect = {
      ...binding.side_effect,
      approval: 'required',
      approval_gate_spec_id: 'approval',
    };
  }
  const credentials = record(dependency.document.requirements).credential_requirements as unknown[];
  if (credentials.length === 0) delete binding.credential_requirement;
  else {
    binding.credential_requirement = structuredClone(
      credentials[0],
    ) as typeof binding.credential_requirement;
  }
  if (binding.kind === 'plugin' && dependency.document.schema_version === 'plugin-tool-source/1') {
    const transportHash = leaf.component_hashes.transport;
    if (transportHash === undefined) throw new Error('fixture transport hash is missing');
    binding.config = {
      ...binding.config,
      provider_tool_name: String(dependency.document.provider_tool_name),
      operation_contract_hash: leaf.operation_contract.contract_hash,
      transport_contract_hash: transportHash,
    };
  } else if (
    binding.kind === 'knowledge' &&
    dependency.document.schema_version === 'knowledge-index-generation-source/1'
  ) {
    const metadataFilterPolicyHash = leaf.component_hashes.metadata_filter_policy;
    if (metadataFilterPolicyHash === undefined) {
      throw new Error('fixture metadata filter policy hash is missing');
    }
    binding.config = {
      ...binding.config,
      query_contract_hash: leaf.operation_contract.contract_hash,
      metadata_filter_policy_hash: metadataFilterPolicyHash,
    };
  } else {
    throw new Error('fixture leaf Binding kind mismatch');
  }
  const bindings = [binding];
  if (secondMount) {
    const second = structuredClone(binding);
    second.binding_id = 'knowledge-second';
    if (second.kind === 'knowledge' && second.config.selection === 'force') {
      second.config.forced_execution.order += 1;
    }
    bindings.push(second);
  }
  agent.capability_bindings = bindings;
  agent.strategy.allowed_capability_binding_ids = bindings.map((item) => item.binding_id);
  agent.strategy.allowed_gate_spec_ids = approval ? ['approval'] : [];
  agent.instruction_skill_bindings = [];
  agent.public_capability_handles = [];
  if (approval) {
    const gate = agent.gate_specs.find((item) => item.gate_spec_id === 'approval');
    if (gate === undefined) throw new Error('fixture approval GateSpec is missing');
    gate.protected_operation_contract_hashes = [leaf.operation_contract.contract_hash];
    agent.gate_specs = [gate];
  } else {
    agent.gate_specs = [];
  }
  const parsedAgent = AgentExecutableSourceV1Schema.safeParse(agent);
  if (!parsedAgent.success) throw new Error(JSON.stringify(parsedAgent.error.issues));
  const root = candidate(agent);
  const rootSource = prepareExecutableSource(root);
  const paths = prepareRootBindingPaths(root).bindings;
  const path = paths[0];
  if (path === undefined) throw new Error('fixture root path is missing');
  const requirements = leaf.intrinsic_policy;
  const ceiling = {
    schema_version: 'capability-policy-ceiling/1',
    credential_allowances: requirements.credential_requirements.map((item) => ({
      provider_id: item.provider_id,
      audience: item.audience,
      allowed_scopes: item.required_scopes,
      principal_modes: item.allowed_principal_modes,
    })),
    principal_modes: requirements.principal_modes,
    egress: requirements.egress,
    readable_data_classification_ceiling: 'restricted',
    output_data_classification: 'public',
    side_effect: { maximum_class: 'unsafe', approval: approval ? 'required' : 'none' },
    operation_contract_hashes: [leaf.operation_contract.contract_hash],
    max_calls: 100,
    max_depth: 100,
    max_parallelism: 100,
    budget: {
      schema_version: 'capability-budget/1',
      amount_credits: '1000000',
      input_tokens: 1000000,
      output_tokens: 1000000,
      total_tokens: 2000000,
      duration_ms: 1000000,
    },
  } as const;
  const policies = {
    schema_version: 'agent-leaf-binding-policy-input/1',
    workspace_ceiling: ceiling,
    root_ceiling: ceiling,
    binding_ceilings: paths.map((item) => ({ binding_path: item.binding_path, ceiling })),
  };
  const graphCandidate = {
    schema_version: 'pinned-dependency-graph-candidate/1' as const,
    root: { pin: rootSource.root.pin, semantic_seed_hash: rootSource.root.semantic_seed_hash },
    root_dependencies: rootSource.dependency_manifest.dependencies,
    resources: rootSource.dependency_manifest.dependencies.map((pin) => {
      const { contract_hash: _hash, binding_mode: _mode, ...owner } = pin;
      return {
        schema_version: 'pinned-dependency-record/1' as const,
        pin,
        publication_state: 'sealed' as const,
        dependency_manifest: deriveDependencyManifest(owner, []),
        ...(pin.published_resource_kind === 'AGENT_RELEASE' ||
        pin.published_resource_kind === 'FLOW_VERSION'
          ? { nested_closure_hash: pin.contract_hash }
          : {}),
      };
    }),
  };
  const graph = preparePinnedDependencyGraph(graphCandidate);
  const slice = prepareGraphBoundAgentLeafBindingEntrySet(
    graph,
    graphCandidate,
    root,
    [dependency],
    policies,
  );
  return { root, path, graph, graphCandidate, slice, policies, disabled };
}

function rootPolicy(value: ReturnType<typeof fixture>) {
  const allowNoPrincipal = (ceiling: typeof value.policies.root_ceiling) => ({
    ...ceiling,
    principal_modes: [...ceiling.principal_modes, 'none'],
  });
  return {
    ...value.policies,
    schema_version: 'agent-root-binding-policy-input/1',
    ...(value.disabled
      ? {
          workspace_ceiling: allowNoPrincipal(value.policies.workspace_ceiling),
          root_ceiling: allowNoPrincipal(value.policies.root_ceiling),
        }
      : {}),
  } as const;
}

describe('Agent root Binding entry-set assembly', () => {
  it('merges direct and recursively committed evidence for one shared leaf node', () => {
    const value = fixture(false, true);
    const direct = value.slice.prepared_entries.dependency_intrinsic_policies[0];
    if (direct === undefined) throw new Error('fixture direct dependency evidence is missing');
    const graphNode = value.graph.nodes.find((node) => node.node_id === direct.node_id);
    if (graphNode === undefined) throw new Error('fixture graph node is missing');
    const committed = {
      ...direct,
      dependency_manifest_hash: graphNode.dependency_manifest_hash,
    };
    expect(mergeDependencyIntrinsicPolicyEvidence(direct, committed)).toEqual(committed);
    expect(mergeDependencyIntrinsicPolicyEvidence(committed, direct)).toEqual(committed);
    const conflictingManifest = {
      ...committed,
      dependency_manifest_hash: `sha256:${'a'.repeat(64)}`,
    };
    const conflictingNested = { ...committed, nested_closure_hash: `sha256:${'a'.repeat(64)}` };
    const otherNested = { ...committed, nested_closure_hash: `sha256:${'b'.repeat(64)}` };
    expect(() => mergeDependencyIntrinsicPolicyEvidence(committed, conflictingManifest)).toThrow(
      'CLOSURE_BINDING_ENTRY_NOT_CLOSED',
    );
    expect(() => mergeDependencyIntrinsicPolicyEvidence(conflictingNested, otherNested)).toThrow(
      'CLOSURE_BINDING_ENTRY_NOT_CLOSED',
    );
    expect(() =>
      mergeDependencyIntrinsicPolicyEvidence(committed, {
        ...direct,
        pin: { ...direct.pin, resource_id: 'different-shared-leaf' },
      }),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
    expect(() =>
      mergeDependencyIntrinsicPolicyEvidence(committed, {
        ...direct,
        intrinsic_policy: canonicalEmptyCapabilityRequirementExpression(),
      }),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');

    const slices = value.slice.prepared_entries.entries.map((entry, index) => {
      const slice = structuredClone(value.slice);
      const expression = slice.prepared_entries.requirement_expressions.find(
        (item) => item.binding_path === entry.binding_path,
      );
      if (expression === undefined) throw new Error('fixture requirement expression is missing');
      (
        slice.prepared_entries as unknown as {
          entries: unknown[];
          requirement_expressions: unknown[];
        }
      ).entries = [entry];
      (
        slice.prepared_entries as unknown as { requirement_expressions: unknown[] }
      ).requirement_expressions = [expression];
      if (index === 1) {
        (
          slice.prepared_entries as unknown as {
            dependency_intrinsic_policies: unknown[];
          }
        ).dependency_intrinsic_policies = [committed];
      }
      return slice;
    });
    for (const orderedSlices of [slices, [...slices].reverse()]) {
      const result = prepareAgentRootBindingEntrySet(
        value.root,
        value.graph.graph_hash,
        orderedSlices,
        rootPolicy(value),
      );
      expect(result.entries).toHaveLength(2);
      expect(result.dependency_intrinsic_policies).toEqual([committed]);
    }
  });

  it('joins one exact graph-bound root namespace with retained intrinsic demand', () => {
    const value = fixture();
    const result = prepareAgentRootBindingEntrySet(
      value.root,
      value.graph.graph_hash,
      [value.slice],
      rootPolicy(value),
    );
    expect(result.entries).toEqual(value.slice.prepared_entries.entries);
    expect(result.requirement_expressions).toEqual(
      value.slice.prepared_entries.requirement_expressions,
    );
    expect(result.dependency_intrinsic_policies).toEqual(
      value.slice.prepared_entries.dependency_intrinsic_policies,
    );
    expect(result.disabled_binding_paths).toEqual([]);
    expect(result.graph_hash).toBe(value.graph.graph_hash);
    expect(result.intrinsic_policy).toEqual(result.requirement_expressions[0]?.expression);
    expect(result.aggregate_limits.operation_contract_hashes).toEqual(
      result.entries[0]?.operation_contracts.map((operation) => operation.contract_hash),
    );
  });

  it('joins multiple mounts in canonical path order without collapsing one shared target', () => {
    const value = fixture(false, true);
    const result = prepareAgentRootBindingEntrySet(
      value.root,
      value.graph.graph_hash,
      [value.slice],
      rootPolicy(value),
    );
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((entry) => entry.binding_path)).toEqual(
      [...result.entries.map((entry) => entry.binding_path)].sort(),
    );
    expect(result.requirement_expressions).toHaveLength(2);
    expect(result.dependency_intrinsic_policies).toHaveLength(1);
    expect(result.intrinsic_policy.expression_kind).toBe('alternative');
    if (result.intrinsic_policy.expression_kind !== 'alternative')
      throw new Error('expected alternative');
    expect(result.intrinsic_policy.children).toHaveLength(1);
  });

  it('retains a source-disabled root entry without adding intrinsic demand', () => {
    const value = fixture(true);
    const result = prepareAgentRootBindingEntrySet(
      value.root,
      value.graph.graph_hash,
      [value.slice],
      rootPolicy(value),
    );
    expect(result.entries).toHaveLength(1);
    expect(result.requirement_expressions).toEqual([]);
    expect(result.disabled_binding_paths).toEqual([value.path.binding_path]);
    expect(value.slice.prepared_entries.dependency_intrinsic_policies).toHaveLength(1);
    expect(result.dependency_intrinsic_policies).toEqual(
      value.slice.prepared_entries.dependency_intrinsic_policies,
    );
    expect(
      value.slice.prepared_entries.dependency_intrinsic_policies[0]?.intrinsic_policy,
    ).toMatchObject({ expression_kind: 'leaf' });
    expect(result.aggregate_limits).toMatchObject({
      principal_modes: ['none'],
      operation_contract_hashes: [],
    });
  });

  it('rejects a root aggregate ceiling that cannot carry the folded demand', () => {
    const value = fixture();
    const policy = rootPolicy(value);
    expect(() =>
      prepareAgentRootBindingEntrySet(value.root, value.graph.graph_hash, [value.slice], {
        ...policy,
        root_ceiling: { ...policy.root_ceiling, max_calls: 0 },
      }),
    ).toThrow('CLOSURE_POLICY_REQUIREMENT_UNAVAILABLE');
  });

  it('rejects missing, duplicate, and unknown slices', () => {
    const value = fixture();
    expect(() =>
      prepareAgentRootBindingEntrySet(value.root, value.graph.graph_hash, [], rootPolicy(value)),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
    expect(() =>
      prepareAgentRootBindingEntrySet(
        value.root,
        value.graph.graph_hash,
        [value.slice, value.slice],
        rootPolicy(value),
      ),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
    expect(() =>
      prepareAgentRootBindingEntrySet(
        value.root,
        value.graph.graph_hash,
        [{ ...value.slice, unexpected: true }],
        rootPolicy(value),
      ),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
  });

  it('does not accept a leaf entry through a composite slice discriminator', () => {
    const value = fixture();
    const prepared = value.slice.prepared_entries;
    const disguised = {
      schema_version: 'prepared-agent-composite-binding-entries/1',
      dependency_kind: 'FLOW_VERSION',
      graph_hash: value.graph.graph_hash,
      nested_closure_hash: `sha256:${'6'.repeat(64)}`,
      dependency_resource_node: {},
      entries: prepared.entries,
      requirement_expressions: prepared.requirement_expressions,
    };
    expect(() =>
      prepareAgentRootBindingEntrySet(
        value.root,
        value.graph.graph_hash,
        [disguised],
        rootPolicy(value),
      ),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
  });

  it('requires every slice to use the exact same verified graph hash', () => {
    const value = fixture();
    expect(() =>
      prepareAgentRootBindingEntrySet(
        value.root,
        `sha256:${'1'.repeat(64)}`,
        [value.slice],
        rootPolicy(value),
      ),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
    expect(() =>
      prepareAgentRootBindingEntrySet(
        value.root,
        value.graph.graph_hash,
        [{ ...value.slice, graph_hash: `sha256:${'2'.repeat(64)}` }],
        rootPolicy(value),
      ),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
  });

  it('rejects a slice prepared for a different root', () => {
    const value = fixture();
    const changed = structuredClone(value.slice);
    record(changed.prepared_entries.root).semantic_seed_hash = `sha256:${'3'.repeat(64)}`;
    expect(() =>
      prepareAgentRootBindingEntrySet(
        value.root,
        value.graph.graph_hash,
        [changed],
        rootPolicy(value),
      ),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
  });

  it('re-derives root entry target, config, source and dependency identities', () => {
    const value = fixture();
    for (const mutate of [
      (entry: Record<string, unknown>) => {
        entry.config_hash = `sha256:${'4'.repeat(64)}`;
      },
      (entry: Record<string, unknown>) => {
        entry.source_contract_hash = `sha256:${'5'.repeat(64)}`;
      },
      (entry: Record<string, unknown>) => {
        entry.dependency_node_ids = [`rn1.${'A'.repeat(43)}`];
      },
    ]) {
      const changed = structuredClone(value.slice);
      const entry = changed.prepared_entries.entries[0];
      if (entry === undefined) throw new Error('fixture entry is missing');
      mutate(record(entry));
      expect(() =>
        prepareAgentRootBindingEntrySet(
          value.root,
          value.graph.graph_hash,
          [changed],
          rootPolicy(value),
        ),
      ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
    }
  });

  it('re-derives every dependency policy node identity from its complete pin', () => {
    const value = fixture();
    const changed = structuredClone(value.slice);
    const evidence = changed.prepared_entries.dependency_intrinsic_policies[0];
    if (evidence === undefined) throw new Error('fixture policy evidence is missing');
    record(evidence).node_id = `rn1.${'A'.repeat(43)}`;
    expect(() =>
      prepareAgentRootBindingEntrySet(
        value.root,
        value.graph.graph_hash,
        [changed],
        rootPolicy(value),
      ),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
  });

  it('requires exactly one canonical requirement expression per enabled root path', () => {
    const value = fixture();
    for (const expressions of [
      [],
      [
        ...value.slice.prepared_entries.requirement_expressions,
        ...value.slice.prepared_entries.requirement_expressions,
      ],
    ]) {
      const changed = structuredClone(value.slice);
      record(changed.prepared_entries).requirement_expressions = expressions;
      expect(() =>
        prepareAgentRootBindingEntrySet(
          value.root,
          value.graph.graph_hash,
          [changed],
          rootPolicy(value),
        ),
      ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
    }
  });

  it('rejects noncanonical entry ordering within a prepared slice', () => {
    const value = fixture(false, true);
    const changed = structuredClone(value.slice);
    record(changed.prepared_entries).entries = [...changed.prepared_entries.entries].reverse();
    expect(() =>
      prepareAgentRootBindingEntrySet(
        value.root,
        value.graph.graph_hash,
        [changed],
        rootPolicy(value),
      ),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
  });

  it('returns a deeply frozen intermediate without claiming closure authority', () => {
    const value = fixture();
    const result = prepareAgentRootBindingEntrySet(
      value.root,
      value.graph.graph_hash,
      [value.slice],
      rootPolicy(value),
    );
    expect(result).not.toHaveProperty('closure_hash');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entries[0]?.effective_policy)).toBe(true);
    expect(Object.isFrozen(result.requirement_expressions[0]?.expression)).toBe(true);
    expect(Object.isFrozen(result.intrinsic_policy)).toBe(true);
    expect(Object.isFrozen(result.aggregate_limits)).toBe(true);
  });
});

describe('Agent root direct resource-graph assembly', () => {
  function prepared(disabled = false, secondMount = false) {
    const value = fixture(disabled, secondMount);
    const entrySet = prepareAgentRootBindingEntrySet(
      value.root,
      value.graph.graph_hash,
      [value.slice],
      rootPolicy(value),
    );
    return { ...value, entrySet };
  }

  it('assembles one canonical root node, direct dependency node, and Binding edge', () => {
    const value = prepared();
    const result = prepareAgentRootResourceGraph(value.graph, value.entrySet);
    expect(result.resource_nodes).toHaveLength(value.graph.nodes.length);
    expect(result.resource_nodes.find((node) => node.node_role === 'root')).toMatchObject({
      node_id: value.graph.root_node_id,
      intrinsic_policy: value.entrySet.intrinsic_policy,
    });
    expect(result.dependency_edges).toContainEqual({
      from_node_id: value.graph.root_node_id,
      to_node_id: value.entrySet.entries[0]?.dependency_node_ids[0],
      relation: 'binding_target',
      source_path: value.entrySet.entries[0]?.binding_path,
    });
    expect(
      result.dependency_edges.filter((edge) => edge.relation === 'binding_target'),
    ).toHaveLength(1);
    expect(
      result.dependency_edges.filter((edge) => edge.relation === 'typed_internal_dependency'),
    ).toHaveLength(value.graph.edges.length - 1);
    expect(
      result.dependency_edges
        .filter((edge) => edge.relation === 'typed_internal_dependency')
        .every(
          (edge) =>
            edge.source_path ===
            canonicalBindingPath([{ segment_kind: 'root', pin: value.entrySet.root.pin }]),
        ),
    ).toBe(true);
    const assemblyEdge = result.dependency_edges.find(
      (edge) => edge.relation === 'typed_internal_dependency',
    );
    expect(
      result.resource_nodes.find((node) => node.node_id === assemblyEdge?.to_node_id)
        ?.intrinsic_policy,
    ).toEqual(canonicalEmptyCapabilityRequirementExpression());
  });

  it('retains one dependency node but one provenance edge per shared-target mount', () => {
    const value = prepared(false, true);
    const result = prepareAgentRootResourceGraph(value.graph, value.entrySet);
    expect(result.resource_nodes).toHaveLength(value.graph.nodes.length);
    const bindingEdges = result.dependency_edges.filter(
      (edge) => edge.relation === 'binding_target',
    );
    expect(bindingEdges).toHaveLength(2);
    expect(new Set(bindingEdges.map((edge) => edge.to_node_id)).size).toBe(1);
  });

  it('keeps a disabled dependency node and edge as evidence without granting closure authority', () => {
    const value = prepared(true);
    const result = prepareAgentRootResourceGraph(value.graph, value.entrySet);
    expect(result.resource_nodes).toHaveLength(value.graph.nodes.length);
    expect(
      result.dependency_edges.filter((edge) => edge.relation === 'binding_target'),
    ).toHaveLength(1);
    expect(result).not.toHaveProperty('closure_hash');
    expect(Object.isFrozen(result.resource_nodes[1]?.intrinsic_policy)).toBe(true);
  });

  it('rejects graph hash drift and missing dependency policy evidence', () => {
    const value = prepared();
    expect(() =>
      prepareAgentRootResourceGraph(
        { ...value.graph, graph_hash: `sha256:${'9'.repeat(64)}` },
        value.entrySet,
      ),
    ).toThrow('CAPABILITY_GRAPH_HASH_MISMATCH');
    expect(() =>
      prepareAgentRootResourceGraph(value.graph, {
        ...value.entrySet,
        dependency_intrinsic_policies: [],
      }),
    ).toThrow('COMPILED_CAPABILITY_CLOSURE_INVALID');
  });

  it('rejects unknown graph fields, entry-set graph drift, and duplicate policy identities', () => {
    const value = prepared();
    expect(() =>
      prepareAgentRootResourceGraph({ ...value.graph, unexpected: true }, value.entrySet),
    ).toThrow('CAPABILITY_GRAPH_INPUT_INVALID');
    expect(() =>
      prepareAgentRootResourceGraph(value.graph, {
        ...value.entrySet,
        graph_hash: `sha256:${'8'.repeat(64)}`,
      }),
    ).toThrow('CAPABILITY_GRAPH_HASH_MISMATCH');
    expect(() =>
      prepareAgentRootResourceGraph(value.graph, {
        ...value.entrySet,
        dependency_intrinsic_policies: [
          ...value.entrySet.dependency_intrinsic_policies,
          ...value.entrySet.dependency_intrinsic_policies,
        ],
      }),
    ).toThrow('COMPILED_CAPABILITY_CLOSURE_INVALID');
    expect(() =>
      prepareAgentRootResourceGraph(value.graph, {
        ...value.entrySet,
        entries: [...value.entrySet.entries, ...value.entrySet.entries],
      }),
    ).toThrow('COMPILED_CAPABILITY_CLOSURE_INVALID');
  });

  it.each(['EXPERIENCE_RELEASE', 'SYSTEM_RELEASE'] as const)(
    'fails closed for an unclassified %s dependency instead of inventing zero demand',
    (publishedResourceKind) => {
      const value = prepared();
      const graphCandidate = structuredClone(value.graphCandidate);
      const firstEntry = value.entrySet.entries[0];
      if (firstEntry === undefined) throw new Error('fixture entry is missing');
      const pin = {
        ...firstEntry.target,
        published_resource_kind: publishedResourceKind,
        resource_id: '018f47f2-c541-7cc6-9292-4a2c35303e8a',
        resource_version_id: '018f47f2-c541-7cc6-9292-4a2c35303e8b',
      };
      const { contract_hash: _hash, binding_mode: _mode, ...owner } = pin;
      const resource = {
        schema_version: 'pinned-dependency-record/1',
        pin,
        publication_state: 'sealed',
        dependency_manifest: deriveDependencyManifest(owner, []),
      } as const;
      const graph = preparePinnedDependencyGraph({
        ...graphCandidate,
        root_dependencies: [...graphCandidate.root_dependencies, pin],
        resources: [...graphCandidate.resources, resource],
      });
      expect(() =>
        prepareAgentRootResourceGraph(graph, { ...value.entrySet, graph_hash: graph.graph_hash }),
      ).toThrow('COMPILED_CAPABILITY_CLOSURE_INVALID');
    },
  );

  it('fails closed on recursive graph edges until descendant provenance is joined', () => {
    const value = prepared();
    const graphCandidate = structuredClone(value.graphCandidate);
    const leaf = prepareLeafResourceSource(leafCandidate('KNOWLEDGE_INDEX_GENERATION'));
    const firstEntry = value.entrySet.entries[0];
    const parent = graphCandidate.resources.find(
      (resource) => resource.pin.contract_hash === firstEntry?.target.contract_hash,
    );
    if (parent === undefined) throw new Error('fixture direct dependency record is missing');
    const { contract_hash: _parentHash, binding_mode: _parentMode, ...parentOwner } = parent.pin;
    parent.dependency_manifest = deriveDependencyManifest(parentOwner, [leaf.full_pin]);
    const { contract_hash: _leafHash, binding_mode: _leafMode, ...leafOwner } = leaf.full_pin;
    graphCandidate.resources.push({
      schema_version: 'pinned-dependency-record/1',
      pin: leaf.full_pin,
      publication_state: 'sealed',
      dependency_manifest: deriveDependencyManifest(leafOwner, []),
    });
    const graph = preparePinnedDependencyGraph(graphCandidate);
    const leafPolicy = {
      node_id: canonicalResourceNodeId(leaf.full_pin),
      pin: leaf.full_pin,
      intrinsic_policy: {
        schema_version: 'capability-requirement-expression/1' as const,
        expression_kind: 'leaf' as const,
        requirements: leaf.intrinsic_policy,
      },
    };
    expect(() =>
      prepareAgentRootResourceGraph(graph, {
        ...value.entrySet,
        graph_hash: graph.graph_hash,
        dependency_intrinsic_policies: [
          ...value.entrySet.dependency_intrinsic_policies,
          leafPolicy,
        ].sort((left, right) => left.node_id.localeCompare(right.node_id)),
      }),
    ).toThrow('COMPILED_CAPABILITY_CLOSURE_INVALID');
  });
});

describe('non-recursive Agent capability closure assembly', () => {
  function prepared(disabled = false, approval = false) {
    const value = fixture(disabled, false, approval);
    const entrySet = prepareAgentRootBindingEntrySet(
      value.root,
      value.graph.graph_hash,
      [value.slice],
      rootPolicy(value),
    );
    return { ...value, entrySet };
  }

  it('seals and re-verifies the complete direct-leaf Agent closure', () => {
    const value = prepared();
    const result = prepareNonRecursiveAgentCapabilityClosure(
      value.root,
      value.graph,
      value.entrySet,
    );
    expect(result.root).toEqual(prepareExecutableSource(value.root).root);
    expect(result.assembly_pins).toEqual(
      prepareExecutableSource(value.root).dependency_manifest.dependencies,
    );
    expect(result.bindings).toEqual(value.entrySet.entries);
    expect(result.bindings[0]?.requirement_expression).toEqual(
      value.entrySet.requirement_expressions[0]?.expression,
    );
    expect(result.resource_nodes).toHaveLength(value.graph.nodes.length);
    expect(result.closure_hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('joins a required Binding to one exact same-root approval GateSpec', () => {
    const value = prepared(false, true);
    const result = prepareNonRecursiveAgentCapabilityClosure(
      value.root,
      value.graph,
      value.entrySet,
    );
    expect(result.bindings[0]?.approval_gate_spec).toEqual({
      gate_spec_id: 'approval',
      gate_spec_hash: result.gate_specs[0]?.gate_spec_hash,
    });
    expect(result.gate_specs[0]?.protected_operation_contract_hashes).toEqual([
      result.bindings[0]?.operation_contracts[0]?.contract_hash,
    ]);
  });

  it.each([
    ['unknown id', { gate_spec_id: 'other', gate_spec_hash: undefined }],
    ['wrong hash', { gate_spec_id: undefined, gate_spec_hash: `sha256:${'f'.repeat(64)}` }],
  ])('rejects a required Binding with %s instead of its exact GateSpec', (_name, drift) => {
    const value = prepared(false, true);
    const entry = value.entrySet.entries[0];
    if (entry?.approval_gate_spec === undefined) throw new Error('fixture approval is missing');
    const entrySet = structuredClone(value.entrySet);
    const mutable = entrySet.entries[0];
    if (mutable?.approval_gate_spec === undefined) throw new Error('fixture approval is missing');
    mutable.approval_gate_spec = {
      gate_spec_id: drift.gate_spec_id ?? entry.approval_gate_spec.gate_spec_id,
      gate_spec_hash: drift.gate_spec_hash ?? entry.approval_gate_spec.gate_spec_hash,
    };
    expect(() =>
      prepareNonRecursiveAgentCapabilityClosure(value.root, value.graph, entrySet),
    ).toThrow('COMPILED_CAPABILITY_CLOSURE_INVALID');
  });

  it('rejects a required Binding when its exact Gate omits the protected operation', () => {
    const value = prepared(false, true);
    const result = prepareNonRecursiveAgentCapabilityClosure(
      value.root,
      value.graph,
      value.entrySet,
    );
    const graph = prepareAgentRootResourceGraph(value.graph, value.entrySet);
    const gates = structuredClone(result.gate_specs);
    const gate = gates[0];
    if (gate === undefined) throw new Error('fixture approval Gate is missing');
    gate.protected_operation_contract_hashes = [`sha256:${'f'.repeat(64)}`];
    expect(() => verifyAgentClosureApprovalCoverage(result.bindings, gates, graph)).toThrow(
      'COMPILED_CAPABILITY_CLOSURE_INVALID',
    );

    const wrongSource = structuredClone(result.gate_specs);
    const dependencyNode = graph.resource_nodes.find((node) => node.node_role === 'dependency');
    if (wrongSource[0] === undefined || dependencyNode === undefined) {
      throw new Error('fixture Gate source dependency is missing');
    }
    wrongSource[0].source_node_id = dependencyNode.node_id;
    expect(() => verifyAgentClosureApprovalCoverage(result.bindings, wrongSource, graph)).toThrow(
      'COMPILED_CAPABILITY_CLOSURE_INVALID',
    );

    const wrongKind = structuredClone(result.gate_specs);
    if (wrongKind[0] === undefined) throw new Error('fixture Gate is missing');
    (wrongKind[0] as unknown as { source_kind: string }).source_kind = 'flow_node';
    expect(() =>
      verifyAgentClosureApprovalCoverage(
        result.bindings,
        wrongKind as typeof result.gate_specs,
        graph,
      ),
    ).toThrow('COMPILED_CAPABILITY_CLOSURE_INVALID');
  });

  it('retains disabled Binding evidence without granting aggregate authority', () => {
    const value = prepared(true);
    const result = prepareNonRecursiveAgentCapabilityClosure(
      value.root,
      value.graph,
      value.entrySet,
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.disabled_binding_paths).toEqual(value.entrySet.disabled_binding_paths);
    expect(result.aggregate_limits).toMatchObject({
      principal_modes: ['none'],
      operation_contract_hashes: [],
    });
  });

  it('rejects a valid graph and entry set that belong to a different Agent source', () => {
    const value = prepared();
    const otherFixture = fixture(false, true);
    const otherEntrySet = prepareAgentRootBindingEntrySet(
      otherFixture.root,
      otherFixture.graph.graph_hash,
      [otherFixture.slice],
      rootPolicy(otherFixture),
    );
    expect(() =>
      prepareNonRecursiveAgentCapabilityClosure(value.root, otherFixture.graph, otherEntrySet),
    ).toThrow('COMPILED_CAPABILITY_CLOSURE_INVALID');
  });

  it('rejects a noncanonical Binding requirement and an enabled demand above its policy limit', () => {
    const value = prepared();
    const valid = prepareNonRecursiveAgentCapabilityClosure(
      value.root,
      value.graph,
      value.entrySet,
    );
    const binding = valid.bindings[0];
    if (binding === undefined || binding.requirement_expression.expression_kind !== 'leaf') {
      throw new Error('fixture leaf Binding requirement is missing');
    }
    const canonical = normalizeCapabilityRequirementExpression({
      schema_version: 'capability-requirement-expression/1',
      expression_kind: 'alternative',
      children: [binding.requirement_expression, canonicalEmptyCapabilityRequirementExpression()],
    });
    if (canonical.expression_kind !== 'alternative') throw new Error('expected alternative');
    const noncanonicalDraft = {
      ...valid,
      bindings: [
        {
          ...binding,
          requirement_expression: { ...canonical, children: [...canonical.children].reverse() },
        },
      ],
    };
    expect(() =>
      prepareCompiledCapabilityClosure({
        ...noncanonicalDraft,
        closure_hash: canonicalSha256ExcludingRootKeys(noncanonicalDraft, ['closure_hash']),
      }),
    ).toThrow('COMPILED_CAPABILITY_CLOSURE_INVALID');

    const excessiveDraft = {
      ...valid,
      bindings: [
        {
          ...binding,
          requirement_expression: {
            ...binding.requirement_expression,
            requirements: {
              ...binding.requirement_expression.requirements,
              minimum_limits: {
                ...binding.requirement_expression.requirements.minimum_limits,
                calls: binding.effective_policy.max_calls + 1,
              },
            },
          },
        },
      ],
    };
    expect(() =>
      prepareCompiledCapabilityClosure({
        ...excessiveDraft,
        closure_hash: canonicalSha256ExcludingRootKeys(excessiveDraft, ['closure_hash']),
      }),
    ).toThrow('CLOSURE_POLICY_REQUIREMENT_UNAVAILABLE');
  });
});
