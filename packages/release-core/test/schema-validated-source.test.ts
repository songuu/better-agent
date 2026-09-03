import { describe, expect, it } from 'vitest';
import {
  prepareSchemaValidatedOperationSource as operation,
  verifySchemaValidatedOperationSource as verifyOperation,
  prepareSchemaValidatedStrategySource as strategy,
  verifySchemaValidatedStrategySource as verifyStrategy,
  prepareOperationContractSource,
  prepareAgentStrategySource,
  prepareJsonSchemaContract,
  canonicalSha256,
} from '../src/index.js';
import { strategyId, strategyReleaseId, workspaceId, hashA } from './fixtures.js';

function operationSource() {
  return {
    schema_version: 'operation-contract-source/1',
    operation_kind: 'plugin_tool',
    operation_id: 'search',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    output_schema: { type: 'array', items: { type: 'string' } },
    side_effect_class: 'safe',
    operation_key_required: false,
    approval_required: false,
  };
}
function strategySource() {
  return {
    schema_version: 'agent-strategy-source-candidate/1',
    workspace_id: workspaceId,
    document: {
      schema_version: 'agent-strategy-source/1',
      strategy_id: strategyId,
      strategy_release_id: strategyReleaseId,
      abi_version: 'agent-strategy-abi/1',
      implementation_digest: hashA,
      config: { attempts: 2 },
      config_schema: {
        type: 'object',
        properties: { attempts: { type: 'integer', minimum: 1, default: 2 } },
        required: ['attempts'],
        additionalProperties: false,
      },
      input_schema: { type: 'object', required: ['request'] },
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
      allowed_gate_spec_ids: [],
      max_iterations: 10,
      max_model_attempts: 5,
      max_tool_calls: 5,
    },
  };
}

