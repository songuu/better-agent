import { CompiledBindingEntryV1Schema } from '@better-agent/domain-contracts';
import { describe, expect, it } from 'vitest';

import { canonicalResourceNodeId } from '../src/closure-identity.js';
import { deriveDependencyManifest, publishedResourcePinKey } from '../src/dependency-manifest.js';
import { prepareExecutableSource } from '../src/executable-source.js';
import { canonicalSha256 } from '../src/hash.js';
import { prepareLeafResourceSource } from '../src/leaf-resource-source.js';
import { preparePinnedDependencyGraph } from '../src/pinned-dependency-graph.js';
import { prepareAgentSkillPackDependencyPaths } from '../src/root-binding-paths.js';
import {
  prepareGraphBoundSkillPackLeafBindingEntrySet,
  prepareSkillPackLeafBindingEntrySet,
} from '../src/skill-pack-leaf-binding-entries.js';
import { prepareSkillPackSource } from '../src/skill-pack-source.js';
import { richAgentSource } from './executable-source-fixtures.js';
import { workspaceId } from './fixtures.js';
import { leafCandidate } from './leaf-resource-source-fixtures.js';
import { skillPackSource } from './skill-pack-source-fixtures.js';

function candidate(document: unknown) {
  return { schema_version: 'executable-source-candidate/1', workspace_id: workspaceId, document };
}

function fixture(options: { secondMount?: boolean; selectExposure?: boolean } = {}) {
  const leafInput = leafCandidate();
  const leaf = prepareLeafResourceSource(leafInput);
  const packInput = skillPackSource();
  const pack = prepareSkillPackSource(packInput);
  const agent = richAgentSource();
  const packBinding = agent.capability_bindings.find((item) => item.kind === 'skill_pack');
  if (packBinding === undefined || packBinding.kind !== 'skill_pack')
    throw new Error('fixture Pack Binding is missing');
  packBinding.pin = pack.full_pin;
  packBinding.manual = { ...pack.document.manual, hash: pack.component_hashes.manual };
  packBinding.input_schema = pack.document.input_schema;
  packBinding.output_schema = pack.document.output_schema;
  packBinding.config = {
    schema_version: 'skill-pack-binding/1',
    member_projection_hash: pack.member_projection_hash,
    exposed_operations:
      options.selectExposure === false
        ? []
        : pack.exposed_operations.map((operation) => ({
            exposed_operation_id: operation.exposed_operation_id,
            exposed_operation_contract_hash: operation.exposed_operation_contract_hash,
          })),
  };
  const directLeafBinding = agent.capability_bindings.find((item) => item.kind === 'plugin');
  const packMember = pack.document.member_bindings[0];
  if (directLeafBinding === undefined || packMember === undefined)
    throw new Error('fixture direct leaf Binding is missing');
  Object.assign(directLeafBinding, structuredClone(packMember), { binding_id: 'plugin' });
  if (options.selectExposure === false) packBinding.enabled = false;
  if (options.secondMount) {
    const second = structuredClone(packBinding);
    second.binding_id = 'pack-second';
    agent.capability_bindings.push(second);
    agent.strategy.allowed_capability_binding_ids.push(second.binding_id);
  }
  const root = candidate(agent);
  const paths = prepareAgentSkillPackDependencyPaths(root, packInput);
  const requirements = leaf.intrinsic_policy;
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
  const mounted = paths.bindings.filter((binding) => binding.members.length > 0);
  const policies = {
    schema_version: 'skill-pack-leaf-binding-policy-input/1',
    workspace_ceiling: ceiling,
    root_ceiling: ceiling,
    pack_binding_ceilings: mounted.map((binding) => ({
      binding_path: binding.binding_path,
      ceiling,
    })),
    member_binding_ceilings: mounted.flatMap((binding) =>
      binding.members.map((member) => ({
        binding_path: member.member_binding_path,
        ceiling,
      })),
    ),
  };
  return { agent, root, packInput, pack, packBinding, leafInput, leaf, paths, policies, ceiling };
}

