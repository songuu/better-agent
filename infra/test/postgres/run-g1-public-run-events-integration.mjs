import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harness = createPostgresHarness('g1-public-run-events');
const migrationDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/migrations',
);
const uuid = (value) => `a6000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const ids = Object.freeze({
  workspace: uuid(1),
  principal: uuid(2),
  deployment: uuid(3),
  revision: uuid(4),
  browserSession: uuid(5),
  run: uuid(6),
  request: uuid(7),
  sourceEvent1: uuid(8),
  sourceEvent2: uuid(9),
  eventSession: uuid(10),
  crossedRun: uuid(11),
});
const material = Object.freeze({
  browserVerifier: randomBytes(32).toString('hex'),
  eventSecret: randomBytes(32).toString('hex'),
  eventVerifier: randomBytes(32).toString('hex'),
});
const hash = (character) => `sha256:${character.repeat(64)}`;
const bytea = (hex) => `decode('${hex}','hex')`;

function browserAuth(identityExpression) {
  return `jsonb_build_object(
    'auth_mode','browser','workspaceId','${ids.workspace}',
    'browserIdentity',jsonb_build_object(
      'workspaceId','${ids.workspace}',
      'browserSessionId','${ids.browserSession}',
      'endUserPrincipalId','${ids.principal}',
      'agentDeploymentId','${ids.deployment}',
      'sessionAuthorizationEpoch',(${identityExpression}->>'session_epoch')::bigint,
      'principalAuthorizationEpoch',(${identityExpression}->>'observed_principal_session_epoch')::bigint,
      'deploymentAuthorizationEpoch',(${identityExpression}->>'observed_deployment_revoke_epoch')::bigint
    ))`;
}

async function seedFacts() {
  const canonicalRevision = JSON.stringify({
    schema_version: 'agent-deployment/1',
    workspace_id: ids.workspace,
    agent_deployment_id: ids.deployment,
    agent_deployment_revision_id: ids.revision,
    agent_id: uuid(20),
    revision_contract_hash: hash('f'),
    conversation_contract_hash: hash('e'),
  }).replaceAll("'", "''");
  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
SET LOCAL session_replication_role=replica;
INSERT INTO public.workspaces(id,name,credits_balance,credits_reserved_balance,credits_balance_version)
VALUES('${ids.workspace}','G1 public events fixture',0,0,0);
INSERT INTO public.end_user_principals(
  id,workspace_id,issuer_config_id,issuer,subject_hash,status,session_epoch)
VALUES('${ids.principal}','${ids.workspace}','${uuid(21)}','https://issuer.example',
  ${bytea(randomBytes(32).toString('hex'))},'active',2);
INSERT INTO public.agent_deployments(
  id,workspace_id,agent_id,public_selector,environment,ingress_channel,created_by)
VALUES('${ids.deployment}','${ids.workspace}','${uuid(20)}','g1-events-browser','staging','browser','fixture');
INSERT INTO public.agent_deployment_security_states(
  workspace_id,agent_deployment_id,status,revoke_epoch,updated_by)
VALUES('${ids.workspace}','${ids.deployment}','ACTIVE',3,'fixture');
INSERT INTO public.agent_deployment_revisions(
  id,workspace_id,agent_deployment_id,agent_id,environment,ingress_channel,
  agent_release_id,agent_release_contract_hash,experience_id,experience_release_id,
  experience_contract_hash,policy_profile_id,policy_profile_version_id,
  policy_profile_contract_hash,entry_grant_policy_id,entry_grant_policy_version_id,
  entry_grant_policy_contract_hash,entry_scope_policy_id,entry_scope_policy_version_id,
  entry_scope_policy_contract_hash,credential_mapping_hash,dependency_manifest_hash,
  change_set_hash,revision_contract_hash,allowed_origins,browser_client_channels,
  session_token_audience,canonical_document,created_by)
VALUES('${ids.revision}','${ids.workspace}','${ids.deployment}','${uuid(20)}','staging','browser',
  '${uuid(22)}','${hash('a')}','${uuid(23)}','${uuid(24)}','${hash('b')}',
  '${uuid(25)}','${uuid(26)}','${hash('c')}','${uuid(27)}','${uuid(28)}','${hash('d')}',
  '${uuid(29)}','${uuid(30)}','${hash('e')}','${hash('1')}','${hash('2')}',
  '${hash('3')}','${hash('f')}',ARRAY['https://app.example'],ARRAY['WEB_SDK'],
  'agent_browser_api','${canonicalRevision}','fixture');
INSERT INTO public.agent_deployment_active_pointers(
  workspace_id,agent_deployment_id,active_revision_id,activation_epoch,activated_by)
VALUES('${ids.workspace}','${ids.deployment}','${ids.revision}',1,'fixture');
INSERT INTO public.browser_sessions(
  id,workspace_id,agent_deployment_id,principal_id,assertion_use_id,client_channel,
  canonical_origin,token_audience,observed_principal_session_epoch,
  observed_deployment_revoke_epoch,session_epoch,status,issued_at,expires_at)
VALUES('${ids.browserSession}','${ids.workspace}','${ids.deployment}','${ids.principal}',
  '${uuid(31)}','WEB_SDK','https://app.example','agent_browser_api',2,3,1,'ACTIVE',
  clock_timestamp(),clock_timestamp()+interval '10 minutes');
INSERT INTO auth.browser_session_auth_index(
  browser_session_id,workspace_id,verifier_hmac,verifier_algorithm,status,session_epoch,expires_at)
SELECT id,workspace_id,${bytea(material.browserVerifier)},'hmac-sha-256','ACTIVE',session_epoch,expires_at
FROM public.browser_sessions WHERE id='${ids.browserSession}';
INSERT INTO public.runs(
  workspace_id,id,billing_owner_run_id,accepted_request_id,accepted_principal_kind,
  accepted_end_user_principal_id,fixed_route,intent_hash,admission_snapshot_hash,
  accepted_plan_hash,accepted_output_schema_ref,accepted_output_schema_hash,
  dependency_pins_hash,target_kind,agent_deployment_id,agent_deployment_revision_id,
  agent_id,agent_release_id,experience_release_id,conversation_id,
  conversation_contract_hash,accepted_conversation_state_version,user_message_id,
  status,execution_status,billing_state,acceptance_receipt_data_redacted,last_event_sequence)
VALUES('${ids.workspace}','${ids.run}','${ids.run}','${ids.request}','end_user','${ids.principal}',
  '/v1/oapi/agent/chat','${hash('4')}','${hash('5')}','${hash('6')}','schema:output',
  '${hash('7')}','${hash('8')}','agent','${ids.deployment}','${ids.revision}','${uuid(20)}',
  '${uuid(22)}','${uuid(24)}','${uuid(32)}','${hash('e')}',1,'${uuid(33)}',
  'RUNNING','RUNNING','PENDING','{}',2);
INSERT INTO public.run_events(workspace_id,id,run_id,sequence,event_type,dedupe_key,payload_redacted,occurred_at)
VALUES
  ('${ids.workspace}','${ids.sourceEvent1}','${ids.run}',1,'RUN_ACCEPTED','accepted','{}','2026-09-05T00:00:00Z'),
  ('${ids.workspace}','${ids.sourceEvent2}','${ids.run}',2,'RUN_STARTED','started','{}','2026-09-05T00:00:01Z');
COMMIT;`,
  );
}

