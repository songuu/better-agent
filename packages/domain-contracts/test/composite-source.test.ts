import { describe, expect, it } from 'vitest';
import {
  SkillPackSourceV1Schema,
  StrategyModelPolicyV1Schema,
  StrategySandboxProfileV1Schema,
  domainContractSchemaRegistry,
} from '../src/index.js';

const id = '10000000-0000-4000-8000-000000000001';
const hash = `sha256:${'a'.repeat(64)}`;
const model = {
  descriptor_id: 'primary',
  provider_id: 'provider',
  model_id: 'chat',
  model_revision: 'v1',
  model_contract_hash: hash,
};
function policy() {
  return {
    schema_version: 'strategy-model-policy/1',
    models: [model],
    maximum_input_tokens: 10,
    maximum_output_tokens: 10,
  };
}
function pack() {
  return {
    schema_version: 'skill-pack-source/1',
    resource_id: id,
    resource_version_id: id,
    manual: { description: 'Pack' },
    input_schema: {},
    member_bindings: [
      {
        binding_id: 'member',
        kind: 'plugin',
        enabled: true,
        discoverability: 'model_selectable',
        manual: { description: 'Member', hash },
        input_schema: {},
        data_classification: 'public',
        side_effect: { class: 'safe', approval: 'none' },
        task_safe: false,
        mock_safe: false,
        retry: {},
        timeout_ms: 1000,
        budget: {},
        pin: {
          workspace_id: id,
          published_resource_kind: 'PLUGIN_TOOL_RELEASE',
          resource_id: id,
          resource_version_id: id,
          contract_hash: hash,
          binding_mode: 'pinned',
        },
        config: {
          schema_version: 'plugin-binding/1',
          operation_contract_hash: hash,
          transport_contract_hash: hash,
          provider_tool_name: 'lookup',
          default_parameters: {},
        },
      },
    ],
    exposures: [
      {
        exposed_operation_id: 'search',
        member_binding_id: 'member',
        member_operation_id: 'lookup',
        operation: {
          schema_version: 'operation-contract-source/1',
          operation_kind: 'plugin_tool',
          operation_id: 'lookup',
          input_schema: {},
          side_effect_class: 'safe',
          operation_key_required: false,
          approval_required: false,
        },
      },
    ],
  };
}

describe('Strategy and Skill Pack structural source contracts', () => {
  it.each([
    'agent-strategy-source/1',
    'agent-strategy-source-candidate/1',
    'skill-pack-source/1',
    'skill-pack-source-candidate/1',
  ])('registers closed %s sources', (schema_version) => {
    expect(
      domainContractSchemaRegistry
        .schemaFor(schema_version)
        .safeParse({ schema_version, secret: 'forbidden' }).success,
    ).toBe(false);
  });
  it('bounds complete model descriptors and rejects duplicates/floating revisions/extra fields', () => {
    const input = policy();
    expect(StrategyModelPolicyV1Schema.safeParse(input).success).toBe(true);
    input.models = Array.from({ length: 128 }, (_, i) => ({ ...model, descriptor_id: `m${i}` }));
    expect(StrategyModelPolicyV1Schema.safeParse(input).success).toBe(true);
    expect(
      StrategyModelPolicyV1Schema.safeParse({
        ...input,
        models: [...input.models, { ...model, descriptor_id: 'extra' }],
      }).success,
    ).toBe(false);
    for (const models of [
      [model, model],
      [{ ...model, model_revision: 'LATEST' }],
      [{ ...model, model_revision: 'floating_latest' }],
      [{ ...model, fallback: true }],
    ])
      expect(StrategyModelPolicyV1Schema.safeParse({ ...policy(), models }).success).toBe(false);
    for (const maximum_input_tokens of [-1, 1_000_001, 0.5])
      expect(
        StrategyModelPolicyV1Schema.safeParse({ ...policy(), maximum_input_tokens }).success,
      ).toBe(false);
  });
  it('requires an explicitly deny-all bounded sandbox declaration', () => {
    const sandbox = {
      schema_version: 'strategy-sandbox-profile/1',
      profile_id: 'isolated/1',
      host_abi: 'agent-strategy-abi/1',
      network: 'deny',
      filesystem: 'deny',
      database: 'deny',
      secrets: 'deny',
      maximum_memory_bytes: 1_073_741_824,
      maximum_instruction_count: 1_000_000_000,
    };
    expect(StrategySandboxProfileV1Schema.safeParse(sandbox).success).toBe(true);
    for (const patch of [
      { network: 'allow' },
      { filesystem: 'read_only' },
      { database: 'allow' },
      { secrets: 'allow' },
      { maximum_memory_bytes: 1_073_741_825 },
      { maximum_instruction_count: 1_000_000_001 },
      { maximum_memory_bytes: 0 },
      { ambient_tools: [] },
    ])
      expect(StrategySandboxProfileV1Schema.safeParse({ ...sandbox, ...patch }).success).toBe(
        false,
      );
  });
  it('requires nonempty bounded unique member and exposure sets', () => {
    const input = pack();
    expect(SkillPackSourceV1Schema.safeParse(input).success).toBe(true);
    const member = input.member_bindings[0];
    const exposure = input.exposures[0];
    if (member === undefined || exposure === undefined) throw new Error('fixture missing');
    for (const patch of [
      { member_bindings: [] },
      { exposures: [] },
      { member_bindings: [member, member] },
      { exposures: [exposure, exposure] },
      {
        exposures: Array.from({ length: 129 }, (_, i) => ({
          ...exposure,
          exposed_operation_id: `op${i}`,
        })),
      },
      {
        member_bindings: Array.from({ length: 129 }, (_, i) => ({
          ...member,
          binding_id: `b${i}`,
        })),
      },
    ])
      expect(SkillPackSourceV1Schema.safeParse({ ...input, ...patch }).success).toBe(false);
    expect(
      SkillPackSourceV1Schema.safeParse({
        ...input,
        exposures: Array.from({ length: 128 }, (_, i) => ({
          ...exposure,
          exposed_operation_id: `op${i}`,
        })),
        member_bindings: Array.from({ length: 128 }, (_, i) => ({
          ...member,
          binding_id: `b${i}`,
        })),
      }).success,
    ).toBe(true);
  });
  it('does not accept projections/discovery instead of complete typed source declarations', () => {
    const input = pack();
    for (const patch of [
      { member_projection_hash: hash },
      { runtime_discovery: true },
      { exposures: [{ operation_contract_hash: hash }] },
      { member_bindings: [{ binding_id: 'member', kind: 'runtime_tool' }] },
      { manual: { description: 'Pack', hash } },
    ])
      expect(SkillPackSourceV1Schema.safeParse({ ...input, ...patch }).success).toBe(false);
  });
});
