import {
  PublishedResourcePinV1Schema,
  type PublishedResourcePinV1,
} from '@better-agent/domain-contracts';
import { boundedDataSnapshot } from '@better-agent/release-core';

import type { G1SourceDatabaseTransaction } from './g1-source-boundary.js';

export interface G1SourceSqlQueryResult<Row> {
  readonly rows: readonly Row[];
}

export interface G1SourceSqlQueryClient {
  query<Row>(sql: string, values: readonly unknown[]): Promise<G1SourceSqlQueryResult<Row>>;
}

export type G1SourcePostgresReadback = Pick<
  G1SourceDatabaseTransaction,
  'loadRegisteredDependencyPins' | 'loadPublishedG1Source'
>;

type ReadbackErrorCode = 'INPUT_INVALID' | 'QUERY_FAILED' | 'PROJECTION_INVALID';
const sha256Pattern = /^sha256:[0-9a-f]{64}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

class G1SourcePostgresReadbackError extends Error {
  constructor(
    readonly code: ReadbackErrorCode,
    options?: ErrorOptions,
  ) {
    super(
      code === 'INPUT_INVALID'
        ? 'G1 source SQL readback rejected the input'
        : code === 'QUERY_FAILED'
          ? 'G1 source SQL readback query failed'
          : 'G1 source SQL readback returned an invalid projection',
      options,
    );
    this.name = 'G1SourcePostgresReadbackError';
  }
}

function parsePin(input: unknown, workspaceId?: string): PublishedResourcePinV1 {
  try {
    const snapshot = boundedDataSnapshot(input, 'identity');
    const result = PublishedResourcePinV1Schema.safeParse(snapshot);
    if (
      !result.success ||
      (workspaceId !== undefined && result.data.workspace_id !== workspaceId) ||
      !uuidPattern.test(result.data.workspace_id) ||
      !uuidPattern.test(result.data.resource_id) ||
      !uuidPattern.test(result.data.resource_version_id) ||
      !sha256Pattern.test(result.data.contract_hash)
    ) {
      throw new Error('pin is invalid or belongs to another Workspace');
    }
    return result.data;
  } catch (error) {
    if (error instanceof G1SourcePostgresReadbackError) throw error;
    throw new G1SourcePostgresReadbackError('INPUT_INVALID', { cause: error });
  }
}

function parseRequestedPins(
  workspaceId: string,
  requestedPins: readonly unknown[],
): readonly PublishedResourcePinV1[] {
  if (
    typeof workspaceId !== 'string' ||
    workspaceId.length === 0 ||
    !Array.isArray(requestedPins)
  ) {
    throw new G1SourcePostgresReadbackError('INPUT_INVALID');
  }
  let snapshot: unknown;
  try {
    snapshot = boundedDataSnapshot(requestedPins, 'source');
  } catch (error) {
    throw new G1SourcePostgresReadbackError('INPUT_INVALID', { cause: error });
  }
  if (!Array.isArray(snapshot) || snapshot.length > 1024) {
    throw new G1SourcePostgresReadbackError('INPUT_INVALID');
  }
  const pins = snapshot.map((pin) => parsePin(pin, workspaceId));
  if (new Set(pins.map((pin) => JSON.stringify(pin))).size !== pins.length) {
    throw new G1SourcePostgresReadbackError('INPUT_INVALID');
  }
  return pins;
}

function decodeProjection<Row>(rows: readonly Row[], profile: 'source' | 'closure'): unknown {
  const [row] = rows;
  if (
    rows.length !== 1 ||
    typeof row !== 'object' ||
    row === null ||
    Array.isArray(row) ||
    Reflect.ownKeys(row).length !== 1 ||
    !Object.hasOwn(row, 'value')
  ) {
    throw new G1SourcePostgresReadbackError('PROJECTION_INVALID');
  }
  let value = Reflect.get(row, 'value');
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw new G1SourcePostgresReadbackError('PROJECTION_INVALID', { cause: error });
    }
  }
  try {
    return boundedDataSnapshot(value, profile);
  } catch (error) {
    throw new G1SourcePostgresReadbackError('PROJECTION_INVALID', { cause: error });
  }
}

async function queryProjection(
  client: G1SourceSqlQueryClient,
  sql: string,
  value: unknown,
  profile: 'source' | 'closure',
): Promise<unknown> {
  let result: G1SourceSqlQueryResult<unknown>;
  try {
    result = await client.query(sql, [JSON.stringify(value)]);
  } catch (error) {
    throw new G1SourcePostgresReadbackError('QUERY_FAILED', { cause: error });
  }
  return decodeProjection(result.rows, profile);
}

export function createG1SourcePostgresReadback(
  client: G1SourceSqlQueryClient,
): G1SourcePostgresReadback {
  return Object.freeze({
    loadRegisteredDependencyPins: async (
      workspaceId: string,
      requestedPins: readonly unknown[],
    ) => {
      const pins = parseRequestedPins(workspaceId, requestedPins);
      const value = await queryProjection(
        client,
        'SELECT app.resolve_registered_dependency_pins($1::jsonb) AS value',
        pins,
        'source',
      );
      if (!Array.isArray(value)) {
        throw new G1SourcePostgresReadbackError('PROJECTION_INVALID');
      }
      return value;
    },
    loadPublishedG1Source: async (input: PublishedResourcePinV1) => {
      const pin = parsePin(input);
      return queryProjection(
        client,
        'SELECT app.resolve_g1_published_source($1::jsonb) AS value',
        pin,
        'closure',
      );
    },
  });
}
