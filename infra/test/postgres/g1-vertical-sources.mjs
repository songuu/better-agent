import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import {
  prepareG1PublishedSourceStorage,
  prepareInstructionSkillSource,
  prepareLeafResourceSource,
} from '../../../packages/release-core/dist/index.js';

const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function operation(kind) {
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

function requirements() {
  return {
    schema_version: 'leaf-capability-requirements/1',
    credential_requirements: [],
    principal_modes: ['none'],
    egress: [],
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
}

function leafCandidate(workspaceId, resourceId, resourceVersionId, kind) {
  const common = {
    resource_id: resourceId,
    resource_version_id: resourceVersionId,
    manual: { description: 'G1 fixed read source', input_description: 'A query string' },
    operation: operation(kind === 'knowledge' ? 'knowledge_query' : 'database_operation'),
    requirements: requirements(),
  };
  const document =
    kind === 'knowledge'
      ? {
          ...common,
          schema_version: 'knowledge-index-generation-source/1',
          source_manifest: {
            schema_version: 'knowledge-source-manifest/1',
            sources: [
              {
                source_id: resourceId,
                source_release_id: resourceVersionId,
                content_hash: digest('g1-knowledge-source'),
              },
            ],
          },
          ingestion: {
            schema_version: 'knowledge-ingestion-contract/1',
            parser_version: 'text-parser/1',
            implementation_digest: digest('g1-parser'),
            chunk_size: 500,
            chunk_overlap: 50,
          },
          embedding: {
            schema_version: 'knowledge-embedding-contract/1',
            provider_id: 'fixture',
            model_id: 'deterministic-embedding',
            model_revision: 'v1',
            dimensions: 3,
            metric: 'cosine',
          },
          retrieval: {
            schema_version: 'knowledge-retrieval-contract/1',
            algorithm: 'vector',
            top_k: 3,
            max_context_tokens: 512,
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
            shard_hashes: [digest('g1-shard')],
            document_count: 1,
          },
        }
      : {
          ...common,
          schema_version: 'database-operation-source/1',
          connector: {
            schema_version: 'database-connector-identity/1',
            connector_id: resourceId,
            connector_revision_id: resourceVersionId,
            provider_id: 'managed-postgres',
            dialect: 'postgresql16',
            contract_hash: digest('g1-database-connector'),
          },
          table: {
            schema_version: 'database-table-contract/1',
            table_revision_id: resourceVersionId,
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
              {
                name: 'title',
                data_type: 'text',
                nullable: false,
                data_classification: 'internal',
              },
              { name: 'score', data_type: 'float8', nullable: true, data_classification: 'public' },
            ],
          },
          query: {
            schema_version: 'database-select/1',
            table_revision_id: resourceVersionId,
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
  return {
    schema_version: 'leaf-resource-source-candidate/1',
    workspace_id: workspaceId,
    document,
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function bundledFile(path, kind, bytes) {
  return {
    manifest: { path, kind, size_bytes: bytes.length, content_hash: digest(bytes) },
    file: { path, chunks_base64: [bytes.toString('base64')] },
  };
}

function instructionSource(workspaceId, resourceId, resourceVersionId) {
  const signer = generateKeyPairSync('ed25519');
  const entry = bundledFile(
    'SKILL.md',
    'instruction',
    Buffer.from('# G1 procedure\nUse only fixed read capabilities.\n'),
  );
  const script = bundledFile(
    'scripts/must-remain-inert.js',
    'script',
    Buffer.from('throw new Error("INERT_SCRIPT_MUST_NOT_RUN")'),
  );
  const source = {
    schema_version: 'instruction-skill-source-candidate/1',
    workspace_id: workspaceId,
    document: {
      schema_version: 'instruction-skill-source/1',
      resource_id: resourceId,
      resource_version_id: resourceVersionId,
      name: 'G1 inert procedure',
      description: 'Signed instructions whose script is never executable',
      parser_version: 'instruction-skill-bundle-parser/1',
      entry_path: 'SKILL.md',
      origin: { publisher_id: 'g1-reviewer', source_id: 'g1-inert', revision: 'v1' },
      manifest: [entry.manifest, script.manifest],
      allowed_capability_binding_ids: ['knowledge', 'database'],
      context_budget_tokens: 512,
      data_classification: 'internal',
      scripts: { mode: 'inert', requires_execution: false },
      signature: { algorithm: 'ed25519', key_id: 'g1-key', signature_base64: '' },
    },
    files: [entry.file, script.file],
  };
  const trust = {
    schema_version: 'instruction-skill-trusted-signers/1',
    workspace_id: workspaceId,
    signers: [
      {
        key_id: 'g1-key',
        publisher_id: 'g1-reviewer',
        source_id: 'g1-inert',
        allowed_resource_ids: [resourceId],
        public_key_spki_base64: signer.publicKey
          .export({ type: 'spki', format: 'der' })
          .toString('base64'),
      },
    ],
  };
  const { signature, ...document } = source.document;
  const payload = {
    schema_version: 'instruction-skill-signing-payload/1',
    canonicalizer_version: 'rfc8785/1',
    workspace_id: workspaceId,
    published_resource_kind: 'INSTRUCTION_SKILL_RELEASE',
    document: {
      ...document,
      manifest: [...document.manifest].sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      ),
      allowed_capability_binding_ids: [...document.allowed_capability_binding_ids].sort(),
    },
    signer: { algorithm: signature.algorithm, key_id: signature.key_id },
  };
  source.document.signature.signature_base64 = sign(
    null,
    Buffer.from(canonical(payload)),
    signer.privateKey,
  ).toString('base64');
  return { source, trust };
}

export function prepareG1VerticalSources(ids) {
  const knowledge = prepareLeafResourceSource(
    leafCandidate(ids.workspace, ids.knowledge, ids.knowledgeVersion, 'knowledge'),
  );
  const database = prepareLeafResourceSource(
    leafCandidate(ids.workspace, ids.database, ids.databaseVersion, 'database'),
  );
  const instructionInput = instructionSource(
    ids.workspace,
    ids.instruction,
    ids.instructionVersion,
  );
  const instruction = prepareInstructionSkillSource(
    instructionInput.source,
    instructionInput.trust,
  );
  return Object.freeze({
    knowledge: prepareG1PublishedSourceStorage(knowledge, [], null),
    database: prepareG1PublishedSourceStorage(database, [], null),
    instruction: prepareG1PublishedSourceStorage(instruction, [], instructionInput.trust),
  });
}
