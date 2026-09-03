import { describe, expect, it, vi } from 'vitest';
import {
  prepareSkillPackSource as prepare,
  verifySkillPackSource as verify,
  verifySkillPackBinding,
  verifySkillPackBindings,
  prepareCapabilityBindingSource,
  canonicalSha256,
  prepareOperationContractSource,
} from '../src/index.js';
import { richAgentSource } from './executable-source-fixtures.js';
import { put, record } from './leaf-resource-source-fixtures.js';
import { skillPackSource as source } from './skill-pack-source-fixtures.js';
import {
  agentId,
  agentReleaseId,
  workspaceId,
  otherWorkspaceId,
  hashA,
  hashB,
} from './fixtures.js';

function packBinding(input: ReturnType<typeof source>) {
  const result = prepare(input);
  const binding = record(
    structuredClone(
      richAgentSource().capability_bindings.find((item) => item.kind === 'skill_pack'),
    ),
  );
  binding.pin = structuredClone(result.full_pin);
  binding.manual = { ...input.document.manual, hash: result.component_hashes.manual };
  binding.input_schema = input.document.input_schema;
  binding.output_schema = input.document.output_schema;
  binding.config = {
    schema_version: 'skill-pack-binding/1',
    member_projection_hash: result.member_projection_hash,
    exposed_operations: result.exposed_operations.map((item) => ({
      exposed_operation_id: item.exposed_operation_id,
      exposed_operation_contract_hash: item.exposed_operation_contract_hash,
    })),
  };
  return binding;
}

function strongSource() {
  const input = source();
  const member = record(input.document.member_bindings[0]);
  const exposure = input.document.exposures[0];
  if (exposure === undefined) throw new Error('fixture missing exposure');
  Object.assign(record(exposure.operation), {
    side_effect_class: 'requires_key',
    operation_key_required: true,
    approval_required: true,
  });
  member.side_effect = {
    class: 'requires_key',
    approval: 'required',
    approval_gate_spec_id: 'approval',
    operation_key_source: 'request',
  };
  member.data_classification = 'confidential';
  put(
    member,
    ['config', 'operation_contract_hash'],
    prepareOperationContractSource(exposure.operation).pin.contract_hash,
  );
  return input;
}
function strongBinding(input: ReturnType<typeof source>) {
  const binding = packBinding(input);
  binding.side_effect = {
    class: 'requires_key',
    approval: 'required',
    approval_gate_spec_id: 'approval',
    operation_key_source: 'request',
  };
  binding.data_classification = 'confidential';
  return binding;
}