function graphFixture() {
  const value = fixture({ secondMount: true });
  const root = prepareExecutableSource(value.root);
  const records = new Map<string, Record<string, unknown>>();
  for (const pin of root.dependency_manifest.dependencies) {
    const { contract_hash: _hash, binding_mode: _mode, ...owner } = pin;
    const dependencyManifest =
      publishedResourcePinKey(pin) === publishedResourcePinKey(value.pack.full_pin)
        ? value.pack.dependency_manifest
        : deriveDependencyManifest(owner, []);
    records.set(publishedResourcePinKey(pin), {
      schema_version: 'pinned-dependency-record/1',
      pin,
      publication_state: 'sealed',
      dependency_manifest: dependencyManifest,
      ...(pin.published_resource_kind === 'AGENT_RELEASE' ||
      pin.published_resource_kind === 'FLOW_VERSION'
        ? { nested_closure_hash: canonicalSha256({ pin }) }
        : {}),
    });
  }
  if (!records.has(publishedResourcePinKey(value.leaf.full_pin))) {
    const { contract_hash: _hash, binding_mode: _mode, ...owner } = value.leaf.full_pin;
    records.set(publishedResourcePinKey(value.leaf.full_pin), {
      schema_version: 'pinned-dependency-record/1',
      pin: value.leaf.full_pin,
      publication_state: 'sealed',
      dependency_manifest: deriveDependencyManifest(owner, []),
    });
  }
  const graphCandidate = {
    schema_version: 'pinned-dependency-graph-candidate/1' as const,
    root: { pin: root.root.pin, semantic_seed_hash: root.root.semantic_seed_hash },
    root_dependencies: root.dependency_manifest.dependencies,
    resources: [...records.values()],
  };
  return {
    ...value,
    rootSource: root,
    graphCandidate,
    graph: preparePinnedDependencyGraph(graphCandidate),
  };
}

