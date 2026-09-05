import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import { canonicalJsonBytes } from '../../../packages/release-core/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrationDirectory = path.resolve(directory, '../../../packages/db/migrations');
const harness = createPostgresHarness('g1-agent-strategy');
const id = (n) => `fc400000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ids = Object.freeze({
  workspace: id(1),
  credential: id(2),
  run: id(3),
  request: id(4),
  attempt: id(5),
  execution: id(6),
  attestation: id(7),
  planAttestation: id(8),
  deployment: id(9),
  deploymentRevision: id(10),
  agent: id(11),
  agentRelease: id(12),
  experienceRelease: id(13),
  conversation: id(14),
  userMessage: id(15),
});
const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const canonicalHash = (value) =>
  `sha256:${createHash('sha256').update(canonicalJsonBytes(value)).digest('hex')}`;
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const jsonb = (value) => `${sqlLiteral(JSON.stringify(value))}::jsonb`;
const rawSecret = randomBytes(32).toString('hex');
const subjectBinding = randomBytes(32).toString('hex');
const planVerifier = randomBytes(32).toString('hex');

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

function checkpointDraft(overrides) {
  return {
    schema_version: 'agent-strategy-checkpoint/1',
    checkpoint_id: overrides.checkpoint_id,
    ...(overrides.previous_checkpoint_hash === undefined
      ? {}
      : { previous_checkpoint_hash: overrides.previous_checkpoint_hash }),
    run_id: ids.run,
    root_step_id: 'root-step-1',
    strategy_release_id: 'strategy-release-1',
    implementation_digest: sha('strategy-implementation'),
    resolved_agent_plan_hash: overrides.plan_hash,
    capability_closure_hash: sha('closure'),
    transition_sequence: overrides.transition_sequence,
    iteration: overrides.iteration,
    phase: overrides.phase,
    durable_state: {},
    state_schema_hash: sha('state-schema'),
    accepted_observation_refs: overrides.accepted_observation_refs ?? [],
    completed_model_attempt_ids: overrides.completed_model_attempt_ids ?? [],
    completed_capability_call_ids: [],
    instruction_skill_activation_ids: [],
    ...(overrides.pending_action === undefined ? {} : { pending_action: overrides.pending_action }),
    counters: {
      schema_version: 'strategy-counter-snapshot/1',
      model_attempts: overrides.model_attempts ?? 0,
      capability_calls: 0,
      committed_usage_receipts: 0,
      budget_exhausted: false,
    },
    ...(overrides.termination_reason === undefined
      ? {}
      : { termination_reason: overrides.termination_reason }),
  };
}

async function main() {
  const migrations = await loadMigrations(migrationDirectory);
  await harness.start();
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), { echoErrors: true });
  const resolvedPlanHash = sha('agent-resolved-plan');
  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.workspaces (id,name,credits_balance,credits_reserved_balance,credits_balance_version)
VALUES ('${ids.workspace}','G1 Agent Strategy',1000,0,1);
INSERT INTO public.runs (
  workspace_id,id,billing_owner_run_id,accepted_request_id,accepted_principal_kind,
  accepted_credential_id,fixed_route,intent_hash,admission_snapshot_hash,accepted_plan_hash,
  accepted_output_schema_ref,accepted_output_schema_hash,dependency_pins_hash,target_kind,
  agent_deployment_id,agent_deployment_revision_id,agent_id,agent_release_id,
  experience_release_id,conversation_id,conversation_contract_hash,
  accepted_conversation_state_version,user_message_id,status,execution_status,billing_state,
  acceptance_receipt_data_redacted,last_event_sequence
) VALUES (
  '${ids.workspace}','${ids.run}','${ids.run}','${ids.request}','credential','${ids.credential}',
  '/v1/oapi/agent/chat','${sha('intent')}','${sha('admission')}','${resolvedPlanHash}',
  'schema://agent/output','${sha('output')}','${sha('dependencies')}','agent',
  '${ids.deployment}','${ids.deploymentRevision}','${ids.agent}','${ids.agentRelease}',
  '${ids.experienceRelease}','${ids.conversation}','${sha('conversation-contract')}',
  1,'${ids.userMessage}','QUEUED','QUEUED','PENDING','{}'::jsonb,0
);
INSERT INTO public.run_attempts (
  workspace_id,id,run_id,attempt_number,status,runtime_protocol_version,lease_generation
) VALUES ('${ids.workspace}','${ids.attempt}','${ids.run}',1,'PENDING',5,0);
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

  const planDraft = {
    schema_version: 'compiled-agent-plan/1',
    agent_release: {
      workspace_id: ids.workspace,
      published_resource_kind: 'AGENT_RELEASE',
      resource_id: ids.agent,
      resource_version_id: ids.agentRelease,
      contract_hash: sha('agent-contract'),
      binding_mode: 'pinned',
    },
    capability_closure_hash: sha('closure'),
    resolved_execution_plan_hash: resolvedPlanHash,
    strategy: {
      strategy_pin: {
        strategy_release_id: 'strategy-release-1',
        implementation_digest: sha('strategy-implementation'),
      },
    },
    checkpoint_contract_version: 'agent-strategy-checkpoint/1',
  };
  const plan = { ...planDraft, plan_hash: canonicalHash(planDraft) };
  await harness.psql(
    'ba_management_issuer_test',
    `SELECT auth.issue_agent_strategy_plan_attestation(
  '${ids.planAttestation}','${ids.workspace}','${ids.run}','${ids.execution}',
  'ba_execution_test'::name,${jsonb(plan)},decode('${planVerifier}','hex'),
  clock_timestamp()+interval '10 minutes'
);`,
    { scanFor: [planVerifier] },
  );
  const registrationFact = {
    ...leased,
    agent_strategy_execution_id: ids.execution,
    compiled_agent_plan: plan,
    plan_attestation_id: ids.planAttestation,
    plan_attestation_verifier: planVerifier,
  };
  const registration = await call('register_agent_strategy_execution', registrationFact);
  assertEqual(
    `${registration.compiled_agent_plan_hash}|${String(registration.replayed)}`,
    `${plan.plan_hash}|false`,
    'Agent Strategy execution binds the reviewed Plan once',
  );
  const replayRegistration = await call('register_agent_strategy_execution', registrationFact);
  assertEqual(
    String(replayRegistration.replayed),
    'true',
    'AgentPlan registration replays exactly',
  );

  const initialDraft = checkpointDraft({
    checkpoint_id: 'checkpoint-0',
    plan_hash: plan.plan_hash,
    transition_sequence: 0,
    iteration: 0,
    phase: 'READY',
  });
  const initial = { ...initialDraft, checkpoint_hash: canonicalHash(initialDraft) };
  const first = await call('commit_agent_strategy_checkpoint', {
    ...leased,
    agent_strategy_execution_id: ids.execution,
    commit_sequence: 1,
    checkpoint: initial,
  });
  assertEqual(String(first.replayed), 'false', 'initial Strategy checkpoint commits once');
  const operationId = canonicalHash({
    schema_version: 'strategy-logical-action-id/1',
    run_id: ids.run,
    root_step_id: 'root-step-1',
    transition_sequence: 1,
    decision_kind: 'request_model',
  });
  const pendingAction = {
    schema_version: 'pending-strategy-action/1',
    action_kind: 'model',
    operation_id: operationId,
    model_descriptor_id: 'model-primary',
    request_hash: sha('request'),
    retry_policy_ref: 'fixed-1',
  };
  const pendingDraft = checkpointDraft({
    checkpoint_id: 'checkpoint-1',
    previous_checkpoint_hash: initial.checkpoint_hash,
    plan_hash: plan.plan_hash,
    transition_sequence: 1,
    iteration: 1,
    phase: 'MODEL_PENDING',
    pending_action: pendingAction,
  });
  const pending = { ...pendingDraft, checkpoint_hash: canonicalHash(pendingDraft) };
  const decisionHash = sha('decision');
  const outbox = {
    schema_version: 'strategy-action-outbox/1',
    operation_id: operationId,
    decision_kind: 'request_model',
    decision_hash: decisionHash,
  };
  await call('commit_agent_strategy_checkpoint', {
    ...leased,
    agent_strategy_execution_id: ids.execution,
    commit_sequence: 2,
    checkpoint: pending,
    decision_hash: decisionHash,
    outbox,
  });
  await reject(
    'commit_agent_strategy_checkpoint',
    {
      ...leased,
      agent_strategy_execution_id: ids.execution,
      commit_sequence: 3,
      checkpoint: { ...pending, checkpoint_id: 'forged-checkpoint' },
      decision_hash: decisionHash,
      outbox,
    },
    /checkpoint hash is invalid|55000/u,
    'checkpoint bytes cannot drift under an existing hash',
  );

  const unknownResult = {
    schema_version: 'strategy-action-result/1',
    operation_id: operationId,
    action_kind: 'model',
    completion_id: 'model-attempt-1',
    status: 'OUTCOME_UNKNOWN',
  };
  const terminalDraft = checkpointDraft({
    checkpoint_id: 'checkpoint-2',
    previous_checkpoint_hash: pending.checkpoint_hash,
    plan_hash: plan.plan_hash,
    transition_sequence: 1,
    iteration: 1,
    phase: 'TERMINATING',
    model_attempts: 1,
    completed_model_attempt_ids: ['model-attempt-1'],
    termination_reason: 'MODEL_OUTCOME_UNKNOWN',
  });
  const terminal = { ...terminalDraft, checkpoint_hash: canonicalHash(terminalDraft) };
  const resultFact = {
    ...leased,
    agent_strategy_execution_id: ids.execution,
    commit_sequence: 3,
    action_result: unknownResult,
    checkpoint: terminal,
  };
  const committed = await call('commit_agent_strategy_action_result', resultFact);
  assertEqual(String(committed.replayed), 'false', 'unknown model outcome commits once');
  const replayed = await call('commit_agent_strategy_action_result', resultFact);
  assertEqual(String(replayed.replayed), 'true', 'unknown model outcome replays exactly');
  await reject(
    'commit_agent_strategy_action_result',
    {
      ...resultFact,
      action_result: { ...unknownResult, operation_id: sha('foreign-operation') },
    },
    /action result does not extend|40001/u,
    'foreign operation cannot satisfy the pending action',
  );

  const directDml = await harness.psql(
    'ba_execution_test',
    establish(`DELETE FROM public.agent_strategy_action_results
WHERE workspace_id='${ids.workspace}' AND agent_strategy_execution_id='${ids.execution}';`),
    { allowFailure: true, scanFor: [rawSecret] },
  );
  assertRejected(directDml, /permission denied|42501/u, 'execution login has zero direct DML');

  process.stdout.write(
    'PostgreSQL 16 G1-A4 Agent Strategy integration passed: reviewed AgentPlan, exact registration replay, checkpoint/action CAS, outcome-unknown terminal replay, foreign-operation denial and zero direct execution-role DML.\n',
  );
  process.stdout.write('architecture-gate-suite/1 g1-agent-strategy pass\n');
}

try {
  await main();
} finally {
  await harness.stop();
}
