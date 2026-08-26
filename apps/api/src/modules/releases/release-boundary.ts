import {
  preparePublishedResource,
  type PreparedPublishedResourceV1,
  type SupportedPublishedResourceKindV1,
} from '@better-agent/release-core';

export type ReleaseBoundaryErrorCode =
  | 'RELEASE_BOUNDARY_INPUT_INVALID'
  | 'RELEASE_PREPARATION_REJECTED'
  | 'RELEASE_PERSISTENCE_FAILED';

export class ReleaseBoundaryError extends Error {
  constructor(readonly code: ReleaseBoundaryErrorCode) {
    super('release boundary rejected the command');
    this.name = 'ReleaseBoundaryError';
  }
}

export interface ReleaseDatabaseTransaction {
  loadRegisteredDependencyPins(workspaceId: string): Promise<readonly unknown[]>;
  publishAgentStrategyRelease(prepared: PreparedPublishedResourceV1): Promise<string>;
  publishAgentRelease(prepared: PreparedPublishedResourceV1): Promise<string>;
  publishFlowVersion(prepared: PreparedPublishedResourceV1): Promise<string>;
  publishExperienceRelease(prepared: PreparedPublishedResourceV1): Promise<string>;
  publishAgentDeploymentRevision(prepared: PreparedPublishedResourceV1): Promise<string>;
  publishFlowDeploymentRevision(prepared: PreparedPublishedResourceV1): Promise<string>;
}

export interface ReleaseBoundaryDependencies {
  withTransaction<T>(callback: (transaction: ReleaseDatabaseTransaction) => Promise<T>): Promise<T>;
}

export interface PublishResourceBoundaryInput {
  readonly workspaceId: string;
  readonly document: unknown;
}

export interface PublishedResourceReceipt {
  readonly schema_version: 'published-resource-receipt/1';
  readonly published_resource_kind: SupportedPublishedResourceKindV1;
  readonly resource_id: string;
  readonly resource_version_id: string;
  readonly contract_hash: string;
  readonly dependency_manifest_hash: string;
}

export interface ReleaseBoundary {
  publishAgentStrategyRelease(
    input: PublishResourceBoundaryInput,
  ): Promise<PublishedResourceReceipt>;
  publishAgentRelease(input: PublishResourceBoundaryInput): Promise<PublishedResourceReceipt>;
  publishFlowVersion(input: PublishResourceBoundaryInput): Promise<PublishedResourceReceipt>;
  publishExperienceRelease(input: PublishResourceBoundaryInput): Promise<PublishedResourceReceipt>;
  publishAgentDeploymentRevision(
    input: PublishResourceBoundaryInput,
  ): Promise<PublishedResourceReceipt>;
  publishFlowDeploymentRevision(
    input: PublishResourceBoundaryInput,
  ): Promise<PublishedResourceReceipt>;
}

const publishInputKeys = Object.freeze(['document', 'workspaceId']);

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function assertInput(input: PublishResourceBoundaryInput): void {
  if (!hasExactKeys(input, publishInputKeys) || typeof input.workspaceId !== 'string') {
    throw new ReleaseBoundaryError('RELEASE_BOUNDARY_INPUT_INVALID');
  }
}

