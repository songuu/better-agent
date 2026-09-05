import {
  comparePostgresInstants,
  G1JoinChildAdmissionV1Schema,
  G1JoinChildSettlementV1Schema,
} from '@better-agent/domain-contracts';
import { boundedDataSnapshot, deepFreezeJson } from '@better-agent/release-core';
import { failRunCore } from './errors.js';

export function prepareJoinChildAdmission(input: { readonly admission: unknown }) {
  const safe = boundedDataSnapshot(input, 'closure') as typeof input;
  if (Object.keys(safe).length !== 1 || !Object.hasOwn(safe, 'admission'))
    failRunCore('RUN_JOIN_CHILD_INVALID', '$', 'join-child input is not closed');

  const parsed = G1JoinChildAdmissionV1Schema.safeParse(safe.admission);
  if (!parsed.success)
    failRunCore('RUN_JOIN_CHILD_INVALID', '$.admission', 'admission failed its closed contract');
  const admission = parsed.data;
  const { delegation } = admission;
  const ceiling = admission.compiled_child_ceiling;

  if (
    comparePostgresInstants(delegation.issued_at, admission.created_at) === 1 ||
    comparePostgresInstants(admission.created_at, delegation.expires_at) !== -1
  )
    failRunCore('RUN_JOIN_CHILD_DENIED', '$.admission.created_at', 'delegation is not live');
  if (!delegation.allowed_target_refs.includes(admission.target_ref))
    failRunCore(
      'RUN_JOIN_CHILD_DENIED',
      '$.admission.target_ref',
      'target is outside the allow-set',
    );
  if (
    ceiling.target_ref !== admission.target_ref ||
    delegation.policy_hash !== ceiling.delegation_policy_hash ||
    delegation.allowed_target_refs.length !== 1 ||
    delegation.max_calls !== ceiling.max_calls ||
    delegation.max_depth !== ceiling.max_depth ||
    delegation.max_budget_credits.toString() !== ceiling.max_budget_credits ||
    Date.parse(delegation.expires_at) - Date.parse(delegation.issued_at) >
      ceiling.max_ttl_seconds * 1_000
  )
    failRunCore(
      'RUN_JOIN_CHILD_DENIED',
      '$.admission.compiled_child_ceiling',
      'runtime delegation exceeds or differs from the compiled child ceiling',
    );
  if (admission.ancestor_target_refs.includes(admission.target_ref))
    failRunCore(
      'RUN_JOIN_CHILD_DENIED',
      '$.admission.target_ref',
      'target matches an ancestor and would create recursive execution',
    );
  if (admission.call_sequence > delegation.max_calls)
    failRunCore(
      'RUN_JOIN_CHILD_DENIED',
      '$.admission.call_sequence',
      'delegated call limit exceeded',
    );
  if (admission.child_depth > delegation.max_depth)
    failRunCore(
      'RUN_JOIN_CHILD_DENIED',
      '$.admission.child_depth',
      'delegated depth limit exceeded',
    );
  if (admission.allocated_credits > delegation.max_budget_credits)
    failRunCore('RUN_JOIN_CHILD_DENIED', '$.admission.allocated_credits', 'budget limit exceeded');

  return deepFreezeJson({ admission });
}

const terminalDisposition = {
  SUCCEEDED: 'RESUME_PARENT',
  FAILED: 'FAIL_PARENT',
  CANCELLED: 'CANCEL_PARENT',
  TIMED_OUT: 'FAIL_PARENT_CHILD_TIMED_OUT',
  NEEDS_ATTENTION: 'HOLD_PARENT_NEEDS_ATTENTION',
} as const;

export function prepareJoinChildSettlement(input: {
  readonly settlement: unknown;
  readonly parent_status: unknown;
}) {
  const safe = boundedDataSnapshot(input, 'closure') as typeof input;
  const keys = Object.keys(safe).sort();
  if (keys.length !== 2 || keys[0] !== 'parent_status' || keys[1] !== 'settlement')
    failRunCore('RUN_JOIN_CHILD_INVALID', '$', 'join-child settlement input is not closed');
  const parsed = G1JoinChildSettlementV1Schema.safeParse(safe.settlement);
  if (!parsed.success)
    failRunCore('RUN_JOIN_CHILD_INVALID', '$.settlement', 'settlement failed its contract');
  if (safe.parent_status !== 'WAITING_FOR_CHILD')
    failRunCore(
      'RUN_JOIN_CHILD_DENIED',
      '$.parent_status',
      'parent is not waiting for a child settlement',
    );
  return deepFreezeJson({
    settlement: parsed.data,
    parent_disposition: terminalDisposition[parsed.data.child_terminal_status],
  });
}
