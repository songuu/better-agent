import {
  PublishedResourcePinV1Schema,
  type PublishedResourceKindV1,
  type PublishedResourcePinV1,
} from '@better-agent/domain-contracts';
import {
  boundedDataSnapshot,
  prepareAgentStrategySource,
  prepareG1PublishedSourceStorage,
  prepareInstructionSkillSource,
  prepareLeafResourceSource,
  prepareSkillPackSource,
  verifyG1PublishedSourceStorage,
  type PreparedG1PublishedSourceStorageV1,
} from '@better-agent/release-core';

export type G1PublishedSourceKind = Extract<
  PublishedResourceKindV1,
  | 'AGENT_STRATEGY_RELEASE'
  | 'INSTRUCTION_SKILL_RELEASE'
  | 'KNOWLEDGE_INDEX_GENERATION'
  | 'DATABASE_OPERATION_RELEASE'
  | 'PLUGIN_TOOL_RELEASE'
  | 'A2A_AGENT_RELEASE'
  | 'SKILL_PACK_RELEASE'
>;

type PreparedG1Source = ReturnType<typeof verifyG1PublishedSourceStorage>;

export type G1SourceBoundaryErrorCode =
  | 'G1_SOURCE_BOUNDARY_INPUT_INVALID'
  | 'G1_SOURCE_PREPARATION_REJECTED'
  | 'G1_SOURCE_PERSISTENCE_FAILED'
  | 'G1_SOURCE_READBACK_REJECTED';

export class G1SourceBoundaryError extends Error {
  constructor(readonly code: G1SourceBoundaryErrorCode) {
    super('G1 source boundary rejected the command');
    this.name = 'G1SourceBoundaryError';
  }
}

export interface G1SourcePublicationAttestation {
  readonly attestationId: string;
  readonly verifierHex: string;
}

export interface G1SourceDatabaseTransaction {
  loadRegisteredDependencyPins(
    workspaceId: string,
    requestedPins: readonly unknown[],
  ): Promise<readonly unknown[]>;
  loadTrustedInstructionSigners(workspaceId: string): Promise<unknown>;
  publishAgentStrategySource(
    source: PreparedG1PublishedSourceStorageV1,
    attestation: G1SourcePublicationAttestation,
  ): Promise<string>;
  publishInstructionSkillSource(
    source: PreparedG1PublishedSourceStorageV1,
    attestation: G1SourcePublicationAttestation,
  ): Promise<string>;
  publishKnowledgeIndexGeneration(
    source: PreparedG1PublishedSourceStorageV1,
    attestation: G1SourcePublicationAttestation,
  ): Promise<string>;
  publishDatabaseOperationRelease(
    source: PreparedG1PublishedSourceStorageV1,
    attestation: G1SourcePublicationAttestation,
  ): Promise<string>;
  publishPluginToolRelease(
    source: PreparedG1PublishedSourceStorageV1,
    attestation: G1SourcePublicationAttestation,
  ): Promise<string>;
  publishA2aAgentRelease(
    source: PreparedG1PublishedSourceStorageV1,
    attestation: G1SourcePublicationAttestation,
  ): Promise<string>;
  publishSkillPackRelease(
    source: PreparedG1PublishedSourceStorageV1,
    attestation: G1SourcePublicationAttestation,
  ): Promise<string>;
  loadPublishedG1Source(pin: PublishedResourcePinV1): Promise<unknown>;
}