async function prepareAndPersist(
  kind: SupportedPublishedResourceKindV1,
  input: PublishResourceBoundaryInput,
  withTransaction: ReleaseBoundaryDependencies['withTransaction'],
  persist: (
    transaction: ReleaseDatabaseTransaction,
    prepared: PreparedPublishedResourceV1,
  ) => Promise<string>,
  expectedDeploymentSchemaVersion?: 'agent-deployment/1' | 'flow-deployment/1',
): Promise<PublishedResourceReceipt> {
  assertInput(input);
  try {
    return await withTransaction(async (transaction) => {
      let registeredDependencyPins: readonly unknown[];
      try {
        registeredDependencyPins = await transaction.loadRegisteredDependencyPins(
          input.workspaceId,
        );
        if (!Array.isArray(registeredDependencyPins)) {
          throw new Error('dependency pin loader returned a non-array result');
        }
      } catch {
        throw new ReleaseBoundaryError('RELEASE_PERSISTENCE_FAILED');
      }

      let prepared: PreparedPublishedResourceV1;
      try {
        prepared = preparePublishedResource({
          schema_version: 'publishable-resource-candidate/1',
          source_kind: 'sealed_candidate',
          workspace_id: input.workspaceId,
          declared_kind: kind,
          document: input.document,
          registered_dependency_pins: registeredDependencyPins,
        });
        if (expectedDeploymentSchemaVersion !== undefined) {
          const document = JSON.parse(prepared.canonical_document) as unknown;
          if (
            typeof document !== 'object' ||
            document === null ||
            Array.isArray(document) ||
            Reflect.get(document, 'schema_version') !== expectedDeploymentSchemaVersion
          ) {
            throw new Error('prepared Deployment kind mismatch');
          }
        }
      } catch {
        throw new ReleaseBoundaryError('RELEASE_PREPARATION_REJECTED');
      }

      let persistedVersionId: string;
      try {
        persistedVersionId = await persist(transaction, prepared);
      } catch {
        throw new ReleaseBoundaryError('RELEASE_PERSISTENCE_FAILED');
      }
      if (persistedVersionId !== prepared.full_pin.resource_version_id) {
        throw new ReleaseBoundaryError('RELEASE_PERSISTENCE_FAILED');
      }

      return Object.freeze({
        schema_version: 'published-resource-receipt/1' as const,
        published_resource_kind: kind,
        resource_id: prepared.full_pin.resource_id,
        resource_version_id: prepared.full_pin.resource_version_id,
        contract_hash: prepared.full_pin.contract_hash,
        dependency_manifest_hash: prepared.dependency_manifest.manifest_hash,
      });
    });
  } catch (error) {
    if (error instanceof ReleaseBoundaryError) throw error;
    throw new ReleaseBoundaryError('RELEASE_PERSISTENCE_FAILED');
  }
}

export function createReleaseBoundary(dependencies: ReleaseBoundaryDependencies): ReleaseBoundary {
  const withTransaction: ReleaseBoundaryDependencies['withTransaction'] = (callback) =>
    dependencies.withTransaction(callback);

  return Object.freeze({
    publishAgentStrategyRelease: (input: PublishResourceBoundaryInput) =>
      prepareAndPersist('AGENT_STRATEGY_RELEASE', input, withTransaction, (transaction, prepared) =>
        transaction.publishAgentStrategyRelease(prepared),
      ),
    publishAgentRelease: (input: PublishResourceBoundaryInput) =>
      prepareAndPersist('AGENT_RELEASE', input, withTransaction, (transaction, prepared) =>
        transaction.publishAgentRelease(prepared),
      ),
    publishFlowVersion: (input: PublishResourceBoundaryInput) =>
      prepareAndPersist('FLOW_VERSION', input, withTransaction, (transaction, prepared) =>
        transaction.publishFlowVersion(prepared),
      ),
    publishExperienceRelease: (input: PublishResourceBoundaryInput) =>
      prepareAndPersist('EXPERIENCE_RELEASE', input, withTransaction, (transaction, prepared) =>
        transaction.publishExperienceRelease(prepared),
      ),
    publishAgentDeploymentRevision: (input: PublishResourceBoundaryInput) =>
      prepareAndPersist(
        'DEPLOYMENT_REVISION',
        input,
        withTransaction,
        (transaction, prepared) => transaction.publishAgentDeploymentRevision(prepared),
        'agent-deployment/1',
      ),
    publishFlowDeploymentRevision: (input: PublishResourceBoundaryInput) =>
      prepareAndPersist(
        'DEPLOYMENT_REVISION',
        input,
        withTransaction,
        (transaction, prepared) => transaction.publishFlowDeploymentRevision(prepared),
        'flow-deployment/1',
      ),
  });
}
