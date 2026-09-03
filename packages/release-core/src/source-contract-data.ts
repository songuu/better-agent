import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import { canonicalJsonBytes } from './canonical-json.js';
import { ReleaseCoreError } from './errors.js';

export function invalidSource(): never {
  throw new ReleaseCoreError(
    'CLOSURE_SOURCE_INVALID',
    '$',
    'source does not satisfy its closed contract',
  );
}
export function mismatchedSource(): never {
  throw new ReleaseCoreError(
    'CLOSURE_SOURCE_MISMATCH',
    '$',
    'source, complete artifact or assembly does not match',
  );
}
export function snapshotSource(input: unknown): unknown {
  const value = boundedDataSnapshot(input, 'source');
  if (canonicalJsonBytes(value).length > 8_388_608)
    throw new ReleaseCoreError(
      'CLOSURE_SOURCE_LIMIT_EXCEEDED',
      '$',
      'source exceeds its encoded byte budget',
    );
  return value;
}
export function sourceEqual(left: unknown, right: unknown): boolean {
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}
export function parseSourceLosslessly<T>(
  input: unknown,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): T {
  const result = schema.safeParse(input);
  if (!result.success || !sourceEqual(input, result.data)) invalidSource();
  return result.data;
}
export function canonicalSourceSet<T>(values: T[]): T[] {
  return values
    .map((value) => ({ value, bytes: canonicalJsonBytes(value) }))
    .sort((left, right) => Buffer.compare(left.bytes, right.bytes))
    .map(({ value }) => value);
}
