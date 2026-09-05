import { canonicalSha256, prepareLeafResourceSource } from '@better-agent/release-core';
import { describe, expect, it } from 'vitest';

import { compileKnowledgeQuery } from '../src/index.js';

const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303eee';
const subjectId = '018f47f2-c541-7cc6-9292-4a2c35303e14';
const grantorId = '018f47f2-c541-7cc6-9292-4a2c35303e15';
const resourceId = '018f47f2-c541-7cc6-9292-4a2c35303e0c';
const versionId = '018f47f2-c541-7cc6-9292-4a2c35303e0d';
const sourceId = '018f47f2-c541-7cc6-9292-4a2c35303e05';
const sourceVersionId = '018f47f2-c541-7cc6-9292-4a2c35303e06';
const hashA = `sha256:${'a'.repeat(64)}` as const;
const hashB = `sha256:${'b'.repeat(64)}` as const;

function candidate(version = versionId) {
  return {
    schema_version: 'leaf-resource-source-candidate/1',
    workspace_id: workspaceId,
    document: {
      schema_version: 'knowledge-index-generation-source/1',
      resource_id: resourceId,
      resource_version_id: version,
      manual: { description: 'Search approved knowledge' },
      operation: {
        schema_version: 'operation-contract-source/1',
        operation_kind: 'knowledge_query',
        operation_id: 'search',
        input_schema: { type: 'object' },
        output_schema: { type: 'array', items: { type: 'object' } },
        side_effect_class: 'safe',
        operation_key_required: false,
        approval_required: false,
      },
      requirements: {
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
      },
      source_manifest: {
        schema_version: 'knowledge-source-manifest/1',
        sources: [{ source_id: sourceId, source_release_id: sourceVersionId, content_hash: hashA }],
      },
      ingestion: {
        schema_version: 'knowledge-ingestion-contract/1',
        parser_version: 'parser-v1',
        implementation_digest: hashA,
        chunk_size: 500,
        chunk_overlap: 50,
      },
      embedding: {
        schema_version: 'knowledge-embedding-contract/1',
        provider_id: 'embedding-provider',
        model_id: 'embedding-model',
        model_revision: 'v1',
        dimensions: 1536,
        metric: 'cosine',
      },
      retrieval: {
        schema_version: 'knowledge-retrieval-contract/1',
        algorithm: 'hybrid',
        top_k: 10,
        max_context_tokens: 2_000,
        score_threshold: 0.5,
        include_metadata_fields: ['category', 'priority'],
      },
      rerank: {
        mode: 'model',
        provider_id: 'rerank-provider',
        model_id: 'rerank-model',
        model_revision: 'v1',
        top_n: 5,
      },
      metadata_filter_policy: {
        schema_version: 'knowledge-filter-policy/1',
        enforce_workspace: true,
        enforce_document_acl: true,
        allowed_fields: [
          { name: 'category', value_type: 'string', operators: ['eq', 'in'] },
          { name: 'priority', value_type: 'number', operators: ['eq', 'gte'] },
        ],
      },
      index_manifest: {
        schema_version: 'knowledge-index-manifest/1',
        shard_hashes: [hashA, hashB],
        document_count: 12,
      },
    },
  } as const;
}

function fixture() {
  const prepared = prepareLeafResourceSource(candidate());
  const document = prepared.document;
  if (document.schema_version !== 'knowledge-index-generation-source/1') throw new Error('bad');
  const binding = {
    binding_id: 'knowledge',
    enabled: true,
    discoverability: 'model_selectable',
    manual: { ...document.manual, hash: prepared.component_hashes.manual },
    input_schema: document.operation.input_schema,
    output_schema: document.operation.output_schema,
    data_classification: 'internal',
    side_effect: { class: 'safe', approval: 'none' },
    task_safe: false,
    mock_safe: false,
    retry: {},
    timeout_ms: 800,
    budget: {},
    kind: 'knowledge',
    pin: prepared.full_pin,
    config: {
      schema_version: 'knowledge-binding/1',
      selection: 'on_demand',
      query_contract_hash: prepared.operation_contract.contract_hash,
      metadata_filter_policy_hash: prepared.component_hashes.metadata_filter_policy,
    },
  } as const;
  const authorityPreimage = {
    schema_version: 'knowledge-authority-preimage/1',
    workspace_id: workspaceId,
    principal_subject_id: subjectId,
    authorization_mode: 'delegated',
    granted_by_subject_id: grantorId,
    generation_pin: prepared.full_pin,
    authorized_sources: [{ source_id: sourceId, source_release_id: sourceVersionId }],
    policy_revision_id: '018f47f2-c541-7cc6-9292-4a2c35303e22',
    evaluated_at: '2026-09-04T00:00:00.000Z',
    expires_at: '2026-09-04T01:00:00.000Z',
  } as const;
  const authority = {
    schema_version: 'knowledge-authority-snapshot/1',
    preimage: authorityPreimage,
    authority_hash: canonicalSha256(authorityPreimage),
  } as const;
  return { prepared, document, binding, authority };
}

