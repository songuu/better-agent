import { createHash } from 'node:crypto';

import { canonicalJsonBytes, canonicalJsonBytesExcludingRootKeys } from './canonical-json.js';

export type CanonicalSha256V1 = `sha256:${string}`;

function sha256(bytes: Uint8Array): CanonicalSha256V1 {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function canonicalSha256(value: unknown): CanonicalSha256V1 {
  return sha256(canonicalJsonBytes(value));
}

export function canonicalSha256ExcludingRootKeys(
  value: unknown,
  excludedRootKeys: readonly string[],
): CanonicalSha256V1 {
  return sha256(canonicalJsonBytesExcludingRootKeys(value, excludedRootKeys));
}
