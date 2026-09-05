import {
  HumanGateResumeActionV1Schema,
  HumanGateV1Schema,
  PostgresInstantV1Schema,
  type HumanGateResumeActionV1,
} from '@better-agent/domain-contracts';
import { boundedDataSnapshot, canonicalSha256, deepFreezeJson } from '@better-agent/release-core';
import { failRunCore } from './errors.js';

export function applyHumanGateMutation(input: {
  readonly gate: unknown;
  readonly expected_plan_hash: string;
  readonly expected_operation_hash: string;
  readonly action: HumanGateResumeActionV1;
  readonly actor: string;
  readonly claim_ref: string;
  readonly claim: unknown;
  readonly decision_ref: string;
  readonly decision: unknown;
  readonly now: string;
}) {
  const safe = boundedDataSnapshot(input, 'closure') as typeof input;
  const expectedKeys = [
    'action',
    'actor',
    'claim',
    'claim_ref',
    'decision',
    'decision_ref',
    'expected_operation_hash',
    'expected_plan_hash',
    'gate',
    'now',
  ].sort();
  const actualKeys = Object.keys(safe).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  )
    failRunCore('RUN_HUMAN_GATE_INVALID', '$', 'Human Gate mutation input is not closed');
  const parsed = HumanGateV1Schema.safeParse(safe.gate);
  if (!parsed.success)
    failRunCore('RUN_HUMAN_GATE_INVALID', '$.gate', 'Gate failed its closed contract');
  const gate = parsed.data;
  if (!HumanGateResumeActionV1Schema.safeParse(safe.action).success)
    failRunCore('RUN_HUMAN_GATE_INVALID', '$.action', 'unknown Human Gate action');
  if (!PostgresInstantV1Schema.safeParse(safe.now).success)
    failRunCore('RUN_HUMAN_GATE_INVALID', '$.now', 'invalid instant');
  const now = Date.parse(safe.now);
  if (
    gate.resolved_plan_hash !== safe.expected_plan_hash ||
    gate.canonical_operation_hash !== safe.expected_operation_hash
  )
    failRunCore(
      'RUN_HUMAN_GATE_INVALID',
      '$.gate',
      'Gate does not match the current immutable Plan operation',
    );
  if ((gate.gate_type === 'approval') !== (safe.action !== 'SUBMIT_INPUT'))
    failRunCore('RUN_HUMAN_GATE_INVALID', '$.action', 'action does not match the Gate type');
  if (now >= Date.parse(gate.expires_at))
    failRunCore('RUN_HUMAN_GATE_EXPIRED', '$.now', 'Gate is no longer resumable');
  if (
    ![safe.actor, safe.claim_ref, safe.decision_ref].every(
      (value) => typeof value === 'string' && value.trim().length > 0,
    )
  )
    failRunCore('RUN_HUMAN_GATE_INVALID', '$', 'claim or decision identity is invalid');
  const claimHash = canonicalSha256(safe.claim);
  const decisionHash = canonicalSha256(safe.decision);
  const status = safe.action === 'REJECT' ? 'REJECTED' : 'APPROVED';
  if (
    gate.status === status &&
    gate.claim_object_ref === safe.claim_ref &&
    gate.claim_sha256 === claimHash &&
    gate.decision_object_ref === safe.decision_ref &&
    gate.decision_sha256 === decisionHash
  )
    return deepFreezeJson({ gate, replayed: true as const });
  if (gate.status !== 'PENDING')
    failRunCore(
      'RUN_HUMAN_GATE_CONFLICT',
      '$.gate.status',
      'Gate already has a different disposition',
    );
  const verified = HumanGateV1Schema.safeParse({
    ...gate,
    status,
    claimed_by: safe.actor,
    claim_object_ref: safe.claim_ref,
    claim_sha256: claimHash,
    claimed_at: safe.now,
    decision_object_ref: safe.decision_ref,
    decision_sha256: decisionHash,
    updated_at: safe.now,
    resolved_at: safe.now,
  });
  if (!verified.success)
    failRunCore('RUN_HUMAN_GATE_INVALID', '$', 'prepared Gate disposition is invalid');
  return deepFreezeJson({ gate: verified.data, replayed: false as const });
}
