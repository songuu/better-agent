import { PublishedResourcePinV1Schema } from '@better-agent/domain-contracts';

import { prepareAgentStrategySource } from './agent-strategy-source.js';
import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import { canonicalJsonBytes } from './canonical-json.js';
import {
  deepFreezeJson,
  normalizeDependencyPins,
  publishedResourcePinKey,
} from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { prepareInstructionSkillSource } from './instruction-skill-source.js';
import { prepareLeafResourceSource } from './leaf-resource-source.js';
import { prepareSkillPackSource } from './skill-pack-source.js';
import { snapshotSource, sourceEqual } from './source-contract-data.js';

const maximumSourceBytes = 8_388_608;
const storageKeys = [
  'schema_version',
  'full_pin',
  'source_schema_version',
  'canonical_document',
  'dependency_manifest',
  'canonical_source_preimage',
  'canonical_source_artifact',
] as const;

type PreparedG1Source =
  | ReturnType<typeof prepareAgentStrategySource>
  | ReturnType<typeof prepareInstructionSkillSource>
  | ReturnType<typeof prepareLeafResourceSource>
  | ReturnType<typeof prepareSkillPackSource>;

export interface PreparedG1PublishedSourceStorageV1 {
  readonly schema_version: 'prepared-g1-published-source-storage/1';
  readonly full_pin: PreparedG1Source['full_pin'];
  readonly source_schema_version: PreparedG1Source['document']['schema_version'];
  readonly canonical_document: string;
  readonly dependency_manifest: PreparedG1Source['dependency_manifest'];
  readonly canonical_source_preimage: string;
  readonly canonical_source_artifact: string;
}

function fail(
  code:
    | 'G1_PUBLISHED_SOURCE_INVALID'
    | 'G1_PUBLISHED_SOURCE_UNSUPPORTED'
    | 'G1_PUBLISHED_SOURCE_TRUST_REQUIRED'
    | 'G1_PUBLISHED_SOURCE_DEPENDENCY_UNREGISTERED'
    | 'G1_PUBLISHED_SOURCE_MISMATCH',
  path: string,
  reason: string,
): never {
  throw new ReleaseCoreError(code, path, reason);
}

function record(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('G1_PUBLISHED_SOURCE_INVALID', path, 'value must be a closed data object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('G1_PUBLISHED_SOURCE_INVALID', path, 'object prototype is invalid');
  }
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    actualKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    fail('G1_PUBLISHED_SOURCE_INVALID', path, 'object fields differ from the closed projection');
  }
  return value as Record<string, unknown>;
}

function artifactRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('G1_PUBLISHED_SOURCE_INVALID', '$.prepared_source', 'prepared source must be an object');
  }
  return value as Record<string, unknown>;
}

function replayPreparedSource(
  input: unknown,
  trustedInstructionSigners: unknown,
): PreparedG1Source {
  const artifact = snapshotSource(input);
  const value = artifactRecord(artifact);
  const pin = artifactRecord(value.full_pin);
  const workspaceId = pin.workspace_id;
  if (typeof workspaceId !== 'string') {
    fail('G1_PUBLISHED_SOURCE_INVALID', '$.prepared_source.full_pin', 'workspace is missing');
  }
  let actual: PreparedG1Source;
  switch (value.schema_version) {
    case 'prepared-agent-strategy-source/1':
      if (trustedInstructionSigners !== null && trustedInstructionSigners !== undefined) {
        fail(
          'G1_PUBLISHED_SOURCE_INVALID',
          '$.trusted_instruction_signers',
          'unused trust is forbidden',
        );
      }
      actual = prepareAgentStrategySource({
        schema_version: 'agent-strategy-source-candidate/1',
        workspace_id: workspaceId,
        document: value.document,
      });
      break;
    case 'prepared-instruction-skill-source/1':
      if (trustedInstructionSigners === null || trustedInstructionSigners === undefined) {
        fail(
          'G1_PUBLISHED_SOURCE_TRUST_REQUIRED',
          '$.trusted_instruction_signers',
          'Instruction Skill replay requires an independent trust snapshot',
        );
      }
      actual = prepareInstructionSkillSource(
        {
          schema_version: 'instruction-skill-source-candidate/1',
          workspace_id: workspaceId,
          document: value.document,
          files: value.files,
        },
        trustedInstructionSigners,
      );
      break;
    case 'prepared-leaf-resource-source/1':
      if (trustedInstructionSigners !== null && trustedInstructionSigners !== undefined) {
        fail(
          'G1_PUBLISHED_SOURCE_INVALID',
          '$.trusted_instruction_signers',
          'unused trust is forbidden',
        );
      }
      actual = prepareLeafResourceSource({
        schema_version: 'leaf-resource-source-candidate/1',
        workspace_id: workspaceId,
        document: value.document,
      });
      break;
    case 'prepared-skill-pack-source/1':
      if (trustedInstructionSigners !== null && trustedInstructionSigners !== undefined) {
        fail(
          'G1_PUBLISHED_SOURCE_INVALID',
          '$.trusted_instruction_signers',
          'unused trust is forbidden',
        );
      }
      actual = prepareSkillPackSource({
        schema_version: 'skill-pack-source-candidate/1',
        workspace_id: workspaceId,
        document: value.document,
      });
      break;
    default:
      fail(
        'G1_PUBLISHED_SOURCE_UNSUPPORTED',
        '$.prepared_source.schema_version',
        'prepared source kind has no typed registry projection',
      );
  }
  if (!sourceEqual(artifact, actual)) {
    fail(
      'G1_PUBLISHED_SOURCE_MISMATCH',
      '$.prepared_source',
      'prepared source does not replay byte-for-byte',
    );
  }
  return actual;
}

