import { canonicalSha256, prepareLeafResourceSource } from '@better-agent/release-core';
import { describe, expect, it, vi } from 'vitest';

import { DatabaseCapabilityError, compileDatabaseSelect } from '../src/index.js';

const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303eee';
const subjectId = '018f47f2-c541-7cc6-9292-4a2c35303e14';
const resourceId = '018f47f2-c541-7cc6-9292-4a2c35303e0c';
const versionId = '018f47f2-c541-7cc6-9292-4a2c35303e0d';
const hashA = `sha256:${'a'.repeat(64)}` as const;

function candidate() {
  return {
    schema_version: 'leaf-resource-source-candidate/1',
    workspace_id: workspaceId,
    document: {
      schema_version: 'database-operation-source/1',
      resource_id: resourceId,
      resource_version_id: versionId,
      manual: { description: 'Find visible records' },
      operation: {
        schema_version: 'operation-contract-source/1',
        operation_kind: 'database_operation',
        operation_id: 'find_records',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            minimum_score: { type: 'number' },
            maximum_score: { type: 'number' },
          },
          required: ['query', 'minimum_score', 'maximum_score'],
          additionalProperties: false,
        },
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
      connector: {
        schema_version: 'database-connector-identity/1',
        connector_id: resourceId,
        connector_revision_id: versionId,
        provider_id: 'managed-postgres',
        dialect: 'postgresql16',
        contract_hash: hashA,
      },
      table: {
        schema_version: 'database-table-contract/1',
        table_revision_id: versionId,
        schema_name: 'app',
        table_name: 'records',
        tenant_column: 'workspace_id',
        columns: [
          {
            name: 'workspace_id',
            data_type: 'uuid',
            nullable: false,
            data_classification: 'internal',
          },
          { name: 'owner_id', data_type: 'uuid', nullable: false, data_classification: 'internal' },
          { name: 'title', data_type: 'text', nullable: false, data_classification: 'internal' },
          { name: 'score', data_type: 'float8', nullable: false, data_classification: 'internal' },
        ],
      },
      query: {
        schema_version: 'database-select/1',
        table_revision_id: versionId,
        select_columns: ['title', 'score'],
        predicates: [
          { column: 'title', operator: 'eq', parameter: 'query' },
          { column: 'score', operator: 'gte', parameter: 'minimum_score' },
        ],
        order_by: [{ column: 'score', direction: 'desc' }],
        max_rows: 50,
        timeout_ms: 1_000,
      },
      row_policy: {
        schema_version: 'database-row-policy/1',
        enforce_workspace: true,
        principal_filters: [{ column: 'owner_id', principal_field: 'subject_id' }],
      },
    },
  } as const;
}

function fixture() {
  const sourceCandidate = candidate();
  const prepared = prepareLeafResourceSource(sourceCandidate);
  const document = prepared.document;
  if (document.schema_version !== 'database-operation-source/1') throw new Error('bad fixture');
  const binding = {
    binding_id: 'database',
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
    timeout_ms: 700,
    budget: {},
    kind: 'database',
    pin: prepared.full_pin,
    config: {
      schema_version: 'database-binding/1',
      operation_contract_hash: prepared.operation_contract.contract_hash,
      table_revision_ids: [versionId],
      allowed_tables: [
        { table_revision_id: versionId, columns: ['workspace_id', 'owner_id', 'title', 'score'] },
      ],
      row_filter_template: {
        schema_version: 'database-additional-filter/1',
        predicates: [{ column: 'score', operator: 'lte', parameter: 'maximum_score' }],
      },
      max_rows: 10,
      transaction_mode: 'read_only',
      approval: 'none',
      idempotency_requirement: 'none',
    },
  } as const;
  return { sourceCandidate, prepared, binding };
}

