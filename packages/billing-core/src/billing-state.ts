import type { RunBillingStateV1, RunBillingStateValueV1 } from '@better-agent/domain-contracts';
import { RunBillingStateV1Schema } from '@better-agent/domain-contracts';

import { BillingCoreError } from './errors.js';
import { deepFreezeFactV1 } from './freeze.js';

export function createInitialRunBillingStateV1(
  workspaceId: string,
  runId: string,
): RunBillingStateV1 {
  return parseBillingState({
    schema_version: 'run-billing-state/1',
    workspace_id: workspaceId,
    run_id: runId,
    billing_state: 'PENDING',
    billing_settled_at: null,
  });
}

export function transitionRunBillingStateV1(
  currentInput: RunBillingStateV1,
  target: RunBillingStateValueV1,
  billingSettledAt: string | null,
): RunBillingStateV1 {
  const current = parseBillingState(currentInput);
  const allowed =
    current.billing_state === target ||
    (current.billing_state === 'PENDING' &&
      (target === 'SETTLED' || target === 'NEEDS_ATTENTION')) ||
    (current.billing_state === 'NEEDS_ATTENTION' && target === 'SETTLED');
  if (!allowed) {
    throw new BillingCoreError(
      'BILLING_STATE_TRANSITION_INVALID',
      `current billing cannot move from ${current.billing_state} to ${target}`,
      { current_state: current.billing_state, target_state: target },
    );
  }

  if (current.billing_state === target) {
    if (current.billing_settled_at !== billingSettledAt) {
      throw new BillingCoreError(
        'BILLING_STATE_TRANSITION_INVALID',
        'an idempotent billing-state replay must preserve billing_settled_at',
        { current_state: current.billing_state },
      );
    }
    return current;
  }

  const candidate = {
    ...current,
    billing_state: target,
    billing_settled_at: billingSettledAt,
  };
  const result = RunBillingStateV1Schema.safeParse(candidate);
  if (!result.success) {
    throw new BillingCoreError(
      'BILLING_STATE_TRANSITION_INVALID',
      'target billing state has an invalid settlement timestamp shape',
      { current_state: current.billing_state, target_state: target },
    );
  }
  return deepFreezeFactV1(result.data);
}

function parseBillingState(input: unknown): RunBillingStateV1 {
  const result = RunBillingStateV1Schema.safeParse(input);
  if (!result.success) {
    throw new BillingCoreError('BILLING_FACT_INVALID', 'current billing state is invalid');
  }
  return deepFreezeFactV1(result.data);
}
