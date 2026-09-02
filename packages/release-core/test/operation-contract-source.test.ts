import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { safeParseDomainContract, type BindingKindV1 } from '@better-agent/domain-contracts';
import {
  canonicalJsonBytes,
  prepareOperationContractSource as prepare,
  verifyOperationContractSource as verify,
  verifyOperationContractPin,
  verifyBindingOperationContract,
} from '../src/index.js';
import { richAgentSource } from './executable-source-fixtures.js';
import { hashA } from './fixtures.js';

const kinds = [
  'knowledge_query',
  'database_operation',
  'flow_call',
  'plugin_tool',
  'subagent_call',
];
function source(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'operation-contract-source/1',
    operation_kind: 'plugin_tool',
    operation_id: 'lookup',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    output_schema: { type: 'string' },
    side_effect_class: 'safe',
    operation_key_required: false,
    approval_required: false,
    ...overrides,
  };
}
function sha(text: string) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
function scenario(kind: BindingKindV1 = 'plugin') {
  const original = richAgentSource().capability_bindings.find((item) => item.kind === kind);
  if (original === undefined) throw new Error('fixture Binding is missing');
  const binding = structuredClone(original) as unknown as Record<string, unknown>;
  const config = binding.config as Record<string, unknown>;
  const operationKind = {
    knowledge: 'knowledge_query',
    database: 'database_operation',
    flow: 'flow_call',
    plugin: 'plugin_tool',
    subagent: 'subagent_call',
    skill_pack: 'plugin_tool',
  }[kind];
  const operation = source({
    operation_kind: operationKind,
    operation_id: kind === 'plugin' ? config.provider_tool_name : 'invoke',
  });
  binding.input_schema = structuredClone(operation.input_schema);
  binding.output_schema = structuredClone(operation.output_schema);
  binding.side_effect = { class: 'safe', approval: 'none' };
  const pin = prepare(operation).pin;
  if (kind === 'knowledge') config.query_contract_hash = pin.contract_hash;
  if (kind === 'plugin' || kind === 'database') config.operation_contract_hash = pin.contract_hash;
  return { binding, operation, pin };
}

