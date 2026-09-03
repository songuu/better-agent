import { describe, expect, it, vi } from 'vitest';
import { sealBoundedResolvedPlan } from '../src/resolved-plan-seal.js';
import { canonicalSha256ExcludingRootKeys } from '../src/hash.js';

vi.mock('../src/hash.js', () => ({
  canonicalSha256ExcludingRootKeys: vi.fn(() => `sha256:${'a'.repeat(64)}`),
}));

// Independent key/text-byte accounting for the output snapshot budget, not JCS length.
function bytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (typeof value !== 'object' || value === null) return 0;
  return Object.entries(value).reduce(
    (sum, [key, child]) => sum + Buffer.byteLength(key) + bytes(child),
    0,
  );
}

describe('ResolvedPlan pre-hash evidence budget', () => {
  it('counts repeated shared Gate evidence at exact 32 MiB and rejects one extra byte before JCS', () => {
    const gate = { approver_policy_ref: 'x'.repeat(65_000) };
    const input = {
      required_calls: Array.from({ length: 515 }, () => ({ on_empty_gate: gate })),
      padding: '',
    };
    const reservedHash = { ...input, plan_hash: `sha256:${'0'.repeat(64)}` };
    input.padding = 'p'.repeat(33_554_432 - bytes(reservedHash));
    expect(input.padding.length).toBeLessThan(65_536);
    const hash = vi.mocked(canonicalSha256ExcludingRootKeys);
    hash.mockClear();
    expect(sealBoundedResolvedPlan(input).plan_hash).toBe(`sha256:${'a'.repeat(64)}`);
    expect(hash).toHaveBeenCalledTimes(1);
    hash.mockClear();
    expect(() => sealBoundedResolvedPlan({ ...input, padding: `${input.padding}p` })).toThrow(
      'CAPABILITY_CLOSURE_LIMIT_EXCEEDED',
    );
    expect(hash).not.toHaveBeenCalled();
  });
});