function projection(eventId, sequence, type, occurredAt, data) {
  return JSON.stringify({
    workspace_id: ids.workspace,
    schema_version: 'run-event/1',
    event_id: eventId,
    sequence: String(sequence),
    occurred_at: occurredAt,
    accepted_request_id: ids.request,
    run_id: ids.run,
    type,
    data,
  }).replaceAll("'", "''");
}

async function assertProjectionContract() {
  const first = projection(ids.sourceEvent1, 1, 'run.accepted', '2026-09-05T00:00:00.000Z', {
    status: 'QUEUED',
  });
  const second = projection(ids.sourceEvent2, 2, 'run.started', '2026-09-05T00:00:01.000Z', {
    status: 'RUNNING',
  });
  await harness.psql(
    'ba_migrator_test',
    `BEGIN; SET LOCAL ROLE ba_run_owner;
ALTER TABLE public.runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.run_events NO FORCE ROW LEVEL SECURITY;
SELECT app.append_public_run_event_projection('${first}'::jsonb);
SELECT app.append_public_run_event_projection('${first}'::jsonb);
SELECT app.append_public_run_event_projection('${second}'::jsonb);
ALTER TABLE public.run_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.runs FORCE ROW LEVEL SECURITY;
COMMIT;`,
  );
  assertRejected(
    await harness.psql(
      'ba_migrator_test',
      `BEGIN; SET LOCAL ROLE ba_run_owner;
ALTER TABLE public.runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.run_events NO FORCE ROW LEVEL SECURITY;
SELECT app.append_public_run_event_projection('${projection(ids.sourceEvent2, 2, 'run.started', '2026-09-05T00:00:01.000Z', { status: 'QUEUED' })}'::jsonb);`,
      { allowFailure: true },
    ),
    /public Run event projection replay conflict|23505/u,
    'different public projection replay conflicts',
  );
  assertRejected(
    await harness.psql(
      'ba_migrator_test',
      `BEGIN; SET LOCAL ROLE ba_run_owner;
ALTER TABLE public.runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.run_events NO FORCE ROW LEVEL SECURITY;
SELECT app.append_public_run_event_projection(
  ('${second}'::jsonb)||jsonb_build_object('credential_id','${uuid(40)}'));`,
      { allowFailure: true },
    ),
    /invalid public Run event projection|22023/u,
    'internal authority key is rejected',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',count(*),min(sequence),max(sequence))
FROM public.public_run_event_projections WHERE run_id='${ids.run}';`,
    ),
    '2|1|2',
    'projection replay writes exactly one row per source event',
  );
}

async function assertBrowserEventSession() {
  const issue = `DO $issue$
DECLARE v_identity jsonb; v_receipt jsonb;
BEGIN
  v_identity:=auth.authenticate_browser_session_identity(
    '${ids.browserSession}',${bytea(material.browserVerifier)},
    'https://app.example','agent_browser_api','WEB_SDK');
  v_receipt:=app.issue_browser_run_event_session(
    '${ids.eventSession}',${bytea(material.eventVerifier)},'${ids.run}',${browserAuth('v_identity')});
  IF v_receipt->>'run_id'<>'${ids.run}' OR (v_receipt->>'max_age_seconds')::integer NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'invalid event session receipt';
  END IF;
END;
$issue$;`;
  await harness.psql('ba_runtime_test', `BEGIN; ${issue} COMMIT;`);
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.run_event_sessions WHERE id='${ids.eventSession}'),
  (SELECT count(*) FROM auth.run_event_session_auth_index WHERE event_session_id='${ids.eventSession}'),
  (SELECT encode(verifier_hmac,'hex')='${material.eventSecret}' FROM auth.run_event_session_auth_index
    WHERE event_session_id='${ids.eventSession}'));
`,
    ),
    '1|1|f',
    'one safe session and one non-raw private verifier are stored',
  );
  await harness.psql(
    'ba_runtime_test',
    `BEGIN;
DO $read$
DECLARE v_identity jsonb; v_events jsonb;
BEGIN
  v_identity:=auth.authenticate_run_event_session_facts(
    '${ids.eventSession}',${bytea(material.eventVerifier)},'https://app.example');
  v_events:=app.read_public_run_events('${ids.run}',1,${browserAuth('v_identity')});
  IF jsonb_array_length(v_events->'events')<>1
     OR v_events#>>'{events,0,sequence}'<>'2' THEN
    RAISE EXCEPTION 'event cursor readback mismatch';
  END IF;
END;
$read$;
COMMIT;`,
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT auth.authenticate_run_event_session_facts(
  '${ids.eventSession}',${bytea(randomBytes(32).toString('hex'))},'https://app.example');`,
      { allowFailure: true },
    ),
    /Run event session authentication rejected|42501/u,
    'wrong event-session verifier is rejected',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT auth.authenticate_run_event_session_facts(
  '${ids.eventSession}',${bytea(material.eventVerifier)},'https://other.example');`,
      { allowFailure: true },
    ),
    /Run event session lifecycle or origin rejected|42501/u,
    'different origin is rejected',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `INSERT INTO public.public_run_event_projections(
  workspace_id,event_id,run_id,sequence,accepted_request_id,projection,occurred_at)
VALUES('${ids.workspace}','${uuid(50)}','${ids.run}',3,'${ids.request}','{}',clock_timestamp());`,
      { allowFailure: true },
    ),
    /permission denied|42501/u,
    'runtime has no direct public projection DML',
  );
}

async function main() {
  await harness.start();
  const migrations = await loadMigrations(migrationDirectory);
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations));
  await seedFacts();
  await assertProjectionContract();
  await assertBrowserEventSession();
  const logs = await harness.logs();
  if (logs.stdout.includes(material.eventSecret) || logs.stderr.includes(material.eventSecret)) {
    throw new Error('raw event-session secret leaked to PostgreSQL logs');
  }
  process.stdout.write(
    `PostgreSQL 16 G1 public Run events passed: ${migrations.length} migrations, immutable replay-safe public projection, strict cursor readback, single-Run 60-second verifier session, origin/lifecycle fences, direct-DML denial and secret-log boundary.\n`,
  );
  process.stdout.write('architecture-gate-suite/1 g1-public-run-events pass\n');
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
if (failures.length > 1) throw new AggregateError(failures, 'G1 public Run events harness failed');
