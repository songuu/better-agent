import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrationDirectory = path.resolve(directory, '../../../packages/db/migrations');
const harness = createPostgresHarness('g1-worker-human-gate');
const id = (n) => `fd500000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ids = Object.freeze({
  admin: id(0),
  workspace: id(1),
  credential: id(2),
  key: id(3),
  flow: id(4),
  deployment: id(5),
  readGrant: id(6),
  resumeGrant: id(7),
  run: id(10),
  request: id(11),
  checkpoint1: id(12),
  gate1: id(13),
  checkpoint2: id(14),
  gate2: id(15),
  raceRun: id(20),
  raceRequest: id(21),
  raceCheckpoint: id(22),
  raceGate: id(23),
  controlAttestation: id(24),
});
const verifier = randomBytes(32).toString('hex');
const controlVerifier = randomBytes(32).toString('hex');
const controlSubject = randomBytes(32).toString('hex');
const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const jsonb = (value) => `${sqlLiteral(JSON.stringify(value))}::jsonb`;

function runtime(sql) {
  return `BEGIN;
DO $auth$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.authenticate_api_credential(
    '${ids.key}',decode('${verifier}','hex')
  )) THEN RAISE EXCEPTION 'fixture credential failed authentication'; END IF;
END;
$auth$;
${sql}
COMMIT;`;
}

function runRow(runId, requestId, planLabel) {
  return `(
    '${ids.workspace}','${runId}','${runId}','${requestId}','credential','${ids.credential}',
    '/v1/oapi/flow/run','${sha(`intent-${planLabel}`)}','${sha(`admission-${planLabel}`)}',
    '${sha(`plan-${planLabel}`)}','schema://flow/output','${sha(`output-${planLabel}`)}',
    '${sha(`dependencies-${planLabel}`)}','flow','${ids.deployment}','${id(100)}',
    '${ids.flow}','${id(101)}','WAITING_FOR_APPROVAL','WAITING_FOR_APPROVAL','PENDING',
    '{}'::jsonb,1
  )`;
}

function gateCommand(runId, gateId, key, action) {
  return {
    action,
    authenticatedPrincipal: {
      credential_id: ids.credential,
      kind: 'credential',
      schema_version: 'conversation-principal/1',
    },
    browserIdentity: null,
    gateId,
    idempotencyKey: key,
    requiredScope: 'run:resume',
    runId,
    workspaceId: ids.workspace,
  };
}

async function resume(role, command) {
  return JSON.parse(
    await harness.queryScalar(role, runtime(`SELECT app.resume_human_gate(${jsonb(command)});`)),
  );
}

async function reject(role, command, pattern, context) {
  const result = await harness.psql(
    role,
    runtime(`SELECT app.resume_human_gate(${jsonb(command)});`),
    { allowFailure: true },
  );
  assertRejected(result, pattern, context);
}

async function main() {
  const migrations = await loadMigrations(migrationDirectory);
  await harness.start();
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), { echoErrors: true });
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces (id,name) VALUES ('${ids.workspace}','G1 Human Gate');
INSERT INTO public.workspace_members (workspace_id,user_id,role)
VALUES ('${ids.workspace}','${ids.admin}','admin');`,
  );
  await harness.psql(
    'ba_management_issuer_test',
    `SELECT auth.issue_control_session_attestation(
  '${ids.controlAttestation}','${ids.workspace}','${ids.admin}','ba_control_test',
  'g1-human-gate-fixture',decode('${controlSubject}','hex'),decode('${controlVerifier}','hex'),
  clock_timestamp()+interval '10 minutes'
);`,
  );
  await harness.psql(
    'ba_control_test',
    `BEGIN;
SELECT auth.establish_control_workspace_context(
  '${ids.controlAttestation}',decode('${controlVerifier}','hex')
);
SELECT auth.create_api_credential(
  '${ids.credential}','${ids.key}','g1-gate','service_api',decode('${verifier}','hex'),
  ARRAY['run:read','run:resume']::text[],'{}'::text[],NULL,NULL,NULL
);
COMMIT;`,
  );
  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
