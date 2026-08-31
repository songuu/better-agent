import { describe, expect, it } from 'vitest';

import {
  RunAttemptLeaseAuthorityV1Schema,
  RunAttemptLeaseStateV1Schema,
  RunDispatchGenerationV1Schema,
  RunDispatchRetirementReceiptV1Schema,
  RunExecutionCheckpointV1Schema,
  RunLeaseDurationSecondsV1Schema,
  RunLeaseFencingTokenV1Schema,
  RunRecoveryEffectDecisionV1Schema,
  RunRecoveryHoldIntentV1Schema,
  RunRecoveryTicketDispositionV1Schema,
  RunRecoveryTicketV1Schema,
  RunRetryEffectEnvelopeV1Schema,
  RunSideEffectReceiptV1Schema,
  RunTerminationIntentRecordResultV1Schema,
  RunTerminationIntentV1Schema,
  RunUsageAttributionRecordResultV1Schema,
  RunUsageAttributionV1Schema,
} from '../src/run-execution-v1.js';

const ids = {
  workspace: '018f47f2-c541-7cc6-9292-4a2c35303001',
  run: '018f47f2-c541-7cc6-9292-4a2c35303002',
  attempt: '018f47f2-c541-7cc6-9292-4a2c35303003',
  step: '018f47f2-c541-7cc6-9292-4a2c35303004',
  reservation: '018f47f2-c541-7cc6-9292-4a2c35303005',
  envelope: '018f47f2-c541-7cc6-9292-4a2c35303006',
  receipt: '018f47f2-c541-7cc6-9292-4a2c35303007',
  checkpoint: '018f47f2-c541-7cc6-9292-4a2c35303008',
  usage: '018f47f2-c541-7cc6-9292-4a2c35303009',
  termination: '018f47f2-c541-7cc6-9292-4a2c3530300a',
  ticket: '018f47f2-c541-7cc6-9292-4a2c3530300b',
  disposition: '018f47f2-c541-7cc6-9292-4a2c3530300c',
  hold: '018f47f2-c541-7cc6-9292-4a2c3530300d',
  outbox: '018f47f2-c541-7cc6-9292-4a2c3530300e',
  retirement: '018f47f2-c541-7cc6-9292-4a2c3530300f',
  terminalSource: '018f47f2-c541-7cc6-9292-4a2c35303010',
  leaseToken: '018f47f2-c541-7cc6-9292-4a2c35303011',
  event: '018f47f2-c541-7cc6-9292-4a2c35303012',
} as const;

const hashA = `sha256:${'a'.repeat(64)}`;
const hashB = `sha256:${'b'.repeat(64)}`;
const authorizedAt = '2026-08-28T01:00:00.000Z';
const leaseExpiresAt = '2026-08-28T01:00:30.000Z';
const microsecondAuthorizedAt = '2026-08-28T01:00:00.123400Z';
const microsecondLeaseExpiresAt = '2026-08-28T01:00:00.123900Z';

const leaseAuthority = {
  schema_version: 'run-attempt-lease-authority/1',
  workspace_id: ids.workspace,
  run_id: ids.run,
  attempt_id: ids.attempt,
  step_id: ids.step,
  session_user: 'ba_execution_worker_a',
  lease_owner: 'ba_execution_worker_a',
  lease_token: ids.leaseToken,
  lease_fencing_token: '7',
  lease_expires_at: leaseExpiresAt,
  authorized_at: authorizedAt,
} as const;

const retryEnvelope = {
  schema_version: 'run-retry-effect-envelope/1',
  envelope_id: ids.envelope,
  workspace_id: ids.workspace,
  run_id: ids.run,
  attempt_id: ids.attempt,
  step_id: ids.step,
  accepted_plan_hash: hashA,
  operation_intent_sha256: hashA,
  effect_payload_sha256: hashB,
  effect_class: 'REQUIRES_KEY',
  recovery_decision: 'REPLAY_WITH_KEY',
  operation_key: 'tool-call:stable-key',
  created_at: authorizedAt,
} as const;