describe('Skill Pack leaf Binding entry assembly', () => {
  it('assembles a complete member entry from the verified Pack and leaf source', () => {
    const value = fixture();
    const result = prepareSkillPackLeafBindingEntrySet(
      value.root,
      value.packInput,
      [value.leafInput],
      value.policies,
    );
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    const member = value.pack.document.member_bindings[0];
    const memberPath = value.paths.bindings.find((binding) => binding.members.length > 0)
      ?.members[0];
    expect(CompiledBindingEntryV1Schema.safeParse(entry).success).toBe(true);
    expect(entry).toMatchObject({
      binding_path: memberPath?.member_binding_path,
      binding_path_segments: memberPath?.member_binding_path_segments,
      binding_id: member?.binding_id,
      binding_kind: member?.kind,
      target: value.leaf.full_pin,
      config_schema_version: member?.config.schema_version,
      config_hash: canonicalSha256(member?.config),
      source_contract_hash: value.leaf.full_pin.contract_hash,
      operation_contracts: [value.leaf.operation_contract],
      dependency_node_ids: [canonicalResourceNodeId(value.leaf.full_pin)],
    });
  });

  it('meets Workspace, root, Pack-mount and member ceilings', () => {
    const value = fixture();
    const minimumCalls = value.leaf.intrinsic_policy.minimum_limits.calls;
    const policies = {
      ...value.policies,
      pack_binding_ceilings: value.policies.pack_binding_ceilings.map((item, index) =>
        index === 0 ? { ...item, ceiling: { ...value.ceiling, max_calls: minimumCalls } } : item,
      ),
    };
    const result = prepareSkillPackLeafBindingEntrySet(
      value.root,
      value.packInput,
      [value.leafInput],
      policies,
    );
    expect(result.entries[0]?.effective_policy.max_calls).toBe(minimumCalls);
  });

  it('isolates two Pack mounts while reusing one verified leaf source', () => {
    const value = fixture({ secondMount: true });
    const result = prepareSkillPackLeafBindingEntrySet(
      value.root,
      value.packInput,
      [value.leafInput],
      value.policies,
    );
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.binding_path).not.toBe(result.entries[1]?.binding_path);
    expect(result.leaf_dependencies).toEqual([value.leaf.full_pin]);
  });

  it('requires an exact unique leaf source set', () => {
    const value = fixture();
    expect(() =>
      prepareSkillPackLeafBindingEntrySet(value.root, value.packInput, [], value.policies),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
    expect(() =>
      prepareSkillPackLeafBindingEntrySet(
        value.root,
        value.packInput,
        [value.leafInput, value.leafInput],
        value.policies,
      ),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
    expect(() =>
      prepareSkillPackLeafBindingEntrySet(
        value.root,
        value.packInput,
        [value.leafInput, leafCandidate('KNOWLEDGE_INDEX_GENERATION')],
        value.policies,
      ),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
  });

  it('requires exact path-keyed Pack and member ceiling sets', () => {
    const value = fixture();
    expect(() =>
      prepareSkillPackLeafBindingEntrySet(value.root, value.packInput, [value.leafInput], {
        ...value.policies,
        pack_binding_ceilings: [],
      }),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
    expect(() =>
      prepareSkillPackLeafBindingEntrySet(value.root, value.packInput, [value.leafInput], {
        ...value.policies,
        member_binding_ceilings: [
          ...value.policies.member_binding_ceilings,
          value.policies.member_binding_ceilings[0],
        ],
      }),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
  });

  it('fails closed when any path ceiling cannot satisfy the leaf demand', () => {
    const value = fixture();
    const policies = {
      ...value.policies,
      member_binding_ceilings: value.policies.member_binding_ceilings.map((item, index) =>
        index === 0
          ? { ...item, ceiling: { ...value.ceiling, operation_contract_hashes: [] } }
          : item,
      ),
    };
    expect(() =>
      prepareSkillPackLeafBindingEntrySet(value.root, value.packInput, [value.leafInput], policies),
    ).toThrow('CLOSURE_POLICY_REQUIREMENT_UNAVAILABLE');
  });

  it('marks disabled Pack member paths unavailable without erasing their entries', () => {
    const value = fixture({ selectExposure: false });
    const result = prepareSkillPackLeafBindingEntrySet(
      value.root,
      value.packInput,
      [value.leafInput],
      value.policies,
    );
    expect(result.entries).toHaveLength(1);
    expect(result.policy_disabled_binding_paths).toEqual([result.entries[0]?.binding_path]);
  });

  it('returns canonical deeply frozen intermediate evidence without closure authority', () => {
    const value = fixture();
    const result = prepareSkillPackLeafBindingEntrySet(
      value.root,
      value.packInput,
      [value.leafInput],
      value.policies,
    );
    expect(result).not.toHaveProperty('closure_hash');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entries[0]?.effective_policy)).toBe(true);
  });

  it('seals Agent to Pack and Pack to every unique leaf in one graph snapshot', () => {
    const value = graphFixture();
    const result = prepareGraphBoundSkillPackLeafBindingEntrySet(
      value.graph,
      value.graphCandidate,
      value.root,
      value.packInput,
      [value.leafInput],
      value.policies,
    );
    expect(result.graph_hash).toBe(value.graph.graph_hash);
    expect(result.prepared_entries.entries).toHaveLength(2);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('rejects a leaf that is direct from Agent but not from its Pack', () => {
    const value = graphFixture();
    const packRecord = value.graphCandidate.resources.find(
      (record) =>
        publishedResourcePinKey(record.pin as never) ===
        publishedResourcePinKey(value.pack.full_pin),
    );
    if (packRecord === undefined) throw new Error('missing Pack record');
    const { contract_hash: _hash, binding_mode: _mode, ...owner } = value.pack.full_pin;
    packRecord.dependency_manifest = deriveDependencyManifest(owner, []);
    value.graphCandidate.root_dependencies = [
      ...value.graphCandidate.root_dependencies,
      value.leaf.full_pin,
    ];
    const graph = preparePinnedDependencyGraph(value.graphCandidate);
    expect(() =>
      prepareGraphBoundSkillPackLeafBindingEntrySet(
        graph,
        value.graphCandidate,
        value.root,
        value.packInput,
        [value.leafInput],
        value.policies,
      ),
    ).toThrow();
  });

  it('rejects graph manifests that differ from the prepared Agent or Pack sources', () => {
    const value = graphFixture();
    const changed = structuredClone(value.graphCandidate);
    const unrelated = {
      ...value.leaf.full_pin,
      resource_id: '33333333-3333-4333-8333-333333333333',
      resource_version_id: '44444444-4444-4444-8444-444444444444',
    };
    const { contract_hash: _hash, binding_mode: _mode, ...owner } = unrelated;
    changed.root_dependencies = [...changed.root_dependencies, unrelated];
    changed.resources.push({
      schema_version: 'pinned-dependency-record/1',
      pin: unrelated,
      publication_state: 'sealed',
      dependency_manifest: deriveDependencyManifest(owner, []),
    });
    const graph = preparePinnedDependencyGraph(changed);
    expect(() =>
      prepareGraphBoundSkillPackLeafBindingEntrySet(
        graph,
        changed,
        value.root,
        value.packInput,
        [value.leafInput],
        value.policies,
      ),
    ).toThrow();
  });

  it('rejects a Pack graph manifest with an extra dependency despite retaining the leaf edge', () => {
    const value = graphFixture();
    const changed = structuredClone(value.graphCandidate);
    const unrelated = {
      ...value.leaf.full_pin,
      resource_id: '55555555-5555-4555-8555-555555555555',
      resource_version_id: '66666666-6666-4666-8666-666666666666',
    };
    const { contract_hash: _hash, binding_mode: _mode, ...owner } = unrelated;
    changed.resources.push({
      schema_version: 'pinned-dependency-record/1',
      pin: unrelated,
      publication_state: 'sealed',
      dependency_manifest: deriveDependencyManifest(owner, []),
    });
    const packRecord = changed.resources.find(
      (record) =>
        publishedResourcePinKey(record.pin as never) ===
        publishedResourcePinKey(value.pack.full_pin),
    );
    if (packRecord === undefined) throw new Error('missing Pack record');
    const { contract_hash: _packHash, binding_mode: _packMode, ...packOwner } = value.pack.full_pin;
    packRecord.dependency_manifest = deriveDependencyManifest(packOwner, [
      value.leaf.full_pin,
      unrelated,
    ]);
    const graph = preparePinnedDependencyGraph(changed);
    expect(() =>
      prepareGraphBoundSkillPackLeafBindingEntrySet(
        graph,
        changed,
        value.root,
        value.packInput,
        [value.leafInput],
        value.policies,
      ),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
  });
});
