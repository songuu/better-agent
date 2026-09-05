import { CapabilityBindingV1Schema } from '@better-agent/domain-contracts';
import {
  canonicalSha256,
  type PreparedLeafResourceSourceV1,
  verifyLeafResourceBinding,
  verifyLeafResourceSource,
} from '@better-agent/release-core';

export type KnowledgeQueryErrorCode =
  | 'INPUT_INVALID'
  | 'SOURCE_INVALID'
  | 'AUTHORITY_INVALID'
  | 'QUERY_INVALID';

export class KnowledgeQueryError extends Error {
  constructor(
    readonly code: KnowledgeQueryErrorCode,
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${code}: ${reason} at ${path}`);
    this.name = 'KnowledgeQueryError';
  }
}

type FilterValue = string | number | boolean | readonly (string | number | boolean)[];
interface CompiledFilter {
  readonly field: string;
  readonly operator: 'eq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte';
  readonly value: FilterValue;
}

export interface CompiledKnowledgeQueryV1 {
  readonly schema_version: 'compiled-knowledge-query/1';
  readonly generation_pin: PreparedLeafResourceSourceV1['full_pin'];
  readonly authority_hash: string;
  readonly compiled_hash: string;
  readonly workspace_id: string;
  readonly subject_id: string;
  readonly authorized_sources: readonly {
    readonly source_id: string;
    readonly source_release_id: string;
  }[];
  readonly text: string;
  readonly filters: readonly CompiledFilter[];
  readonly embedding: unknown;
  readonly retrieval: unknown;
  readonly rerank: unknown;
  readonly index_manifest: unknown;
  readonly timeout_ms: number;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function fail(code: KnowledgeQueryErrorCode, path: string, reason: string): never {
  throw new KnowledgeQueryError(code, path, reason);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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
    fail('INPUT_INVALID', path, 'object fields do not match the closed contract');
}

function validUuid(value: unknown, path: string, code: KnowledgeQueryErrorCode): string {
  if (typeof value !== 'string' || !uuid.test(value)) fail(code, path, 'expected lowercase UUID');
  return value;
}

function validTime(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    !timestamp.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail('AUTHORITY_INVALID', path, 'expected canonical UTC timestamp');
  return value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function verifySourceAndBinding(input: Record<string, unknown>) {
  const prepared = input.prepared_source as PreparedLeafResourceSourceV1;
  if (!object(prepared) || !object(prepared.preimage))
    fail('SOURCE_INVALID', '$.prepared_source', 'expected prepared source');
  const candidate = {
    schema_version: 'leaf-resource-source-candidate/1',
    workspace_id: prepared.preimage.workspace_id,
    document: prepared.preimage.document,
  };
  try {
    const actual = verifyLeafResourceSource(prepared, candidate);
    const binding = CapabilityBindingV1Schema.parse(input.binding);
    if (binding.kind !== 'knowledge') throw new Error('expected Knowledge Binding');
    verifyLeafResourceBinding(binding, candidate);
    if (actual.document.schema_version !== 'knowledge-index-generation-source/1')
      throw new Error('expected Knowledge generation source');
    if (!binding.enabled)
      fail('SOURCE_INVALID', '$.binding.enabled', 'disabled Binding cannot run');
    return { actual, binding };
  } catch (error) {
    if (error instanceof KnowledgeQueryError) throw error;
    return fail(
      'SOURCE_INVALID',
      '$.prepared_source',
      `source and Binding must be exact self-verifying pins (${error instanceof Error ? error.message : 'verification failed'})`,
    );
  }
}

function verifyAuthority(
  authority: unknown,
  actual: PreparedLeafResourceSourceV1,
  workspaceId: string,
  subjectId: string,
  now: unknown,
) {
  if (!object(authority)) fail('AUTHORITY_INVALID', '$.authority_snapshot', 'expected object');
  exactKeys(authority, ['authority_hash', 'preimage', 'schema_version'], '$.authority_snapshot');
  if (authority.schema_version !== 'knowledge-authority-snapshot/1' || !object(authority.preimage))
    fail('AUTHORITY_INVALID', '$.authority_snapshot', 'invalid authority envelope');
  const preimage = authority.preimage;
  const mode = preimage.authorization_mode;
  const preimageKeys = [
    'authorization_mode',
    'authorized_sources',
    'evaluated_at',
    'expires_at',
    'generation_pin',
    'policy_revision_id',
    'principal_subject_id',
    'schema_version',
    'workspace_id',
    ...(mode === 'delegated' ? ['granted_by_subject_id'] : []),
  ];
  exactKeys(preimage, preimageKeys, '$.authority_snapshot.preimage');
  if (
    preimage.schema_version !== 'knowledge-authority-preimage/1' ||
    (mode !== 'direct' && mode !== 'delegated') ||
    preimage.workspace_id !== workspaceId ||
    preimage.principal_subject_id !== subjectId ||
    canonicalSha256(preimage.generation_pin) !== canonicalSha256(actual.full_pin) ||
    authority.authority_hash !== canonicalSha256(preimage)
  )
    fail(
      'AUTHORITY_INVALID',
      '$.authority_snapshot',
      'authority identity, generation or hash differs',
    );
  validUuid(
    preimage.policy_revision_id,
    '$.authority_snapshot.preimage.policy_revision_id',
    'AUTHORITY_INVALID',
  );
  if (mode === 'delegated') {
    const grantor = validUuid(
      preimage.granted_by_subject_id,
      '$.authority_snapshot.preimage.granted_by_subject_id',
      'AUTHORITY_INVALID',
    );
    if (grantor === subjectId)
      fail(
        'AUTHORITY_INVALID',
        '$.authority_snapshot.preimage',
        'delegation requires another grantor',
      );
  }
  const evaluated = validTime(preimage.evaluated_at, '$.authority_snapshot.preimage.evaluated_at');
  const expires = validTime(preimage.expires_at, '$.authority_snapshot.preimage.expires_at');
  const current = validTime(now, '$.now');
  if (evaluated > current || current >= expires || evaluated >= expires)
    fail('AUTHORITY_INVALID', '$.authority_snapshot.preimage', 'authority is not active at now');

  if (!Array.isArray(preimage.authorized_sources) || preimage.authorized_sources.length === 0)
    fail('AUTHORITY_INVALID', '$.authority_snapshot.preimage.authorized_sources', 'ACL is empty');
  const document = actual.document;
  if (document.schema_version !== 'knowledge-index-generation-source/1')
    return fail('SOURCE_INVALID', '$.prepared_source', 'expected Knowledge source');
  const manifest = new Set(
    document.source_manifest.sources.map(
      (source) => `${source.source_id}:${source.source_release_id}`,
    ),
  );
  const seen = new Set<string>();
  const authorized = preimage.authorized_sources.map((source, index) => {
    if (!object(source))
      return fail(
        'AUTHORITY_INVALID',
        `$.authority_snapshot.preimage.authorized_sources[${index}]`,
        'expected object',
      );
    exactKeys(
      source,
      ['source_id', 'source_release_id'],
      `$.authority_snapshot.preimage.authorized_sources[${index}]`,
    );
    const sourceId = validUuid(
      source.source_id,
      `$.authority_snapshot.preimage.authorized_sources[${index}].source_id`,
      'AUTHORITY_INVALID',
    );
    const releaseId = validUuid(
      source.source_release_id,
      `$.authority_snapshot.preimage.authorized_sources[${index}].source_release_id`,
      'AUTHORITY_INVALID',
    );
    const key = `${sourceId}:${releaseId}`;
    if (!manifest.has(key) || seen.has(key))
      fail(
        'AUTHORITY_INVALID',
        '$.authority_snapshot.preimage.authorized_sources',
        'ACL source is absent or duplicated',
      );
    seen.add(key);
    return { source_id: sourceId, source_release_id: releaseId };
  });
  return { authorityHash: authority.authority_hash as string, authorized };
}

function compileFilters(query: Record<string, unknown>, actual: PreparedLeafResourceSourceV1) {
  exactKeys(query, ['filters', 'text'], '$.query');
  if (typeof query.text !== 'string' || query.text.length === 0 || query.text.length > 32_768)
    fail('QUERY_INVALID', '$.query.text', 'query text must contain 1..32768 characters');
  if (!Array.isArray(query.filters) || query.filters.length > 128)
    fail('QUERY_INVALID', '$.query.filters', 'expected at most 128 filters');
  const document = actual.document;
  if (document.schema_version !== 'knowledge-index-generation-source/1')
    return fail('SOURCE_INVALID', '$.prepared_source', 'expected Knowledge source');
  const policy = new Map(
    document.metadata_filter_policy.allowed_fields.map((field) => [field.name, field]),
  );
  const filters: CompiledFilter[] = query.filters.map((filter, index) => {
    const path = `$.query.filters[${index}]`;
    if (!object(filter)) return fail('QUERY_INVALID', path, 'filter must be an object');
    exactKeys(filter, ['field', 'operator', 'value'], path);
    if (typeof filter.field !== 'string')
      return fail('QUERY_INVALID', `${path}.field`, 'unknown field');
    const allowed = policy.get(filter.field);
    if (allowed === undefined) return fail('QUERY_INVALID', `${path}.field`, 'unknown field');
    if (
      typeof filter.operator !== 'string' ||
      !allowed.operators.includes(filter.operator as never)
    )
      return fail('QUERY_INVALID', `${path}.operator`, 'operator is not allowed');
    const scalar = (value: unknown): string | number | boolean => {
      if (
        (allowed.value_type === 'string' && typeof value !== 'string') ||
        (allowed.value_type === 'boolean' && typeof value !== 'boolean') ||
        (allowed.value_type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)))
      )
        return fail('QUERY_INVALID', `${path}.value`, 'value type differs from policy');
      return value as string | number | boolean;
    };
    const value =
      filter.operator === 'in'
        ? (() => {
            if (
              !Array.isArray(filter.value) ||
              filter.value.length === 0 ||
              filter.value.length > 500
            )
              return fail('QUERY_INVALID', `${path}.value`, 'value must contain 1..500 items');
            return filter.value.map(scalar);
          })()
        : (() => {
            if (Array.isArray(filter.value))
              return fail('QUERY_INVALID', `${path}.value`, 'value must be scalar');
            return scalar(filter.value);
          })();
    return {
      field: filter.field,
      operator: filter.operator as CompiledFilter['operator'],
      value,
    };
  });
  return { text: query.text, filters };
}

export function compileKnowledgeQuery(input: unknown): CompiledKnowledgeQueryV1 {
  rejectAccessors(input);
  if (!object(input)) fail('INPUT_INVALID', '$', 'expected object');
  exactKeys(
    input,
    ['authority_snapshot', 'binding', 'now', 'prepared_source', 'principal', 'query'],
    '$',
  );
  if (!object(input.principal)) fail('INPUT_INVALID', '$.principal', 'expected object');
  exactKeys(input.principal, ['subject_id', 'workspace_id'], '$.principal');
  const workspaceId = validUuid(
    input.principal.workspace_id,
    '$.principal.workspace_id',
    'AUTHORITY_INVALID',
  );
  const subjectId = validUuid(
    input.principal.subject_id,
    '$.principal.subject_id',
    'AUTHORITY_INVALID',
  );
  const { actual, binding } = verifySourceAndBinding(input);
  if (actual.full_pin.workspace_id !== workspaceId)
    fail('AUTHORITY_INVALID', '$.principal.workspace_id', 'principal and source workspaces differ');
  const authority = verifyAuthority(
    input.authority_snapshot,
    actual,
    workspaceId,
    subjectId,
    input.now,
  );
  if (!object(input.query)) fail('QUERY_INVALID', '$.query', 'expected object');
  const query = compileFilters(input.query, actual);
  const document = actual.document;
  if (document.schema_version !== 'knowledge-index-generation-source/1')
    return fail('SOURCE_INVALID', '$.prepared_source', 'expected Knowledge source');
  const draft = {
    schema_version: 'compiled-knowledge-query/1',
    generation_pin: actual.full_pin,
    authority_hash: authority.authorityHash,
    workspace_id: workspaceId,
    subject_id: subjectId,
    authorized_sources: authority.authorized,
    text: query.text,
    filters: query.filters,
    embedding: document.embedding,
    retrieval: document.retrieval,
    rerank: document.rerank,
    index_manifest: document.index_manifest,
    timeout_ms: binding.timeout_ms,
  } as const;
  return deepFreeze({ ...draft, compiled_hash: canonicalSha256(draft) });
}