describe('operation source preimages', () => {
  it.each(kinds)('derives complete %s pins from real schema bodies', (kind) => {
    const document = source({ operation_kind: kind });
    const actual = prepare(document);
    const fields = {
      operation_kind: kind,
      operation_id: 'lookup',
      input_schema_hash: sha(
        '{"additionalProperties":false,"properties":{"query":{"type":"string"}},"required":["query"],"type":"object"}',
      ),
      output_schema_hash: sha('{"type":"string"}'),
      side_effect_class: 'safe',
      operation_key_required: false,
      approval_required: false,
    };
    const preimage = {
      schema_version: 'operation-contract-preimage/1',
      canonicalizer_version: 'rfc8785/1',
      ...fields,
    };
    expect(actual).toEqual({
      schema_version: 'prepared-operation-contract-source/1',
      source: document,
      preimage,
      pin: { ...fields, contract_hash: sha(canonicalJsonBytes(preimage).toString('utf8')) },
    });
    expect(verify(actual, document)).toEqual(actual);
    expect(verifyOperationContractPin(actual.pin, document)).toEqual(actual.pin);
    expect(safeParseDomainContract(document).success).toBe(true);
  });

  it('keeps absent output different from an explicit empty output schema', () => {
    const { output_schema: _output, ...without } = source();
    const absent = prepare(without);
    expect(Object.hasOwn(absent.pin, 'output_schema_hash')).toBe(false);
    expect(absent.pin.contract_hash).not.toBe(
      prepare(source({ output_schema: {} })).pin.contract_hash,
    );
  });

  it('is key-order invariant but preserves schema annotations and array order', () => {
    const initial = source({
      input_schema: { type: 'string', title: 'Business title', enum: ['a', 'b'] },
    });
    const reordered = source({
      input_schema: { enum: ['a', 'b'], title: 'Business title', type: 'string' },
    });
    expect(prepare(initial)).toEqual(prepare(reordered));
    for (const input_schema of [
      { type: 'string', title: 'Other title', enum: ['a', 'b'] },
      { type: 'string', title: 'Business title', enum: ['b', 'a'] },
    ])
      expect(prepare(source({ input_schema })).pin.contract_hash).not.toBe(
        prepare(initial).pin.contract_hash,
      );
  });

  it.each([
    ['kind', { operation_kind: 'flow_call' }],
    ['identity', { operation_id: 'other' }],
    ['input', { input_schema: { type: 'integer' } }],
    ['output', { output_schema: { type: 'number' } }],
    ['effect', { side_effect_class: 'unsafe' }],
    ['operation key', { operation_key_required: true }],
    ['approval', { approval_required: true }],
  ])('binds the %s semantic axis', (_label, patch) => {
    const prepared = prepare(source());
    expect(prepare(source(patch)).pin.contract_hash).not.toBe(prepared.pin.contract_hash);
    expect(() => verify(prepared, source(patch))).toThrow('CAPABILITY_OPERATION_CONTRACT_MISMATCH');
    expect(() => verifyOperationContractPin(prepared.pin, source(patch))).toThrow(
      'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
    );
  });

  it.each([
    ['version', { schema_version: 'operation-contract-source/2' }],
    ['unknown field', { secret_ref: 'private' }],
    ['precomputed hash', { input_schema_hash: hashA }],
    ['precomputed contract', { contract_hash: hashA }],
    ['unknown operation kind', { operation_kind: 'shell' }],
    ['empty id', { operation_id: '' }],
    ['string flag', { operation_key_required: 'false' }],
    ['key class without key', { side_effect_class: 'requires_key', operation_key_required: false }],
    ['query side effect', { operation_kind: 'knowledge_query', side_effect_class: 'unsafe' }],
    ['non-object input', { input_schema: [] }],
    ['explicit undefined output', { output_schema: undefined }],
  ])('rejects %s without echoing source values', (_label, patch) => {
    expect(() => prepare(source(patch))).toThrow('CLOSURE_SOURCE_INVALID');
    try {
      prepare(source(patch));
    } catch (error) {
      expect(String(error)).not.toContain('private');
    }
  });

  it.each(['input_schema', 'output_schema'])('rejects silent map-key loss in %s', (field) => {
    expect(() =>
      prepare(source({ [field]: JSON.parse('{"__proto__":{"secret":"lost"},"type":"object"}') })),
    ).toThrow('CLOSURE_SOURCE_INVALID');
  });

  it('rejects getters, proxies and revoked proxies without traps', () => {
    const trap = vi.fn(() => {
      throw new Error('input code ran');
    });
    const accessor = source();
    Object.defineProperty(accessor, 'input_schema', { get: trap, enumerable: true });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const input of [
      accessor,
      new Proxy(source(), { ownKeys: trap, get: trap }),
      source({ input_schema: revoked.proxy }),
    ])
      expect(() => prepare(input)).toThrow('CLOSURE_SOURCE_INVALID');
    expect(trap).not.toHaveBeenCalled();
  });

  it('bounds identity UTF-8, schema strings, and structural depth', () => {
    expect(prepare(source({ operation_id: 'é'.repeat(2048) })).pin.operation_id).toHaveLength(2048);
    expect(() => prepare(source({ operation_id: `${'é'.repeat(2048)}a` }))).toThrow(
      'CLOSURE_SOURCE_LIMIT_EXCEEDED',
    );
    expect(
      prepare(source({ input_schema: { description: 'é'.repeat(32768) } })).source.input_schema
        .description,
    ).toHaveLength(32768);
    expect(() =>
      prepare(source({ input_schema: { description: `${'é'.repeat(32768)}a` } })),
    ).toThrow('CLOSURE_SOURCE_LIMIT_EXCEEDED');
    let deep: unknown = {};
    for (let i = 0; i < 65; i += 1) deep = { child: deep };
    expect(() => prepare(source({ input_schema: deep }))).toThrow('CLOSURE_SOURCE_LIMIT_EXCEEDED');
  });

  it('bounds encoded bytes even when raw schema strings fit, without poisoning a retry', () => {
    const input = source({ input_schema: { examples: Array(128).fill('\n'.repeat(32768)) } });
    expect(() => prepare(input)).toThrow('CLOSURE_SOURCE_LIMIT_EXCEEDED');
    expect(prepare(source()).pin.operation_id).toBe('lookup');
  });

  it('rejects an oversized prepared artifact even when the entire input encoding fits', () => {
    const examples = [...Array<string>(127).fill('\n'.repeat(32768)), ''];
    const input = source({ input_schema: { examples } });
    const remaining = 8_388_608 - 64 - canonicalJsonBytes(input).length;
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(65_536);
    examples[127] = 'x'.repeat(remaining);
    expect(canonicalJsonBytes(input).length).toBe(8_388_608 - 64);
    expect(() => prepare(input)).toThrow('CLOSURE_SOURCE_LIMIT_EXCEEDED');
    examples[127] = 'x'.repeat(remaining - 3_000);
    const prepared = prepare(input);
    expect(canonicalJsonBytes(prepared).length).toBeLessThanOrEqual(8_388_608);
    expect(verify(prepared, input)).toEqual(prepared);
  });

  it('accepts explicit requires-key declarations only when the key requirement is bound', () => {
    const input = source({ side_effect_class: 'requires_key', operation_key_required: true });
    expect(prepare(input).pin).toMatchObject({
      side_effect_class: 'requires_key',
      operation_key_required: true,
    });
    expect(safeParseDomainContract(input).success).toBe(true);
  });

  it('returns a detached frozen result and verifies the complete artifact, not only its hash', () => {
    const input = source();
    const artifact = prepare(input);
    input.input_schema.properties.query.type = 'number';
    expect(artifact.source.input_schema).not.toEqual(input.input_schema);
    expect(Object.isFrozen(artifact.source.input_schema)).toBe(true);
    expect(Object.isFrozen(artifact.pin)).toBe(true);
    for (const patch of [
      { source: source({ operation_id: 'forged' }) },
      { preimage: { ...artifact.preimage, canonicalizer_version: 'other' } },
      { extra: true },
      { pin: { ...artifact.pin, operation_id: 'forged' } },
    ])
      expect(() => verify({ ...artifact, ...patch }, source())).toThrow(
        'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
      );
  });

  it.each([
    'operation_kind',
    'operation_id',
    'input_schema_hash',
    'output_schema_hash',
    'side_effect_class',
    'operation_key_required',
    'approval_required',
    'contract_hash',
  ])('rejects full pin field substitution: %s', (field) => {
    const pin = prepare(source()).pin;
    expect(() => verifyOperationContractPin({ ...pin, [field]: 'forged' }, source())).toThrow(
      'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
    );
  });
});

