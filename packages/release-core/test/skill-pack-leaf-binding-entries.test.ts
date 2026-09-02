import { CompiledBindingEntryV1Schema } from '@better-agent/domain-contracts';
import { describe, expect, it } from 'vitest';

import { canonicalResourceNodeId } from '../src/closure-identity.js';
import { canonicalSha256 } from '../src/hash.js';
import { prepareLeafResourceSource } from '../src/leaf-resource-source.js';
import { prepareAgentSkillPackDependencyPaths } from '../src/root-binding-paths.js';
import { prepareSkillPackLeafBindingEntrySet } from '../src/skill-pack-leaf-binding-entries.js';
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
});
