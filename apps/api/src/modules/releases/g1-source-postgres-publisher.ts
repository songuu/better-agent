import {
  boundedDataSnapshot,
  type PreparedG1PublishedSourceStorageV1,
} from '@better-agent/release-core';

import type {
  G1SourceDatabaseTransaction,
  G1SourcePublicationAttestation,
} from './g1-source-boundary.js';
import type { G1SourceSqlQueryClient } from './g1-source-postgres-readback.js';

export type G1SourcePostgresPublisher = Pick<
  G1SourceDatabaseTransaction,
  | 'publishAgentStrategySource'
  | 'publishInstructionSkillSource'
  | 'publishKnowledgeIndexGeneration'
  | 'publishDatabaseOperationRelease'
  | 'publishPluginToolRelease'
  | 'publishA2aAgentRelease'
  | 'publishSkillPackRelease'
>;

type PublisherErrorCode = 'INPUT_INVALID' | 'QUERY_FAILED' | 'RECEIPT_INVALID';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const verifierPattern = /^[0-9a-f]{64}$/u;

class G1SourcePostgresPublisherError extends Error {
  constructor(
    readonly code: PublisherErrorCode,
    options?: ErrorOptions,
  ) {
    super(
      code === 'INPUT_INVALID'
        ? 'G1 attested publisher rejected the input'
        : code === 'QUERY_FAILED'
          ? 'G1 attested publisher query failed'
          : 'G1 attested publisher returned an invalid receipt',
      options,
    );
    this.name = 'G1SourcePostgresPublisherError';
  }
}

function snapshotArguments(
  source: PreparedG1PublishedSourceStorageV1,
  attestation: G1SourcePublicationAttestation,
): {
  readonly source: PreparedG1PublishedSourceStorageV1;
  readonly attestation: G1SourcePublicationAttestation;
} {
  try {
    const sourceSnapshot = boundedDataSnapshot(source, 'closure');
    const proofSnapshot = boundedDataSnapshot(attestation, 'identity');
    if (
      typeof sourceSnapshot !== 'object' ||
      sourceSnapshot === null ||
      Array.isArray(sourceSnapshot) ||
      Reflect.get(sourceSnapshot, 'schema_version') !== 'prepared-g1-published-source-storage/1' ||
      typeof proofSnapshot !== 'object' ||
      proofSnapshot === null ||
      Array.isArray(proofSnapshot) ||
      Reflect.ownKeys(proofSnapshot).length !== 2 ||
      !Object.hasOwn(proofSnapshot, 'attestationId') ||
      !Object.hasOwn(proofSnapshot, 'verifierHex') ||
      typeof Reflect.get(proofSnapshot, 'attestationId') !== 'string' ||
      !uuidPattern.test(Reflect.get(proofSnapshot, 'attestationId') as string) ||
      typeof Reflect.get(proofSnapshot, 'verifierHex') !== 'string' ||
      !verifierPattern.test(Reflect.get(proofSnapshot, 'verifierHex') as string)
    ) {
      throw new Error('publisher input shape is invalid');
    }
    return {
      source: sourceSnapshot as PreparedG1PublishedSourceStorageV1,
      attestation: proofSnapshot as unknown as G1SourcePublicationAttestation,
    };
  } catch (error) {
    throw new G1SourcePostgresPublisherError('INPUT_INVALID', { cause: error });
  }
}

async function publish(
  client: G1SourceSqlQueryClient,
  sql: string,
  source: PreparedG1PublishedSourceStorageV1,
  attestation: G1SourcePublicationAttestation,
): Promise<string> {
  const snapshot = snapshotArguments(source, attestation);
  let rows: readonly unknown[];
  try {
    ({ rows } = await client.query(sql, [
      snapshot.attestation.attestationId,
      snapshot.attestation.verifierHex,
      JSON.stringify(snapshot.source),
    ]));
  } catch (error) {
    throw new G1SourcePostgresPublisherError('QUERY_FAILED', { cause: error });
  }
  const [row] = rows;
  if (
    rows.length !== 1 ||
    typeof row !== 'object' ||
    row === null ||
    Array.isArray(row) ||
    Reflect.ownKeys(row).length !== 1 ||
    !Object.hasOwn(row, 'resource_version_id') ||
    typeof Reflect.get(row, 'resource_version_id') !== 'string' ||
    !uuidPattern.test(Reflect.get(row, 'resource_version_id') as string)
  ) {
    throw new G1SourcePostgresPublisherError('RECEIPT_INVALID');
  }
  return Reflect.get(row, 'resource_version_id') as string;
}

export function createG1SourcePostgresPublisher(
  client: G1SourceSqlQueryClient,
): G1SourcePostgresPublisher {
  return Object.freeze({
    publishAgentStrategySource: (source, attestation) =>
      publish(
        client,
        "SELECT app.publish_attested_agent_strategy_source($1::uuid, decode($2, 'hex'), $3::jsonb) AS resource_version_id",
        source,
        attestation,
      ),
    publishInstructionSkillSource: (source, attestation) =>
      publish(
        client,
        "SELECT app.publish_attested_instruction_skill_release($1::uuid, decode($2, 'hex'), $3::jsonb) AS resource_version_id",
        source,
        attestation,
      ),
    publishKnowledgeIndexGeneration: (source, attestation) =>
      publish(
        client,
        "SELECT app.publish_attested_knowledge_index_generation($1::uuid, decode($2, 'hex'), $3::jsonb) AS resource_version_id",
        source,
        attestation,
      ),
    publishDatabaseOperationRelease: (source, attestation) =>
      publish(
        client,
        "SELECT app.publish_attested_database_operation_release($1::uuid, decode($2, 'hex'), $3::jsonb) AS resource_version_id",
        source,
        attestation,
      ),
    publishPluginToolRelease: (source, attestation) =>
      publish(
        client,
        "SELECT app.publish_attested_plugin_tool_release($1::uuid, decode($2, 'hex'), $3::jsonb) AS resource_version_id",
        source,
        attestation,
      ),
    publishA2aAgentRelease: (source, attestation) =>
      publish(
        client,
        "SELECT app.publish_attested_a2a_agent_release($1::uuid, decode($2, 'hex'), $3::jsonb) AS resource_version_id",
        source,
        attestation,
      ),
    publishSkillPackRelease: (source, attestation) =>
      publish(
        client,
        "SELECT app.publish_attested_skill_pack_release($1::uuid, decode($2, 'hex'), $3::jsonb) AS resource_version_id",
        source,
        attestation,
      ),
  });
}