function requireRegisteredDependencies(source: PreparedG1Source, registryInput: unknown): void {
  if (!Array.isArray(registryInput)) {
    fail(
      'G1_PUBLISHED_SOURCE_INVALID',
      '$.registered_dependency_pins',
      'registry snapshot must be an array',
    );
  }
  const registered = normalizeDependencyPins(source.full_pin.workspace_id, registryInput);
  const registeredKeys = new Set(registered.map(publishedResourcePinKey));
  for (const [index, dependency] of source.dependency_manifest.dependencies.entries()) {
    if (!registeredKeys.has(publishedResourcePinKey(dependency))) {
      fail(
        'G1_PUBLISHED_SOURCE_DEPENDENCY_UNREGISTERED',
        `$.dependency_manifest.dependencies[${index}]`,
        'source dependency is absent from the authoritative registry snapshot',
      );
    }
  }
}

function encode(value: unknown, path: string): string {
  const bytes = canonicalJsonBytes(value);
  if (bytes.length > maximumSourceBytes) {
    fail('G1_PUBLISHED_SOURCE_INVALID', path, 'canonical source bytes exceed the storage limit');
  }
  return bytes.toString('utf8');
}

function decode(value: unknown, path: string): unknown {
  if (
    typeof value !== 'string' ||
    value.length > maximumSourceBytes ||
    Buffer.byteLength(value, 'utf8') > maximumSourceBytes
  ) {
    fail('G1_PUBLISHED_SOURCE_INVALID', path, 'stored source text is missing or oversized');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail('G1_PUBLISHED_SOURCE_INVALID', path, 'stored source text is not JSON');
  }
  const snapshot = boundedDataSnapshot(parsed, 'source');
  if (encode(snapshot, path) !== value) {
    fail('G1_PUBLISHED_SOURCE_INVALID', path, 'stored source must use exact canonical bytes');
  }
  return snapshot;
}

export function prepareG1PublishedSourceStorage(
  preparedSource: unknown,
  registeredDependencyPins: unknown,
  trustedInstructionSigners: unknown = null,
): PreparedG1PublishedSourceStorageV1 {
  const source = replayPreparedSource(preparedSource, trustedInstructionSigners);
  requireRegisteredDependencies(source, registeredDependencyPins);
  return deepFreezeJson({
    schema_version: 'prepared-g1-published-source-storage/1',
    full_pin: source.full_pin,
    source_schema_version: source.document.schema_version,
    canonical_document: encode(source.document, '$.canonical_document'),
    dependency_manifest: source.dependency_manifest,
    canonical_source_preimage: encode(source.preimage, '$.canonical_source_preimage'),
    canonical_source_artifact: encode(source, '$.canonical_source_artifact'),
  });
}

export function verifyG1PublishedSourceStorage(
  expectedPin: unknown,
  input: unknown,
  registeredDependencyPins: unknown,
  trustedInstructionSigners: unknown = null,
): PreparedG1Source {
  const storage = record(boundedDataSnapshot(input, 'closure'), storageKeys, '$');
  if (storage.schema_version !== 'prepared-g1-published-source-storage/1') {
    fail('G1_PUBLISHED_SOURCE_INVALID', '$.schema_version', 'storage version is unsupported');
  }
  const expectedSnapshot = boundedDataSnapshot(expectedPin, 'identity');
  const expectedResult = PublishedResourcePinV1Schema.safeParse(expectedSnapshot);
  if (!expectedResult.success || !sourceEqual(expectedResult.data, expectedSnapshot)) {
    fail('G1_PUBLISHED_SOURCE_INVALID', '$.expected_pin', 'expected pin is invalid');
  }
  const artifact = decode(storage.canonical_source_artifact, '$.canonical_source_artifact');
  const source = replayPreparedSource(artifact, trustedInstructionSigners);
  requireRegisteredDependencies(source, registeredDependencyPins);
  const document = decode(storage.canonical_document, '$.canonical_document');
  const preimage = decode(storage.canonical_source_preimage, '$.canonical_source_preimage');
  if (
    !sourceEqual(expectedResult.data, source.full_pin) ||
    !sourceEqual(storage.full_pin, source.full_pin) ||
    storage.source_schema_version !== source.document.schema_version ||
    !sourceEqual(document, source.document) ||
    !sourceEqual(preimage, source.preimage) ||
    !sourceEqual(storage.dependency_manifest, source.dependency_manifest)
  ) {
    fail(
      'G1_PUBLISHED_SOURCE_MISMATCH',
      '$',
      'stored source identity, document or manifest does not match replay',
    );
  }
  return source;
}
