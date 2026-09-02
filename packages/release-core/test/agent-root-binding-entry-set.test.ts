import { AgentExecutableSourceV1Schema } from '@better-agent/domain-contracts';
import { describe, expect, it } from 'vitest';

import { prepareGraphBoundAgentLeafBindingEntrySet } from '../src/agent-leaf-binding-entries.js';
import { prepareAgentRootBindingEntrySet } from '../src/agent-root-binding-entry-set.js';
import { deriveDependencyManifest } from '../src/dependency-manifest.js';
import { prepareExecutableSource } from '../src/executable-source.js';
import { prepareLeafResourceSource } from '../src/leaf-resource-source.js';
import { preparePinnedDependencyGraph } from '../src/pinned-dependency-graph.js';
import { prepareRootBindingPaths } from '../src/root-binding-paths.js';
import { richAgentSource } from './executable-source-fixtures.js';
import { workspaceId } from './fixtures.js';
import { leafCandidate, record } from './leaf-resource-source-fixtures.js';

function candidate(document: unknown) {
  return { schema_version: 'executable-source-candidate/1', workspace_id: workspaceId, document };
}

function fixture(disabled = false, secondMount = false) {
  const dependency = leafCandidate(
    secondMount ? 'KNOWLEDGE_INDEX_GENERATION' : 'PLUGIN_TOOL_RELEASE',
  );
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
  agent.strategy.allowed_gate_spec_ids = [];
  agent.instruction_skill_bindings = [];
  agent.public_capability_handles = [];
  agent.gate_specs = [];
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
    side_effect: { maximum_class: 'unsafe', approval: 'none' },
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
  return { root, path, graph, slice, policies, disabled };
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
