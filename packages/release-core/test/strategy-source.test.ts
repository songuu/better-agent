import { describe, expect, it, vi } from 'vitest';
import { safeParseDomainContract } from '@better-agent/domain-contracts';
import {
  prepareAgentStrategySource as prepare,
  verifyAgentStrategySource as verify,
  verifyAgentStrategyAssembly,
  canonicalSha256,
  deriveDependencyManifest,
  prepareExecutableSource,
} from '../src/index.js';
import { richAgentSource } from './executable-source-fixtures.js';
import {
  strategyId,
  strategyReleaseId,
  workspaceId,
  otherWorkspaceId,
  hashA,
  hashB,
} from './fixtures.js';
import { put, record } from './leaf-resource-source-fixtures.js';

function source() {
  return {
    schema_version: 'agent-strategy-source-candidate/1',
    workspace_id: workspaceId,
    document: {
      schema_version: 'agent-strategy-source/1',
      strategy_id: strategyId,
      strategy_release_id: strategyReleaseId,
      abi_version: 'agent-strategy-abi/1',
      implementation_digest: hashA,
      config: { planning: { mode: 'react', prompt: 'Answer the question' } },
      config_schema: { type: 'object' },
      input_schema: { type: 'object', title: 'StrategyStart' },
      state_schema: { type: 'object', properties: { cursor: { type: 'integer' } } },
      decision_schema: { type: 'object', required: ['kind'] },
      observation_schema: { type: 'object', title: 'Observation' },
      sandbox_profile: {
        schema_version: 'strategy-sandbox-profile/1',
        profile_id: 'isolated-strategy/1',
        host_abi: 'agent-strategy-abi/1',
        network: 'deny',
        filesystem: 'deny',
        database: 'deny',
        secrets: 'deny',
        maximum_memory_bytes: 67_108_864,
        maximum_instruction_count: 1_000_000,
      },
      allowed_model_policy: {
        schema_version: 'strategy-model-policy/1',
        models: [
          {
            descriptor_id: 'primary',
            provider_id: 'provider',
            model_id: 'chat',
            model_revision: '2026-01',
            model_contract_hash: hashA,
          },
        ],
        maximum_input_tokens: 32_768,
        maximum_output_tokens: 4_096,
      },
      allowed_capability_binding_ids: ['plugin', 'knowledge'],
      allowed_gate_spec_ids: [] as string[],
      max_iterations: 10,
      max_model_attempts: 5,
      max_tool_calls: 5,
    },
  };
}

function assembly(input: ReturnType<typeof source>) {
  const document = richAgentSource();
  document.strategy = structuredClone(prepare(input).strategy_pin);
  document.model_policy = structuredClone(input.document.allowed_model_policy);
  return { schema_version: 'executable-source-candidate/1', workspace_id: workspaceId, document };
}