describe('G0-07 lease contracts', () => {
  it('accepts only explicit 1..300 second durations and safe canonical fencing strings', () => {
    expect(RunLeaseDurationSecondsV1Schema.safeParse(1).success).toBe(true);
    expect(RunLeaseDurationSecondsV1Schema.safeParse(300).success).toBe(true);
    for (const value of [0, 301, 1.5, undefined]) {
      expect(RunLeaseDurationSecondsV1Schema.safeParse(value).success).toBe(false);
    }

    expect(RunLeaseFencingTokenV1Schema.safeParse('1').success).toBe(true);
    expect(RunLeaseFencingTokenV1Schema.safeParse('9007199254740991').success).toBe(true);
    for (const value of ['0', '01', '+1', '-1', '9007199254740992', 1]) {
      expect(RunLeaseFencingTokenV1Schema.safeParse(value).success).toBe(false);
    }

    expect(RunDispatchGenerationV1Schema.safeParse('0').success).toBe(true);
    expect(RunDispatchGenerationV1Schema.safeParse('9007199254740991').success).toBe(true);
    for (const value of ['00', '01', '+1', '-1', '9007199254740992', 0]) {
      expect(RunDispatchGenerationV1Schema.safeParse(value).success).toBe(false);
    }
  });

  it('requires an all-or-nothing active lease and forbids it on pending or terminal states', () => {
    const running = {
      schema_version: 'run-attempt-lease-state/1',
      workspace_id: ids.workspace,
      run_id: ids.run,
      attempt_id: ids.attempt,
      attempt_number: 1,
      status: 'RUNNING',
      lease_owner: 'ba_execution_worker_a',
      lease_token: ids.leaseToken,
      lease_fencing_token: '7',
      lease_expires_at: leaseExpiresAt,
      started_at: authorizedAt,
      updated_at: authorizedAt,
    } as const;
    expect(RunAttemptLeaseStateV1Schema.safeParse(running).success).toBe(true);
    expect(
      RunAttemptLeaseStateV1Schema.safeParse({
        ...running,
        lease_expires_at: microsecondLeaseExpiresAt,
        updated_at: microsecondAuthorizedAt,
      }).success,
    ).toBe(true);

    const partial = { ...running } as Record<string, unknown>;
    delete partial.lease_token;
    expect(RunAttemptLeaseStateV1Schema.safeParse(partial).success).toBe(false);

    const terminal = {
      ...running,
      status: 'FAILED',
      finished_at: leaseExpiresAt,
    } as const;
    expect(RunAttemptLeaseStateV1Schema.safeParse(terminal).success).toBe(false);

    expect(
      RunAttemptLeaseStateV1Schema.safeParse({
        schema_version: 'run-attempt-lease-state/1',
        workspace_id: ids.workspace,
        run_id: ids.run,
        attempt_id: ids.attempt,
        attempt_number: 1,
        status: 'PENDING',
        pending_kind: 'RECOVERY',
        lease_fencing_token: '8',
        updated_at: authorizedAt,
      }).success,
    ).toBe(false);

    expect(
      RunAttemptLeaseStateV1Schema.safeParse({
        schema_version: 'run-attempt-lease-state/1',
        workspace_id: ids.workspace,
        run_id: ids.run,
        attempt_id: ids.attempt,
        attempt_number: 1,
        status: 'PENDING',
        pending_kind: 'RECOVERY',
        lease_fencing_token: '8',
        recovery_ticket_id: ids.ticket,
        started_at: authorizedAt,
        updated_at: authorizedAt,
      }).success,
    ).toBe(true);

    expect(
      RunAttemptLeaseStateV1Schema.safeParse({
        schema_version: 'run-attempt-lease-state/1',
        workspace_id: ids.workspace,
        run_id: ids.run,
        attempt_id: ids.attempt,
        attempt_number: 1,
        status: 'CANCELLED',
        finished_at: leaseExpiresAt,
        updated_at: leaseExpiresAt,
      }).success,
    ).toBe(true);
    expect(
      RunAttemptLeaseStateV1Schema.safeParse({
        schema_version: 'run-attempt-lease-state/1',
        workspace_id: ids.workspace,
        run_id: ids.run,
        attempt_id: ids.attempt,
        attempt_number: 1,
        status: 'FAILED',
        lease_fencing_token: '8',
        started_at: authorizedAt,
        finished_at: leaseExpiresAt,
        updated_at: leaseExpiresAt,
      }).success,
    ).toBe(true);
    expect(
      RunAttemptLeaseStateV1Schema.safeParse({
        ...running,
        status: 'FAILED',
        finished_at: microsecondAuthorizedAt,
        started_at: microsecondLeaseExpiresAt,
        updated_at: microsecondAuthorizedAt,
        lease_owner: undefined,
        lease_token: undefined,
        lease_expires_at: undefined,
      }).success,
    ).toBe(false);
  });

  it('binds authority session_user to lease_owner and validates DB-time authorization', () => {
    expect(RunAttemptLeaseAuthorityV1Schema.safeParse(leaseAuthority).success).toBe(true);
    expect(
      RunAttemptLeaseAuthorityV1Schema.safeParse({
        ...leaseAuthority,
        authorized_at: microsecondAuthorizedAt,
        lease_expires_at: microsecondLeaseExpiresAt,
      }).success,
    ).toBe(true);
    expect(
      RunAttemptLeaseAuthorityV1Schema.safeParse({
        ...leaseAuthority,
        authorized_at: microsecondLeaseExpiresAt,
        lease_expires_at: microsecondAuthorizedAt,
      }).success,
    ).toBe(false);
    expect(
      RunAttemptLeaseAuthorityV1Schema.safeParse({
        ...leaseAuthority,
        authorized_at: microsecondAuthorizedAt,
        lease_expires_at: microsecondAuthorizedAt,
      }).success,
    ).toBe(false);
    for (const [authorized_at, lease_expires_at] of [
      ['2026-08-28T01:00:00.0000001Z', '2026-08-28T01:00:01.0000004Z'],
      ['2026-08-28T01:00:00+16:00', '2026-08-28T01:00:01+16:00'],
      ['0000-01-01T00:00:00Z', '0000-01-01T00:00:01Z'],
    ] as const) {
      expect(
        RunAttemptLeaseAuthorityV1Schema.safeParse({
          ...leaseAuthority,
          authorized_at,
          lease_expires_at,
        }).success,
      ).toBe(false);
    }
    expect(
      RunAttemptLeaseAuthorityV1Schema.safeParse({
        ...leaseAuthority,
        authorized_at: '0001-01-01T00:00:00Z',
        lease_expires_at: '0001-01-01T00:00:01Z',
      }).success,
    ).toBe(true);
    expect(
      RunAttemptLeaseAuthorityV1Schema.safeParse({
        ...leaseAuthority,
        session_user: 'ba_execution_worker_b',
      }).success,
    ).toBe(false);
    expect(
      RunAttemptLeaseAuthorityV1Schema.safeParse({
        ...leaseAuthority,
        authorized_at: leaseExpiresAt,
      }).success,
    ).toBe(false);
    const missingOwner = { ...leaseAuthority } as Record<string, unknown>;
    delete missingOwner.lease_owner;
    expect(RunAttemptLeaseAuthorityV1Schema.safeParse(missingOwner).success).toBe(false);
  });
});

