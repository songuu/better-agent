import { CompiledBindingEntryV1Schema } from '@better-agent/domain-contracts';
import { describe, expect, it } from 'vitest';

import { canonicalResourceNodeId } from '../src/closure-identity.js';
import { canonicalSha256 } from '../src/hash.js';
import {
  prepareAgentLeafBindingEntries,
  prepareAgentLeafBindingEntrySet,
  prepareGraphBoundAgentLeafBindingEntrySet,
} from '../src/agent-leaf-binding-entries.js';
import { deriveDependencyManifest, publishedResourcePinKey } from '../src/dependency-manifest.js';
import { prepareExecutableSource } from '../src/executable-source.js';
import { prepareLeafResourceSource } from '../src/leaf-resource-source.js';
import { prepareRootBindingPaths } from '../src/root-binding-paths.js';
import { preparePinnedDependencyGraph } from '../src/pinned-dependency-graph.js';
import { richAgentSource } from './executable-source-fixtures.js';
import { workspaceId } from './fixtures.js';
import { leafCandidate, record, type LeafKind } from './leaf-resource-source-fixtures.js';

function candidate(document: unknown) {
  return { schema_version: 'executable-source-candidate/1', workspace_id: workspaceId, document };
}

function fixture(kind: LeafKind = 'PLUGIN_TOOL_RELEASE') {
  const dependency = leafCandidate(kind);
  const prepared = prepareLeafResourceSource(dependency);
  const bindingKind = {
    KNOWLEDGE_INDEX_GENERATION: 'knowledge',
    DATABASE_OPERATION_RELEASE: 'database',
    PLUGIN_TOOL_RELEASE: 'plugin',
    A2A_AGENT_RELEASE: 'subagent',
  }[kind];
  const agent = richAgentSource();
  const binding = record(agent.capability_bindings.find((item) => item.kind === bindingKind));
  const document = dependency.document;
  binding.pin = prepared.full_pin;
  binding.manual = { ...record(document.manual), hash: prepared.component_hashes.manual };
  binding.input_schema = structuredClone(record(document.operation).input_schema);
  binding.output_schema = structuredClone(record(document.operation).output_schema);
  binding.data_classification = 'internal';
  const credentials = record(document.requirements).credential_requirements as unknown[];
  if (credentials.length > 0) binding.credential_requirement = structuredClone(credentials[0]);
  else delete binding.credential_requirement;
  const config = record(binding.config);
  if (bindingKind === 'knowledge') {
    config.query_contract_hash = prepared.operation_contract.contract_hash;
    config.metadata_filter_policy_hash = prepared.component_hashes.metadata_filter_policy;
  }
  if (bindingKind === 'plugin') {
    config.operation_contract_hash = prepared.operation_contract.contract_hash;
    config.provider_tool_name = document.provider_tool_name;
    config.transport_contract_hash = prepared.component_hashes.transport;
  }
  if (bindingKind === 'database') {
    config.operation_contract_hash = prepared.operation_contract.contract_hash;
    config.table_revision_ids = [record(document.table).table_revision_id];
    config.allowed_tables = [
      { table_revision_id: record(document.table).table_revision_id, columns: ['title'] },
    ];
    config.max_rows = 20;
  }
  if (bindingKind === 'subagent') binding.target_kind = 'external_a2a';
  const root = candidate(agent);
  const path = prepareRootBindingPaths(root).bindings.find(
    (item) => item.binding_id === binding.binding_id,
  );
  if (path === undefined) throw new Error('missing fixture path');
  const requirements = prepared.intrinsic_policy;
  const ceiling = {
    schema_version: 'capability-policy-ceiling/1',
    credential_allowances: requirements.credential_requirements.map((item) => ({
      provider_id: item.provider_id,
      audience: item.audience,
      allowed_scopes: [...item.required_scopes, 'extra'].sort(),
      principal_modes: [...item.allowed_principal_modes],
    })),
    principal_modes: [...requirements.principal_modes],
    egress: [...requirements.egress],
    readable_data_classification_ceiling: 'restricted',
    output_data_classification: 'public',
    side_effect: { maximum_class: 'unsafe', approval: 'none' },
    operation_contract_hashes: [prepared.operation_contract.contract_hash],
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
    binding_ceilings: [{ binding_path: path.binding_path, ceiling }],
  };
  return { root, agent, binding, dependency, prepared, path, policies };
}

