import {
  CapabilityBindingV1Schema,
  DatabaseAdditionalFilterV1Schema,
  type DatabaseOperationSourceV1,
} from '@better-agent/domain-contracts';
import {
  canonicalSha256,
  type PreparedLeafResourceSourceV1,
  verifyLeafResourceBinding,
  verifyLeafResourceSource,
} from '@better-agent/release-core';

export type DatabaseCapabilityErrorCode = 'INPUT_INVALID' | 'SOURCE_INVALID' | 'PARAMETERS_INVALID';

export class DatabaseCapabilityError extends Error {
  constructor(
    readonly code: DatabaseCapabilityErrorCode,
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${code}: ${reason} at ${path}`);
    this.name = 'DatabaseCapabilityError';
  }
}

type Scalar = string | number | boolean;
type ParameterValue = Scalar | readonly Scalar[];

export interface CompiledDatabaseSelectV1 {
  readonly schema_version: 'compiled-database-select/1';
  readonly connector_id: string;
  readonly connector_revision_id: string;
  readonly database_operation_pin: PreparedLeafResourceSourceV1['full_pin'];
  readonly table_revision_id: string;
  readonly operation_contract_hash: string;
  readonly compiled_hash: string;
  readonly sql: string;
  readonly values: readonly ParameterValue[];
  readonly result_columns: readonly string[];
  readonly max_rows: number;
  readonly timeout_ms: number;
  readonly transaction_mode: 'read_only';
}

const inputKeys = ['binding', 'parameters', 'prepared_source', 'principal'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const decimalInteger = /^-?(0|[1-9][0-9]*)$/u;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const operatorSql = {
  eq: '=',
  ne: '<>',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
} as const;

function fail(code: DatabaseCapabilityErrorCode, path: string, reason: string): never {
  throw new DatabaseCapabilityError(code, path, reason);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Inspect descriptors before reading values so caller accessors never execute. */
function rejectAccessors(root: unknown): void {
  const pending = [root];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    visited += 1;
    if (visited > 20_000) fail('INPUT_INVALID', '$', 'input graph exceeds its object budget');
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if ('get' in descriptor || 'set' in descriptor)
        fail('INPUT_INVALID', `$.${key}`, 'accessor properties are forbidden');
      if ('value' in descriptor) pending.push(descriptor.value);
    }
  }
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    fail('INPUT_INVALID', path, 'object fields do not match the closed input contract');
}

function quote(identifier: string): string {
  return `"${identifier}"`;
}

function validateUuid(value: unknown, path: string): string {
  if (typeof value !== 'string' || !uuid.test(value))
    fail('PARAMETERS_INVALID', path, 'expected a lowercase UUID');
  return value;
}

function validateScalar(
  value: unknown,
  dataType: DatabaseOperationSourceV1['table']['columns'][number]['data_type'],
  path: string,
): Scalar {
  switch (dataType) {
    case 'uuid':
      return validateUuid(value, path);
    case 'text':
      if (typeof value !== 'string' || value.length > 1_048_576)
        fail('PARAMETERS_INVALID', path, 'expected bounded text');
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') fail('PARAMETERS_INVALID', path, 'expected boolean');
      return value;
    case 'int4':
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < -2_147_483_648 ||
        value > 2_147_483_647
      )
        fail('PARAMETERS_INVALID', path, 'expected PostgreSQL int4');
      return value;
    case 'int8': {
      if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
      if (typeof value !== 'string' || !decimalInteger.test(value))
        fail('PARAMETERS_INVALID', path, 'expected a canonical PostgreSQL int8');
      const parsed = BigInt(value);
      if (parsed < -9_223_372_036_854_775_808n || parsed > 9_223_372_036_854_775_807n)
        fail('PARAMETERS_INVALID', path, 'PostgreSQL int8 is out of range');
      return value;
    }
    case 'float8':
    case 'numeric':
      if (typeof value !== 'number' || !Number.isFinite(value))
        fail('PARAMETERS_INVALID', path, `expected finite PostgreSQL ${dataType}`);
      return value;
    case 'timestamptz':
      if (
        typeof value !== 'string' ||
        !timestamp.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value
      )
        fail('PARAMETERS_INVALID', path, 'expected canonical UTC timestamptz');
      return value;
  }
}

function freezeResult(result: CompiledDatabaseSelectV1): CompiledDatabaseSelectV1 {
  for (const value of result.values) if (Array.isArray(value)) Object.freeze(value);
  Object.freeze(result.values);
  Object.freeze(result.result_columns);
  return Object.freeze(result);
}

function verifiedInputs(input: unknown) {
  rejectAccessors(input);
  if (!object(input)) fail('INPUT_INVALID', '$', 'expected an object');
  exactKeys(input, inputKeys, '$');
  const principal = input.principal;
  const parameters = input.parameters;
  if (!object(principal)) fail('INPUT_INVALID', '$.principal', 'expected an object');
  exactKeys(principal, ['subject_id', 'workspace_id'], '$.principal');
  if (!object(parameters)) fail('PARAMETERS_INVALID', '$.parameters', 'expected an object');

  const prepared = input.prepared_source as PreparedLeafResourceSourceV1;
  if (!object(prepared) || !object(prepared.preimage))
    fail('SOURCE_INVALID', '$.prepared_source', 'expected a prepared leaf source');
  const candidate = {
    schema_version: 'leaf-resource-source-candidate/1',
    workspace_id: prepared.preimage.workspace_id,
    document: prepared.preimage.document,
  };
  let actual: PreparedLeafResourceSourceV1;
  try {
    actual = verifyLeafResourceSource(prepared, candidate);
  } catch (error) {
    return fail(
      'SOURCE_INVALID',
      '$.prepared_source',
      `prepared source must be an exact self-verifying pin (${error instanceof Error ? error.message : 'unknown verification failure'})`,
    );
  }
  try {
    const parsed = CapabilityBindingV1Schema.safeParse(input.binding);
    if (!parsed.success)
      throw new Error(parsed.error.issues.map((issue) => issue.message).join('; '));
    if (parsed.data.kind !== 'database') throw new Error('not database');
    verifyLeafResourceBinding(parsed.data, candidate);
    if (actual.document.schema_version !== 'database-operation-source/1')
      throw new Error('not database');
    return { actual, binding: parsed.data, parameters, principal };
  } catch (error) {
    return fail(
      'SOURCE_INVALID',
      '$.binding',
      `database Binding must exactly narrow the prepared source (${error instanceof Error ? error.message : 'unknown verification failure'})`,
    );
  }
}

export function compileDatabaseSelect(input: unknown): CompiledDatabaseSelectV1 {
  const { actual, binding, parameters, principal } = verifiedInputs(input);
  if (!binding.enabled)
    fail('SOURCE_INVALID', '$.binding.enabled', 'disabled database Bindings cannot execute');
  const document = actual.document;
  if (document.schema_version !== 'database-operation-source/1')
    return fail('SOURCE_INVALID', '$.prepared_source', 'expected a database source');
  const workspaceId = validateUuid(principal.workspace_id, '$.principal.workspace_id');
  const subjectId = validateUuid(principal.subject_id, '$.principal.subject_id');
  if (workspaceId !== actual.full_pin.workspace_id)
    fail('SOURCE_INVALID', '$.principal.workspace_id', 'principal and source workspaces differ');

  const additional =
    binding.config.row_filter_template === undefined
      ? undefined
      : DatabaseAdditionalFilterV1Schema.parse(binding.config.row_filter_template);
  const predicates = [...document.query.predicates, ...(additional?.predicates ?? [])];
  const expectedParameters = [
    ...new Set(predicates.map((predicate) => predicate.parameter)),
  ].sort();
  const actualParameters = Object.keys(parameters).sort();
  if (
    actualParameters.length !== expectedParameters.length ||
    actualParameters.some((key, index) => key !== expectedParameters[index])
  )
    fail('PARAMETERS_INVALID', '$.parameters', 'parameter names must match the sealed predicates');

  const columns = new Map(document.table.columns.map((column) => [column.name, column]));
  const values: ParameterValue[] = [workspaceId];
  const where = [`${quote(document.table.tenant_column)} = $1::uuid`];
  for (const filter of document.row_policy.principal_filters) {
    const value = filter.principal_field === 'workspace_id' ? workspaceId : subjectId;
    values.push(value);
    where.push(`${quote(filter.column)} = $${values.length}::uuid`);
  }
  for (const predicate of predicates) {
    const column = columns.get(predicate.column);
    if (column === undefined)
      return fail('SOURCE_INVALID', '$.prepared_source', 'predicate column is not sealed');
    const raw = parameters[predicate.parameter];
    let value: ParameterValue;
    if (predicate.operator === 'in') {
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > 500)
        fail('PARAMETERS_INVALID', `$.parameters.${predicate.parameter}`, 'expected 1..500 values');
      value = raw.map((item, index) =>
        validateScalar(item, column.data_type, `$.parameters.${predicate.parameter}[${index}]`),
      );
    } else {
      if (Array.isArray(raw))
        fail('PARAMETERS_INVALID', `$.parameters.${predicate.parameter}`, 'expected a scalar');
      value = validateScalar(raw, column.data_type, `$.parameters.${predicate.parameter}`);
    }
    values.push(value);
    const placeholder = `$${values.length}::${column.data_type}`;
    where.push(
      predicate.operator === 'in'
        ? `${quote(predicate.column)} = ANY(${placeholder}[])`
        : `${quote(predicate.column)} ${operatorSql[predicate.operator]} ${placeholder}`,
    );
  }

  const maxRows = Math.min(document.query.max_rows, binding.config.max_rows);
  const timeout = Math.min(document.query.timeout_ms, binding.timeout_ms);
  const select = document.query.select_columns.map(quote).join(', ');
  const order = document.query.order_by
    .map((item) => `${quote(item.column)} ${item.direction.toUpperCase()}`)
    .join(', ');
  const sql = `SELECT ${select} FROM ${quote(document.table.schema_name)}.${quote(document.table.table_name)} WHERE ${where.join(' AND ')}${order.length === 0 ? '' : ` ORDER BY ${order}`} LIMIT ${maxRows}`;
  const draft = {
    schema_version: 'compiled-database-select/1',
    connector_id: document.connector.connector_id,
    connector_revision_id: document.connector.connector_revision_id,
    database_operation_pin: actual.full_pin,
    table_revision_id: document.table.table_revision_id,
    operation_contract_hash: actual.operation_contract.contract_hash,
    sql,
    values,
    result_columns: [...document.query.select_columns],
    max_rows: maxRows,
    timeout_ms: timeout,
    transaction_mode: 'read_only',
  } as const;
  return freezeResult({ ...draft, compiled_hash: canonicalSha256(draft) });
}
