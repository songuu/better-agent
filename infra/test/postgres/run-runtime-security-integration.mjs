import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadMigrations,
  renderDownMigrationSql,
  renderUpMigrationSql,
  selectMigrationMilestone,
} from '../../../packages/db/dist/index.js';
import {
  RunExecutionCheckpointV1Schema,
  RunRetryEffectEnvelopeV1Schema,
  RunSideEffectReceiptV1Schema,
  RunTerminationIntentRecordResultV1Schema,
  RunUsageAttributionRecordResultV1Schema,
} from '../../../packages/domain-contracts/dist/index.js';
import { canonicalJsonBytes } from '../../../packages/release-core/dist/index.js';
import { renderCatalogFingerprintExpressionSql } from './catalog-fingerprint.mjs';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harnessDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationDirectory = path.resolve(harnessDirectory, '../../../packages/db/migrations');
const harness = createPostgresHarness('runtime-security');
const legacyUpgradeCatalogFingerprintExpressionSql = renderCatalogFingerprintExpressionSql([
  'app',
  'auth',
  'better_agent_migrations',
  'public',
]);

const phaseBindings = Object.freeze([
  ['admission', 'ba_admission_test'],
  ['execution', 'ba_execution_test'],
  ['metering', 'ba_metering_test'],
  ['finalizer', 'ba_finalizer_test'],
  ['reclaimer', 'ba_reclaimer_test'],
  ['reconciliation', 'ba_reconciliation_test'],
  ['archive_evidence', 'ba_archive_evidence_test'],
  ['retention', 'ba_retention_executor_test'],
]);

const commonEstablishSignature =
  'auth.establish_internal_service_workspace_context(uuid,bytea,text)';
const phaseFunctionOracle = Object.freeze({
  admission: Object.freeze([]),
  archive_evidence: Object.freeze(['app.register_phase_run_archive_manifest(jsonb)']),
  execution: Object.freeze([
    'app.claim_run_attempt(jsonb)',
    'app.renew_run_attempt_lease(jsonb)',
    'app.relinquish_run_attempt_lease(jsonb)',
    'app.record_attempt_started(jsonb)',
    'app.record_attempt_retry_wait(jsonb)',
    'app.record_attempt_recovering(jsonb)',
    'app.record_attempt_finished(jsonb)',
    'app.record_step_started(jsonb)',
    'app.record_step_finished(jsonb)',
    'app.record_execution_checkpoint(jsonb)',
    'app.record_execution_effect_envelope(jsonb)',
    'app.record_execution_effect_receipt(jsonb)',
    'app.record_usage_attribution(jsonb)',
    'app.record_leased_termination_intent(jsonb)',
    'app.claim_run_dispatch(jsonb)',
    'app.renew_run_dispatch_lease(jsonb)',
    'app.complete_run_dispatch(jsonb)',
    'app.fail_run_dispatch(jsonb)',
  ]),
  finalizer: Object.freeze([
    'app.finalize_attributed_run(jsonb)',
    'app.finalize_claimed_run(jsonb)',
  ]),
  metering: Object.freeze(['app.settle_attributed_credits(jsonb)']),
  reclaimer: Object.freeze([
    'app.fence_expired_run_attempt(jsonb)',
    'app.record_recovery_hold_intent(jsonb)',
    'app.fence_expired_run_dispatch(jsonb)',
  ]),
  reconciliation: Object.freeze(['app.reconcile_needs_attention_billing(jsonb)']),
  retention: Object.freeze([
    'app.purge_phase_run_events(jsonb)',
    'app.purge_phase_run_recovery_material(jsonb)',
  ]),
});
const allExecutorSignatures = Object.freeze([
  commonEstablishSignature,
  ...Object.values(phaseFunctionOracle).flat(),
]);

function fixtureUuid(index) {
  return `a7000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function hash(label) {
  return `sha256:${createHash('sha256').update(label).digest('hex')}`;
}

function protocolHash(domain, payload) {
  return `sha256:${createHash('sha256')
    .update(domain, 'utf8')
    .update(Buffer.from([0]))
    .update(payload, 'utf8')
    .digest('hex')}`;
}

function assertExecutionEffectEnvelopeProjection(response, context) {
  const { envelope_sha256: envelopeSha256, replayed, ...candidate } = response;
  const contract = RunRetryEffectEnvelopeV1Schema.parse(candidate);
  if (typeof replayed !== 'boolean') {
    throw new Error(`${context}: envelope response is missing its replay marker`);
  }
  assertEqual(
    envelopeSha256,
    protocolHash(
      'better-agent/run-retry-effect-envelope/1',
      canonicalJsonBytes(contract).toString('utf8'),
    ),
    `${context}: Node independently verifies the canonical envelope domain hash`,
  );
  return {
    ...response,
    envelope: contract,
    envelope_id: contract.envelope_id,
    envelope_sha256: envelopeSha256,
  };
}

function assertExecutionEffectReceiptProjection(response, context) {
  const { receipt_sha256: receiptSha256, replayed, ...candidate } = response;
  const contract = RunSideEffectReceiptV1Schema.parse(candidate);
  if (typeof replayed !== 'boolean') {
    throw new Error(`${context}: receipt response is missing its replay marker`);
  }
  assertEqual(
    receiptSha256,
    protocolHash(
      'better-agent/run-side-effect-receipt/1',
      canonicalJsonBytes(contract).toString('utf8'),
    ),
    `${context}: Node independently verifies the canonical receipt domain hash`,
  );
  return {
    ...response,
    envelope_id: contract.retry_effect_envelope_id,
    envelope_sha256: contract.retry_effect_envelope_sha256,
    receipt: contract,
    receipt_id: contract.effect_receipt_id,
    receipt_sha256: receiptSha256,
  };
}

function assertExecutionCheckpointProjection(response, context) {
  try {
    return RunExecutionCheckpointV1Schema.parse(response);
  } catch (error) {
    throw new Error(`${context}: checkpoint response violates the public domain contract`, {
      cause: error,
    });
  }
}

function sourceAuthorityHashPayload(source) {
  const {
    consumption_generation: _consumptionGeneration,
    lease_owner: _leaseOwner,
    ...payload
  } = source;
  return payload;
}

function assertUsageAttributionProjection(response, context) {
  let result;
  try {
    result = RunUsageAttributionRecordResultV1Schema.parse(response);
  } catch (error) {
    throw new Error(`${context}: usage response violates the public domain contract`, {
      cause: error,
    });
  }
  assertEqual(
    result.source_authority_hash,
    protocolHash(
      'better-agent/execution-usage-source/1',
      canonicalJsonBytes(sourceAuthorityHashPayload(result.source)).toString('utf8'),
    ),
    `${context}: Node independently verifies the canonical usage source hash`,
  );
  return result;
}

function assertTerminationIntentProjection(response, context) {
  let result;
  try {
    result = RunTerminationIntentRecordResultV1Schema.parse(response);
  } catch (error) {
    throw new Error(`${context}: termination response violates the public domain contract`, {
      cause: error,
    });
  }
  assertEqual(
    result.source_authority_hash,
    protocolHash(
      'better-agent/execution-termination-source/1',
      canonicalJsonBytes(sourceAuthorityHashPayload(result.intent)).toString('utf8'),
    ),
    `${context}: Node independently verifies the canonical termination source hash`,
  );
  return result;
}

function flipSha256Bit(value) {
  const lastNibble = Number.parseInt(value.at(-1), 16);
  return `${value.slice(0, -1)}${(lastNibble ^ 1).toString(16)}`;
}

function jsonb(value) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const ids = Object.freeze({
  workspace: fixtureUuid(1),
  otherWorkspace: fixtureUuid(2),
  credential: fixtureUuid(3),
  flowDeployment: fixtureUuid(4),
  flowRevision: fixtureUuid(5),
  flow: fixtureUuid(6),
  flowVersion: fixtureUuid(7),
  run: fixtureUuid(10),
  acceptedRequest: fixtureUuid(11),
  attempt: fixtureUuid(12),
  step: fixtureUuid(13),
  reservation: fixtureUuid(14),
  dispatch: fixtureUuid(15),
  rollbackRun: fixtureUuid(20),
  rollbackAcceptedRequest: fixtureUuid(21),
  rollbackAttempt: fixtureUuid(22),
  rollbackStep: fixtureUuid(25),
  replayRun: fixtureUuid(30),
  replayAcceptedRequest: fixtureUuid(31),
  replayAttempt: fixtureUuid(32),
  replayStep: fixtureUuid(33),
  replayReservation: fixtureUuid(34),
  replayDispatch: fixtureUuid(35),
  replaySecondStep: fixtureUuid(36),
  holdRun: fixtureUuid(40),
  holdAcceptedRequest: fixtureUuid(41),
  holdAttempt: fixtureUuid(42),
  holdStep: fixtureUuid(43),
  holdReservation: fixtureUuid(44),
  cancelRun: fixtureUuid(50),
  cancelAcceptedRequest: fixtureUuid(51),
  cancelReservation: fixtureUuid(52),
  cancelEvent: fixtureUuid(54),
  zeroCancelRun: fixtureUuid(60),
  zeroCancelAcceptedRequest: fixtureUuid(61),
  zeroCancelReservation: fixtureUuid(62),
  zeroCancelEvent: fixtureUuid(64),
  retirementRun: fixtureUuid(70),
  retirementAcceptedRequest: fixtureUuid(71),
  retirementAttempt: fixtureUuid(72),
  retirementStep: fixtureUuid(73),
  retirementReservation: fixtureUuid(74),
  retirementDispatch: fixtureUuid(75),
  retirementCancelEvent: fixtureUuid(76),
  missingRun: fixtureUuid(200),
  missingAcceptedRequest: fixtureUuid(201),
  missingAttempt: fixtureUuid(202),
  missingStep: fixtureUuid(203),
  missingReservation: fixtureUuid(204),
  missingDispatch: fixtureUuid(205),
  missingCancelEvent: fixtureUuid(206),
  unknownRun: fixtureUuid(210),
  unknownAcceptedRequest: fixtureUuid(211),
  unknownAttempt: fixtureUuid(212),
  unknownStep: fixtureUuid(213),
  unknownReservation: fixtureUuid(214),
  unknownDispatch: fixtureUuid(215),
  unknownCancelEvent: fixtureUuid(216),
  openRun: fixtureUuid(220),
  openAcceptedRequest: fixtureUuid(221),
  openAttempt: fixtureUuid(222),
  openStep: fixtureUuid(223),
  openReservation: fixtureUuid(224),
  openDispatch: fixtureUuid(225),
  openCancelEvent: fixtureUuid(226),
  aggregateUnknownRun: fixtureUuid(230),
  aggregateUnknownAcceptedRequest: fixtureUuid(231),
  aggregateUnknownAttempt: fixtureUuid(232),
  aggregateUnknownStep: fixtureUuid(233),
  aggregateUnknownReservation: fixtureUuid(234),
  aggregateUnknownDispatch: fixtureUuid(235),
  aggregateUnknownCancelEvent: fixtureUuid(236),
  meteringMissRun: fixtureUuid(240),
  meteringMissAcceptedRequest: fixtureUuid(241),
  meteringMissAttempt: fixtureUuid(242),
  meteringMissStep: fixtureUuid(243),
  meteringMissReservation: fixtureUuid(244),
  meteringMissDispatch: fixtureUuid(245),
  meteringMissCancelEvent: fixtureUuid(246),
  meteringReplayRun: fixtureUuid(250),
  meteringReplayAcceptedRequest: fixtureUuid(251),
  meteringReplayAttempt: fixtureUuid(252),
  meteringReplayStep: fixtureUuid(253),
  meteringReplayReservation: fixtureUuid(254),
  meteringReplayDispatch: fixtureUuid(255),
  meteringReplayCancelEvent: fixtureUuid(256),
  noFinancialSettledRun: fixtureUuid(260),
  noFinancialSettledAcceptedRequest: fixtureUuid(261),
  noFinancialSettledReservation: fixtureUuid(264),
  noFinancialSettledDispatch: fixtureUuid(265),
  noFinancialSettledCancelEvent: fixtureUuid(266),
  noFinancialSettledLedger: fixtureUuid(267),
  noFinancialReleasedRun: fixtureUuid(270),
  noFinancialReleasedAcceptedRequest: fixtureUuid(271),
  noFinancialReleasedReservation: fixtureUuid(274),
  noFinancialReleasedDispatch: fixtureUuid(275),
  noFinancialReleasedCancelEvent: fixtureUuid(276),
  noFinancialReleasedLedger: fixtureUuid(277),
  noFinancialExpiredRun: fixtureUuid(280),
  noFinancialExpiredAcceptedRequest: fixtureUuid(281),
  noFinancialExpiredReservation: fixtureUuid(284),
  noFinancialExpiredDispatch: fixtureUuid(285),
  noFinancialExpiredCancelEvent: fixtureUuid(286),
  noFinancialExpiredLedger: fixtureUuid(287),
  reconciliation: fixtureUuid(290),
  reconciliationLedger: fixtureUuid(291),
  quiescenceWorkspace: fixtureUuid(300),
  malformedLegacyRun: fixtureUuid(301),
  malformedLegacyReservation: fixtureUuid(302),
  malformedLegacyLedger: fixtureUuid(303),
  malformedLegacyTerminalEvent: fixtureUuid(304),
  mismatchedAuthorityReceipt: fixtureUuid(305),
  mismatchedAuthorityLedger: fixtureUuid(306),
  mismatchedAuthoritySource: fixtureUuid(307),
  meteringFirstAcceptedRequest: fixtureUuid(320),
  meteringFirstRun: fixtureUuid(321),
  meteringFirstAttempt: fixtureUuid(322),
  meteringFirstStep: fixtureUuid(323),
  meteringFirstReservation: fixtureUuid(324),
});

const phaseAttestations = Object.freeze(
  Object.fromEntries(
    phaseBindings.map(([phase, login], index) => [
      phase,
      Object.freeze({
        binding: randomBytes(32).toString('hex'),
        id: fixtureUuid(100 + index),
        login,
        rawSecret: randomBytes(32).toString('hex'),
      }),
    ]),
  ),
);

const wrongVerifier = randomBytes(32).toString('hex');
const executionOtherAttestation = Object.freeze({
  binding: randomBytes(32).toString('hex'),
  id: fixtureUuid(110),
  login: 'ba_execution_other_test',
  phase: 'execution',
  rawSecret: randomBytes(32).toString('hex'),
});
const ecmaScriptTrimOnlyValues = Object.freeze([
  Object.freeze({ label: 'tab', value: '\t' }),
  Object.freeze({ label: 'newline', value: '\n' }),
  Object.freeze({ label: 'no-break-space', value: '\u00a0' }),
]);
const rejectedAttestationIds = Object.freeze({
  expired: fixtureUuid(120),
  invalidBinding: fixtureUuid(121),
  revoked: fixtureUuid(122),
  invalidRevocationShape: fixtureUuid(123),
});
const rejectedAttestationSecrets = Object.freeze({
  expired: randomBytes(32).toString('hex'),
  invalidBinding: randomBytes(32).toString('hex'),
  revoked: randomBytes(32).toString('hex'),
});

function establishSql(phase, body = '') {
  const attestation = phaseAttestations[phase];
  if (attestation === undefined) throw new Error(`unknown fixture phase: ${phase}`);
  return establishWithAttestationSql(attestation, phase, body);
}

function establishWithAttestationSql(attestation, phase, body = '') {
  return `BEGIN;
SELECT auth.establish_internal_service_workspace_context(
  '${attestation.id}', decode('${attestation.rawSecret}', 'hex'), '${phase}'
);
${body}
COMMIT;`;
}

async function phasePsql(phase, body, options = {}) {
  const attestation = phaseAttestations[phase];
  const result = await harness.psql(attestation.login, establishSql(phase, body), {
    ...options,
    scanFor: [...(options.scanFor ?? []), attestation.rawSecret],
  });
  assertEqual(
    `${String(result.rawScan.leakDetected)}|${String(result.rawScan.count)}`,
    'false|0',
    `${phase} raw attestation is absent from PostgreSQL client output`,
  );
  return result;
}

async function phaseJsonCall(phase, functionName, fact) {
  const result = await phasePsql(phase, `SELECT app.${functionName}(${jsonb(fact)});`, {
    tuplesOnly: true,
  });
  const jsonLine = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .findLast((line) => line.startsWith('{'));
  if (jsonLine === undefined) {
    throw new Error(`${functionName} did not return a JSON object`);
  }
  return JSON.parse(jsonLine);
}

async function attestedJsonCall(attestation, phase, functionName, fact) {
  const result = await harness.psql(
    attestation.login,
    establishWithAttestationSql(attestation, phase, `SELECT app.${functionName}(${jsonb(fact)});`),
    { scanFor: [attestation.rawSecret], tuplesOnly: true },
  );
  assertEqual(
    `${String(result.rawScan.leakDetected)}|${String(result.rawScan.count)}`,
    'false|0',
    `${phase} custom-workspace call does not echo its raw attestation`,
  );
  const jsonLine = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .findLast((line) => line.startsWith('{'));
  if (jsonLine === undefined) throw new Error(`${functionName} returned no JSON object`);
  return JSON.parse(jsonLine);
}

async function assertAttestedRejected(attestation, phase, functionName, fact, expected, context) {
  return assertPsqlRejected(
    attestation.login,
    establishWithAttestationSql(attestation, phase, `SELECT app.${functionName}(${jsonb(fact)});`),
    expected,
    context,
    { scanFor: [attestation.rawSecret] },
  );
}

function executionEffectEnvelopeFact(
  authority,
  { effectClass, effectPayloadSha256, label, operationIntentSha256, operationKey, stepId },
) {
  return {
    ...authority,
    effect_class: effectClass,
    effect_payload_sha256: effectPayloadSha256 ?? hash(`${label}:effect-payload`),
    operation_intent_sha256: operationIntentSha256 ?? hash(`${label}:operation-intent`),
    ...(operationKey === undefined ? {} : { operation_key: operationKey }),
    step_id: stepId,
  };
}

function executionEffectReceiptFact(
  authority,
  envelope,
  {
    externalReceiptRef,
    externalReceiptSha256,
    label,
    outcome = 'CONFIRMED',
    resultPayloadSha256,
    stepId,
    unknownReasonCode,
  },
) {
  const envelopeId = envelope.envelope_id ?? envelope.retry_effect_envelope_id;
  const envelopeSha256 = envelope.envelope_sha256 ?? envelope.retry_effect_envelope_sha256;
  return {
    ...authority,
    outcome,
    result_payload_sha256: resultPayloadSha256 ?? hash(`${label}:result-payload`),
    retry_effect_envelope_id: envelopeId,
    retry_effect_envelope_sha256: envelopeSha256,
    ...(outcome === 'CONFIRMED'
      ? {
          external_receipt_ref: externalReceiptRef ?? `fixture://g007/${label}`,
          external_receipt_sha256: externalReceiptSha256 ?? hash(`${label}:external-receipt`),
        }
      : { unknown_reason_code: unknownReasonCode ?? 'UPSTREAM_RESULT_UNKNOWN' }),
    step_id: stepId ?? envelope.envelope?.step_id,
  };
}

async function recordExecutionEffectEnvelope(authority, specification) {
  const response = await phaseJsonCall(
    'execution',
    'record_execution_effect_envelope',
    executionEffectEnvelopeFact(authority, specification),
  );
  return assertExecutionEffectEnvelopeProjection(
    response,
    `${specification.label} effect envelope`,
  );
}

async function recordExecutionEffectReceipt(authority, envelope, specification) {
  const response = await phaseJsonCall(
    'execution',
    'record_execution_effect_receipt',
    executionEffectReceiptFact(authority, envelope, specification),
  );
  return assertExecutionEffectReceiptProjection(response, `${specification.label} effect receipt`);
}

async function recordCompletedExecutionEffect(authority, specification) {
  // This split is the durability seam: the intent commits before the external-call receipt.
  const envelope = await recordExecutionEffectEnvelope(authority, specification);
  const receipt = await recordExecutionEffectReceipt(authority, envelope, specification);
  return { ...envelope, ...receipt, envelope: envelope.envelope };
}

async function phaseScalarCall(phase, functionName, fact) {
  const result = await phasePsql(phase, `SELECT app.${functionName}(${jsonb(fact)});`, {
    tuplesOnly: true,
  });
  const value = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (value === undefined) throw new Error(`${functionName} returned no scalar row`);
  return value;
}

async function assertPsqlRejected(role, sql, expectedPattern, context, options = {}) {
  const result = await harness.psql(role, sql, {
    ...options,
    allowFailure: true,
  });
  assertRejected(result, expectedPattern, context);
  if ((options.scanFor ?? []).length > 0) {
    assertEqual(
      `${String(result.rawScan.leakDetected)}|${String(result.rawScan.count)}`,
      'false|0',
      `${context} does not leak dynamic secrets`,
    );
  }
  return result;
}

async function assertPhaseRejected(phase, body, expectedPattern, context) {
  const attestation = phaseAttestations[phase];
  return assertPsqlRejected(
    attestation.login,
    establishSql(phase, body),
    expectedPattern,
    context,
    {
      scanFor: [attestation.rawSecret],
    },
  );
}

async function assertAttemptFinishResponsibilityRejected(authority, context) {
  const before = await runtimeDigest();
  await assertPhaseRejected(
    'execution',
    `SELECT app.record_attempt_finished(${jsonb({
      ...authority,
      attempt_status: 'FAILED',
    })});`,
    /ERROR:\s+55000:\s+Attempt completion requires (?:a CLOSED effect envelope set|every effect to be safely CONFIRMED)/u,
    context,
  );
  assertEqual(
    await runtimeDigest(),
    before,
    `${context} preserves the live lease, Run sequence, Event set and effect facts`,
  );
}

function attestationVerifierSql(rawSecret) {
  return `public.hmac(
    decode('${rawSecret}', 'hex'),
    convert_to('better-agent/internal-service-attestation-verifier/1', 'UTF8')
      || decode('00', 'hex'),
    'sha256'
  )`;
}

function issueAttestationSql({
  binding,
  expires = "clock_timestamp() + interval '10 minutes'",
  id,
  login,
  phase,
  rawSecret,
  workspace = ids.workspace,
}) {
  return `SELECT auth.issue_internal_service_attestation(
  '${id}', '${workspace}', '${login}'::name, '${phase}',
  'better-agent/internal-service/1', decode('${binding}', 'hex'),
  ${attestationVerifierSql(rawSecret)}, ${expires}
);`;
}

async function issueAttestation(fact) {
  const result = await harness.psql('ba_internal_issuer_test', issueAttestationSql(fact), {
    scanFor: [fact.rawSecret],
  });
  assertEqual(
    `${String(result.rawScan.leakDetected)}|${String(result.rawScan.count)}`,
    'false|0',
    `${fact.phase} attestation issuance does not leak its raw secret`,
  );
}

async function runtimeDigest() {
  return harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT encode(public.digest(convert_to(concat_ws('|',
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM auth.internal_service_attestations AS fact
     WHERE fact.workspace_id IN ('${ids.workspace}', '${ids.otherWorkspace}')),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.runs AS fact WHERE fact.workspace_id = '${ids.workspace}'),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.run_attempts AS fact WHERE fact.workspace_id = '${ids.workspace}'),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.run_steps AS fact WHERE fact.workspace_id = '${ids.workspace}'),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.run_events AS fact WHERE fact.workspace_id = '${ids.workspace}'),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.run_checkpoints AS fact WHERE fact.workspace_id = '${ids.workspace}'),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.run_retry_effect_envelopes AS fact WHERE fact.workspace_id = '${ids.workspace}'),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.run_side_effect_receipts AS fact WHERE fact.workspace_id = '${ids.workspace}'),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.run_usage_attributions AS fact WHERE fact.workspace_id = '${ids.workspace}'),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.run_termination_intents AS fact WHERE fact.workspace_id = '${ids.workspace}'),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.run_recovery_tickets AS fact WHERE fact.workspace_id = '${ids.workspace}'),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.run_recovery_ticket_dispositions AS fact WHERE fact.workspace_id = '${ids.workspace}'),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.run_recovery_hold_intents AS fact WHERE fact.workspace_id = '${ids.workspace}'),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.run_billing_authority_receipts AS fact WHERE fact.workspace_id = '${ids.workspace}'),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.credits_ledger AS fact WHERE fact.workspace_id = '${ids.workspace}'),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.outbox AS fact WHERE fact.workspace_id = '${ids.workspace}'),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.run_dispatch_retirement_receipts AS fact
     WHERE fact.workspace_id = '${ids.workspace}'),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.phase_operation_audit AS fact WHERE fact.workspace_id = '${ids.workspace}'),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.finalizer_transaction_claims AS fact WHERE fact.workspace_id = '${ids.workspace}')
), 'UTF8'), 'sha256'), 'hex');`,
  );
}

async function assertJsonNumberFinitenessVectors() {
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  CASE WHEN app.g007_json_numbers_are_finite(
    '{"nested":[{"overflow":1e1000}]}'::jsonb
  ) THEN 'true' ELSE 'false' END,
  CASE WHEN app.g007_json_numbers_are_finite(
    '{"nested":{"overflow":-1e1000}}'::jsonb
  ) THEN 'true' ELSE 'false' END,
  CASE WHEN app.g007_json_numbers_are_finite(
    '{"nested":[{"underflow":1e-1000}]}'::jsonb
  ) THEN 'true' ELSE 'false' END
);`,
    ),
    'false|false|true',
    'recursive JSON-number validator rejects signed JavaScript overflow and preserves underflow-to-zero semantics',
  );
}

async function workspaceBillingDigest(workspaceId) {
  return harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT encode(public.digest(convert_to(jsonb_build_object(
  'workspace', (SELECT to_jsonb(fact) FROM public.workspaces AS fact
    WHERE fact.id = ${sqlLiteral(workspaceId)}::uuid),
  'runs', (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id), '[]')
    FROM public.runs AS fact
    WHERE fact.workspace_id = ${sqlLiteral(workspaceId)}::uuid),
  'reservations', (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id), '[]')
    FROM public.credit_reservations AS fact
    WHERE fact.workspace_id = ${sqlLiteral(workspaceId)}::uuid),
  'reconciliations', (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id), '[]')
    FROM public.run_billing_reconciliations AS fact
    WHERE fact.workspace_id = ${sqlLiteral(workspaceId)}::uuid),
  'authority_receipts', (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id), '[]')
    FROM public.run_billing_authority_receipts AS fact
    WHERE fact.workspace_id = ${sqlLiteral(workspaceId)}::uuid),
  'ledger', (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id), '[]')
    FROM public.credits_ledger AS fact
    WHERE fact.workspace_id = ${sqlLiteral(workspaceId)}::uuid)
)::text, 'UTF8'), 'sha256'), 'hex');`,
  );
}

async function terminalSnapshotDigest(runId) {
  return harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT encode(public.digest(convert_to(jsonb_build_object(
  'status', status,
  'execution_status', execution_status,
  'termination_reason', termination_reason,
  'terminal_intent_hash', terminal_intent_hash,
  'terminal_result_redacted', terminal_result_redacted,
  'terminal_error_redacted', terminal_error_redacted,
  'terminal_event_id', terminal_event_id,
  'terminal_event_sequence', terminal_event_sequence,
  'finished_at', finished_at,
  'events_retention_until', events_retention_until,
  'recovery_retention_until', recovery_retention_until,
  'retention_until', retention_until
)::text, 'UTF8'), 'sha256'), 'hex')
FROM public.runs
WHERE workspace_id = '${ids.workspace}' AND id = '${runId}';`,
  );
}

async function readAttemptEffectClosure(runId, attemptId, disposition = 'CLOSED') {
  const closurePayload = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'envelope_sha256', envelope.envelope_sha256,
    'receipt_sha256', receipt.receipt_sha256,
    'disposition', receipt.disposition
  ) ORDER BY envelope.id)::text
  FROM public.run_retry_effect_envelopes AS envelope
  LEFT JOIN public.run_side_effect_receipts AS receipt
    ON receipt.workspace_id = envelope.workspace_id
   AND receipt.envelope_id = envelope.id
  WHERE envelope.workspace_id = '${ids.workspace}'
    AND envelope.run_id = '${runId}'
    AND envelope.attempt_id = '${attemptId}'
), '[]');`,
  );
  return {
    disposition,
    effect_closure_sha256: protocolHash('better-agent/run-effect-closure/1', closurePayload),
  };
}

async function assertRecoveryTicketReadback(fenceResult, context) {
  const ticket = fenceResult.recovery_ticket;
  if (ticket === undefined) throw new Error(`${context}: missing nested recovery_ticket`);
  const decisionPayload = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT jsonb_build_object(
  'schema_version', 'run-recovery-effect-decision-set/1',
  'effect_decisions', effect_decisions
)::text
FROM public.run_recovery_tickets
WHERE workspace_id = '${ids.workspace}' AND id = '${ticket.recovery_ticket_id}';`,
  );
  assertEqual(
    protocolHash('better-agent/run-recovery-effect-decision-set/1', decisionPayload),
    ticket.effect_decisions_sha256,
    `${context}: independent Node digest binds the complete ordered effect-decision set`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT effect_decisions_sha256 || ':' || ticket_sha256
FROM public.run_recovery_tickets
WHERE workspace_id = '${ids.workspace}' AND id = '${ticket.recovery_ticket_id}';`,
    ),
    `${ticket.effect_decisions_sha256}:${fenceResult.recovery_ticket_sha256}`,
    `${context}: nested contract hashes match immutable database readback`,
  );
  return ticket;
}

async function assertDispatchRetirementReceipt(outboxId, expected, context) {
  const rawContract = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT jsonb_strip_nulls(jsonb_build_object(
  'schema_version', 'run-dispatch-retirement-receipt/1',
  'retirement_receipt_id', id,
  'workspace_id', workspace_id,
  'run_id', run_id,
  'outbox_id', outbox_id,
  'old_status', old_status,
  'old_lease_owner', old_lease_owner,
  'old_lease_token', old_lease_token,
  'old_lease_fencing_token', old_lease_fencing_token::text,
  'old_lease_expires_at', old_lease_expires_at,
  'old_delivery_generation', old_delivery_generation::text,
  'new_delivery_generation', new_delivery_generation::text,
  'retired_status', retired_status,
  'last_error_code', last_error_code,
  'terminal_source_kind', terminal_source_kind,
  'terminal_source_id', terminal_source_id,
  'terminal_source_sha256', terminal_source_sha256,
  'terminal_intent_sha256', terminal_intent_sha256,
  'retired_at', retired_at
))::text
FROM public.run_dispatch_retirement_receipts
WHERE workspace_id = '${ids.workspace}' AND outbox_id = '${outboxId}';`,
  );
  if (rawContract.length === 0) throw new Error(`${context}: missing retirement receipt`);
  const contract = JSON.parse(rawContract);
  for (const [field, value] of Object.entries(expected)) {
    assertEqual(String(contract[field]), String(value), `${context}: ${field} readback`);
  }
  const storedHash = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT receipt_sha256
FROM public.run_dispatch_retirement_receipts
WHERE workspace_id = '${ids.workspace}' AND outbox_id = '${outboxId}';`,
  );
  assertEqual(
    protocolHash('better-agent/run-dispatch-retirement-receipt/1', rawContract),
    storedHash,
    `${context}: independent Node digest binds the full SQL receipt projection`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  message.status,
  message.delivery_generation,
  message.lease_owner IS NULL,
  message.lease_token IS NULL,
  message.lease_fencing_token IS NULL,
  message.lease_expires_at IS NULL,
  message.last_error_redacted,
  message.delivery_failure_evidence_sha256 IS NULL,
  receipt.retired_at IS NOT NULL,
  receipt.terminal_intent_sha256 = run_row.terminal_intent_hash
)
FROM public.outbox AS message
JOIN public.run_dispatch_retirement_receipts AS receipt
  ON receipt.workspace_id = message.workspace_id AND receipt.outbox_id = message.id
JOIN public.runs AS run_row
  ON run_row.workspace_id = message.workspace_id AND run_row.id = message.run_id
WHERE message.workspace_id = '${ids.workspace}' AND message.id = '${outboxId}';`,
    ),
    `DEAD|${String(expected.new_delivery_generation)}|t|t|t|t|RUN_TERMINATED_BEFORE_DISPATCH|t|t|t`,
    `${context}: retired Outbox and receipt agree on status, generation, error and terminal source`,
  );
  return contract;
}

async function assertInteractiveHarness() {
  const cleanCanary = randomBytes(32).toString('hex');
  const cleanSession = harness.openInteractivePsql('ba_migrator_test', {
    applicationName: 'ba-g007-clean-interactive',
    scanFor: [cleanCanary],
  });
  const cleanPid = await cleanSession.backendPid();
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT application_name
FROM pg_catalog.pg_stat_activity
WHERE pid = ${String(cleanPid)};`,
    ),
    'ba-g007-clean-interactive',
    'interactive application_name is observable from pg_stat_activity',
  );
  const cleanMetadata = await cleanSession.close();
  assertEqual(String(cleanMetadata.rawScan.leakDetected), 'false', 'clean raw-buffer canary scan');
  assertEqual(String(cleanMetadata.rawScan.count), '0', 'clean raw-buffer canary count');

  const detectionCanary = randomBytes(32).toString('hex');
  const detectionSession = harness.openInteractivePsql('ba_migrator_test', {
    applicationName: 'ba-g007-raw-scan-detection',
    scanFor: [detectionCanary],
  });
  await detectionSession.execute(`SELECT '${detectionCanary}'::text;`);
  const detectionMetadata = await detectionSession.close();
  assertEqual(
    String(detectionMetadata.rawScan.leakDetected),
    'true',
    'raw-buffer scan detects a dynamic binary canary before redaction',
  );
  assertEqual(String(detectionMetadata.rawScan.count), '1', 'raw-buffer canary detection count');
}

async function assertBlockingAndBackendTermination() {
  const lockKey = 8_391_927_202_508_28;
  const blocker = harness.openInteractivePsql('ba_migrator_test', {
    applicationName: 'ba-g007-blocker',
  });
  const blocked = harness.openInteractivePsql('ba_migrator_test', {
    applicationName: 'ba-g007-blocked',
  });
  const blockerPid = await blocker.backendPid();
  const blockedPid = await blocked.backendPid();
  await blocker.execute(`BEGIN; SELECT pg_catalog.pg_advisory_xact_lock(${String(lockKey)});`);

  const blockedExecution = blocked.execute(
    `BEGIN; SELECT pg_catalog.pg_advisory_xact_lock(${String(lockKey)});`,
    { timeoutMs: 10_000 },
  );
  await harness.waitForBlockingEdge(blockedPid, blockerPid, { timeoutMs: 5_000 });
  assertEqual(
    await harness.terminateBackend(blockerPid),
    't',
    'DBA terminates the blocking backend',
  );
  await harness.waitForBackendExit(blockerPid, { timeoutMs: 5_000 });
  await blockedExecution;
  await blocked.execute('ROLLBACK;');
  await blocked.close();
  await blocker.close();
}

async function assertAbruptDisconnectRollsBack() {
  const lockKey = 8_391_927_202_508_29;
  const session = harness.openInteractivePsql('ba_migrator_test', {
    applicationName: 'ba-g007-abrupt-disconnect',
  });
  const backendPid = await session.backendPid();
  await session.execute(`BEGIN; SELECT pg_catalog.pg_advisory_xact_lock(${String(lockKey)});`);
  await session.abruptDisconnect();
  await harness.waitForBackendExit(backendPid, { timeoutMs: 5_000 });
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT pg_catalog.pg_try_advisory_lock(${String(lockKey)});`,
    ),
    't',
    'abrupt client disconnect releases transaction-scoped authority',
  );
  await harness.psql(
    'ba_bootstrap_test',
    `SELECT pg_catalog.pg_advisory_unlock(${String(lockKey)});`,
  );
}

async function assertInteractiveTimeoutCleansUpBackend() {
  const session = harness.openInteractivePsql('ba_migrator_test', {
    applicationName: 'ba-g007-timeout-cleanup',
  });
  const backendPid = await session.backendPid();
  let timeoutError;
  try {
    await session.execute('SELECT pg_catalog.pg_sleep(10);', {
      disconnectOnFailure: false,
      timeoutMs: 100,
    });
  } catch (error) {
    timeoutError = error;
  }
  if (timeoutError === undefined) {
    throw new Error('interactive marker timeout unexpectedly completed');
  }
  assertErrorMatches(
    timeoutError,
    /interactive psql marker: timed out after 100ms/u,
    'interactive marker timeout is explicit',
  );
  assertEqual(
    await harness.cancelBackend(backendPid),
    't',
    'client timeout sends an explicit PostgreSQL cancel request',
  );
  await session.close();
  await harness.waitForBackendExit(backendPid, {
    context: 'timed-out interactive PostgreSQL backend cleanup',
    timeoutMs: 5_000,
  });
}

async function legacyUpgradeDigest() {
  return harness.queryScalar(
    'ba_bootstrap_test',
    `WITH migration_ledger_digest AS (
  SELECT encode(public.digest(convert_to(COALESCE((
  SELECT jsonb_agg(to_jsonb(migration_row) ORDER BY migration_row.version)::text
  FROM better_agent_migrations.schema_migrations AS migration_row
), '[]'), 'UTF8'), 'sha256'), 'hex') AS value
), data_digest AS (
  SELECT encode(public.digest(convert_to(jsonb_build_object(
  'workspace', (SELECT to_jsonb(workspace_row) FROM public.workspaces AS workspace_row
    WHERE workspace_row.id = '${ids.quiescenceWorkspace}'),
  'run', (SELECT to_jsonb(run_row) FROM public.runs AS run_row
    WHERE run_row.workspace_id = '${ids.quiescenceWorkspace}'
      AND run_row.id = '${ids.malformedLegacyRun}'),
  'reservation', (SELECT to_jsonb(reservation_row)
    FROM public.credit_reservations AS reservation_row
    WHERE reservation_row.workspace_id = '${ids.quiescenceWorkspace}'
      AND reservation_row.id = '${ids.malformedLegacyReservation}'),
  'ledger', (SELECT to_jsonb(ledger_row) FROM public.credits_ledger AS ledger_row
    WHERE ledger_row.workspace_id = '${ids.quiescenceWorkspace}'
      AND ledger_row.id = '${ids.malformedLegacyLedger}')
)::text, 'UTF8'), 'sha256'), 'hex') AS value
)
SELECT concat_ws('|',
  (SELECT value FROM migration_ledger_digest),
  ${legacyUpgradeCatalogFingerprintExpressionSql},
  (SELECT value FROM data_digest)
);`,
  );
}

async function isolatedDatabasePsql(role, database, sql, options = {}) {
  return harness.psql(role, `\\connect ${database}\n${sql}`, options);
}

async function isolatedDatabaseScalar(role, database, sql) {
  const result = await isolatedDatabasePsql(role, database, sql, { tuplesOnly: true });
  const value = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (value === undefined) throw new Error(`${database} scalar query returned no row`);
  return value;
}

async function createIsolatedMigrationDatabase(database) {
  await harness.psql(
    'ba_bootstrap_test',
    `CREATE DATABASE ${database} TEMPLATE template0;
REVOKE ALL ON DATABASE ${database} FROM PUBLIC;
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${database} TO ba_migrator;`,
  );
  await isolatedDatabasePsql(
    'ba_bootstrap_test',
    database,
    `CREATE EXTENSION vector;
CREATE EXTENSION pgcrypto;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO ba_migrator WITH GRANT OPTION;`,
  );
}

async function isolatedUsedInstallationDigest(database) {
  return isolatedDatabaseScalar(
    'ba_bootstrap_test',
    database,
    `WITH migration_ledger AS (
  SELECT COALESCE(jsonb_agg(to_jsonb(migration_row) ORDER BY migration_row.version), '[]') AS value
  FROM better_agent_migrations.schema_migrations AS migration_row
), runtime_facts AS (
  SELECT jsonb_build_object(
    'workspaces', (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id), '[]')
      FROM public.workspaces AS fact),
    'phase_operation_audit', (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id), '[]')
      FROM public.phase_operation_audit AS fact),
    'run_attempts', (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id), '[]')
      FROM public.run_attempts AS fact),
    'run_checkpoints', (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id), '[]')
      FROM public.run_checkpoints AS fact),
    'outbox', (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id), '[]')
      FROM public.outbox AS fact),
    'credits_ledger', (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id), '[]')
      FROM public.credits_ledger AS fact)
  ) AS value
)
SELECT encode(public.digest(convert_to(concat_ws('|',
  (SELECT value::text FROM migration_ledger),
  ${legacyUpgradeCatalogFingerprintExpressionSql},
  (SELECT value::text FROM runtime_facts)
), 'UTF8'), 'sha256'), 'hex');`,
  );
}

async function isolatedLegacyBillingDigest(database) {
  return isolatedDatabaseScalar(
    'ba_bootstrap_test',
    database,
    `SELECT encode(public.digest(convert_to(concat_ws('|',
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.version)::text, '[]')
     FROM better_agent_migrations.schema_migrations AS fact),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.workspaces AS fact),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.runs AS fact),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.credit_reservations AS fact),
  (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text, '[]')
     FROM public.credits_ledger AS fact),
  to_regclass('public.run_recovery_tickets')::text
), 'UTF8'), 'sha256'), 'hex');`,
  );
}

async function assert005LegacyBalanceSafeIntegerPreflight(migrations) {
  const through004 = migrations.filter(({ version }) => version <= 4);
  const safeMaximum = '9007199254740991';
  const beyondSafeMaximum = '9007199254740992';
  const workspaceId = fixtureUuid(880);
  const runId = fixtureUuid(881);
  const reservationId = fixtureUuid(882);
  const ledgerId = fixtureUuid(883);
  const terminalEventId = fixtureUuid(884);
  const acceptedPlanHash = hash('g007-005-large-legacy-balance-plan');
  const chargeKey = 'g007:005:large-legacy-balance';
  const billingIntentHash = hash(
    JSON.stringify({
      accepted_plan_hash: acceptedPlanHash,
      amount_credits: '0',
      billing_owner_run_id: runId,
      charge_key: chargeKey,
      expires_at: '2100-01-01T00:00:00.000Z',
      intent_kind: 'RESERVE',
      reservation_id: reservationId,
      schema_version: 'billing-intent/1',
      workspace_id: workspaceId,
    }),
  );
  const seedSql = (snapshot, balanceVersion) => `BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.workspaces (
  id, name, credits_balance, credits_reserved_balance, credits_balance_version
) VALUES (
  '${workspaceId}', 'G0-07 legacy safe-integer preflight', ${snapshot}, 0, 0
);
INSERT INTO public.runs (
  workspace_id, id, billing_owner_run_id, accepted_request_id,
  accepted_principal_kind, accepted_credential_id, fixed_route,
  intent_hash, admission_snapshot_hash, accepted_plan_hash,
  accepted_output_schema_ref, accepted_output_schema_hash, dependency_pins_hash,
  target_kind, flow_deployment_id, flow_deployment_revision_id, flow_id, flow_version_id,
  status, execution_status, billing_state, billing_settled_at,
  acceptance_receipt_data_redacted, last_event_sequence,
  termination_reason, terminal_intent_hash, terminal_error_redacted,
  terminal_billing_pending, terminal_billing_pending_at,
  terminal_event_id, terminal_event_sequence, finished_at,
  events_retention_until, recovery_retention_until, retention_until, accepted_at
) VALUES (
  '${workspaceId}', '${runId}', '${runId}', '${runId}',
  'credential', '${ids.credential}', '/v1/oapi/flow/run',
  '${hash('g007-005-large-legacy-balance-intent')}',
  '${hash('g007-005-large-legacy-balance-admission')}', '${acceptedPlanHash}',
  'schema://g007/large-legacy-balance',
  '${hash('g007-005-large-legacy-balance-output')}',
  '${hash('g007-005-large-legacy-balance-dependencies')}', 'flow',
  '${ids.flowDeployment}', '${ids.flowRevision}', '${ids.flow}', '${ids.flowVersion}',
  'CANCELLED', 'CANCELLED', 'SETTLED', '2000-01-01T00:00:00.000Z',
  jsonb_build_object('fixture', 'g007-005-large-legacy-balance'), 1,
  'USER_CANCELLED', '${hash('g007-005-large-legacy-balance-terminal')}',
  jsonb_build_object('code', 'USER_CANCELLED', 'retryable', false, 'category', 'EXECUTION'),
  false, '2000-01-01T00:00:00.000Z', '${terminalEventId}', 1,
  '2000-01-01T00:00:00.000Z', '2000-01-09T00:00:00.000Z',
  '2000-02-01T00:00:00.000Z', '2000-02-02T00:00:00.000Z',
  '2000-01-01T00:00:00.000Z'
);
INSERT INTO public.credit_reservations (
  workspace_id, id, run_id, billing_owner_run_id, accepted_plan_hash,
  status, reserved_credits, settled_credits, released_credits, balance_version,
  expires_at, created_at, updated_at, settled_at
) VALUES (
  '${workspaceId}', '${reservationId}', '${runId}', '${runId}', '${acceptedPlanHash}',
  'SETTLED', 0, 0, 0, 0, '2100-01-01T00:00:00.000Z',
  '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z',
  '2000-01-01T00:00:00.000Z'
);
INSERT INTO public.credits_ledger (
  workspace_id, id, run_id, billing_owner_run_id, producer_run_id,
  reservation_id, entry_kind, available_delta_credits, reserved_delta_credits,
  settled_delta_credits, billing_intent_hash, charge_attribution_hash, charge_key,
  balance_before, reserved_before, balance_after, reserved_after, balance_version,
  metering_detail_redacted, created_at
) VALUES (
  '${workspaceId}', '${ledgerId}', '${runId}', '${runId}', '${runId}',
  '${reservationId}', 'RESERVE', 0, 0, 0,
  '${billingIntentHash}', '${acceptedPlanHash}', '${chargeKey}',
  ${snapshot}, ${snapshot}, ${snapshot}, ${snapshot}, ${balanceVersion},
  jsonb_build_object('fixture', 'g007-005-large-legacy-balance'),
  '2000-01-01T00:00:00.000Z'
);
COMMIT;`;
  const scenarios = [
    {
      balanceVersion: '0',
      database: 'better_agent_g007_large_legacy_balances',
      snapshot: beyondSafeMaximum,
      upgrades: true,
    },
    {
      balanceVersion: beyondSafeMaximum,
      database: 'better_agent_g007_unsafe_legacy_version',
      snapshot: '0',
      upgrades: false,
    },
  ];

  for (const scenario of scenarios) {
    await createIsolatedMigrationDatabase(scenario.database);
    await isolatedDatabasePsql(
      'ba_migrator_test',
      scenario.database,
      renderUpMigrationSql(through004),
      { echoErrors: true },
    );
    await isolatedDatabasePsql(
      'ba_bootstrap_test',
      scenario.database,
      seedSql(scenario.snapshot, scenario.balanceVersion),
    );
    if (scenario.upgrades) {
      await isolatedDatabasePsql(
        'ba_migrator_test',
        scenario.database,
        renderUpMigrationSql(migrations),
        { echoErrors: true },
      );
      assertEqual(
        await isolatedDatabaseScalar(
          'ba_bootstrap_test',
          scenario.database,
          `SELECT concat_ws('|',
  (SELECT max(version) FROM better_agent_migrations.schema_migrations),
  (SELECT balance_before || ':' || reserved_before || ':' ||
          balance_after || ':' || reserved_after || ':' || balance_version
     FROM public.credits_ledger WHERE workspace_id = '${workspaceId}' AND id = '${ledgerId}')
);`,
        ),
        `5|${beyondSafeMaximum}:${beyondSafeMaximum}:${beyondSafeMaximum}:${beyondSafeMaximum}:0`,
        '005 preserves valid bigint-string ledger balance snapshots beyond Number.MAX_SAFE_INTEGER',
      );
      continue;
    }
    const before = await isolatedLegacyBillingDigest(scenario.database);
    const rejected = await isolatedDatabasePsql(
      'ba_migrator_test',
      scenario.database,
      renderUpMigrationSql(migrations),
      { allowFailure: true },
    );
    assertRejected(
      rejected,
      /ERROR:\s+55000:\s+through-004 ledger does not satisfy CreditLedgerEntryV1/u,
      `005 rejects a through-004 balance_version beyond ${safeMaximum}`,
    );
    assertEqual(
      await isolatedLegacyBillingDigest(scenario.database),
      before,
      'unsafe legacy balance_version rejection preserves migration ledger, catalog marker and billing facts',
    );
  }
}

async function assert005UsedInstallationDownGuards(migrations) {
  const scenarios = [
    {
      database: 'better_agent_down_g007_fact',
      label: 'new G0-07 immutable fact',
      seedSql: `INSERT INTO public.workspaces (id, name)
VALUES ('${fixtureUuid(840)}', 'G0-07 used-down audit fixture');
INSERT INTO public.phase_operation_audit (
  workspace_id, id, phase, operation, resource_kind, resource_id,
  operation_sha256, actor_session_user, occurred_at
) VALUES (
  '${fixtureUuid(840)}', '${fixtureUuid(841)}', 'execution', 'USED_DOWN_PROBE',
  'ATTEMPT', '${fixtureUuid(842)}', '${hash('g007-used-down-audit')}',
  'ba_execution_test', clock_timestamp()
);`,
    },
    {
      database: 'better_agent_down_legacy_provenance',
      label: 'legacy relation protocol-v5 provenance',
      seedSql: `SET session_replication_role = replica;
INSERT INTO public.outbox (
  workspace_id, id, run_id, message_type, dedupe_key, payload_ref,
  payload_hash, producer_fencing_token, payload_redacted, status,
  delivery_protocol_version, delivery_generation
) VALUES (
  '${fixtureUuid(850)}', '${fixtureUuid(851)}', '${fixtureUuid(852)}',
  'RUN_DISPATCH', 'g007-used-down-legacy', 'fixture://g007/used-down/legacy',
  '${hash('g007-used-down-legacy')}', 1, '{}'::jsonb, 'PENDING', 5, 1
);
RESET session_replication_role;`,
    },
    {
      database: 'better_agent_down_v2_ledger',
      label: 'v2 billing authority ledger provenance',
      seedSql: `SET session_replication_role = replica;
INSERT INTO public.credits_ledger (
  workspace_id, id, run_id, billing_owner_run_id, producer_run_id,
  reservation_id, entry_kind, available_delta_credits, reserved_delta_credits,
  settled_delta_credits, billing_intent_hash, charge_attribution_hash,
  charge_key, balance_before, reserved_before, balance_after, reserved_after,
  balance_version, metering_detail_redacted, entry_schema_version,
  authority_schema_version, authority_kind, authority_id
) VALUES (
  '${fixtureUuid(860)}', '${fixtureUuid(861)}', '${fixtureUuid(862)}',
  '${fixtureUuid(862)}', '${fixtureUuid(862)}', '${fixtureUuid(863)}',
  'RELEASE', 0, 0, 0, '${hash('g007-used-down-ledger-intent')}',
  '${hash('g007-used-down-ledger-authority')}', 'g007:used-down:v2-ledger',
  0, 0, 0, 0, 0, '{}'::jsonb, 2, 1, 'DURABLE_CANCEL', '${fixtureUuid(864)}'
);
RESET session_replication_role;`,
    },
  ];

  for (const scenario of scenarios) {
    await createIsolatedMigrationDatabase(scenario.database);
    await isolatedDatabasePsql(
      'ba_migrator_test',
      scenario.database,
      renderUpMigrationSql(migrations),
      { echoErrors: true },
    );
    await isolatedDatabasePsql('ba_bootstrap_test', scenario.database, scenario.seedSql);
    const before = await isolatedUsedInstallationDigest(scenario.database);
    const rejected = await isolatedDatabasePsql(
      'ba_migrator_test',
      scenario.database,
      renderDownMigrationSql(migrations, 4, { allowDown: true }),
      { allowFailure: true },
    );
    assertRejected(
      rejected,
      /ERROR:\s+55000:\s+G0-07 security facts exist; rollback requires an unused installation/u,
      `${scenario.label} blocks 005 down through its semantic guard`,
    );
    assertEqual(
      await isolatedUsedInstallationDigest(scenario.database),
      before,
      `${scenario.label} failed down preserves migration ledger, complete catalog and facts`,
    );
  }
}

async function assert005UpgradeNowaitQuiescence(migrations) {
  const through004 = migrations.filter(({ version }) => version <= 4);
  const legacyAcceptedPlanHash = hash('g007-005-malformed-legacy-plan');
  const legacyChargeKey = 'g007:005:malformed-legacy-reserve';
  const validLegacyIntentHash = hash(
    JSON.stringify({
      accepted_plan_hash: legacyAcceptedPlanHash,
      amount_credits: '0',
      billing_owner_run_id: ids.malformedLegacyRun,
      charge_key: legacyChargeKey,
      expires_at: '2100-01-01T00:00:00.000Z',
      intent_kind: 'RESERVE',
      reservation_id: ids.malformedLegacyReservation,
      schema_version: 'billing-intent/1',
      workspace_id: ids.quiescenceWorkspace,
    }),
  );
  const malformedLegacyIntentHash = flipSha256Bit(validLegacyIntentHash);
  await harness.psql('ba_migrator_test', renderUpMigrationSql(through004), { echoErrors: true });
  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.workspaces (id, name, credits_balance, credits_reserved_balance)
VALUES ('${ids.quiescenceWorkspace}', 'G0-07 005 quiescence', 0, 0);
INSERT INTO public.runs (
  workspace_id, id, billing_owner_run_id, accepted_request_id,
  accepted_principal_kind, accepted_credential_id, fixed_route,
  intent_hash, admission_snapshot_hash, accepted_plan_hash,
  accepted_output_schema_ref, accepted_output_schema_hash, dependency_pins_hash,
  target_kind, flow_deployment_id, flow_deployment_revision_id, flow_id, flow_version_id,
  status, execution_status, billing_state, billing_settled_at,
  acceptance_receipt_data_redacted, last_event_sequence,
  termination_reason, terminal_intent_hash, terminal_error_redacted,
  terminal_billing_pending, terminal_billing_pending_at,
  terminal_event_id, terminal_event_sequence, finished_at,
  events_retention_until, recovery_retention_until, retention_until, accepted_at
) VALUES (
  '${ids.quiescenceWorkspace}', '${ids.malformedLegacyRun}', '${ids.malformedLegacyRun}',
  '${ids.malformedLegacyRun}', 'credential', '${ids.credential}', '/v1/oapi/flow/run',
  '${hash('g007-005-malformed-legacy-intent')}',
  '${hash('g007-005-malformed-legacy-admission')}', '${legacyAcceptedPlanHash}',
  'schema://g007/malformed-legacy-output', '${hash('g007-005-malformed-legacy-output')}',
  '${hash('g007-005-malformed-legacy-dependencies')}', 'flow',
  '${ids.flowDeployment}', '${ids.flowRevision}', '${ids.flow}', '${ids.flowVersion}',
  'CANCELLED', 'CANCELLED', 'SETTLED', '2000-01-01T00:00:00.000Z',
  jsonb_build_object('fixture', 'g007-005-malformed-legacy'), 1,
  'USER_CANCELLED', '${hash('g007-005-malformed-legacy-terminal')}',
  jsonb_build_object('code', 'USER_CANCELLED', 'retryable', false, 'category', 'EXECUTION'),
  false, '2000-01-01T00:00:00.000Z', '${ids.malformedLegacyTerminalEvent}', 1,
  '2000-01-01T00:00:00.000Z', '2000-01-09T00:00:00.000Z',
  '2000-02-01T00:00:00.000Z', '2000-02-02T00:00:00.000Z',
  '2000-01-01T00:00:00.000Z'
);
INSERT INTO public.credit_reservations (
  workspace_id, id, run_id, billing_owner_run_id, accepted_plan_hash,
  status, reserved_credits, settled_credits, released_credits, balance_version,
  expires_at, created_at, updated_at, settled_at
) VALUES (
  '${ids.quiescenceWorkspace}', '${ids.malformedLegacyReservation}',
  '${ids.malformedLegacyRun}', '${ids.malformedLegacyRun}', '${legacyAcceptedPlanHash}',
  'SETTLED', 0, 0, 0, 0, '2100-01-01T00:00:00.000Z',
  '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z',
  '2000-01-01T00:00:00.000Z'
);
INSERT INTO public.credits_ledger (
  workspace_id, id, run_id, billing_owner_run_id, producer_run_id,
  reservation_id, entry_kind, available_delta_credits, reserved_delta_credits,
  settled_delta_credits, billing_intent_hash, charge_attribution_hash, charge_key,
  balance_before, reserved_before, balance_after, reserved_after, balance_version,
  metering_detail_redacted, created_at
) VALUES (
  '${ids.quiescenceWorkspace}', '${ids.malformedLegacyLedger}',
  '${ids.malformedLegacyRun}', '${ids.malformedLegacyRun}', '${ids.malformedLegacyRun}',
  '${ids.malformedLegacyReservation}', 'RESERVE', 0, 0, 0,
  '${malformedLegacyIntentHash}', '${legacyAcceptedPlanHash}', '${legacyChargeKey}',
  0, 0, 0, 0, 0, jsonb_build_object('fixture', 'g007-005-malformed-legacy'),
  '2000-01-01T00:00:00.000Z'
);
COMMIT;`,
  );
  const malformedBefore = await legacyUpgradeDigest();
  const malformedUpgrade = await harness.psql(
    'ba_migrator_test',
    renderUpMigrationSql(migrations),
    { allowFailure: true },
  );
  assertRejected(
    malformedUpgrade,
    /ERROR:\s+55000:\s+through-004 ledger BillingIntentV1 hash mismatch/u,
    '005 rejects a shape-valid through-004 ledger whose canonical BillingIntentV1 hash has one flipped bit',
  );
  assertEqual(
    await legacyUpgradeDigest(),
    malformedBefore,
    'failed malformed-ledger upgrade preserves migration schema, catalog and every legacy fixture byte',
  );
  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
SET LOCAL session_replication_role = replica;
DELETE FROM public.credits_ledger
WHERE workspace_id = '${ids.quiescenceWorkspace}' AND id = '${ids.malformedLegacyLedger}';
DELETE FROM public.credit_reservations
WHERE workspace_id = '${ids.quiescenceWorkspace}' AND id = '${ids.malformedLegacyReservation}';
DELETE FROM public.runs
WHERE workspace_id = '${ids.quiescenceWorkspace}' AND id = '${ids.malformedLegacyRun}';
COMMIT;`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|', relation.relrowsecurity, relation.relforcerowsecurity,
  owner_role.rolname)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = relation.relowner
WHERE namespace.nspname = 'public' AND relation.relname = 'credits_ledger';`,
    ),
    't|t|ba_billing_owner',
    'through-004 billing facts begin with the exact ENABLE+FORCE RLS owner prerequisite',
  );
  await harness.psql(
    'ba_bootstrap_test',
    'ALTER TABLE public.credits_ledger NO FORCE ROW LEVEL SECURITY;',
  );
  try {
    const driftBefore = await legacyUpgradeDigest();
    const driftedUpgrade = await harness.psql(
      'ba_migrator_test',
      renderUpMigrationSql(migrations),
      { allowFailure: true },
    );
    assertRejected(
      driftedUpgrade,
      /ERROR:\s+55000:\s+through-004 FORCE-RLS owner prerequisite drift/u,
      '005 rejects through-004 owner or RLS catalog drift instead of silently repairing it',
    );
    assertEqual(
      await legacyUpgradeDigest(),
      driftBefore,
      'failed metadata-drift upgrade preserves the observed migration ledger, catalog and legacy fixture digest',
    );
    assertEqual(
      await harness.queryScalar(
        'ba_bootstrap_test',
        `SELECT concat_ws('|', relation.relrowsecurity, relation.relforcerowsecurity,
  owner_role.rolname)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = relation.relowner
WHERE namespace.nspname = 'public' AND relation.relname = 'credits_ledger';`,
      ),
      't|f|ba_billing_owner',
      'rejected metadata-drift upgrade does not hide or mutate the pre-existing catalog drift',
    );
  } finally {
    await harness.psql(
      'ba_bootstrap_test',
      'ALTER TABLE public.credits_ledger FORCE ROW LEVEL SECURITY;',
    );
  }
  const before = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT concat_ws('|',
  (SELECT max(version) FROM better_agent_migrations.schema_migrations),
  (SELECT name FROM public.workspaces WHERE id = '${ids.quiescenceWorkspace}'),
  to_regclass('public.run_recovery_tickets') IS NULL,
  (SELECT count(*) FROM public.credits_ledger)
);`,
  );
  const legacyWriter = harness.openInteractivePsql('ba_bootstrap_test', {
    applicationName: 'ba-g007-legacy-writer-before-005',
  });
  const writerPid = await legacyWriter.backendPid();
  const failures = [];
  let blockedUpgrade;
  try {
    await legacyWriter.execute(`BEGIN;
UPDATE public.workspaces
SET name = name
WHERE id = '${ids.quiescenceWorkspace}';`);
    blockedUpgrade = await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), {
      allowFailure: true,
      echoErrors: true,
    });
    assertRejected(
      blockedUpgrade,
      /could not obtain lock on relation|55P03/u,
      '005 upgrade NOWAIT loses immediately to an in-flight legacy relation writer',
    );
    assertEqual(
      await harness.queryScalar(
        'ba_bootstrap_test',
        `SELECT state || ':' || (xact_start IS NOT NULL)::text
FROM pg_catalog.pg_stat_activity WHERE pid = ${String(writerPid)};`,
      ),
      'idle in transaction:true',
      'failed NOWAIT upgrade neither terminates nor commits the winning legacy writer',
    );
    assertEqual(
      await harness.queryScalar(
        'ba_bootstrap_test',
        `SELECT concat_ws('|',
  (SELECT max(version) FROM better_agent_migrations.schema_migrations),
  (SELECT name FROM public.workspaces WHERE id = '${ids.quiescenceWorkspace}'),
  to_regclass('public.run_recovery_tickets') IS NULL,
  (SELECT count(*) FROM public.credits_ledger)
);`,
      ),
      before,
      'failed 005 upgrade preserves migration ledger, catalog and committed legacy facts',
    );
    await legacyWriter.execute('ROLLBACK;');
  } catch (error) {
    failures.push(error);
  }
  try {
    await legacyWriter.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, '005 upgrade NOWAIT fixture cleanup failed');
  }
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), { echoErrors: true });
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT max(version) FROM better_agent_migrations.schema_migrations),
  to_regclass('public.run_recovery_tickets') IS NOT NULL,
  (SELECT name FROM public.workspaces WHERE id = '${ids.quiescenceWorkspace}'),
  (SELECT count(*) FROM public.credits_ledger)
);`,
    ),
    '5|t|G0-07 005 quiescence|0',
    'fresh upgrade transaction wins after quiescence without losing legacy facts',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `WITH expected(schema_name, relation_name, owner_name) AS (
  VALUES
    ('public', 'runs', 'ba_run_owner'),
    ('public', 'run_attempts', 'ba_run_owner'),
    ('public', 'outbox', 'ba_run_owner'),
    ('public', 'credit_reservations', 'ba_billing_owner'),
    ('public', 'run_budget_allocations', 'ba_billing_owner'),
    ('public', 'credits_ledger', 'ba_billing_owner'),
    ('public', 'run_billing_reconciliations', 'ba_billing_owner')
)
SELECT concat_ws('|', count(*), bool_and(
  owner_role.rolname::text = expected.owner_name
  AND relation.relrowsecurity
  AND relation.relforcerowsecurity
))
FROM expected
JOIN pg_catalog.pg_namespace AS namespace ON namespace.nspname = expected.schema_name
JOIN pg_catalog.pg_class AS relation
  ON relation.relnamespace = namespace.oid
 AND relation.relname = expected.relation_name
 AND relation.relkind = 'r'
JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = relation.relowner;`,
    ),
    '7|t',
    'successful 005 upgrade restores exact owners with ENABLE+FORCE RLS on all inspected legacy facts',
  );
}

async function assert005DownNowaitAgainstRuntimeWriter(migrations, authority) {
  const execution = phaseAttestations.execution;
  const writer = harness.openInteractivePsql(execution.login, {
    applicationName: 'ba-g007-runtime-writer-before-005-down',
    scanFor: [execution.rawSecret],
  });
  const writerPid = await writer.backendPid();
  const before = await runtimeDigest();
  const failures = [];
  try {
    await writer.execute(
      establishWithAttestationSql(
        execution,
        'execution',
        `SELECT app.record_attempt_started(${jsonb({
          attempt_id: ids.attempt,
          lease_fencing_token: authority.lease_fencing_token,
          lease_token: authority.lease_token,
          run_id: ids.run,
        })});`,
      ).replace(/\nCOMMIT;$/u, ''),
    );
    const blockedDown = await harness.psql(
      'ba_migrator_test',
      renderDownMigrationSql(migrations, 4, { allowDown: true }),
      { allowFailure: true, echoErrors: true },
    );
    assertRejected(
      blockedDown,
      /could not obtain lock on relation|55P03/u,
      '005 down NOWAIT loses immediately to an in-flight phase runtime writer',
    );
    assertEqual(
      await harness.queryScalar(
        'ba_bootstrap_test',
        `SELECT concat_ws('|',
  (SELECT max(version) FROM better_agent_migrations.schema_migrations),
  to_regprocedure('app.claim_run_attempt(jsonb)') IS NOT NULL,
  (SELECT state || ':' || (xact_start IS NOT NULL)::text
     FROM pg_catalog.pg_stat_activity WHERE pid = ${String(writerPid)})
);`,
      ),
      '5|t|idle in transaction:true',
      'failed 005 down preserves the migration ledger, runtime catalog and winning writer transaction',
    );
    await writer.execute('ROLLBACK;');
  } catch (error) {
    failures.push(error);
  }
  try {
    const metadata = await writer.close();
    assertEqual(
      `${String(metadata.rawScan.leakDetected)}|${String(metadata.rawScan.count)}`,
      'false|0',
      '005 down runtime-writer fixture does not echo its raw attestation',
    );
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, '005 down NOWAIT fixture cleanup failed');
  }
  assertEqual(
    await runtimeDigest(),
    before,
    'rolled-back runtime winner and failed down leave all committed runtime facts unchanged',
  );
}

async function seedRuntimeSecurityWorkspaces() {
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces (
  id, name, credits_balance, credits_reserved_balance, credits_balance_version
) VALUES
  ('${ids.workspace}', 'G0-07 runtime-security', 1000, 0, 0),
  ('${ids.otherWorkspace}', 'G0-07 other workspace', 1000, 0, 0);`,
  );
}

async function assertAttestationSecurity() {
  for (const [phase] of phaseBindings)
    await issueAttestation({ ...phaseAttestations[phase], phase });
  await issueAttestation(executionOtherAttestation);

  const invalidIssueDigest = await runtimeDigest();
  await assertPsqlRejected(
    'ba_internal_issuer_test',
    issueAttestationSql({
      binding: randomBytes(32).toString('hex'),
      id: rejectedAttestationIds.invalidBinding,
      login: 'ba_admission_test',
      phase: 'execution',
      rawSecret: rejectedAttestationSecrets.invalidBinding,
    }),
    /invalid internal service attestation binding|22023/u,
    'issuer rejects a subject login that is not enrolled in the requested phase',
    { scanFor: [rejectedAttestationSecrets.invalidBinding] },
  );
  assertEqual(
    await runtimeDigest(),
    invalidIssueDigest,
    'invalid attestation issuance has zero durable side effects',
  );

  await issueAttestation({
    binding: randomBytes(32).toString('hex'),
    expires: "clock_timestamp() + interval '1 second'",
    id: rejectedAttestationIds.expired,
    login: 'ba_execution_test',
    phase: 'execution',
    rawSecret: rejectedAttestationSecrets.expired,
  });
  await issueAttestation({
    binding: randomBytes(32).toString('hex'),
    id: rejectedAttestationIds.revoked,
    login: 'ba_execution_test',
    phase: 'execution',
    rawSecret: rejectedAttestationSecrets.revoked,
  });
  await harness.psql(
    'ba_internal_issuer_test',
    `SELECT auth.revoke_internal_service_attestation(
  '${rejectedAttestationIds.revoked}', 'fixture revocation'
);`,
  );

  for (const [phase] of phaseBindings) {
    const result = await phasePsql(phase, '', { tuplesOnly: true });
    assertEqual(
      result.stdout.trim(),
      ids.workspace,
      `${phase} establishes only its attested Workspace in the current transaction`,
    );
  }
  const reused = await phasePsql('execution', '', { tuplesOnly: true });
  assertEqual(
    reused.stdout.trim(),
    ids.workspace,
    'an unexpired raw attestation re-establishes a fresh proof on another connection',
  );

  const execution = phaseAttestations.execution;
  const rejectionDigest = await runtimeDigest();
  await assertPsqlRejected(
    execution.login,
    `BEGIN;
SELECT auth.establish_internal_service_workspace_context(
  '${execution.id}', decode('${wrongVerifier}', 'hex'), 'execution'
);`,
    /attestation verification failed|42501/u,
    'wrong raw verifier is rejected',
    { scanFor: [wrongVerifier] },
  );
  await assertPsqlRejected(
    'ba_execution_other_test',
    establishSql('execution'),
    /unavailable for this binding|42501/u,
    'same-phase second login cannot reuse the first login attestation',
    { scanFor: [execution.rawSecret] },
  );
  await assertPsqlRejected(
    execution.login,
    `BEGIN;
SELECT auth.establish_internal_service_workspace_context(
  '${execution.id}', decode('${execution.rawSecret}', 'hex'), 'metering'
);`,
    /not enrolled for the requested internal phase|42501/u,
    'wrong requested phase is rejected before context establishment',
    { scanFor: [execution.rawSecret] },
  );
  await harness.waitForDatabaseCondition(
    `SELECT clock_timestamp() >= expires_at
FROM auth.internal_service_attestations
WHERE id = '${rejectedAttestationIds.expired}';`,
    { context: 'short-lived internal attestation expiry', timeoutMs: 5_000 },
  );
  await assertPsqlRejected(
    execution.login,
    `BEGIN;
SELECT auth.establish_internal_service_workspace_context(
  '${rejectedAttestationIds.expired}',
  decode('${rejectedAttestationSecrets.expired}', 'hex'), 'execution'
);`,
    /unavailable for this binding|42501/u,
    'expired internal attestation is rejected by database time',
    { scanFor: [rejectedAttestationSecrets.expired] },
  );
  await assertPsqlRejected(
    execution.login,
    `BEGIN;
SELECT auth.establish_internal_service_workspace_context(
  '${rejectedAttestationIds.revoked}',
  decode('${rejectedAttestationSecrets.revoked}', 'hex'), 'execution'
);`,
    /unavailable for this binding|42501/u,
    'revoked internal attestation is rejected',
    { scanFor: [rejectedAttestationSecrets.revoked] },
  );
  assertEqual(
    await runtimeDigest(),
    rejectionDigest,
    'wrong verifier/session/phase plus expired and revoked establishment have zero side effects',
  );

  const proofSession = harness.openInteractivePsql(execution.login, {
    applicationName: 'ba-g007-old-proof-source',
    scanFor: [execution.rawSecret],
  });
  await proofSession.execute(`BEGIN;
SELECT auth.establish_internal_service_workspace_context(
  '${execution.id}', decode('${execution.rawSecret}', 'hex'), 'execution'
);`);
  const oldProof = (
    await proofSession.execute(`SELECT current_setting('app.tenant_context');`)
  ).trim();
  await proofSession.execute('COMMIT;');
  const proofMetadata = await proofSession.close();
  assertEqual(
    `${String(proofMetadata.rawScan.leakDetected)}|${String(proofMetadata.rawScan.count)}`,
    'false|0',
    'old-proof source connection does not echo the raw attestation',
  );
  await assertPsqlRejected(
    execution.login,
    `BEGIN;
SELECT set_config('app.tenant_context', ${sqlLiteral(oldProof)}, true);
SELECT app.claim_run_attempt(${jsonb({
      attempt_id: ids.attempt,
      duration_seconds: 30,
      run_id: ids.run,
    })});`,
    /phase proof is missing or mismatched|42501/u,
    'a copied transaction proof is invalid in a new transaction and connection',
  );
  assertEqual(
    await runtimeDigest(),
    rejectionDigest,
    'copied old transaction proof has zero durable side effects',
  );
}

async function assertAttestationRevocationCheckBackstop() {
  const attestationCountBefore = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT count(*)::text
FROM auth.internal_service_attestations
WHERE workspace_id = '${ids.workspace}';`,
  );
  const digestBefore = await runtimeDigest();

  await assertPsqlRejected(
    'ba_bootstrap_test',
    `BEGIN;
INSERT INTO auth.internal_service_attestations (
  id, workspace_id, subject_session_user, phase, audience,
  binding_sha256, verifier_hmac, issued_at, expires_at,
  revoked_at, revocation_reason
)
SELECT
  '${rejectedAttestationIds.invalidRevocationShape}',
  '${ids.workspace}',
  'ba_execution_test',
  'execution',
  'better-agent/internal-service/1',
  public.digest(convert_to('g007-invalid-revocation-binding', 'UTF8'), 'sha256'),
  public.digest(convert_to('g007-invalid-revocation-verifier', 'UTF8'), 'sha256'),
  timing.issued_at,
  timing.issued_at + interval '10 minutes',
  timing.issued_at,
  NULL
FROM (SELECT clock_timestamp() AS issued_at) AS timing;
COMMIT;`,
    /ERROR:\s+23514:[^\r\n]*constraint "internal_service_attestations_revocation_check"/u,
    'owner-plane raw INSERT cannot store a revoked attestation without a revocation reason',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT count(*)::text
FROM auth.internal_service_attestations
WHERE workspace_id = '${ids.workspace}';`,
    ),
    attestationCountBefore,
    'revocation CHECK rejection preserves the Workspace attestation row count',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT count(*)::text
FROM auth.internal_service_attestations
WHERE id = '${rejectedAttestationIds.invalidRevocationShape}';`,
    ),
    '0',
    'revocation CHECK rejection leaves no malformed attestation row',
  );
  assertEqual(
    await runtimeDigest(),
    digestBefore,
    'revocation CHECK rejection has zero runtime side effects',
  );
}

async function assertPhaseAclIsolation() {
  const phaseRoles = phaseBindings.map(([phase]) => `ba_${phase}_executor`);
  const actualRoleMatrix = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT string_agg(concat_ws(':', role_row.rolname,
  role_row.rolcanlogin::text,
  role_row.rolinherit::text,
  role_row.rolsuper::text,
  role_row.rolcreatedb::text,
  role_row.rolcreaterole::text,
  role_row.rolreplication::text,
  role_row.rolbypassrls::text
), '|' ORDER BY role_row.rolname)
FROM pg_catalog.pg_roles AS role_row
WHERE role_row.rolname = ANY (ARRAY[
  'ba_internal_service_attestation_issuer',
  ${phaseRoles.map(sqlLiteral).join(',\n  ')}
]::name[]);`,
  );
  const expectedRoleMatrix = ['ba_internal_service_attestation_issuer', ...phaseRoles]
    .sort()
    .map((role) => `${role}:false:false:false:false:false:false:false`)
    .join('|');
  assertEqual(
    actualRoleMatrix,
    expectedRoleMatrix,
    'phase capabilities remain isolated NOLOGIN roles',
  );

  for (const [phase, login] of phaseBindings) {
    assertEqual(
      await harness.queryScalar(
        'ba_bootstrap_test',
        `SELECT concat_ws('|',
  pg_has_role('${login}', 'ba_${phase}_executor', 'MEMBER')::text,
  pg_has_role('${login}', 'ba_runtime', 'MEMBER')::text,
  pg_has_role('${login}', 'ba_run_owner', 'MEMBER')::text,
  pg_has_role('${login}', 'ba_billing_owner', 'MEMBER')::text,
  pg_has_role('${login}', 'ba_internal_service_attestation_issuer', 'MEMBER')::text,
  has_database_privilege('${login}', current_database(), 'TEMP')::text,
  has_schema_privilege('${login}', 'public', 'CREATE')::text,
  has_table_privilege('${login}', 'public.runs', 'SELECT')::text,
  has_table_privilege('${login}', 'public.runs', 'INSERT')::text,
  has_function_privilege(
    '${login}',
    'auth.establish_internal_service_workspace_context(uuid,bytea,text)',
    'EXECUTE'
  )::text
);`,
      ),
      'true|false|false|false|false|false|false|false|false|true',
      `${phase} login has one phase capability, common establish, and no owner/raw-write authority`,
    );
    const actualFunctions = await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT COALESCE(string_agg(signature, '|' ORDER BY signature), '')
FROM unnest(ARRAY[
  ${allExecutorSignatures.map(sqlLiteral).join(',\n  ')}
]::text[]) AS allowed(signature)
WHERE has_function_privilege('${login}', signature, 'EXECUTE');`,
    );
    const expectedFunctions = [commonEstablishSignature, ...phaseFunctionOracle[phase]]
      .sort()
      .join('|');
    assertEqual(
      actualFunctions,
      expectedFunctions,
      `${phase} login has exactly common establish plus its reviewed phase façade set`,
    );
  }

  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  has_function_privilege('ba_internal_issuer_test',
    'auth.issue_internal_service_attestation(uuid,uuid,name,text,text,bytea,bytea,timestamptz)',
    'EXECUTE')::text,
  has_function_privilege('ba_internal_issuer_test',
    'auth.revoke_internal_service_attestation(uuid,text)', 'EXECUTE')::text,
  has_function_privilege('ba_internal_issuer_test',
    'auth.establish_internal_service_workspace_context(uuid,bytea,text)', 'EXECUTE')::text,
  pg_has_role('ba_internal_issuer_test', 'ba_auth_owner', 'MEMBER')::text
);`,
    ),
    'true|true|false|false',
    'issuer can only issue/revoke and cannot establish or inherit its owner',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  has_function_privilege('ba_runtime_test',
    'app.reserve_credits(uuid,uuid,uuid,uuid,bigint,text,text,text,text,timestamptz,timestamptz)',
    'EXECUTE')::text,
  has_function_privilege('ba_runtime_test',
    'app.settle_credits(uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,text,jsonb,timestamptz)',
    'EXECUTE')::text,
  has_function_privilege('ba_runtime_test',
    'app.release_credits(uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,text,text,timestamptz)',
    'EXECUTE')::text,
  has_function_privilege('ba_runtime_test', 'app.finalize_run(jsonb)', 'EXECUTE')::text,
  has_function_privilege('ba_plain_app_test',
    'auth.establish_internal_service_workspace_context(uuid,bytea,text)', 'EXECUTE')::text
);`,
    ),
    'false|false|false|false|false',
    'legacy runtime and plain application logins cannot enter billing/finalizer/phase authority',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  has_schema_privilege('ba_run_owner', 'auth', 'USAGE')::text,
  has_schema_privilege('ba_billing_owner', 'auth', 'USAGE')::text,
  has_schema_privilege('ba_archive_evidence_owner', 'auth', 'USAGE')::text,
  has_schema_privilege('ba_retention', 'auth', 'USAGE')::text,
  has_schema_privilege('ba_run_owner', 'auth', 'CREATE')::text,
  has_schema_privilege('ba_billing_owner', 'auth', 'CREATE')::text,
  has_schema_privilege('ba_archive_evidence_owner', 'auth', 'CREATE')::text,
  has_schema_privilege('ba_retention', 'auth', 'CREATE')::text,
  has_schema_privilege('ba_run_owner', 'app', 'CREATE')::text,
  has_schema_privilege('ba_billing_owner', 'app', 'CREATE')::text,
  has_schema_privilege('ba_archive_evidence_owner', 'app', 'CREATE')::text,
  has_schema_privilege('ba_retention', 'app', 'CREATE')::text
);`,
    ),
    'true|true|true|true|false|false|false|false|false|false|false|false',
    'phase-function owners can resolve auth proof only and retain no schema creation authority',
  );

  const rawAclDigest = await runtimeDigest();
  await assertPsqlRejected(
    'ba_execution_test',
    'SELECT count(*) FROM public.runs;',
    /permission denied|42501/u,
    'execution login cannot read raw Run facts',
  );
  await assertPsqlRejected(
    'ba_execution_test',
    `INSERT INTO public.workspaces (id, name) VALUES ('${fixtureUuid(999)}', 'forbidden');`,
    /permission denied|42501/u,
    'execution login cannot mutate raw tenant facts',
  );
  await assertPsqlRejected(
    'ba_execution_test',
    'CREATE TEMP TABLE forbidden_runtime_temp (id integer);',
    /permission denied|42501/u,
    'execution login cannot create temporary relations',
  );
  await assertPsqlRejected(
    'ba_execution_test',
    'CREATE TABLE public.forbidden_runtime_table (id integer);',
    /permission denied|42501/u,
    'execution login cannot create schema relations',
  );
  await assertPsqlRejected(
    'ba_execution_test',
    issueAttestationSql({
      ...phaseAttestations.execution,
      id: fixtureUuid(998),
      phase: 'execution',
    }),
    /permission denied|42501/u,
    'executor cannot invoke issuer authority',
    { scanFor: [phaseAttestations.execution.rawSecret] },
  );
  assertEqual(
    await runtimeDigest(),
    rawAclDigest,
    'raw ACL attacks leave all runtime facts unchanged',
  );
}

const runtimeFixtures = Object.freeze([
  Object.freeze({
    acceptedRequest: ids.acceptedRequest,
    attempt: ids.attempt,
    dispatch: ids.dispatch,
    label: 'primary',
    reservation: ids.reservation,
    run: ids.run,
    step: ids.step,
  }),
  Object.freeze({
    acceptedRequest: ids.rollbackAcceptedRequest,
    attempt: ids.rollbackAttempt,
    dispatch: fixtureUuid(23),
    label: 'rollback',
    reservation: fixtureUuid(24),
    run: ids.rollbackRun,
    step: ids.rollbackStep,
  }),
  Object.freeze({
    acceptedRequest: ids.replayAcceptedRequest,
    attempt: ids.replayAttempt,
    dispatch: ids.replayDispatch,
    label: 'replay',
    reservation: ids.replayReservation,
    run: ids.replayRun,
    step: ids.replayStep,
  }),
  Object.freeze({
    acceptedRequest: ids.holdAcceptedRequest,
    attempt: ids.holdAttempt,
    dispatch: fixtureUuid(45),
    label: 'hold',
    reservation: ids.holdReservation,
    run: ids.holdRun,
    step: ids.holdStep,
  }),
  Object.freeze({
    acceptedRequest: ids.cancelAcceptedRequest,
    attempt: null,
    dispatch: fixtureUuid(53),
    label: 'cancel',
    reservation: ids.cancelReservation,
    run: ids.cancelRun,
    step: null,
  }),
  Object.freeze({
    acceptedRequest: ids.zeroCancelAcceptedRequest,
    attempt: null,
    dispatch: fixtureUuid(63),
    label: 'zero-cancel',
    reservation: ids.zeroCancelReservation,
    reservedCredits: 0,
    run: ids.zeroCancelRun,
    step: null,
  }),
  Object.freeze({
    acceptedRequest: ids.retirementAcceptedRequest,
    attempt: ids.retirementAttempt,
    dispatch: ids.retirementDispatch,
    label: 'terminal-retirement',
    reservation: ids.retirementReservation,
    run: ids.retirementRun,
    step: ids.retirementStep,
  }),
]);

const holdMatrixFixtures = Object.freeze([
  Object.freeze({
    acceptedRequest: ids.missingAcceptedRequest,
    attempt: ids.missingAttempt,
    cancelEvent: ids.missingCancelEvent,
    closureDisposition: 'CLOSED',
    dispatch: ids.missingDispatch,
    effect: 'missing',
    expectedHoldReason: 'MISSING_ENVELOPE',
    label: 'missing-effect-hold',
    reservation: ids.missingReservation,
    reservedCredits: 0,
    run: ids.missingRun,
    step: ids.missingStep,
  }),
  Object.freeze({
    acceptedRequest: ids.unknownAcceptedRequest,
    attempt: ids.unknownAttempt,
    cancelEvent: ids.unknownCancelEvent,
    closureDisposition: 'CLOSED',
    dispatch: ids.unknownDispatch,
    effect: 'unknown-receipt',
    expectedHoldReason: 'SIDE_EFFECT_UNKNOWN',
    label: 'unknown-effect-hold',
    reservation: ids.unknownReservation,
    reservedCredits: 0,
    run: ids.unknownRun,
    step: ids.unknownStep,
  }),
  Object.freeze({
    acceptedRequest: ids.openAcceptedRequest,
    attempt: ids.openAttempt,
    cancelEvent: ids.openCancelEvent,
    closureDisposition: 'OPEN',
    dispatch: ids.openDispatch,
    effect: 'confirmed',
    expectedHoldReason: 'EFFECT_CLOSURE_OPEN',
    label: 'aggregate-open-hold',
    reservation: ids.openReservation,
    reservedCredits: 0,
    run: ids.openRun,
    step: ids.openStep,
  }),
  Object.freeze({
    acceptedRequest: ids.aggregateUnknownAcceptedRequest,
    attempt: ids.aggregateUnknownAttempt,
    cancelEvent: ids.aggregateUnknownCancelEvent,
    closureDisposition: 'UNKNOWN',
    dispatch: ids.aggregateUnknownDispatch,
    effect: 'confirmed',
    expectedHoldReason: 'EFFECT_CLOSURE_UNKNOWN',
    label: 'aggregate-unknown-hold',
    reservation: ids.aggregateUnknownReservation,
    reservedCredits: 0,
    run: ids.aggregateUnknownRun,
    step: ids.aggregateUnknownStep,
  }),
  Object.freeze({
    acceptedRequest: ids.meteringMissAcceptedRequest,
    attempt: ids.meteringMissAttempt,
    cancelEvent: ids.meteringMissCancelEvent,
    closureDisposition: 'OPEN',
    dispatch: ids.meteringMissDispatch,
    effect: 'confirmed',
    expectedHoldReason: 'EFFECT_CLOSURE_OPEN',
    label: 'hold-metering-miss',
    reservation: ids.meteringMissReservation,
    reservedCredits: 1,
    run: ids.meteringMissRun,
    step: ids.meteringMissStep,
    usage: 'miss-after-hold',
  }),
  Object.freeze({
    acceptedRequest: ids.meteringReplayAcceptedRequest,
    attempt: ids.meteringReplayAttempt,
    cancelEvent: ids.meteringReplayCancelEvent,
    closureDisposition: 'OPEN',
    dispatch: ids.meteringReplayDispatch,
    effect: 'confirmed',
    expectedHoldReason: 'EFFECT_CLOSURE_OPEN',
    label: 'hold-metering-replay',
    reservation: ids.meteringReplayReservation,
    reservedCredits: 1,
    run: ids.meteringReplayRun,
    step: ids.meteringReplayStep,
    usage: 'committed-before-hold',
  }),
]);

const noFinancialFixtures = Object.freeze([
  Object.freeze({
    acceptedRequest: ids.noFinancialSettledAcceptedRequest,
    cancelEvent: ids.noFinancialSettledCancelEvent,
    dispatch: ids.noFinancialSettledDispatch,
    label: 'pre-settled-cancel',
    ledger: ids.noFinancialSettledLedger,
    reservation: ids.noFinancialSettledReservation,
    reservationStatus: 'SETTLED',
    run: ids.noFinancialSettledRun,
  }),
  Object.freeze({
    acceptedRequest: ids.noFinancialReleasedAcceptedRequest,
    cancelEvent: ids.noFinancialReleasedCancelEvent,
    dispatch: ids.noFinancialReleasedDispatch,
    label: 'pre-released-cancel',
    ledger: ids.noFinancialReleasedLedger,
    reservation: ids.noFinancialReleasedReservation,
    reservationStatus: 'RELEASED',
    run: ids.noFinancialReleasedRun,
  }),
  Object.freeze({
    acceptedRequest: ids.noFinancialExpiredAcceptedRequest,
    cancelEvent: ids.noFinancialExpiredCancelEvent,
    dispatch: ids.noFinancialExpiredDispatch,
    label: 'pre-expired-cancel',
    ledger: ids.noFinancialExpiredLedger,
    reservation: ids.noFinancialExpiredReservation,
    reservationStatus: 'EXPIRED',
    run: ids.noFinancialExpiredRun,
  }),
]);

const billingVectorIds = Object.freeze({
  attempt: '018f47f2-c541-7cc6-9292-4a2c35303205',
  billingRun: '018f47f2-c541-7cc6-9292-4a2c35303202',
  cancelEvent: '018f47f2-c541-7cc6-9292-4a2c3530320a',
  meteredRun: '018f47f2-c541-7cc6-9292-4a2c35303203',
  reservation: '018f47f2-c541-7cc6-9292-4a2c35303204',
  step: '018f47f2-c541-7cc6-9292-4a2c35303206',
  termination: '018f47f2-c541-7cc6-9292-4a2c35303209',
  token: '018f47f2-c541-7cc6-9292-4a2c35303207',
  usage: '018f47f2-c541-7cc6-9292-4a2c35303208',
  workspace: '018f47f2-c541-7cc6-9292-4a2c35303201',
});
const billingVectorHashA = `sha256:${'a'.repeat(64)}`;
const billingVectorHashB = `sha256:${'b'.repeat(64)}`;
const billingVectorAuthorizedAt = '2026-08-28T01:00:00.000Z';
const billingVectorLeaseExpiresAt = '2026-08-28T01:00:30.000Z';

const billingHashVectors = Object.freeze([
  Object.freeze({
    expectedIntentHash: 'sha256:e632bb5a5893c1779563bd0ee268c225aa038fd28d8a1349d638a75251e8adf8',
    expectedSourceHash: 'sha256:367977effd85124e39490e5d18b586c251e44e4d29d34a6c6a27169072c62dd2',
    hashDomain: 'better-agent/execution-usage-source/1',
    label: 'usage attribution',
    source: Object.freeze({
      amount_credits: '3',
      attempt_id: billingVectorIds.attempt,
      authorized_at: billingVectorAuthorizedAt,
      billing_owner_run_id: billingVectorIds.billingRun,
      consumption_generation: '1',
      execution_effect_payload_sha256: billingVectorHashB,
      lease_expires_at: billingVectorLeaseExpiresAt,
      lease_fencing_token: '7',
      lease_owner: 'ba_execution_worker_a',
      lease_token: billingVectorIds.token,
      metering_quantity: '12',
      metering_unit: 'tokens',
      operation_intent_sha256: billingVectorHashA,
      producer_operation_key: 'usage:test-vector',
      producer_session_user: 'ba_execution_worker_a',
      reservation_id: billingVectorIds.reservation,
      run_id: billingVectorIds.meteredRun,
      schema_version: 'run-usage-attribution/1',
      settlement_operation_key: 'settle:usage:12',
      step_id: billingVectorIds.step,
      usage_attribution_id: billingVectorIds.usage,
      workspace_id: billingVectorIds.workspace,
    }),
    sourceOmissions: Object.freeze(['lease_owner', 'consumption_generation']),
  }),
  Object.freeze({
    expectedIntentHash: 'sha256:26a38e9d30c50ca8739117e3a3df6a977f9772228beca3ce82aeaaaeb724504e',
    expectedSourceHash: 'sha256:b92e3d1381c68ee6cbe7921494e72edc4a609fb67841cf1c6c6b7d7d2ba1c375',
    hashDomain: 'better-agent/execution-termination-source/1',
    label: 'termination attribution',
    source: Object.freeze({
      attempt_id: billingVectorIds.attempt,
      authorized_at: billingVectorAuthorizedAt,
      billing_owner_run_id: billingVectorIds.billingRun,
      consumption_generation: '1',
      effect_closure_sha256: billingVectorHashA,
      effect_disposition: 'CLOSED',
      intended_release_credits: '2',
      intended_settle_credits: '3',
      lease_expires_at: billingVectorLeaseExpiresAt,
      lease_fencing_token: '7',
      lease_owner: 'ba_execution_worker_a',
      lease_token: billingVectorIds.token,
      operation_intent_sha256: billingVectorHashB,
      producer_operation_key: 'termination:test-vector',
      producer_session_user: 'ba_execution_worker_a',
      release_operation_key: 'release:terminal:remainder',
      release_reason_code: 'USER_CANCELLED',
      reservation_id: billingVectorIds.reservation,
      run_id: billingVectorIds.meteredRun,
      schema_version: 'run-termination-intent/1',
      settlement_operation_key: 'settle:terminal:usage-set',
      step_id: billingVectorIds.step,
      terminal_status: 'CANCELLED',
      termination_intent_id: billingVectorIds.termination,
      termination_reason: 'USER_CANCELLED',
      usage_attribution_ids: Object.freeze([billingVectorIds.usage]),
      workspace_id: billingVectorIds.workspace,
    }),
    sourceOmissions: Object.freeze(['lease_owner', 'consumption_generation']),
  }),
  Object.freeze({
    expectedIntentHash: 'sha256:721b9de33a2eee3688cfe00a62ac3a183672e3296dd1c4777e6607241650d4e3',
    expectedSourceHash: 'sha256:0d71b017793fdaf4e92db810b99dd5a2c10dd7dbf739915d9edf56324d36ba2d',
    hashDomain: 'better-agent/run-cancellation-release-source/1',
    label: 'cancellation release',
    source: Object.freeze({
      authorized_at: billingVectorAuthorizedAt,
      billing_owner_run_id: billingVectorIds.billingRun,
      cancel_event_id: billingVectorIds.cancelEvent,
      cancel_event_sequence: '4',
      cancel_intent_sha256: billingVectorHashA,
      effect_closure_sha256: billingVectorHashA,
      release_operation_key: 'release:cancel:4',
      release_reason_code: 'USER_CANCELLED',
      remaining_credits: '2',
      reservation_id: billingVectorIds.reservation,
      run_id: billingVectorIds.billingRun,
      schema_version: 'run-cancellation-release-authority/1',
      terminal_intent_sha256: billingVectorHashB,
      workspace_id: billingVectorIds.workspace,
    }),
    sourceOmissions: Object.freeze([]),
  }),
]);

function billingIntentForVector(vector) {
  const source = vector.source;
  const sourceHash = vector.expectedSourceHash;
  const descriptor =
    source.schema_version === 'run-usage-attribution/1'
      ? {
          amount: source.amount_credits,
          authorityKind: 'USAGE_ATTRIBUTION',
          intentKind: 'SETTLE',
          sourceId: source.usage_attribution_id,
        }
      : source.schema_version === 'run-termination-intent/1'
        ? {
            amount: source.intended_release_credits,
            authorityKind: 'TERMINATION_ATTRIBUTION',
            intentKind: 'RELEASE',
            sourceId: source.termination_intent_id,
          }
        : {
            amount: source.remaining_credits,
            authorityKind: 'CANCELLATION_RELEASE',
            intentKind: 'RELEASE',
            sourceId: source.cancel_event_id,
          };
  const authority = {
    authority_kind: descriptor.authorityKind,
    schema_version: 'billing-authority-reference/1',
    source_authority_hash: sourceHash,
    source_id: descriptor.sourceId,
    source_schema_version: source.schema_version,
  };
  if (source.schema_version !== 'run-cancellation-release-authority/1') {
    Object.assign(authority, {
      producer_attempt_id: source.attempt_id,
      producer_lease_fencing_token: source.lease_fencing_token,
      producer_run_id: source.run_id,
      step_id: source.step_id,
    });
  }
  return {
    amount_credits: descriptor.amount,
    authority,
    billing_owner_run_id: source.billing_owner_run_id,
    charge_attribution_hash: sourceHash,
    charge_key: `billing-v2/${descriptor.authorityKind.toLowerCase()}/${descriptor.sourceId}/${sourceHash.slice('sha256:'.length)}`,
    intent_kind: descriptor.intentKind,
    reservation_id: source.reservation_id,
    schema_version: 'billing-intent/2',
    workspace_id: source.workspace_id,
  };
}

async function seedProtocolV5Facts() {
  const runRows = runtimeFixtures
    .map(
      (fixture) => `(
  '${ids.workspace}', '${fixture.run}', '${fixture.run}', '${fixture.acceptedRequest}',
  'credential', '${ids.credential}', '/v1/oapi/flow/run',
  '${hash(`g007-${fixture.label}-intent`)}',
  '${hash(`g007-${fixture.label}-admission`)}',
  '${hash(`g007-${fixture.label}-plan`)}',
  'schema://g007/flow-output', '${hash(`g007-${fixture.label}-output`)}',
  '${hash(`g007-${fixture.label}-dependencies`)}', 'flow',
  '${ids.flowDeployment}', '${ids.flowRevision}', '${ids.flow}', '${ids.flowVersion}',
  'QUEUED', 'QUEUED', 'PENDING',
  jsonb_build_object('run_id', '${fixture.run}', 'status', 'QUEUED'), 0
)`,
    )
    .join(',\n');
  const attemptRows = runtimeFixtures
    .filter((fixture) => fixture.attempt !== null)
    .map(
      (fixture) => `(
  '${ids.workspace}', '${fixture.attempt}', '${fixture.run}', 1, 'PENDING',
  5, 0
)`,
    )
    .join(',\n');
  const reservationRows = runtimeFixtures
    .map(
      (fixture, index) => `(
  '${ids.workspace}', '${fixture.reservation}', '${fixture.run}', '${fixture.run}',
  '${hash(`g007-${fixture.label}-plan`)}', 'HELD', ${String(fixture.reservedCredits ?? 20)},
  0, 0, ${String(
    runtimeFixtures.slice(0, index + 1).filter((candidate) => (candidate.reservedCredits ?? 20) > 0)
      .length,
  )},
  clock_timestamp() + interval '1 hour', clock_timestamp(), clock_timestamp()
)`,
    )
    .join(',\n');
  const dispatchRows = runtimeFixtures
    .map(
      (fixture) => `(
  '${ids.workspace}', '${fixture.dispatch}', '${fixture.run}', 'RUN_DISPATCH',
  'g007-${fixture.label}-dispatch', 'fixture://g007/${fixture.label}/dispatch',
  '${hash(`g007-${fixture.label}-dispatch`)}', 1,
  jsonb_build_object('run_id', '${fixture.run}'), 'PENDING',
  clock_timestamp(), clock_timestamp(), 5, 0
)`,
    )
    .join(',\n');

  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
SET LOCAL session_replication_role = replica;
UPDATE public.workspaces
SET credits_balance = 880,
    credits_reserved_balance = 120,
    credits_balance_version = 6,
    updated_at = clock_timestamp()
WHERE id = '${ids.workspace}';
INSERT INTO public.runs (
  workspace_id, id, billing_owner_run_id, accepted_request_id,
  accepted_principal_kind, accepted_credential_id, fixed_route,
  intent_hash, admission_snapshot_hash, accepted_plan_hash,
  accepted_output_schema_ref, accepted_output_schema_hash, dependency_pins_hash,
  target_kind, flow_deployment_id, flow_deployment_revision_id, flow_id, flow_version_id,
  status, execution_status, billing_state, acceptance_receipt_data_redacted,
  last_event_sequence
) VALUES
${runRows};
INSERT INTO public.run_attempts (
  workspace_id, id, run_id, attempt_number, status,
  runtime_protocol_version, lease_generation
) VALUES
${attemptRows};
INSERT INTO public.credit_reservations (
  workspace_id, id, run_id, billing_owner_run_id, accepted_plan_hash,
  status, reserved_credits, settled_credits, released_credits,
  balance_version, expires_at, created_at, updated_at
) VALUES
${reservationRows};
INSERT INTO public.outbox (
  workspace_id, id, run_id, message_type, dedupe_key, payload_ref,
  payload_hash, producer_fencing_token, payload_redacted, status,
  available_at, created_at, delivery_protocol_version, delivery_generation
) VALUES
${dispatchRows};
COMMIT;`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.runs WHERE workspace_id = '${ids.workspace}'
    AND status = 'QUEUED' AND billing_state = 'PENDING'),
  (SELECT count(*) FROM public.run_attempts WHERE workspace_id = '${ids.workspace}'
    AND runtime_protocol_version = 5 AND status = 'PENDING' AND lease_generation = 0),
  (SELECT count(*) FROM public.credit_reservations WHERE workspace_id = '${ids.workspace}'
    AND status = 'HELD'),
  (SELECT count(*) FROM public.outbox WHERE workspace_id = '${ids.workspace}'
    AND message_type = 'RUN_DISPATCH' AND delivery_protocol_version = 5
    AND status = 'PENDING' AND delivery_generation = 0)
);`,
    ),
    '7|5|7|7',
    'disposable accepted-plan seam exposes only protocol-v5 starting facts',
  );
}

async function seedRemainingPlanFacts() {
  const fixtures = [...holdMatrixFixtures, ...noFinancialFixtures];
  const runRows = fixtures
    .map(
      (fixture) => `(
  '${ids.workspace}', '${fixture.run}', '${fixture.run}', '${fixture.acceptedRequest}',
  'credential', '${ids.credential}', '/v1/oapi/flow/run',
  '${hash(`g007-${fixture.label}-intent`)}',
  '${hash(`g007-${fixture.label}-admission`)}',
  '${hash(`g007-${fixture.label}-plan`)}',
  'schema://g007/flow-output', '${hash(`g007-${fixture.label}-output`)}',
  '${hash(`g007-${fixture.label}-dependencies`)}', 'flow',
  '${ids.flowDeployment}', '${ids.flowRevision}', '${ids.flow}', '${ids.flowVersion}',
  'QUEUED', 'QUEUED', 'PENDING',
  jsonb_build_object('run_id', '${fixture.run}', 'status', 'QUEUED'), 0
)`,
    )
    .join(',\n');
  const attemptRows = holdMatrixFixtures
    .map(
      (fixture) => `(
  '${ids.workspace}', '${fixture.attempt}', '${fixture.run}', 1, 'PENDING', 5, 0
)`,
    )
    .join(',\n');
  let positiveReservationVersion = 6;
  const holdReservationRows = holdMatrixFixtures
    .map((fixture) => {
      if (fixture.reservedCredits > 0) positiveReservationVersion += 1;
      return `(
  '${ids.workspace}', '${fixture.reservation}', '${fixture.run}', '${fixture.run}',
  '${hash(`g007-${fixture.label}-plan`)}', 'HELD', ${String(fixture.reservedCredits)},
  0, 0, ${String(positiveReservationVersion)}, clock_timestamp() + interval '1 hour',
  clock_timestamp(), clock_timestamp(), NULL, NULL, NULL
)`;
    })
    .join(',\n');
  const noFinancialReservationRows = noFinancialFixtures
    .map((fixture) => {
      const isSettled = fixture.reservationStatus === 'SETTLED';
      return `(
  '${ids.workspace}', '${fixture.reservation}', '${fixture.run}', '${fixture.run}',
  '${hash(`g007-${fixture.label}-plan`)}', '${fixture.reservationStatus}', 0, 0, 0, 8,
  transaction_timestamp() + interval '1 hour', transaction_timestamp() - interval '1 minute',
  transaction_timestamp(), ${isSettled ? 'transaction_timestamp()' : 'NULL'},
  ${isSettled ? 'NULL' : 'transaction_timestamp()'}, 'G007_PRE_CLOSED'
)`;
    })
    .join(',\n');
  const dispatchRows = fixtures
    .map(
      (fixture) => `(
  '${ids.workspace}', '${fixture.dispatch}', '${fixture.run}', 'RUN_DISPATCH',
  'g007-${fixture.label}-dispatch', 'fixture://g007/${fixture.label}/dispatch',
  '${hash(`g007-${fixture.label}-dispatch`)}', 1,
  jsonb_build_object('run_id', '${fixture.run}'), 'PENDING',
  clock_timestamp(), clock_timestamp(), 5, 0
)`,
    )
    .join(',\n');
  const proofLedgerRows = noFinancialFixtures
    .map(
      (fixture) => `(
  '${ids.workspace}', '${fixture.ledger}', '${fixture.run}', '${fixture.run}', '${fixture.run}',
  '${fixture.reservation}', '${
    fixture.reservationStatus === 'EXPIRED' ? 'EXPIRED' : 'RECONCILIATION'
  }', 0, 0, 0,
  '${hash(`g007-${fixture.label}-closed-billing-intent`)}',
  '${hash(`g007-${fixture.label}-closed-attribution`)}',
  'g007:${fixture.label}:closed-proof', 878, 122, 878, 122, 8,
  jsonb_build_object('fixture', '${fixture.label}', 'pre_closed', true), clock_timestamp()
)`,
    )
    .join(',\n');

  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
SET LOCAL session_replication_role = replica;
UPDATE public.workspaces
SET credits_balance = 878,
    credits_reserved_balance = 122,
    credits_balance_version = 8,
    updated_at = clock_timestamp()
WHERE id = '${ids.workspace}';
INSERT INTO public.runs (
  workspace_id, id, billing_owner_run_id, accepted_request_id,
  accepted_principal_kind, accepted_credential_id, fixed_route,
  intent_hash, admission_snapshot_hash, accepted_plan_hash,
  accepted_output_schema_ref, accepted_output_schema_hash, dependency_pins_hash,
  target_kind, flow_deployment_id, flow_deployment_revision_id, flow_id, flow_version_id,
  status, execution_status, billing_state, acceptance_receipt_data_redacted,
  last_event_sequence
) VALUES
${runRows};
INSERT INTO public.run_attempts (
  workspace_id, id, run_id, attempt_number, status,
  runtime_protocol_version, lease_generation
) VALUES
${attemptRows};
INSERT INTO public.credit_reservations (
  workspace_id, id, run_id, billing_owner_run_id, accepted_plan_hash,
  status, reserved_credits, settled_credits, released_credits,
  balance_version, expires_at, created_at, updated_at, settled_at, released_at,
  status_reason_code
) VALUES
${holdReservationRows},
${noFinancialReservationRows};
INSERT INTO public.outbox (
  workspace_id, id, run_id, message_type, dedupe_key, payload_ref,
  payload_hash, producer_fencing_token, payload_redacted, status,
  available_at, created_at, delivery_protocol_version, delivery_generation
) VALUES
${dispatchRows};
INSERT INTO public.credits_ledger (
  workspace_id, id, run_id, billing_owner_run_id, producer_run_id,
  reservation_id, entry_kind, available_delta_credits, reserved_delta_credits,
  settled_delta_credits, billing_intent_hash, charge_attribution_hash, charge_key,
  balance_before, reserved_before, balance_after, reserved_after, balance_version,
  metering_detail_redacted, created_at
) VALUES
${proofLedgerRows};
COMMIT;`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT credits_balance || ':' || credits_reserved_balance || ':' || credits_balance_version
     FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT count(*) FROM public.runs WHERE workspace_id = '${ids.workspace}'
     AND id = ANY (ARRAY[${fixtures.map(({ run }) => sqlLiteral(run)).join(', ')}]::uuid[])),
  (SELECT count(*) FROM public.run_attempts WHERE workspace_id = '${ids.workspace}'
     AND id = ANY (ARRAY[${holdMatrixFixtures
       .map(({ attempt }) => sqlLiteral(attempt))
       .join(', ')}]::uuid[])),
  (SELECT count(*) FROM public.credit_reservations WHERE workspace_id = '${ids.workspace}'
     AND id = ANY (ARRAY[${fixtures.map(({ reservation }) => sqlLiteral(reservation)).join(', ')}]::uuid[])),
  (SELECT count(*) FROM public.outbox WHERE workspace_id = '${ids.workspace}'
     AND id = ANY (ARRAY[${fixtures.map(({ dispatch }) => sqlLiteral(dispatch)).join(', ')}]::uuid[])),
  (SELECT count(*) FROM public.credits_ledger WHERE workspace_id = '${ids.workspace}'
     AND id = ANY (ARRAY[${noFinancialFixtures
       .map(({ ledger }) => sqlLiteral(ledger))
       .join(', ')}]::uuid[]))
);`,
    ),
    '878:122:8|9|6|9|9|3',
    'remaining T11/T12 fixtures expose six recovery responsibilities and three pre-closed reservations',
  );
}

function parseLastJson(output, context) {
  const jsonLine = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .findLast((line) => line.startsWith('{'));
  if (jsonLine === undefined) throw new Error(`${context}: missing JSON result`);
  return JSON.parse(jsonLine);
}

function assertErrorMatches(error, expectedPattern, context) {
  const message = error instanceof Error ? error.message : String(error);
  if (!expectedPattern.test(message)) {
    throw new Error(`${context}: expected ${String(expectedPattern)}, received ${message}`);
  }
}

async function assertCrossLanguageBillingHashVectors() {
  for (const vector of billingHashVectors) {
    const sourceExpression =
      vector.sourceOmissions.length === 0
        ? jsonb(vector.source)
        : `(${jsonb(vector.source)} - ARRAY[${vector.sourceOmissions.map(sqlLiteral).join(', ')}])`;
    const intent = billingIntentForVector(vector);
    const result = await harness.psql(
      'ba_migrator_test',
      `BEGIN;
SET LOCAL ROLE ba_billing_owner;
WITH hashes AS (
  SELECT app.g007_sha256(
    ${sqlLiteral(vector.hashDomain)},
    app.g007_canonical_json(${sourceExpression})
  ) AS source_authority_hash,
  app.g007_canonical_sha256(${jsonb(intent)}) AS billing_intent_hash
)
SELECT jsonb_build_object(
  'source_authority_hash', source_authority_hash,
  'charge_attribution_hash', source_authority_hash,
  'billing_intent_hash', billing_intent_hash
) FROM hashes;
ROLLBACK;`,
      { tuplesOnly: true },
    );
    const sqlHashes = parseLastJson(result.stdout, `${vector.label} SQL billing vector`);
    assertEqual(
      `${sqlHashes.source_authority_hash}|${sqlHashes.charge_attribution_hash}|${sqlHashes.billing_intent_hash}`,
      `${vector.expectedSourceHash}|${vector.expectedSourceHash}|${vector.expectedIntentHash}`,
      `${vector.label} PostgreSQL hashes match the frozen TypeScript source and BillingIntentV2 vectors`,
    );
  }
}

async function assertEcmaScriptTrimStringBillingBoundaries() {
  const commonArguments = [
    sqlLiteral(ids.workspace),
    sqlLiteral(ids.run),
    sqlLiteral(ids.reservation),
    sqlLiteral(fixtureUuid(987)),
    sqlLiteral(ids.run),
    sqlLiteral(ids.attempt),
    '1',
    sqlLiteral(ids.step),
    '0',
  ];
  for (const { label, value } of ecmaScriptTrimOnlyValues) {
    await assertPsqlRejected(
      'ba_bootstrap_test',
      `SELECT app.settle_credits(${[
        ...commonArguments,
        sqlLiteral(value),
        sqlLiteral(hash(`g007-trim-settle-intent:${label}`)),
        sqlLiteral(hash(`g007-trim-settle-attribution:${label}`)),
        `'{}'::jsonb`,
        'clock_timestamp()',
      ].join(', ')});`,
      /invalid settle_credits intent|22023/u,
      `${label}-only charge key is rejected at the PostgreSQL settlement façade`,
    );
    for (const [field, chargeKey, reasonCode] of [
      ['charge key', value, 'TRIM_BOUNDARY_TEST'],
      ['reason code', `g007:trim-release:${label}`, value],
    ]) {
      await assertPsqlRejected(
        'ba_bootstrap_test',
        `SELECT app.release_credits(${[
          ...commonArguments,
          sqlLiteral(chargeKey),
          sqlLiteral(hash(`g007-trim-release-intent:${label}:${field}`)),
          sqlLiteral(hash(`g007-trim-release-attribution:${label}:${field}`)),
          sqlLiteral(reasonCode),
          'clock_timestamp()',
        ].join(', ')});`,
        /invalid release_credits intent|22023/u,
        `${label}-only release ${field} is rejected at the PostgreSQL release façade`,
      );
    }
  }
  const paddedChargeKey = `${'c'.repeat(300)} `;
  await assertPsqlRejected(
    'ba_bootstrap_test',
    `SELECT app.settle_credits(${[
      ...commonArguments,
      sqlLiteral(paddedChargeKey),
      sqlLiteral(hash('g007-raw-length-settle-intent')),
      sqlLiteral(hash('g007-raw-length-settle-attribution')),
      `'{}'::jsonb`,
      'clock_timestamp()',
    ].join(', ')});`,
    /invalid settle_credits intent|22023/u,
    '301-code-point padded charge key is rejected at the PostgreSQL settlement façade',
  );
  const paddedReasonCode = `${'R'.repeat(200)} `;
  await assertPsqlRejected(
    'ba_bootstrap_test',
    `SELECT app.release_credits(${[
      ...commonArguments,
      sqlLiteral('g007:raw-length-release'),
      sqlLiteral(hash('g007-raw-length-release-intent')),
      sqlLiteral(hash('g007-raw-length-release-attribution')),
      sqlLiteral(paddedReasonCode),
      'clock_timestamp()',
    ].join(', ')});`,
    /invalid release_credits intent|22023/u,
    '201-code-point padded reason code is rejected at the PostgreSQL release façade',
  );
}

async function assertSafeBalanceVersionCeiling() {
  const ceiling = '9007199254740991';
  const runId = fixtureUuid(870);
  const reservationId = fixtureUuid(871);
  const ledgerId = fixtureUuid(872);
  const authorityId = fixtureUuid(873);
  const sourceId = fixtureUuid(874);
  const attemptId = fixtureUuid(875);
  const stepId = fixtureUuid(876);
  const kernelContextAttestation = fixtureUuid(877);
  const commonKernelFact = {
    amount: '1',
    authority_id: authorityId,
    authorized_at: '2100-01-01T00:00:00.000Z',
    billing_intent_hash: hash('g007-safe-version-kernel-intent'),
    charge_attribution_hash: hash('g007-safe-version-kernel-attribution'),
    charge_key: 'g007:safe-version:kernel',
    ledger_entry_id: ledgerId,
    producer_attempt_id: attemptId,
    producer_lease_fencing_token: '1',
    producer_run_id: runId,
    reservation_id: reservationId,
    run_id: runId,
    source_authority_hash: hash('g007-safe-version-kernel-source'),
    source_consumption_generation: '1',
    source_id: sourceId,
    step_id: stepId,
    workspace_id: ids.workspace,
  };
  const commonLegacyArguments = [
    sqlLiteral(ids.workspace),
    sqlLiteral(runId),
    sqlLiteral(reservationId),
    sqlLiteral(ledgerId),
    sqlLiteral(runId),
    sqlLiteral(attemptId),
    '1',
    sqlLiteral(stepId),
    '1',
  ];
  const vectors = [
    {
      label: 'attributed settlement kernel',
      statement: `SELECT app.apply_credit_settlement_kernel(${jsonb({
        ...commonKernelFact,
        authority_kind: 'EXECUTION_USAGE',
        operation: 'SETTLE',
      })});`,
    },
    {
      label: 'attributed release kernel',
      statement: `SELECT app.apply_credit_release_kernel(${jsonb({
        ...commonKernelFact,
        authority_kind: 'EXECUTION_TERMINATION',
        operation: 'RELEASE',
        reason_code: 'SAFE_VERSION_CEILING',
      })});`,
    },
    {
      label: 'legacy settlement facade',
      statement: `SELECT app.settle_credits(${[
        ...commonLegacyArguments,
        sqlLiteral('g007:safe-version:legacy-settle'),
        sqlLiteral(hash('g007-safe-version-legacy-settle-intent')),
        sqlLiteral(hash('g007-safe-version-legacy-settle-attribution')),
        `'{}'::jsonb`,
        'clock_timestamp()',
      ].join(', ')});`,
    },
    {
      label: 'legacy release facade',
      statement: `SELECT app.release_credits(${[
        ...commonLegacyArguments,
        sqlLiteral('g007:safe-version:legacy-release'),
        sqlLiteral(hash('g007-safe-version-legacy-release-intent')),
        sqlLiteral(hash('g007-safe-version-legacy-release-attribution')),
        sqlLiteral('SAFE_VERSION_CEILING'),
        'clock_timestamp()',
      ].join(', ')});`,
    },
  ];
  const signedOwnerContextSetSql = (attestationId) => `SELECT set_config(
  'app.tenant_context',
  format(
    'internal:%s:%s:%s:%s:%s:%s',
    attestation.workspace_id,
    attestation.id,
    attestation.phase,
    txid_current(),
    session_user,
    encode(public.hmac(
      convert_to(format(
        'internal:%s:%s:%s:%s:%s',
        attestation.workspace_id,
        attestation.id,
        attestation.phase,
        txid_current(),
        session_user
      ), 'UTF8'),
      attestation.verifier_hmac,
      'sha256'
    ), 'hex')
  ),
  true
)
FROM auth.internal_service_attestations AS attestation
WHERE attestation.id = '${attestationId}';`;

  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO auth.internal_service_attestations (
  id, workspace_id, subject_session_user, phase, audience,
  binding_sha256, verifier_hmac, issued_at, expires_at
) VALUES (
  '${kernelContextAttestation}', '${ids.workspace}', 'ba_bootstrap_test', 'execution',
  'better-agent/internal-service/1',
  public.digest(convert_to('g007-safe-version-kernel-binding', 'UTF8'), 'sha256'),
  public.digest(convert_to('g007-safe-version-kernel-verifier', 'UTF8'), 'sha256'),
  transaction_timestamp(), transaction_timestamp() + interval '15 minutes'
);`,
  );
  try {
    const before = await workspaceBillingDigest(ids.workspace);
    for (const vector of vectors) {
      await assertPsqlRejected(
        'ba_bootstrap_test',
        `BEGIN;
${signedOwnerContextSetSql(kernelContextAttestation)}
SET LOCAL session_replication_role = replica;
UPDATE public.workspaces
SET credits_balance_version = ${ceiling}
WHERE id = ${sqlLiteral(ids.workspace)}::uuid;
SET LOCAL session_replication_role = origin;
${vector.statement}
ROLLBACK;`,
        /Workspace credit balance version cannot advance safely|22003/u,
        `${vector.label} rejects a non-zero write at the maximum safe balance version`,
      );
      assertEqual(
        await workspaceBillingDigest(ids.workspace),
        before,
        `${vector.label} version-ceiling rejection is atomic across Workspace, reservation, receipt and ledger state`,
      );
    }
  } finally {
    await harness.psql(
      'ba_bootstrap_test',
      `BEGIN;
SET LOCAL session_replication_role = replica;
DELETE FROM auth.internal_service_attestations
WHERE id = '${kernelContextAttestation}';
COMMIT;`,
    );
  }

  const reserveRun = fixtureUuid(890);
  const reserveReservation = fixtureUuid(891);
  const reserveLedger = fixtureUuid(892);
  const expireRun = fixtureUuid(893);
  const expireReservation = fixtureUuid(894);
  const expireLedger = fixtureUuid(895);
  const reconcileRun = fixtureUuid(896);
  const reconcileReservation = fixtureUuid(897);
  const reconcileLedger = fixtureUuid(898);
  const reconciliationId = fixtureUuid(899);
  const reconciliationTerminalEvent = fixtureUuid(900);
  const ownerContextAttestation = fixtureUuid(901);
  const reservePlanHash = hash('g007-safe-version-reserve-plan');
  const expirePlanHash = hash('g007-safe-version-expire-plan');
  const reconcilePlanHash = hash('g007-safe-version-reconcile-plan');
  const evidenceHash = hash('g007-safe-version-reconciliation-evidence');
  const originalBillingDigest = await workspaceBillingDigest(ids.workspace);

  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
SET LOCAL session_replication_role = replica;
UPDATE public.workspaces
SET credits_balance = 1000,
    credits_reserved_balance = 2,
    credits_balance_version = ${ceiling}
WHERE id = '${ids.workspace}';
INSERT INTO public.runs (
  workspace_id, id, billing_owner_run_id, accepted_request_id,
  accepted_principal_kind, accepted_credential_id, fixed_route,
  intent_hash, admission_snapshot_hash, accepted_plan_hash,
  accepted_output_schema_ref, accepted_output_schema_hash, dependency_pins_hash,
  target_kind, flow_deployment_id, flow_deployment_revision_id, flow_id, flow_version_id,
  status, execution_status, billing_state, acceptance_receipt_data_redacted,
  last_event_sequence
) VALUES
  (
    '${ids.workspace}', '${reserveRun}', '${reserveRun}', '${reserveRun}',
    'credential', '${ids.credential}', '/v1/oapi/flow/run',
    '${hash('g007-safe-version-reserve-intent')}',
    '${hash('g007-safe-version-reserve-admission')}', '${reservePlanHash}',
    'schema://g007/safe-version-reserve', '${hash('g007-safe-version-reserve-output')}',
    '${hash('g007-safe-version-reserve-dependencies')}', 'flow',
    '${ids.flowDeployment}', '${ids.flowRevision}', '${ids.flow}', '${ids.flowVersion}',
    'QUEUED', 'QUEUED', 'PENDING',
    jsonb_build_object('fixture', 'g007-safe-version-reserve'), 0
  ),
  (
    '${ids.workspace}', '${expireRun}', '${expireRun}', '${expireRun}',
    'credential', '${ids.credential}', '/v1/oapi/flow/run',
    '${hash('g007-safe-version-expire-intent')}',
    '${hash('g007-safe-version-expire-admission')}', '${expirePlanHash}',
    'schema://g007/safe-version-expire', '${hash('g007-safe-version-expire-output')}',
    '${hash('g007-safe-version-expire-dependencies')}', 'flow',
    '${ids.flowDeployment}', '${ids.flowRevision}', '${ids.flow}', '${ids.flowVersion}',
    'QUEUED', 'QUEUED', 'PENDING',
    jsonb_build_object('fixture', 'g007-safe-version-expire'), 0
  );
INSERT INTO public.runs (
  workspace_id, id, billing_owner_run_id, accepted_request_id,
  accepted_principal_kind, accepted_credential_id, fixed_route,
  intent_hash, admission_snapshot_hash, accepted_plan_hash,
  accepted_output_schema_ref, accepted_output_schema_hash, dependency_pins_hash,
  target_kind, flow_deployment_id, flow_deployment_revision_id, flow_id, flow_version_id,
  status, execution_status, billing_state,
  acceptance_receipt_data_redacted, last_event_sequence,
  termination_reason, terminal_intent_hash, terminal_error_redacted,
  terminal_billing_pending, terminal_billing_pending_at,
  terminal_event_id, terminal_event_sequence, finished_at,
  events_retention_until, recovery_retention_until, retention_until
) VALUES (
  '${ids.workspace}', '${reconcileRun}', '${reconcileRun}', '${reconcileRun}',
  'credential', '${ids.credential}', '/v1/oapi/flow/run',
  '${hash('g007-safe-version-reconcile-intent')}',
  '${hash('g007-safe-version-reconcile-admission')}', '${reconcilePlanHash}',
  'schema://g007/safe-version-reconcile', '${hash('g007-safe-version-reconcile-output')}',
  '${hash('g007-safe-version-reconcile-dependencies')}', 'flow',
  '${ids.flowDeployment}', '${ids.flowRevision}', '${ids.flow}', '${ids.flowVersion}',
  'NEEDS_ATTENTION', 'NEEDS_ATTENTION', 'NEEDS_ATTENTION',
  jsonb_build_object('fixture', 'g007-safe-version-reconcile'), 1,
  'SIDE_EFFECT_UNKNOWN', '${hash('g007-safe-version-reconcile-terminal')}',
  jsonb_build_object(
    'code', 'SIDE_EFFECT_UNKNOWN', 'retryable', false, 'category', 'EXECUTION',
    'requires_operator_action', true
  ),
  false, clock_timestamp(), '${reconciliationTerminalEvent}', 1, clock_timestamp(),
  clock_timestamp() + interval '8 days', clock_timestamp() + interval '31 days',
  clock_timestamp() + interval '32 days'
);
INSERT INTO public.credit_reservations (
  workspace_id, id, run_id, billing_owner_run_id, accepted_plan_hash,
  status, reserved_credits, settled_credits, released_credits, balance_version,
  expires_at, created_at, updated_at
) VALUES
  (
    '${ids.workspace}', '${expireReservation}', '${expireRun}', '${expireRun}',
    '${expirePlanHash}', 'HELD', 1, 0, 0, ${ceiling},
    clock_timestamp() - interval '1 minute', clock_timestamp() - interval '2 minutes',
    clock_timestamp() - interval '2 minutes'
  ),
  (
    '${ids.workspace}', '${reconcileReservation}', '${reconcileRun}', '${reconcileRun}',
    '${reconcilePlanHash}', 'HELD', 1, 0, 0, ${ceiling},
    clock_timestamp() + interval '1 hour', clock_timestamp() - interval '1 minute',
    clock_timestamp() - interval '1 minute'
  );
INSERT INTO auth.internal_service_attestations (
  id, workspace_id, subject_session_user, phase, audience,
  binding_sha256, verifier_hmac, issued_at, expires_at
) VALUES (
  '${ownerContextAttestation}', '${ids.workspace}', 'ba_bootstrap_test', 'execution',
  'better-agent/internal-service/1',
  public.digest(convert_to('g007-safe-version-owner-binding', 'UTF8'), 'sha256'),
  public.digest(convert_to('g007-safe-version-owner-verifier', 'UTF8'), 'sha256'),
  transaction_timestamp(), transaction_timestamp() + interval '15 minutes'
);
COMMIT;`,
  );

  const inheritedBefore = await workspaceBillingDigest(ids.workspace);
  const ownerContextSql = (statement) => `BEGIN;
${signedOwnerContextSetSql(ownerContextAttestation)}
${statement}
COMMIT;`;
  const inheritedOwnerVectors = [
    {
      label: 'inherited reserve facade',
      statement: `SELECT app.reserve_credits(
  '${ids.workspace}', '${reserveRun}', '${reserveReservation}', '${reserveLedger}', 1,
  '${reservePlanHash}', 'g007:safe-version:reserve',
  '${hash('g007-safe-version-reserve-billing-intent')}', '${reservePlanHash}',
  clock_timestamp() + interval '1 hour', clock_timestamp()
);`,
    },
    {
      label: 'inherited expiry facade',
      statement: `SELECT app.expire_credit_reservation(
  '${ids.workspace}', '${expireRun}', '${expireReservation}', '${expireLedger}',
  'g007:safe-version:expire', '${hash('g007-safe-version-expire-billing-intent')}',
  '${hash('g007-safe-version-expire-attribution')}', clock_timestamp()
);`,
    },
  ];

  try {
    for (const vector of inheritedOwnerVectors) {
      await assertPsqlRejected(
        'ba_bootstrap_test',
        ownerContextSql(vector.statement),
        /workspaces_credits_balance_version_safe_check/u,
        `${vector.label} reaches the authoritative safe-version constraint`,
      );
      assertEqual(
        await workspaceBillingDigest(ids.workspace),
        inheritedBefore,
        `${vector.label} safe-version rejection is atomic across billing and Run facts`,
      );
    }

    await assertPhaseRejected(
      'reconciliation',
      `SELECT app.reconcile_needs_attention_billing(${jsonb({
        billing_intent_hash: hash('g007-safe-version-reconcile-billing-intent'),
        charge_attribution_hash: evidenceHash,
        charge_key: 'g007:safe-version:reconcile',
        evidence_ref: 'fixture://g007/safe-version/reconcile',
        evidence_sha256: evidenceHash,
        idempotency_key: 'g007-safe-version-reconcile',
        ledger_entry_id: reconcileLedger,
        reconciliation_id: reconciliationId,
        released_credits: '0',
        reservation_id: reconcileReservation,
        run_id: reconcileRun,
        settled_credits: '1',
      })});`,
      /workspaces_credits_balance_version_safe_check/u,
      'inherited reconciliation facade reaches the authoritative safe-version constraint',
    );
    assertEqual(
      await workspaceBillingDigest(ids.workspace),
      inheritedBefore,
      'inherited reconciliation safe-version rejection is atomic across billing and Run facts',
    );
  } finally {
    await harness.psql(
      'ba_bootstrap_test',
      `BEGIN;
SET LOCAL session_replication_role = replica;
DELETE FROM auth.internal_service_attestations WHERE id = '${ownerContextAttestation}';
DELETE FROM public.credit_reservations
WHERE workspace_id = '${ids.workspace}'
  AND id IN ('${expireReservation}', '${reconcileReservation}');
DELETE FROM public.runs
WHERE workspace_id = '${ids.workspace}'
  AND id IN ('${reserveRun}', '${expireRun}', '${reconcileRun}');
UPDATE public.workspaces
SET credits_balance = 1000,
    credits_reserved_balance = 0,
    credits_balance_version = 0
WHERE id = '${ids.workspace}';
COMMIT;`,
    );
  }
  assertEqual(
    await workspaceBillingDigest(ids.workspace),
    originalBillingDigest,
    'safe-version inherited-writer fixture cleanup restores the original billing projection',
  );
}

async function assertClaimRollbackOnDisconnect() {
  const execution = phaseAttestations.execution;
  const session = harness.openInteractivePsql(execution.login, {
    applicationName: 'ba-g007-claim-rollback',
    scanFor: [execution.rawSecret],
  });
  const backendPid = await session.backendPid();
  await session.execute(
    establishWithAttestationSql(
      execution,
      'execution',
      `SELECT app.claim_run_attempt(${jsonb({
        attempt_id: ids.rollbackAttempt,
        duration_seconds: 30,
        run_id: ids.rollbackRun,
      })});`,
    ).replace(/\nCOMMIT;$/u, ''),
  );
  const metadata = await session.abruptDisconnect();
  await harness.waitForBackendExit(backendPid, {
    context: 'uncommitted Attempt claim backend exit',
    timeoutMs: 5_000,
  });
  assertEqual(
    `${String(metadata.rawScan.leakDetected)}|${String(metadata.rawScan.count)}`,
    'false|0',
    'uncommitted Attempt claim does not echo its raw attestation',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|', status, runtime_protocol_version, lease_generation,
  lease_owner IS NULL, lease_token IS NULL, lease_fencing_token IS NULL,
  lease_expires_at IS NULL)
FROM public.run_attempts
WHERE workspace_id = '${ids.workspace}' AND id = '${ids.rollbackAttempt}';`,
    ),
    'PENDING|5|0|t|t|t|t',
    'abrupt disconnect before claim commit restores the complete PENDING authority tuple',
  );
}

async function assertAttemptClaimLinearization() {
  const winnerAttestation = phaseAttestations.execution;
  const loserAttestation = executionOtherAttestation;
  const winner = harness.openInteractivePsql(winnerAttestation.login, {
    applicationName: 'ba-g007-attempt-claim-winner',
    scanFor: [winnerAttestation.rawSecret],
  });
  const loser = harness.openInteractivePsql(loserAttestation.login, {
    applicationName: 'ba-g007-attempt-claim-loser',
    scanFor: [loserAttestation.rawSecret],
  });
  const winnerPid = await winner.backendPid();
  const loserPid = await loser.backendPid();
  let authority;
  let loserOutcome;
  const failures = [];
  try {
    const winnerOutput = await winner.execute(
      establishWithAttestationSql(
        winnerAttestation,
        'execution',
        `SELECT app.claim_run_attempt(${jsonb({
          attempt_id: ids.attempt,
          duration_seconds: 30,
          run_id: ids.run,
        })});`,
      ).replace(/\nCOMMIT;$/u, ''),
    );
    authority = parseLastJson(winnerOutput, 'winning Attempt claim');
    const loserPromise = loser
      .execute(
        establishWithAttestationSql(
          loserAttestation,
          'execution',
          `SELECT app.claim_run_attempt(${jsonb({
            attempt_id: ids.attempt,
            duration_seconds: 30,
            run_id: ids.run,
          })});`,
        ).replace(/\nCOMMIT;$/u, ''),
        { timeoutMs: 10_000 },
      )
      .then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ reason, status: 'rejected' }),
      );
    await harness.waitForBlockingEdge(loserPid, winnerPid, {
      context: 'second execution login waits on the Run/Attempt claim winner',
      timeoutMs: 5_000,
    });
    await winner.execute('COMMIT;');
    loserOutcome = await loserPromise;
  } catch (error) {
    failures.push(error);
  }
  try {
    const winnerMetadata = await winner.close();
    assertEqual(
      `${String(winnerMetadata.rawScan.leakDetected)}|${String(winnerMetadata.rawScan.count)}`,
      'false|0',
      'winning execution connection does not echo its raw attestation',
    );
  } catch (error) {
    failures.push(error);
  }
  try {
    const loserMetadata = await loser.close();
    assertEqual(
      `${String(loserMetadata.rawScan.leakDetected)}|${String(loserMetadata.rawScan.count)}`,
      'false|0',
      'losing execution connection does not echo its raw attestation',
    );
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Attempt claim concurrency and cleanup failed');
  }
  assertEqual(loserOutcome?.status, 'rejected', 'two-connection Attempt claim has one winner');
  assertErrorMatches(
    loserOutcome?.reason,
    /Attempt is not claimable|55000/u,
    'losing Attempt claim observes the committed winner',
  );
  if (authority === undefined) throw new Error('winning Attempt claim returned no authority');
  assertEqual(
    `${authority.workspace_id}|${authority.run_id}|${authority.attempt_id}|${authority.lease_owner}|${authority.lease_fencing_token}`,
    `${ids.workspace}|${ids.run}|${ids.attempt}|ba_execution_test|1`,
    'winning claim derives Workspace, session owner and first monotonic fence in PostgreSQL',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|', status, lease_generation, lease_owner, lease_token,
  lease_fencing_token, lease_expires_at > clock_timestamp())
FROM public.run_attempts
WHERE workspace_id = '${ids.workspace}' AND id = '${ids.attempt}';`,
    ),
    `RUNNING|1|ba_execution_test|${authority.lease_token}|1|t`,
    'independent readback matches the committed winning Attempt authority',
  );
  return authority;
}

async function concurrentExecutionJsonCall(functionName, fact, context) {
  const attestation = phaseAttestations.execution;
  const winner = harness.openInteractivePsql(attestation.login, {
    applicationName: `ba-g007-${functionName}-winner`,
    scanFor: [attestation.rawSecret],
  });
  const loser = harness.openInteractivePsql(attestation.login, {
    applicationName: `ba-g007-${functionName}-replay`,
    scanFor: [attestation.rawSecret],
  });
  const winnerPid = await winner.backendPid();
  const loserPid = await loser.backendPid();
  const failures = [];
  let winnerValue;
  let loserValue;
  try {
    winnerValue = parseLastJson(
      await winner.execute(
        establishWithAttestationSql(
          attestation,
          'execution',
          `SELECT app.${functionName}(${jsonb(fact)});`,
        ).replace(/\nCOMMIT;$/u, ''),
      ),
      `${context} winner`,
    );
    const loserPromise = loser
      .execute(
        establishWithAttestationSql(
          attestation,
          'execution',
          `SELECT app.${functionName}(${jsonb(fact)});`,
        ).replace(/\nCOMMIT;$/u, ''),
        { timeoutMs: 10_000 },
      )
      .then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ reason, status: 'rejected' }),
      );
    await harness.waitForBlockingEdge(loserPid, winnerPid, {
      context: `${context} concurrent miss waits behind the winner`,
      timeoutMs: 5_000,
    });
    await winner.execute('COMMIT;');
    const loserOutcome = await loserPromise;
    if (loserOutcome.status === 'rejected') throw loserOutcome.reason;
    loserValue = parseLastJson(loserOutcome.value, `${context} replay`);
    await loser.execute('COMMIT;');
  } catch (error) {
    failures.push(error);
    for (const pid of [winnerPid, loserPid]) {
      try {
        await harness.terminateBackend(pid);
      } catch {
        // The backend may already have exited while unwinding the failed fixture.
      }
    }
  }
  for (const [session, label] of [
    [winner, 'winner'],
    [loser, 'replay'],
  ]) {
    try {
      const metadata = await session.close();
      assertEqual(
        `${String(metadata.rawScan.leakDetected)}|${String(metadata.rawScan.count)}`,
        'false|0',
        `${context} ${label} does not echo its raw attestation`,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `${context} concurrency and cleanup failed`);
  }
  if (winnerValue === undefined || loserValue === undefined) {
    throw new Error(`${context} did not return both winner and replay values`);
  }
  return { loser: loserValue, winner: winnerValue };
}

async function commitExecutionCallWithoutDeliveredResponse(
  functionName,
  fact,
  committedConditionSql,
  context,
) {
  const attestation = phaseAttestations.execution;
  const session = harness.openInteractivePsql(attestation.login, {
    applicationName: `ba-g007-${functionName}-response-loss`,
    scanFor: [attestation.rawSecret],
  });
  const backendPid = await session.backendPid();
  const pending = session
    .execute(
      `${establishWithAttestationSql(
        attestation,
        'execution',
        `SELECT app.${functionName}(${jsonb(fact)});`,
      )}\nSELECT pg_catalog.pg_sleep(30);`,
      { timeoutMs: 45_000 },
    )
    .then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ reason, status: 'rejected' }),
    );
  await harness.waitForDatabaseCondition(
    `SELECT (${committedConditionSql}) AND EXISTS (
  SELECT 1 FROM pg_catalog.pg_stat_activity
  WHERE pid = ${String(backendPid)} AND wait_event = 'PgSleep'
);`,
    { context: `${context} commit is durable before response transport loss`, timeoutMs: 5_000 },
  );
  assertEqual(
    await harness.terminateBackend(backendPid),
    't',
    `${context} terminates the post-commit sleeping backend before its marker`,
  );
  const outcome = await pending;
  assertEqual(outcome.status, 'rejected', `${context} does not deliver a successful client result`);
  await harness.waitForBackendExit(backendPid, {
    context: `${context} terminated backend cleanup`,
    timeoutMs: 5_000,
  });
  const metadata = session.metadata();
  assertEqual(
    `${String(metadata.rawScan.leakDetected)}|${String(metadata.rawScan.count)}`,
    'false|0',
    `${context} response-loss transport does not echo its raw attestation`,
  );
}

async function assertEffectPersistenceSeams(baseAuthority, stepId) {
  const concurrentEnvelopeFact = executionEffectEnvelopeFact(baseAuthority, {
    effectClass: 'SAFE',
    label: 'concurrent-effect-envelope',
    stepId,
  });
  const envelopeRace = await concurrentExecutionJsonCall(
    'record_execution_effect_envelope',
    concurrentEnvelopeFact,
    'effect envelope same-fact miss',
  );
  const envelopeWinner = assertExecutionEffectEnvelopeProjection(
    envelopeRace.winner,
    'effect envelope concurrent winner',
  );
  const envelopeReplay = assertExecutionEffectEnvelopeProjection(
    envelopeRace.loser,
    'effect envelope concurrent replay',
  );
  assertEqual(
    `${envelopeWinner.envelope_id}|${envelopeWinner.envelope_sha256}|${String(envelopeWinner.replayed)}|${envelopeReplay.envelope_id}|${envelopeReplay.envelope_sha256}|${String(envelopeReplay.replayed)}`,
    `${envelopeWinner.envelope_id}|${envelopeWinner.envelope_sha256}|false|${envelopeWinner.envelope_id}|${envelopeWinner.envelope_sha256}|true`,
    'effect envelope race commits one immutable winner and one exact replay',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT count(*) FROM public.run_retry_effect_envelopes
WHERE workspace_id = '${ids.workspace}'
  AND run_id = '${baseAuthority.run_id}'
  AND attempt_id = '${baseAuthority.attempt_id}'
  AND operation_intent_sha256 = '${concurrentEnvelopeFact.operation_intent_sha256}';`,
    ),
    '1',
    'effect envelope same-fact race persists only one row',
  );
  const envelopeConflictDigest = await runtimeDigest();
  await assertPhaseRejected(
    'execution',
    `SELECT app.record_execution_effect_envelope(${jsonb({
      ...concurrentEnvelopeFact,
      effect_payload_sha256: flipSha256Bit(concurrentEnvelopeFact.effect_payload_sha256),
    })});`,
    /identity is already committed differently|23505/u,
    'effect envelope same identity rejects a different payload after the race',
  );
  assertEqual(
    await runtimeDigest(),
    envelopeConflictDigest,
    'effect envelope conflict after the race has zero side effects',
  );

  const concurrentReceiptFact = executionEffectReceiptFact(baseAuthority, envelopeWinner, {
    label: 'concurrent-effect-receipt',
    stepId,
  });
  const receiptRace = await concurrentExecutionJsonCall(
    'record_execution_effect_receipt',
    concurrentReceiptFact,
    'effect receipt same-fact miss',
  );
  const receiptWinner = assertExecutionEffectReceiptProjection(
    receiptRace.winner,
    'effect receipt concurrent winner',
  );
  const receiptReplay = assertExecutionEffectReceiptProjection(
    receiptRace.loser,
    'effect receipt concurrent replay',
  );
  assertEqual(
    `${receiptWinner.receipt_id}|${receiptWinner.receipt_sha256}|${String(receiptWinner.replayed)}|${receiptReplay.receipt_id}|${receiptReplay.receipt_sha256}|${String(receiptReplay.replayed)}`,
    `${receiptWinner.receipt_id}|${receiptWinner.receipt_sha256}|false|${receiptWinner.receipt_id}|${receiptWinner.receipt_sha256}|true`,
    'effect receipt race commits one immutable winner and one exact replay',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT count(*) FROM public.run_side_effect_receipts
WHERE workspace_id = '${ids.workspace}'
  AND envelope_id = '${envelopeWinner.envelope_id}';`,
    ),
    '1',
    'effect receipt same-fact race persists only one row',
  );
  const receiptConflictDigest = await runtimeDigest();
  await assertPhaseRejected(
    'execution',
    `SELECT app.record_execution_effect_receipt(${jsonb({
      ...concurrentReceiptFact,
      result_payload_sha256: flipSha256Bit(concurrentReceiptFact.result_payload_sha256),
    })});`,
    /identity is already committed differently|23505/u,
    'effect receipt same identity rejects a different result after the race',
  );
  assertEqual(
    await runtimeDigest(),
    receiptConflictDigest,
    'effect receipt conflict after the race has zero side effects',
  );

  const lostEnvelopeFact = executionEffectEnvelopeFact(baseAuthority, {
    effectClass: 'SAFE',
    label: 'transport-lost-effect-envelope',
    stepId,
  });
  await commitExecutionCallWithoutDeliveredResponse(
    'record_execution_effect_envelope',
    lostEnvelopeFact,
    `EXISTS (
  SELECT 1 FROM public.run_retry_effect_envelopes
  WHERE workspace_id = '${ids.workspace}'
    AND operation_intent_sha256 = '${lostEnvelopeFact.operation_intent_sha256}'
)`,
    'effect envelope post-commit response loss',
  );
  const lostEnvelope = JSON.parse(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT jsonb_build_object(
  'envelope_id', id,
  'envelope_sha256', envelope_sha256
)::text
FROM public.run_retry_effect_envelopes
WHERE workspace_id = '${ids.workspace}'
  AND operation_intent_sha256 = '${lostEnvelopeFact.operation_intent_sha256}';`,
    ),
  );
  const lostReceiptFact = executionEffectReceiptFact(baseAuthority, lostEnvelope, {
    label: 'transport-lost-effect-receipt',
    stepId,
  });
  await commitExecutionCallWithoutDeliveredResponse(
    'record_execution_effect_receipt',
    lostReceiptFact,
    `EXISTS (
  SELECT 1 FROM public.run_side_effect_receipts
  WHERE workspace_id = '${ids.workspace}'
    AND envelope_id = '${lostEnvelope.envelope_id}'
)`,
    'effect receipt post-commit response loss',
  );
  const lostReceipt = JSON.parse(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT jsonb_build_object(
  'receipt_id', id,
  'receipt_sha256', receipt_sha256
)::text
FROM public.run_side_effect_receipts
WHERE workspace_id = '${ids.workspace}'
  AND envelope_id = '${lostEnvelope.envelope_id}';`,
    ),
  );
  return { lostEnvelope, lostEnvelopeFact, lostReceipt, lostReceiptFact };
}

async function assertEffectResponseLossReplayAfterAuthorityLoss(evidence, stage) {
  const before = await runtimeDigest();
  const envelopeReplay = assertExecutionEffectEnvelopeProjection(
    await phaseJsonCall('execution', 'record_execution_effect_envelope', evidence.lostEnvelopeFact),
    `${stage} response-loss envelope replay`,
  );
  const receiptReplay = assertExecutionEffectReceiptProjection(
    await phaseJsonCall('execution', 'record_execution_effect_receipt', evidence.lostReceiptFact),
    `${stage} response-loss receipt replay`,
  );
  assertEqual(
    `${envelopeReplay.envelope_id}|${envelopeReplay.envelope_sha256}|${String(envelopeReplay.replayed)}|${receiptReplay.receipt_id}|${receiptReplay.receipt_sha256}|${String(receiptReplay.replayed)}`,
    `${evidence.lostEnvelope.envelope_id}|${evidence.lostEnvelope.envelope_sha256}|true|${evidence.lostReceipt.receipt_id}|${evidence.lostReceipt.receipt_sha256}|true`,
    `old producer tuple first-pass replays both committed effect facts ${stage}`,
  );
  assertEqual(
    await runtimeDigest(),
    before,
    `${stage} effect response-loss replay creates no duplicate envelope or receipt`,
  );
}

async function assertLeasedExecutionWrites(authority) {
  const baseAuthority = {
    attempt_id: ids.attempt,
    lease_fencing_token: authority.lease_fencing_token,
    lease_token: authority.lease_token,
    run_id: ids.run,
  };
  const rejectedDigest = await runtimeDigest();
  await assertPsqlRejected(
    executionOtherAttestation.login,
    establishWithAttestationSql(
      executionOtherAttestation,
      'execution',
      `SELECT app.renew_run_attempt_lease(${jsonb({
        ...baseAuthority,
        duration_seconds: 30,
      })});`,
    ),
    /owned by another session_user|42501/u,
    'same-phase second login cannot steal a complete token/fence tuple',
    { scanFor: [executionOtherAttestation.rawSecret] },
  );
  await assertPhaseRejected(
    'execution',
    `SELECT app.record_execution_checkpoint(${jsonb({
      ...baseAuthority,
      checkpoint_ref: 'fixture://g007/pre-step',
      checkpoint_sha256: hash('g007-pre-step-checkpoint'),
      payload_redacted: {},
      step_id: fixtureUuid(997),
    })});`,
    /does not bind the requested Step|23503/u,
    'leased checkpoint rejects a mixed Step tuple',
  );
  await assertPhaseRejected(
    'execution',
    `SELECT app.record_attempt_started(${jsonb({
      ...baseAuthority,
      lease_fencing_token: '2',
    })});`,
    /missing, stale, expired or owned|42501/u,
    'leased mutation rejects a mismatched fencing token',
  );
  await assertPhaseRejected(
    'execution',
    `SELECT app.record_attempt_started(${jsonb({
      ...baseAuthority,
      workspace_id: ids.workspace,
    })});`,
    /authority shape is invalid|22023/u,
    'phase façade rejects caller-selected Workspace authority',
  );
  assertEqual(
    await runtimeDigest(),
    rejectedDigest,
    'stolen, mixed and caller-selected authority attacks have zero durable side effects',
  );

  // This branch deliberately executes many serial, concurrent and response-loss
  // probes before it seals the Run. Renew to the public maximum so harness speed
  // cannot turn those probes into an accidental expiry test.
  await phaseJsonCall('execution', 'renew_run_attempt_lease', {
    ...baseAuthority,
    duration_seconds: 300,
  });

  await phaseJsonCall('execution', 'record_attempt_started', baseAuthority);
  await phaseJsonCall('execution', 'record_step_started', {
    ...baseAuthority,
    input_hash: hash('g007-step-input'),
    step_id: ids.step,
    step_key: 'primary-model-call',
  });
  const terminationFact = {
    ...baseAuthority,
    billing_close_intent_redacted: {
      intended_release_amount: '15',
      intended_settle_amount: '5',
    },
    producer_operation_key: 'g007:primary:termination',
    reservation_id: ids.reservation,
    step_id: ids.step,
    terminal_kind: 'FAILED',
    termination_reason: 'INTERNAL_FAILURE',
  };
  const zeroEnvelopeDigest = await runtimeDigest();
  await assertPhaseRejected(
    'execution',
    `SELECT app.record_leased_termination_intent(${jsonb(terminationFact)});`,
    /termination attribution requires a CLOSED effect envelope set/u,
    'zero-envelope Attempt cannot mint a termination attribution',
  );
  assertEqual(
    await runtimeDigest(),
    zeroEnvelopeDigest,
    'rejected zero-envelope termination leaves no stale closure or billing source behind',
  );
  const effectSeam = await assertEffectPersistenceSeams(baseAuthority, ids.step);
  const effect = await recordCompletedExecutionEffect(baseAuthority, {
    effectClass: 'SAFE',
    externalReceiptRef: 'fixture://g007/effect/result',
    label: 'primary-effect',
    stepId: ids.step,
  });
  const trimBoundaryDigest = await runtimeDigest();
  for (const { label, value } of ecmaScriptTrimOnlyValues) {
    for (const [functionName, fact, expectedPattern, field] of [
      [
        'record_execution_checkpoint',
        {
          ...baseAuthority,
          checkpoint_ref: value,
          checkpoint_sha256: hash(`g007-trim-checkpoint:${label}`),
          payload_redacted: {},
          step_id: ids.step,
        },
        /execution checkpoint fact shape is invalid|22023/u,
        'checkpoint ref',
      ],
      [
        'record_execution_effect_envelope',
        executionEffectEnvelopeFact(baseAuthority, {
          effectClass: 'REQUIRES_KEY',
          label: `g007-trim-operation-key:${label}`,
          operationKey: value,
          stepId: ids.step,
        }),
        /execution effect envelope fact shape is invalid|22023/u,
        'operation key',
      ],
      [
        'record_execution_effect_receipt',
        executionEffectReceiptFact(
          baseAuthority,
          {
            envelope_sha256: hash(`g007-trim-external-ref-envelope:${label}`),
            retry_effect_envelope_id: fixtureUuid(993),
          },
          {
            externalReceiptRef: value,
            label: `g007-trim-external-ref:${label}`,
            stepId: ids.step,
          },
        ),
        /execution effect receipt is invalid|22023/u,
        'external receipt ref',
      ],
      [
        'record_execution_effect_receipt',
        executionEffectReceiptFact(
          baseAuthority,
          {
            envelope_sha256: hash(`g007-trim-unknown-reason-envelope:${label}`),
            retry_effect_envelope_id: fixtureUuid(993),
          },
          {
            label: `g007-trim-unknown-reason:${label}`,
            outcome: 'UNKNOWN',
            stepId: ids.step,
            unknownReasonCode: value,
          },
        ),
        /execution effect receipt is invalid|22023/u,
        'unknown reason code',
      ],
      [
        'record_usage_attribution',
        {
          ...baseAuthority,
          amount: '0',
          detail_redacted: {},
          metering_unit: 'fixture_token',
          producer_operation_key: value,
          quantity: '0',
          reservation_id: ids.reservation,
          step_id: ids.step,
        },
        /usage attribution values are invalid|22023/u,
        'producer operation key',
      ],
      [
        'record_usage_attribution',
        {
          ...baseAuthority,
          amount: '0',
          detail_redacted: {},
          metering_unit: value,
          producer_operation_key: `g007:trim-metering-unit:${label}`,
          quantity: '0',
          reservation_id: ids.reservation,
          step_id: ids.step,
        },
        /usage attribution values are invalid|22023/u,
        'metering unit',
      ],
    ]) {
      await assertPhaseRejected(
        'execution',
        `SELECT app.${functionName}(${jsonb(fact)});`,
        expectedPattern,
        `${label}-only ${field} is rejected at the PostgreSQL execution façade`,
      );
    }
  }
  assertEqual(
    await runtimeDigest(),
    trimBoundaryDigest,
    'ECMAScript-only whitespace rejection leaves execution and billing facts unchanged',
  );
  const checkpoint = assertExecutionCheckpointProjection(
    await phaseJsonCall('execution', 'record_execution_checkpoint', {
      ...baseAuthority,
      checkpoint_ref: 'fixture://g007/checkpoint',
      checkpoint_sha256: hash('g007-checkpoint'),
      payload_redacted: { cursor: 'after-effect' },
      step_id: ids.step,
    }),
    'primary execution checkpoint',
  );
  const usageFact = {
    ...baseAuthority,
    amount: '5',
    detail_redacted: { provider: 'fixture' },
    metering_unit: 'fixture_token',
    producer_operation_key: 'g007:primary:usage',
    quantity: '5',
    reservation_id: ids.reservation,
    step_id: ids.step,
  };
  const freshOverflowDigest = await runtimeDigest();
  await assertPhaseRejected(
    'execution',
    `SELECT app.record_usage_attribution((${jsonb({
      ...usageFact,
      producer_operation_key: 'g007:primary:usage:overflow:fresh',
    })} || '{"detail_redacted":{"nested":[{"overflow":1e1000}]}}'::jsonb));`,
    /ERROR:\s+22023:\s+usage attribution values are invalid/u,
    'fresh usage attribution rejects a recursively nested positive JavaScript overflow from raw JSON',
  );
  assertEqual(
    await runtimeDigest(),
    freshOverflowDigest,
    'fresh raw-JSON overflow rejection leaves execution and billing facts unchanged',
  );
  for (const [label, override] of [
    ['numeric amount', { amount: 5 }],
    ['leading-zero amount', { amount: '05' }],
    ['numeric quantity', { quantity: 5 }],
  ]) {
    const before = await runtimeDigest();
    await assertPhaseRejected(
      'execution',
      `SELECT app.record_usage_attribution(${jsonb({
        ...usageFact,
        ...override,
        producer_operation_key: `g007:primary:usage:invalid:${label.replaceAll(' ', '-')}`,
      })});`,
      /usage attribution values are invalid|22023/u,
      `usage attribution rejects ${label} instead of normalizing a billing amount`,
    );
    assertEqual(
      await runtimeDigest(),
      before,
      `usage attribution ${label} rejection has zero durable mutation`,
    );
  }
  const usageRace = await concurrentExecutionJsonCall(
    'record_usage_attribution',
    usageFact,
    'usage attribution same-fact miss',
  );
  const usage = assertUsageAttributionProjection(
    usageRace.winner,
    'usage attribution concurrent winner',
  );
  const usageConcurrentReplay = assertUsageAttributionProjection(
    usageRace.loser,
    'usage attribution concurrent replay',
  );
  assertEqual(
    `${usage.source.usage_attribution_id}|${usage.source_authority_hash}|${usage.source.authorized_at}|${String(usage.replayed)}|${usageConcurrentReplay.source.usage_attribution_id}|${usageConcurrentReplay.source_authority_hash}|${usageConcurrentReplay.source.authorized_at}|${String(usageConcurrentReplay.replayed)}`,
    `${usage.source.usage_attribution_id}|${usage.source_authority_hash}|${usage.source.authorized_at}|false|${usage.source.usage_attribution_id}|${usage.source_authority_hash}|${usage.source.authorized_at}|true`,
    'usage attribution race commits one source and returns an exact replay after winner commit',
  );
  const usageSerialReplay = assertUsageAttributionProjection(
    await phaseJsonCall('execution', 'record_usage_attribution', usageFact),
    'usage attribution serial replay',
  );
  assertEqual(
    `${usageSerialReplay.source.usage_attribution_id}|${usageSerialReplay.source_authority_hash}|${String(usageSerialReplay.replayed)}`,
    `${usage.source.usage_attribution_id}|${usage.source_authority_hash}|true`,
    'usage attribution serial retry returns the original source',
  );
  const replayOverflowDigest = await runtimeDigest();
  await assertPhaseRejected(
    'execution',
    `SELECT app.record_usage_attribution((${jsonb(usageFact)} || '{"detail_redacted":{"nested":[{"overflow":-1e1000}]}}'::jsonb));`,
    /ERROR:\s+22023:\s+usage attribution values are invalid/u,
    'committed usage replay rejects a recursively nested negative JavaScript overflow from raw JSON before replay',
  );
  assertEqual(
    await runtimeDigest(),
    replayOverflowDigest,
    'committed raw-JSON overflow replay rejection leaves the source and runtime digest unchanged',
  );
  const crossProducerUsageReplayDigest = await runtimeDigest();
  await assertAttestedRejected(
    executionOtherAttestation,
    'execution',
    'record_usage_attribution',
    usageFact,
    /committed usage producer replay belongs to another session_user|42501/u,
    'same-phase second login cannot replay another producer session usage response',
  );
  assertEqual(
    await runtimeDigest(),
    crossProducerUsageReplayDigest,
    'cross-producer usage replay rejection leaves the committed source unchanged',
  );
  const usageConflictDigest = await runtimeDigest();
  await assertPhaseRejected(
    'execution',
    `SELECT app.record_usage_attribution(${jsonb({ ...usageFact, amount: '6' })});`,
    /producer operation key conflicts|23505/u,
    'usage producer operation key rejects a different billing fact',
  );
  assertEqual(
    await runtimeDigest(),
    usageConflictDigest,
    'different usage fact under a committed producer key has zero mutation',
  );
  const callerTimeoutDigest = await runtimeDigest();
  await assertPhaseRejected(
    'execution',
    `SELECT app.record_leased_termination_intent(${jsonb({
      ...baseAuthority,
      billing_close_intent_redacted: {},
      producer_operation_key: 'g007:primary:invalid-timeout',
      reservation_id: ids.reservation,
      step_id: ids.step,
      terminal_kind: 'TIMED_OUT',
      termination_reason: 'RUN_TIMED_OUT',
    })});`,
    /lacks durable protocol-v5 authority|22023/u,
    'caller-reported timeout cannot mint a leased terminal authority source',
  );
  assertEqual(
    await runtimeDigest(),
    callerTimeoutDigest,
    'caller timeout rejection leaves execution and billing sources unchanged',
  );
  const terminationRace = await concurrentExecutionJsonCall(
    'record_leased_termination_intent',
    terminationFact,
    'termination attribution same-fact miss',
  );
  const termination = assertTerminationIntentProjection(
    terminationRace.winner,
    'termination attribution concurrent winner',
  );
  const terminationConcurrentReplay = assertTerminationIntentProjection(
    terminationRace.loser,
    'termination attribution concurrent replay',
  );
  assertEqual(
    `${termination.intent.termination_intent_id}|${termination.source_authority_hash}|${termination.intent.authorized_at}|${String(termination.replayed)}|${terminationConcurrentReplay.intent.termination_intent_id}|${terminationConcurrentReplay.source_authority_hash}|${terminationConcurrentReplay.intent.authorized_at}|${String(terminationConcurrentReplay.replayed)}`,
    `${termination.intent.termination_intent_id}|${termination.source_authority_hash}|${termination.intent.authorized_at}|false|${termination.intent.termination_intent_id}|${termination.source_authority_hash}|${termination.intent.authorized_at}|true`,
    'termination attribution race commits one intent and returns an exact replay after winner commit',
  );
  const terminationSerialReplay = assertTerminationIntentProjection(
    await phaseJsonCall('execution', 'record_leased_termination_intent', terminationFact),
    'termination attribution serial replay',
  );
  assertEqual(
    `${terminationSerialReplay.intent.termination_intent_id}|${terminationSerialReplay.source_authority_hash}|${String(terminationSerialReplay.replayed)}`,
    `${termination.intent.termination_intent_id}|${termination.source_authority_hash}|true`,
    'termination attribution serial retry returns the original immutable intent',
  );
  const crossProducerTerminationReplayDigest = await runtimeDigest();
  await assertAttestedRejected(
    executionOtherAttestation,
    'execution',
    'record_leased_termination_intent',
    terminationFact,
    /committed termination producer replay belongs to another session_user|42501/u,
    'same-phase second login cannot replay another producer session termination response',
  );
  assertEqual(
    await runtimeDigest(),
    crossProducerTerminationReplayDigest,
    'cross-producer termination replay rejection leaves the committed intent unchanged',
  );
  const terminationConflictDigest = await runtimeDigest();
  await assertPhaseRejected(
    'execution',
    `SELECT app.record_leased_termination_intent(${jsonb({
      ...terminationFact,
      billing_close_intent_redacted: {
        intended_release_amount: 15,
        intended_settle_amount: 5,
      },
    })});`,
    /producer operation conflicts|23505/u,
    'termination producer operation key rejects a differently encoded financial request',
  );
  assertEqual(
    await runtimeDigest(),
    terminationConflictDigest,
    'different termination fact under a committed producer key has zero mutation',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.run_usage_attributions
     WHERE workspace_id = '${ids.workspace}' AND run_id = '${ids.run}'
       AND producer_operation_key = '${usageFact.producer_operation_key}'),
  (SELECT count(*) FROM public.run_termination_intents
     WHERE workspace_id = '${ids.workspace}' AND run_id = '${ids.run}'
       AND producer_operation_key = '${terminationFact.producer_operation_key}')
);`,
    ),
    '1|1',
    'concurrent and serial retries persist exactly one usage source and one termination intent',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT status || ':' || execution_status || ':' || last_event_sequence
     FROM public.runs WHERE workspace_id = '${ids.workspace}' AND id = '${ids.run}'),
  (SELECT status || ':' || step_key FROM public.run_steps
     WHERE workspace_id = '${ids.workspace}' AND id = '${ids.step}'),
  (SELECT producer_session_user || ':' || producer_lease_fencing_token
     FROM public.run_checkpoints WHERE workspace_id = '${ids.workspace}'
       AND id = '${checkpoint.checkpoint_id}'),
  (SELECT effect_class || ':' || disposition
     FROM public.run_retry_effect_envelopes AS envelope
     JOIN public.run_side_effect_receipts AS receipt
       ON receipt.workspace_id = envelope.workspace_id AND receipt.envelope_id = envelope.id
     WHERE envelope.workspace_id = '${ids.workspace}' AND envelope.id = '${effect.envelope_id}'),
  (SELECT producer_session_user || ':' || producer_lease_fencing_token || ':' || amount
     FROM public.run_usage_attributions WHERE workspace_id = '${ids.workspace}'
       AND id = '${usage.source.usage_attribution_id}'),
  (SELECT producer_session_user || ':' || producer_lease_fencing_token || ':' || effect_disposition
     FROM public.run_termination_intents WHERE workspace_id = '${ids.workspace}'
       AND id = '${termination.intent.termination_intent_id}')
);`,
    ),
    'RUNNING:RUNNING:2|RUNNING:primary-model-call|ba_execution_test:1|safe:CONFIRMED|ba_execution_test:1:5|ba_execution_test:1:CLOSED',
    'independent readback binds progress, effect, checkpoint and billing sources to lease N',
  );
  const effectClosure = await readAttemptEffectClosure(ids.run, ids.attempt);
  assertEqual(
    effectClosure.effect_closure_sha256,
    termination.intent.effect_closure_sha256,
    'independent Node digest of locked effect facts matches the durable termination source',
  );
  const sealedClosureDigest = await runtimeDigest();
  await assertPhaseRejected(
    'execution',
    `SELECT app.record_execution_effect_envelope(${jsonb({
      ...baseAuthority,
      effect_class: 'SAFE',
      effect_payload_sha256: hash('g007-effect-after-termination:effect-payload'),
      operation_intent_sha256: hash('g007-effect-after-termination:operation-intent'),
      step_id: ids.step,
    })});`,
    /Run is not executable under this phase proof/u,
    'committed termination attribution seals the effect set against closure drift',
  );
  assertEqual(
    await runtimeDigest(),
    sealedClosureDigest,
    'post-termination effect rejection preserves the committed closure and source hashes',
  );
  const sealedAttempt = fixtureUuid(990);
  const sealedPendingDispatch = fixtureUuid(991);
  const sealedLeasedDispatch = fixtureUuid(992);
  const sealedDispatchToken = fixtureUuid(989);
  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
INSERT INTO public.run_attempts (
  workspace_id, id, run_id, attempt_number, status,
  runtime_protocol_version, lease_generation
) VALUES (
  '${ids.workspace}', '${sealedAttempt}', '${ids.run}', 2, 'PENDING', 5, 0
);
INSERT INTO public.outbox (
  workspace_id, id, run_id, message_type, dedupe_key, payload_ref,
  payload_hash, producer_fencing_token, payload_redacted, status,
  available_at, created_at, delivery_protocol_version, delivery_generation,
  lease_owner, lease_token, lease_fencing_token, lease_expires_at
) VALUES
(
  '${ids.workspace}', '${sealedPendingDispatch}', '${ids.run}', 'RUN_DISPATCH',
  'g007-sealed-pending-dispatch', 'fixture://g007/sealed/pending-dispatch',
  '${hash('g007-sealed-pending-dispatch')}', 1, jsonb_build_object('run_id', '${ids.run}'),
  'PENDING', clock_timestamp(), clock_timestamp(), 5, 0, NULL, NULL, NULL, NULL
),
(
  '${ids.workspace}', '${sealedLeasedDispatch}', '${ids.run}', 'RUN_DISPATCH',
  'g007-sealed-leased-dispatch', 'fixture://g007/sealed/leased-dispatch',
  '${hash('g007-sealed-leased-dispatch')}', 1, jsonb_build_object('run_id', '${ids.run}'),
  'LEASED', clock_timestamp(), clock_timestamp(), 5, 1,
  'ba_execution_test', '${sealedDispatchToken}', 1, clock_timestamp() + interval '1 hour'
);
COMMIT;`,
  );
  const sealedAuthorityDigest = await runtimeDigest();
  await assertPhaseRejected(
    'execution',
    `SELECT app.claim_run_attempt(${jsonb({
      attempt_id: sealedAttempt,
      duration_seconds: 30,
      run_id: ids.run,
    })});`,
    /Run cannot admit a new execution lease|55000/u,
    'committed termination attribution rejects a new Attempt authority',
  );
  await assertPhaseRejected(
    'execution',
    `SELECT app.claim_run_dispatch(${jsonb({
      duration_seconds: 30,
      outbox_id: sealedPendingDispatch,
      run_id: ids.run,
    })});`,
    /Run cannot admit a RUN_DISPATCH lease|55000/u,
    'committed termination attribution rejects a new dispatch authority',
  );
  await assertPhaseRejected(
    'execution',
    `SELECT app.renew_run_dispatch_lease(${jsonb({
      duration_seconds: 30,
      lease_fencing_token: '1',
      lease_token: sealedDispatchToken,
      outbox_id: sealedLeasedDispatch,
      run_id: ids.run,
    })});`,
    /Run is unavailable for RUN_DISPATCH mutation|55000/u,
    'committed termination attribution seals an already-issued dispatch authority',
  );
  assertEqual(
    await runtimeDigest(),
    sealedAuthorityDigest,
    'sealed Attempt and dispatch authority attacks leave all durable facts unchanged',
  );
  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
DELETE FROM public.outbox
WHERE workspace_id = '${ids.workspace}'
  AND id IN ('${sealedPendingDispatch}', '${sealedLeasedDispatch}');
DELETE FROM public.run_attempts
WHERE workspace_id = '${ids.workspace}' AND id = '${sealedAttempt}';
COMMIT;`,
  );
  return {
    baseAuthority,
    checkpoint,
    effect,
    effectClosure,
    effectSeam,
    termination,
    terminationFact,
    usage,
    usageFact,
  };
}

async function assertCrossAttemptRecoveryCheckpointRejected(executionArtifacts) {
  const foreignAttempt = fixtureUuid(980);
  const foreignCheckpoint = fixtureUuid(981);
  const foreignCheckpointToken = fixtureUuid(982);
  const foreignCheckpointHash = hash('g007-cross-attempt-recovery-checkpoint');
  const seedForeignCheckpoint = `SET LOCAL session_replication_role = replica;
INSERT INTO public.run_checkpoints (
  workspace_id, id, run_id, step_id, checkpoint_hash, payload_ref,
  payload_redacted, created_at, producer_attempt_id, producer_lease_token,
  producer_lease_fencing_token, producer_session_user,
  producer_lease_expires_at, authorized_at, checkpoint_sequence,
  runtime_protocol_version
) VALUES (
  '${ids.workspace}', '${foreignCheckpoint}', '${ids.run}', '${ids.step}',
  '${foreignCheckpointHash}', 'fixture://g007/cross-attempt-checkpoint', '{}'::jsonb,
  clock_timestamp(), '${foreignAttempt}', '${foreignCheckpointToken}', 1,
  'ba_execution_other_test', clock_timestamp() + interval '1 hour',
  clock_timestamp(), 9007199254740990, 5
);
SET LOCAL session_replication_role = origin;`;
  const before = await runtimeDigest();
  await assertPsqlRejected(
    'ba_bootstrap_test',
    `BEGIN;
${seedForeignCheckpoint}
WITH decisions AS (
  SELECT app.g007_attempt_recovery_effect_decisions(
    '${ids.workspace}', '${ids.run}', '${ids.attempt}'
  ) AS value
)
INSERT INTO public.run_recovery_tickets (
  workspace_id, id, run_id, resource_kind, resource_id, old_generation,
  fenced_generation, checkpoint_id, checkpoint_sha256, effect_decisions,
  effect_decisions_sha256, ticket_sha256, created_at
)
SELECT '${ids.workspace}', '${fixtureUuid(983)}', '${ids.run}', 'ATTEMPT', '${ids.attempt}',
  1, 2, '${foreignCheckpoint}', '${foreignCheckpointHash}', value,
  app.g007_sha256(
    'better-agent/run-recovery-effect-decision-set/1',
    jsonb_build_object(
      'schema_version', 'run-recovery-effect-decision-set/1',
      'effect_decisions', value
    )::text
  ),
  '${hash('g007-cross-attempt-recovery-ticket')}', clock_timestamp()
FROM decisions;
COMMIT;`,
    /recovery checkpoint binding is unavailable|23514/u,
    'Attempt recovery ticket rejects a checkpoint produced by another Attempt in the same Run',
  );
  assertEqual(
    await runtimeDigest(),
    before,
    'cross-Attempt recovery ticket rejection leaves checkpoints, tickets and runtime state unchanged',
  );
  await assertPsqlRejected(
    'ba_bootstrap_test',
    `BEGIN;
${seedForeignCheckpoint}
INSERT INTO public.run_recovery_hold_intents (
  workspace_id, id, run_id, resource_kind, resource_id,
  old_generation, fenced_generation, hold_reason,
  effect_closure_disposition, effect_closure_sha256,
  hold_evidence_sha256, checkpoint_id, checkpoint_sha256, created_at
) VALUES (
  '${ids.workspace}', '${fixtureUuid(984)}', '${ids.run}', 'ATTEMPT', '${ids.attempt}',
  1, 2, 'EFFECT_CLOSURE_OPEN', 'OPEN',
  '${executionArtifacts.effectClosure.effect_closure_sha256}',
  '${hash('g007-cross-attempt-recovery-hold')}',
  '${foreignCheckpoint}', '${foreignCheckpointHash}', clock_timestamp()
);
COMMIT;`,
    /recovery checkpoint binding is unavailable|23514/u,
    'Attempt recovery HOLD rejects a checkpoint produced by another Attempt in the same Run',
  );
  assertEqual(
    await runtimeDigest(),
    before,
    'cross-Attempt recovery HOLD rejection leaves checkpoints, HOLDs and runtime state unchanged',
  );
}

async function meteringFirstScenarioDigest() {
  return harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT encode(public.digest(convert_to(jsonb_build_object(
  'workspace', (SELECT to_jsonb(fact) FROM public.workspaces AS fact
    WHERE fact.id = '${ids.otherWorkspace}'),
  'run', (SELECT to_jsonb(fact) FROM public.runs AS fact
    WHERE fact.workspace_id = '${ids.otherWorkspace}' AND fact.id = '${ids.meteringFirstRun}'),
  'attempt', (SELECT to_jsonb(fact) FROM public.run_attempts AS fact
    WHERE fact.workspace_id = '${ids.otherWorkspace}'
      AND fact.id = '${ids.meteringFirstAttempt}'),
  'reservation', (SELECT to_jsonb(fact) FROM public.credit_reservations AS fact
    WHERE fact.workspace_id = '${ids.otherWorkspace}'
      AND fact.id = '${ids.meteringFirstReservation}'),
  'steps', (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id), '[]')
    FROM public.run_steps AS fact WHERE fact.workspace_id = '${ids.otherWorkspace}'),
  'events', (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id), '[]')
    FROM public.run_events AS fact WHERE fact.workspace_id = '${ids.otherWorkspace}'),
  'envelopes', (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id), '[]')
    FROM public.run_retry_effect_envelopes AS fact
    WHERE fact.workspace_id = '${ids.otherWorkspace}'),
  'effect_receipts', (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id), '[]')
    FROM public.run_side_effect_receipts AS fact
    WHERE fact.workspace_id = '${ids.otherWorkspace}'),
  'usage', (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id), '[]')
    FROM public.run_usage_attributions AS fact
    WHERE fact.workspace_id = '${ids.otherWorkspace}'),
  'termination', (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id), '[]')
    FROM public.run_termination_intents AS fact
    WHERE fact.workspace_id = '${ids.otherWorkspace}'),
  'billing_receipts', (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id), '[]')
    FROM public.run_billing_authority_receipts AS fact
    WHERE fact.workspace_id = '${ids.otherWorkspace}'),
  'ledger', (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id), '[]')
    FROM public.credits_ledger AS fact WHERE fact.workspace_id = '${ids.otherWorkspace}'),
  'audit', (SELECT COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id), '[]')
    FROM public.phase_operation_audit AS fact
    WHERE fact.workspace_id = '${ids.otherWorkspace}')
)::text, 'UTF8'), 'sha256'), 'hex');`,
  );
}

async function assertMeteringFirstFullSettlementThenTermination() {
  const largeCreditAmount = '9007199254740993';
  const execution = Object.freeze({
    binding: randomBytes(32).toString('hex'),
    id: fixtureUuid(325),
    login: 'ba_execution_test',
    phase: 'execution',
    rawSecret: randomBytes(32).toString('hex'),
    workspace: ids.otherWorkspace,
  });
  const metering = Object.freeze({
    binding: randomBytes(32).toString('hex'),
    id: fixtureUuid(326),
    login: 'ba_metering_test',
    phase: 'metering',
    rawSecret: randomBytes(32).toString('hex'),
    workspace: ids.otherWorkspace,
  });
  await issueAttestation(execution);
  await issueAttestation(metering);
  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
SET LOCAL session_replication_role = replica;
UPDATE public.workspaces
SET credits_balance = 995, credits_reserved_balance = ${largeCreditAmount},
    credits_balance_version = 1,
    updated_at = clock_timestamp()
WHERE id = '${ids.otherWorkspace}';
INSERT INTO public.runs (
  workspace_id, id, billing_owner_run_id, accepted_request_id,
  accepted_principal_kind, accepted_credential_id, fixed_route,
  intent_hash, admission_snapshot_hash, accepted_plan_hash,
  accepted_output_schema_ref, accepted_output_schema_hash, dependency_pins_hash,
  target_kind, flow_deployment_id, flow_deployment_revision_id, flow_id, flow_version_id,
  status, execution_status, billing_state, acceptance_receipt_data_redacted,
  last_event_sequence
) VALUES (
  '${ids.otherWorkspace}', '${ids.meteringFirstRun}', '${ids.meteringFirstRun}',
  '${ids.meteringFirstAcceptedRequest}', 'credential', '${ids.credential}',
  '/v1/oapi/flow/run', '${hash('g007-metering-first-intent')}',
  '${hash('g007-metering-first-admission')}', '${hash('g007-metering-first-plan')}',
  'schema://g007/flow-output', '${hash('g007-metering-first-output')}',
  '${hash('g007-metering-first-dependencies')}', 'flow', '${ids.flowDeployment}',
  '${ids.flowRevision}', '${ids.flow}', '${ids.flowVersion}', 'QUEUED', 'QUEUED', 'PENDING',
  jsonb_build_object('run_id', '${ids.meteringFirstRun}', 'status', 'QUEUED'), 0
);
INSERT INTO public.run_attempts (
  workspace_id, id, run_id, attempt_number, status, runtime_protocol_version, lease_generation
) VALUES (
  '${ids.otherWorkspace}', '${ids.meteringFirstAttempt}', '${ids.meteringFirstRun}',
  1, 'PENDING', 5, 0
);
INSERT INTO public.credit_reservations (
  workspace_id, id, run_id, billing_owner_run_id, accepted_plan_hash,
  status, reserved_credits, settled_credits, released_credits, balance_version,
  expires_at, created_at, updated_at
) VALUES (
  '${ids.otherWorkspace}', '${ids.meteringFirstReservation}', '${ids.meteringFirstRun}',
  '${ids.meteringFirstRun}', '${hash('g007-metering-first-plan')}', 'HELD',
  ${largeCreditAmount}, 0, 0, 1,
  clock_timestamp() + interval '1 hour', clock_timestamp(), clock_timestamp()
);
COMMIT;`,
  );

  const authority = await attestedJsonCall(execution, 'execution', 'claim_run_attempt', {
    attempt_id: ids.meteringFirstAttempt,
    duration_seconds: 120,
    run_id: ids.meteringFirstRun,
  });
  const baseAuthority = {
    attempt_id: ids.meteringFirstAttempt,
    lease_fencing_token: authority.lease_fencing_token,
    lease_token: authority.lease_token,
    run_id: ids.meteringFirstRun,
  };
  await attestedJsonCall(execution, 'execution', 'record_attempt_started', baseAuthority);
  await attestedJsonCall(execution, 'execution', 'record_step_started', {
    ...baseAuthority,
    input_hash: hash('g007-metering-first-step-input'),
    step_id: ids.meteringFirstStep,
    step_key: 'metering-first-full-settlement',
  });
  const envelope = assertExecutionEffectEnvelopeProjection(
    await attestedJsonCall(
      execution,
      'execution',
      'record_execution_effect_envelope',
      executionEffectEnvelopeFact(baseAuthority, {
        effectClass: 'SAFE',
        label: 'g007-metering-first-effect',
        stepId: ids.meteringFirstStep,
      }),
    ),
    'metering-first effect envelope',
  );
  assertExecutionEffectReceiptProjection(
    await attestedJsonCall(
      execution,
      'execution',
      'record_execution_effect_receipt',
      executionEffectReceiptFact(baseAuthority, envelope, {
        externalReceiptRef: 'fixture://g007/metering-first/effect',
        label: 'g007-metering-first-effect',
        stepId: ids.meteringFirstStep,
      }),
    ),
    'metering-first effect receipt',
  );
  const usageFact = {
    ...baseAuthority,
    amount: largeCreditAmount,
    detail_redacted: { order: 'metering-first' },
    metering_unit: 'fixture_credit',
    producer_operation_key: 'g007:metering-first:usage',
    quantity: '5',
    reservation_id: ids.meteringFirstReservation,
    step_id: ids.meteringFirstStep,
  };
  const usage = assertUsageAttributionProjection(
    await attestedJsonCall(execution, 'execution', 'record_usage_attribution', usageFact),
    'metering-first usage attribution',
  );
  const terminationFact = {
    ...baseAuthority,
    billing_close_intent_redacted: {
      intended_release_amount: '0',
      intended_settle_amount: largeCreditAmount,
    },
    producer_operation_key: 'g007:metering-first:termination',
    reservation_id: ids.meteringFirstReservation,
    step_id: ids.meteringFirstStep,
    terminal_kind: 'FAILED',
    termination_reason: 'INTERNAL_FAILURE',
  };

  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
SET LOCAL session_replication_role = replica;
UPDATE public.run_usage_attributions
SET consumed_at = clock_timestamp(), consumption_generation = 2
WHERE workspace_id = '${ids.otherWorkspace}' AND id = '${usage.source.usage_attribution_id}';
UPDATE public.credit_reservations
SET status = 'SETTLED', settled_credits = ${largeCreditAmount},
    settled_at = statement_timestamp(),
    updated_at = statement_timestamp()
WHERE workspace_id = '${ids.otherWorkspace}' AND id = '${ids.meteringFirstReservation}';
COMMIT;`,
  );
  const missingReceiptDigest = await meteringFirstScenarioDigest();
  await assertAttestedRejected(
    execution,
    'execution',
    'record_leased_termination_intent',
    terminationFact,
    /closed reservation usage lacks an exact durable settlement receipt|55000/u,
    'closed reservation rejects a consumed usage source with no billing receipt',
  );
  assertEqual(
    await meteringFirstScenarioDigest(),
    missingReceiptDigest,
    'missing-receipt termination rejection leaves the isolated scenario unchanged',
  );
  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
SET LOCAL session_replication_role = replica;
UPDATE public.run_usage_attributions
SET consumed_at = NULL, consumption_generation = 1
WHERE workspace_id = '${ids.otherWorkspace}' AND id = '${usage.source.usage_attribution_id}';
UPDATE public.credit_reservations
SET status = 'HELD', settled_credits = 0, settled_at = NULL, updated_at = clock_timestamp()
WHERE workspace_id = '${ids.otherWorkspace}' AND id = '${ids.meteringFirstReservation}';
COMMIT;`,
  );

  const settlementFact = {
    run_id: ids.meteringFirstRun,
    source_authority_hash: usage.source_authority_hash,
    source_id: usage.source.usage_attribution_id,
  };
  const settlement = await attestedJsonCall(
    metering,
    'metering',
    'settle_attributed_credits',
    settlementFact,
  );
  assertEqual(
    `${typeof settlement.amount}|${settlement.amount}|${String(settlement.replayed)}`,
    `string|${largeCreditAmount}|false`,
    'metering-first fixture returns its above-MAX_SAFE_INTEGER settlement as an exact string',
  );
  const settlementReplay = await attestedJsonCall(
    metering,
    'metering',
    'settle_attributed_credits',
    settlementFact,
  );
  assertEqual(
    `${typeof settlementReplay.amount}|${settlementReplay.amount}|${settlementReplay.authority_receipt_id}|${settlementReplay.ledger_entry_id}|${String(settlementReplay.replayed)}`,
    `string|${largeCreditAmount}|${settlement.authority_receipt_id}|${settlement.ledger_entry_id}|true`,
    'above-MAX_SAFE_INTEGER settlement replay returns the original exact amount, receipt and ledger',
  );
  const consumedAt = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT consumed_at::text FROM public.run_usage_attributions
WHERE workspace_id = '${ids.otherWorkspace}' AND id = '${usage.source.usage_attribution_id}';`,
  );
  await harness.psql(
    'ba_bootstrap_test',
    `SET session_replication_role = replica;
UPDATE public.run_usage_attributions
SET consumed_at = NULL
WHERE workspace_id = '${ids.otherWorkspace}' AND id = '${usage.source.usage_attribution_id}';
RESET session_replication_role;`,
  );
  const unconsumedDigest = await meteringFirstScenarioDigest();
  await assertAttestedRejected(
    execution,
    'execution',
    'record_leased_termination_intent',
    terminationFact,
    /closed reservation usage lacks an exact durable settlement receipt|55000/u,
    'closed reservation rejects an unconsumed source despite an exact billing receipt',
  );
  assertEqual(
    await meteringFirstScenarioDigest(),
    unconsumedDigest,
    'unconsumed-source termination rejection leaves the isolated scenario unchanged',
  );
  await harness.psql(
    'ba_bootstrap_test',
    `SET session_replication_role = replica;
UPDATE public.run_usage_attributions
SET consumed_at = ${sqlLiteral(consumedAt)}::timestamptz
WHERE workspace_id = '${ids.otherWorkspace}' AND id = '${usage.source.usage_attribution_id}';
RESET session_replication_role;`,
  );

  const termination = assertTerminationIntentProjection(
    await attestedJsonCall(
      execution,
      'execution',
      'record_leased_termination_intent',
      terminationFact,
    ),
    'termination after full metering settlement',
  );
  assertEqual(
    `${termination.intent.intended_settle_credits}|${termination.intent.intended_release_credits}|${termination.intent.usage_attribution_ids.join(',')}`,
    `${largeCreditAmount}|0|${usage.source.usage_attribution_id}`,
    'closed reservation termination preserves the settled usage set and requests no second movement',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT credits_balance || ':' || credits_reserved_balance || ':' || credits_balance_version
     FROM public.workspaces WHERE id = '${ids.otherWorkspace}'),
  (SELECT status || ':' || settled_credits || ':' || released_credits
     FROM public.credit_reservations WHERE workspace_id = '${ids.otherWorkspace}'
       AND id = '${ids.meteringFirstReservation}'),
  (SELECT count(*) FROM public.run_usage_attributions
     WHERE workspace_id = '${ids.otherWorkspace}' AND run_id = '${ids.meteringFirstRun}'),
  (SELECT count(*) FROM public.run_billing_authority_receipts
     WHERE workspace_id = '${ids.otherWorkspace}' AND run_id = '${ids.meteringFirstRun}'),
  (SELECT count(*) FROM public.credits_ledger
     WHERE workspace_id = '${ids.otherWorkspace}' AND run_id = '${ids.meteringFirstRun}'),
  (SELECT count(*) FROM public.run_termination_intents
     WHERE workspace_id = '${ids.otherWorkspace}' AND run_id = '${ids.meteringFirstRun}')
);`,
    ),
    `995:0:2|SETTLED:${largeCreditAmount}:0|1|1|1|1`,
    'metering-first close produces one usage source, one settlement and one zero-release intent',
  );
}

async function prepareCancelHoldMatrix() {
  const branches = [];
  for (const fixture of holdMatrixFixtures) {
    const authority = await phaseJsonCall('execution', 'claim_run_attempt', {
      attempt_id: fixture.attempt,
      duration_seconds: 30,
      run_id: fixture.run,
    });
    const baseAuthority = {
      attempt_id: fixture.attempt,
      lease_fencing_token: authority.lease_fencing_token,
      lease_token: authority.lease_token,
      run_id: fixture.run,
    };
    await phaseJsonCall('execution', 'record_attempt_started', baseAuthority);
    await phaseJsonCall('execution', 'record_step_started', {
      ...baseAuthority,
      input_hash: hash(`g007-${fixture.label}-input`),
      step_id: fixture.step,
      step_key: fixture.label,
    });
    let effect;
    if (fixture.effect !== 'missing') {
      effect = await recordCompletedExecutionEffect(baseAuthority, {
        effectClass: 'SAFE',
        externalReceiptRef: `fixture://g007/${fixture.label}/effect`,
        label: fixture.label,
        outcome: fixture.effect === 'unknown-receipt' ? 'UNKNOWN' : 'CONFIRMED',
        stepId: fixture.step,
        unknownReasonCode:
          fixture.effect === 'unknown-receipt' ? 'UPSTREAM_RESULT_UNKNOWN' : undefined,
      });
    }
    if (fixture.effect === 'missing' || fixture.effect === 'unknown-receipt') {
      await assertAttemptFinishResponsibilityRejected(
        baseAuthority,
        `${fixture.label} cannot erase unresolved responsibility by finishing its Attempt`,
      );
    }
    if (fixture.effect === 'unknown-receipt') {
      const nonConfirmedDigest = await runtimeDigest();
      await assertPhaseRejected(
        'execution',
        `SELECT app.record_leased_termination_intent(${jsonb({
          ...baseAuthority,
          billing_close_intent_redacted: {},
          producer_operation_key: `g007:${fixture.label}:termination-unknown`,
          reservation_id: fixture.reservation,
          step_id: fixture.step,
          terminal_kind: 'FAILED',
          termination_reason: 'INTERNAL_FAILURE',
        })});`,
        /termination attribution requires a CLOSED effect envelope set/u,
        'UNKNOWN receipt cannot mint a termination attribution',
      );
      assertEqual(
        await runtimeDigest(),
        nonConfirmedDigest,
        'non-CONFIRMED termination rejection preserves the live lease and unresolved receipt',
      );
    }
    let usage;
    if (fixture.usage !== undefined) {
      usage = assertUsageAttributionProjection(
        await phaseJsonCall('execution', 'record_usage_attribution', {
          ...baseAuthority,
          amount: '1',
          detail_redacted: { fixture: fixture.label },
          metering_unit: 'fixture_credit',
          producer_operation_key: `g007:${fixture.label}:usage`,
          quantity: '1',
          reservation_id: fixture.reservation,
          step_id: fixture.step,
        }),
        `${fixture.label} usage attribution`,
      );
    }
    const effectClosure = await readAttemptEffectClosure(
      fixture.run,
      fixture.attempt,
      fixture.closureDisposition,
    );
    if (fixture.effect === 'missing' || fixture.effect === 'unknown-receipt') {
      const beforeRelinquish = await runtimeDigest();
      await assertPhaseRejected(
        'execution',
        `SELECT app.relinquish_run_attempt_lease(${jsonb(baseAuthority)});`,
        /effect closure is not safely relinquishable|55000/u,
        `${fixture.label} cannot erase unresolved responsibility by relinquishing its lease`,
      );
      assertEqual(
        await runtimeDigest(),
        beforeRelinquish,
        `${fixture.label} relinquish rejection preserves its live lease and responsibility facts`,
      );
    }
    branches.push({ authority, baseAuthority, effect, effectClosure, fixture, usage });
  }

  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
SET LOCAL session_replication_role = replica;
${holdMatrixFixtures
  .map(
    (fixture) => `WITH next_event AS (
  UPDATE public.runs
  SET status = 'CANCEL_REQUESTED',
      execution_status = 'CANCELLING',
      last_event_sequence = last_event_sequence + 1
  WHERE workspace_id = '${ids.workspace}' AND id = '${fixture.run}'
  RETURNING last_event_sequence
)
INSERT INTO public.run_events (
  workspace_id, id, run_id, sequence, event_type, dedupe_key,
  payload_redacted, occurred_at
) SELECT
  '${ids.workspace}', '${fixture.cancelEvent}', '${fixture.run}',
  next_event.last_event_sequence, 'RUN_CANCEL_REQUESTED',
  'g007:${fixture.label}:cancel',
  jsonb_build_object('reason', 'USER_CANCELLED'), clock_timestamp()
FROM next_event;`,
  )
  .join('\n')}
COMMIT;`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.runs WHERE workspace_id = '${ids.workspace}'
     AND id = ANY (ARRAY[${holdMatrixFixtures
       .map(({ run }) => sqlLiteral(run))
       .join(', ')}]::uuid[])
     AND status = 'CANCEL_REQUESTED' AND execution_status = 'CANCELLING'),
  (SELECT count(*) FROM public.run_attempts WHERE workspace_id = '${ids.workspace}'
     AND id = ANY (ARRAY[${holdMatrixFixtures
       .map(({ attempt }) => sqlLiteral(attempt))
       .join(', ')}]::uuid[])
     AND status = 'RUNNING' AND lease_owner = 'ba_execution_test'),
  (SELECT count(*) FROM public.run_events WHERE workspace_id = '${ids.workspace}'
     AND id = ANY (ARRAY[${holdMatrixFixtures
       .map(({ cancelEvent }) => sqlLiteral(cancelEvent))
       .join(', ')}]::uuid[]))
);`,
    ),
    '6|6|6',
    'durable cancel facts coexist with six unresolved live Attempt authorities before HOLD fencing',
  );
  return branches;
}

async function prepareRecoveryBranches(dispatchAuthority) {
  const replayAuthority = await phaseJsonCall('execution', 'claim_run_attempt', {
    attempt_id: ids.replayAttempt,
    duration_seconds: 30,
    run_id: ids.replayRun,
  });
  const replayBase = {
    attempt_id: ids.replayAttempt,
    lease_fencing_token: replayAuthority.lease_fencing_token,
    lease_token: replayAuthority.lease_token,
    run_id: ids.replayRun,
  };
  await phaseJsonCall('execution', 'record_attempt_started', replayBase);
  await phaseJsonCall('execution', 'record_step_started', {
    ...replayBase,
    input_hash: hash('g007-replay-input'),
    step_id: ids.replayStep,
    step_key: 'replayable-step',
  });
  const safeMissingEffectSpecification = {
    effectClass: 'SAFE',
    label: 'replay-missing-receipt',
    stepId: ids.replayStep,
  };
  const uppercaseReplayBase = {
    ...replayBase,
    attempt_id: replayBase.attempt_id.toUpperCase(),
    lease_token: replayBase.lease_token.toUpperCase(),
    run_id: replayBase.run_id.toUpperCase(),
  };
  const safeMissingEffect = await recordExecutionEffectEnvelope(uppercaseReplayBase, {
    ...safeMissingEffectSpecification,
    stepId: ids.replayStep.toUpperCase(),
  });
  assertEqual(
    `${safeMissingEffect.envelope.run_id}|${safeMissingEffect.envelope.attempt_id}|${safeMissingEffect.envelope.step_id}`,
    `${ids.replayRun}|${ids.replayAttempt}|${ids.replayStep}`,
    'first uppercase UUID request returns the canonical lowercase Zod envelope projection',
  );
  const committedEnvelopeDigest = await runtimeDigest();
  const safeMissingEffectReplay = await recordExecutionEffectEnvelope(
    replayBase,
    safeMissingEffectSpecification,
  );
  assertEqual(
    `${safeMissingEffect.envelope_id}|${safeMissingEffect.envelope_sha256}|${String(safeMissingEffect.replayed)}|${safeMissingEffectReplay.envelope_id}|${safeMissingEffectReplay.envelope_sha256}|${String(safeMissingEffectReplay.replayed)}`,
    `${safeMissingEffect.envelope_id}|${safeMissingEffect.envelope_sha256}|false|${safeMissingEffect.envelope_id}|${safeMissingEffect.envelope_sha256}|true`,
    'canonical lowercase response-loss retry returns the uppercase request envelope ID and hash',
  );
  assertEqual(
    await runtimeDigest(),
    committedEnvelopeDigest,
    'committed pre-call envelope replay does not mutate the runtime facts',
  );
  await assertAttemptFinishResponsibilityRejected(
    replayBase,
    'OPEN effect envelope cannot be erased by finishing its Attempt',
  );
  await phaseJsonCall('execution', 'record_step_started', {
    ...replayBase,
    input_hash: hash('g007-replay-second-input'),
    step_id: ids.replaySecondStep,
    step_key: 'replayable-second-step',
  });
  await recordCompletedExecutionEffect(replayBase, {
    effectClass: 'SAFE',
    externalReceiptRef: 'fixture://g007/replay/second-effect',
    label: 'replay-second-effect',
    stepId: ids.replaySecondStep,
  });
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|', envelope.effect_class, count(receipt.id))
FROM public.run_retry_effect_envelopes AS envelope
LEFT JOIN public.run_side_effect_receipts AS receipt
  ON receipt.workspace_id = envelope.workspace_id AND receipt.envelope_id = envelope.id
WHERE envelope.workspace_id = '${ids.workspace}'
  AND envelope.id = '${safeMissingEffect.envelope_id}'
GROUP BY envelope.effect_class;`,
    ),
    'safe|0',
    'the public two-stage API leaves one durable safe envelope with no receipt before recovery',
  );
  assertExecutionCheckpointProjection(
    await phaseJsonCall('execution', 'record_execution_checkpoint', {
      ...replayBase,
      checkpoint_ref: 'fixture://g007/replay/checkpoint',
      checkpoint_sha256: hash('g007-replay-checkpoint'),
      payload_redacted: { cursor: 'committed-replay-point' },
      step_id: ids.replayStep,
    }),
    'recovery replay checkpoint',
  );
  const renewedReplay = await phaseJsonCall('execution', 'renew_run_attempt_lease', {
    ...replayBase,
    duration_seconds: 30,
  });

  const holdAuthority = await phaseJsonCall('execution', 'claim_run_attempt', {
    attempt_id: ids.holdAttempt,
    duration_seconds: 30,
    run_id: ids.holdRun,
  });
  const holdBase = {
    attempt_id: ids.holdAttempt,
    lease_fencing_token: holdAuthority.lease_fencing_token,
    lease_token: holdAuthority.lease_token,
    run_id: ids.holdRun,
  };
  await phaseJsonCall('execution', 'record_attempt_started', holdBase);
  await phaseJsonCall('execution', 'record_step_started', {
    ...holdBase,
    input_hash: hash('g007-hold-input'),
    step_id: ids.holdStep,
    step_key: 'unsafe-effect-step',
  });
  await recordCompletedExecutionEffect(holdBase, {
    effectClass: 'UNSAFE',
    externalReceiptRef: 'fixture://g007/hold/effect',
    label: 'hold-unsafe-effect',
    stepId: ids.holdStep,
  });
  await assertAttemptFinishResponsibilityRejected(
    holdBase,
    'UNSAFE effect cannot be erased by finishing its Attempt',
  );
  const relinquishDigest = await runtimeDigest();
  await assertPhaseRejected(
    'execution',
    `SELECT app.relinquish_run_attempt_lease(${jsonb(holdBase)});`,
    /effect closure is not safely relinquishable|55000/u,
    'unsafe effect blocks voluntary lease relinquishment',
  );
  assertEqual(
    await runtimeDigest(),
    relinquishDigest,
    'failed unsafe-effect relinquishment preserves the live lease and effect facts',
  );

  const retirementAuthority = await phaseJsonCall('execution', 'claim_run_attempt', {
    attempt_id: ids.retirementAttempt,
    duration_seconds: 30,
    run_id: ids.retirementRun,
  });
  const retirementBase = {
    attempt_id: ids.retirementAttempt,
    lease_fencing_token: retirementAuthority.lease_fencing_token,
    lease_token: retirementAuthority.lease_token,
    run_id: ids.retirementRun,
  };
  await phaseJsonCall('execution', 'record_attempt_started', retirementBase);
  await phaseJsonCall('execution', 'record_step_started', {
    ...retirementBase,
    input_hash: hash('g007-terminal-retirement-input'),
    step_id: ids.retirementStep,
    step_key: 'terminal-retirement-step',
  });
  await recordCompletedExecutionEffect(retirementBase, {
    effectClass: 'SAFE',
    externalReceiptRef: 'fixture://g007/terminal-retirement/effect',
    label: 'terminal-retirement-effect',
    stepId: ids.retirementStep,
  });

  const replayEffectClosure = await readAttemptEffectClosure(ids.replayRun, ids.replayAttempt);
  const holdEffectClosure = await readAttemptEffectClosure(ids.holdRun, ids.holdAttempt);
  const retirementEffectClosure = await readAttemptEffectClosure(
    ids.retirementRun,
    ids.retirementAttempt,
  );

  const replayDispatchAuthority = await phaseJsonCall('execution', 'claim_run_dispatch', {
    duration_seconds: 30,
    outbox_id: ids.replayDispatch,
    run_id: ids.replayRun,
  });
  const earlyFenceDigest = await runtimeDigest();
  await assertPhaseRejected(
    'reclaimer',
    `SELECT app.fence_expired_run_attempt(${jsonb({
      ...replayBase,
      effect_closure: replayEffectClosure,
    })});`,
    /missing, stale or not expired|42501/u,
    'reclaimer cannot fence an execution lease before database expiry',
  );
  assertEqual(
    await runtimeDigest(),
    earlyFenceDigest,
    'pre-expiry recovery-fence attempts leave runtime facts unchanged',
  );
  const holdMatrix = await prepareCancelHoldMatrix();
  return {
    dispatchAuthority,
    holdAuthority,
    holdBase,
    holdEffectClosure,
    replayAuthority: renewedReplay,
    replayDispatchAuthority,
    replayBase: {
      ...replayBase,
      lease_fencing_token: renewedReplay.lease_fencing_token,
      lease_token: renewedReplay.lease_token,
    },
    replayEffectClosure,
    safeMissingEffect,
    retirementAuthority,
    retirementBase,
    retirementEffectClosure,
    holdMatrix,
  };
}

async function crossLeaseExpiryUnderLock(primaryAuthority, recoveryBranches) {
  // The primary Attempt already has a committed termination intent, so its
  // execution façade must fail at the Run guard before reaching the Attempt
  // row lock. Use the still-executable replay branch to exercise the intended
  // post-lock database-time recheck.
  const renewalAuthority = recoveryBranches.replayBase;
  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
SET LOCAL session_replication_role = replica;
UPDATE public.run_attempts
SET lease_expires_at = clock_timestamp() + interval '30 seconds',
    updated_at = clock_timestamp()
WHERE workspace_id = '${ids.workspace}' AND id = '${ids.attempt}';
COMMIT;`,
  );
  const blocker = harness.openInteractivePsql('ba_bootstrap_test', {
    applicationName: 'ba-g007-expiry-attempt-blocker',
  });
  const execution = phaseAttestations.execution;
  const renewer = harness.openInteractivePsql(execution.login, {
    applicationName: 'ba-g007-expiry-renewer',
    scanFor: [execution.rawSecret],
  });
  const reclaimer = phaseAttestations.reclaimer;
  const fencer = harness.openInteractivePsql(reclaimer.login, {
    applicationName: 'ba-g007-expiry-fencer',
    scanFor: [reclaimer.rawSecret],
  });
  const blockerPid = await blocker.backendPid();
  const renewerPid = await renewer.backendPid();
  const fencerPid = await fencer.backendPid();
  let renewalOutcome;
  let fenceOutcome;
  const failures = [];
  try {
    await blocker.execute(`BEGIN;
SELECT 1 FROM public.run_attempts
WHERE workspace_id = '${ids.workspace}'
  AND id IN ('${ids.replayAttempt}', '${ids.retirementAttempt}')
ORDER BY id
FOR UPDATE;`);
    const renewalPromise = renewer
      .execute(
        establishWithAttestationSql(
          execution,
          'execution',
          `SELECT app.renew_run_attempt_lease(${jsonb({
            attempt_id: ids.replayAttempt,
            duration_seconds: 30,
            lease_fencing_token: renewalAuthority.lease_fencing_token,
            lease_token: renewalAuthority.lease_token,
            run_id: ids.replayRun,
          })});`,
        ).replace(/\nCOMMIT;$/u, ''),
        { timeoutMs: 45_000 },
      )
      .then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ reason, status: 'rejected' }),
      );
    const fencePromise = fencer
      .execute(
        establishWithAttestationSql(
          reclaimer,
          'reclaimer',
          `SELECT app.fence_expired_run_attempt(${jsonb({
            ...recoveryBranches.retirementBase,
            effect_closure: recoveryBranches.retirementEffectClosure,
          })});`,
        ).replace(/\nCOMMIT;$/u, ''),
        { timeoutMs: 45_000 },
      )
      .then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ reason, status: 'rejected' }),
      );
    await harness.waitForBlockingEdge(renewerPid, blockerPid, {
      context: 'Attempt renewer waits behind the cross-expiry row lock',
      timeoutMs: 5_000,
    });
    await harness.waitForBlockingEdge(fencerPid, blockerPid, {
      context: 'Attempt fencer waits behind the cross-expiry row lock',
      timeoutMs: 5_000,
    });
    await harness.waitForDatabaseCondition(
      `SELECT clock_timestamp() >= greatest(
  (SELECT lease_expires_at FROM public.run_attempts
    WHERE workspace_id = '${ids.workspace}' AND id = '${ids.attempt}'),
  (SELECT lease_expires_at FROM public.run_attempts
    WHERE workspace_id = '${ids.workspace}' AND id = '${ids.replayAttempt}'),
  (SELECT lease_expires_at FROM public.run_attempts
    WHERE workspace_id = '${ids.workspace}' AND id = '${ids.holdAttempt}'),
  (SELECT lease_expires_at FROM public.run_attempts
    WHERE workspace_id = '${ids.workspace}' AND id = '${ids.retirementAttempt}'),
  (SELECT lease_expires_at FROM public.outbox
    WHERE workspace_id = '${ids.workspace}' AND id = '${ids.dispatch}'),
  (SELECT lease_expires_at FROM public.outbox
    WHERE workspace_id = '${ids.workspace}' AND id = '${ids.replayDispatch}'),
  ${recoveryBranches.holdMatrix
    .map(
      ({ fixture }) => `(SELECT lease_expires_at FROM public.run_attempts
    WHERE workspace_id = '${ids.workspace}' AND id = '${fixture.attempt}')`,
    )
    .join(',\n  ')}
);`,
      { context: 'all 30-second protocol-v5 leases reach database expiry', timeoutMs: 40_000 },
    );
    await blocker.execute('COMMIT;');
    [renewalOutcome, fenceOutcome] = await Promise.all([renewalPromise, fencePromise]);
    if (fenceOutcome.status === 'fulfilled') await fencer.execute('COMMIT;');
  } catch (error) {
    failures.push(error);
  }
  try {
    await blocker.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    const fencerMetadata = await fencer.close();
    assertEqual(
      `${String(fencerMetadata.rawScan.leakDetected)}|${String(fencerMetadata.rawScan.count)}`,
      'false|0',
      'cross-expiry fencer does not echo the raw attestation',
    );
  } catch (error) {
    failures.push(error);
  }
  try {
    const renewerMetadata = await renewer.close();
    assertEqual(
      `${String(renewerMetadata.rawScan.leakDetected)}|${String(renewerMetadata.rawScan.count)}`,
      'false|0',
      'cross-expiry renewer does not echo the raw attestation',
    );
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'cross-expiry row-lock fixture and cleanup failed');
  }
  assertEqual(
    renewalOutcome?.status,
    'rejected',
    'renewal started before expiry rechecks database time after acquiring the lock',
  );
  assertErrorMatches(
    renewalOutcome?.reason,
    /missing, stale, expired or owned|42501/u,
    'post-lock Attempt renewal fails after database expiry',
  );
  assertEqual(
    fenceOutcome?.status,
    'fulfilled',
    'fencer started before expiry rechecks database time and succeeds after acquiring the lock',
  );
  const retirementFence = parseLastJson(
    fenceOutcome?.value ?? '',
    'cross-expiry retirement Attempt fence',
  );
  assertEqual(
    `${retirementFence.disposition}|${retirementFence.recovery_ticket?.new_fencing_token}`,
    'RECOVERY_PENDING|2',
    'post-lock Attempt fencer advances N to N+1 after database expiry',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT lease_generation || ':' || (lease_token = '${primaryAuthority.lease_token}')::text
     FROM public.run_attempts WHERE workspace_id = '${ids.workspace}' AND id = '${ids.attempt}'),
  (SELECT lease_generation || ':' || (lease_token = '${recoveryBranches.replayBase.lease_token}')::text
     FROM public.run_attempts WHERE workspace_id = '${ids.workspace}' AND id = '${ids.replayAttempt}'),
  (SELECT lease_generation || ':' || (lease_token = '${recoveryBranches.holdBase.lease_token}')::text
     FROM public.run_attempts WHERE workspace_id = '${ids.workspace}' AND id = '${ids.holdAttempt}'),
  (SELECT lease_generation || ':' || (lease_token IS NULL)::text
     FROM public.run_attempts WHERE workspace_id = '${ids.workspace}' AND id = '${ids.retirementAttempt}'),
  (SELECT delivery_generation || ':' || (lease_token = '${recoveryBranches.dispatchAuthority.lease_token}')::text
     FROM public.outbox WHERE workspace_id = '${ids.workspace}' AND id = '${ids.dispatch}'),
  (SELECT delivery_generation || ':' || (lease_token = '${recoveryBranches.replayDispatchAuthority.lease_token}')::text
     FROM public.outbox WHERE workspace_id = '${ids.workspace}' AND id = '${ids.replayDispatch}'),
  (SELECT count(*) FROM public.run_attempts
     WHERE workspace_id = '${ids.workspace}'
       AND id = ANY (ARRAY[${recoveryBranches.holdMatrix
         .map(({ fixture }) => sqlLiteral(fixture.attempt))
         .join(', ')}]::uuid[])
       AND lease_generation = 1 AND lease_owner = 'ba_execution_test'
       AND lease_token IS NOT NULL AND lease_fencing_token = 1)
);`,
    ),
    '1:true|1:true|1:true|2:true|1:true|1:true|6',
    'cross-expiry renew/fence outcomes preserve every unaffected authority and advance one N+1 fence',
  );
  return { retirementFence };
}

async function assertRecoveryFencingAndTakeover(
  primaryAuthority,
  primaryEffectClosure,
  recoveryBranches,
  crossExpiryEvidence,
) {
  const closureTamperDigest = await runtimeDigest();
  await assertPhaseRejected(
    'reclaimer',
    `SELECT app.fence_expired_run_attempt(${jsonb({
      ...primaryAuthority,
      effect_closure: {
        ...primaryEffectClosure,
        effect_closure_sha256: flipSha256Bit(primaryEffectClosure.effect_closure_sha256),
      },
    })});`,
    /effect closure does not match locked durable facts|42501/u,
    'single-bit effect-closure tamper cannot fence an expired Attempt',
  );
  assertEqual(
    await runtimeDigest(),
    closureTamperDigest,
    'single-bit effect-closure tamper leaves the authority tuple and evidence unchanged',
  );
  const primaryFence = await phaseJsonCall('reclaimer', 'fence_expired_run_attempt', {
    ...primaryAuthority,
    effect_closure: primaryEffectClosure,
  });
  assertEqual(
    `${primaryFence.disposition}|${primaryFence.fenced_generation}`,
    'TERMINATION_INTENT_PRESERVED|2',
    'reclaimer fences N to N+1 while preserving an unconsumed termination attribution',
  );
  const replayFence = await phaseJsonCall('reclaimer', 'fence_expired_run_attempt', {
    ...recoveryBranches.replayBase,
    effect_closure: recoveryBranches.replayEffectClosure,
  });
  const replayTicket = await assertRecoveryTicketReadback(replayFence, 'Attempt recovery ticket');
  assertEqual(
    `${replayFence.disposition}|${replayTicket?.new_fencing_token}|${replayTicket?.effect_decisions.length}|${replayTicket?.effect_decisions
      .map((decision) => decision.recovery_decision)
      .toSorted()
      .join(',')}`,
    'RECOVERY_PENDING|2|2|REPLAY_SAFE,RESUME_FROM_RECEIPT',
    'closed multi-effect set classifies a safe missing receipt without blocking the aggregate N+1 ticket',
  );
  const safeMissingDecision = replayTicket.effect_decisions.find(
    (decision) =>
      decision.retry_effect_envelope_id === recoveryBranches.safeMissingEffect.envelope_id,
  );
  assertEqual(
    `${safeMissingDecision?.effect_class}|${safeMissingDecision?.recovery_decision}|${String(safeMissingDecision?.effect_receipt_id === undefined)}`,
    'SAFE|REPLAY_SAFE|true',
    'safe envelope without a receipt is explicitly replay-safe and never fabricates receipt evidence',
  );
  assertEqual(
    replayTicket.effect_decisions.map((decision) => decision.retry_effect_envelope_id).join(','),
    replayTicket.effect_decisions
      .map((decision) => decision.retry_effect_envelope_id)
      .toSorted()
      .join(','),
    'aggregate recovery effect decisions are in deterministic envelope-ID order',
  );
  const holdFence = await phaseJsonCall('reclaimer', 'record_recovery_hold_intent', {
    ...recoveryBranches.holdBase,
    effect_closure: recoveryBranches.holdEffectClosure,
  });
  const holdIntent = holdFence.hold_intent;
  assertEqual(
    `${holdFence.disposition}|${holdIntent?.new_fencing_token}|${holdIntent?.hold_reason}`,
    'HOLD|2|UNSAFE_EFFECT',
    'unsafe effect produces a HOLD and never a replay ticket',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT hold_reason || ':' || fenced_generation || ':' || hold_evidence_sha256
FROM public.run_recovery_hold_intents
WHERE workspace_id = '${ids.workspace}' AND id = '${holdIntent.recovery_hold_intent_id}';`,
    ),
    `UNSAFE_EFFECT:2:${holdIntent.hold_evidence_sha256}`,
    'nested HOLD evidence matches immutable database readback',
  );
  const dispatchFence = await phaseJsonCall('reclaimer', 'fence_expired_run_dispatch', {
    lease_fencing_token: recoveryBranches.dispatchAuthority.lease_fencing_token,
    lease_token: recoveryBranches.dispatchAuthority.lease_token,
    outbox_id: ids.dispatch,
    run_id: ids.run,
  });
  const dispatchTicket = await assertRecoveryTicketReadback(
    dispatchFence,
    'primary RUN_DISPATCH recovery ticket',
  );
  assertEqual(
    `${dispatchFence.disposition}|${dispatchTicket?.new_fencing_token}|${dispatchTicket?.effect_decisions[0]?.recovery_decision}`,
    'RECOVERY_PENDING|2|REPLAY_SAFE',
    'expired RUN_DISPATCH lease becomes one N+1 recovery ticket',
  );
  const replayDispatchFence = await phaseJsonCall('reclaimer', 'fence_expired_run_dispatch', {
    lease_fencing_token: recoveryBranches.replayDispatchAuthority.lease_fencing_token,
    lease_token: recoveryBranches.replayDispatchAuthority.lease_token,
    outbox_id: ids.replayDispatch,
    run_id: ids.replayRun,
  });
  const replayDispatchTicket = await assertRecoveryTicketReadback(
    replayDispatchFence,
    'replayed RUN_DISPATCH recovery ticket',
  );
  const retirementFence = crossExpiryEvidence.retirementFence;
  const retirementTicket = await assertRecoveryTicketReadback(
    retirementFence,
    'terminal-retirement Attempt recovery ticket',
  );
  assertEqual(
    `${retirementFence.disposition}|${retirementTicket?.new_fencing_token}|${retirementTicket?.effect_decisions.length}`,
    'RECOVERY_PENDING|2|1',
    'confirmed aggregate effect closure produces a terminal-retirable N+1 ticket',
  );

  const fencedDigest = await runtimeDigest();
  await assertPhaseRejected(
    'execution',
    `SELECT app.record_execution_checkpoint(${jsonb({
      ...recoveryBranches.replayBase,
      checkpoint_ref: 'fixture://g007/stale-checkpoint',
      checkpoint_sha256: hash('g007-stale-checkpoint'),
      payload_redacted: {},
      step_id: ids.replayStep,
    })});`,
    /missing, stale, expired or owned|42501/u,
    'stale Worker cannot write after the N+1 reclaimer fence',
  );
  await assertPhaseRejected(
    'execution',
    `SELECT app.claim_run_attempt(${jsonb({
      attempt_id: ids.replayAttempt,
      duration_seconds: 30,
      recovery_ticket_id: fixtureUuid(996),
      run_id: ids.replayRun,
    })});`,
    /recovery ticket is missing or already consumed|42501/u,
    'recovery claim rejects a wrong ticket without consuming the real ticket',
  );
  assertEqual(
    await runtimeDigest(),
    fencedDigest,
    'stale write and wrong recovery ticket leave fenced facts unchanged',
  );

  const dispatchTakeover = await phaseJsonCall('execution', 'claim_run_dispatch', {
    duration_seconds: 30,
    outbox_id: ids.replayDispatch,
    recovery_ticket_id: replayDispatchTicket.recovery_ticket_id,
    run_id: ids.replayRun,
  });
  assertEqual(
    `${dispatchTakeover.lease_fencing_token}`,
    '3',
    'execution consumes the dispatch N+1 ticket exactly once and claims generation N+2',
  );
  const completedDispatch = await phaseJsonCall('execution', 'complete_run_dispatch', {
    lease_fencing_token: dispatchTakeover.lease_fencing_token,
    lease_token: dispatchTakeover.lease_token,
    outbox_id: ids.replayDispatch,
    run_id: ids.replayRun,
  });
  assertEqual(
    `${completedDispatch.status}|${completedDispatch.delivery_generation}`,
    'DELIVERED|3',
    'recovered RUN_DISPATCH completes only under the N+2 authority tuple',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT status || ':' || lease_generation || ':' || (lease_token IS NULL)::text
     FROM public.run_attempts WHERE workspace_id = '${ids.workspace}' AND id = '${ids.attempt}'),
  (SELECT status || ':' || lease_generation || ':' || (lease_token IS NULL)::text
     FROM public.run_attempts WHERE workspace_id = '${ids.workspace}' AND id = '${ids.replayAttempt}'),
  (SELECT status || ':' || lease_generation || ':' || (recovery_ticket_id IS NULL)::text
     FROM public.run_attempts WHERE workspace_id = '${ids.workspace}' AND id = '${ids.holdAttempt}'),
  (SELECT count(*) FROM public.run_recovery_hold_intents
     WHERE workspace_id = '${ids.workspace}' AND run_id = '${ids.holdRun}'),
  (SELECT count(*) FROM public.run_recovery_ticket_dispositions
     WHERE workspace_id = '${ids.workspace}' AND disposition_kind = 'CLAIMED'),
  (SELECT status || ':' || lease_generation || ':' || (lease_token IS NULL)::text
     FROM public.run_attempts WHERE workspace_id = '${ids.workspace}' AND id = '${ids.retirementAttempt}'),
  (SELECT status || ':' || delivery_generation || ':' || (lease_token IS NULL)::text
     FROM public.outbox WHERE workspace_id = '${ids.workspace}' AND id = '${ids.dispatch}'),
  (SELECT status || ':' || delivery_generation || ':' || (lease_token IS NULL)::text
     FROM public.outbox WHERE workspace_id = '${ids.workspace}' AND id = '${ids.replayDispatch}')
);`,
    ),
    'RELINQUISHED:2:true|PENDING:2:true|RELINQUISHED:2:true|1|1|PENDING:2:true|PENDING:2:true|DELIVERED:3:true',
    'independent readback proves termination-preserved, ticket, HOLD, terminal-retirement and dispatch branches',
  );
  return {
    dispatchFence,
    dispatchTicket,
    dispatchTakeover,
    holdFence,
    holdIntent,
    primaryFence,
    replayDispatchFence,
    replayDispatchTicket,
    replayFence,
    replayTicket,
    retirementFence,
    retirementTicket,
  };
}

async function assertCancelHoldRecoveryMatrix(recoveryBranches) {
  const evidence = [];
  for (const branch of recoveryBranches.holdMatrix) {
    const before = await runtimeDigest();
    const fenced = await phaseJsonCall('reclaimer', 'record_recovery_hold_intent', {
      ...branch.baseAuthority,
      effect_closure: branch.effectClosure,
    });
    const hold = fenced.hold_intent;
    if (hold === undefined) throw new Error(`${branch.fixture.label}: missing nested hold_intent`);
    assertEqual(
      `${fenced.disposition}|${hold.workspace_id}|${hold.run_id}|${hold.resource_id}|${hold.old_fencing_token}|${hold.new_fencing_token}|${hold.hold_reason}`,
      `HOLD|${ids.workspace}|${branch.fixture.run}|${branch.fixture.attempt}|1|2|${branch.fixture.expectedHoldReason}`,
      `${branch.fixture.label} fences N+1 and derives only the reviewed HOLD reason`,
    );
    if (branch.fixture.effect === 'unknown-receipt') {
      assertEqual(
        `${hold.retry_effect_envelope_id}|${hold.retry_effect_envelope_sha256}|${hold.effect_receipt_id}|${hold.effect_receipt_sha256}`,
        `${branch.effect?.envelope_id}|${branch.effect?.envelope_sha256}|${branch.effect?.receipt_id}|${branch.effect?.receipt_sha256}`,
        'UNKNOWN receipt HOLD binds the exact envelope and receipt evidence',
      );
    }
    if (branch.fixture.closureDisposition !== 'CLOSED') {
      assertEqual(
        `${hold.effect_closure_disposition}|${hold.effect_closure_sha256}`,
        `${branch.fixture.closureDisposition}|${branch.effectClosure.effect_closure_sha256}`,
        `${branch.fixture.label} HOLD binds the caller classification to the locked aggregate digest`,
      );
    }
    assertEqual(
      await harness.queryScalar(
        'ba_bootstrap_test',
        `SELECT concat_ws('|',
  (SELECT status || ':' || lease_generation || ':' ||
          (lease_owner IS NULL)::text || ':' || (lease_token IS NULL)::text || ':' ||
          (lease_fencing_token IS NULL)::text || ':' || (lease_expires_at IS NULL)::text
     FROM public.run_attempts WHERE workspace_id = '${ids.workspace}'
       AND id = '${branch.fixture.attempt}'),
  (SELECT hold_reason || ':' || old_generation || ':' || fenced_generation || ':' ||
          hold_evidence_sha256 || ':' || (consumed_at IS NULL)::text
     FROM public.run_recovery_hold_intents WHERE workspace_id = '${ids.workspace}'
       AND id = '${hold.recovery_hold_intent_id}'),
  (SELECT count(*) FROM public.run_recovery_tickets WHERE workspace_id = '${ids.workspace}'
     AND run_id = '${branch.fixture.run}')
);`,
      ),
      `RELINQUISHED:2:true:true:true:true|${branch.fixture.expectedHoldReason}:1:2:${hold.hold_evidence_sha256}:true|0`,
      `${branch.fixture.label} readback has no live lease or replay ticket and one immutable HOLD`,
    );
    if (before === (await runtimeDigest())) {
      throw new Error(
        `${branch.fixture.label}: recovery HOLD produced no durable state transition`,
      );
    }
    evidence.push({ ...branch, fence: fenced, holdIntent: hold });
  }
  return evidence;
}

async function assertRecoveryClaimOuterRollback(recoveryEvidence) {
  const before = await runtimeDigest();
  const execution = phaseAttestations.execution;
  const session = harness.openInteractivePsql(execution.login, {
    applicationName: 'ba-g007-recovery-claim-outer-rollback',
    scanFor: [execution.rawSecret],
  });
  const claim = parseLastJson(
    await session.execute(
      establishWithAttestationSql(
        execution,
        'execution',
        `SELECT app.claim_run_attempt(${jsonb({
          attempt_id: ids.retirementAttempt,
          duration_seconds: 30,
          recovery_ticket_id: recoveryEvidence.retirementTicket.recovery_ticket_id,
          run_id: ids.retirementRun,
        })});`,
      ).replace(/\nCOMMIT;$/u, ''),
    ),
    'recovery claim outer rollback authority',
  );
  assertEqual(
    claim.lease_fencing_token,
    '3',
    'uncommitted recovery claim provisionally advances N+1 to N+2',
  );
  await session.execute('ROLLBACK;');
  const metadata = await session.close();
  assertEqual(
    `${String(metadata.rawScan.leakDetected)}|${String(metadata.rawScan.count)}`,
    'false|0',
    'recovery claim outer rollback does not echo the raw execution attestation',
  );
  assertEqual(
    await runtimeDigest(),
    before,
    'recovery claim outer rollback restores Attempt N+1 and removes its provisional disposition',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT status || ':' || lease_generation || ':' || recovery_ticket_id
     FROM public.run_attempts WHERE workspace_id = '${ids.workspace}'
       AND id = '${ids.retirementAttempt}'),
  (SELECT count(*) FROM public.run_recovery_ticket_dispositions
     WHERE workspace_id = '${ids.workspace}'
       AND recovery_ticket_id = '${recoveryEvidence.retirementTicket.recovery_ticket_id}')
);`,
    ),
    `PENDING:2:${recoveryEvidence.retirementTicket.recovery_ticket_id}|0`,
    'independent rollback readback leaves the exact ticket available for terminal retirement',
  );
}

async function assertRecoveryClaimFirstFinalizerRace(recoveryEvidence, recoveryBranches) {
  const execution = phaseAttestations.execution;
  const finalizerAttestation = phaseAttestations.finalizer;
  const replayDecision = recoveryEvidence.replayTicket.effect_decisions.find(
    (decision) => decision.recovery_decision === 'REPLAY_SAFE',
  );
  if (replayDecision === undefined) {
    throw new Error('claim-first recovery ticket lacks its REPLAY_SAFE decision');
  }
  const envelopeCountBefore = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT count(*)
FROM public.run_retry_effect_envelopes
WHERE workspace_id = '${ids.workspace}'
  AND run_id = '${ids.replayRun}'
  AND attempt_id = '${ids.replayAttempt}';`,
  );
  const ticketBefore = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT jsonb_build_object(
  'ticket_sha256', ticket_sha256,
  'effect_decisions_sha256', effect_decisions_sha256,
  'effect_decisions', effect_decisions
)::text
FROM public.run_recovery_tickets
WHERE workspace_id = '${ids.workspace}'
  AND id = '${recoveryEvidence.replayTicket.recovery_ticket_id}';`,
  );
  const claimant = harness.openInteractivePsql(execution.login, {
    applicationName: 'ba-g007-recovery-claim-first',
    scanFor: [execution.rawSecret],
  });
  const finalizer = harness.openInteractivePsql(finalizerAttestation.login, {
    applicationName: 'ba-g007-recovery-claim-first-finalizer',
    scanFor: [finalizerAttestation.rawSecret],
  });
  const claimantPid = await claimant.backendPid();
  const finalizerPid = await finalizer.backendPid();
  let claim;
  let renewedClaim;
  let recoveredReceipt;
  let termination;
  let finalized;
  const failures = [];
  try {
    claim = parseLastJson(
      await claimant.execute(
        establishWithAttestationSql(
          execution,
          'execution',
          `SELECT app.claim_run_attempt(${jsonb({
            attempt_id: ids.replayAttempt,
            duration_seconds: 120,
            recovery_ticket_id: recoveryEvidence.replayTicket.recovery_ticket_id,
            run_id: ids.replayRun,
          })});`,
        ).replace(/\nCOMMIT;$/u, ''),
      ),
      'claim-first recovery Attempt authority',
    );
    renewedClaim = parseLastJson(
      await claimant.execute(
        `SELECT app.renew_run_attempt_lease(${jsonb({
          attempt_id: ids.replayAttempt,
          duration_seconds: 240,
          lease_fencing_token: claim.lease_fencing_token,
          lease_token: claim.lease_token,
          run_id: ids.replayRun,
        })});`,
      ),
      'claim-first renewed recovery Attempt authority',
    );
    assertEqual(
      `${recoveryEvidence.replayTicket.old_fencing_token}|${recoveryEvidence.replayTicket.new_fencing_token}|${claim.lease_fencing_token}|${renewedClaim.lease_fencing_token}|${String(renewedClaim.lease_token === claim.lease_token)}|${String(Date.parse(renewedClaim.lease_expires_at) > Date.parse(claim.lease_expires_at))}`,
      '1|2|3|3|true|true',
      'recovery claim renews expiry without changing the ticket N to claim N+2 token/fence binding',
    );
    const recoveredReceiptAuthority = {
      attempt_id: ids.replayAttempt,
      lease_fencing_token: renewedClaim.lease_fencing_token,
      lease_token: renewedClaim.lease_token,
      run_id: ids.replayRun,
    };
    const recoveredReceiptFact = executionEffectReceiptFact(
      recoveredReceiptAuthority,
      {
        retry_effect_envelope_id: replayDecision.retry_effect_envelope_id,
        retry_effect_envelope_sha256: replayDecision.retry_effect_envelope_sha256,
      },
      {
        externalReceiptRef: 'fixture://g007/replay/recovered-effect',
        label: 'replay-recovered-effect',
        stepId: ids.replayStep,
      },
    );
    recoveredReceipt = assertExecutionEffectReceiptProjection(
      parseLastJson(
        await claimant.execute(
          `SELECT app.record_execution_effect_receipt(${jsonb(recoveredReceiptFact)});`,
        ),
        'claim-first recovered effect receipt',
      ),
      'claim-first recovered effect receipt',
    );
    assertEqual(
      `${recoveredReceipt.receipt.lease_fencing_token}|${String(Date.parse(recoveredReceipt.receipt.lease_expires_at) === Date.parse(renewedClaim.lease_expires_at))}`,
      `${claim.lease_fencing_token}|true`,
      'recovery receipt records the renewed producer expiry under the unchanged N+2 fence',
    );
    await claimant.execute('COMMIT;');

    const committedReceiptDigest = await runtimeDigest();
    const recoveredReceiptReplay = assertExecutionEffectReceiptProjection(
      await phaseJsonCall('execution', 'record_execution_effect_receipt', recoveredReceiptFact),
      'claim-first recovered effect receipt replay',
    );
    assertEqual(
      `${recoveredReceipt.envelope_id}|${recoveredReceipt.receipt_id}|${String(recoveredReceipt.replayed)}|${recoveredReceiptReplay.receipt_id}|${String(recoveredReceiptReplay.replayed)}`,
      `${replayDecision.retry_effect_envelope_id}|${recoveredReceipt.receipt_id}|false|${recoveredReceipt.receipt_id}|true`,
      'a new transaction replays the committed N+2 recovery receipt after response loss',
    );
    assertEqual(
      await runtimeDigest(),
      committedReceiptDigest,
      'committed recovery receipt replay returns the original response without mutating runtime facts',
    );

    assertEqual(
      await harness.queryScalar(
        'ba_bootstrap_test',
        `SELECT concat_ws('|',
  (SELECT count(*) FROM public.run_retry_effect_envelopes
     WHERE workspace_id = '${ids.workspace}'
       AND run_id = '${ids.replayRun}'
       AND attempt_id = '${ids.replayAttempt}'),
  (SELECT producer_lease_fencing_token FROM public.run_retry_effect_envelopes
     WHERE workspace_id = '${ids.workspace}'
       AND id = '${replayDecision.retry_effect_envelope_id}'),
  (SELECT count(*) FROM public.run_side_effect_receipts
     WHERE workspace_id = '${ids.workspace}'
       AND envelope_id = '${replayDecision.retry_effect_envelope_id}'),
  (SELECT producer_lease_fencing_token || ':' ||
          (producer_lease_expires_at = '${renewedClaim.lease_expires_at}'::timestamptz)::text
     FROM public.run_side_effect_receipts
     WHERE workspace_id = '${ids.workspace}'
       AND envelope_id = '${replayDecision.retry_effect_envelope_id}'
       AND id = '${recoveredReceipt.receipt_id}')
);`,
      ),
      `${envelopeCountBefore}|${recoveryEvidence.replayTicket.old_fencing_token}|1|${claim.lease_fencing_token}:true`,
      'recovery closes the old N envelope with one renewed N+2 receipt without creating another envelope',
    );
    assertEqual(
      await harness.queryScalar(
        'ba_bootstrap_test',
        `SELECT jsonb_build_object(
  'ticket_sha256', ticket_sha256,
  'effect_decisions_sha256', effect_decisions_sha256,
  'effect_decisions', effect_decisions
)::text
FROM public.run_recovery_tickets
WHERE workspace_id = '${ids.workspace}'
  AND id = '${recoveryEvidence.replayTicket.recovery_ticket_id}';`,
      ),
      ticketBefore,
      'recovery receipt creation and committed replay do not rewrite the ticket or its decision set',
    );

    const assertRecoveryEffectRejectedWithoutMutation = async (
      functionName,
      fact,
      expectedPattern,
      context,
    ) => {
      const before = await runtimeDigest();
      await assertPhaseRejected(
        'execution',
        `SELECT app.${functionName}(${jsonb(fact)});`,
        expectedPattern,
        context,
      );
      assertEqual(await runtimeDigest(), before, `${context} leaves all runtime facts unchanged`);
    };
    await assertRecoveryEffectRejectedWithoutMutation(
      'record_execution_effect_receipt',
      {
        ...recoveredReceiptFact,
        retry_effect_envelope_sha256: flipSha256Bit(
          recoveredReceiptFact.retry_effect_envelope_sha256,
        ),
      },
      /recovery effect|mismatched|42501/u,
      'recovery receipt rejects a single-bit envelope-hash tamper',
    );
    await assertRecoveryEffectRejectedWithoutMutation(
      'record_execution_effect_receipt',
      {
        ...recoveredReceiptFact,
        effect_class: 'UNSAFE',
      },
      /effect receipt is invalid|invalid|22023/u,
      'recovery receipt rejects caller injection of an effect class absent from the envelope',
    );
    await assertRecoveryEffectRejectedWithoutMutation(
      'record_execution_effect_receipt',
      {
        ...recoveredReceiptFact,
        lease_fencing_token: recoveryBranches.replayBase.lease_fencing_token,
        lease_token: recoveryBranches.replayBase.lease_token,
      },
      /does not match committed authority|missing, stale, expired|23505|42501/u,
      'recovery receipt rejects the stale N authority fence',
    );
    await assertRecoveryEffectRejectedWithoutMutation(
      'record_execution_effect_envelope',
      executionEffectEnvelopeFact(recoveredReceiptAuthority, {
        effectClass: 'REQUIRES_KEY',
        label: 'recovery-missing-operation-key-attack',
        stepId: ids.replayStep,
      }),
      /effect envelope is invalid|invalid|22023/u,
      'recovery envelope rejects REQUIRES_KEY without an operation key',
    );
    const missingResultRefFact = { ...recoveredReceiptFact };
    delete missingResultRefFact.external_receipt_ref;
    await assertRecoveryEffectRejectedWithoutMutation(
      'record_execution_effect_receipt',
      missingResultRefFact,
      /effect receipt is invalid|invalid|22023/u,
      'recovery receipt rejects CONFIRMED without an external receipt reference',
    );

    termination = assertTerminationIntentProjection(
      parseLastJson(
        await claimant.execute(
          establishWithAttestationSql(
            execution,
            'execution',
            `SELECT app.record_leased_termination_intent(${jsonb({
              attempt_id: ids.replayAttempt,
              billing_close_intent_redacted: {
                intended_operation: 'RELEASE',
                intended_release_amount: '20',
                intended_settle_amount: '0',
              },
              lease_fencing_token: claim.lease_fencing_token,
              lease_token: claim.lease_token,
              producer_operation_key: 'g007:recovery:termination',
              reservation_id: ids.replayReservation,
              run_id: ids.replayRun,
              step_id: ids.replayStep,
              terminal_kind: 'FAILED',
              termination_reason: 'INTERNAL_FAILURE',
            })});`,
          ).replace(/\nCOMMIT;$/u, ''),
        ),
        'claim-first termination authority',
      ),
      'claim-first termination authority contract',
    );
    const finalizationPromise = finalizer.execute(
      establishWithAttestationSql(
        finalizerAttestation,
        'finalizer',
        `SELECT app.finalize_attributed_run(${jsonb({
          run_id: ids.replayRun,
          source_authority_hash: termination.source_authority_hash,
          source_id: termination.intent.termination_intent_id,
        })});`,
      ).replace(/\nCOMMIT;$/u, ''),
      { timeoutMs: 15_000 },
    );
    await harness.waitForBlockingEdge(finalizerPid, claimantPid, {
      context: 'attributed finalizer waits behind committed recovery claim and source creation',
      timeoutMs: 5_000,
    });
    await claimant.execute('COMMIT;');
    finalized = parseLastJson(await finalizationPromise, 'claim-first attributed finalizer');
    await finalizer.execute('COMMIT;');
  } catch (error) {
    failures.push(error);
  }
  for (const [session, label] of [
    [claimant, 'recovery claimant'],
    [finalizer, 'claim-first finalizer'],
  ]) {
    try {
      const metadata = await session.close();
      assertEqual(
        `${String(metadata.rawScan.leakDetected)}|${String(metadata.rawScan.count)}`,
        'false|0',
        `${label} does not echo the raw attestation`,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'claim-first recovery/finalizer race and cleanup failed');
  }
  assertEqual(
    `${claim?.lease_fencing_token}|${finalized?.status}|${finalized?.billing_state}|${String(finalized?.replayed)}`,
    '3|FAILED|SETTLED|false',
    'recovery claim wins at N+2 before one historical-attribution finalizer commit',
  );
  const exactReplay = await phaseJsonCall('finalizer', 'finalize_attributed_run', {
    run_id: ids.replayRun,
    source_authority_hash: termination?.source_authority_hash,
    source_id: termination?.intent.termination_intent_id,
  });
  assertEqual(
    `${exactReplay.terminal_event_id}|${String(exactReplay.replayed)}`,
    `${finalized?.terminal_event_id}|true`,
    'claim-first terminal response-loss retry replays the committed tombstone',
  );
  const terminalDigest = await runtimeDigest();
  await assertPhaseRejected(
    'execution',
    `SELECT app.claim_run_attempt(${jsonb({
      attempt_id: ids.replayAttempt,
      duration_seconds: 30,
      recovery_ticket_id: recoveryEvidence.replayTicket.recovery_ticket_id,
      run_id: ids.replayRun,
    })});`,
    /cannot admit a new Attempt|recovery ticket is missing or already consumed|55000|42501/u,
    'terminal replay Run cannot consume an already-claimed recovery ticket again',
  );
  assertEqual(
    await runtimeDigest(),
    terminalDigest,
    'post-terminal ticket replay attempt has zero side effects',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT disposition_kind || ':' || ticket_fencing_token || ':' ||
          claim_fencing_token || ':' || claim_session_user || ':' ||
          (recovery_ticket_sha256 = '${recoveryEvidence.replayFence.recovery_ticket_sha256}')::text || ':' ||
          (claim_lease_owner = 'ba_execution_test')::text || ':' ||
          (claim_lease_token = '${claim?.lease_token}')::text || ':' ||
          (claim_lease_expires_at = '${claim?.lease_expires_at}'::timestamptz)::text
     FROM public.run_recovery_ticket_dispositions
     WHERE workspace_id = '${ids.workspace}'
       AND recovery_ticket_id = '${recoveryEvidence.replayTicket.recovery_ticket_id}'),
  (SELECT status || ':' || lease_generation || ':' || (lease_token IS NULL)::text
     FROM public.run_attempts WHERE workspace_id = '${ids.workspace}' AND id = '${ids.replayAttempt}'),
  (SELECT (consumed_at IS NOT NULL)::text FROM public.run_termination_intents
     WHERE workspace_id = '${ids.workspace}'
       AND id = '${termination?.intent.termination_intent_id}'),
  (SELECT status || ':' || billing_state FROM public.runs
     WHERE workspace_id = '${ids.workspace}' AND id = '${ids.replayRun}'),
  (SELECT status || ':' || released_credits FROM public.credit_reservations
     WHERE workspace_id = '${ids.workspace}' AND id = '${ids.replayReservation}'),
  (SELECT authority_kind || ':' || producer_lease_fencing_token || ':' || reserved_delta_credits
     FROM public.credits_ledger WHERE workspace_id = '${ids.workspace}'
       AND id = '${finalized?.ledger_entry_id}'),
  (SELECT status || ':' || delivery_generation FROM public.outbox
     WHERE workspace_id = '${ids.workspace}' AND id = '${ids.replayDispatch}'),
  (SELECT producer_lease_fencing_token || ':' || (id = '${recoveredReceipt?.receipt_id}')::text
     FROM public.run_side_effect_receipts
     WHERE workspace_id = '${ids.workspace}'
       AND envelope_id = '${recoveredReceipt?.envelope_id}'),
  (SELECT count(*) FROM public.finalizer_transaction_claims
     WHERE workspace_id = '${ids.workspace}')
);`,
    ),
    'CLAIMED:2:3:ba_execution_test:true:true:true:true|FAILED:3:true|true|FAILED:SETTLED|RELEASED:20|EXECUTION_TERMINATION:3:-20|DELIVERED:3|3:true|0',
    'independent claim-first readback binds the exact ticket digest and N+2 claim authority to the terminal projection',
  );
}

async function assertHistoricalAttributionSettlement(executionArtifacts) {
  await assertEffectResponseLossReplayAfterAuthorityLoss(
    executionArtifacts.effectSeam,
    'after lease expiry and fencing',
  );
  const historicalSourceReplayDigest = await runtimeDigest();
  const historicalUsageReplay = assertUsageAttributionProjection(
    await phaseJsonCall('execution', 'record_usage_attribution', executionArtifacts.usageFact),
    'usage attribution replay after lease fencing',
  );
  assertEqual(
    `${historicalUsageReplay.source.usage_attribution_id}|${historicalUsageReplay.source_authority_hash}|${historicalUsageReplay.source.authorized_at}|${String(historicalUsageReplay.replayed)}`,
    `${executionArtifacts.usage.source.usage_attribution_id}|${executionArtifacts.usage.source_authority_hash}|${executionArtifacts.usage.source.authorized_at}|true`,
    'old usage producer tuple first-pass exact replays after lease expiry and fencing',
  );
  assertEqual(
    await runtimeDigest(),
    historicalSourceReplayDigest,
    'post-fence usage source replay does not consume or duplicate the source',
  );
  const settlementFact = {
    run_id: ids.run,
    source_authority_hash: executionArtifacts.usage.source_authority_hash,
    source_id: executionArtifacts.usage.source.usage_attribution_id,
  };
  const workspaceBefore = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT credits_balance || ':' || credits_reserved_balance || ':' || credits_balance_version
       FROM public.workspaces WHERE id = '${ids.workspace}';`,
  );
  const [availableBefore, reservedBefore, versionBefore] = workspaceBefore
    .split(':')
    .map((value) => BigInt(value));
  const first = await phaseJsonCall('metering', 'settle_attributed_credits', settlementFact);
  assertEqual(
    `${typeof first.amount}|${first.amount}|${String(first.replayed)}`,
    'string|5|false',
    'metering consumes the committed historical N attribution after its lease was fenced',
  );
  const replay = await phaseJsonCall('metering', 'settle_attributed_credits', settlementFact);
  assertEqual(
    `${typeof replay.amount}|${replay.amount}|${replay.authority_receipt_id}|${replay.ledger_entry_id}|${String(replay.replayed)}`,
    `string|5|${first.authority_receipt_id}|${first.ledger_entry_id}|true`,
    'response-loss retry returns the original receipt and ledger without moving credits again',
  );

  const replayDigest = await runtimeDigest();
  await assertPhaseRejected(
    'metering',
    `SELECT app.settle_attributed_credits(${jsonb({
      ...settlementFact,
      source_authority_hash: hash('g007-stolen-source'),
    })});`,
    /replay does not match committed authority|23505/u,
    'consumed source cannot replay under a different source hash',
  );
  await assertPhaseRejected(
    'metering',
    `SELECT app.settle_attributed_credits(${jsonb({
      ...settlementFact,
      run_id: ids.replayRun,
    })});`,
    /replay does not match committed authority|23505/u,
    'consumed source cannot be rebound to another Run',
  );
  await assertPhaseRejected(
    'metering',
    `SELECT app.settle_attributed_credits(${jsonb({
      ...settlementFact,
      workspace_id: ids.workspace,
    })});`,
    /invalid attributed settlement request|22023/u,
    'metering rejects caller-selected Workspace even on exact replay',
  );
  assertEqual(
    await runtimeDigest(),
    replayDigest,
    'wrong-binding historical settlement replays leave balances and receipts unchanged',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT credits_balance || ':' || credits_reserved_balance || ':' || credits_balance_version
     FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT status || ':' || settled_credits || ':' || released_credits
     FROM public.credit_reservations WHERE workspace_id = '${ids.workspace}'
       AND id = '${ids.reservation}'),
  (SELECT entry_schema_version || ':' || authority_kind || ':' ||
          producer_lease_fencing_token || ':' || settled_delta_credits
     FROM public.credits_ledger WHERE workspace_id = '${ids.workspace}'
       AND id = '${first.ledger_entry_id}'),
  (SELECT receipt.authority_kind || ':' || receipt.source_id || ':' ||
          receipt.source_authority_hash || ':' ||
          receipt.source_consumption_generation || ':' ||
          (receipt.charge_attribution_hash = receipt.source_authority_hash)::text || ':' ||
          (receipt.billing_intent_hash = ledger.billing_intent_hash)::text
     FROM public.run_billing_authority_receipts AS receipt
     JOIN public.credits_ledger AS ledger
       ON ledger.workspace_id = receipt.workspace_id AND ledger.id = receipt.ledger_entry_id
     WHERE receipt.workspace_id = '${ids.workspace}'
       AND receipt.id = '${first.authority_receipt_id}'),
  (SELECT consumption_generation || ':' || (consumed_at IS NOT NULL)::text
     FROM public.run_usage_attributions
     WHERE workspace_id = '${ids.workspace}' AND id = '${settlementFact.source_id}')
);`,
    ),
    `${availableBefore}:${reservedBefore - BigInt(first.amount)}:${versionBefore + 1n}|HELD:5:0|2:EXECUTION_USAGE:1:5|EXECUTION_USAGE:${settlementFact.source_id}:${settlementFact.source_authority_hash}:1:true:true|2:true`,
    'independent readback preserves historical fence N=1 and binds receipt CAS generation 1 before source generation 2',
  );
  return first;
}

async function assertFinalizerOuterRollback(functionName, fact, context) {
  const before = await runtimeDigest();
  const attestation = phaseAttestations.finalizer;
  const session = harness.openInteractivePsql(attestation.login, {
    applicationName: `ba-g007-${context.replaceAll(' ', '-')}`,
    scanFor: [attestation.rawSecret],
  });
  await session.execute(
    establishWithAttestationSql(
      attestation,
      'finalizer',
      `SELECT app.${functionName}(${jsonb(fact)});`,
    ).replace(/\nCOMMIT;$/u, ''),
  );
  await session.execute('ROLLBACK;');
  const metadata = await session.close();
  assertEqual(
    `${String(metadata.rawScan.leakDetected)}|${String(metadata.rawScan.count)}`,
    'false|0',
    `${context} rollback does not echo the raw finalizer attestation`,
  );
  assertEqual(
    await runtimeDigest(),
    before,
    `${context} outer rollback restores source CAS, ledger, tombstone and retirement facts`,
  );
}

async function assertAttributedFinalization(executionArtifacts, recoveryEvidence) {
  const fact = {
    run_id: ids.run,
    source_authority_hash: executionArtifacts.termination.source_authority_hash,
    source_id: executionArtifacts.termination.intent.termination_intent_id,
  };
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT count(*) FROM public.run_attempts
WHERE workspace_id = '${ids.workspace}' AND run_id = '${ids.run}'
  AND (status IN ('PENDING', 'RUNNING') OR lease_token IS NOT NULL
    OR lease_fencing_token IS NOT NULL OR lease_expires_at IS NOT NULL);`,
    ),
    '0',
    'attributed finalizer independently observes no active executable Attempt authority',
  );
  await assertFinalizerOuterRollback(
    'finalize_attributed_run',
    fact,
    'attributed finalizer terminal-write-after-release',
  );
  const first = await phaseJsonCall('finalizer', 'finalize_attributed_run', fact);
  assertEqual(
    `${first.status}|${first.billing_state}|${String(first.replayed)}`,
    'FAILED|SETTLED|false',
    'historical termination attribution atomically releases the remainder and finalizes the Run',
  );
  const replay = await phaseJsonCall('finalizer', 'finalize_attributed_run', fact);
  assertEqual(
    `${replay.run_id}|${replay.terminal_event_id}|${String(replay.replayed)}`,
    `${ids.run}|${first.terminal_event_id}|true`,
    'attributed finalizer response-loss replay returns the original terminal tombstone',
  );
  const terminalDigest = await runtimeDigest();
  await assertPhaseRejected(
    'finalizer',
    `SELECT app.finalize_attributed_run(${jsonb({
      ...fact,
      source_authority_hash: hash('g007-wrong-termination-source'),
    })});`,
    /replay conflicts with terminal tombstone|23505/u,
    'terminal tombstone rejects a different termination attribution hash',
  );
  assertEqual(
    await runtimeDigest(),
    terminalDigest,
    'different attributed terminal replay leaves the completed Run byte-for-byte unchanged',
  );
  await assertEffectResponseLossReplayAfterAuthorityLoss(
    executionArtifacts.effectSeam,
    'after terminalization',
  );
  const terminalSourceReplayDigest = await runtimeDigest();
  const terminalUsageReplay = assertUsageAttributionProjection(
    await phaseJsonCall('execution', 'record_usage_attribution', executionArtifacts.usageFact),
    'usage attribution replay after terminalization',
  );
  const terminalIntentReplay = assertTerminationIntentProjection(
    await phaseJsonCall(
      'execution',
      'record_leased_termination_intent',
      executionArtifacts.terminationFact,
    ),
    'termination attribution replay after terminalization',
  );
  assertEqual(
    `${terminalUsageReplay.source.usage_attribution_id}|${terminalUsageReplay.source_authority_hash}|${terminalUsageReplay.source.authorized_at}|${String(terminalUsageReplay.replayed)}|${terminalIntentReplay.intent.termination_intent_id}|${terminalIntentReplay.source_authority_hash}|${terminalIntentReplay.intent.authorized_at}|${String(terminalIntentReplay.replayed)}`,
    `${executionArtifacts.usage.source.usage_attribution_id}|${executionArtifacts.usage.source_authority_hash}|${executionArtifacts.usage.source.authorized_at}|true|${executionArtifacts.termination.intent.termination_intent_id}|${executionArtifacts.termination.source_authority_hash}|${executionArtifacts.termination.intent.authorized_at}|true`,
    'old usage and termination producer tuples first-pass exact replay after terminalization',
  );
  assertEqual(
    await runtimeDigest(),
    terminalSourceReplayDigest,
    'post-terminal source replays do not duplicate billing authority or mutate source CAS',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT status || ':' || execution_status || ':' || billing_state || ':' || termination_reason
     FROM public.runs WHERE workspace_id = '${ids.workspace}' AND id = '${ids.run}'),
  (SELECT status || ':' || settled_credits || ':' || released_credits
     FROM public.credit_reservations WHERE workspace_id = '${ids.workspace}'
       AND id = '${ids.reservation}'),
  (SELECT authority_kind || ':' || producer_lease_fencing_token || ':' || reserved_delta_credits
     FROM public.credits_ledger WHERE workspace_id = '${ids.workspace}'
       AND id = '${first.ledger_entry_id}'),
  (SELECT count(*) FROM public.run_steps WHERE workspace_id = '${ids.workspace}'
     AND run_id = '${ids.run}' AND status IN ('PENDING', 'RUNNING', 'SUSPENDED')),
  (SELECT count(*) FROM public.run_events WHERE workspace_id = '${ids.workspace}'
     AND run_id = '${ids.run}' AND event_type = 'RUN_FINISHED'),
  (SELECT status || ':' || delivery_generation FROM public.outbox
     WHERE workspace_id = '${ids.workspace}' AND id = '${ids.dispatch}'),
  (SELECT count(*) FROM public.run_dispatch_retirement_receipts
     WHERE workspace_id = '${ids.workspace}' AND outbox_id = '${ids.dispatch}'),
  (SELECT disposition_kind || ':' || ticket_fencing_token || ':' ||
          terminal_source_kind || ':' || terminal_source_id || ':' || terminal_resource_status
     FROM public.run_recovery_ticket_dispositions
     WHERE workspace_id = '${ids.workspace}'
       AND recovery_ticket_id = '${recoveryEvidence.dispatchTicket.recovery_ticket_id}'),
  (SELECT count(*) FROM public.finalizer_transaction_claims
     WHERE workspace_id = '${ids.workspace}')
);`,
    ),
    `FAILED:FAILED:SETTLED:INTERNAL_FAILURE|SETTLED:5:15|EXECUTION_TERMINATION:1:-15|0|1|DEAD:2|1|TERMINAL_RETIRED:2:TERMINATION_ATTRIBUTION:${executionArtifacts.termination.intent.termination_intent_id}:DEAD|0`,
    'independent readback closes Steps and dispatch authority while preserving historical termination fence N=1',
  );
  await assertDispatchRetirementReceipt(
    ids.dispatch,
    {
      last_error_code: 'RUN_TERMINATED_BEFORE_DISPATCH',
      new_delivery_generation: '2',
      old_delivery_generation: '2',
      old_lease_expires_at: undefined,
      old_lease_fencing_token: undefined,
      old_lease_owner: undefined,
      old_lease_token: undefined,
      old_status: 'PENDING',
      outbox_id: ids.dispatch,
      retired_status: 'DEAD',
      run_id: ids.run,
      terminal_intent_sha256: first.terminal_intent_hash,
      terminal_source_id: executionArtifacts.termination.intent.termination_intent_id,
      terminal_source_kind: 'TERMINATION_ATTRIBUTION',
      terminal_source_sha256: executionArtifacts.termination.source_authority_hash,
      workspace_id: ids.workspace,
    },
    'attributed finalizer dispatch retirement receipt',
  );
  return first;
}

async function assertBillingAuthorityKindOperationMismatch(sourceLedgerId) {
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT authority_kind || ':' || operation
FROM public.run_billing_authority_receipts
WHERE workspace_id = '${ids.workspace}' AND ledger_entry_id = '${sourceLedgerId}';`,
    ),
    'EXECUTION_TERMINATION:RELEASE',
    'kind-operation negative fixture starts from a committed termination release authority',
  );
  const before = await runtimeDigest();
  await assertPsqlRejected(
    'ba_bootstrap_test',
    `BEGIN;
INSERT INTO public.run_billing_authority_receipts (
  workspace_id, id, run_id, billing_owner_run_id, reservation_id,
  authority_schema_version, authority_kind, source_id, source_authority_hash,
  source_consumption_generation, operation, amount, producer_run_id,
  producer_attempt_id, producer_lease_fencing_token, step_id, ledger_entry_id,
  charge_key, billing_intent_hash, charge_attribution_hash, receipt_sha256, authorized_at
)
SELECT
  workspace_id, '${ids.mismatchedAuthorityReceipt}', run_id, billing_owner_run_id,
  reservation_id, authority_schema_version, 'EXECUTION_USAGE',
  '${ids.mismatchedAuthoritySource}', source_authority_hash,
  source_consumption_generation, 'RELEASE', amount, producer_run_id,
  producer_attempt_id, producer_lease_fencing_token, step_id,
  '${ids.mismatchedAuthorityLedger}', charge_key || ':kind-operation-mismatch',
  billing_intent_hash, charge_attribution_hash, receipt_sha256, authorized_at
FROM public.run_billing_authority_receipts
WHERE workspace_id = '${ids.workspace}' AND ledger_entry_id = '${sourceLedgerId}';
COMMIT;`,
    /run_billing_authority_receipts_shape_check/u,
    'v2 receipt cannot commit an EXECUTION_USAGE authority paired with RELEASE',
  );
  assertEqual(
    await runtimeDigest(),
    before,
    'kind-operation mismatch rolls back without a receipt, ledger row or source mutation',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT entry_schema_version || ':' || authority_kind || ':' || entry_kind
FROM public.credits_ledger
WHERE workspace_id = '${ids.workspace}' AND id = '${sourceLedgerId}';`,
    ),
    '2:EXECUTION_TERMINATION:RELEASE',
    'ledger-side negative fixture starts from a committed v2 termination release entry',
  );
  const ledgerBefore = await runtimeDigest();
  await assertPsqlRejected(
    'ba_bootstrap_test',
    `BEGIN;
INSERT INTO public.credits_ledger (
  workspace_id, id, run_id, billing_owner_run_id, producer_run_id,
  producer_attempt_id, producer_lease_fencing_token, step_id, reservation_id,
  entry_kind, available_delta_credits, reserved_delta_credits,
  settled_delta_credits, billing_intent_hash, charge_attribution_hash, charge_key,
  balance_before, reserved_before, balance_after, reserved_after, balance_version,
  metering_detail_redacted, created_at, entry_schema_version,
  authority_schema_version, authority_kind, authority_id
)
SELECT
  workspace_id, '${ids.mismatchedAuthorityLedger}', run_id, billing_owner_run_id,
  producer_run_id, producer_attempt_id, producer_lease_fencing_token, step_id,
  reservation_id, 'RELEASE', available_delta_credits, reserved_delta_credits,
  settled_delta_credits, billing_intent_hash, charge_attribution_hash,
  charge_key || ':ledger-kind-operation-mismatch', balance_before, reserved_before,
  balance_after, reserved_after, balance_version, metering_detail_redacted, created_at,
  2, 1, 'EXECUTION_USAGE', '${ids.mismatchedAuthorityReceipt}'
FROM public.credits_ledger
WHERE workspace_id = '${ids.workspace}' AND id = '${sourceLedgerId}';
COMMIT;`,
    /credits_ledger_authority_shape_check/u,
    'v2 ledger cannot commit an EXECUTION_USAGE authority paired with RELEASE',
  );
  assertEqual(
    await runtimeDigest(),
    ledgerBefore,
    'ledger-side kind-operation mismatch rolls back before deferred authority binding',
  );
}

async function assertRawDmlCheckGroup(label, vectors) {
  const before = await runtimeDigest();
  for (const { constraint, context, statement } of vectors) {
    await assertPsqlRejected(
      'ba_bootstrap_test',
      `BEGIN;
${statement}
COMMIT;`,
      new RegExp(`ERROR:\\s+23514:[^\\r\\n]*constraint "${constraint}"`, 'u'),
      context,
    );
  }
  assertEqual(
    await runtimeDigest(),
    before,
    `${label} raw-DML CHECK rejections are transactionally atomic`,
  );
}

async function assertFailClosedShapeConstraintVectors(
  executionArtifacts,
  recoveryEvidence,
  sourceLedgerId,
) {
  const vectorIds = Object.freeze({
    attempt: fixtureUuid(308),
    checkpoint: fixtureUuid(309),
    hold: fixtureUuid(310),
    dispatchReceipt: fixtureUuid(311),
    billingReceipt: fixtureUuid(312),
    billingReceiptLedger: fixtureUuid(313),
    ledger: fixtureUuid(314),
    ledgerAuthority: fixtureUuid(315),
    ledgerJson: fixtureUuid(316),
  });

  await assertRawDmlCheckGroup('Attempt protocol-v5 state', [
    {
      constraint: 'run_attempts_protocol_v5_state_check',
      context: 'owner-plane raw DML cannot store a RUNNING protocol-v5 Attempt with a NULL fence',
      statement: `INSERT INTO public.run_attempts (
  workspace_id, id, run_id, attempt_number, status, lease_owner, lease_token,
  lease_fencing_token, lease_expires_at, started_at, finished_at, created_at,
  runtime_protocol_version, lease_generation, recovery_ticket_id, updated_at
)
SELECT source.workspace_id, '${vectorIds.attempt}', source.run_id,
  (SELECT max(candidate.attempt_number) + 1 FROM public.run_attempts AS candidate
   WHERE candidate.workspace_id = source.workspace_id AND candidate.run_id = source.run_id),
  'RUNNING', 'ba_execution_test', '${fixtureUuid(317)}', NULL,
  clock_timestamp() + interval '1 hour', clock_timestamp(), NULL, clock_timestamp(),
  5, 1, NULL, clock_timestamp()
FROM public.run_attempts AS source
WHERE source.workspace_id = '${ids.workspace}' AND source.id = '${ids.attempt}';`,
    },
  ]);

  await assertRawDmlCheckGroup('Checkpoint protocol-v5 shape', [
    {
      constraint: 'run_checkpoints_protocol_v5_shape_check',
      context:
        'owner-plane raw DML cannot store a protocol-v5 Checkpoint with a NULL producer fence',
      statement: `INSERT INTO public.run_checkpoints (
  workspace_id, id, run_id, step_id, checkpoint_hash, payload_ref, payload_redacted,
  created_at, producer_attempt_id, producer_lease_token, producer_lease_fencing_token,
  producer_session_user, producer_lease_expires_at, authorized_at, checkpoint_sequence,
  runtime_protocol_version
)
SELECT source.workspace_id, '${vectorIds.checkpoint}', source.run_id, source.step_id,
  '${hash('g007-null-checkpoint-fence')}', 'fixture://g007/null-checkpoint-fence',
  source.payload_redacted, source.created_at, source.producer_attempt_id,
  source.producer_lease_token, NULL, source.producer_session_user,
  source.producer_lease_expires_at, source.authorized_at,
  (SELECT max(candidate.checkpoint_sequence) + 1 FROM public.run_checkpoints AS candidate
   WHERE candidate.workspace_id = source.workspace_id AND candidate.run_id = source.run_id),
  5
FROM public.run_checkpoints AS source
WHERE source.workspace_id = '${ids.workspace}'
  AND source.id = '${executionArtifacts.checkpoint.checkpoint_id}';`,
    },
  ]);

  await assertRawDmlCheckGroup('Recovery HOLD evidence shape', [
    {
      constraint: 'run_recovery_hold_intents_evidence_shape_check',
      context: 'owner-plane raw DML cannot store closure HOLD evidence with a NULL disposition',
      statement: `INSERT INTO public.run_recovery_hold_intents (
  workspace_id, id, run_id, resource_kind, resource_id, old_generation,
  fenced_generation, hold_reason, retry_effect_envelope_id,
  retry_effect_envelope_sha256, effect_receipt_id, effect_receipt_sha256,
  effect_closure_disposition, effect_closure_sha256, hold_evidence_sha256,
  checkpoint_id, checkpoint_sha256, created_at, consumed_at
)
SELECT workspace_id, '${vectorIds.hold}', run_id, resource_kind, resource_id,
  old_generation, fenced_generation, 'EFFECT_CLOSURE_OPEN', NULL, NULL, NULL, NULL,
  NULL, '${hash('g007-null-hold-disposition-closure')}',
  '${hash('g007-null-hold-disposition-evidence')}', checkpoint_id, checkpoint_sha256,
  created_at, NULL
FROM public.run_recovery_hold_intents
WHERE workspace_id = '${ids.workspace}'
  AND id = '${recoveryEvidence.holdIntent.recovery_hold_intent_id}';`,
    },
  ]);

  await assertRawDmlCheckGroup('Dispatch retirement lease shape', [
    {
      constraint: 'run_dispatch_retirement_receipts_lease_shape_check',
      context: 'owner-plane raw DML cannot store a LEASED retirement receipt with a NULL old fence',
      statement: `INSERT INTO public.run_dispatch_retirement_receipts (
  workspace_id, id, run_id, outbox_id, old_status, old_lease_owner, old_lease_token,
  old_lease_fencing_token, old_lease_expires_at, old_delivery_generation,
  new_delivery_generation, retired_status, last_error_code, terminal_source_kind,
  terminal_source_id, terminal_source_sha256, terminal_intent_sha256,
  receipt_sha256, retired_at
)
SELECT workspace_id, '${vectorIds.dispatchReceipt}', run_id, outbox_id, 'LEASED',
  'ba_execution_test', '${fixtureUuid(318)}', NULL, clock_timestamp() + interval '1 hour',
  1, 2, retired_status, last_error_code, terminal_source_kind, terminal_source_id,
  terminal_source_sha256, terminal_intent_sha256, receipt_sha256, retired_at
FROM public.run_dispatch_retirement_receipts
WHERE workspace_id = '${ids.workspace}' AND outbox_id = '${ids.dispatch}';`,
    },
  ]);

  await assertRawDmlCheckGroup('Billing authority receipt shape', [
    {
      constraint: 'run_billing_authority_receipts_shape_check',
      context: 'owner-plane raw DML cannot store an execution billing receipt with a NULL Step',
      statement: `INSERT INTO public.run_billing_authority_receipts (
  workspace_id, id, run_id, billing_owner_run_id, reservation_id,
  authority_schema_version, authority_kind, source_id, source_authority_hash,
  source_consumption_generation, operation, amount, producer_run_id,
  producer_attempt_id, producer_lease_fencing_token, step_id, ledger_entry_id,
  charge_key, billing_intent_hash, charge_attribution_hash, receipt_sha256, authorized_at
)
SELECT workspace_id, '${vectorIds.billingReceipt}', run_id, billing_owner_run_id,
  reservation_id, authority_schema_version, authority_kind, '${fixtureUuid(319)}',
  source_authority_hash, source_consumption_generation, operation, amount,
  producer_run_id, producer_attempt_id, producer_lease_fencing_token, NULL,
  '${vectorIds.billingReceiptLedger}', charge_key || ':null-step-receipt',
  billing_intent_hash, charge_attribution_hash, receipt_sha256, authorized_at
FROM public.run_billing_authority_receipts
WHERE workspace_id = '${ids.workspace}' AND ledger_entry_id = '${sourceLedgerId}';`,
    },
  ]);

  const ledgerColumns = `workspace_id, id, run_id, billing_owner_run_id, producer_run_id,
  producer_attempt_id, producer_lease_fencing_token, step_id, reservation_id,
  entry_kind, available_delta_credits, reserved_delta_credits, settled_delta_credits,
  billing_intent_hash, charge_attribution_hash, charge_key, balance_before,
  reserved_before, balance_after, reserved_after, balance_version,
  metering_detail_redacted, created_at, entry_schema_version,
  authority_schema_version, authority_kind, authority_id`;
  await assertRawDmlCheckGroup('Ledger JSON and authority shape', [
    {
      constraint: 'credits_ledger_metering_detail_json_check',
      context: 'ledger table backstop rejects recursively nested JavaScript overflow from raw JSON',
      statement: `INSERT INTO public.credits_ledger (${ledgerColumns})
SELECT workspace_id, '${vectorIds.ledgerJson}', run_id, billing_owner_run_id,
  producer_run_id, producer_attempt_id, producer_lease_fencing_token, step_id,
  reservation_id, entry_kind, available_delta_credits, reserved_delta_credits,
  settled_delta_credits, billing_intent_hash, charge_attribution_hash,
  charge_key || ':overflow-json', balance_before, reserved_before, balance_after,
  reserved_after, balance_version, '{"nested":[{"overflow":1e1000}]}'::jsonb,
  created_at, entry_schema_version, authority_schema_version, authority_kind, authority_id
FROM public.credits_ledger
WHERE workspace_id = '${ids.workspace}' AND id = '${sourceLedgerId}';`,
    },
    {
      constraint: 'credits_ledger_authority_shape_check',
      context: 'owner-plane raw DML cannot store a v2 execution ledger entry with a NULL Step',
      statement: `INSERT INTO public.credits_ledger (${ledgerColumns})
SELECT workspace_id, '${vectorIds.ledger}', run_id, billing_owner_run_id,
  producer_run_id, producer_attempt_id, producer_lease_fencing_token, NULL,
  reservation_id, entry_kind, available_delta_credits, reserved_delta_credits,
  settled_delta_credits, billing_intent_hash, charge_attribution_hash,
  charge_key || ':null-step-ledger', balance_before, reserved_before, balance_after,
  reserved_after, balance_version, metering_detail_redacted, created_at,
  entry_schema_version, authority_schema_version, authority_kind, '${vectorIds.ledgerAuthority}'
FROM public.credits_ledger
WHERE workspace_id = '${ids.workspace}' AND id = '${sourceLedgerId}';`,
    },
  ]);
}

async function seedDurableCancellationFacts() {
  const facts = [
    { event: ids.cancelEvent, label: 'cancel', run: ids.cancelRun },
    { event: ids.zeroCancelEvent, label: 'zero-cancel', run: ids.zeroCancelRun },
    {
      event: ids.retirementCancelEvent,
      label: 'terminal-retirement',
      run: ids.retirementRun,
    },
    ...noFinancialFixtures.map(({ cancelEvent, label, run }) => ({
      event: cancelEvent,
      label,
      run,
    })),
  ];
  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
SET LOCAL session_replication_role = replica;
${facts
  .map(
    ({ event, label, run }) => `WITH next_event AS (
  UPDATE public.runs
  SET status = 'CANCEL_REQUESTED',
      execution_status = 'CANCELLING',
      last_event_sequence = last_event_sequence + 1
  WHERE workspace_id = '${ids.workspace}' AND id = '${run}'
  RETURNING last_event_sequence
)
INSERT INTO public.run_events (
  workspace_id, id, run_id, sequence, event_type, dedupe_key,
  payload_redacted, occurred_at
) SELECT
  '${ids.workspace}', '${event}', '${run}', next_event.last_event_sequence,
  'RUN_CANCEL_REQUESTED',
  'g007-${label}-requested',
  jsonb_build_object('cancel_intent_hash', '${hash(`g007-${label}-intent`)}'),
  clock_timestamp()
FROM next_event;`,
  )
  .join('\n')}
COMMIT;`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT count(*) FROM public.runs AS run_row
JOIN public.run_events AS event
  ON event.workspace_id = run_row.workspace_id AND event.run_id = run_row.id
WHERE run_row.workspace_id = '${ids.workspace}'
  AND run_row.id = ANY (ARRAY[${[
    ids.cancelRun,
    ids.zeroCancelRun,
    ids.retirementRun,
    ...noFinancialFixtures.map(({ run }) => run),
  ]
    .map(sqlLiteral)
    .join(', ')}]::uuid[])
  AND run_row.status = 'CANCEL_REQUESTED'
  AND event.event_type = 'RUN_CANCEL_REQUESTED';`,
    ),
    '6',
    'disposable source fixture exposes six durable pre-claim cancellation facts',
  );
}

async function assertHoldFinalization(recoveryEvidence) {
  const fact = {
    hold_intent_id: recoveryEvidence.holdIntent.recovery_hold_intent_id,
    run_id: ids.holdRun,
  };
  const ledgerCountBefore = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT count(*) FROM public.credits_ledger WHERE workspace_id = '${ids.workspace}';`,
  );
  await assertFinalizerOuterRollback('finalize_claimed_run', fact, 'recovery HOLD finalizer');
  const first = await phaseJsonCall('finalizer', 'finalize_claimed_run', fact);
  assertEqual(
    `${first.status}|${first.billing_state}|${String(first.replayed)}`,
    'NEEDS_ATTENTION|NEEDS_ATTENTION|false',
    'HOLD-first finalization produces NEEDS_ATTENTION with no financial movement',
  );
  const replay = await phaseJsonCall('finalizer', 'finalize_claimed_run', fact);
  assertEqual(
    `${replay.terminal_event_id}|${String(replay.replayed)}`,
    `${first.terminal_event_id}|true`,
    'HOLD finalizer exact response-loss retry replays the terminal tombstone',
  );
  const holdDigest = await runtimeDigest();
  await assertPhaseRejected(
    'finalizer',
    `SELECT app.finalize_claimed_run(${jsonb({
      hold_intent_id: fixtureUuid(995),
      run_id: ids.holdRun,
    })});`,
    /replay conflicts|unavailable or consumed|42501|23505/u,
    'terminal HOLD replay rejects a different source ID',
  );
  assertEqual(await runtimeDigest(), holdDigest, 'different HOLD replay has zero side effects');
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT status || ':' || billing_state || ':' || termination_reason
     FROM public.runs WHERE workspace_id = '${ids.workspace}' AND id = '${ids.holdRun}'),
  (SELECT status || ':' || settled_credits || ':' || released_credits
     FROM public.credit_reservations WHERE workspace_id = '${ids.workspace}'
       AND id = '${ids.holdReservation}'),
  (SELECT (consumed_at IS NOT NULL)::text FROM public.run_recovery_hold_intents
     WHERE workspace_id = '${ids.workspace}' AND id = '${fact.hold_intent_id}'),
  (SELECT count(*) FROM public.run_steps WHERE workspace_id = '${ids.workspace}'
     AND run_id = '${ids.holdRun}' AND status IN ('PENDING', 'RUNNING', 'SUSPENDED')),
  (SELECT status || ':' || delivery_generation FROM public.outbox
     WHERE workspace_id = '${ids.workspace}' AND run_id = '${ids.holdRun}'
       AND message_type = 'RUN_DISPATCH'),
  (SELECT count(*) FROM public.run_dispatch_retirement_receipts
     WHERE workspace_id = '${ids.workspace}' AND run_id = '${ids.holdRun}'),
  (SELECT count(*) FROM public.finalizer_transaction_claims
     WHERE workspace_id = '${ids.workspace}')
);`,
    ),
    'NEEDS_ATTENTION:NEEDS_ATTENTION:SIDE_EFFECT_UNKNOWN|HELD:0:0|true|0|DEAD:0|1|0',
    'independent HOLD readback closes execution/dispatch authority and leaves credits held',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT count(*) FROM public.credits_ledger WHERE workspace_id = '${ids.workspace}';`,
    ),
    ledgerCountBefore,
    'HOLD finalization writes no financial ledger row',
  );
}

async function assertCancelHoldFinalizationAndMetering(holdEvidence) {
  const meteringReplay = holdEvidence.find(
    ({ fixture }) => fixture.usage === 'committed-before-hold',
  );
  const meteringMiss = holdEvidence.find(({ fixture }) => fixture.usage === 'miss-after-hold');
  if (meteringReplay?.usage === undefined || meteringMiss?.usage === undefined) {
    throw new Error('HOLD metering matrix is missing committed usage authority fixtures');
  }
  const exactSettlementFact = {
    run_id: meteringReplay.fixture.run,
    source_authority_hash: meteringReplay.usage.source_authority_hash,
    source_id: meteringReplay.usage.source.usage_attribution_id,
  };
  const exactSettlement = await phaseJsonCall(
    'metering',
    'settle_attributed_credits',
    exactSettlementFact,
  );
  assertEqual(
    `${exactSettlement.amount}|${String(exactSettlement.replayed)}`,
    '1|false',
    'exact usage authority commits its one-credit ledger before HOLD finalization',
  );

  for (const evidence of holdEvidence.filter(({ fixture }) => fixture.usage === undefined)) {
    const financialBefore = await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT credits_balance || ':' || credits_reserved_balance || ':' || credits_balance_version
     FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT count(*) FROM public.run_billing_authority_receipts
     WHERE workspace_id = '${ids.workspace}' AND run_id = '${evidence.fixture.run}'),
  (SELECT count(*) FROM public.credits_ledger
     WHERE workspace_id = '${ids.workspace}' AND run_id = '${evidence.fixture.run}')
);`,
    );
    const fact = {
      hold_intent_id: evidence.holdIntent.recovery_hold_intent_id,
      run_id: evidence.fixture.run,
    };
    const first = await phaseJsonCall('finalizer', 'finalize_claimed_run', fact);
    const replay = await phaseJsonCall('finalizer', 'finalize_claimed_run', fact);
    assertEqual(
      `${first.status}|${first.billing_state}|${String(first.replayed)}|${replay.terminal_event_id}|${String(replay.replayed)}`,
      `NEEDS_ATTENTION|NEEDS_ATTENTION|false|${first.terminal_event_id}|true`,
      `${evidence.fixture.label} HOLD finalization commits once and exactly replays`,
    );
    assertEqual(
      await harness.queryScalar(
        'ba_bootstrap_test',
        `SELECT concat_ws('|',
  (SELECT credits_balance || ':' || credits_reserved_balance || ':' || credits_balance_version
     FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT count(*) FROM public.run_billing_authority_receipts
     WHERE workspace_id = '${ids.workspace}' AND run_id = '${evidence.fixture.run}'),
  (SELECT count(*) FROM public.credits_ledger
     WHERE workspace_id = '${ids.workspace}' AND run_id = '${evidence.fixture.run}')
);`,
      ),
      financialBefore,
      `${evidence.fixture.label} HOLD finalization does not mint billing authority or move funds`,
    );
  }

  const missFact = {
    run_id: meteringMiss.fixture.run,
    source_authority_hash: meteringMiss.usage.source_authority_hash,
    source_id: meteringMiss.usage.source.usage_attribution_id,
  };
  const finalizerAttestation = phaseAttestations.finalizer;
  const meteringAttestation = phaseAttestations.metering;
  const finalizer = harness.openInteractivePsql(finalizerAttestation.login, {
    applicationName: 'ba-g007-hold-finalizer-workspace-lock',
    scanFor: [finalizerAttestation.rawSecret],
  });
  const metering = harness.openInteractivePsql(meteringAttestation.login, {
    applicationName: 'ba-g007-metering-miss-behind-hold',
    scanFor: [meteringAttestation.rawSecret],
  });
  const finalizerPid = await finalizer.backendPid();
  const meteringPid = await metering.backendPid();
  let finalizedMiss;
  let meteringOutcome;
  const failures = [];
  try {
    finalizedMiss = parseLastJson(
      await finalizer.execute(
        establishWithAttestationSql(
          finalizerAttestation,
          'finalizer',
          `SELECT app.finalize_claimed_run(${jsonb({
            hold_intent_id: meteringMiss.holdIntent.recovery_hold_intent_id,
            run_id: meteringMiss.fixture.run,
          })});`,
        ).replace(/\nCOMMIT;$/u, ''),
      ),
      'HOLD finalizer before queued metering miss',
    );
    const meteringPromise = metering
      .execute(
        establishWithAttestationSql(
          meteringAttestation,
          'metering',
          `SELECT app.settle_attributed_credits(${jsonb(missFact)});`,
        ),
        { timeoutMs: 10_000 },
      )
      .then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ reason, status: 'rejected' }),
      );
    await harness.waitForBlockingEdge(meteringPid, finalizerPid, {
      context: 'metering first-consumption miss waits behind the HOLD finalizer Workspace lock',
      timeoutMs: 5_000,
    });
    await finalizer.execute('COMMIT;');
    meteringOutcome = await meteringPromise;
  } catch (error) {
    failures.push(error);
  }
  for (const [session, label] of [
    [finalizer, 'HOLD finalizer'],
    [metering, 'queued metering miss'],
  ]) {
    try {
      const metadata = await session.close();
      assertEqual(
        `${String(metadata.rawScan.leakDetected)}|${String(metadata.rawScan.count)}`,
        'false|0',
        `${label} does not echo its raw attestation`,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'HOLD finalizer and queued metering fixture cleanup failed');
  }
  assertEqual(
    `${finalizedMiss?.status}|${finalizedMiss?.billing_state}|${meteringOutcome?.status}`,
    'NEEDS_ATTENTION|NEEDS_ATTENTION|rejected',
    'HOLD finalizer linearizes first and the queued metering first-consumption miss fails closed',
  );
  assertErrorMatches(
    meteringOutcome?.reason,
    /terminal|NEEDS_ATTENTION|cannot consume|not available|42501|55000|23514/u,
    'metering rechecks the terminal Run after the Workspace lock is released',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT status || ':' || billing_state FROM public.runs
     WHERE workspace_id = '${ids.workspace}' AND id = '${meteringMiss.fixture.run}'),
  (SELECT status || ':' || settled_credits || ':' || released_credits
     FROM public.credit_reservations WHERE workspace_id = '${ids.workspace}'
       AND id = '${meteringMiss.fixture.reservation}'),
  (SELECT consumed_at IS NULL FROM public.run_usage_attributions
     WHERE workspace_id = '${ids.workspace}'
       AND id = '${meteringMiss.usage.source.usage_attribution_id}'),
  (SELECT count(*) FROM public.run_billing_authority_receipts
     WHERE workspace_id = '${ids.workspace}' AND run_id = '${meteringMiss.fixture.run}'),
  (SELECT count(*) FROM public.credits_ledger
     WHERE workspace_id = '${ids.workspace}' AND run_id = '${meteringMiss.fixture.run}')
);`,
    ),
    'NEEDS_ATTENTION:NEEDS_ATTENTION|HELD:0:0|t|0|0',
    'failed post-HOLD metering miss preserves the committed source and held funds for reconciliation',
  );

  const replayHoldFact = {
    hold_intent_id: meteringReplay.holdIntent.recovery_hold_intent_id,
    run_id: meteringReplay.fixture.run,
  };
  await phaseJsonCall('finalizer', 'finalize_claimed_run', replayHoldFact);
  const beforeExactReplay = await runtimeDigest();
  const exactReplay = await phaseJsonCall(
    'metering',
    'settle_attributed_credits',
    exactSettlementFact,
  );
  assertEqual(
    `${exactReplay.authority_receipt_id}|${exactReplay.ledger_entry_id}|${String(exactReplay.replayed)}`,
    `${exactSettlement.authority_receipt_id}|${exactSettlement.ledger_entry_id}|true`,
    'same committed usage authority replays its exact receipt and ledger after HOLD terminalization',
  );
  assertEqual(
    await runtimeDigest(),
    beforeExactReplay,
    'post-HOLD exact metering replay performs no second consumption or funds movement',
  );

  const snapshotBefore = await terminalSnapshotDigest(meteringMiss.fixture.run);
  const workspaceBefore = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT credits_balance || ':' || credits_reserved_balance || ':' || credits_balance_version
FROM public.workspaces WHERE id = '${ids.workspace}';`,
  );
  const reconciliationFact = {
    billing_intent_hash: hash('g007-hold-reconciliation-intent'),
    charge_attribution_hash: hash('g007-hold-reconciliation-evidence'),
    charge_key: 'g007:hold-reconciliation:release',
    evidence_ref: 'fixture://g007/hold-reconciliation/evidence',
    evidence_sha256: hash('g007-hold-reconciliation-evidence'),
    idempotency_key: 'g007-hold-reconciliation',
    ledger_entry_id: ids.reconciliationLedger,
    reconciliation_id: ids.reconciliation,
    released_credits: '1',
    reservation_id: meteringMiss.fixture.reservation,
    run_id: meteringMiss.fixture.run,
    settled_credits: '0',
  };
  const reconciliationId = await phaseScalarCall(
    'reconciliation',
    'reconcile_needs_attention_billing',
    reconciliationFact,
  );
  const reconciliationReplay = await phaseScalarCall(
    'reconciliation',
    'reconcile_needs_attention_billing',
    reconciliationFact,
  );
  assertEqual(
    `${reconciliationId}|${reconciliationReplay}`,
    `${ids.reconciliation}|${ids.reconciliation}`,
    'reconciliation evidence is append-once and exactly replayable',
  );
  assertEqual(
    await terminalSnapshotDigest(meteringMiss.fixture.run),
    snapshotBefore,
    'reconciliation cannot rewrite the immutable HOLD terminal snapshot',
  );
  const [balanceBefore, reservedBefore, versionBefore] = workspaceBefore.split(':').map(Number);
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT credits_balance || ':' || credits_reserved_balance || ':' || credits_balance_version
     FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT status || ':' || billing_state || ':' || (billing_settled_at IS NOT NULL)::text
     FROM public.runs WHERE workspace_id = '${ids.workspace}'
       AND id = '${meteringMiss.fixture.run}'),
  (SELECT status || ':' || settled_credits || ':' || released_credits
     FROM public.credit_reservations WHERE workspace_id = '${ids.workspace}'
       AND id = '${meteringMiss.fixture.reservation}'),
  (SELECT count(*) FROM public.run_billing_reconciliations
     WHERE workspace_id = '${ids.workspace}' AND id = '${ids.reconciliation}'),
  (SELECT entry_kind || ':' || available_delta_credits || ':' || reserved_delta_credits
     FROM public.credits_ledger WHERE workspace_id = '${ids.workspace}'
       AND id = '${ids.reconciliationLedger}')
);`,
    ),
    `${String(balanceBefore + 1)}:${String(reservedBefore - 1)}:${String(versionBefore + 1)}|NEEDS_ATTENTION:SETTLED:true|RELEASED:0:1|1|RECONCILIATION:1:-1`,
    'reconciliation appends evidence and updates only current billing closure after HOLD',
  );
}

async function assertConcurrentDurableCancelFinalization() {
  const fact = { cancel_event_id: ids.cancelEvent, run_id: ids.cancelRun };
  const attestation = phaseAttestations.finalizer;
  const winner = harness.openInteractivePsql(attestation.login, {
    applicationName: 'ba-g007-cancel-finalizer-winner',
    scanFor: [attestation.rawSecret],
  });
  const replay = harness.openInteractivePsql(attestation.login, {
    applicationName: 'ba-g007-cancel-finalizer-replay',
    scanFor: [attestation.rawSecret],
  });
  const winnerPid = await winner.backendPid();
  const replayPid = await replay.backendPid();
  let first;
  let second;
  const failures = [];
  try {
    first = parseLastJson(
      await winner.execute(
        establishWithAttestationSql(
          attestation,
          'finalizer',
          `SELECT app.finalize_claimed_run(${jsonb(fact)});`,
        ).replace(/\nCOMMIT;$/u, ''),
      ),
      'durable cancel finalizer winner',
    );
    const replayPromise = replay.execute(
      establishWithAttestationSql(
        attestation,
        'finalizer',
        `SELECT app.finalize_claimed_run(${jsonb(fact)});`,
      ).replace(/\nCOMMIT;$/u, ''),
      { timeoutMs: 10_000 },
    );
    await harness.waitForBlockingEdge(replayPid, winnerPid, {
      context: 'second finalizer waits behind the durable cancel winner',
      timeoutMs: 5_000,
    });
    await winner.execute('COMMIT;');
    second = parseLastJson(await replayPromise, 'durable cancel finalizer replay');
    await replay.execute('COMMIT;');
  } catch (error) {
    failures.push(error);
  }
  for (const [session, label] of [
    [winner, 'winner'],
    [replay, 'replay'],
  ]) {
    try {
      const metadata = await session.close();
      assertEqual(
        `${String(metadata.rawScan.leakDetected)}|${String(metadata.rawScan.count)}`,
        'false|0',
        `durable cancel ${label} does not echo the raw finalizer attestation`,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'durable cancel finalizer concurrency and cleanup failed');
  }
  assertEqual(
    `${first?.status}|${String(first?.replayed)}|${second?.status}|${String(second?.replayed)}`,
    'CANCELLED|false|CANCELLED|true',
    'two finalizers linearize to one durable-cancel winner and one exact replay',
  );
  const cancelDigest = await runtimeDigest();
  await assertPhaseRejected(
    'finalizer',
    `SELECT app.finalize_claimed_run(${jsonb({
      cancel_event_id: fixtureUuid(994),
      run_id: ids.cancelRun,
    })});`,
    /replay conflicts|durable cancel event is unavailable|42501|23505/u,
    'terminal cancel replay rejects a different event source',
  );
  assertEqual(
    await runtimeDigest(),
    cancelDigest,
    'different durable-cancel replay leaves terminal and financial rows unchanged',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT status || ':' || billing_state || ':' || termination_reason
     FROM public.runs WHERE workspace_id = '${ids.workspace}' AND id = '${ids.cancelRun}'),
  (SELECT status || ':' || released_credits
     FROM public.credit_reservations WHERE workspace_id = '${ids.workspace}'
       AND id = '${ids.cancelReservation}'),
  (SELECT authority_kind || ':' || (producer_attempt_id IS NULL)::text || ':' || available_delta_credits
     FROM public.credits_ledger WHERE workspace_id = '${ids.workspace}'
       AND id = '${first?.ledger_entry_id}'),
  (SELECT status || ':' || delivery_generation FROM public.outbox
     WHERE workspace_id = '${ids.workspace}' AND run_id = '${ids.cancelRun}'
       AND message_type = 'RUN_DISPATCH'),
  (SELECT count(*) FROM public.run_dispatch_retirement_receipts
     WHERE workspace_id = '${ids.workspace}' AND run_id = '${ids.cancelRun}'),
  (SELECT count(*) FROM public.finalizer_transaction_claims
     WHERE workspace_id = '${ids.workspace}')
);`,
    ),
    'CANCELLED:SETTLED:USER_CANCELLED|RELEASED:20|DURABLE_CANCEL:true:20|DEAD:0|1|0',
    'independent cancel readback proves keyless authority, one release, and dispatch retirement',
  );
}

async function assertZeroCreditDurableCancel() {
  const fact = { cancel_event_id: ids.zeroCancelEvent, run_id: ids.zeroCancelRun };
  await assertFinalizerOuterRollback(
    'finalize_claimed_run',
    fact,
    'zero-credit durable cancel finalizer',
  );
  const beforeVersion = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT credits_balance_version FROM public.workspaces WHERE id = '${ids.workspace}';`,
  );
  const first = await phaseJsonCall('finalizer', 'finalize_claimed_run', fact);
  const replay = await phaseJsonCall('finalizer', 'finalize_claimed_run', fact);
  assertEqual(
    `${first.status}|${String(first.replayed)}|${replay.terminal_event_id}|${String(replay.replayed)}`,
    `CANCELLED|false|${first.terminal_event_id}|true`,
    'zero-credit durable cancel commits once and response-loss retry replays',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT status || ':' || released_credits FROM public.credit_reservations
     WHERE workspace_id = '${ids.workspace}' AND id = '${ids.zeroCancelReservation}'),
  (SELECT entry_schema_version || ':' || authority_kind || ':' || available_delta_credits
     FROM public.credits_ledger WHERE workspace_id = '${ids.workspace}'
       AND id = '${first.ledger_entry_id}'),
  (SELECT credits_balance_version FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT count(*) FROM public.finalizer_transaction_claims
     WHERE workspace_id = '${ids.workspace}')
);`,
    ),
    `RELEASED:0|2:DURABLE_CANCEL:0|${beforeVersion}|0`,
    'zero-credit cancel records /2 authority without changing Workspace balance version',
  );
}

async function assertNoFinancialDispatchLinearization() {
  const settled = noFinancialFixtures.find(
    ({ reservationStatus }) => reservationStatus === 'SETTLED',
  );
  const released = noFinancialFixtures.find(
    ({ reservationStatus }) => reservationStatus === 'RELEASED',
  );
  const expired = noFinancialFixtures.find(
    ({ reservationStatus }) => reservationStatus === 'EXPIRED',
  );
  if (settled === undefined || released === undefined || expired === undefined) {
    throw new Error('pre-closed reservation dispatch matrix is incomplete');
  }

  const settledAuthority = await phaseJsonCall('execution', 'claim_run_dispatch', {
    duration_seconds: 30,
    outbox_id: settled.dispatch,
    run_id: settled.run,
  });
  const settledDispatcher = harness.openInteractivePsql(phaseAttestations.execution.login, {
    applicationName: 'ba-g007-pre-settled-dispatch-complete-first',
    scanFor: [phaseAttestations.execution.rawSecret],
  });
  const settledFinalizer = harness.openInteractivePsql(phaseAttestations.finalizer.login, {
    applicationName: 'ba-g007-pre-settled-finalizer-after-complete',
    scanFor: [phaseAttestations.finalizer.rawSecret],
  });
  const settledDispatcherPid = await settledDispatcher.backendPid();
  const settledFinalizerPid = await settledFinalizer.backendPid();
  let settledCompletion;
  let settledFinalization;
  const settledFailures = [];
  try {
    settledCompletion = parseLastJson(
      await settledDispatcher.execute(
        establishWithAttestationSql(
          phaseAttestations.execution,
          'execution',
          `SELECT app.complete_run_dispatch(${jsonb({
            lease_fencing_token: settledAuthority.lease_fencing_token,
            lease_token: settledAuthority.lease_token,
            outbox_id: settled.dispatch,
            run_id: settled.run,
          })});`,
        ).replace(/\nCOMMIT;$/u, ''),
      ),
      'pre-settled dispatch completion',
    );
    const finalizationPromise = settledFinalizer.execute(
      establishWithAttestationSql(
        phaseAttestations.finalizer,
        'finalizer',
        `SELECT app.finalize_claimed_run(${jsonb({
          cancel_event_id: settled.cancelEvent,
          run_id: settled.run,
        })});`,
      ).replace(/\nCOMMIT;$/u, ''),
      { timeoutMs: 10_000 },
    );
    await harness.waitForBlockingEdge(settledFinalizerPid, settledDispatcherPid, {
      context: 'pre-settled finalizer waits behind dispatcher-first DELIVERED transition',
      timeoutMs: 5_000,
    });
    await settledDispatcher.execute('COMMIT;');
    settledFinalization = parseLastJson(
      await finalizationPromise,
      'pre-settled finalization after delivery',
    );
    await settledFinalizer.execute('COMMIT;');
  } catch (error) {
    settledFailures.push(error);
  }
  for (const [session, label] of [
    [settledDispatcher, 'pre-settled dispatcher'],
    [settledFinalizer, 'pre-settled finalizer'],
  ]) {
    try {
      const metadata = await session.close();
      assertEqual(
        `${String(metadata.rawScan.leakDetected)}|${String(metadata.rawScan.count)}`,
        'false|0',
        `${label} does not echo its raw attestation`,
      );
    } catch (error) {
      settledFailures.push(error);
    }
  }
  if (settledFailures.length === 1) throw settledFailures[0];
  if (settledFailures.length > 1) {
    throw new AggregateError(
      settledFailures,
      'pre-settled dispatch-first finalization cleanup failed',
    );
  }
  assertEqual(
    `${settledCompletion?.status}|${settledCompletion?.delivery_generation}|${settledFinalization?.status}|${settledFinalization?.billing_state}`,
    'DELIVERED|1|CANCELLED|SETTLED',
    'dispatcher-first delivery remains immutable while pre-settled cancel terminalizes without finance',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT status || ':' || delivery_generation FROM public.outbox
     WHERE workspace_id = '${ids.workspace}' AND id = '${settled.dispatch}'),
  (SELECT count(*) FROM public.run_dispatch_retirement_receipts
     WHERE workspace_id = '${ids.workspace}' AND outbox_id = '${settled.dispatch}'),
  (SELECT status || ':' || settled_credits || ':' || released_credits
     FROM public.credit_reservations WHERE workspace_id = '${ids.workspace}'
       AND id = '${settled.reservation}'),
  (SELECT count(*) FROM public.credits_ledger WHERE workspace_id = '${ids.workspace}'
     AND run_id = '${settled.run}'),
  (SELECT count(*) FROM public.run_billing_authority_receipts
     WHERE workspace_id = '${ids.workspace}' AND run_id = '${settled.run}')
);`,
    ),
    'DELIVERED:1|0|SETTLED:0:0|1|0',
    'pre-settled no-financial branch preserves the delivered row and existing ledger proof only',
  );
  const deliveredDigest = await runtimeDigest();
  await assertPhaseRejected(
    'execution',
    `SELECT app.claim_run_dispatch(${jsonb({
      duration_seconds: 30,
      outbox_id: settled.dispatch,
      run_id: settled.run,
    })});`,
    /cannot admit|not claimable|55000/u,
    'a later dispatcher cannot claim an already delivered terminal Run',
  );
  assertEqual(
    await runtimeDigest(),
    deliveredDigest,
    'post-terminal claim rejection cannot rewrite the delivered dispatch',
  );

  const releasedFact = { cancel_event_id: released.cancelEvent, run_id: released.run };
  await assertFinalizerOuterRollback(
    'finalize_claimed_run',
    releasedFact,
    'pre-released PENDING-dispatch finalizer',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|', status, delivery_generation, lease_owner IS NULL,
  lease_token IS NULL, lease_fencing_token IS NULL, lease_expires_at IS NULL,
  (SELECT count(*) FROM public.run_dispatch_retirement_receipts AS receipt
   WHERE receipt.workspace_id = message.workspace_id AND receipt.outbox_id = message.id))
FROM public.outbox AS message
WHERE workspace_id = '${ids.workspace}' AND id = '${released.dispatch}';`,
    ),
    'PENDING|0|t|t|t|t|0',
    'outer rollback restores the complete initial PENDING dispatch tuple and removes its receipt',
  );
  const releasedFinalizer = harness.openInteractivePsql(phaseAttestations.finalizer.login, {
    applicationName: 'ba-g007-pre-released-finalizer-first',
    scanFor: [phaseAttestations.finalizer.rawSecret],
  });
  const releasedClaimant = harness.openInteractivePsql(phaseAttestations.execution.login, {
    applicationName: 'ba-g007-pre-released-dispatch-claim-loser',
    scanFor: [phaseAttestations.execution.rawSecret],
  });
  const releasedFinalizerPid = await releasedFinalizer.backendPid();
  const releasedClaimantPid = await releasedClaimant.backendPid();
  let releasedFinalization;
  let releasedClaimOutcome;
  const releasedFailures = [];
  try {
    releasedFinalization = parseLastJson(
      await releasedFinalizer.execute(
        establishWithAttestationSql(
          phaseAttestations.finalizer,
          'finalizer',
          `SELECT app.finalize_claimed_run(${jsonb(releasedFact)});`,
        ).replace(/\nCOMMIT;$/u, ''),
      ),
      'pre-released finalizer-first terminal',
    );
    const claimPromise = releasedClaimant
      .execute(
        establishWithAttestationSql(
          phaseAttestations.execution,
          'execution',
          `SELECT app.claim_run_dispatch(${jsonb({
            duration_seconds: 30,
            outbox_id: released.dispatch,
            run_id: released.run,
          })});`,
        ).replace(/\nCOMMIT;$/u, ''),
        { timeoutMs: 10_000 },
      )
      .then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ reason, status: 'rejected' }),
      );
    await harness.waitForBlockingEdge(releasedClaimantPid, releasedFinalizerPid, {
      context: 'PENDING dispatch claimant waits behind finalizer-first terminal retirement',
      timeoutMs: 5_000,
    });
    await releasedFinalizer.execute('COMMIT;');
    releasedClaimOutcome = await claimPromise;
  } catch (error) {
    releasedFailures.push(error);
  }
  for (const [session, label] of [
    [releasedFinalizer, 'pre-released finalizer'],
    [releasedClaimant, 'pre-released claim loser'],
  ]) {
    try {
      const metadata = await session.close();
      assertEqual(
        `${String(metadata.rawScan.leakDetected)}|${String(metadata.rawScan.count)}`,
        'false|0',
        `${label} does not echo its raw attestation`,
      );
    } catch (error) {
      releasedFailures.push(error);
    }
  }
  if (releasedFailures.length === 1) throw releasedFailures[0];
  if (releasedFailures.length > 1) {
    throw new AggregateError(
      releasedFailures,
      'pre-released finalizer-first dispatch cleanup failed',
    );
  }
  assertEqual(
    `${releasedFinalization?.status}|${releasedFinalization?.billing_state}|${releasedClaimOutcome?.status}`,
    'CANCELLED|SETTLED|rejected',
    'finalizer-first PENDING retirement has one terminal winner and one rejected dispatcher',
  );
  assertErrorMatches(
    releasedClaimOutcome?.reason,
    /cannot admit|not claimable|55000/u,
    'blocked PENDING claim observes the committed terminal Run',
  );
  await assertDispatchRetirementReceipt(
    released.dispatch,
    {
      last_error_code: 'RUN_TERMINATED_BEFORE_DISPATCH',
      new_delivery_generation: '0',
      old_delivery_generation: '0',
      old_lease_expires_at: undefined,
      old_lease_fencing_token: undefined,
      old_lease_owner: undefined,
      old_lease_token: undefined,
      old_status: 'PENDING',
      outbox_id: released.dispatch,
      retired_status: 'DEAD',
      run_id: released.run,
      terminal_intent_sha256: releasedFinalization?.terminal_intent_hash,
      terminal_source_id: released.cancelEvent,
      terminal_source_kind: 'DURABLE_CANCEL',
      workspace_id: ids.workspace,
    },
    'pre-released PENDING retirement receipt',
  );

  const expiredAuthority = await phaseJsonCall('execution', 'claim_run_dispatch', {
    duration_seconds: 30,
    outbox_id: expired.dispatch,
    run_id: expired.run,
  });
  const expiredFact = { cancel_event_id: expired.cancelEvent, run_id: expired.run };
  await assertFinalizerOuterRollback(
    'finalize_claimed_run',
    expiredFact,
    'pre-expired active-dispatch finalizer',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|', status, delivery_generation, lease_owner,
  lease_token = '${expiredAuthority.lease_token}', lease_fencing_token,
  lease_expires_at = '${expiredAuthority.lease_expires_at}'::timestamptz,
  (SELECT count(*) FROM public.run_dispatch_retirement_receipts AS receipt
   WHERE receipt.workspace_id = message.workspace_id AND receipt.outbox_id = message.id))
FROM public.outbox AS message
WHERE workspace_id = '${ids.workspace}' AND id = '${expired.dispatch}';`,
    ),
    'LEASED|1|ba_execution_test|t|1|t|0',
    'outer rollback restores the complete active dispatch lease and removes its retirement receipt',
  );
  const expiredFinalizer = harness.openInteractivePsql(phaseAttestations.finalizer.login, {
    applicationName: 'ba-g007-pre-expired-active-finalizer-first',
    scanFor: [phaseAttestations.finalizer.rawSecret],
  });
  const expiredDispatcher = harness.openInteractivePsql(phaseAttestations.execution.login, {
    applicationName: 'ba-g007-pre-expired-dispatch-fail-loser',
    scanFor: [phaseAttestations.execution.rawSecret],
  });
  const expiredFinalizerPid = await expiredFinalizer.backendPid();
  const expiredDispatcherPid = await expiredDispatcher.backendPid();
  let expiredFinalization;
  let expiredFailOutcome;
  const expiredFailures = [];
  try {
    expiredFinalization = parseLastJson(
      await expiredFinalizer.execute(
        establishWithAttestationSql(
          phaseAttestations.finalizer,
          'finalizer',
          `SELECT app.finalize_claimed_run(${jsonb(expiredFact)});`,
        ).replace(/\nCOMMIT;$/u, ''),
      ),
      'pre-expired finalizer-first terminal',
    );
    const failPromise = expiredDispatcher
      .execute(
        establishWithAttestationSql(
          phaseAttestations.execution,
          'execution',
          `SELECT app.fail_run_dispatch(${jsonb({
            disposition: 'RETRY',
            error_code: 'G007_RETRYABLE_FAILURE',
            lease_fencing_token: expiredAuthority.lease_fencing_token,
            lease_token: expiredAuthority.lease_token,
            outbox_id: expired.dispatch,
            run_id: expired.run,
          })});`,
        ).replace(/\nCOMMIT;$/u, ''),
        { timeoutMs: 10_000 },
      )
      .then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ reason, status: 'rejected' }),
      );
    await harness.waitForBlockingEdge(expiredDispatcherPid, expiredFinalizerPid, {
      context: 'active dispatcher fail waits behind finalizer-first lease retirement',
      timeoutMs: 5_000,
    });
    await expiredFinalizer.execute('COMMIT;');
    expiredFailOutcome = await failPromise;
  } catch (error) {
    expiredFailures.push(error);
  }
  for (const [session, label] of [
    [expiredFinalizer, 'pre-expired active finalizer'],
    [expiredDispatcher, 'pre-expired dispatch fail loser'],
  ]) {
    try {
      const metadata = await session.close();
      assertEqual(
        `${String(metadata.rawScan.leakDetected)}|${String(metadata.rawScan.count)}`,
        'false|0',
        `${label} does not echo its raw attestation`,
      );
    } catch (error) {
      expiredFailures.push(error);
    }
  }
  if (expiredFailures.length === 1) throw expiredFailures[0];
  if (expiredFailures.length > 1) {
    throw new AggregateError(
      expiredFailures,
      'pre-expired finalizer-first dispatch cleanup failed',
    );
  }
  assertEqual(
    `${expiredFinalization?.status}|${expiredFinalization?.billing_state}|${expiredFailOutcome?.status}`,
    'CANCELLED|SETTLED|rejected',
    'finalizer-first active lease retirement rejects the stale dispatcher fail',
  );
  assertErrorMatches(
    expiredFailOutcome?.reason,
    /terminal|missing, stale|cannot|42501|55000/u,
    'blocked dispatcher fail rechecks the terminal Run and retired lease tuple',
  );
  await assertDispatchRetirementReceipt(
    expired.dispatch,
    {
      last_error_code: 'RUN_TERMINATED_BEFORE_DISPATCH',
      new_delivery_generation: '2',
      old_delivery_generation: '1',
      old_lease_expires_at: expiredAuthority.lease_expires_at,
      old_lease_fencing_token: '1',
      old_lease_owner: 'ba_execution_test',
      old_lease_token: expiredAuthority.lease_token,
      old_status: 'LEASED',
      outbox_id: expired.dispatch,
      retired_status: 'DEAD',
      run_id: expired.run,
      terminal_intent_sha256: expiredFinalization?.terminal_intent_hash,
      terminal_source_id: expired.cancelEvent,
      terminal_source_kind: 'DURABLE_CANCEL',
      workspace_id: ids.workspace,
    },
    'pre-expired active lease retirement receipt',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.credits_ledger WHERE workspace_id = '${ids.workspace}'
     AND run_id = ANY (ARRAY[${noFinancialFixtures
       .map(({ run }) => sqlLiteral(run))
       .join(', ')}]::uuid[])),
  (SELECT count(*) FROM public.run_billing_authority_receipts
     WHERE workspace_id = '${ids.workspace}'
       AND run_id = ANY (ARRAY[${noFinancialFixtures
         .map(({ run }) => sqlLiteral(run))
         .join(', ')}]::uuid[])),
  (SELECT count(*) FROM public.finalizer_transaction_claims
     WHERE workspace_id = '${ids.workspace}')
);`,
    ),
    '3|0|0',
    'SETTLED/RELEASED/EXPIRED terminal branches preserve only their three pre-existing proof ledgers',
  );
}

async function assertFinalizerFirstTicketRetirement(recoveryEvidence) {
  const fact = {
    cancel_event_id: ids.retirementCancelEvent,
    run_id: ids.retirementRun,
  };
  await assertFinalizerOuterRollback('finalize_claimed_run', fact, 'terminal-retirement finalizer');
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT status || ':' || lease_generation || ':' || recovery_ticket_id
     FROM public.run_attempts WHERE workspace_id = '${ids.workspace}'
       AND id = '${ids.retirementAttempt}'),
  (SELECT count(*) FROM public.run_recovery_ticket_dispositions
     WHERE workspace_id = '${ids.workspace}'
       AND recovery_ticket_id = '${recoveryEvidence.retirementTicket.recovery_ticket_id}')
);`,
    ),
    `PENDING:2:${recoveryEvidence.retirementTicket.recovery_ticket_id}|0`,
    'outer rollback leaves the exact CLOSED N+1 recovery ticket claimable',
  );

  const finalizerAttestation = phaseAttestations.finalizer;
  const execution = phaseAttestations.execution;
  const finalizer = harness.openInteractivePsql(finalizerAttestation.login, {
    applicationName: 'ba-g007-terminal-retirement-finalizer-first',
    scanFor: [finalizerAttestation.rawSecret],
  });
  const claimant = harness.openInteractivePsql(execution.login, {
    applicationName: 'ba-g007-terminal-retirement-claim-loser',
    scanFor: [execution.rawSecret],
  });
  const finalizerPid = await finalizer.backendPid();
  const claimantPid = await claimant.backendPid();
  let finalized;
  let claimOutcome;
  const failures = [];
  try {
    finalized = parseLastJson(
      await finalizer.execute(
        establishWithAttestationSql(
          finalizerAttestation,
          'finalizer',
          `SELECT app.finalize_claimed_run(${jsonb(fact)});`,
        ).replace(/\nCOMMIT;$/u, ''),
      ),
      'terminal-retirement finalizer winner',
    );
    const claimPromise = claimant
      .execute(
        establishWithAttestationSql(
          execution,
          'execution',
          `SELECT app.claim_run_attempt(${jsonb({
            attempt_id: ids.retirementAttempt,
            duration_seconds: 30,
            recovery_ticket_id: recoveryEvidence.retirementTicket.recovery_ticket_id,
            run_id: ids.retirementRun,
          })});`,
        ).replace(/\nCOMMIT;$/u, ''),
        { timeoutMs: 10_000 },
      )
      .then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ reason, status: 'rejected' }),
      );
    await harness.waitForBlockingEdge(claimantPid, finalizerPid, {
      context: 'recovery claimant waits behind finalizer-first terminal retirement',
      timeoutMs: 5_000,
    });
    await finalizer.execute('COMMIT;');
    claimOutcome = await claimPromise;
  } catch (error) {
    failures.push(error);
  }
  for (const [session, label] of [
    [finalizer, 'terminal-retirement finalizer'],
    [claimant, 'terminal-retirement claim loser'],
  ]) {
    try {
      const metadata = await session.close();
      assertEqual(
        `${String(metadata.rawScan.leakDetected)}|${String(metadata.rawScan.count)}`,
        'false|0',
        `${label} does not echo the raw attestation`,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'finalizer-first ticket retirement race and cleanup failed');
  }
  assertEqual(
    `${finalized?.status}|${finalized?.billing_state}|${String(finalized?.replayed)}|${claimOutcome?.status}`,
    'CANCELLED|SETTLED|false|rejected',
    'finalizer-first commit retires the N+1 ticket before the blocked recovery claimant resumes',
  );
  assertErrorMatches(
    claimOutcome?.reason,
    /cannot admit a new Attempt|recovery ticket is missing or already consumed|55000|42501/u,
    'blocked recovery claim observes the committed terminal Run and retired ticket',
  );
  const replay = await phaseJsonCall('finalizer', 'finalize_claimed_run', fact);
  assertEqual(
    `${replay.terminal_event_id}|${String(replay.replayed)}`,
    `${finalized?.terminal_event_id}|true`,
    'terminal-retirement response-loss retry replays the original tombstone',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT status || ':' || execution_status || ':' || billing_state
     FROM public.runs WHERE workspace_id = '${ids.workspace}' AND id = '${ids.retirementRun}'),
  (SELECT status || ':' || lease_generation || ':' ||
          (lease_token IS NULL)::text || ':' || (recovery_ticket_id IS NULL)::text
     FROM public.run_attempts WHERE workspace_id = '${ids.workspace}'
       AND id = '${ids.retirementAttempt}'),
  (SELECT disposition_kind || ':' || ticket_fencing_token || ':' ||
          (claim_session_user IS NULL)::text || ':' ||
          (recovery_ticket_sha256 = '${recoveryEvidence.retirementFence.recovery_ticket_sha256}')::text || ':' ||
          terminal_source_kind || ':' || terminal_source_id || ':' ||
          (terminal_source_sha256 ~ '^sha256:[0-9a-f]{64}$')::text || ':' ||
          (terminal_intent_sha256 = (SELECT terminal_intent_hash FROM public.runs
              WHERE workspace_id = '${ids.workspace}' AND id = '${ids.retirementRun}'))::text
          || ':' || terminal_resource_status
     FROM public.run_recovery_ticket_dispositions
     WHERE workspace_id = '${ids.workspace}'
       AND recovery_ticket_id = '${recoveryEvidence.retirementTicket.recovery_ticket_id}'),
  (SELECT status || ':' || released_credits FROM public.credit_reservations
     WHERE workspace_id = '${ids.workspace}' AND id = '${ids.retirementReservation}'),
  (SELECT status || ':' || delivery_generation FROM public.outbox
     WHERE workspace_id = '${ids.workspace}' AND id = '${ids.retirementDispatch}'),
  (SELECT count(*) FROM public.run_dispatch_retirement_receipts
     WHERE workspace_id = '${ids.workspace}' AND outbox_id = '${ids.retirementDispatch}'),
  (SELECT count(*) FROM public.finalizer_transaction_claims
     WHERE workspace_id = '${ids.workspace}')
);`,
    ),
    `CANCELLED:CANCELLED:SETTLED|CANCELLED:2:true:true|TERMINAL_RETIRED:2:true:true:DURABLE_CANCEL:${ids.retirementCancelEvent}:true:true:CANCELLED|RELEASED:20|DEAD:0|1|0`,
    'independent finalizer-first readback preserves N+1 and seals the complete terminal disposition provenance',
  );
}

async function assertCommittedLeaseAndCheckpointResponseLoss() {
  const attestation = phaseAttestations.execution;
  const claimSession = harness.openInteractivePsql(attestation.login, {
    applicationName: 'ba-g007-committed-claim-disconnect',
    scanFor: [attestation.rawSecret],
  });
  const claimPid = await claimSession.backendPid();
  const authority = parseLastJson(
    await claimSession.execute(
      establishWithAttestationSql(
        attestation,
        'execution',
        `SELECT app.claim_run_attempt(${jsonb({
          attempt_id: ids.rollbackAttempt,
          duration_seconds: 30,
          run_id: ids.rollbackRun,
        })});`,
      ).replace(/\nCOMMIT;$/u, ''),
    ),
    'committed claim before disconnect',
  );
  await claimSession.execute('COMMIT;');
  const claimMetadata = await claimSession.abruptDisconnect();
  await harness.waitForBackendExit(claimPid, {
    context: 'committed claim client disconnect',
    timeoutMs: 5_000,
  });
  assertEqual(
    `${String(claimMetadata.rawScan.leakDetected)}|${String(claimMetadata.rawScan.count)}`,
    'false|0',
    'post-commit claim disconnect does not echo the raw execution attestation',
  );
  const baseAuthority = {
    attempt_id: ids.rollbackAttempt,
    lease_fencing_token: authority.lease_fencing_token,
    lease_token: authority.lease_token,
    run_id: ids.rollbackRun,
  };
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT status || ':' || lease_generation || ':' || lease_owner || ':' ||
       (lease_token = '${authority.lease_token}')::text
FROM public.run_attempts
WHERE workspace_id = '${ids.workspace}' AND id = '${ids.rollbackAttempt}';`,
    ),
    'RUNNING:1:ba_execution_test:true',
    'client loss after claim commit preserves the database-owned lease',
  );
  const earlyFenceDigest = await runtimeDigest();
  const emptyEffectClosure = await readAttemptEffectClosure(ids.rollbackRun, ids.rollbackAttempt);
  await assertPhaseRejected(
    'reclaimer',
    `SELECT app.fence_expired_run_attempt(${jsonb({
      ...baseAuthority,
      effect_closure: emptyEffectClosure,
    })});`,
    /missing, stale or not expired|42501/u,
    'client loss does not permit recovery fencing before the committed lease expires',
  );
  assertEqual(
    await runtimeDigest(),
    earlyFenceDigest,
    'pre-expiry fence after client loss has zero side effects',
  );

  await phaseJsonCall('execution', 'record_attempt_started', baseAuthority);
  await phaseJsonCall('execution', 'record_step_started', {
    ...baseAuthority,
    input_hash: hash('g007-response-loss-input'),
    step_id: ids.rollbackStep,
    step_key: 'response-loss-step',
  });
  await recordCompletedExecutionEffect(baseAuthority, {
    effectClass: 'SAFE',
    externalReceiptRef: 'fixture://g007/response-loss/effect',
    label: 'response-loss-effect',
    stepId: ids.rollbackStep,
  });

  const checkpointSession = harness.openInteractivePsql(attestation.login, {
    applicationName: 'ba-g007-checkpoint-disconnect',
    scanFor: [attestation.rawSecret],
  });
  const checkpointPid = await checkpointSession.backendPid();
  await checkpointSession.execute(
    establishWithAttestationSql(
      attestation,
      'execution',
      `SELECT app.record_execution_checkpoint(${jsonb({
        ...baseAuthority,
        checkpoint_ref: 'fixture://g007/checkpoint/uncommitted',
        checkpoint_sha256: hash('g007-uncommitted-checkpoint'),
        payload_redacted: { cursor: 'uncommitted' },
        step_id: ids.rollbackStep,
      })});`,
    ).replace(/\nCOMMIT;$/u, ''),
  );
  const checkpointMetadata = await checkpointSession.abruptDisconnect();
  await harness.waitForBackendExit(checkpointPid, {
    context: 'uncommitted checkpoint client disconnect',
    timeoutMs: 5_000,
  });
  assertEqual(
    `${String(checkpointMetadata.rawScan.leakDetected)}|${String(checkpointMetadata.rawScan.count)}`,
    'false|0',
    'uncommitted checkpoint disconnect does not echo the raw execution attestation',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT count(*) FROM public.run_checkpoints
WHERE workspace_id = '${ids.workspace}' AND run_id = '${ids.rollbackRun}';`,
    ),
    '0',
    'checkpoint client loss before commit leaves no recoverable checkpoint',
  );

  const committedCheckpoint = assertExecutionCheckpointProjection(
    await phaseJsonCall('execution', 'record_execution_checkpoint', {
      ...baseAuthority,
      checkpoint_ref: 'fixture://g007/checkpoint/committed',
      checkpoint_sha256: hash('g007-committed-checkpoint'),
      payload_redacted: { cursor: 'committed' },
      step_id: ids.rollbackStep,
    }),
    'committed response-loss checkpoint',
  );
  const finishedAttempt = await phaseJsonCall('execution', 'record_attempt_finished', {
    ...baseAuthority,
    attempt_status: 'FAILED',
  });
  assertEqual(
    `${finishedAttempt.event_type}|${finishedAttempt.attempt_id}`,
    `ATTEMPT_FINISHED|${ids.rollbackAttempt}`,
    'CLOSED effect set permits the leased worker to finish its Attempt',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT status || ':' || lease_generation || ':' || (lease_token IS NULL)::text
     FROM public.run_attempts WHERE workspace_id = '${ids.workspace}'
       AND id = '${ids.rollbackAttempt}'),
  (SELECT producer_session_user || ':' || producer_lease_fencing_token
     FROM public.run_checkpoints WHERE workspace_id = '${ids.workspace}'
       AND id = '${committedCheckpoint.checkpoint_id}')
);`,
    ),
    'FAILED:1:true|ba_execution_test:1',
    'only the committed checkpoint survives and CLOSED effect responsibility permits finish',
  );
}

async function assertFinalRuntimeReadback() {
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT credits_balance || ':' || credits_reserved_balance || ':' || credits_balance_version
     FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT count(*) FROM public.runs WHERE workspace_id = '${ids.workspace}'
     AND status IN ('FAILED', 'CANCELLED', 'NEEDS_ATTENTION')),
  (SELECT count(*) FROM public.run_attempts AS attempt
     JOIN public.runs AS run_row
       ON run_row.workspace_id = attempt.workspace_id AND run_row.id = attempt.run_id
     WHERE attempt.workspace_id = '${ids.workspace}'
       AND run_row.status IN ('FAILED', 'CANCELLED', 'NEEDS_ATTENTION')
       AND (attempt.status IN ('PENDING', 'RUNNING') OR attempt.lease_owner IS NOT NULL
         OR attempt.lease_token IS NOT NULL OR attempt.lease_fencing_token IS NOT NULL
         OR attempt.lease_expires_at IS NOT NULL)),
  (SELECT count(*) FROM public.outbox AS message
     JOIN public.runs AS run_row
       ON run_row.workspace_id = message.workspace_id AND run_row.id = message.run_id
     WHERE message.workspace_id = '${ids.workspace}'
       AND message.message_type = 'RUN_DISPATCH'
       AND run_row.status IN ('FAILED', 'CANCELLED', 'NEEDS_ATTENTION')
       AND message.status IN ('PENDING', 'LEASED')),
  (SELECT count(*) FROM public.run_recovery_tickets AS ticket
     LEFT JOIN public.run_recovery_ticket_dispositions AS disposition
       ON disposition.workspace_id = ticket.workspace_id
      AND disposition.recovery_ticket_id = ticket.id
     WHERE ticket.workspace_id = '${ids.workspace}' AND disposition.id IS NULL),
  (SELECT count(*) FROM public.run_recovery_ticket_dispositions
     WHERE workspace_id = '${ids.workspace}' AND disposition_kind = 'CLAIMED'),
  (SELECT count(*) FROM public.run_recovery_ticket_dispositions
     WHERE workspace_id = '${ids.workspace}' AND disposition_kind = 'TERMINAL_RETIRED'),
  (SELECT count(*) FROM public.run_billing_authority_receipts
     WHERE workspace_id = '${ids.workspace}'),
  (SELECT count(*) FROM public.credits_ledger
     WHERE workspace_id = '${ids.workspace}' AND entry_schema_version = 2),
  (SELECT count(*) FROM public.run_billing_authority_receipts AS receipt
     FULL JOIN (
       SELECT * FROM public.credits_ledger WHERE entry_schema_version = 2
     ) AS ledger
       ON ledger.workspace_id = receipt.workspace_id AND ledger.id = receipt.ledger_entry_id
     WHERE COALESCE(receipt.workspace_id, ledger.workspace_id) = '${ids.workspace}'
       AND (receipt.id IS NULL OR ledger.id IS NULL
         OR receipt.authority_kind IS DISTINCT FROM ledger.authority_kind
         OR receipt.id IS DISTINCT FROM ledger.authority_id)),
  (SELECT count(*) FROM public.run_dispatch_retirement_receipts
     WHERE workspace_id = '${ids.workspace}'),
  (SELECT count(*) FROM public.run_usage_attributions
     WHERE workspace_id = '${ids.workspace}' AND consumed_at IS NULL),
  (SELECT count(*) FROM public.run_termination_intents
     WHERE workspace_id = '${ids.workspace}' AND consumed_at IS NULL),
  (SELECT count(*) FROM public.finalizer_transaction_claims
     WHERE workspace_id = '${ids.workspace}')
);`,
    ),
    '954:40:15|15|0|0|0|2|2|7|7|0|13|1|0|0',
    'independent aggregate readback closes executable authority and the seven-row v2 billing DAG while retaining one reconciled usage source',
  );
  const firstDigest = await runtimeDigest();
  assertEqual(
    await runtimeDigest(),
    firstDigest,
    'independent full-row digest readback is stable without hidden reconciliation writes',
  );
}

async function main() {
  const loadedMigrations = await loadMigrations(migrationDirectory);
  const migrations = selectMigrationMilestone(
    loadedMigrations,
    '005',
    'G0-07 runtime-security integration',
  );
  const expected005 = migrations.find(({ id }) => id === '005');
  if (expected005 === undefined || expected005.name !== 'runtime_security') {
    throw new Error(
      'G0-07 runtime-security suite requires explicit migration 005_runtime_security',
    );
  }

  await harness.start();
  await assert005LegacyBalanceSafeIntegerPreflight(migrations);
  await assert005UpgradeNowaitQuiescence(migrations);
  await assertJsonNumberFinitenessVectors();
  await assert005UsedInstallationDownGuards(migrations);
  await assertCrossLanguageBillingHashVectors();
  await assertEcmaScriptTrimStringBillingBoundaries();
  await assertInteractiveHarness();
  await assertBlockingAndBackendTermination();
  await assertAbruptDisconnectRollsBack();
  await assertInteractiveTimeoutCleansUpBackend();
  await seedRuntimeSecurityWorkspaces();
  await assertAttestationSecurity();
  await assertAttestationRevocationCheckBackstop();
  await assertSafeBalanceVersionCeiling();
  await assertPhaseAclIsolation();
  await seedProtocolV5Facts();
  await seedRemainingPlanFacts();
  await assertMeteringFirstFullSettlementThenTermination();
  await assertClaimRollbackOnDisconnect();
  const attemptAuthority = await assertAttemptClaimLinearization();
  await assert005DownNowaitAgainstRuntimeWriter(migrations, attemptAuthority);
  const primaryDispatchAuthority = await phaseJsonCall('execution', 'claim_run_dispatch', {
    duration_seconds: 30,
    outbox_id: ids.dispatch,
    run_id: ids.run,
  });
  const preExpiryDispatchDigest = await runtimeDigest();
  await assertPhaseRejected(
    'reclaimer',
    `SELECT app.fence_expired_run_dispatch(${jsonb({
      lease_fencing_token: primaryDispatchAuthority.lease_fencing_token,
      lease_token: primaryDispatchAuthority.lease_token,
      outbox_id: ids.dispatch,
      run_id: ids.run,
    })});`,
    /missing, stale or not expired|42501/u,
    'reclaimer cannot fence a freshly issued RUN_DISPATCH lease before database expiry',
  );
  assertEqual(
    await runtimeDigest(),
    preExpiryDispatchDigest,
    'pre-expiry RUN_DISPATCH fence rejection leaves the authority unchanged',
  );
  const executionArtifacts = await assertLeasedExecutionWrites(attemptAuthority);
  await assertCrossAttemptRecoveryCheckpointRejected(executionArtifacts);
  const recoveryBranches = await prepareRecoveryBranches(primaryDispatchAuthority);
  const crossExpiryEvidence = await crossLeaseExpiryUnderLock(
    executionArtifacts.baseAuthority,
    recoveryBranches,
  );
  const recoveryEvidence = await assertRecoveryFencingAndTakeover(
    executionArtifacts.baseAuthority,
    executionArtifacts.effectClosure,
    recoveryBranches,
    crossExpiryEvidence,
  );
  const holdEvidence = await assertCancelHoldRecoveryMatrix(recoveryBranches);
  await assertRecoveryClaimOuterRollback(recoveryEvidence);
  await assertHistoricalAttributionSettlement(executionArtifacts);
  await assertRecoveryClaimFirstFinalizerRace(recoveryEvidence, recoveryBranches);
  const attributedFinalization = await assertAttributedFinalization(
    executionArtifacts,
    recoveryEvidence,
  );
  await assertBillingAuthorityKindOperationMismatch(attributedFinalization.ledger_entry_id);
  await assertFailClosedShapeConstraintVectors(
    executionArtifacts,
    recoveryEvidence,
    attributedFinalization.ledger_entry_id,
  );
  await assertHoldFinalization(recoveryEvidence);
  await assertCancelHoldFinalizationAndMetering(holdEvidence);
  await seedDurableCancellationFacts();
  await assertConcurrentDurableCancelFinalization();
  await assertZeroCreditDurableCancel();
  await assertNoFinancialDispatchLinearization();
  await assertFinalizerFirstTicketRetirement(recoveryEvidence);
  await assertCommittedLeaseAndCheckpointResponseLoss();
  await assertFinalRuntimeReadback();
  process.stdout.write(
    'G0-07 PostgreSQL runtime-security harness passed: interactive transport, attestation, ACL/RLS, lease/finalizer linearization, recovery, dispatch, historical billing, rollback and response-loss paths.\n',
  );
  process.stdout.write('architecture-gate-suite/1 runtime-security pass\n');
}

let mainFailure;
try {
  await main();
} catch (error) {
  mainFailure = error;
}

const cleanup = await Promise.allSettled([harness.stop()]);
const cleanupFailures = cleanup.flatMap((result) =>
  result.status === 'rejected' ? [result.reason] : [],
);
const failures = mainFailure === undefined ? cleanupFailures : [mainFailure, ...cleanupFailures];
if (failures.length === 1) throw failures[0];
if (failures.length > 1) throw new AggregateError(failures, 'runtime-security harness failed');
