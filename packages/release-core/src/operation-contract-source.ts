import {
  CapabilityBindingV1Schema,
  OperationContractSourceV1Schema,
  UuidV1Schema,
  type OperationContractPinV1,
  type OperationContractSourceV1,
} from '@better-agent/domain-contracts';

import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import { canonicalJsonBytes } from './canonical-json.js';
import { deepFreezeJson } from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { canonicalSha256 } from './hash.js';

export interface PreparedOperationContractSourceV1 {
  readonly schema_version: 'prepared-operation-contract-source/1';
  readonly source: OperationContractSourceV1;
  readonly preimage: Omit<OperationContractPinV1, 'contract_hash'> & {
    readonly schema_version: 'operation-contract-preimage/1';
    readonly canonicalizer_version: 'rfc8785/1';
  };
  readonly pin: OperationContractPinV1;
}

function invalid(): never {
  throw new ReleaseCoreError(
    'CLOSURE_SOURCE_INVALID',
    '$',
    'operation source or Binding does not satisfy its closed data contract',
  );
}
function limit(): never {
  throw new ReleaseCoreError(
    'CLOSURE_SOURCE_LIMIT_EXCEEDED',
    '$',
    'operation source exceeds its absolute byte or identity budget',
  );
}
function mismatch(): never {
  throw new ReleaseCoreError(
    'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
    '$',
    'operation source, pin or Binding declarations do not match',
  );
}
function bounded(input: unknown): unknown {
  const snapshot = boundedDataSnapshot(input, 'source');
  if (canonicalJsonBytes(snapshot).length > 8_388_608) limit();
  return snapshot;
}
function equal(left: unknown, right: unknown): boolean {
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}
function parseLosslessly<T>(
  input: unknown,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): T {
  const result = schema.safeParse(input);
  if (!result.success || !equal(input, result.data)) invalid();
  return result.data;
}

/**
 * Bind complete schema documents to the operation's declared identity and effect semantics.
 * This is not JSON Schema compilation, target implementation verification or registry admission.
 */
export function prepareOperationContractSource(input: unknown): PreparedOperationContractSourceV1 {
  const source = parseLosslessly(bounded(input), OperationContractSourceV1Schema);
  if (Buffer.byteLength(source.operation_id, 'utf8') > 4_096) limit();
  const fields = {
    operation_kind: source.operation_kind,
    operation_id: source.operation_id,
    input_schema_hash: canonicalSha256(source.input_schema),
    ...(source.output_schema === undefined
      ? {}
      : { output_schema_hash: canonicalSha256(source.output_schema) }),
    side_effect_class: source.side_effect_class,
    operation_key_required: source.operation_key_required,
    approval_required: source.approval_required,
  };
  const preimage = {
    schema_version: 'operation-contract-preimage/1' as const,
    canonicalizer_version: 'rfc8785/1' as const,
    ...fields,
  };
  const result: PreparedOperationContractSourceV1 = {
    schema_version: 'prepared-operation-contract-source/1',
    source,
    preimage,
    pin: { ...fields, contract_hash: canonicalSha256(preimage) },
  };
  bounded(result);
  return deepFreezeJson(result);
}

export function verifyOperationContractSource(
  expected: unknown,
  input: unknown,
): PreparedOperationContractSourceV1 {
  const snapshot = bounded(expected);
  const actual = prepareOperationContractSource(input);
  if (!equal(snapshot, actual)) mismatch();
  return actual;
}

export function verifyOperationContractPin(
  expected: unknown,
  input: unknown,
): OperationContractPinV1 {
  const snapshot = bounded(expected);
  const actual = prepareOperationContractSource(input).pin;
  if (!equal(snapshot, actual)) mismatch();
  return actual;
}

/**
 * Verify one concrete Binding against an operation source from its target's release adapter.
 * The caller must still prove target provenance, policy narrowing and GateSpec coverage.
 * Skill Pack exposure is a separate exact member-route contract, never a generic Tool fallback.
 */
export function verifyBindingOperationContract(
  bindingInput: unknown,
  operationInput: unknown,
): OperationContractPinV1 {
  const [bindingSnapshot, operationSnapshot] = bounded([bindingInput, operationInput]) as unknown[];
  const binding = parseLosslessly(bindingSnapshot, CapabilityBindingV1Schema);
  for (const id of [
    binding.pin.workspace_id,
    binding.pin.resource_id,
    binding.pin.resource_version_id,
  ])
    if (id !== id.toLowerCase() || !UuidV1Schema.safeParse(id).success) invalid();
  if (
    binding.pin.contract_hash.length !== 71 ||
    !/^sha256:[a-f0-9]{64}$/u.test(binding.pin.contract_hash)
  )
    invalid();
  if (binding.kind === 'skill_pack')
    throw new ReleaseCoreError(
      'SKILL_PACK_OPERATION_UNRESOLVED',
      '$.config',
      'Skill Pack operations require an exact sealed member route',
    );
  if (binding.kind === 'database' && binding.config.transaction_mode !== 'read_only')
    throw new ReleaseCoreError(
      'FEATURE_NOT_ENABLED',
      '$.config',
      'G1 database operations must be read-only',
    );

  const operation = prepareOperationContractSource(operationSnapshot).pin;
  const expectedKind = {
    knowledge: 'knowledge_query',
    database: 'database_operation',
    plugin: 'plugin_tool',
    flow: 'flow_call',
    subagent: 'subagent_call',
  }[binding.kind];
  if (
    operation.operation_kind !== expectedKind ||
    operation.input_schema_hash !== canonicalSha256(binding.input_schema) ||
    operation.output_schema_hash !==
      (binding.output_schema === undefined ? undefined : canonicalSha256(binding.output_schema)) ||
    operation.side_effect_class !== binding.side_effect.class ||
    (operation.operation_key_required && binding.side_effect.operation_key_source === undefined) ||
    (operation.approval_required && binding.side_effect.approval !== 'required')
  )
    mismatch();

  switch (binding.kind) {
    case 'knowledge':
      if (binding.config.query_contract_hash !== operation.contract_hash) mismatch();
      break;
    case 'database':
      if (operation.side_effect_class !== 'safe')
        throw new ReleaseCoreError(
          'FEATURE_NOT_ENABLED',
          '$.config',
          'G1 database operations must have safe effects',
        );
      if (
        binding.config.operation_contract_hash !== operation.contract_hash ||
        (operation.operation_key_required &&
          binding.config.idempotency_requirement !== 'operation_key_required') ||
        (binding.config.idempotency_requirement === 'operation_key_required' &&
          binding.side_effect.operation_key_source === undefined)
      )
        mismatch();
      break;
    case 'plugin':
      if (
        binding.config.operation_contract_hash !== operation.contract_hash ||
        binding.config.provider_tool_name !== operation.operation_id
      )
        mismatch();
      break;
    case 'flow':
    case 'subagent':
      break;
  }
  return operation;
}