describe('G0-07 retry/effect and producer facts', () => {
  it('closes safe, keyed and unsafe retry decisions without caller ambiguity', () => {
    expect(RunRetryEffectEnvelopeV1Schema.safeParse(retryEnvelope).success).toBe(true);
    expect(
      RunRetryEffectEnvelopeV1Schema.safeParse({
        ...retryEnvelope,
        operation_key: undefined,
      }).success,
    ).toBe(false);
    expect(
      RunRetryEffectEnvelopeV1Schema.safeParse({
        ...retryEnvelope,
        effect_class: 'UNSAFE',
        recovery_decision: 'REPLAY_WITH_KEY',
      }).success,
    ).toBe(false);
    expect(
      RunRetryEffectEnvelopeV1Schema.safeParse({
        ...retryEnvelope,
        effect_class: 'SAFE',
        recovery_decision: 'REPLAY_SAFE',
        caller_hint: 'trust me',
      }).success,
    ).toBe(false);
    for (const invalid of [
      {
        ...retryEnvelope,
        effect_class: 'SAFE',
        recovery_decision: 'REPLAY_SAFE',
      },
      {
        ...retryEnvelope,
        effect_class: 'UNSAFE',
        recovery_decision: 'HOLD',
      },
      { ...retryEnvelope, operation_key: '   ' },
      { ...retryEnvelope, operation_key: 'x'.repeat(301) },
      { ...retryEnvelope, operation_key: ` ${'x'.repeat(299)} ` },
    ]) {
      expect(RunRetryEffectEnvelopeV1Schema.safeParse(invalid).success).toBe(false);
    }
    for (const blank of ['\t', '\n', '\u00a0']) {
      expect(
        RunRetryEffectEnvelopeV1Schema.safeParse({ ...retryEnvelope, operation_key: blank })
          .success,
      ).toBe(false);
    }
    expect(
      RunRetryEffectEnvelopeV1Schema.safeParse({
        ...retryEnvelope,
        operation_key: ` ${'x'.repeat(298)} `,
      }).success,
    ).toBe(true);
    expect(
      RunRetryEffectEnvelopeV1Schema.safeParse({
        ...retryEnvelope,
        operation_key: '😀'.repeat(151),
      }).success,
    ).toBe(true);
    expect(
      RunRetryEffectEnvelopeV1Schema.safeParse({
        ...retryEnvelope,
        operation_key: '😀'.repeat(301),
      }).success,
    ).toBe(false);
    for (const operationKey of ['\u0000', 'key\u0000suffix', String.fromCharCode(0xd800)]) {
      expect(
        RunRetryEffectEnvelopeV1Schema.safeParse({
          ...retryEnvelope,
          operation_key: operationKey,
        }).success,
      ).toBe(false);
    }
  });

  it('requires a confirmed external receipt ref/hash pair or an explicit UNKNOWN reason', () => {
    const confirmed = {
      schema_version: 'run-side-effect-receipt/1',
      effect_receipt_id: ids.receipt,
      workspace_id: ids.workspace,
      run_id: ids.run,
      attempt_id: ids.attempt,
      step_id: ids.step,
      retry_effect_envelope_id: ids.envelope,
      retry_effect_envelope_sha256: hashA,
      effect_class: 'REQUIRES_KEY',
      operation_key: retryEnvelope.operation_key,
      outcome: 'CONFIRMED',
      external_receipt_ref: 'provider://receipts/42',
      external_receipt_sha256: hashB,
      result_payload_sha256: hashA,
      producer_session_user: leaseAuthority.session_user,
      lease_owner: leaseAuthority.lease_owner,
      lease_token: ids.leaseToken,
      lease_fencing_token: '7',
      lease_expires_at: leaseExpiresAt,
      authorized_at: authorizedAt,
    } as const;
    expect(RunSideEffectReceiptV1Schema.safeParse(confirmed).success).toBe(true);
    expect(
      RunSideEffectReceiptV1Schema.safeParse({
        ...confirmed,
        authorized_at: '2026-08-28T09:00:00.123400+08:00',
        lease_expires_at: microsecondLeaseExpiresAt,
      }).success,
    ).toBe(true);
    expect(
      RunSideEffectReceiptV1Schema.safeParse({
        ...confirmed,
        authorized_at: microsecondLeaseExpiresAt,
        lease_expires_at: microsecondAuthorizedAt,
      }).success,
    ).toBe(false);
    expect(
      RunSideEffectReceiptV1Schema.safeParse({
        ...confirmed,
        authorized_at: microsecondAuthorizedAt,
        lease_expires_at: microsecondAuthorizedAt,
      }).success,
    ).toBe(false);
    expect(
      RunSideEffectReceiptV1Schema.safeParse({
        ...confirmed,
        external_receipt_sha256: undefined,
      }).success,
    ).toBe(false);
    expect(
      RunSideEffectReceiptV1Schema.safeParse({
        ...confirmed,
        outcome: 'UNKNOWN',
        external_receipt_ref: undefined,
        external_receipt_sha256: undefined,
        unknown_reason_code: 'PROVIDER_RESPONSE_LOST',
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...confirmed, effect_class: 'SAFE' },
      { ...confirmed, effect_class: 'UNSAFE' },
      { ...confirmed, operation_key: '   ' },
      { ...confirmed, operation_key: 'x'.repeat(301) },
      { ...confirmed, operation_key: ` ${'x'.repeat(299)} ` },
      { ...confirmed, external_receipt_ref: '   ' },
    ]) {
      expect(RunSideEffectReceiptV1Schema.safeParse(invalid).success).toBe(false);
    }
    expect(
      RunSideEffectReceiptV1Schema.safeParse({
        ...confirmed,
        operation_key: ` ${'x'.repeat(298)} `,
      }).success,
    ).toBe(true);
    expect(
      RunSideEffectReceiptV1Schema.safeParse({
        ...confirmed,
        outcome: 'UNKNOWN',
        external_receipt_ref: undefined,
        external_receipt_sha256: undefined,
        unknown_reason_code: '   ',
      }).success,
    ).toBe(false);
  });

  it('requires checkpoint and usage facts to carry the full historical producer tuple', () => {
    const checkpoint = {
      schema_version: 'run-execution-checkpoint/1',
      checkpoint_id: ids.checkpoint,
      workspace_id: ids.workspace,
      run_id: ids.run,
      attempt_id: ids.attempt,
      step_id: ids.step,
      checkpoint_sequence: '1',
      checkpoint_ref: 'postgres://run-checkpoints/1',
      checkpoint_sha256: hashA,
      producer_session_user: leaseAuthority.session_user,
      lease_owner: leaseAuthority.lease_owner,
      lease_token: ids.leaseToken,
      lease_fencing_token: '7',
      lease_expires_at: leaseExpiresAt,
      authorized_at: authorizedAt,
    } as const;
    expect(RunExecutionCheckpointV1Schema.parse(checkpoint)).toEqual(checkpoint);
    expect(
      RunExecutionCheckpointV1Schema.safeParse({ ...checkpoint, checkpoint_ref: '   ' }).success,
    ).toBe(false);
    const missingAttempt = { ...checkpoint } as Record<string, unknown>;
    delete missingAttempt.attempt_id;
    expect(RunExecutionCheckpointV1Schema.safeParse(missingAttempt).success).toBe(false);

    const usage = {
      schema_version: 'run-usage-attribution/1',
      usage_attribution_id: ids.usage,
      workspace_id: ids.workspace,
      billing_owner_run_id: ids.run,
      run_id: ids.run,
      reservation_id: ids.reservation,
      attempt_id: ids.attempt,
      step_id: ids.step,
      producer_session_user: leaseAuthority.session_user,
      lease_owner: leaseAuthority.lease_owner,
      lease_token: ids.leaseToken,
      lease_fencing_token: '7',
      lease_expires_at: leaseExpiresAt,
      authorized_at: authorizedAt,
      producer_operation_key: 'worker:usage:request-1',
      metering_unit: 'tokens',
      metering_quantity: '12',
      amount_credits: '3',
      settlement_operation_key: 'settle:usage:1',
      operation_intent_sha256: hashA,
      execution_effect_payload_sha256: hashB,
      consumption_generation: '1',
    } as const;
    expect(RunUsageAttributionV1Schema.safeParse(usage).success).toBe(true);
    expect(
      RunUsageAttributionV1Schema.safeParse({
        ...usage,
        producer_session_user: 'stolen-worker',
      }).success,
    ).toBe(false);
    const missingFence = { ...usage } as Record<string, unknown>;
    delete missingFence.lease_fencing_token;
    expect(RunUsageAttributionV1Schema.safeParse(missingFence).success).toBe(false);
    expect(
      RunUsageAttributionV1Schema.safeParse({ ...usage, producer_operation_key: '   ' }).success,
    ).toBe(false);
    expect(
      RunUsageAttributionV1Schema.safeParse({
        ...usage,
        producer_operation_key: 'x'.repeat(301),
      }).success,
    ).toBe(false);
    expect(
      RunUsageAttributionV1Schema.safeParse({
        ...usage,
        producer_operation_key: ` ${'x'.repeat(299)} `,
      }).success,
    ).toBe(false);
    expect(RunUsageAttributionV1Schema.safeParse({ ...usage, metering_unit: '   ' }).success).toBe(
      false,
    );
    for (const blank of ['\t', '\n', '\u00a0']) {
      expect(
        RunUsageAttributionV1Schema.safeParse({ ...usage, metering_unit: blank }).success,
      ).toBe(false);
    }

    const result = {
      schema_version: 'run-usage-attribution-record-result/1',
      source: usage,
      source_authority_hash: hashA,
      detail_redacted: { model: 'provider-model' },
      replayed: false,
    } as const;
    expect(RunUsageAttributionRecordResultV1Schema.parse(result)).toEqual(result);
    expect(
      RunUsageAttributionRecordResultV1Schema.safeParse({ ...result, caller_hint: 'trust me' })
        .success,
    ).toBe(false);
    expect(
      RunUsageAttributionRecordResultV1Schema.safeParse({
        ...result,
        source: { ...usage, caller_hint: 'trust me' },
      }).success,
    ).toBe(false);
    expect(
      RunUsageAttributionRecordResultV1Schema.safeParse({
        ...result,
        detail_redacted: { provider: 'bad\u0000value' },
      }).success,
    ).toBe(false);
    expect(
      RunUsageAttributionRecordResultV1Schema.safeParse({
        ...result,
        detail_redacted: { [String.fromCharCode(0xd800)]: 'bad key' },
      }).success,
    ).toBe(false);
  });

  it('allows termination authority only after CLOSED effect closure and sorted usage IDs', () => {
    const usageIdB = '018f47f2-c541-7cc6-9292-4a2c35303020';
    const termination = {
      schema_version: 'run-termination-intent/1',
      termination_intent_id: ids.termination,
      workspace_id: ids.workspace,
      billing_owner_run_id: ids.run,
      run_id: ids.run,
      reservation_id: ids.reservation,
      attempt_id: ids.attempt,
      step_id: ids.step,
      producer_session_user: leaseAuthority.session_user,
      lease_owner: leaseAuthority.lease_owner,
      lease_token: ids.leaseToken,
      lease_fencing_token: '7',
      lease_expires_at: leaseExpiresAt,
      authorized_at: authorizedAt,
      producer_operation_key: 'worker:termination:request-1',
      terminal_status: 'CANCELLED',
      termination_reason: 'USER_CANCELLED',
      effect_disposition: 'CLOSED',
      effect_closure_sha256: hashA,
      usage_attribution_ids: [ids.usage, usageIdB],
      intended_settle_credits: '3',
      settlement_operation_key: 'settle:terminal:1',
      intended_release_credits: '2',
      release_operation_key: 'release:terminal:1',
      release_reason_code: 'USER_CANCELLED',
      operation_intent_sha256: hashB,
      consumption_generation: '1',
    } as const;
    expect(RunTerminationIntentV1Schema.safeParse(termination).success).toBe(true);
    expect(
      RunTerminationIntentV1Schema.safeParse({
        ...termination,
        effect_disposition: 'UNKNOWN',
      }).success,
    ).toBe(false);
    expect(
      RunTerminationIntentV1Schema.safeParse({
        ...termination,
        usage_attribution_ids: [usageIdB, ids.usage],
      }).success,
    ).toBe(false);
    expect(
      RunTerminationIntentV1Schema.safeParse({
        ...termination,
        terminal_status: 'FAILED',
      }).success,
    ).toBe(false);
    expect(
      RunTerminationIntentV1Schema.safeParse({
        ...termination,
        terminal_status: 'TIMED_OUT',
        termination_reason: 'RUN_TIMED_OUT',
      }).success,
    ).toBe(false);
    expect(
      RunTerminationIntentV1Schema.safeParse({
        ...termination,
        terminal_status: 'FAILED',
        termination_reason: 'RUN_TIMED_OUT',
      }).success,
    ).toBe(false);
    expect(
      RunTerminationIntentV1Schema.safeParse({
        ...termination,
        producer_operation_key: '   ',
      }).success,
    ).toBe(false);
    expect(
      RunTerminationIntentV1Schema.safeParse({
        ...termination,
        producer_operation_key: 'x'.repeat(301),
      }).success,
    ).toBe(false);
    expect(
      RunTerminationIntentV1Schema.safeParse({
        ...termination,
        producer_operation_key: ` ${'x'.repeat(299)} `,
      }).success,
    ).toBe(false);
    expect(
      RunTerminationIntentV1Schema.safeParse({
        ...termination,
        settlement_operation_key: '   ',
      }).success,
    ).toBe(false);
    expect(
      RunTerminationIntentV1Schema.safeParse({
        ...termination,
        release_operation_key: '   ',
      }).success,
    ).toBe(false);
    expect(
      RunTerminationIntentV1Schema.safeParse({ ...termination, release_reason_code: '   ' })
        .success,
    ).toBe(false);

    const result = {
      schema_version: 'run-termination-intent-record-result/1',
      intent: termination,
      terminal_intent_hash: hashA,
      source_authority_hash: hashB,
      billing_close_intent_redacted: { reservation_id: ids.reservation },
      replayed: true,
    } as const;
    expect(RunTerminationIntentRecordResultV1Schema.parse(result)).toEqual(result);
    expect(
      RunTerminationIntentRecordResultV1Schema.safeParse({
        ...result,
        caller_hint: 'trust me',
      }).success,
    ).toBe(false);
    expect(
      RunTerminationIntentRecordResultV1Schema.safeParse({
        ...result,
        intent: { ...termination, caller_hint: 'trust me' },
      }).success,
    ).toBe(false);
  });
});

