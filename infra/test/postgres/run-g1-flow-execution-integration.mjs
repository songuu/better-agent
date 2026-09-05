import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import { canonicalJsonBytes } from '../../../packages/release-core/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrationDirectory = path.resolve(directory, '../../../packages/db/migrations');
const harness = createPostgresHarness('g1-flow-execution');

const id = (n) => `fa100000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ids = Object.freeze({
  workspace: id(1),
  credential: id(2),
  flowDeployment: id(3),
  flowRevision: id(4),
  flow: id(5),
  flowVersion: id(6),
  run: id(7),
  request: id(8),
  attempt: id(9),
  step: id(10),
  startStep: id(18),
  outputStep: id(19),
  reservation: id(11),
  execution: id(12),
  receipt: id(13),
  attestation: id(14),
  planAttestation: id(15),
  revokedPlanAttestation: id(17),
});
const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const canonicalHash = (value) =>
  `sha256:${createHash('sha256').update(canonicalJsonBytes(value)).digest('hex')}`;
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const jsonb = (value) => `${sqlLiteral(JSON.stringify(value))}::jsonb`;
const rawSecret = randomBytes(32).toString('hex');
const subjectBinding = randomBytes(32).toString('hex');
const planVerifier = randomBytes(32).toString('hex');
const wrongPlanVerifier = randomBytes(32).toString('hex');
const revokedPlanVerifier = randomBytes(32).toString('hex');

function establish(body) {
  return `BEGIN;