export interface G1SourceBoundaryDependencies {
  withTransaction<T>(
    callback: (transaction: G1SourceDatabaseTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface PublishG1SourceInput {
  readonly workspaceId: string;
  readonly document: unknown;
  readonly publicationAttestation: G1SourcePublicationAttestation;
}

export interface PublishInstructionSkillSourceInput extends PublishG1SourceInput {
  readonly files: unknown;
}

export interface LoadG1PublishedSourceInput {
  readonly workspaceId: string;
  readonly pin: unknown;
}

export interface G1PublishedSourceReceipt {
  readonly schema_version: 'g1-published-source-receipt/1';
  readonly published_resource_kind: G1PublishedSourceKind;
  readonly resource_id: string;
  readonly resource_version_id: string;
  readonly contract_hash: string;
  readonly dependency_manifest_hash: string;
}

export interface G1SourceBoundary {
  publishAgentStrategySource(input: PublishG1SourceInput): Promise<G1PublishedSourceReceipt>;
  publishInstructionSkillSource(
    input: PublishInstructionSkillSourceInput,
  ): Promise<G1PublishedSourceReceipt>;
  publishKnowledgeIndexGeneration(input: PublishG1SourceInput): Promise<G1PublishedSourceReceipt>;
  publishDatabaseOperationRelease(input: PublishG1SourceInput): Promise<G1PublishedSourceReceipt>;
  publishPluginToolRelease(input: PublishG1SourceInput): Promise<G1PublishedSourceReceipt>;
  publishA2aAgentRelease(input: PublishG1SourceInput): Promise<G1PublishedSourceReceipt>;
  publishSkillPackRelease(input: PublishG1SourceInput): Promise<G1PublishedSourceReceipt>;
  loadPublishedSource(input: LoadG1PublishedSourceInput): Promise<PreparedG1Source>;
}

const documentInputKeys = Object.freeze(['document', 'publicationAttestation', 'workspaceId']);
const instructionInputKeys = Object.freeze([
  'document',
  'files',
  'publicationAttestation',
  'workspaceId',
]);
const loadInputKeys = Object.freeze(['pin', 'workspaceId']);
const g1Kinds = new Set<G1PublishedSourceKind>([
  'AGENT_STRATEGY_RELEASE',
  'INSTRUCTION_SKILL_RELEASE',
  'KNOWLEDGE_INDEX_GENERATION',
  'DATABASE_OPERATION_RELEASE',
  'PLUGIN_TOOL_RELEASE',
  'A2A_AGENT_RELEASE',
  'SKILL_PACK_RELEASE',
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const verifierPattern = /^[0-9a-f]{64}$/u;

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function snapshotInput(input: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  try {
    const snapshot = boundedDataSnapshot(input, 'source');
    if (
      !hasExactKeys(snapshot, expectedKeys) ||
      typeof snapshot.workspaceId !== 'string' ||
      snapshot.workspaceId.length === 0 ||
      (expectedKeys.includes('publicationAttestation') &&
        (!hasExactKeys(snapshot.publicationAttestation, ['attestationId', 'verifierHex']) ||
          typeof snapshot.publicationAttestation.attestationId !== 'string' ||
          !uuidPattern.test(snapshot.publicationAttestation.attestationId) ||
          typeof snapshot.publicationAttestation.verifierHex !== 'string' ||
          !verifierPattern.test(snapshot.publicationAttestation.verifierHex)))
    ) {
      throw new Error('boundary input shape is invalid');
    }
    return snapshot;
  } catch {
    throw new G1SourceBoundaryError('G1_SOURCE_BOUNDARY_INPUT_INVALID');
  }
}

async function loadTrust(
  transaction: G1SourceDatabaseTransaction,
  workspaceId: string,
  kind: G1PublishedSourceKind,
): Promise<unknown> {
  const loadedTrust =
    kind === 'INSTRUCTION_SKILL_RELEASE'
      ? await transaction.loadTrustedInstructionSigners(workspaceId)
      : null;
  return boundedDataSnapshot(loadedTrust, 'source');
}

async function loadRegisteredPins(
  transaction: G1SourceDatabaseTransaction,
  workspaceId: string,
  requestedPins: readonly unknown[],
): Promise<readonly unknown[]> {
  const loadedPins = await transaction.loadRegisteredDependencyPins(workspaceId, requestedPins);
  if (!Array.isArray(loadedPins)) throw new Error('registry loader returned a non-array result');
  const registeredPins = boundedDataSnapshot(loadedPins, 'source');
  if (!Array.isArray(registeredPins)) throw new Error('registry snapshot is not an array');
  return registeredPins;
}

function snapshotStorageDependencies(input: unknown): {
  readonly storage: unknown;
  readonly dependencyPins: readonly unknown[];
} {
  const storage = boundedDataSnapshot(input, 'closure');
  if (typeof storage !== 'object' || storage === null || Array.isArray(storage)) {
    throw new Error('stored source is not an object');
  }
  const manifest = Reflect.get(storage, 'dependency_manifest');
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error('stored dependency manifest is not an object');
  }
  const dependencyPins = Reflect.get(manifest, 'dependencies');
  if (!Array.isArray(dependencyPins)) {
    throw new Error('stored dependency manifest has no dependency array');
  }
  return { storage, dependencyPins };
}

function prepareSource(
  kind: G1PublishedSourceKind,
  workspaceId: string,
  document: unknown,
  files: unknown,
  trust: unknown,
): PreparedG1Source {
  switch (kind) {
    case 'AGENT_STRATEGY_RELEASE':
      return prepareAgentStrategySource({
        schema_version: 'agent-strategy-source-candidate/1',
        workspace_id: workspaceId,
        document,
      });
    case 'INSTRUCTION_SKILL_RELEASE':
      return prepareInstructionSkillSource(
        {
          schema_version: 'instruction-skill-source-candidate/1',
          workspace_id: workspaceId,
          document,
          files,
        },
        trust,
      );
    case 'SKILL_PACK_RELEASE':
      return prepareSkillPackSource({
        schema_version: 'skill-pack-source-candidate/1',
        workspace_id: workspaceId,
        document,
      });
    case 'KNOWLEDGE_INDEX_GENERATION':
    case 'DATABASE_OPERATION_RELEASE':
    case 'PLUGIN_TOOL_RELEASE':
    case 'A2A_AGENT_RELEASE': {
      const source = prepareLeafResourceSource({
        schema_version: 'leaf-resource-source-candidate/1',
        workspace_id: workspaceId,
        document,
      });
      if (source.full_pin.published_resource_kind !== kind) {
        throw new Error('prepared leaf kind differs from the fixed publisher kind');
      }
      return source;
    }
  }
}

function receipt(source: PreparedG1PublishedSourceStorageV1): G1PublishedSourceReceipt {
  return Object.freeze({
    schema_version: 'g1-published-source-receipt/1' as const,
    published_resource_kind: source.full_pin.published_resource_kind as G1PublishedSourceKind,
    resource_id: source.full_pin.resource_id,
    resource_version_id: source.full_pin.resource_version_id,
    contract_hash: source.full_pin.contract_hash,
    dependency_manifest_hash: source.dependency_manifest.manifest_hash,
  });
}

export function createG1SourceBoundary(
  dependencies: G1SourceBoundaryDependencies,
): G1SourceBoundary {
  const withTransaction: G1SourceBoundaryDependencies['withTransaction'] = (callback) =>
    dependencies.withTransaction(callback);

  async function publish(
    kind: G1PublishedSourceKind,
    rawInput: unknown,
    instruction: boolean,
    persist: (
      transaction: G1SourceDatabaseTransaction,
      source: PreparedG1PublishedSourceStorageV1,
      attestation: G1SourcePublicationAttestation,
    ) => Promise<string>,
  ): Promise<G1PublishedSourceReceipt> {
    const input = snapshotInput(rawInput, instruction ? instructionInputKeys : documentInputKeys);
    const workspaceId = input.workspaceId as string;
    const publicationAttestation = input.publicationAttestation as G1SourcePublicationAttestation;
    try {
      return await withTransaction(async (transaction) => {
        let trust: unknown;
        try {
          trust = await loadTrust(transaction, workspaceId, kind);
        } catch {
          throw new G1SourceBoundaryError('G1_SOURCE_PERSISTENCE_FAILED');
        }

        let prepared: PreparedG1Source;
        try {
          prepared = prepareSource(
            kind,
            workspaceId,
            input.document,
            instruction ? input.files : undefined,
            trust,
          );
          if (prepared.full_pin.published_resource_kind !== kind) {
            throw new Error('prepared source kind differs from the fixed publisher kind');
          }
        } catch {
          throw new G1SourceBoundaryError('G1_SOURCE_PREPARATION_REJECTED');
        }

        let registeredPins: readonly unknown[];
        try {
          registeredPins = await loadRegisteredPins(
            transaction,
            workspaceId,
            prepared.dependency_manifest.dependencies,
          );
        } catch {
          throw new G1SourceBoundaryError('G1_SOURCE_PERSISTENCE_FAILED');
        }

        let storage: PreparedG1PublishedSourceStorageV1;
        try {
          storage = prepareG1PublishedSourceStorage(prepared, registeredPins, trust);
        } catch {
          throw new G1SourceBoundaryError('G1_SOURCE_PREPARATION_REJECTED');
        }

        let persistedVersionId: string;
        try {
          persistedVersionId = await persist(transaction, storage, publicationAttestation);
        } catch {
          throw new G1SourceBoundaryError('G1_SOURCE_PERSISTENCE_FAILED');
        }
        if (persistedVersionId !== storage.full_pin.resource_version_id) {
          throw new G1SourceBoundaryError('G1_SOURCE_PERSISTENCE_FAILED');
        }
        return receipt(storage);
      });
    } catch (error) {
      if (error instanceof G1SourceBoundaryError) throw error;
      throw new G1SourceBoundaryError('G1_SOURCE_PERSISTENCE_FAILED');
    }
  }

  return Object.freeze({
    publishAgentStrategySource: (input: PublishG1SourceInput) =>
      publish('AGENT_STRATEGY_RELEASE', input, false, (transaction, source, attestation) =>
        transaction.publishAgentStrategySource(source, attestation),
      ),
    publishInstructionSkillSource: (input: PublishInstructionSkillSourceInput) =>
      publish('INSTRUCTION_SKILL_RELEASE', input, true, (transaction, source, attestation) =>
        transaction.publishInstructionSkillSource(source, attestation),
      ),
    publishKnowledgeIndexGeneration: (input: PublishG1SourceInput) =>
      publish('KNOWLEDGE_INDEX_GENERATION', input, false, (transaction, source, attestation) =>
        transaction.publishKnowledgeIndexGeneration(source, attestation),
      ),
    publishDatabaseOperationRelease: (input: PublishG1SourceInput) =>
      publish('DATABASE_OPERATION_RELEASE', input, false, (transaction, source, attestation) =>
        transaction.publishDatabaseOperationRelease(source, attestation),
      ),
    publishPluginToolRelease: (input: PublishG1SourceInput) =>
      publish('PLUGIN_TOOL_RELEASE', input, false, (transaction, source, attestation) =>
        transaction.publishPluginToolRelease(source, attestation),
      ),
    publishA2aAgentRelease: (input: PublishG1SourceInput) =>
      publish('A2A_AGENT_RELEASE', input, false, (transaction, source, attestation) =>
        transaction.publishA2aAgentRelease(source, attestation),
      ),
    publishSkillPackRelease: (input: PublishG1SourceInput) =>
      publish('SKILL_PACK_RELEASE', input, false, (transaction, source, attestation) =>
        transaction.publishSkillPackRelease(source, attestation),
      ),
    loadPublishedSource: async (rawInput: LoadG1PublishedSourceInput) => {
      const input = snapshotInput(rawInput, loadInputKeys);
      const workspaceId = input.workspaceId as string;
      const pinResult = PublishedResourcePinV1Schema.safeParse(input.pin);
      if (
        !pinResult.success ||
        pinResult.data.workspace_id !== workspaceId ||
        !g1Kinds.has(pinResult.data.published_resource_kind as G1PublishedSourceKind)
      ) {
        throw new G1SourceBoundaryError('G1_SOURCE_BOUNDARY_INPUT_INVALID');
      }
      const pin = Object.freeze(pinResult.data);
      const kind = pin.published_resource_kind as G1PublishedSourceKind;
      try {
        return await withTransaction(async (transaction) => {
          try {
            const loadedStorage = await transaction.loadPublishedG1Source(pin);
            const { storage, dependencyPins } = snapshotStorageDependencies(loadedStorage);
            const trust = await loadTrust(transaction, workspaceId, kind);
            const registeredPins = await loadRegisteredPins(
              transaction,
              workspaceId,
              dependencyPins,
            );
            return verifyG1PublishedSourceStorage(pin, storage, registeredPins, trust);
          } catch {
            throw new G1SourceBoundaryError('G1_SOURCE_READBACK_REJECTED');
          }
        });
      } catch (error) {
        if (error instanceof G1SourceBoundaryError) throw error;
        throw new G1SourceBoundaryError('G1_SOURCE_READBACK_REJECTED');
      }
    },
  });
}
