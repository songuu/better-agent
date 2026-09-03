import { z } from 'zod';

import { UuidV1Schema } from './auth-v1.js';
import {
  CanonicalEgressRuleV1Schema,
  CapabilityRequirementsV1Schema,
} from './capability-policy-v1.js';
import { OperationContractSourceV1Schema } from './operation-contract-source-v1.js';
import {
  hasUniqueBy,
  hasUniqueStrings,
  PostgresTextV1Schema,
  Sha256HexV1Schema,
} from './primitives.js';

const Text = PostgresTextV1Schema.min(1).max(4_096);
const Revision = Text.refine(
  (value) => !['latest', 'floating_latest'].includes(value.toLowerCase()),
);
const Id = UuidV1Schema.refine((value) => value === value.toLowerCase());
const Hash = Sha256HexV1Schema.length(71);
const Identifier = Text.max(63).regex(/^[a-z_][a-z0-9_]*$(?![\s\S])/u);
const Names = z.array(Identifier).min(1).max(128).refine(hasUniqueStrings);
const Classification = z.enum(['public', 'internal', 'confidential', 'restricted']);
const Timeout = z.number().int().min(1).max(300_000);
const Predicate = z.strictObject({
  column: Identifier,
  operator: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in']),
  parameter: Identifier,
});

export const LeafCapabilityRequirementsV1Schema = CapabilityRequirementsV1Schema.omit({
  operation_contract_hashes: true,
  side_effect_class: true,
  approval_required: true,
}).extend({ schema_version: z.literal('leaf-capability-requirements/1') });

const common = {
  resource_id: Id,
  resource_version_id: Id,
  manual: z.strictObject({ description: Text, input_description: Text.optional() }),
  operation: OperationContractSourceV1Schema,
  requirements: LeafCapabilityRequirementsV1Schema,
};

export const CapabilityNetworkTransportV1Schema = z.strictObject({
  schema_version: z.literal('capability-network-transport/1'),
  protocol: z.enum(['http_json', 'mcp_streamable_http', 'a2a_jsonrpc']),
  request: CanonicalEgressRuleV1Schema.refine(
    (value) =>
      value.host.match === 'exact' &&
      value.path.match === 'exact' &&
      value.methods.length === 1 &&
      value.redirects.mode === 'deny',
  ),
  timeout_ms: Timeout,
  max_response_bytes: z.number().int().min(1).max(8_388_608),
  remote_identity: z.strictObject({ identity_id: Text, revision: Revision, identity_hash: Hash }),
  authentication: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('none') }),
    z.strictObject({
      mode: z.literal('credential'),
      requirement_id: Text,
      provider_id: Text,
      audience: Text,
    }),
  ]),
});

export const KnowledgeIndexGenerationSourceV1Schema = z.strictObject({
  ...common,
  schema_version: z.literal('knowledge-index-generation-source/1'),
  source_manifest: z.strictObject({
    schema_version: z.literal('knowledge-source-manifest/1'),
    sources: z
      .array(z.strictObject({ source_id: Id, source_release_id: Id, content_hash: Hash }))
      .min(1)
      .max(1_024)
      .refine((values) => hasUniqueBy(values, (value) => value.source_id)),
  }),
  ingestion: z
    .strictObject({
      schema_version: z.literal('knowledge-ingestion-contract/1'),
      parser_version: Revision,
      implementation_digest: Hash,
      chunk_size: z.number().int().min(1).max(65_536),
      chunk_overlap: z.number().int().nonnegative().max(65_535),
    })
    .refine((value) => value.chunk_overlap < value.chunk_size),
  embedding: z.strictObject({
    schema_version: z.literal('knowledge-embedding-contract/1'),
    provider_id: Text,
    model_id: Text,
    model_revision: Revision,
    dimensions: z.number().int().min(1).max(65_536),
    metric: z.enum(['cosine', 'inner_product', 'l2']),
  }),
  retrieval: z.strictObject({
    schema_version: z.literal('knowledge-retrieval-contract/1'),
    algorithm: z.enum(['vector', 'hybrid']),
    top_k: z.number().int().min(1).max(1_000),
    max_context_tokens: z.number().int().min(1).max(1_048_576),
    score_threshold: z.number().min(0).max(1),
    include_metadata_fields: z.array(Text).max(128).refine(hasUniqueStrings),
  }),
  rerank: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('none') }),
    z.strictObject({
      mode: z.literal('model'),
      provider_id: Text,
      model_id: Text,
      model_revision: Revision,
      top_n: z.number().int().min(1).max(1_000),
    }),
  ]),
  metadata_filter_policy: z.strictObject({
    schema_version: z.literal('knowledge-filter-policy/1'),
    enforce_workspace: z.literal(true),
    enforce_document_acl: z.literal(true),
    allowed_fields: z
      .array(
        z
          .strictObject({
            name: Text,
            value_type: z.enum(['string', 'number', 'boolean']),
            operators: z
              .array(z.enum(['eq', 'in', 'lt', 'lte', 'gt', 'gte']))
              .min(1)
              .max(6)
              .refine(hasUniqueStrings),
          })
          .refine(
            (field) =>
              field.value_type === 'number' ||
              field.operators.every((op) => op === 'eq' || op === 'in'),
          ),
      )
      .max(128)
      .refine((values) => hasUniqueBy(values, (value) => value.name)),
  }),
  index_manifest: z.strictObject({
    schema_version: z.literal('knowledge-index-manifest/1'),
    shard_hashes: z.array(Hash).min(1).max(1_024).refine(hasUniqueStrings),
    document_count: z.number().int().nonnegative().safe(),
  }),
});

