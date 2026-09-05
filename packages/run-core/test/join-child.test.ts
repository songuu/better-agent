import { describe, expect, it } from 'vitest';

import { prepareJoinChildAdmission, prepareJoinChildSettlement } from '../src/index.js';

const hash = (character: string) => `sha256:${character.repeat(64)}`;

const input = {
  admission: {
    schema_version: 'g1-join-child-admission/1',
    workspace_id: '018f47f2-c541-7cc6-9292-4a2c35304000',
    parent_run_id: '018f47f2-c541-7cc6-9292-4a2c35304001',
    child_run_id: '018f47f2-c541-7cc6-9292-4a2c35304002',
    link_id: '018f47f2-c541-7cc6-9292-4a2c35304003',
    billing_owner_run_id: '018f47f2-c541-7cc6-9292-4a2c35304001',
    parent_plan_hash: hash('a'),
    parent_checkpoint_id: '018f47f2-c541-7cc6-9292-4a2c35304006',
    parent_checkpoint_object_ref: 'run-checkpoint://parent/1',
    parent_checkpoint_sha256: hash('3'),
    child_plan_hash: hash('b'),
    canonical_operation_hash: hash('c'),
    binding_id: 'research-agent',
    target_agent_id: '018f47f2-c541-7cc6-9292-4a2c35304004',
    target_agent_release_id: '018f47f2-c541-7cc6-9292-4a2c35304005',
    target_ref: 'agent-release:researcher@1',
    ancestor_target_refs: ['agent-release:orchestrator@1'],
    parent_depth: 0,
    child_depth: 1,
    completed_child_calls: 0,
    call_sequence: 1,
    allocated_credits: 30,
    admission_snapshot_hash: hash('f'),
    accepted_output_schema_ref: 'schema://research-result/1',
    accepted_output_schema_hash: hash('1'),
    dependency_pins_hash: hash('2'),
    context_projection_object_ref: 'run-context://child/1',
    context_projection_sha256: hash('d'),
    delegation_reason: 'Research the bounded question',
    delegation: {
      schema_version: 'g1-bounded-child-delegation/1',
      policy_hash: hash('e'),
      allowed_target_refs: ['agent-release:researcher@1'],
      max_calls: 2,
      max_depth: 2,
      max_budget_credits: 50,
      issued_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-01-01T00:05:00.000Z',
    },
    compiled_child_ceiling: {
      schema_version: 'g1-join-child-ceiling/1',
      target_ref: 'agent-release:researcher@1',
      max_calls: 2,
      max_depth: 2,
      max_ttl_seconds: 300,
      max_budget_credits: '50',
      delegation_policy_hash: hash('e'),
    },
    async_child_policy: {
      schema_version: 'async-child-policy/1',
      invocation: 'async',
      completion_policy: 'join',
      cancel_propagation: 'cascade',
      result_projection: 'safe_summary',
      parent_terminal_policy: 'wait_for_settlement',
      terminal_outcome_map: {
        schema_version: 'g1-join-child-terminal-map/1',
        SUCCEEDED: 'PARENT_CALL_SUCCEEDED_CONTINUE',
        FAILED: 'PARENT_CALL_FAILED_PARENT_FAILED',
        CANCELLED: 'PARENT_CALL_CANCELLED_PARENT_CANCELLED',
        TIMED_OUT: 'PARENT_CALL_FAILED_CHILD_TIMED_OUT_PARENT_FAILED',
        NEEDS_ATTENTION: 'PARENT_CALL_AND_RUN_NEEDS_ATTENTION',
      },
    },
    created_at: '2026-01-01T00:01:00.000Z',
  },
} as const;

describe('join-only child admission', () => {
  it('accepts and freezes an exact bounded descendant admission', () => {
    const result = prepareJoinChildAdmission(input);
    expect(result.admission.child_depth).toBe(1);
    expect(result.admission.call_sequence).toBe(1);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ['ancestor target', { target_ref: input.admission.ancestor_target_refs[0] }],
    ['unapproved target', { target_ref: 'agent-release:other@1' }],
    ['expired delegation', { created_at: input.admission.delegation.expires_at }],
    ['call limit', { completed_child_calls: 2, call_sequence: 3 }],
    ['depth limit', { parent_depth: 2, child_depth: 3 }],
    ['budget limit', { allocated_credits: 51 }],
  ])('rejects %s before preparing a fact', (_name, override) => {
    expect(() =>
      prepareJoinChildAdmission({ admission: { ...input.admission, ...override } }),
    ).toThrowError(/RUN_JOIN_CHILD_INVALID|RUN_JOIN_CHILD_DENIED/);
  });

  it('rejects semantic drift and an open input object', () => {
    expect(() =>
      prepareJoinChildAdmission({
        admission: { ...input.admission, child_depth: 2 },
      }),
    ).toThrowError(/RUN_JOIN_CHILD_INVALID/);
    expect(() => prepareJoinChildAdmission({ ...input, authority: true } as never)).toThrowError(
      /RUN_JOIN_CHILD_INVALID/,
    );
  });
});

describe('join-only child settlement', () => {
  const settlement = {
    schema_version: 'g1-join-child-settlement/1' as const,
    workspace_id: input.admission.workspace_id,
    settlement_id: '018f47f2-c541-7cc6-9292-4a2c35304007',
    parent_run_id: input.admission.parent_run_id,
    child_run_id: input.admission.child_run_id,
    child_terminal_status: 'SUCCEEDED' as const,
    child_terminal_intent_hash: hash('4'),
    terminal_payload_object_ref: 'run-result://child/1',
    terminal_payload_sha256: hash('5'),
    child_billing_state: 'SETTLED' as const,
    allocation_status: 'SETTLED' as const,
    settled_at: '2026-01-01T00:04:00.000Z',
  };

  it('maps the immutable terminal outcome only while the parent waits', () => {
    expect(
      prepareJoinChildSettlement({ settlement, parent_status: 'WAITING_FOR_CHILD' }),
    ).toMatchObject({ parent_disposition: 'RESUME_PARENT' });
    expect(() => prepareJoinChildSettlement({ settlement, parent_status: 'RUNNING' })).toThrowError(
      /RUN_JOIN_CHILD_DENIED/,
    );
  });

  it.each([
    ['FAILED', 'FAIL_PARENT'],
    ['CANCELLED', 'CANCEL_PARENT'],
    ['TIMED_OUT', 'FAIL_PARENT_CHILD_TIMED_OUT'],
    ['NEEDS_ATTENTION', 'HOLD_PARENT_NEEDS_ATTENTION'],
  ] as const)('maps %s deterministically', (child_terminal_status, expected) => {
    expect(
      prepareJoinChildSettlement({
        settlement: { ...settlement, child_terminal_status },
        parent_status: 'WAITING_FOR_CHILD',
      }).parent_disposition,
    ).toBe(expected);
  });
});
