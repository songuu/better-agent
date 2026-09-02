import {
  prepareAgentStrategySource,
  type PreparedAgentStrategySourceV1,
} from './agent-strategy-source.js';
import {
  prepareOperationContractSource,
  type PreparedOperationContractSourceV1,
} from './operation-contract-source.js';
import { deepFreezeJson } from './dependency-manifest.js';
import { compareCanonicalStrings } from './dependency-manifest.js';
import { prepareExecutableSource, type PreparedExecutableSourceV1 } from './executable-source.js';
import {
  prepareLeafResourceSource,
  type PreparedLeafResourceSourceV1,
} from './leaf-resource-source.js';
import { prepareSkillPackSource, type PreparedSkillPackSourceV1 } from './skill-pack-source.js';
import { canonicalSha256 } from './hash.js';
import { JSON_SCHEMA_VALIDATOR_PROFILE } from './json-schema-profile.mjs';
import {
  prepareJsonSchemaContractSummaries,
  validateJsonSchemaInstance,
} from './json-schema-validation.js';
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

interface SchemaEvidenceEntryV1 {
  readonly field: string;
  readonly schema_hash: `sha256:${string}`;
  readonly contract_hash: `sha256:${string}`;
}
export interface SourceSchemaSetValidationEvidenceV1 {
  readonly schema_version: 'source-schema-set-validation-evidence/1';
  readonly source_artifact_hash: `sha256:${string}`;
  readonly validator_profile_hash: `sha256:${string}`;
  readonly schema_count: number;
  readonly schema_batches: readonly (readonly SchemaEvidenceEntryV1[])[];
  readonly instances: readonly SourceSchemaValidationEvidenceV1['instances'][number][];
}
interface SchemaValidatedSetSource<Version extends string, Source> {
  readonly schema_version: Version;
  readonly source_artifact: Source;
  readonly evidence: SourceSchemaSetValidationEvidenceV1;
  readonly validation_hash: `sha256:${string}`;
}
export type SchemaValidatedExecutableSourceV1 = SchemaValidatedSetSource<
  'schema-validated-executable-source/1',
  PreparedExecutableSourceV1
>;
export type SchemaValidatedLeafResourceSourceV1 = SchemaValidatedSetSource<
  'schema-validated-leaf-resource-source/1',
  PreparedLeafResourceSourceV1
>;
export type SchemaValidatedSkillPackSourceV1 = SchemaValidatedSetSource<
  'schema-validated-skill-pack-source/1',
  PreparedSkillPackSourceV1
>;