describe('Binding operation source verification', () => {
  it.each(['knowledge', 'database', 'plugin', 'flow', 'subagent'] as const)(
    'connects a %s Binding to the recomputed operation',
    (kind) => {
      const { binding, operation, pin } = scenario(kind);
      expect(verifyBindingOperationContract(binding, operation)).toEqual(pin);
      binding.enabled = false;
      expect(verifyBindingOperationContract(binding, operation)).toEqual(pin);
      binding.input_schema = { type: 'integer' };
      expect(() => verifyBindingOperationContract(binding, operation)).toThrow(
        'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
      );
    },
  );

  it.each(['knowledge', 'database', 'plugin'] as const)(
    'rejects a stale %s config contract hash',
    (kind) => {
      const { binding, operation } = scenario(kind);
      const config = binding.config as Record<string, unknown>;
      config[kind === 'knowledge' ? 'query_contract_hash' : 'operation_contract_hash'] = hashA;
      expect(() => verifyBindingOperationContract(binding, operation)).toThrow(
        'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
      );
    },
  );

  it('checks plugin provider operation identity independently from a matching hash', () => {
    const { binding, operation } = scenario();
    (binding.config as Record<string, unknown>).provider_tool_name = 'other';
    expect(() => verifyBindingOperationContract(binding, operation)).toThrow(
      'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
    );
  });

  it('requires exact output schema presence and contents', () => {
    const { binding, operation } = scenario();
    binding.output_schema = { type: 'integer' };
    expect(() => verifyBindingOperationContract(binding, operation)).toThrow(
      'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
    );
    delete binding.output_schema;
    expect(() => verifyBindingOperationContract(binding, operation)).toThrow(
      'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
    );
    const { output_schema: _output, ...without } = operation;
    (binding.config as Record<string, unknown>).operation_contract_hash =
      prepare(without).pin.contract_hash;
    expect(verifyBindingOperationContract(binding, without)).not.toHaveProperty(
      'output_schema_hash',
    );
    binding.output_schema = {};
    expect(() => verifyBindingOperationContract(binding, without)).toThrow(
      'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
    );
  });

  it('rejects matching hashes whose operation kind does not match the Binding', () => {
    const { binding, operation } = scenario();
    operation.operation_kind = 'flow_call';
    (binding.config as Record<string, unknown>).operation_contract_hash =
      prepare(operation).pin.contract_hash;
    expect(() => verifyBindingOperationContract(binding, operation)).toThrow(
      'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
    );
  });

  it('enforces operation key and approval requirements while allowing extra approval', () => {
    const { binding, operation } = scenario();
    binding.side_effect = {
      class: 'safe',
      approval: 'required',
      approval_gate_spec_id: 'published-gate',
    };
    expect(verifyBindingOperationContract(binding, operation)).toEqual(prepare(operation).pin);
    operation.operation_key_required = true;
    operation.approval_required = true;
    (binding.config as Record<string, unknown>).operation_contract_hash =
      prepare(operation).pin.contract_hash;
    expect(() => verifyBindingOperationContract(binding, operation)).toThrow(
      'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
    );
    binding.side_effect = { class: 'safe', approval: 'none', operation_key_source: 'generated' };
    expect(() => verifyBindingOperationContract(binding, operation)).toThrow(
      'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
    );
    binding.side_effect = {
      class: 'safe',
      approval: 'required',
      approval_gate_spec_id: 'published-gate',
      operation_key_source: 'request',
    };
    expect(verifyBindingOperationContract(binding, operation)).toEqual(prepare(operation).pin);
  });

  it('rejects declared effect drift even with matching schemas and operation hash', () => {
    const { binding, operation } = scenario();
    binding.side_effect = { class: 'unsafe', approval: 'none' };
    expect(() => verifyBindingOperationContract(binding, operation)).toThrow(
      'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
    );
  });

  it('does not bypass the G1 read-only database or Skill Pack routing boundaries', () => {
    const db = scenario('database');
    (db.binding.config as Record<string, unknown>).transaction_mode = 'single_write';
    expect(() => verifyBindingOperationContract(db.binding, db.operation)).toThrow(
      'FEATURE_NOT_ENABLED',
    );
    const pack = scenario('skill_pack');
    expect(() => verifyBindingOperationContract(pack.binding, pack.operation)).toThrow(
      'SKILL_PACK_OPERATION_UNRESOLVED',
    );
  });

  it('rejects an unsafe database operation disguised with a read-only Binding mode', () => {
    const { binding, operation } = scenario('database');
    operation.side_effect_class = 'unsafe';
    binding.side_effect = { class: 'unsafe', approval: 'none' };
    (binding.config as Record<string, unknown>).operation_contract_hash =
      prepare(operation).pin.contract_hash;
    expect(() => verifyBindingOperationContract(binding, operation)).toThrow('FEATURE_NOT_ENABLED');
  });

  it('supports the typed external A2A call declaration without changing its provenance boundary', () => {
    const { binding, operation, pin } = scenario('subagent');
    binding.target_kind = 'external_a2a';
    binding.pin = { ...(binding.pin as object), published_resource_kind: 'A2A_AGENT_RELEASE' };
    expect(verifyBindingOperationContract(binding, operation)).toEqual(pin);
  });

  it('enforces a stricter database config key requirement even when the operation does not require one', () => {
    const { binding, operation } = scenario('database');
    (binding.config as Record<string, unknown>).idempotency_requirement = 'operation_key_required';
    expect(() => verifyBindingOperationContract(binding, operation)).toThrow(
      'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
    );
    binding.side_effect = { class: 'safe', approval: 'none', operation_key_source: 'generated' };
    expect(verifyBindingOperationContract(binding, operation)).toEqual(prepare(operation).pin);
  });

  it('requires database operation-key declarations to agree with its config', () => {
    const { binding, operation } = scenario('database');
    operation.operation_key_required = true;
    const config = binding.config as Record<string, unknown>;
    config.operation_contract_hash = prepare(operation).pin.contract_hash;
    binding.side_effect = { class: 'safe', approval: 'none', operation_key_source: 'generated' };
    expect(() => verifyBindingOperationContract(binding, operation)).toThrow(
      'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
    );
    config.idempotency_requirement = 'operation_key_required';
    expect(verifyBindingOperationContract(binding, operation)).toEqual(prepare(operation).pin);
  });

  it('rejects closed-schema, full-pin and lost-field failures without exposing target identity', () => {
    const { binding, operation } = scenario();
    const originalPin = binding.pin as Record<string, unknown>;
    for (const patch of [
      { pin: { ...originalPin, published_resource_kind: 'FLOW_VERSION' } },
      { pin: { ...originalPin, contract_hash: 'sha256:short' } },
      { pin: { ...originalPin, resource_id: 'not-a-uuid' } },
      { config: { ...(binding.config as object), unknown: true } },
      { input_schema: JSON.parse('{"__proto__":{"lost":true},"type":"object"}') },
    ]) {
      expect(() => verifyBindingOperationContract({ ...binding, ...patch }, operation)).toThrow(
        'CLOSURE_SOURCE_INVALID',
      );
      try {
        verifyBindingOperationContract({ ...binding, ...patch }, operation);
      } catch (error) {
        expect(String(error)).not.toContain(String(originalPin.resource_id));
      }
    }
  });
});
