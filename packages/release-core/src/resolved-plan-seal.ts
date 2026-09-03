import type { ResolvedExecutionPlanV1 } from '@better-agent/domain-contracts';
import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import { canonicalSha256ExcludingRootKeys } from './hash.js';

/** Package-private: bound expanded evidence before JCS allocates the complete preimage. */
export function sealBoundedResolvedPlan(input: unknown) {
  const candidate = boundedDataSnapshot(input, 'closure') as Omit<
    ResolvedExecutionPlanV1,
    'plan_hash'
  >;
  // Reserve the real field's full byte cost too, so the sealed output remains consumable.
  const bounded = boundedDataSnapshot(
    { ...candidate, plan_hash: `sha256:${'0'.repeat(64)}` },
    'closure',
  ) as ResolvedExecutionPlanV1;
  return { ...bounded, plan_hash: canonicalSha256ExcludingRootKeys(bounded, ['plan_hash']) };
}