SET LOCAL session_replication_role=replica;
INSERT INTO public.flow_deployments (
  id,workspace_id,flow_id,public_selector,environment,ingress_channel,created_by
) VALUES (
  '${ids.deployment}','${ids.workspace}','${ids.flow}','g1-gate-flow','staging',
  'service_api','fixture'
);
INSERT INTO public.flow_deployment_security_states (
  workspace_id,flow_deployment_id,status,updated_by
) VALUES ('${ids.workspace}','${ids.deployment}','ACTIVE','fixture');
INSERT INTO public.flow_deployment_entry_grants (
  id,workspace_id,credential_id,flow_deployment_id,credential_kind,principal_mode,
  entry_audience,ingress_channel,scope,target_cardinality,status,created_by
) VALUES
  ('${ids.readGrant}','${ids.workspace}','${ids.credential}','${ids.deployment}',
   'service_api','credential_service_principal','flow_runtime_api','service_api',
   'run:read','exactly_one_flow_deployment','ACTIVE','fixture'),
  ('${ids.resumeGrant}','${ids.workspace}','${ids.credential}','${ids.deployment}',
   'service_api','credential_service_principal','flow_runtime_api','service_api',
   'run:resume','exactly_one_flow_deployment','ACTIVE','fixture');
INSERT INTO public.runs (
  workspace_id,id,billing_owner_run_id,accepted_request_id,accepted_principal_kind,
  accepted_credential_id,fixed_route,intent_hash,admission_snapshot_hash,accepted_plan_hash,
  accepted_output_schema_ref,accepted_output_schema_hash,dependency_pins_hash,target_kind,
  flow_deployment_id,flow_deployment_revision_id,flow_id,flow_version_id,status,
  execution_status,billing_state,acceptance_receipt_data_redacted,last_event_sequence
) VALUES
  ${runRow(ids.run, ids.request, 'ordered')},
  ${runRow(ids.raceRun, ids.raceRequest, 'race')};
INSERT INTO public.run_checkpoints (
  workspace_id,id,run_id,checkpoint_hash,payload_ref,payload_redacted
) VALUES
  ('${ids.workspace}','${ids.checkpoint1}','${ids.run}','${sha('checkpoint-1')}',
   'checkpoint:${ids.checkpoint1}','{}'::jsonb),
  ('${ids.workspace}','${ids.checkpoint2}','${ids.run}','${sha('checkpoint-2')}',
   'checkpoint:${ids.checkpoint2}','{}'::jsonb),
  ('${ids.workspace}','${ids.raceCheckpoint}','${ids.raceRun}','${sha('race-checkpoint')}',
   'checkpoint:${ids.raceCheckpoint}','{}'::jsonb);
INSERT INTO public.human_gates (
  workspace_id,id,run_id,checkpoint_id,gate_type,canonical_operation_hash,
  resolved_plan_hash,barrier_generation,approver_policy_hash,public_schema,status,expires_at
) VALUES
  ('${ids.workspace}','${ids.gate1}','${ids.run}','${ids.checkpoint1}','APPROVAL',
   '${sha('operation-1')}','${sha('plan-ordered')}',1,'${sha('policy-1')}',
   '{}'::jsonb,'PENDING',clock_timestamp()+interval '10 minutes'),
  ('${ids.workspace}','${ids.gate2}','${ids.run}','${ids.checkpoint2}','APPROVAL',
   '${sha('operation-2')}','${sha('plan-ordered')}',2,'${sha('policy-2')}',
   '{}'::jsonb,'PENDING',clock_timestamp()+interval '10 minutes'),
  ('${ids.workspace}','${ids.raceGate}','${ids.raceRun}','${ids.raceCheckpoint}','APPROVAL',
   '${sha('race-operation')}','${sha('plan-race')}',1,'${sha('race-policy')}',
   '{}'::jsonb,'PENDING',clock_timestamp()+interval '10 minutes');
INSERT INTO public.run_events (
  workspace_id,id,run_id,sequence,event_type,dedupe_key,payload_redacted
) VALUES
  ('${ids.workspace}','${id(30)}','${ids.run}',1,'RUN_WAITING','initial-wait',
   '{"type":"run.waiting"}'::jsonb),
  ('${ids.workspace}','${id(31)}','${ids.raceRun}',1,'RUN_WAITING','initial-race-wait',
   '{"type":"run.waiting"}'::jsonb);