describe('Agent Strategy typed source and assembly', () => {
  it('binds config, every ABI schema, sandbox and model policy to the full source and strategy pins', () => {
    const input = source();
    const result = prepare(input);
    expect(safeParseDomainContract(input.document).success).toBe(true);
    expect(result.preimage).toEqual({
      schema_version: 'agent-strategy-source-preimage/1',
      compiler_version: 'capability-compiler/1',
      canonicalizer_version: 'rfc8785/1',
      workspace_id: workspaceId,
      published_resource_kind: 'AGENT_STRATEGY_RELEASE',
      document: result.document,
    });
    expect(result.full_pin).toEqual({
      workspace_id: workspaceId,
      published_resource_kind: 'AGENT_STRATEGY_RELEASE',
      resource_id: strategyId,
      resource_version_id: strategyReleaseId,
      contract_hash: canonicalSha256(result.preimage),
      binding_mode: 'pinned',
    });
    expect(result.strategy_pin).toEqual({
      published_resource_kind: 'AGENT_STRATEGY_RELEASE',
      strategy_id: strategyId,
      strategy_release_id: strategyReleaseId,
      abi_version: 'agent-strategy-abi/1',
      implementation_digest: hashA,
      config_hash: canonicalSha256(input.document.config),
      input_schema_hash: canonicalSha256(input.document.input_schema),
      state_schema_hash: canonicalSha256(input.document.state_schema),
      decision_schema_hash: canonicalSha256(input.document.decision_schema),
      observation_schema_hash: canonicalSha256(input.document.observation_schema),
      sandbox_profile_id: 'isolated-strategy/1',
      allowed_model_policy_hash: canonicalSha256(input.document.allowed_model_policy),
      allowed_capability_binding_ids: ['knowledge', 'plugin'],
      allowed_gate_spec_ids: [],
      max_iterations: 10,
      max_model_attempts: 5,
      max_tool_calls: 5,
      contract_hash: result.full_pin.contract_hash,
    });
    const { contract_hash: _hash, binding_mode: _mode, ...owner } = result.full_pin;
    expect(result.dependency_manifest).toEqual(deriveDependencyManifest(owner, []));
    expect(verify(result, input)).toEqual(result);
    const agent = assembly(input);
    expect(verifyAgentStrategyAssembly(agent, input)).toEqual(result);
    expect(prepareExecutableSource(agent).dependency_manifest.dependencies).toContainEqual(
      result.full_pin,
    );
  });

  it.each([
    ['config', ['config', 'planning', 'prompt'], 'different'],
    ['config schema', ['config_schema', 'title'], 'new'],
    ['input', ['input_schema', 'title'], 'different'],
    ['state', ['state_schema', 'title'], 'new'],
    ['decision', ['decision_schema', 'title'], 'new'],
    ['observation', ['observation_schema', 'title'], 'new'],
    ['implementation', ['implementation_digest'], hashB],
    ['sandbox', ['sandbox_profile', 'maximum_memory_bytes'], 33_554_432],
    ['model', ['allowed_model_policy', 'models', '0', 'model_contract_hash'], hashB],
    ['model limit', ['allowed_model_policy', 'maximum_input_tokens'], 16_384],
    ['capabilities', ['allowed_capability_binding_ids'], ['plugin']],
    ['gates', ['allowed_gate_spec_ids'], ['approval']],
    ['iterations', ['max_iterations'], 11],
    ['model attempts', ['max_model_attempts'], 6],
    ['tool calls', ['max_tool_calls'], 6],
  ])('binds the %s axis without trusting precomputed digests', (_label, path, value) => {
    const input = source();
    const result = prepare(input);
    put(input.document, path as string[], value);
    expect(prepare(input).full_pin.contract_hash).not.toBe(result.full_pin.contract_hash);
    expect(() => verify(result, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
  });

  it.each([
    ['unknown field', ['token'], 'not-to-be-echoed'],
    ['fake hash', ['config_hash'], hashA],
    ['identity', ['strategy_id'], strategyId.toUpperCase()],
    ['floating model', ['allowed_model_policy', 'models', '0', 'model_revision'], 'latest'],
    ['network', ['sandbox_profile', 'network'], 'allow'],
    ['filesystem', ['sandbox_profile', 'filesystem'], 'allow'],
    ['database', ['sandbox_profile', 'database'], 'allow'],
    ['secret', ['sandbox_profile', 'secrets'], 'allow'],
    ['ABI', ['abi_version'], 'agent-strategy-abi/2'],
    ['sandbox ABI', ['sandbox_profile', 'host_abi'], 'agent-strategy-abi/2'],
    ['duplicate binding', ['allowed_capability_binding_ids'], ['plugin', 'plugin']],
    ['zero iteration', ['max_iterations'], 0],
    ['negative attempts', ['max_model_attempts'], -1],
  ])('rejects %s in the closed control-plane source', (_label, path, value) => {
    const input = source();
    put(input.document, path as string[], value);
    expect(() => prepare(input)).toThrow('CLOSURE_SOURCE_INVALID');
  });

  it('canonicalizes explicit sets, keeps business array order and detaches deeply frozen results', () => {
    const input = source();
    const before = structuredClone(input);
    const result = prepare(input);
    expect(input).toEqual(before);
    input.document.allowed_capability_binding_ids.reverse();
    expect(prepare(input)).toEqual(result);
    expect(Object.isFrozen(result.document.config)).toBe(true);
    put(input.document, ['config', 'steps'], ['a', 'b']);
    const ordered = prepare(input);
    put(input.document, ['config', 'steps'], ['b', 'a']);
    expect(prepare(input).full_pin.contract_hash).not.toBe(ordered.full_pin.contract_hash);
  });

  it('verifies every artifact field and rejects hidden executable input', () => {
    const input = source();
    const result = prepare(input);
    for (const patch of [
      { component_hashes: {} },
      { document: {} },
      { strategy_pin: {} },
      { dependency_manifest: {} },
      { extra: true },
    ])
      expect(() => verify({ ...result, ...patch }, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
    const trap = vi.fn();
    const hostile = source();
    Object.defineProperty(hostile.document, 'config', { get: trap, enumerable: true });
    expect(() => prepare(hostile)).toThrow('CLOSURE_SOURCE_INVALID');
    expect(() => prepare(new Proxy(input, { ownKeys: trap, get: trap }))).toThrow(
      'CLOSURE_SOURCE_INVALID',
    );
    expect(trap).not.toHaveBeenCalled();
    put(input.document, ['config'], JSON.parse('{"__proto__":{"lost":true}}'));
    expect(() => prepare(input)).toThrow('CLOSURE_SOURCE_INVALID');
  });

  it.each([
    'strategy_id',
    'strategy_release_id',
    'implementation_digest',
    'config_hash',
    'input_schema_hash',
    'state_schema_hash',
    'decision_schema_hash',
    'observation_schema_hash',
    'sandbox_profile_id',
    'allowed_model_policy_hash',
    'contract_hash',
    'max_iterations',
    'max_model_attempts',
    'max_tool_calls',
  ])('rejects assembled strategy %s drift', (field) => {
    const input = source();
    const agent = assembly(input);
    const pin = record(agent.document.strategy);
    pin[field] =
      typeof pin[field] === 'number'
        ? Number(pin[field]) + 1
        : field.endsWith('id')
          ? workspaceId
          : hashB;
    expect(() => verifyAgentStrategyAssembly(agent, input)).toThrow();
  });

  it('rejects cross-Workspace or model identity/limit expansion while accepting narrower models', () => {
    const input = source();
    const agent = assembly(input);
    expect(() =>
      verifyAgentStrategyAssembly(agent, { ...input, workspace_id: otherWorkspaceId }),
    ).toThrow('CLOSURE_SOURCE_MISMATCH');
    for (const [path, value] of [
      [['models', '0', 'provider_id'], 'other'],
      [['models', '0', 'model_id'], 'other'],
      [['models', '0', 'model_revision'], '2026-02'],
      [['models', '0', 'descriptor_id'], 'other'],
      [['models', '0', 'model_contract_hash'], hashB],
      [['maximum_input_tokens'], 32_769],
      [['maximum_output_tokens'], 4_097],
    ] as [string[], unknown][]) {
      const changed = structuredClone(agent);
      put(changed.document.model_policy, path, value);
      expect(() => verifyAgentStrategyAssembly(changed, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
    }
    put(agent.document.model_policy, ['maximum_input_tokens'], 1024);
    expect(verifyAgentStrategyAssembly(agent, input)).toEqual(prepare(input));
  });

  it('compares every model in multi-model policies and accepts exact subsets and permutations', () => {
    const input = source();
    const model = input.document.allowed_model_policy.models[0];
    if (model === undefined) throw new Error('fixture model missing');
    input.document.allowed_model_policy.models.push({
      ...model,
      descriptor_id: 'secondary',
      model_id: 'other-chat',
    });
    const result = prepare(input);
    const agent = assembly(input);
    expect(verifyAgentStrategyAssembly(agent, input)).toEqual(result);
    put(agent.document.model_policy, ['models', '1', 'model_revision'], 'unauthorized-revision');
    expect(() => verifyAgentStrategyAssembly(agent, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
    put(agent.document.model_policy, ['models'], [input.document.allowed_model_policy.models[1]]);
    expect(verifyAgentStrategyAssembly(agent, input)).toEqual(result);
    input.document.allowed_model_policy.models.reverse();
    expect(prepare(input)).toEqual(result);
    put(agent.document.model_policy, ['models'], []);
    put(agent.document.model_policy, ['maximum_input_tokens'], 0);
    put(agent.document.model_policy, ['maximum_output_tokens'], 0);
    expect(verifyAgentStrategyAssembly(agent, input)).toEqual(result);
  });

  it('binds nonempty gates and detects allowset drift even when all references exist in the Agent', () => {
    const input = source();
    input.document.allowed_gate_spec_ids = ['approval'];
    const result = prepare(input);
    const agent = assembly(input);
    expect(result.strategy_pin.allowed_gate_spec_ids).toEqual(['approval']);
    expect(verifyAgentStrategyAssembly(agent, input)).toEqual(result);
    for (const [field, values] of [
      ['allowed_capability_binding_ids', ['plugin']],
      ['allowed_capability_binding_ids', ['plugin', 'knowledge', 'database']],
      ['allowed_gate_spec_ids', []],
      ['allowed_gate_spec_ids', ['approval', 'input']],
    ] as [string, string[]][]) {
      const changed = structuredClone(agent);
      put(changed.document.strategy, [field], values);
      expect(() => prepareExecutableSource(changed)).not.toThrow();
      expect(() => verifyAgentStrategyAssembly(changed, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
    }
    input.document.allowed_gate_spec_ids = ['missing'];
    expect(() => verifyAgentStrategyAssembly(assembly(input), input)).toThrow(
      'CLOSURE_SOURCE_INVALID',
    );
  });

  it('round-trips a large legal artifact and rejects output expansion in the same prepare call', () => {
    const input = source();
    put(
      input.document,
      ['config'],
      Object.fromEntries(Array.from({ length: 63 }, (_, i) => [`k${i}`, 'a'.repeat(65_536)])),
    );
    const prepared = prepare(input);
    expect(verify(prepared, input)).toEqual(prepared);
    expect(verifyAgentStrategyAssembly(assembly(input), input)).toEqual(prepared);
    put(input.document, ['config', 'overflow'], 'a'.repeat(65_536));
    expect(() => prepare(input)).toThrow('CLOSURE_SOURCE_LIMIT_EXCEEDED');
    expect(prepare(source()).full_pin.contract_hash).toBe(prepare(source()).full_pin.contract_hash);
  });
});