describe('compileKnowledgeQuery', () => {
  it('seals generation, delegated ACL, retrieval, rerank, shards and metadata filters', () => {
    const { prepared, document, binding, authority } = fixture();
    const result = compileKnowledgeQuery({
      prepared_source: prepared,
      binding,
      principal: { workspace_id: workspaceId, subject_id: subjectId },
      authority_snapshot: authority,
      query: {
        text: 'deployment policy',
        filters: [
          { field: 'category', operator: 'in', value: ['guide', 'runbook'] },
          { field: 'priority', operator: 'gte', value: 2 },
        ],
      },
      now: '2026-09-04T00:30:00.000Z',
    });
    expect(result.generation_pin).toEqual(prepared.full_pin);
    expect(result.authority_hash).toBe(authority.authority_hash);
    expect(result.authorized_sources).toEqual(authority.preimage.authorized_sources);
    expect(result.retrieval).toEqual(document.retrieval);
    expect(result.rerank).toEqual(document.rerank);
    expect(result.index_manifest).toEqual(document.index_manifest);
    const { compiled_hash: compiledHash, ...preimage } = result;
    expect(compiledHash).toBe(canonicalSha256(preimage));
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    [[{ field: 'secret', operator: 'eq', value: 'x' }], 'unknown field'],
    [[{ field: 'category', operator: 'gte', value: 'x' }], 'operator'],
    [[{ field: 'priority', operator: 'gte', value: 'high' }], 'value'],
    [[{ field: 'category', operator: 'in', value: [] }], 'value'],
  ])('rejects metadata filters outside the closed policy', (filters, reason) => {
    const { prepared, binding, authority } = fixture();
    expect(() =>
      compileKnowledgeQuery({
        prepared_source: prepared,
        binding,
        principal: { workspace_id: workspaceId, subject_id: subjectId },
        authority_snapshot: authority,
        query: { text: 'x', filters },
        now: '2026-09-04T00:30:00.000Z',
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'QUERY_INVALID', reason: expect.stringContaining(reason) }),
    );
  });

  it('rejects expired, cross-principal and tampered ACL snapshots', () => {
    const { prepared, binding, authority } = fixture();
    const base = {
      prepared_source: prepared,
      binding,
      principal: { workspace_id: workspaceId, subject_id: subjectId },
      query: { text: 'x', filters: [] },
    };
    expect(() =>
      compileKnowledgeQuery({
        ...base,
        authority_snapshot: authority,
        now: '2026-09-04T02:00:00.000Z',
      }),
    ).toThrowError(expect.objectContaining({ code: 'AUTHORITY_INVALID' }));
    expect(() =>
      compileKnowledgeQuery({
        ...base,
        principal: { workspace_id: workspaceId, subject_id: grantorId },
        authority_snapshot: authority,
        now: '2026-09-04T00:30:00.000Z',
      }),
    ).toThrowError(expect.objectContaining({ code: 'AUTHORITY_INVALID' }));
    expect(() =>
      compileKnowledgeQuery({
        ...base,
        authority_snapshot: { ...authority, authority_hash: hashA },
        now: '2026-09-04T00:30:00.000Z',
      }),
    ).toThrowError(expect.objectContaining({ code: 'AUTHORITY_INVALID' }));
  });

  it('prevents an accepted ACL snapshot from drifting onto a refreshed generation', () => {
    const { binding, authority } = fixture();
    const refreshed = prepareLeafResourceSource(candidate('018f47f2-c541-7cc6-9292-4a2c35303e2f'));
    expect(() =>
      compileKnowledgeQuery({
        prepared_source: refreshed,
        binding: { ...binding, pin: refreshed.full_pin },
        principal: { workspace_id: workspaceId, subject_id: subjectId },
        authority_snapshot: authority,
        query: { text: 'x', filters: [] },
        now: '2026-09-04T00:30:00.000Z',
      }),
    ).toThrowError(expect.objectContaining({ code: 'AUTHORITY_INVALID' }));
  });
});
