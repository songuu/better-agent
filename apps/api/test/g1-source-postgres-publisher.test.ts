import {
  prepareAgentStrategySource,
  prepareG1PublishedSourceStorage,
} from '@better-agent/release-core';
import { describe, expect, it, vi } from 'vitest';

import { createG1SourcePostgresPublisher } from '../src/modules/releases/index.js';
import type { G1SourceSqlQueryClient } from '../src/modules/releases/g1-source-postgres-readback.js';

const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303eee';
const strategyId = '018f47f2-c541-7cc6-9292-4a2c35303e01';
const strategyReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303e02';
const attestationId = '018f47f2-c541-7cc6-9292-4a2c35303e03';
const verifierHex = 'ab'.repeat(32);
const hashA = `sha256:${'a'.repeat(64)}` as const;

function clientWithRows(rows: readonly unknown[]) {
  const query = vi.fn(async (_sql: string, _values: readonly unknown[]) => ({ rows }));
  return { client: { query } as G1SourceSqlQueryClient, query };
}

function storage() {
  const prepared = prepareAgentStrategySource({
    schema_version: 'agent-strategy-source-candidate/1',
    workspace_id: workspaceId,
    document: {
      schema_version: 'agent-strategy-source/1',
      strategy_id: strategyId,
      strategy_release_id: strategyReleaseId,
      abi_version: 'agent-strategy-abi/1',
      implementation_digest: hashA,
      config: {},
      config_schema: { type: 'object' },
      input_schema: { type: 'object' },
      state_schema: { type: 'object' },
      decision_schema: { type: 'object' },
      observation_schema: { type: 'object' },
      sandbox_profile: {
        schema_version: 'strategy-sandbox-profile/1',
        profile_id: 'isolated-strategy/1',
        host_abi: 'agent-strategy-abi/1',
        network: 'deny',
        filesystem: 'deny',
        database: 'deny',
        secrets: 'deny',
        maximum_memory_bytes: 67_108_864,
        maximum_instruction_count: 1_000_000,
      },
      allowed_model_policy: {
        schema_version: 'strategy-model-policy/1',
        models: [],
        maximum_input_tokens: 32_768,
        maximum_output_tokens: 4_096,
      },
      allowed_capability_binding_ids: [],
      allowed_gate_spec_ids: [],
      max_iterations: 10,
      max_model_attempts: 5,
      max_tool_calls: 5,
    },
  });
  return prepareG1PublishedSourceStorage(prepared, [], null);
}

describe('G1 attested PostgreSQL publisher', () => {
  it('uses fixed parameterized SQL and returns the exact database version receipt', async () => {
    const { client, query } = clientWithRows([{ resource_version_id: strategyReleaseId }]);
    const publisher = createG1SourcePostgresPublisher(client);
    const source = storage();

    await expect(
      publisher.publishAgentStrategySource(source, { attestationId, verifierHex }),
    ).resolves.toBe(strategyReleaseId);

    expect(query).toHaveBeenCalledWith(
      "SELECT app.publish_attested_agent_strategy_source($1::uuid, decode($2, 'hex'), $3::jsonb) AS resource_version_id",
      [attestationId, verifierHex, JSON.stringify(source)],
    );
  });

  it('selects the fixed publisher from the prepared kind, never caller SQL', async () => {
    const { client, query } = clientWithRows([{ resource_version_id: strategyReleaseId }]);
    const publisher = createG1SourcePostgresPublisher(client);
    const source = storage();

    await publisher.publishSkillPackRelease(
      {
        ...source,
        full_pin: { ...source.full_pin, published_resource_kind: 'SKILL_PACK_RELEASE' },
      },
      { attestationId, verifierHex },
    );

    expect(query.mock.calls[0]?.[0]).toContain('app.publish_attested_skill_pack_release');
    expect(query.mock.calls[0]?.[0]).not.toContain('SKILL_PACK_RELEASE');
  });

  it('rejects malformed proof input before querying', async () => {
    const { client, query } = clientWithRows([]);
    const publisher = createG1SourcePostgresPublisher(client);

    for (const proof of [
      { attestationId: 'not-a-uuid', verifierHex },
      { attestationId, verifierHex: 'AA'.repeat(32) },
      { attestationId, verifierHex: 'ab' },
      { attestationId, verifierHex, extra: true },
    ]) {
      await expect(publisher.publishAgentStrategySource(storage(), proof)).rejects.toThrow(
        'G1 attested publisher rejected the input',
      );
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('snapshots source bytes before the database await', async () => {
    let release: ((value: { rows: { resource_version_id: string }[] }) => void) | undefined;
    const result = new Promise<{ rows: { resource_version_id: string }[] }>((resolve) => {
      release = resolve;
    });
    const query = vi.fn(async (_sql: string, _values: readonly unknown[]) => result);
    const publisher = createG1SourcePostgresPublisher({ query } as G1SourceSqlQueryClient);
    const source = structuredClone(storage());

    const pending = publisher.publishAgentStrategySource(source, { attestationId, verifierHex });
    (source as { canonical_document: string }).canonical_document = '{}';
    release?.({ rows: [{ resource_version_id: strategyReleaseId }] });

    await expect(pending).resolves.toBe(strategyReleaseId);
    expect(query.mock.calls[0]?.[1]?.[2]).not.toContain('"canonical_document":"{}"');
  });

  it('rejects query and projection failures with stable non-secret errors', async () => {
    const marker = 'database-secret-must-not-leak';
    const failed = createG1SourcePostgresPublisher({
      query: vi.fn(async () => {
        throw new Error(marker);
      }),
    } as G1SourceSqlQueryClient);
    await expect(
      failed.publishAgentStrategySource(storage(), { attestationId, verifierHex }),
    ).rejects.toThrow('G1 attested publisher query failed');

    const malformed = createG1SourcePostgresPublisher(
      clientWithRows([{ resource_version_id: strategyReleaseId, extra: marker }]).client,
    );
    await expect(
      malformed.publishAgentStrategySource(storage(), { attestationId, verifierHex }),
    ).rejects.toThrow('G1 attested publisher returned an invalid receipt');
  });
});
