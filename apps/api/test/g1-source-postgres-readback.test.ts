import { describe, expect, it, vi } from 'vitest';

import { createG1SourcePostgresReadback } from '../src/modules/releases/index.js';
import type { G1SourceSqlQueryClient } from '../src/modules/releases/g1-source-postgres-readback.js';

const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303eee';
const pin = {
  workspace_id: workspaceId,
  published_resource_kind: 'AGENT_STRATEGY_RELEASE',
  resource_id: '018f47f2-c541-7cc6-9292-4a2c35303e01',
  resource_version_id: '018f47f2-c541-7cc6-9292-4a2c35303e02',
  contract_hash: `sha256:${'a'.repeat(64)}`,
  binding_mode: 'pinned',
} as const;

function clientWithRows(rows: readonly unknown[]) {
  const query = vi.fn(async () => ({ rows }));
  return { client: { query } as G1SourceSqlQueryClient, query };
}

describe('G1 PostgreSQL authoritative readback adapter', () => {
  it('uses one parameterized fixed function for exact dependency pins', async () => {
    const { client, query } = clientWithRows([{ value: [pin] }]);
    const readback = createG1SourcePostgresReadback(client);

    await expect(readback.loadRegisteredDependencyPins(workspaceId, [pin])).resolves.toEqual([pin]);
    expect(query).toHaveBeenCalledWith(
      'SELECT app.resolve_registered_dependency_pins($1::jsonb) AS value',
      [JSON.stringify([pin])],
    );
  });

  it('uses one parameterized fixed function for the exact source pin', async () => {
    const storage = { schema_version: 'prepared-g1-published-source-storage/1' };
    const { client, query } = clientWithRows([{ value: storage }]);
    const readback = createG1SourcePostgresReadback(client);

    await expect(readback.loadPublishedG1Source(pin)).resolves.toEqual(storage);
    expect(query).toHaveBeenCalledWith(
      'SELECT app.resolve_g1_published_source($1::jsonb) AS value',
      [JSON.stringify(pin)],
    );
  });

  it('rejects invalid or cross-workspace pins before querying PostgreSQL', async () => {
    const { client, query } = clientWithRows([]);
    const readback = createG1SourcePostgresReadback(client);

    for (const invalid of [
      [{ ...pin, workspace_id: '018f47f2-c541-7cc6-9292-4a2c35303eff' }],
      [{ ...pin, extra: true }],
      [{ ...pin, contract_hash: 'not-a-hash' }],
    ])
      await expect(readback.loadRegisteredDependencyPins(workspaceId, invalid)).rejects.toThrow(
        'G1 source SQL readback rejected the input',
      );
    await expect(
      readback.loadPublishedG1Source({ ...pin, extra: true } as unknown as typeof pin),
    ).rejects.toThrow('G1 source SQL readback rejected the input');
    expect(query).not.toHaveBeenCalled();
  });

  it('snapshots dependency requests before the database await', async () => {
    let releaseQuery: ((value: { rows: readonly unknown[] }) => void) | undefined;
    const queryResult = new Promise<{ rows: readonly unknown[] }>((resolve) => {
      releaseQuery = resolve;
    });
    const query = vi.fn(async () => queryResult);
    const readback = createG1SourcePostgresReadback({ query } as G1SourceSqlQueryClient);
    const requested = [structuredClone(pin)];

    const pending = readback.loadRegisteredDependencyPins(workspaceId, requested);
    const first = requested[0] as unknown as { resource_version_id: string } | undefined;
    if (first === undefined) throw new Error('dependency fixture is missing');
    first.resource_version_id = '018f47f2-c541-7cc6-9292-4a2c35303eff';
    releaseQuery?.({ rows: [{ value: [pin] }] });
    await pending;

    expect(query).toHaveBeenCalledWith(expect.any(String), [JSON.stringify([pin])]);
  });

  it('rejects missing, duplicate and malformed SQL projections', async () => {
    for (const rows of [[], [{ value: [] }, { value: [] }], [{}], [{ value: '{' }]]) {
      const { client } = clientWithRows(rows);
      await expect(
        createG1SourcePostgresReadback(client).loadRegisteredDependencyPins(workspaceId, []),
      ).rejects.toThrow('G1 source SQL readback returned an invalid projection');
    }
  });
});
