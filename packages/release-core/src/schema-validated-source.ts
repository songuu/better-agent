import {
  prepareAgentStrategySource,
  type PreparedAgentStrategySourceV1,
} from './agent-strategy-source.js';
import {
  prepareOperationContractSource,
  type PreparedOperationContractSourceV1,
} from './operation-contract-source.js';
import { deepFreezeJson } from './dependency-manifest.js';
import { canonicalSha256 } from './hash.js';
import { JSON_SCHEMA_VALIDATOR_PROFILE } from './json-schema-profile.mjs';
import { prepareJsonSchemaContract, validateJsonSchemaInstance } from './json-schema-validation.js';
import { mismatchedSource, snapshotSource, sourceEqual } from './source-contract-data.js';

export interface SourceSchemaValidationEvidenceV1 {
  readonly schema_version: 'source-schema-validation-evidence/1';
  readonly source_artifact_hash: `sha256:${string}`;
  readonly validator_profile_hash: `sha256:${string}`;
  readonly schemas: readonly {
    readonly field: string;
    readonly schema_hash: `sha256:${string}`;
    readonly contract_hash: `sha256:${string}`;
  }[];
  readonly instances: readonly {
    readonly field: string;
    readonly schema_field: string;
    readonly instance_hash: `sha256:${string}`;
  }[];
}
interface SchemaValidatedSource<Version extends string, Source> {
  readonly schema_version: Version;
  readonly source_artifact: Source;
  readonly evidence: SourceSchemaValidationEvidenceV1;
  readonly validation_hash: `sha256:${string}`;
}
export type SchemaValidatedOperationSourceV1 = SchemaValidatedSource<
  'schema-validated-operation-source/1',
  PreparedOperationContractSourceV1
>;
export type SchemaValidatedStrategySourceV1 = SchemaValidatedSource<
  'schema-validated-strategy-source/1',
  PreparedAgentStrategySourceV1
>;

async function checkSchemas(
  entries: readonly (readonly [field: string, schema: unknown])[],
): Promise<SourceSchemaValidationEvidenceV1['schemas']> {
  const schemas = [];
  // Sequential admission avoids consuming the entire worker budget for one source.
  for (const [field, schema] of entries) {
    const contract = await prepareJsonSchemaContract(schema);
    schemas.push({
      field,
      schema_hash: contract.schema_hash,
      contract_hash: contract.contract_hash,
    });
  }
  return schemas;
}
function finish<Version extends string, Source>(
  schema_version: Version,
  source_artifact: Source,
  schemas: SourceSchemaValidationEvidenceV1['schemas'],
  instances: SourceSchemaValidationEvidenceV1['instances'],
): SchemaValidatedSource<Version, Source> {
  const evidence: SourceSchemaValidationEvidenceV1 = {
    schema_version: 'source-schema-validation-evidence/1',
    source_artifact_hash: canonicalSha256(source_artifact),
    validator_profile_hash: canonicalSha256(JSON_SCHEMA_VALIDATOR_PROFILE),
    schemas,
    instances,
  };
  const result = {
    schema_version,
    source_artifact,
    evidence,
    validation_hash: canonicalSha256(evidence),
  };
  snapshotSource(result);
  return deepFreezeJson(result);
}

/** Schema validation evidence, not publisher provenance, registry admission or implementation verification. */
export async function prepareSchemaValidatedOperationSource(
  input: unknown,
): Promise<SchemaValidatedOperationSourceV1> {
  const artifact = prepareOperationContractSource(input);
  const entries: [string, unknown][] = [['input_schema', artifact.source.input_schema]];
  if (artifact.source.output_schema !== undefined)
    entries.push(['output_schema', artifact.source.output_schema]);
  const schemas = await checkSchemas(entries);
  return finish('schema-validated-operation-source/1', artifact, schemas, []);
}
export async function verifySchemaValidatedOperationSource(
  expected: unknown,
  input: unknown,
): Promise<SchemaValidatedOperationSourceV1> {
  const snapshot = snapshotSource(expected);
  const actual = await prepareSchemaValidatedOperationSource(input);
  if (!sourceEqual(snapshot, actual)) mismatchedSource();
  return actual;
}

/** Validate declared ABI schemas and real config; no Strategy execution or sandbox attestation occurs. */
export async function prepareSchemaValidatedStrategySource(
  input: unknown,
): Promise<SchemaValidatedStrategySourceV1> {
  const artifact = prepareAgentStrategySource(input);
  const fields = [
    'config_schema',
    'input_schema',
    'state_schema',
    'decision_schema',
    'observation_schema',
  ] as const;
  const schemas = await checkSchemas(fields.map((field) => [field, artifact.document[field]]));
  await validateJsonSchemaInstance(artifact.document.config_schema, artifact.document.config);
  return finish('schema-validated-strategy-source/1', artifact, schemas, [
    {
      field: 'config',
      schema_field: 'config_schema',
      instance_hash: canonicalSha256(artifact.document.config),
    },
  ]);
}
export async function verifySchemaValidatedStrategySource(
  expected: unknown,
  input: unknown,
): Promise<SchemaValidatedStrategySourceV1> {
  const snapshot = snapshotSource(expected);
  const actual = await prepareSchemaValidatedStrategySource(input);
  if (!sourceEqual(snapshot, actual)) mismatchedSource();
  return actual;
}