describe('G0-07 recovery and terminal retirement facts', () => {
  const recoveryEffectDecision = {
    retry_effect_envelope_id: ids.envelope,
    retry_effect_envelope_sha256: hashB,
    effect_class: 'REQUIRES_KEY',
    recovery_decision: 'REPLAY_WITH_KEY',
    operation_key: retryEnvelope.operation_key,
  } as const;
  const recoveryTicket = {
    schema_version: 'run-recovery-ticket/1',
    recovery_ticket_id: ids.ticket,
    workspace_id: ids.workspace,
    run_id: ids.run,
    resource_kind: 'ATTEMPT',
    resource_id: ids.attempt,
    old_fencing_token: '7',
    new_fencing_token: '8',
    created_generation: '8',
    checkpoint_id: ids.checkpoint,
    checkpoint_sha256: hashA,
    effect_decisions: [recoveryEffectDecision],
    effect_decisions_sha256: hashA,
    created_at: authorizedAt,
  } as const;

  it('makes recovery tickets immutable lease-free N+1 facts', () => {
    expect(RunRecoveryEffectDecisionV1Schema.safeParse(recoveryEffectDecision).success).toBe(true);
    expect(RunRecoveryTicketV1Schema.safeParse(recoveryTicket).success).toBe(true);
    expect(
      RunRecoveryTicketV1Schema.safeParse({
        ...recoveryTicket,
        new_fencing_token: '9',
      }).success,
    ).toBe(false);
    expect(
      RunRecoveryTicketV1Schema.safeParse({
        ...recoveryTicket,
        lease_owner: 'must-not-be-a-capability',
      }).success,
    ).toBe(false);
    const parseInvalidFence = () =>
      RunRecoveryTicketV1Schema.safeParse({
        ...recoveryTicket,
        old_fencing_token: 'abc',
      });
    expect(parseInvalidFence).not.toThrow();
    expect(parseInvalidFence().success).toBe(false);

    const confirmedDecision = {
      retry_effect_envelope_id: '018f47f2-c541-7cc6-9292-4a2c35303020',
      retry_effect_envelope_sha256: hashA,
      effect_class: 'SAFE',
      recovery_decision: 'RESUME_FROM_RECEIPT',
      effect_receipt_id: ids.receipt,
      effect_receipt_sha256: hashB,
    } as const;
    expect(RunRecoveryEffectDecisionV1Schema.safeParse(confirmedDecision).success).toBe(true);
    expect(
      RunRecoveryTicketV1Schema.safeParse({
        ...recoveryTicket,
        effect_decisions: [confirmedDecision, recoveryEffectDecision],
      }).success,
    ).toBe(false);
    expect(
      RunRecoveryTicketV1Schema.safeParse({
        ...recoveryTicket,
        effect_decisions: [recoveryEffectDecision, confirmedDecision],
      }).success,
    ).toBe(true);
  });

  it('closes each ticket with exactly one claimed or terminal disposition shape', () => {
    const claimed = {
      schema_version: 'run-recovery-ticket-disposition/1',
      disposition_id: ids.disposition,
      recovery_ticket_id: ids.ticket,
      recovery_ticket_sha256: hashA,
      workspace_id: ids.workspace,
      run_id: ids.run,
      resource_kind: 'ATTEMPT',
      resource_id: ids.attempt,
      ticket_fencing_token: '8',
      disposition_kind: 'CLAIMED',
      claim_fencing_token: '9',
      claim_session_user: 'ba_execution_worker_b',
      claim_lease_owner: 'ba_execution_worker_b',
      claim_lease_token: ids.leaseToken,
      claim_lease_expires_at: leaseExpiresAt,
      disposed_at: authorizedAt,
    } as const;
    expect(RunRecoveryTicketDispositionV1Schema.safeParse(claimed).success).toBe(true);
    expect(
      RunRecoveryTicketDispositionV1Schema.safeParse({
        ...claimed,
        disposed_at: microsecondAuthorizedAt,
        claim_lease_expires_at: microsecondLeaseExpiresAt,
      }).success,
    ).toBe(true);
    expect(
      RunRecoveryTicketDispositionV1Schema.safeParse({
        ...claimed,
        terminal_source_kind: 'DURABLE_CANCEL',
      }).success,
    ).toBe(false);

    const retired = {
      schema_version: 'run-recovery-ticket-disposition/1',
      disposition_id: ids.disposition,
      recovery_ticket_id: ids.ticket,
      recovery_ticket_sha256: hashA,
      workspace_id: ids.workspace,
      run_id: ids.run,
      resource_kind: 'ATTEMPT',
      resource_id: ids.attempt,
      ticket_fencing_token: '8',
      disposition_kind: 'TERMINAL_RETIRED',
      terminal_source_kind: 'DURABLE_CANCEL',
      terminal_source_id: ids.terminalSource,
      terminal_source_sha256: hashB,
      terminal_intent_sha256: hashA,
      terminal_resource_status: 'CANCELLED',
      disposed_at: authorizedAt,
    } as const;
    expect(RunRecoveryTicketDispositionV1Schema.safeParse(retired).success).toBe(true);
    expect(
      RunRecoveryTicketDispositionV1Schema.safeParse({
        ...retired,
        terminal_resource_status: 'FAILED',
      }).success,
    ).toBe(false);
    expect(
      RunRecoveryTicketDispositionV1Schema.safeParse({
        ...retired,
        terminal_source_kind: 'TERMINATION_ATTRIBUTION',
        terminal_resource_status: 'FAILED',
      }).success,
    ).toBe(true);
    expect(
      RunRecoveryTicketDispositionV1Schema.safeParse({
        ...retired,
        terminal_source_kind: 'RECOVERY_HOLD',
      }).success,
    ).toBe(false);
    expect(
      RunRecoveryTicketDispositionV1Schema.safeParse({
        ...retired,
        terminal_source_kind: 'RECOVERY_HOLD',
        terminal_resource_status: 'RELINQUISHED',
      }).success,
    ).toBe(true);
    expect(
      RunRecoveryTicketDispositionV1Schema.safeParse({
        ...retired,
        terminal_resource_status: 'RELINQUISHED',
      }).success,
    ).toBe(false);
  });

  it('records HOLD evidence without manufacturing a ticket or active lease', () => {
    const hold = {
      schema_version: 'run-recovery-hold-intent/1',
      recovery_hold_intent_id: ids.hold,
      workspace_id: ids.workspace,
      run_id: ids.run,
      resource_kind: 'ATTEMPT',
      resource_id: ids.attempt,
      old_fencing_token: '7',
      new_fencing_token: '8',
      created_generation: '8',
      hold_reason: 'SIDE_EFFECT_UNKNOWN',
      retry_effect_envelope_id: ids.envelope,
      retry_effect_envelope_sha256: hashA,
      effect_receipt_id: ids.receipt,
      effect_receipt_sha256: hashB,
      hold_evidence_sha256: hashA,
      checkpoint_id: ids.checkpoint,
      checkpoint_sha256: hashB,
      created_at: authorizedAt,
    } as const;
    expect(RunRecoveryHoldIntentV1Schema.safeParse(hold).success).toBe(true);
    expect(
      RunRecoveryHoldIntentV1Schema.safeParse({ ...hold, effect_receipt_id: undefined }).success,
    ).toBe(false);
    expect(
      RunRecoveryHoldIntentV1Schema.safeParse({ ...hold, lease_token: ids.leaseToken }).success,
    ).toBe(false);

    const aggregateHold = {
      ...hold,
      hold_reason: 'EFFECT_CLOSURE_OPEN',
      retry_effect_envelope_id: undefined,
      retry_effect_envelope_sha256: undefined,
      effect_receipt_id: undefined,
      effect_receipt_sha256: undefined,
      effect_closure_disposition: 'OPEN',
      effect_closure_sha256: hashB,
    } as const;
    expect(RunRecoveryHoldIntentV1Schema.safeParse(aggregateHold).success).toBe(true);
    expect(
      RunRecoveryHoldIntentV1Schema.safeParse({
        ...aggregateHold,
        effect_closure_disposition: 'CLOSED',
      }).success,
    ).toBe(false);
  });

  it('retires PENDING or LEASED RUN_DISPATCH without forging DELIVERED', () => {
    const pending = {
      schema_version: 'run-dispatch-retirement-receipt/1',
      retirement_receipt_id: ids.retirement,
      workspace_id: ids.workspace,
      run_id: ids.run,
      outbox_id: ids.outbox,
      old_status: 'PENDING',
      old_delivery_generation: '0',
      new_delivery_generation: '0',
      retired_status: 'DEAD',
      last_error_code: 'RUN_TERMINATED_BEFORE_DISPATCH',
      terminal_source_kind: 'DURABLE_CANCEL',
      terminal_source_id: ids.event,
      terminal_source_sha256: hashA,
      terminal_intent_sha256: hashB,
      retired_at: authorizedAt,
    } as const;
    expect(RunDispatchRetirementReceiptV1Schema.safeParse(pending).success).toBe(true);

    const leased = {
      ...pending,
      old_status: 'LEASED',
      old_lease_owner: 'ba_execution_worker_a',
      old_lease_token: ids.leaseToken,
      old_lease_fencing_token: '3',
      old_lease_expires_at: leaseExpiresAt,
      old_delivery_generation: '3',
      new_delivery_generation: '4',
    } as const;
    expect(RunDispatchRetirementReceiptV1Schema.safeParse(leased).success).toBe(true);
    expect(
      RunDispatchRetirementReceiptV1Schema.safeParse({
        ...leased,
        old_status: 'DELIVERED',
      }).success,
    ).toBe(false);
    expect(
      RunDispatchRetirementReceiptV1Schema.safeParse({
        ...leased,
        old_delivery_generation: '0',
        new_delivery_generation: '1',
      }).success,
    ).toBe(false);
    expect(
      RunDispatchRetirementReceiptV1Schema.safeParse({
        ...pending,
        new_delivery_generation: '2',
      }).success,
    ).toBe(false);
  });
});