COMMIT;`,
  );

  const firstCommand = gateCommand(ids.run, ids.gate1, 'ordered-gate-1', 'approve');
  const first = await resume('ba_runtime_test', firstCommand);
  assertEqual(
    `${first.outcome}|${first.receipt.data.outcome}|${first.receipt.data.pending_action.gate_id}`,
    `ACCEPTED|NEXT_GATE_WAITING|${ids.gate2}`,
    'intermediate approval materializes only the next pending gate',
  );
  const replay = await resume('ba_runtime_other_test', firstCommand);
  assertEqual(
    `${replay.outcome}|${JSON.stringify(replay.receipt)}`,
    `REPLAY|${JSON.stringify(first.receipt)}`,
    'exact Human Gate replay returns the immutable first outcome',
  );
  await reject(
    'ba_runtime_test',
    { ...firstCommand, action: 'reject' },
    /Human Gate Idempotency-Key reused|23505/u,
    'same key cannot change Human Gate disposition',
  );
  const second = await resume(
    'ba_runtime_test',
    gateCommand(ids.run, ids.gate2, 'ordered-gate-2', 'approve'),
  );
  assertEqual(
    `${second.outcome}|${second.receipt.data.outcome}`,
    'ACCEPTED|RUN_RESUMED',
    'final positive approval creates one resumed attempt',
  );

  const raceApprove = gateCommand(ids.raceRun, ids.raceGate, 'race-approve', 'approve');
  const raceReject = gateCommand(ids.raceRun, ids.raceGate, 'race-reject', 'reject');
  const raceResults = await Promise.all([
    harness.psql(
      'ba_runtime_test',
      runtime(`SELECT app.resume_human_gate(${jsonb(raceApprove)});`),
      { allowFailure: true },
    ),
    harness.psql(
      'ba_runtime_other_test',
      runtime(`SELECT app.resume_human_gate(${jsonb(raceReject)});`),
      { allowFailure: true },
    ),
  ]);
  assertEqual(
    String(raceResults.filter((result) => result.exitCode === 0).length),
    '1',
    'concurrent approve/reject has exactly one winner',
  );
  assertRejected(
    raceResults.find((result) => result.exitCode !== 0),
    /Human Gate is not resumable|23505/u,
    'concurrent losing Human Gate disposition is rolled back',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT concat_ws(':',status,execution_status,last_event_sequence) FROM public.runs
    WHERE id='${ids.run}'),
  (SELECT count(*) FROM public.human_gate_evidence WHERE run_id='${ids.run}'),
  (SELECT count(*) FROM public.run_mutation_idempotency WHERE target_run_id='${ids.run}'),
  (SELECT count(*) FROM public.run_attempts WHERE run_id='${ids.run}'),
  (SELECT count(*) FROM public.outbox WHERE run_id='${ids.run}'),
  (SELECT count(*) FROM public.run_mutation_idempotency WHERE target_run_id='${ids.raceRun}'),
  (SELECT count(*) FROM public.human_gate_evidence WHERE run_id='${ids.raceRun}'))`,
    ),
    'RESUMING:RESUMING:3|4|2|1|1|1|2',
    'ordered and racing gates retain exactly one durable fact set per accepted decision',
  );

  await harness.psql(
    'ba_bootstrap_test',
    `UPDATE public.flow_deployment_entry_grants
SET status='REVOKED',authorization_epoch=authorization_epoch+1,revoked_at=clock_timestamp()
WHERE id='${ids.resumeGrant}';`,
  );
  assertEqual(
    (await resume('ba_runtime_test', firstCommand)).outcome,
    'REPLAY',
    'historical key replay ignores current resume grant after original-target read authorization',
  );
  await reject(
    'ba_runtime_test',
    gateCommand(ids.run, ids.gate2, 'new-key-after-revoke', 'approve'),
    /current run:resume grant is unavailable|42501/u,
    'idempotency miss revalidates the current literal run:resume grant',
  );
  process.stdout.write(
    `PostgreSQL 16 G1 Worker/Human Gate passed: ${migrations.length} migrations, replay-first receipts, ordered barrier, unique resume attempt/outbox, private evidence and concurrent single winner.\n`,
  );
  process.stdout.write('architecture-gate-suite/1 g1-worker-human-gate pass\n');
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
  failure = failure === undefined ? error : new AggregateError([failure, error]);
}
if (failure !== undefined) throw failure;