export const DatabaseOperationSourceV1Schema = z.strictObject({
  ...common,
  schema_version: z.literal('database-operation-source/1'),
  connector: z.strictObject({
    schema_version: z.literal('database-connector-identity/1'),
    connector_id: Id,
    connector_revision_id: Id,
    provider_id: Text,
    dialect: z.literal('postgresql16'),
    contract_hash: Hash,
  }),
  table: z.strictObject({
    schema_version: z.literal('database-table-contract/1'),
    table_revision_id: Id,
    schema_name: Identifier,
    table_name: Identifier,
    tenant_column: Identifier,
    columns: z
      .array(
        z.strictObject({
          name: Identifier,
          data_type: z.enum([
            'uuid',
            'text',
            'boolean',
            'int4',
            'int8',
            'float8',
            'numeric',
            'timestamptz',
          ]),
          nullable: z.boolean(),
          data_classification: Classification,
        }),
      )
      .min(1)
      .max(128)
      .refine((values) => hasUniqueBy(values, (value) => value.name)),
  }),
  query: z.strictObject({
    schema_version: z.literal('database-select/1'),
    table_revision_id: Id,
    select_columns: Names,
    predicates: z.array(Predicate).max(128),
    order_by: z
      .array(z.strictObject({ column: Identifier, direction: z.enum(['asc', 'desc']) }))
      .max(128)
      .refine((values) => hasUniqueBy(values, (value) => value.column)),
    max_rows: z.number().int().min(1).max(500),
    timeout_ms: Timeout,
  }),
  row_policy: z.strictObject({
    schema_version: z.literal('database-row-policy/1'),
    enforce_workspace: z.literal(true),
    principal_filters: z
      .array(
        z.strictObject({
          column: Identifier,
          principal_field: z.enum(['subject_id', 'workspace_id']),
        }),
      )
      .max(128)
      .refine((values) => hasUniqueBy(values, (value) => value.column)),
  }),
});

/** Additional predicates are ANDed with, never substituted for, the sealed row policy. */
export const DatabaseAdditionalFilterV1Schema = z.strictObject({
  schema_version: z.literal('database-additional-filter/1'),
  predicates: z.array(Predicate).min(1).max(128),
});
export const DatabaseAllowedTableV1Schema = z.strictObject({
  table_revision_id: Id,
  columns: Names,
});

export const PluginToolSourceV1Schema = z.strictObject({
  ...common,
  schema_version: z.literal('plugin-tool-source/1'),
  provider_id: Text,
  provider_tool_name: Text,
  transport: CapabilityNetworkTransportV1Schema,
  implementation_digest: Hash,
  sandbox_profile_id: Revision,
  tool_list: z.strictObject({
    schema_version: z.literal('plugin-tool-list/1'),
    operations: z
      .array(OperationContractSourceV1Schema)
      .min(1)
      .max(128)
      .refine((values) => hasUniqueBy(values, (value) => value.operation_id)),
  }),
});

/** Internal frozen projection, not a claim of conformance to a remote A2A protocol version. */
export const A2aAgentSourceV1Schema = z.strictObject({
  ...common,
  schema_version: z.literal('a2a-agent-source/1'),
  provider_id: Text,
  remote_skill_id: Text,
  transport: CapabilityNetworkTransportV1Schema,
  agent_card: z.strictObject({
    schema_version: z.literal('a2a-agent-card-contract/1'),
    agent_id: Text,
    revision: Revision,
    skills: z
      .array(z.strictObject({ skill_id: Text, operation: OperationContractSourceV1Schema }))
      .min(1)
      .max(128)
      .refine((values) => hasUniqueBy(values, (value) => value.skill_id)),
  }),
});

export const LeafResourceDocumentV1Schema = z.discriminatedUnion('schema_version', [
  KnowledgeIndexGenerationSourceV1Schema,
  DatabaseOperationSourceV1Schema,
  PluginToolSourceV1Schema,
  A2aAgentSourceV1Schema,
]);
export const LeafResourceSourceCandidateV1Schema = z.strictObject({
  schema_version: z.literal('leaf-resource-source-candidate/1'),
  workspace_id: Id,
  document: LeafResourceDocumentV1Schema,
});

export type LeafResourceDocumentV1 = z.infer<typeof LeafResourceDocumentV1Schema>;
export type DatabaseOperationSourceV1 = z.infer<typeof DatabaseOperationSourceV1Schema>;
export type KnowledgeIndexGenerationSourceV1 = z.infer<
  typeof KnowledgeIndexGenerationSourceV1Schema
>;
export type PluginToolSourceV1 = z.infer<typeof PluginToolSourceV1Schema>;
export type A2aAgentSourceV1 = z.infer<typeof A2aAgentSourceV1Schema>;
