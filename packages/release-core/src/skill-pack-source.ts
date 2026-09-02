import {
  SkillPackSourceCandidateV1Schema,
  type CapabilityBindingV1,
  type OperationContractPinV1,
  type PublishedResourcePinV1,
  type SkillPackSourceV1,
} from '@better-agent/domain-contracts';
import {
  compareCanonicalStrings,
  deepFreezeJson,
  deriveDependencyManifest,
} from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { prepareCapabilityBindingSource } from './executable-source.js';
import { canonicalSha256 } from './hash.js';
import {
  prepareOperationContractSource,
  verifyBindingOperationContract,
} from './operation-contract-source.js';
import {
  mismatchedSource,
  parseSourceLosslessly,
  snapshotSource,
  sourceEqual,
} from './source-contract-data.js';

export interface SkillPackExposedOperationV1 {
  readonly exposed_operation_id: string;
  readonly exposed_operation_contract_hash: string;
  readonly member_binding_id: string;
  readonly member_operation_id: string;
  readonly member_target: PublishedResourcePinV1;
  readonly member_operation_contract: OperationContractPinV1;
}
export interface PreparedSkillPackSourceV1 {
  readonly schema_version: 'prepared-skill-pack-source/1';
  readonly document: SkillPackSourceV1;
  readonly preimage: {
    readonly schema_version: 'skill-pack-source-preimage/1';
    readonly compiler_version: 'capability-compiler/1';
    readonly canonicalizer_version: 'rfc8785/1';
    readonly workspace_id: string;
    readonly published_resource_kind: 'SKILL_PACK_RELEASE';
    readonly document: SkillPackSourceV1;
  };
  readonly full_pin: PublishedResourcePinV1 & {
    readonly published_resource_kind: 'SKILL_PACK_RELEASE';
  };
  readonly exposed_operations: readonly SkillPackExposedOperationV1[];
  readonly member_projection: {
    readonly schema_version: 'skill-pack-member-projection/1';
    readonly member_bindings: readonly CapabilityBindingV1[];
    readonly exposed_operations: readonly SkillPackExposedOperationV1[];
  };
  readonly member_projection_hash: `sha256:${string}`;
  readonly component_hashes: {
    readonly manual: `sha256:${string}`;
    readonly input_schema: `sha256:${string}`;
    readonly output_schema?: `sha256:${string}`;
  };
  readonly dependency_manifest: ReturnType<typeof deriveDependencyManifest>;
}

function unresolved(): never {
  throw new ReleaseCoreError(
    'SKILL_PACK_OPERATION_UNRESOLVED',
    '$.exposures',
    'exposure requires an enabled exact member operation',
  );
}

const effectRank = { safe: 0, requires_key: 1, unsafe: 2 } as const;
const classificationRank = { public: 0, internal: 1, confidential: 2, restricted: 3 } as const;
function coversOperation(binding: CapabilityBindingV1, operation: OperationContractPinV1): boolean {
  return (
    effectRank[binding.side_effect.class] >= effectRank[operation.side_effect_class] &&
    (!operation.operation_key_required || binding.side_effect.operation_key_source !== undefined) &&
    (!operation.approval_required || binding.side_effect.approval === 'required')
  );
}

function projectExposure(
  exposure: SkillPackSourceV1['exposures'][number],
  members: ReadonlyMap<string, CapabilityBindingV1>,
): SkillPackExposedOperationV1 {
  const member = members.get(exposure.member_binding_id);
  if (member === undefined || !member.enabled) unresolved();
  const operation = prepareOperationContractSource(exposure.operation).pin;
  if (member.kind === 'skill_pack') {
    const nested = member.config.exposed_operations.find(
      (item) => item.exposed_operation_id === exposure.member_operation_id,
    );
    if (nested?.exposed_operation_contract_hash !== operation.contract_hash) unresolved();
    if (!coversOperation(member, operation))
      throw new ReleaseCoreError(
        'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
        '$.exposures',
        'nested member restrictions do not cover the known operation',
      );
  } else {
    if (exposure.member_operation_id !== operation.operation_id)
      throw new ReleaseCoreError(
        'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
        '$.exposures',
        'member operation identity does not match its source',
      );
    verifyBindingOperationContract(member, exposure.operation);
  }
  return {
    exposed_operation_id: exposure.exposed_operation_id,
    exposed_operation_contract_hash: operation.contract_hash,
    member_binding_id: member.binding_id,
    member_operation_id: exposure.member_operation_id,
    member_target: member.pin,
    member_operation_contract: operation,
  };
}