async function checkSchemas(
  entries: readonly (readonly [field: string, schema: unknown])[],
): Promise<SourceSchemaValidationEvidenceV1['schemas']> {
  const contracts = await prepareJsonSchemaContractSummaries(entries.map(([, schema]) => schema));
  return entries.map(([field], index) => {
    const contract = contracts[index];
    if (contract === undefined) throw new Error('schema summary cardinality mismatch');
    return { field, schema_hash: contract.schema_hash, contract_hash: contract.contract_hash };
  });
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

async function finishSet<Version extends string, Source>(
  schema_version: Version,
  source_artifact: Source,
  entries: readonly (readonly [field: string, schema: unknown])[],
): Promise<SchemaValidatedSetSource<Version, Source>> {
  const ordered = [...entries].sort(([left], [right]) => compareCanonicalStrings(left, right));
  const schemas = await checkSchemas(ordered);
  const schema_batches: SchemaEvidenceEntryV1[][] = [];
  for (let index = 0; index < schemas.length; index += 1024)
    schema_batches.push(schemas.slice(index, index + 1024));
  const evidence: SourceSchemaSetValidationEvidenceV1 = {
    schema_version: 'source-schema-set-validation-evidence/1',
    source_artifact_hash: canonicalSha256(source_artifact),
    validator_profile_hash: canonicalSha256(JSON_SCHEMA_VALIDATOR_PROFILE),
    schema_count: schemas.length,
    schema_batches,
    instances: [],
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

type SchemaEntry = [field: string, schema: unknown];
type AnyRecord = Record<string, unknown>;
function record(value: unknown): AnyRecord {
  return value as AnyRecord;
}
function records(value: unknown): AnyRecord[] {
  return value as AnyRecord[];
}
function operationEntries(operation: AnyRecord, base: string): SchemaEntry[] {
  const entries: SchemaEntry[] = [[`${base}/input_schema`, operation.input_schema]];
  if (operation.output_schema !== undefined)
    entries.push([`${base}/output_schema`, operation.output_schema]);
  return entries;
}
function bindingEntries(binding: AnyRecord, base: string): SchemaEntry[] {
  const entries: SchemaEntry[] = [[`${base}/input_schema`, binding.input_schema]];
  if (binding.output_schema !== undefined)
    entries.push([`${base}/output_schema`, binding.output_schema]);
  return entries;
}
function flowGraphEntries(graph: AnyRecord, base: string): SchemaEntry[] {
  const entries: SchemaEntry[] = [];
  for (const [index, node] of records(graph.nodes).entries()) {
    const nodeBase = `${base}/nodes/${index}`;
    entries.push([`${nodeBase}/output_schema`, node.output_schema]);
    if (node.type === 'human_gate')
      entries.push([
        `${nodeBase}/config/gate/decision_schema`,
        record(record(node.config).gate).decision_schema,
      ]);
    if (node.type === 'loop')
      entries.push(
        ...flowGraphEntries(record(record(node.config).body), `${nodeBase}/config/body`),
      );
    if (node.type === 'branch') {
      const config = record(node.config);
      for (const [caseIndex, item] of records(config.cases).entries())
        entries.push(
          ...flowGraphEntries(record(item.graph), `${nodeBase}/config/cases/${caseIndex}/graph`),
        );
      if (config.else_case !== undefined)
        entries.push(
          ...flowGraphEntries(
            record(record(config.else_case).graph),
            `${nodeBase}/config/else_case/graph`,
          ),
        );
    }
  }
  return entries;
}

/** Validates every JSON Schema-bearing field in a normalized Agent or Flow source. */
export async function prepareSchemaValidatedExecutableSource(
  input: unknown,
): Promise<SchemaValidatedExecutableSourceV1> {
  const artifact = prepareExecutableSource(input);
  const document = record(artifact.preimage.document);
  const entries: SchemaEntry[] = [];
  if (artifact.root.pin.published_resource_kind === 'AGENT_RELEASE') {
    entries.push(['/preimage/document/input_contract', document.input_contract]);
    if (document.output_contract !== undefined)
      entries.push(['/preimage/document/output_contract', document.output_contract]);
    for (const [index, gate] of records(document.gate_specs).entries())
      entries.push([
        `/preimage/document/gate_specs/${index}/decision_schema`,
        gate.decision_schema,
      ]);
    for (const [index, binding] of records(document.capability_bindings).entries())
      entries.push(...bindingEntries(binding, `/preimage/document/capability_bindings/${index}`));
  } else {
    entries.push(['/preimage/document/input_schema', document.input_schema]);
    if (document.output_schema !== undefined)
      entries.push(['/preimage/document/output_schema', document.output_schema]);
    entries.push(
      ...flowGraphEntries(record(document.entry_graph), '/preimage/document/entry_graph'),
    );
  }
  return finishSet('schema-validated-executable-source/1', artifact, entries);
}
export async function verifySchemaValidatedExecutableSource(expected: unknown, input: unknown) {
  const snapshot = snapshotSource(expected);
  const actual = await prepareSchemaValidatedExecutableSource(input);
  if (!sourceEqual(snapshot, actual)) mismatchedSource();
  return actual;
}

/** Validates the primary operation and every kind-specific operation declaration. */
export async function prepareSchemaValidatedLeafResourceSource(
  input: unknown,
): Promise<SchemaValidatedLeafResourceSourceV1> {
  const artifact = prepareLeafResourceSource(input);
  const document = record(artifact.document);
  const entries = operationEntries(record(document.operation), '/document/operation');
  if (document.schema_version === 'plugin-tool-source/1')
    for (const [index, operation] of records(record(document.tool_list).operations).entries())
      entries.push(...operationEntries(operation, `/document/tool_list/operations/${index}`));
  if (document.schema_version === 'a2a-agent-source/1')
    for (const [index, skill] of records(record(document.agent_card).skills).entries())
      entries.push(
        ...operationEntries(
          record(skill.operation),
          `/document/agent_card/skills/${index}/operation`,
        ),
      );
  return finishSet('schema-validated-leaf-resource-source/1', artifact, entries);
}
export async function verifySchemaValidatedLeafResourceSource(expected: unknown, input: unknown) {
  const snapshot = snapshotSource(expected);
  const actual = await prepareSchemaValidatedLeafResourceSource(input);
  if (!sourceEqual(snapshot, actual)) mismatchedSource();
  return actual;
}

/** Validates Skill Pack envelope, member Binding and exposure operation schemas. */
export async function prepareSchemaValidatedSkillPackSource(
  input: unknown,
): Promise<SchemaValidatedSkillPackSourceV1> {
  const artifact = prepareSkillPackSource(input);
  const document = record(artifact.document);
  const entries: SchemaEntry[] = [['/document/input_schema', document.input_schema]];
  if (document.output_schema !== undefined)
    entries.push(['/document/output_schema', document.output_schema]);
  for (const [index, binding] of records(document.member_bindings).entries())
    entries.push(...bindingEntries(binding, `/document/member_bindings/${index}`));
  for (const [index, exposure] of records(document.exposures).entries())
    entries.push(
      ...operationEntries(record(exposure.operation), `/document/exposures/${index}/operation`),
    );
  return finishSet('schema-validated-skill-pack-source/1', artifact, entries);
}
export async function verifySchemaValidatedSkillPackSource(expected: unknown, input: unknown) {
  const snapshot = snapshotSource(expected);
  const actual = await prepareSchemaValidatedSkillPackSource(input);
  if (!sourceEqual(snapshot, actual)) mismatchedSource();
  return actual;
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