describe('schema validation bound to real operation and Strategy sources', () => {
  it('preserves the exact operation artifact and binds every schema in a complete evidence preimage', async () => {
    const input = operationSource();
    const prepared = prepareOperationContractSource(input);
    const inputContract = await prepareJsonSchemaContract(input.input_schema);
    const outputContract = await prepareJsonSchemaContract(input.output_schema);
    const result = await operation(input);
    const evidence = {
      schema_version: 'source-schema-validation-evidence/1',
      source_artifact_hash: canonicalSha256(prepared),
      validator_profile_hash: inputContract.validator_profile_hash,
      schemas: [
        {
          field: 'input_schema',
          schema_hash: inputContract.schema_hash,
          contract_hash: inputContract.contract_hash,
        },
        {
          field: 'output_schema',
          schema_hash: outputContract.schema_hash,
          contract_hash: outputContract.contract_hash,
        },
      ],
      instances: [],
    };
    expect(result).toEqual({
      schema_version: 'schema-validated-operation-source/1',
      source_artifact: prepared,
      evidence,
      validation_hash: canonicalSha256(evidence),
    });
    expect(await verifyOperation(result, input)).toEqual(result);
    expect(Object.isFrozen(result.evidence.schemas)).toBe(true);
    expect(Object.isFrozen(result.source_artifact.source.input_schema)).toBe(true);
  });

  it('does not invent an absent operation output contract', async () => {
    const { output_schema: _, ...input } = operationSource();
    const result = await operation(input);
    expect(result.evidence.schemas.map((schema) => schema.field)).toEqual(['input_schema']);
    expect(result.source_artifact.pin.output_schema_hash).toBeUndefined();
  });

  it.each(['input_schema', 'output_schema'] as const)(
    'rejects invalid operation %s at its real source entry',
    async (field) => {
      const input = { ...operationSource(), [field]: { type: 'not-a-type' } };
      expect(prepareOperationContractSource(input)).toBeDefined();
      await expect(operation(input)).rejects.toThrow('JSON_SCHEMA_INVALID');
    },
  );

  it('validates all five Strategy contracts and its actual config without changing source identity', async () => {
    const input = strategySource();
    const source = prepareAgentStrategySource(input);
    const result = await strategy(input);
    const fields = [
      'config_schema',
      'input_schema',
      'state_schema',
      'decision_schema',
      'observation_schema',
    ] as const;
    const schemas = [];
    for (const field of fields) {
      const contract = await prepareJsonSchemaContract(input.document[field]);
      schemas.push({
        field,
        schema_hash: contract.schema_hash,
        contract_hash: contract.contract_hash,
      });
    }
    const profile = await prepareJsonSchemaContract({});
    const evidence = {
      schema_version: 'source-schema-validation-evidence/1',
      source_artifact_hash: canonicalSha256(source),
      validator_profile_hash: profile.validator_profile_hash,
      schemas,
      instances: [
        {
          field: 'config',
          schema_field: 'config_schema',
          instance_hash: canonicalSha256(input.document.config),
        },
      ],
    };
    expect(result).toEqual({
      schema_version: 'schema-validated-strategy-source/1',
      source_artifact: source,
      evidence,
      validation_hash: canonicalSha256(evidence),
    });
    expect(await verifyStrategy(result, input)).toEqual(result);
    expect(Object.isFrozen(result.source_artifact.document.config)).toBe(true);
    expect(Object.isFrozen(result.evidence.instances[0])).toBe(true);
  });

  it.each([
    'config_schema',
    'input_schema',
    'state_schema',
    'decision_schema',
    'observation_schema',
  ] as const)('checks even unused Strategy %s definitions', async (field) => {
    const input = strategySource();
    Object.assign(input.document, { [field]: { $defs: { unused: { type: 'not-a-type' } } } });
    expect(prepareAgentStrategySource(input)).toBeDefined();
    await expect(strategy(input)).rejects.toThrow('JSON_SCHEMA_INVALID');
  });

  it.each([{}, { attempts: '2' }, { attempts: 0 }, { attempts: 2, extra: true }])(
    'rejects Strategy config %j rather than coercing or filling defaults',
    async (config) => {
      const input = strategySource();
      Object.assign(input.document, { config });
      expect(prepareAgentStrategySource(input)).toBeDefined();
      await expect(strategy(input)).rejects.toThrow('JSON_SCHEMA_INSTANCE_INVALID');
    },
  );

  it('snapshots operation and Strategy operands before the first await', async () => {
    const input = operationSource();
    const expectedOperation = prepareOperationContractSource(input);
    const pending = operation(input);
    input.output_schema.items.type = 'invalid';
    expect((await pending).source_artifact).toEqual(expectedOperation);
    const candidate = strategySource();
    const expectedStrategy = prepareAgentStrategySource(candidate);
    const strategyPending = strategy(candidate);
    candidate.document.config.attempts = 0;
    candidate.document.decision_schema.type = 'invalid';
    expect((await strategyPending).source_artifact).toEqual(expectedStrategy);
  });

  it('reconstructs the whole operation wrapper and refuses source/evidence/hash/extra-field drift', async () => {
    const input = operationSource();
    const result = await operation(input);
    for (const patch of [
      { source_artifact: {} },
      { evidence: {} },
      { validation_hash: hashA },
      { extra: true },
      { evidence: { ...result.evidence, schemas: result.evidence.schemas.slice(0, 1) } },
      { evidence: { ...result.evidence, source_artifact_hash: hashA } },
      { evidence: { ...result.evidence, validator_profile_hash: hashA } },
      { evidence: { ...result.evidence, instances: [{ field: 'invented' }] } },
    ])
      await expect(verifyOperation({ ...result, ...patch }, input)).rejects.toThrow(
        'CLOSURE_SOURCE_MISMATCH',
      );
    await expect(verifyOperation(result, { ...input, operation_id: 'other' })).rejects.toThrow(
      'CLOSURE_SOURCE_MISMATCH',
    );
  });

  it('reconstructs Strategy config evidence rather than trusting caller hashes', async () => {
    const input = strategySource();
    const result = await strategy(input);
    const evidence = result.evidence;
    const patches = [
      { schema_version: 'unknown' },
      { source_artifact: {} },
      { validation_hash: hashA },
      { extra: true },
      ...[
        { schema_version: 'unknown' },
        { source_artifact_hash: hashA },
        { validator_profile_hash: hashA },
        { schemas: evidence.schemas.slice(0, -1) },
        { instances: [] },
        { extra: true },
        ...['field', 'schema_hash', 'contract_hash'].map((field) => ({
          schemas: evidence.schemas.map((entry, index) =>
            index === 3 ? { ...entry, [field]: 'wrong' } : entry,
          ),
        })),
        ...['field', 'schema_field', 'instance_hash'].map((field) => ({
          instances: [{ ...evidence.instances[0], [field]: 'wrong' }],
        })),
      ].map((patch) => ({ evidence: { ...evidence, ...patch } })),
    ];
    for (const patch of patches)
      await expect(verifyStrategy({ ...result, ...patch }, input)).rejects.toThrow(
        'CLOSURE_SOURCE_MISMATCH',
      );
    input.document.config.attempts = 3;
    await expect(verifyStrategy(result, input)).rejects.toThrow('CLOSURE_SOURCE_MISMATCH');
  }, 20_000);

  it('retains source closed-shape rejection before schema validation', async () => {
    await expect(operation({ ...operationSource(), unrecognized: true })).rejects.toThrow(
      'CLOSURE_SOURCE_INVALID',
    );
    const candidate = strategySource();
    await expect(
      strategy({ ...candidate, document: { ...candidate.document, abi_version: 'unknown' } }),
    ).rejects.toThrow('CLOSURE_SOURCE_INVALID');
  });

  it('bounds the complete evidence wrapper even when both schemas and the source artifact fit', async () => {
    const input = {
      ...operationSource(),
      input_schema: {
        type: 'object',
        title: '',
        examples: Array.from({ length: 64 }, () => 'a'.repeat(65_500)),
      },
      output_schema: {
        type: 'object',
        examples: Array.from({ length: 64 }, () => 'b'.repeat(65_500)),
      },
    };
    const base = prepareOperationContractSource(input);
    const padding = 8_388_608 - 500 - Buffer.byteLength(JSON.stringify(base), 'utf8');
    expect(padding).toBeGreaterThan(2000);
    input.input_schema.title = 'x'.repeat(padding);
    const source = prepareOperationContractSource(input);
    expect(Buffer.byteLength(JSON.stringify(source), 'utf8')).toBe(8_388_608 - 500);
    await expect(prepareJsonSchemaContract(input.input_schema)).resolves.toBeDefined();
    await expect(prepareJsonSchemaContract(input.output_schema)).resolves.toBeDefined();
    await expect(operation(input)).rejects.toThrow('CLOSURE_SOURCE_LIMIT_EXCEEDED');
    input.input_schema.title = input.input_schema.title.slice(2000);
    const recovered = await operation(input);
    expect(await verifyOperation(recovered, input)).toEqual(recovered);
  }, 20_000);
});