SELECT auth.establish_internal_service_workspace_context(
  '${ids.attestation}', decode('${rawSecret}', 'hex'), 'execution'
);
${body}
COMMIT;`;
}

async function call(functionName, fact) {
  const result = await harness.psql(
    'ba_execution_test',
    establish(`SELECT app.${functionName}(${jsonb(fact)});`),
    { scanFor: [rawSecret], tuplesOnly: true },
  );
  const line = result.stdout
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .findLast((item) => item.startsWith('{'));
  if (line === undefined) throw new Error(`${functionName} returned no JSON object`);
  return JSON.parse(line);
}

async function reject(functionName, fact, pattern, context) {
  const result = await harness.psql(
    'ba_execution_test',
    establish(`SELECT app.${functionName}(${jsonb(fact)});`),
    { allowFailure: true, scanFor: [rawSecret] },
  );
  assertRejected(result, pattern, context);
}

async function main() {
  const migrations = await loadMigrations(migrationDirectory);
  await harness.start();
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), { echoErrors: true });

  const resolvedPlanHash = sha('flow-resolved-plan');
  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.workspaces (id,name,credits_balance,credits_reserved_balance,credits_balance_version)
VALUES ('${ids.workspace}','G1 Flow execution',1000,100,1);
INSERT INTO public.runs (
  workspace_id,id,billing_owner_run_id,accepted_request_id,accepted_principal_kind,
  accepted_credential_id,fixed_route,intent_hash,admission_snapshot_hash,accepted_plan_hash,
  accepted_output_schema_ref,accepted_output_schema_hash,dependency_pins_hash,target_kind,
  flow_deployment_id,flow_deployment_revision_id,flow_id,flow_version_id,status,
  execution_status,billing_state,acceptance_receipt_data_redacted,last_event_sequence
) VALUES (
  '${ids.workspace}','${ids.run}','${ids.run}','${ids.request}','credential','${ids.credential}',
  '/v1/oapi/flow/run','${sha('intent')}','${sha('admission')}','${resolvedPlanHash}',
  'schema://flow/output','${sha('output-schema')}','${sha('dependencies')}','flow',
  '${ids.flowDeployment}','${ids.flowRevision}','${ids.flow}','${ids.flowVersion}',
  'QUEUED','QUEUED','PENDING','{}'::jsonb,0
);
INSERT INTO public.run_attempts (
  workspace_id,id,run_id,attempt_number,status,runtime_protocol_version,lease_generation
) VALUES ('${ids.workspace}','${ids.attempt}','${ids.run}',1,'PENDING',5,0);
INSERT INTO public.credit_reservations (
  workspace_id,id,run_id,billing_owner_run_id,accepted_plan_hash,status,reserved_credits,
  settled_credits,released_credits,balance_version,expires_at,created_at,updated_at
) VALUES (
  '${ids.workspace}','${ids.reservation}','${ids.run}','${ids.run}','${resolvedPlanHash}',
  'HELD',100,0,0,1,clock_timestamp()+interval '1 hour',clock_timestamp(),clock_timestamp()
);
COMMIT;`,
  );

  await harness.psql(
    'ba_internal_issuer_test',
    `SELECT auth.issue_internal_service_attestation(
  '${ids.attestation}','${ids.workspace}','ba_execution_test'::name,'execution',
  'better-agent/internal-service/1',decode('${subjectBinding}','hex'),
  public.hmac(decode('${rawSecret}','hex'),
    convert_to('better-agent/internal-service-attestation-verifier/1','UTF8') || decode('00','hex'),
    'sha256'),clock_timestamp()+interval '10 minutes'
);`,
    { scanFor: [rawSecret] },
  );

  const authority = await call('claim_run_attempt', {
    run_id: ids.run,
    attempt_id: ids.attempt,
    duration_seconds: 300,
  });
  const leased = {
    run_id: ids.run,
    attempt_id: ids.attempt,
    lease_token: authority.lease_token,
    lease_fencing_token: authority.lease_fencing_token,
  };
  await call('record_attempt_started', leased);
  await call('record_step_started', {
    ...leased,
    step_id: ids.startStep,
    step_key: 'start',
    input_hash: sha('start-input'),
  });

  const model = {
    workspace_id: ids.workspace,
    published_resource_kind: 'SYSTEM_RELEASE',
    resource_id: id(20),
    resource_version_id: id(21),
    contract_hash: sha('model-contract'),
    binding_mode: 'pinned',
  };
  const planDraft = {
    schema_version: 'compiled-flow-plan/1',
    flow_version: {
      workspace_id: ids.workspace,
      published_resource_kind: 'FLOW_VERSION',
      resource_id: ids.flow,
      resource_version_id: ids.flowVersion,
      contract_hash: sha('flow-contract'),
      binding_mode: 'pinned',
    },
    source_semantic_hash: sha('source'),
    capability_closure_hash: sha('closure'),
    resolved_execution_plan_hash: resolvedPlanHash,
    input_schema_hash: sha('input-schema'),
    output_schema_hash: sha('output-schema'),
    checkpoint_contract_version: 'flow-step-checkpoint/1',
    steps: [
      {
        node_id: 'start',
        node_key: 'start',
        canonical_node_path_hash: sha('start-path'),
        topology_rank: 0,
        predecessor_node_ids: [],
        input_bindings: {},
        output_schema_hash: sha('start-output'),
        timeout_ms: 300000,
        node_type: 'start',
      },
      {
        node_id: 'model',
        node_key: 'model',
        canonical_node_path_hash: sha('model-path'),
        topology_rank: 1,
        predecessor_node_ids: ['start'],
        input_bindings: {},
        output_schema_hash: sha('model-output'),
        retry: { max_attempts: 2, backoff: 'fixed' },
        timeout_ms: 300000,
        node_type: 'llm',
        model,
        credential_requirement_id: 'model-credential',
        credential_mapping_hash: sha('mapping'),
        credential_material_identity_hash: sha('material'),
        prompt: { role: 'user', content: 'test' },
        temperature: 0,
        budget: {
          schema_version: 'capability-budget/1',
          amount_credits: '10',
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          duration_ms: 1000,
        },
      },
      {
        node_id: 'output',
        node_key: 'output',
        canonical_node_path_hash: sha('output-path'),
        topology_rank: 2,
        predecessor_node_ids: ['model'],
        input_bindings: {},
        output_schema_hash: sha('output-output'),
        timeout_ms: 300000,
        node_type: 'output',
      },
    ],
  };
  const plan = { ...planDraft, compiled_hash: canonicalHash(planDraft) };
  await harness.psql(
    'ba_management_issuer_test',
    `SELECT auth.issue_flow_execution_plan_attestation(
  '${ids.revokedPlanAttestation}','${ids.workspace}','${ids.run}','${ids.execution}',
  'ba_execution_test'::name,${jsonb(plan)},decode('${revokedPlanVerifier}','hex'),
  clock_timestamp()+interval '10 minutes'
);
SELECT auth.revoke_flow_execution_plan_attestation(
  '${ids.revokedPlanAttestation}','integration revocation'
);`,
    { scanFor: [revokedPlanVerifier] },
  );
  await reject(
    'register_flow_execution',
    {
      ...leased,
      flow_execution_id: ids.execution,
      compiled_flow_plan: plan,
      plan_attestation_id: ids.revokedPlanAttestation,
      plan_attestation_verifier: revokedPlanVerifier,
    },
    /attestation is unavailable|42501/u,
    'revoked FlowPlan reviewer proof is rejected',
  );
  await harness.psql(
    'ba_management_issuer_test',
    `SELECT auth.issue_flow_execution_plan_attestation(
  '${ids.planAttestation}','${ids.workspace}','${ids.run}','${ids.execution}',
  'ba_execution_test'::name,${jsonb(plan)},decode('${planVerifier}','hex'),
  clock_timestamp()+interval '10 minutes'
);`,
    { scanFor: [planVerifier] },
  );
  await reject(
    'register_flow_execution',
    {
      ...leased,
      flow_execution_id: ids.execution,
      compiled_flow_plan: plan,
      plan_attestation_id: ids.planAttestation,
      plan_attestation_verifier: wrongPlanVerifier,
    },
    /attestation is unavailable|42501/u,
    'wrong FlowPlan reviewer verifier is rejected',
  );
  const registration = await call('register_flow_execution', {
    ...leased,
    flow_execution_id: ids.execution,
    compiled_flow_plan: plan,
    plan_attestation_id: ids.planAttestation,
    plan_attestation_verifier: planVerifier,
  });
  assertEqual(
    `${registration.compiled_flow_plan_hash}|${String(registration.replayed)}`,
    `${plan.compiled_hash}|false`,
    'Flow execution binds exact plan once',
  );
  const replayRegistration = await call('register_flow_execution', {
    ...leased,
    flow_execution_id: ids.execution,
    compiled_flow_plan: plan,
    plan_attestation_id: ids.planAttestation,
    plan_attestation_verifier: planVerifier,
  });
  assertEqual(
    String(replayRegistration.replayed),
    'true',
    'Flow execution registration replays exactly',
  );

  const startCheckpointDraft = {
    schema_version: 'flow-step-checkpoint/1',
    run_id: ids.run,
    flow_execution_id: ids.execution,
    flow_plan_hash: plan.compiled_hash,
    checkpoint_sequence: '1',
    execution_fence: String(authority.lease_fencing_token),
    node_id: 'start',
    node_type: 'start',
    canonical_node_path_hash: sha('start-path'),
    attempt: 1,
    predecessor_checkpoint_hashes: [],
    output_ref: 'snapshot://g1-flow/start',
    output_hash: sha('start-result'),
  };
  const startCheckpoint = {
    ...startCheckpointDraft,
    checkpoint_hash: canonicalHash(startCheckpointDraft),
  };
  const startCheckpointResult = await call('record_flow_step_checkpoint', {
    ...leased,
    step_id: ids.startStep,
    checkpoint: startCheckpoint,
  });
  assertEqual(String(startCheckpointResult.replayed), 'false', 'Start checkpoint commits once');
  await call('record_step_finished', {
    ...leased,
    step_id: ids.startStep,
    step_status: 'SUCCEEDED',
    output_hash: startCheckpoint.output_hash,
  });
  await call('record_step_started', {
    ...leased,
    step_id: ids.step,
    step_key: 'model',
    input_hash: sha('model-input'),
  });

  const operationKey = `flow-llm:v1:${sha('operation').slice(7)}`;
  const providerRequestHash = sha('provider-request');
  const resultPayloadHash = sha('provider-result');
  const envelope = await call('record_execution_effect_envelope', {
    ...leased,
    step_id: ids.step,
    effect_class: 'REQUIRES_KEY',
    operation_key: operationKey,
    operation_intent_sha256: sha('operation-intent'),
    effect_payload_sha256: providerRequestHash,
  });
  await call('record_execution_effect_receipt', {
    ...leased,
    step_id: ids.step,
    retry_effect_envelope_id: envelope.envelope_id,
    retry_effect_envelope_sha256: envelope.envelope_sha256,
    outcome: 'CONFIRMED',
    external_receipt_ref: 'fixture://g1-flow/model-result',
    external_receipt_sha256: sha('provider-receipt'),
    result_payload_sha256: resultPayloadHash,
  });
  const receiptDraft = {
    schema_version: 'flow-model-usage-receipt/1',
    model_usage_receipt_id: ids.receipt,
    run_id: ids.run,
    flow_execution_id: ids.execution,
    flow_plan_hash: plan.compiled_hash,
    node_id: 'model',
    canonical_node_path_hash: sha('model-path'),
    model,
    model_attempt_number: 1,
    operation_key: operationKey,
    provider_request_hash: providerRequestHash,
    result_payload_hash: resultPayloadHash,
    usage: {
      schema_version: 'capability-budget/1',
      amount_credits: '4',
      input_tokens: 60,
      output_tokens: 20,
      total_tokens: 80,
      duration_ms: 700,
    },
  };
  const receipt = { ...receiptDraft, receipt_hash: canonicalHash(receiptDraft) };
  const usageFact = { ...leased, reservation_id: ids.reservation, step_id: ids.step, receipt };
  const recorded = await call('record_flow_model_usage_receipt', usageFact);
  assertEqual(String(recorded.replayed), 'false', 'first Flow model receipt records usage');
  const replayed = await call('record_flow_model_usage_receipt', usageFact);
  assertEqual(
    `${replayed.usage_attribution_id}|${String(replayed.replayed)}`,
    `${recorded.usage_attribution_id}|true`,
    'same model key replays one usage fact',
  );
  const modelCheckpointDraft = {
    schema_version: 'flow-step-checkpoint/1',
    run_id: ids.run,
    flow_execution_id: ids.execution,
    flow_plan_hash: plan.compiled_hash,
    checkpoint_sequence: '2',
    previous_checkpoint_hash: startCheckpoint.checkpoint_hash,
    execution_fence: String(authority.lease_fencing_token),
    node_id: 'model',
    node_type: 'llm',
    canonical_node_path_hash: sha('model-path'),
    attempt: 1,
    predecessor_checkpoint_hashes: [startCheckpoint.checkpoint_hash],
    output_ref: 'snapshot://g1-flow/model',
    output_hash: resultPayloadHash,
    model_usage_receipt_id: ids.receipt,
    model_usage_receipt_hash: receipt.receipt_hash,
  };
  const modelCheckpoint = {
    ...modelCheckpointDraft,
    checkpoint_hash: canonicalHash(modelCheckpointDraft),
  };
  const wrongPredecessorDraft = {
    ...modelCheckpointDraft,
    predecessor_checkpoint_hashes: [sha('foreign-start-checkpoint')],
  };
  await reject(
    'record_flow_step_checkpoint',
    {
      ...leased,
      step_id: ids.step,
      checkpoint: {
        ...wrongPredecessorDraft,
        checkpoint_hash: canonicalHash(wrongPredecessorDraft),
      },
    },
    /predecessor is missing, foreign or stale|55000/u,
    'LLM checkpoint cannot borrow a foreign predecessor',
  );
  const modelCheckpointResult = await call('record_flow_step_checkpoint', {
    ...leased,
    step_id: ids.step,
    checkpoint: modelCheckpoint,
  });
  assertEqual(String(modelCheckpointResult.replayed), 'false', 'LLM checkpoint commits once');
  await call('record_step_finished', {
    ...leased,
    step_id: ids.step,
    step_status: 'SUCCEEDED',
    output_hash: modelCheckpoint.output_hash,
  });
  await call('record_step_started', {
    ...leased,
    step_id: ids.outputStep,
    step_key: 'output',
    input_hash: modelCheckpoint.output_hash,
  });
  const outputCheckpointDraft = {
    schema_version: 'flow-step-checkpoint/1',
    run_id: ids.run,
    flow_execution_id: ids.execution,
    flow_plan_hash: plan.compiled_hash,
    checkpoint_sequence: '3',
    previous_checkpoint_hash: modelCheckpoint.checkpoint_hash,
    execution_fence: String(authority.lease_fencing_token),
    node_id: 'output',
    node_type: 'output',
    canonical_node_path_hash: sha('output-path'),
    attempt: 1,
    predecessor_checkpoint_hashes: [modelCheckpoint.checkpoint_hash],
    output_ref: 'snapshot://g1-flow/output',
    output_hash: sha('flow-output'),
  };
  const outputCheckpoint = {
    ...outputCheckpointDraft,
    checkpoint_hash: canonicalHash(outputCheckpointDraft),
  };
  const outputCheckpointResult = await call('record_flow_step_checkpoint', {
    ...leased,
    step_id: ids.outputStep,
    checkpoint: outputCheckpoint,
  });
  assertEqual(String(outputCheckpointResult.replayed), 'false', 'Output checkpoint commits once');
  await call('record_step_finished', {
    ...leased,
    step_id: ids.outputStep,
    step_status: 'SUCCEEDED',
    output_hash: outputCheckpoint.output_hash,
  });

  const overBudgetDraft = {
    ...receiptDraft,
    model_usage_receipt_id: id(16),
    operation_key: `flow-llm:v1:${sha('over-budget-operation').slice(7)}`,
    usage: { ...receiptDraft.usage, duration_ms: 1001 },
  };
  await reject(
    'record_flow_model_usage_receipt',
    {
      ...leased,
      reservation_id: ids.reservation,
      step_id: ids.step,
      receipt: { ...overBudgetDraft, receipt_hash: canonicalHash(overBudgetDraft) },
    },
    /exceeds or differs|55000/u,
    'over-budget model receipt is rejected',
  );
  await harness.psql(
    'ba_bootstrap_test',
    `UPDATE public.run_attempts
SET status='SUCCEEDED',lease_owner=NULL,lease_token=NULL,lease_fencing_token=NULL,
    lease_expires_at=NULL,recovery_ticket_id=NULL,updated_at=clock_timestamp()
WHERE workspace_id='${ids.workspace}' AND id='${ids.attempt}';`,
  );
  const replayAfterAuthorityLoss = await call('record_flow_model_usage_receipt', usageFact);
  assertEqual(
    `${replayAfterAuthorityLoss.usage_attribution_id}|${String(replayAfterAuthorityLoss.replayed)}`,
    `${recorded.usage_attribution_id}|true`,
    'committed Flow usage replays after execution authority is gone',
  );
  const checkpointReplayAfterAuthorityLoss = await call('record_flow_step_checkpoint', {
    ...leased,
    step_id: ids.outputStep,
    checkpoint: outputCheckpoint,
  });
  assertEqual(
    `${checkpointReplayAfterAuthorityLoss.run_checkpoint_id}|${String(checkpointReplayAfterAuthorityLoss.replayed)}`,
    `${outputCheckpointResult.run_checkpoint_id}|true`,
    'committed Flow checkpoint replays after execution authority is gone',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.flow_executions WHERE workspace_id='${ids.workspace}'),
  (SELECT count(*) FROM public.flow_model_usage_receipts WHERE workspace_id='${ids.workspace}'),
  (SELECT count(*) FROM public.run_usage_attributions WHERE workspace_id='${ids.workspace}'),
  (SELECT count(*) FROM public.flow_step_checkpoints WHERE workspace_id='${ids.workspace}'),
  (SELECT count(*) FROM public.run_checkpoints WHERE workspace_id='${ids.workspace}'),
  (SELECT count(*) FROM auth.flow_execution_plan_attestations
    WHERE workspace_id='${ids.workspace}' AND consumed_at IS NOT NULL)
);`,
    ),
    '1|1|1|3|3|1',
    'Flow receipt and generic billing attribution are exactly-once',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT NOT has_table_privilege('ba_execution_test','public.flow_executions','SELECT,INSERT,UPDATE,DELETE')
AND NOT has_table_privilege('ba_execution_test','public.flow_model_usage_receipts','SELECT,INSERT,UPDATE,DELETE')
AND NOT has_table_privilege('ba_execution_test','public.flow_step_checkpoints','SELECT,INSERT,UPDATE,DELETE')
AND NOT has_table_privilege('ba_execution_test','auth.flow_execution_plan_attestations','SELECT,INSERT,UPDATE,DELETE');`,
    ),
    't',
    'execution login has no direct Flow fact DML',
  );
  process.stdout.write(
    'PostgreSQL 16 G1-A2 Flow execution passed: exact plan binding, confirmed-effect receipt, budget enforcement, atomic usage and exact replay.\n',
  );
  process.stdout.write('architecture-gate-suite/1 g1-flow-execution pass\n');
}

let failure;
try {
  await main();
} catch (error) {
  failure = error;
}
try {
  await harness.stop();
} catch (error) {
  failure =
    failure === undefined
      ? error
      : new AggregateError([failure, error], 'Flow integration and cleanup failed');
}
if (failure !== undefined) throw failure;