describe('Skill Pack immutable source projection', () => {
  it('binds complete members, exact operation mappings and every direct target to a pack pin', () => {
    const input = source();
    const result = prepare(input);
    expect(result.preimage).toEqual({
      schema_version: 'skill-pack-source-preimage/1',
      compiler_version: 'capability-compiler/1',
      canonicalizer_version: 'rfc8785/1',
      workspace_id: workspaceId,
      published_resource_kind: 'SKILL_PACK_RELEASE',
      document: result.document,
    });
    expect(result.full_pin.contract_hash).toBe(canonicalSha256(result.preimage));
    expect(result.dependency_manifest.dependencies).toEqual([
      input.document.member_bindings[0]?.pin,
    ]);
    expect(result.exposed_operations[0]).toMatchObject({
      exposed_operation_id: 'search',
      member_binding_id: 'lookup-member',
      member_operation_id: 'lookup',
      member_target: input.document.member_bindings[0]?.pin,
    });
    expect(result.member_projection_hash).toBe(canonicalSha256(result.member_projection));
    expect(verify(result, input)).toEqual(result);
    expect(verifySkillPackBinding(packBinding(input), input)).toEqual(result);
    expect(Object.isFrozen(result.document.member_bindings)).toBe(true);
  });

  it('verifies a unique Binding set against one Pack and rejects a bad non-first Binding', () => {
    const input = source();
    const first = packBinding(input);
    const second = structuredClone(first);
    second.binding_id = 'pack-second';
    expect(verifySkillPackBindings([first, second], input)).toEqual(prepare(input));
    record(second.config).member_projection_hash = hashB;
    expect(() => verifySkillPackBindings([first, second], input)).toThrow(
      'CLOSURE_SOURCE_MISMATCH',
    );
  });

  it('rejects duplicate and empty Binding verification sets', () => {
    const input = source();
    const binding = packBinding(input);
    expect(() => verifySkillPackBindings([], input)).toThrow('CLOSURE_SOURCE_MISMATCH');
    expect(() => verifySkillPackBindings([binding, binding], input)).toThrow(
      'CLOSURE_SOURCE_MISMATCH',
    );
  });

  it.each([
    [
      'missing member',
      ['exposures', '0', 'member_binding_id'],
      'missing',
      'SKILL_PACK_OPERATION_UNRESOLVED',
    ],
    [
      'member operation',
      ['exposures', '0', 'member_operation_id'],
      'other',
      'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
    ],
    [
      'member input',
      ['exposures', '0', 'operation', 'input_schema'],
      {},
      'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
    ],
    [
      'disabled member',
      ['member_bindings', '0', 'enabled'],
      false,
      'SKILL_PACK_OPERATION_UNRESOLVED',
    ],
    [
      'cross Workspace',
      ['member_bindings', '0', 'pin', 'workspace_id'],
      otherWorkspaceId,
      'CLOSURE_SOURCE_INVALID',
    ],
    [
      'floating pin',
      ['member_bindings', '0', 'pin', 'binding_mode'],
      'latest',
      'CLOSURE_SOURCE_INVALID',
    ],
    ['discovery field', ['runtime_discovery'], true, 'CLOSURE_SOURCE_INVALID'],
    ['fake projection', ['member_projection_hash'], hashA, 'CLOSURE_SOURCE_INVALID'],
  ])('rejects %s without accepting unresolved operation routes', (_label, path, value, code) => {
    const input = source();
    put(input.document, path as string[], value);
    expect(() => prepare(input)).toThrow(code as string);
  });

  it('rejects duplicate member/exposure identities and self-version dependencies', () => {
    const input = source();
    input.document.member_bindings.push(structuredClone(record(input.document.member_bindings[0])));
    expect(() => prepare(input)).toThrow('CLOSURE_SOURCE_INVALID');
    const duplicate = source();
    const firstExposure = duplicate.document.exposures[0];
    if (firstExposure === undefined) throw new Error('fixture missing exposure');
    duplicate.document.exposures.push(structuredClone(firstExposure));
    expect(() => prepare(duplicate)).toThrow('CLOSURE_SOURCE_INVALID');
    const self = source();
    const member = record(self.document.member_bindings[0]);
    Object.assign(member, {
      kind: 'skill_pack',
      pin: {
        workspace_id: workspaceId,
        published_resource_kind: 'SKILL_PACK_RELEASE',
        resource_id: agentId,
        resource_version_id: agentReleaseId,
        contract_hash: hashA,
        binding_mode: 'pinned',
      },
      config: {
        schema_version: 'skill-pack-binding/1',
        exposed_operations: [],
        member_projection_hash: hashA,
      },
    });
    expect(() => prepare(self)).toThrow('CAPABILITY_DEPENDENCY_CYCLE');
  });

  it('includes disabled/unexposed targets and canonicalizes member and exposure sets', () => {
    const input = source();
    const member = structuredClone(record(input.document.member_bindings[0]));
    member.binding_id = 'another';
    member.enabled = false;
    input.document.member_bindings.push(member);
    const prepared = prepare(input);
    input.document.member_bindings.reverse();
    expect(prepare(input)).toEqual(prepared);
    expect(prepared.document.member_bindings).toHaveLength(2);
    expect(prepared.dependency_manifest.dependencies).toHaveLength(1);
    put(input.document, ['manual', 'description'], 'new manual');
    expect(() => verify(prepared, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
  });

  it('verifies complete projection artifacts rather than a self-reported hash', () => {
    const input = source();
    const result = prepare(input);
    for (const patch of [
      { exposed_operations: [] },
      { member_projection: {} },
      { member_projection_hash: hashB },
      { dependency_manifest: {} },
      { component_hashes: {} },
      { extra: true },
    ])
      expect(() => verify({ ...result, ...patch }, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
  });

  it('rejects Binding target/manual/envelope/projection/exposure drift', () => {
    const input = source();
    for (const [path, value] of [
      [['pin', 'contract_hash'], hashB],
      [['manual', 'description'], 'other'],
      [['input_schema'], {}],
      [['output_schema'], {}],
      [['config', 'member_projection_hash'], hashA],
      [['config', 'exposed_operations', '0', 'exposed_operation_id'], 'other'],
      [['config', 'exposed_operations', '0', 'exposed_operation_contract_hash'], hashA],
      [['config', 'exposed_operations'], []],
    ] as [string[], unknown][]) {
      const binding = packBinding(input);
      put(binding, path, value);
      expect(() => verifySkillPackBinding(binding, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
    }
  });

  it('supports nested packs through explicit member exposed IDs, never name discovery', () => {
    const child = source();
    const childPrepared = prepare(child);
    const nestedBinding = packBinding(child);
    const parent = source();
    parent.document.resource_version_id = '018f47f2-c541-7cc6-9292-4a2c35303e99';
    nestedBinding.binding_id = 'nested';
    parent.document.member_bindings = [nestedBinding];
    const exposure = parent.document.exposures[0];
    if (exposure === undefined) throw new Error('fixture missing exposure');
    exposure.member_binding_id = 'nested';
    exposure.member_operation_id = 'search';
    expect(prepare(parent).dependency_manifest.dependencies).toEqual([childPrepared.full_pin]);
    put(exposure.operation, ['input_schema', 'title'], 'changed operation, same alias');
    expect(() => prepare(parent)).toThrow('SKILL_PACK_OPERATION_UNRESOLVED');
    delete record(record(exposure.operation).input_schema).title;
    exposure.member_operation_id = 'unknown';
    expect(() => prepare(parent)).toThrow('SKILL_PACK_OPERATION_UNRESOLVED');
  });

  it('reuses the closed canonical Binding source boundary without mutation', () => {
    const input = source();
    const binding = input.document.member_bindings[0];
    const original = structuredClone(binding);
    const result = prepareCapabilityBindingSource(workspaceId, binding);
    expect(binding).toEqual(original);
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => prepareCapabilityBindingSource(otherWorkspaceId, binding)).toThrow(
      'CLOSURE_SOURCE_INVALID',
    );
  });

  it.each([
    [['side_effect', 'class'], 'safe'],
    [['side_effect'], { class: 'requires_key', approval: 'none', operation_key_source: 'request' }],
    [['side_effect'], { class: 'unsafe', approval: 'required', approval_gate_spec_id: 'approval' }],
    [['data_classification'], 'internal'],
  ] as [string[], unknown][])(
    'does not launder selected member restrictions at %j',
    (path, value) => {
      const input = strongSource();
      const binding = strongBinding(input);
      expect(verifySkillPackBinding(binding, input)).toEqual(prepare(input));
      put(binding, path, value);
      expect(() => verifySkillPackBinding(binding, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
    },
  );

  it.each(['approval', 'key'])(
    'retains member-added %s even when the operation does not require it',
    (guard) => {
      const input = source();
      const member = record(input.document.member_bindings[0]);
      member.side_effect =
        guard === 'key'
          ? { class: 'safe', approval: 'none', operation_key_source: 'request' }
          : { class: 'safe', approval: 'required', approval_gate_spec_id: 'approval' };
      const binding = packBinding(input);
      binding.side_effect = structuredClone(member.side_effect);
      expect(verifySkillPackBinding(binding, input)).toEqual(prepare(input));
      binding.side_effect = { class: 'safe', approval: 'none' };
      expect(() => verifySkillPackBinding(binding, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
    },
  );

  it('requires an operation key source for a Binding that strengthens its class to requires_key', () => {
    const input = source();
    const binding = packBinding(input);
    binding.side_effect = { class: 'requires_key', approval: 'none' };
    expect(() => verifySkillPackBinding(binding, input)).toThrow('CLOSURE_SOURCE_INVALID');
    put(binding, ['side_effect', 'operation_key_source'], 'generated');
    expect(verifySkillPackBinding(binding, input)).toEqual(prepare(input));
  });

  it('rejects a nested requires_key declaration without a key source before mapping its operations', () => {
    const child = source();
    const nested = packBinding(child);
    nested.binding_id = 'nested';
    nested.side_effect = { class: 'requires_key', approval: 'none' };
    const parent = source();
    parent.document.resource_version_id = workspaceId;
    parent.document.member_bindings = [nested];
    put(parent.document, ['exposures', '0', 'member_binding_id'], 'nested');
    put(parent.document, ['exposures', '0', 'member_operation_id'], 'search');
    expect(() => prepare(parent)).toThrow('CLOSURE_SOURCE_INVALID');
    put(nested, ['side_effect', 'operation_key_source'], 'request');
    expect(() => prepare(parent)).not.toThrow();
  });

  it.each(['effect', 'key', 'approval'])(
    'checks a nested member against the known operation %s floor',
    (guard) => {
      const child = source();
      const nested = packBinding(child);
      nested.binding_id = 'nested';
      const parent = source();
      parent.document.resource_version_id = workspaceId;
      parent.document.member_bindings = [nested];
      put(parent.document, ['exposures', '0', 'member_binding_id'], 'nested');
      put(parent.document, ['exposures', '0', 'member_operation_id'], 'search');
      const operation = record(parent.document.exposures[0]?.operation);
      operation.side_effect_class = 'unsafe';
      operation.operation_key_required = true;
      operation.approval_required = true;
      put(
        nested,
        ['config', 'exposed_operations', '0', 'exposed_operation_contract_hash'],
        prepareOperationContractSource(operation).pin.contract_hash,
      );
      nested.side_effect = {
        class: 'unsafe',
        approval: 'required',
        approval_gate_spec_id: 'approval',
        operation_key_source: 'request',
      };
      expect(() => prepare(parent)).not.toThrow();
      if (guard === 'effect') put(nested, ['side_effect', 'class'], 'safe');
      if (guard === 'key') delete record(nested.side_effect).operation_key_source;
      if (guard === 'approval')
        nested.side_effect = { class: 'unsafe', approval: 'none', operation_key_source: 'request' };
      expect(() => prepare(parent)).toThrow('CAPABILITY_OPERATION_CONTRACT_MISMATCH');
    },
  );

  it('allows exact subsets while preserving unselected members and their dependency identities', () => {
    const input = source();
    const member = structuredClone(record(input.document.member_bindings[0]));
    member.binding_id = 'second';
    put(member, ['pin', 'resource_version_id'], workspaceId);
    const first = input.document.exposures[0];
    if (first === undefined) throw new Error('fixture exposure missing');
    input.document.member_bindings.push(member);
    input.document.exposures.push({
      ...structuredClone(first),
      exposed_operation_id: 'second-search',
      member_binding_id: 'second',
    });
    const prepared = prepare(input);
    const binding = packBinding(input);
    input.document.member_bindings.reverse();
    input.document.exposures.reverse();
    expect(prepare(input)).toEqual(prepared);
    const config = record(binding.config);
    const operations = config.exposed_operations;
    if (!Array.isArray(operations)) throw new Error('fixture operations missing');
    config.exposed_operations = operations.slice(1);
    expect(verifySkillPackBinding(binding, input).dependency_manifest.dependencies).toHaveLength(2);
    config.exposed_operations = [];
    expect(() => verifySkillPackBinding(binding, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
    binding.enabled = false;
    expect(verifySkillPackBinding(binding, input)).toEqual(prepared);
  });

  it('projects each distinct member pin and complete operation, and checks restrictions on the second selection', () => {
    const input = source();
    const stronger = strongSource();
    const second = record(stronger.document.member_bindings[0]);
    second.binding_id = 'second';
    put(second, ['pin', 'resource_version_id'], workspaceId);
    const operation = structuredClone(stronger.document.exposures[0]?.operation);
    put(operation, ['operation_id'], 'second-lookup');
    const operationPin = prepareOperationContractSource(operation).pin;
    put(second, ['config', 'provider_tool_name'], 'second-lookup');
    put(second, ['config', 'operation_contract_hash'], operationPin.contract_hash);
    input.document.member_bindings.push(second);
    input.document.exposures.push({
      exposed_operation_id: 'z-second',
      member_binding_id: 'second',
      member_operation_id: 'second-lookup',
      operation,
    });
    const result = prepare(input);
    expect(result.exposed_operations).toEqual(
      input.document.exposures.map((exposure) => {
        const member = input.document.member_bindings.find(
          (item) => item.binding_id === exposure.member_binding_id,
        );
        const pin = prepareOperationContractSource(exposure.operation).pin;
        return {
          exposed_operation_id: exposure.exposed_operation_id,
          exposed_operation_contract_hash: pin.contract_hash,
          member_binding_id: exposure.member_binding_id,
          member_operation_id: exposure.member_operation_id,
          member_target: member?.pin,
          member_operation_contract: pin,
        };
      }),
    );
    const binding = strongBinding(input);
    expect(verifySkillPackBinding(binding, input)).toEqual(result);
    binding.data_classification = 'internal';
    expect(() => verifySkillPackBinding(binding, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
    // The first selected operation remains valid, so checking only it cannot explain the rejection.
    const operations = record(binding.config).exposed_operations;
    if (!Array.isArray(operations)) throw new Error('fixture operations missing');
    record(binding.config).exposed_operations = operations.slice(0, 1);
    expect(verifySkillPackBinding(binding, input)).toEqual(result);
  });

  it.each([
    [['manual', 'input_description'], 'envelope docs'],
    [['input_schema', 'title'], 'envelope input'],
    [['output_schema', 'title'], 'envelope output'],
    [['member_bindings', '0', 'manual', 'description'], 'member docs'],
    [['member_bindings', '0', 'pin', 'contract_hash'], hashB],
    [['member_bindings', '0', 'config', 'default_parameters'], { limit: 4 }],
    [['member_bindings', '0', 'data_classification'], 'restricted'],
    [['exposures', '0', 'exposed_operation_id'], 'new-id'],
  ] as [string[], unknown][])('binds complete source bodies at %j', (path, value) => {
    const input = source();
    const result = prepare(input);
    put(input.document, path, value);
    expect(prepare(input).full_pin.contract_hash).not.toBe(result.full_pin.contract_hash);
    expect(() => verify(result, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
  });

  it('rejects output omission drift and alternate full target identities', () => {
    const input = source();
    const binding = packBinding(input);
    delete binding.output_schema;
    expect(() => verifySkillPackBinding(binding, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
    const withoutOutput = source();
    delete record(withoutOutput.document).output_schema;
    const outputless = packBinding(withoutOutput);
    delete outputless.output_schema;
    expect(verifySkillPackBinding(outputless, withoutOutput)).toEqual(prepare(withoutOutput));
    for (const [field, value, code] of [
      ['resource_id', workspaceId, 'CLOSURE_SOURCE_MISMATCH'],
      ['resource_version_id', workspaceId, 'CLOSURE_SOURCE_MISMATCH'],
      ['workspace_id', otherWorkspaceId, 'CLOSURE_SOURCE_INVALID'],
    ] as const) {
      const changed = packBinding(input);
      put(changed, ['pin', field], value);
      expect(() => verifySkillPackBinding(changed, input)).toThrow(code);
    }
  });

  it('rejects hash-conflicting versions even when the additional member is disabled and unexposed', () => {
    const input = source();
    const member = structuredClone(record(input.document.member_bindings[0]));
    member.binding_id = 'disabled';
    member.enabled = false;
    put(member, ['pin', 'contract_hash'], hashB);
    input.document.member_bindings.push(member);
    expect(() => prepare(input)).toThrow('RELEASE_DEPENDENCY_INVALID');
  });

  it('does not invoke hostile accessors/proxies or silently lose JSON keys', () => {
    const input = source();
    const trap = vi.fn();
    Object.defineProperty(input.document, 'manual', { get: trap, enumerable: true });
    expect(() => prepare(input)).toThrow('CLOSURE_SOURCE_INVALID');
    const valid = source();
    const proxy = new Proxy({}, { get: trap, ownKeys: trap });
    expect(() => verify(proxy, valid)).toThrow('CLOSURE_SOURCE_INVALID');
    expect(() => verifySkillPackBinding(proxy, valid)).toThrow('CLOSURE_SOURCE_INVALID');
    put(
      valid.document,
      ['member_bindings', '0', 'input_schema'],
      JSON.parse('{"__proto__":{"lost":true}}'),
    );
    expect(() => prepare(valid)).toThrow('CLOSURE_SOURCE_INVALID');
    expect(trap).not.toHaveBeenCalled();
  });

  it('rejects output expansion after a legal input and permits large independent round trips', () => {
    const input = source();
    // Each normalized member body appears three times in the artifact, independently of raw-input limits.
    put(
      input.document,
      ['member_bindings', '0', 'config', 'default_parameters'],
      Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`k${i}`, 'a'.repeat(65_536)])),
    );
    const prepared = prepare(input);
    expect(verify(prepared, input)).toEqual(prepared);
    put(
      input.document,
      ['member_bindings', '0', 'config', 'default_parameters', 'overflow'],
      'a'.repeat(65_536),
    );
    // Raise the aggregate above 8 MiB while every scalar remains within its own limit.
    for (let i = 36; i < 43; i++)
      put(
        input.document,
        ['member_bindings', '0', 'config', 'default_parameters', `k${i}`],
        'a'.repeat(65_536),
      );
    expect(() => prepare(input)).toThrow('CLOSURE_SOURCE_LIMIT_EXCEEDED');
    expect(verify(prepare(source()), source())).toEqual(prepare(source()));
  });
});