describe('compileDatabaseSelect', () => {
  it('compiles only the sealed table, columns, predicates, principal policy and bounds', () => {
    const { prepared, binding } = fixture();
    const result = compileDatabaseSelect({
      prepared_source: prepared,
      binding,
      principal: { workspace_id: workspaceId, subject_id: subjectId },
      parameters: { query: 'alpha', minimum_score: 0.25, maximum_score: 0.9 },
    });

    const expected = {
      schema_version: 'compiled-database-select/1',
      connector_id: resourceId,
      connector_revision_id: versionId,
      database_operation_pin: prepared.full_pin,
      table_revision_id: versionId,
      operation_contract_hash: prepared.operation_contract.contract_hash,
      sql: 'SELECT "title", "score" FROM "app"."records" WHERE "workspace_id" = $1::uuid AND "owner_id" = $2::uuid AND "title" = $3::text AND "score" >= $4::float8 AND "score" <= $5::float8 ORDER BY "score" DESC LIMIT 10',
      values: [workspaceId, subjectId, 'alpha', 0.25, 0.9],
      result_columns: ['title', 'score'],
      max_rows: 10,
      timeout_ms: 700,
      transaction_mode: 'read_only',
    } as const;
    expect(result).toEqual({ ...expected, compiled_hash: canonicalSha256(expected) });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.values)).toBe(true);
  });

  it.each([
    [{ query: 'alpha', minimum_score: 0.25 }, 'PARAMETERS_INVALID'],
    [{ query: 'alpha', minimum_score: '0.25', maximum_score: 0.9 }, 'PARAMETERS_INVALID'],
    [
      { query: 'alpha', minimum_score: 0.25, maximum_score: 0.9, sql: 'DROP TABLE records' },
      'PARAMETERS_INVALID',
    ],
  ])('rejects incomplete, incorrectly typed or open parameter maps', (parameters, code) => {
    const { prepared, binding } = fixture();
    expect(() =>
      compileDatabaseSelect({
        prepared_source: prepared,
        binding,
        principal: { workspace_id: workspaceId, subject_id: subjectId },
        parameters,
      }),
    ).toThrowError(expect.objectContaining({ code }));
  });

  it('rejects any changed prepared source or binding pin', () => {
    const { prepared, binding } = fixture();
    expect(() =>
      compileDatabaseSelect({
        prepared_source: {
          ...prepared,
          component_hashes: { ...prepared.component_hashes, query: hashA },
        },
        binding,
        principal: { workspace_id: workspaceId, subject_id: subjectId },
        parameters: { query: 'alpha', minimum_score: 0.25, maximum_score: 0.9 },
      }),
    ).toThrowError(DatabaseCapabilityError);
    expect(() =>
      compileDatabaseSelect({
        prepared_source: prepared,
        binding: { ...binding, pin: { ...binding.pin, contract_hash: hashA } },
        principal: { workspace_id: workspaceId, subject_id: subjectId },
        parameters: { query: 'alpha', minimum_score: 0.25, maximum_score: 0.9 },
      }),
    ).toThrowError(DatabaseCapabilityError);
  });

  it('rejects a disabled binding before producing SQL', () => {
    const { prepared, binding } = fixture();
    expect(() =>
      compileDatabaseSelect({
        prepared_source: prepared,
        binding: { ...binding, enabled: false },
        principal: { workspace_id: workspaceId, subject_id: subjectId },
        parameters: { query: 'alpha', minimum_score: 0.25, maximum_score: 0.9 },
      }),
    ).toThrowError(expect.objectContaining({ code: 'SOURCE_INVALID', path: '$.binding.enabled' }));
  });

  it('rejects accessors without executing them', () => {
    const { prepared, binding } = fixture();
    const getter = vi.fn(() => 'SELECT * FROM secrets');
    const input = {
      prepared_source: prepared,
      binding,
      principal: { workspace_id: workspaceId, subject_id: subjectId },
      parameters: { query: 'alpha', minimum_score: 0.25, maximum_score: 0.9 },
    };
    Object.defineProperty(input, 'sql', { enumerable: true, get: getter });
    expect(() => compileDatabaseSelect(input)).toThrowError(
      expect.objectContaining({ code: 'INPUT_INVALID' }),
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it('binds IN arrays with the fixed PostgreSQL column type', () => {
    const base = candidate();
    const changed = structuredClone(base) as unknown as {
      document: {
        query: { predicates: Array<{ column: string; operator: string; parameter: string }> };
        operation: { input_schema: { properties: Record<string, unknown> } };
      };
    };
    changed.document.query.predicates[0] = { column: 'title', operator: 'in', parameter: 'query' };
    changed.document.operation.input_schema.properties.query = {
      type: 'array',
      items: { type: 'string' },
    };
    const prepared = prepareLeafResourceSource(changed);
    const original = fixture().binding;
    const binding = {
      ...original,
      pin: prepared.full_pin,
      manual: { ...prepared.document.manual, hash: prepared.component_hashes.manual },
      input_schema: prepared.document.operation.input_schema,
      output_schema: prepared.document.operation.output_schema,
      config: {
        ...original.config,
        operation_contract_hash: prepared.operation_contract.contract_hash,
      },
    };
    const result = compileDatabaseSelect({
      prepared_source: prepared,
      binding,
      principal: { workspace_id: workspaceId, subject_id: subjectId },
      parameters: { query: ['alpha', 'beta'], minimum_score: 0.25, maximum_score: 0.9 },
    });
    expect(result.sql).toContain('"title" = ANY($3::text[])');
    expect(result.values[2]).toEqual(['alpha', 'beta']);
  });
});
