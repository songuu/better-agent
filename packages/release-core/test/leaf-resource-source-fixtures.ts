import { hashA, hashB, pluginId, pluginReleaseId, workspaceId } from './fixtures.js';

export const leafKinds = [
  'KNOWLEDGE_INDEX_GENERATION',
  'DATABASE_OPERATION_RELEASE',
  'PLUGIN_TOOL_RELEASE',
  'A2A_AGENT_RELEASE',
] as const;
export type LeafKind = (typeof leafKinds)[number];
export function leafOperation(kind: string) {
  return {
    schema_version: 'operation-contract-source/1',
    operation_kind: kind,
    operation_id: 'lookup',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    output_schema: { type: 'array', items: { type: 'string' } },
    side_effect_class: 'safe',
    operation_key_required: false,
    approval_required: false,
  };
}
export function leafRequest() {
  return {
    schema_version: 'canonical-egress-rule/1',
    network_policy: {
      policy_id: 'provider-network',
      policy_hash: hashA,
      address_class: 'public_only',
    },
    scheme: 'https',
    host: { match: 'exact', name: 'api.example.com' },
    port: 443,
    path: { match: 'exact', value: '/invoke' },
    methods: ['POST'],
    dns_resolution: 'revalidate_each_connection',
    redirects: { mode: 'deny', max_hops: 0, strip_cross_origin_credentials: true },
  };
}
export function leafCandidate(kind: LeafKind = 'PLUGIN_TOOL_RELEASE') {
  const network = kind === 'PLUGIN_TOOL_RELEASE' || kind === 'A2A_AGENT_RELEASE';
  const operation = leafOperation(
    {
      KNOWLEDGE_INDEX_GENERATION: 'knowledge_query',
      DATABASE_OPERATION_RELEASE: 'database_operation',
      PLUGIN_TOOL_RELEASE: 'plugin_tool',
      A2A_AGENT_RELEASE: 'subagent_call',
    }[kind],
  );
  const credential = {
    schema_version: 'credential-requirement/1',
    requirement_id: 'provider-access',
    provider_id: 'provider',
    audience: 'provider-api',
    required_scopes: ['invoke'],
    allowed_principal_modes: ['service_principal'],
  };
  const requirements = {
    schema_version: 'leaf-capability-requirements/1',
    credential_requirements: network ? [credential] : [],
    principal_modes: network ? ['service_principal'] : ['none'],
    egress: network ? [leafRequest()] : [],
    readable_data_classification: 'internal',
    output_data_classification: 'internal',
    minimum_limits: {
      calls: 1,
      depth: 0,
      parallelism: 1,
      budget: {
        schema_version: 'capability-budget/1',
        amount_credits: '0',
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        duration_ms: 1,
      },
    },
  };
  const transport = {
    schema_version: 'capability-network-transport/1',
    protocol: kind === 'A2A_AGENT_RELEASE' ? 'a2a_jsonrpc' : 'http_json',
    request: leafRequest(),
    timeout_ms: 1000,
    max_response_bytes: 1_048_576,
    remote_identity: { identity_id: 'provider-server', revision: 'v1', identity_hash: hashA },
    authentication: {
      mode: 'credential',
      requirement_id: 'provider-access',
      provider_id: 'provider',
      audience: 'provider-api',
    },
  };
  const base = {
    resource_id: pluginId,
    resource_version_id: pluginReleaseId,
    manual: { description: 'Look up a record', input_description: 'A query string' },
    operation,
    requirements,
  };
  let document: Record<string, unknown>;
  switch (kind) {
    case 'KNOWLEDGE_INDEX_GENERATION':
      document = {
        ...base,
        schema_version: 'knowledge-index-generation-source/1',
        source_manifest: {
          schema_version: 'knowledge-source-manifest/1',
          sources: [
            { source_id: pluginId, source_release_id: pluginReleaseId, content_hash: hashA },
          ],
        },
        ingestion: {
          schema_version: 'knowledge-ingestion-contract/1',
          parser_version: 'text-parser/1',
          implementation_digest: hashA,
          chunk_size: 500,
          chunk_overlap: 50,
        },
        embedding: {
          schema_version: 'knowledge-embedding-contract/1',
          provider_id: 'embedding-provider',
          model_id: 'embed',
          model_revision: 'v1',
          dimensions: 1536,
          metric: 'cosine',
        },
        retrieval: {
          schema_version: 'knowledge-retrieval-contract/1',
          algorithm: 'vector',
          top_k: 10,
          max_context_tokens: 2000,
          score_threshold: 0.5,
          include_metadata_fields: ['category'],
        },
        rerank: { mode: 'none' },
        metadata_filter_policy: {
          schema_version: 'knowledge-filter-policy/1',
          enforce_workspace: true,
          enforce_document_acl: true,
          allowed_fields: [{ name: 'category', value_type: 'string', operators: ['eq', 'in'] }],
        },
        index_manifest: {
          schema_version: 'knowledge-index-manifest/1',
          shard_hashes: [hashB, hashA],
          document_count: 12,
        },
      };
      break;
    case 'DATABASE_OPERATION_RELEASE':
      document = {
        ...base,
        schema_version: 'database-operation-source/1',
        connector: {
          schema_version: 'database-connector-identity/1',
          connector_id: pluginId,
          connector_revision_id: pluginReleaseId,
          provider_id: 'managed-postgres',
          dialect: 'postgresql16',
          contract_hash: hashA,
        },
        table: {
          schema_version: 'database-table-contract/1',
          table_revision_id: pluginReleaseId,
          schema_name: 'public',
          table_name: 'records',
          tenant_column: 'workspace_id',
          columns: [
            {
              name: 'workspace_id',
              data_type: 'uuid',
              nullable: false,
              data_classification: 'internal',
            },
            { name: 'title', data_type: 'text', nullable: false, data_classification: 'internal' },
            { name: 'score', data_type: 'float8', nullable: true, data_classification: 'public' },
          ],
        },
        query: {
          schema_version: 'database-select/1',
          table_revision_id: pluginReleaseId,
          select_columns: ['title'],
          predicates: [{ column: 'title', operator: 'eq', parameter: 'query' }],
          order_by: [{ column: 'title', direction: 'asc' }],
          max_rows: 50,
          timeout_ms: 1000,
        },
        row_policy: {
          schema_version: 'database-row-policy/1',
          enforce_workspace: true,
          principal_filters: [],
        },
      };
      break;
    case 'PLUGIN_TOOL_RELEASE':
      document = {
        ...base,
        schema_version: 'plugin-tool-source/1',
        provider_id: 'provider',
        provider_tool_name: 'lookup',
        transport,
        implementation_digest: hashA,
        sandbox_profile_id: 'isolated-provider/1',
        tool_list: {
          schema_version: 'plugin-tool-list/1',
          operations: [structuredClone(operation)],
        },
      };
      break;
    case 'A2A_AGENT_RELEASE':
      document = {
        ...base,
        schema_version: 'a2a-agent-source/1',
        provider_id: 'provider',
        remote_skill_id: 'lookup-skill',
        transport,
        agent_card: {
          schema_version: 'a2a-agent-card-contract/1',
          agent_id: 'remote-agent',
          revision: 'v1',
          skills: [{ skill_id: 'lookup-skill', operation: structuredClone(operation) }],
        },
      };
      break;
  }
  return {
    schema_version: 'leaf-resource-source-candidate/1',
    workspace_id: workspaceId,
    document,
  };
}

export function record(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object') throw new Error('fixture expected object');
  return input as Record<string, unknown>;
}
export function put(input: unknown, path: string[], value: unknown): void {
  let target = record(input);
  for (const key of path.slice(0, -1)) target = record(target[key]);
  const key = path.at(-1);
  if (key === undefined) throw new Error('fixture path is empty');
  target[key] = value;
}