/** Freeze declared pack members and exact exposure mappings; target provenance and recursive routes remain compiler responsibilities. */
export function prepareSkillPackSource(input: unknown): PreparedSkillPackSourceV1 {
  const candidate = parseSourceLosslessly(snapshotSource(input), SkillPackSourceCandidateV1Schema);
  const document = candidate.document;
  document.member_bindings = document.member_bindings
    .map((binding) => prepareCapabilityBindingSource(candidate.workspace_id, binding))
    .sort((left, right) => compareCanonicalStrings(left.binding_id, right.binding_id));
  document.exposures.sort((left, right) =>
    compareCanonicalStrings(left.exposed_operation_id, right.exposed_operation_id),
  );
  const owner = {
    workspace_id: candidate.workspace_id,
    published_resource_kind: 'SKILL_PACK_RELEASE' as const,
    resource_id: document.resource_id,
    resource_version_id: document.resource_version_id,
  };
  // Disabled and unexposed members remain dependencies; omission would hide cycles and source drift.
  for (const { pin } of document.member_bindings)
    if (
      pin.published_resource_kind === owner.published_resource_kind &&
      pin.resource_id === owner.resource_id &&
      pin.resource_version_id === owner.resource_version_id
    )
      throw new ReleaseCoreError(
        'CAPABILITY_DEPENDENCY_CYCLE',
        '$.member_bindings',
        'a pack cannot depend on its own resource version',
      );
  const dependency_manifest = deriveDependencyManifest(
    owner,
    document.member_bindings.map((binding) => binding.pin),
  );
  const members = new Map(document.member_bindings.map((binding) => [binding.binding_id, binding]));
  const exposed_operations = document.exposures.map((exposure) =>
    projectExposure(exposure, members),
  );
  const member_projection = {
    schema_version: 'skill-pack-member-projection/1' as const,
    member_bindings: document.member_bindings,
    exposed_operations,
  };
  const preimage = {
    schema_version: 'skill-pack-source-preimage/1' as const,
    compiler_version: 'capability-compiler/1' as const,
    canonicalizer_version: 'rfc8785/1' as const,
    workspace_id: candidate.workspace_id,
    published_resource_kind: owner.published_resource_kind,
    document,
  };
  const result: PreparedSkillPackSourceV1 = {
    schema_version: 'prepared-skill-pack-source/1',
    document,
    preimage,
    full_pin: { ...owner, contract_hash: canonicalSha256(preimage), binding_mode: 'pinned' },
    exposed_operations,
    member_projection,
    member_projection_hash: canonicalSha256(member_projection),
    dependency_manifest,
    component_hashes: {
      manual: canonicalSha256(document.manual),
      input_schema: canonicalSha256(document.input_schema),
      ...(document.output_schema === undefined
        ? {}
        : { output_schema: canonicalSha256(document.output_schema) }),
    },
  };
  snapshotSource(result);
  return deepFreezeJson(result);
}

export function verifySkillPackSource(
  expected: unknown,
  input: unknown,
): PreparedSkillPackSourceV1 {
  const snapshot = snapshotSource(expected);
  const actual = prepareSkillPackSource(input);
  if (!sourceEqual(snapshot, actual)) mismatchedSource();
  return actual;
}

/** Verify envelope and selected declarations; this does not replace per-route policy intersection or GateSpec coverage. */
export function verifySkillPackBinding(
  bindingInput: unknown,
  input: unknown,
): PreparedSkillPackSourceV1 {
  const pack = prepareSkillPackSource(input);
  const binding = prepareCapabilityBindingSource(pack.full_pin.workspace_id, bindingInput);
  if (
    binding.kind !== 'skill_pack' ||
    !sourceEqual(binding.pin, pack.full_pin) ||
    !sourceEqual(binding.manual, { ...pack.document.manual, hash: pack.component_hashes.manual }) ||
    !sourceEqual(binding.input_schema, pack.document.input_schema) ||
    !sourceEqual(binding.output_schema ?? null, pack.document.output_schema ?? null) ||
    binding.config.member_projection_hash !== pack.member_projection_hash ||
    (binding.enabled && binding.config.exposed_operations.length === 0)
  )
    mismatchedSource();
  const exposed = new Map(
    pack.exposed_operations.map((operation) => [operation.exposed_operation_id, operation]),
  );
  const members = new Map(
    pack.document.member_bindings.map((member) => [member.binding_id, member]),
  );
  for (const selected of binding.config.exposed_operations) {
    const operation = exposed.get(selected.exposed_operation_id);
    if (
      operation === undefined ||
      operation.exposed_operation_contract_hash !== selected.exposed_operation_contract_hash
    )
      mismatchedSource();
    const member = members.get(operation.member_binding_id);
    if (member === undefined) mismatchedSource();
    const declaration = operation.member_operation_contract;
    if (
      !coversOperation(binding, declaration) ||
      effectRank[binding.side_effect.class] < effectRank[member.side_effect.class] ||
      classificationRank[binding.data_classification] <
        classificationRank[member.data_classification] ||
      (member.side_effect.operation_key_source !== undefined &&
        binding.side_effect.operation_key_source === undefined) ||
      (member.side_effect.approval === 'required' && binding.side_effect.approval !== 'required')
    )
      mismatchedSource();
  }
  return pack;
}