describe('Agent leaf compiled Binding entry assembly', () => {
  it.each([
    'KNOWLEDGE_INDEX_GENERATION',
    'DATABASE_OPERATION_RELEASE',
    'PLUGIN_TOOL_RELEASE',
    'A2A_AGENT_RELEASE',
  ] as const)('assembles one closed %s root Binding entry', (kind) => {
    const value = fixture(kind);
    const result = prepareAgentLeafBindingEntries(value.root, value.dependency, value.policies);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    const normalizedBinding = (
      prepareExecutableSource(value.root).preimage.document as unknown as {
        capability_bindings: typeof value.agent.capability_bindings;
      }
    ).capability_bindings.find((item) => item.binding_id === value.binding.binding_id);
    if (normalizedBinding === undefined) throw new Error('missing normalized fixture Binding');
    expect(CompiledBindingEntryV1Schema.safeParse(entry).success).toBe(true);
    expect(entry).toMatchObject({
      binding_path: value.path.binding_path,
      binding_path_segments: value.path.binding_path_segments,
      binding_id: value.binding.binding_id,
      binding_kind: value.binding.kind,
      target: value.prepared.full_pin,
      config_schema_version: record(value.binding.config).schema_version,
      config_hash: canonicalSha256(normalizedBinding.config),
      source_contract_hash: value.prepared.full_pin.contract_hash,
      operation_contracts: [value.prepared.operation_contract],
      dependency_node_ids: [canonicalResourceNodeId(value.prepared.full_pin)],
    });
  });

  it('meets all three ceilings and resolves the complete intrinsic demand', () => {
    const value = fixture();
    const narrow = {
      ...value.policies.root_ceiling,
      max_calls: value.prepared.intrinsic_policy.minimum_limits.calls,
      credential_allowances: value.policies.root_ceiling.credential_allowances.map((item) => ({
        ...item,
        allowed_scopes: item.allowed_scopes.filter((scope) => scope !== 'extra'),
      })),
    };
    const result = prepareAgentLeafBindingEntries(value.root, value.dependency, {
      ...value.policies,
      root_ceiling: narrow,
    });
    expect(result.entries[0]?.effective_policy.max_calls).toBe(narrow.max_calls);
    expect(result.entries[0]?.effective_policy.operation_contract_hashes).toEqual([
      value.prepared.operation_contract.contract_hash,
    ]);
  });

  it('requires an exact path-keyed Binding ceiling set', () => {
    const value = fixture();
    expect(() =>
      prepareAgentLeafBindingEntries(value.root, value.dependency, {
        ...value.policies,
        binding_ceilings: [],
      }),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
    expect(() =>
      prepareAgentLeafBindingEntries(value.root, value.dependency, {
        ...value.policies,
        binding_ceilings: [...value.policies.binding_ceilings, value.policies.binding_ceilings[0]],
      }),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
  });

  it('fails closed when any ceiling cannot satisfy intrinsic requirements', () => {
    const value = fixture();
    const bindingCeiling = value.policies.binding_ceilings[0];
    if (bindingCeiling === undefined) throw new Error('missing fixture Binding ceiling');
    expect(() =>
      prepareAgentLeafBindingEntries(value.root, value.dependency, {
        ...value.policies,
        binding_ceilings: [
          {
            ...bindingCeiling,
            ceiling: { ...bindingCeiling.ceiling, operation_contract_hashes: [] },
          },
        ],
      }),
    ).toThrow('CLOSURE_POLICY_REQUIREMENT_UNAVAILABLE');
  });

  it('does not compile a policy-mandated approval without a source-covered GateSpec', () => {
    const value = fixture();
    expect(() =>
      prepareAgentLeafBindingEntries(value.root, value.dependency, {
        ...value.policies,
        root_ceiling: {
          ...value.policies.root_ceiling,
          side_effect: { maximum_class: 'unsafe', approval: 'required' },
        },
      }),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
  });

  it('seals async external A2A child policy and omits it for non-child Bindings', () => {
    const child = fixture('A2A_AGENT_RELEASE');
    const childEntry = prepareAgentLeafBindingEntries(child.root, child.dependency, child.policies)
      .entries[0];
    expect(childEntry?.async_child_policy_hash).toBe(
      canonicalSha256(record(child.binding.config).async_child),
    );
    const plugin = fixture();
    expect(
      prepareAgentLeafBindingEntries(plugin.root, plugin.dependency, plugin.policies).entries[0],
    ).not.toHaveProperty('async_child_policy_hash');
  });

  it('returns canonical path order, deep freeze, and no closure authority', () => {
    const value = fixture();
    const result = prepareAgentLeafBindingEntries(value.root, value.dependency, value.policies);
    expect(result).not.toHaveProperty('closure_hash');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entries[0]?.effective_policy)).toBe(true);
  });
});

describe('complete Agent root leaf Binding entry set', () => {
  function mountedTwice() {
    const value = fixture('KNOWLEDGE_INDEX_GENERATION');
    const second = structuredClone(value.binding);
    second.binding_id = 'knowledge-second';
    if (second.kind === 'knowledge' && record(second.config).selection === 'force') {
      const forced = record(record(second.config).forced_execution);
      forced.order = Number(forced.order) + 1;
    }
    value.agent.capability_bindings = [
      value.binding,
      second,
    ] as unknown as typeof value.agent.capability_bindings;
    value.agent.strategy.allowed_capability_binding_ids = [
      'knowledge-second',
      String(value.binding.binding_id),
    ];
    value.agent.instruction_skill_bindings = [];
    value.agent.public_capability_handles = [];
    const root = candidate(value.agent);
    const paths = prepareRootBindingPaths(root).bindings;
    const policies = {
      ...value.policies,
      binding_ceilings: paths.map((path) => ({
        binding_path: path.binding_path,
        ceiling: value.policies.workspace_ceiling,
      })),
    };
    return { ...value, root, paths, policies };
  }

  function graphFixture() {
    const value = mountedTwice();
    const source = prepareExecutableSource(value.root);
    const resources = source.dependency_manifest.dependencies.map((pin) => {
      const { contract_hash: _hash, binding_mode: _mode, ...owner } = pin;
      return {
        schema_version: 'pinned-dependency-record/1' as const,
        pin,
        publication_state: 'sealed' as const,
        dependency_manifest: deriveDependencyManifest(owner, []),
        ...(pin.published_resource_kind === 'AGENT_RELEASE' ||
        pin.published_resource_kind === 'FLOW_VERSION'
          ? { nested_closure_hash: value.prepared.full_pin.contract_hash }
          : {}),
      };
    });
    const graphCandidate = {
      schema_version: 'pinned-dependency-graph-candidate/1' as const,
      root: { pin: source.root.pin, semantic_seed_hash: source.root.semantic_seed_hash },
      root_dependencies: source.dependency_manifest.dependencies,
      resources,
    };
    return {
      ...value,
      source,
      graphCandidate,
      graph: preparePinnedDependencyGraph(graphCandidate),
    };
  }

  it('assembles all mounts of one verified leaf dependency in canonical path order', () => {
    const value = mountedTwice();
    const result = prepareAgentLeafBindingEntrySet(value.root, [value.dependency], value.policies);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((entry) => entry.binding_path)).toEqual(
      [...value.paths.map((path) => path.binding_path)].sort(),
    );
    expect(result.dependencies).toEqual([value.prepared.full_pin]);
    expect(Object.isFrozen(result.entries)).toBe(true);
    expect(result).not.toHaveProperty('closure_hash');
  });

  it('rejects missing, duplicate, and unrelated dependency candidates', () => {
    const value = mountedTwice();
    expect(() => prepareAgentLeafBindingEntrySet(value.root, [], value.policies)).toThrow(
      'CLOSURE_BINDING_ENTRY_NOT_CLOSED',
    );
    expect(() =>
      prepareAgentLeafBindingEntrySet(
        value.root,
        [value.dependency, value.dependency],
        value.policies,
      ),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
    expect(() =>
      prepareAgentLeafBindingEntrySet(
        value.root,
        [value.dependency, leafCandidate('PLUGIN_TOOL_RELEASE')],
        value.policies,
      ),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
  });

  it('requires the policy ceiling set to equal the complete leaf path set', () => {
    const value = mountedTwice();
    expect(() =>
      prepareAgentLeafBindingEntrySet(value.root, [value.dependency], {
        ...value.policies,
        binding_ceilings: value.policies.binding_ceilings.slice(0, 1),
      }),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
  });

  it('binds the complete set to the source manifest and every direct graph edge', () => {
    const value = graphFixture();
    const result = prepareGraphBoundAgentLeafBindingEntrySet(
      value.graph,
      value.graphCandidate,
      value.root,
      [value.dependency],
      value.policies,
    );
    expect(result.graph_hash).toBe(value.graph.graph_hash);
    expect(result.prepared_entries.entries).toHaveLength(2);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('rejects a leaf that exists in the graph only as a transitive dependency', () => {
    const value = graphFixture();
    const leafKey = publishedResourcePinKey(value.prepared.full_pin);
    const direct = value.graphCandidate.root_dependencies.filter(
      (pin) => publishedResourcePinKey(pin) !== leafKey,
    );
    const parent = value.graphCandidate.resources.find(
      (record) => publishedResourcePinKey(record.pin) !== leafKey,
    );
    if (parent === undefined) throw new Error('missing graph parent fixture');
    const { contract_hash: _hash, binding_mode: _mode, ...owner } = parent.pin;
    parent.dependency_manifest = deriveDependencyManifest(owner, [value.prepared.full_pin]);
    const transitiveCandidate = { ...value.graphCandidate, root_dependencies: direct };
    const transitiveGraph = preparePinnedDependencyGraph(transitiveCandidate);
    expect(() =>
      prepareGraphBoundAgentLeafBindingEntrySet(
        transitiveGraph,
        transitiveCandidate,
        value.root,
        [value.dependency],
        value.policies,
      ),
    ).toThrow();
  });
});
