import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import { canonicalJsonBytes } from '../../../packages/release-core/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(directory, '../../../packages/db/migrations');
const harness = createPostgresHarness('g1-join-child');
const id = (n) => `fc600000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ids = Object.freeze({
  workspace: id(1),
  credential: id(2),
  root: id(3),
  rootAttempt: id(4),
  rootExecution: id(5),
  child: id(6),
  childLink: id(7),
  childAllocation: id(8),
  reservation: id(9),
  childEvent: id(10),
  childOutbox: id(11),
  rootAgent: id(12),
  rootRelease: id(13),
  childAgent: id(14),
  childRelease: id(15),
  grandAgent: id(16),
  grandRelease: id(17),
  serviceAttestation: id(18),
  rootPlanAttestation: id(19),
  childAttempt: id(20),
  childExecution: id(21),
  childPlanAttestation: id(22),
  grandchild: id(23),
  grandchildLink: id(24),
  grandchildAllocation: id(25),
  grandchildEvent: id(26),
  grandchildOutbox: id(27),
  request: id(28),
  sourceDraft: id(29),
  rootCheckpoint: id(36),
  rootWaitEvent: id(37),
  rootWaitOutbox: id(38),
  childCheckpoint: id(39),
  childWaitEvent: id(40),
  childWaitOutbox: id(41),
  finalizerAttestation: id(42),
  grandchildSettlement: id(43),
  childResumeAttempt: id(44),
  childResumeEvent: id(45),
  childResumeOutbox: id(46),
  childSettlement: id(47),
  rootResumeAttempt: id(48),
  rootResumeEvent: id(49),
  rootResumeOutbox: id(50),
  grandchildTerminalEvent: id(51),
  childTerminalEvent: id(52),
  grandchildAttempt: id(53),
  grandchildStep: id(54),
  grandchildTerminalIntent: id(55),
  grandchildBillingAuthority: id(56),
  grandchildLedger: id(57),
  grandchildTerminalOutbox: id(58),
  childTerminalStep: id(59),
  childTerminalIntent: id(60),
  childBillingAuthority: id(61),
  childLedger: id(62),
  childTerminalOutbox: id(63),
});
const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const canonicalHash = (value) =>
  `sha256:${createHash('sha256').update(canonicalJsonBytes(value)).digest('hex')}`;
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const jsonb = (value) => `${sqlLiteral(JSON.stringify(value))}::jsonb`;
const rawSecret = randomBytes(32).toString('hex');
const subjectBinding = randomBytes(32).toString('hex');
const planVerifier = randomBytes(32).toString('hex');
const finalizerSecret = randomBytes(32).toString('hex');
const finalizerSubjectBinding = randomBytes(32).toString('hex');
const now = new Date();
const issuedAt = new Date(now.getTime() - 60_000).toISOString();
const createdAt = new Date(now.getTime() + 1_000).toISOString();
const expiresAt = new Date(now.getTime() + 8 * 60_000).toISOString();
const asyncPolicy = Object.freeze({
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
});
const policyHash = canonicalHash(asyncPolicy);
const targetRef = (agent, release) => `agent-release:${agent}:${release}`;

function establish(body) {
  return `BEGIN;
SELECT auth.establish_internal_service_workspace_context(
  '${ids.serviceAttestation}', decode('${rawSecret}', 'hex'), 'execution');
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

async function finalizerCall(functionName, fact) {
  const result = await harness.psql(
    'ba_finalizer_test',
    `BEGIN;
SELECT auth.establish_internal_service_workspace_context(
  '${ids.finalizerAttestation}',decode('${finalizerSecret}','hex'),'finalizer');
SELECT app.${functionName}(${jsonb(fact)});
COMMIT;`,
    { scanFor: [finalizerSecret], tuplesOnly: true },
  );
  const line = result.stdout
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .findLast((item) => item.startsWith('{'));
  if (line === undefined) throw new Error(`${functionName} returned no finalizer JSON object`);
  return JSON.parse(line);
}

async function finalizerReject(functionName, fact, pattern, context) {
  const result = await harness.psql(
    'ba_finalizer_test',
    `BEGIN;
SELECT auth.establish_internal_service_workspace_context(
  '${ids.finalizerAttestation}',decode('${finalizerSecret}','hex'),'finalizer');
SELECT app.${functionName}(${jsonb(fact)});
COMMIT;`,
    { allowFailure: true, scanFor: [finalizerSecret] },
  );
  assertRejected(result, pattern, context);
}

async function terminalizeJoinChild({
  runId,
  attemptId,
  stepId,
  intentId,
  billingAuthorityId,
  ledgerId,
  eventId,
  outboxId,
  payload,
  settledCredits,
  operationKey,
}) {
  const authority = await call('claim_run_attempt', {
    run_id: runId,
    attempt_id: attemptId,
    duration_seconds: 300,
  });
  const lease = {
    run_id: runId,
    attempt_id: attemptId,
    lease_token: authority.lease_token,
    lease_fencing_token: authority.lease_fencing_token,
  };
  await call('record_attempt_started', lease);
  await call('record_step_started', {
    ...lease,
    step_id: stepId,
    step_key: 'terminal-output',
    input_hash: sha(`terminal-input:${runId}`),
  });
  const terminalFact = {
    ...lease,
    step_id: stepId,
    terminal_intent_id: intentId,
    terminal_status: 'SUCCEEDED',
    termination_reason: 'COMPLETED',
    terminal_payload_redacted: payload,
    settled_credits: String(settledCredits),
    producer_operation_key: operationKey,
  };
  const rejectedFinishedAt = new Date().toISOString();
  await finalizerReject(
    'finalize_join_child',
    {
      child_run_id: runId,
      terminal_intent_id: intentId,
      terminal_intent_hash: sha(`missing-terminal-intent:${runId}`),
      authority_id: billingAuthorityId,
      ledger_entry_id: ledgerId,
      terminal_event_id: eventId,
      terminal_outbox_id: outboxId,
      finished_at: rejectedFinishedAt,
      events_retention_until: new Date(
        Date.parse(rejectedFinishedAt) + 8 * 86_400_000,
      ).toISOString(),
      recovery_retention_until: new Date(
        Date.parse(rejectedFinishedAt) + 31 * 86_400_000,
      ).toISOString(),
      retention_until: new Date(Date.parse(rejectedFinishedAt) + 91 * 86_400_000).toISOString(),
    },
    /lacks its execution authority/u,
    'finalizer cannot invent a child terminal intent',
  );
  await reject(
    'commit_join_child_terminal_intent',
    { ...terminalFact, settled_credits: '999' },
    /lacks an exact active allocation/u,
    'execution cannot settle beyond the child allocation',
  );
  const intent = await call('commit_join_child_terminal_intent', terminalFact);
  const replay = await call('commit_join_child_terminal_intent', terminalFact);
  assertEqual(String(replay.replayed), 'true', 'terminal intent replays after lease retirement');
  await reject(
    'commit_join_child_terminal_intent',
    { ...terminalFact, settled_credits: String(settledCredits + 1) },
    /terminal intent replay conflict/u,
    'changed terminal intent replay is rejected',
  );
  const finishedAt = new Date().toISOString();
  const finalized = await finalizerCall('finalize_join_child', {
    child_run_id: runId,
    terminal_intent_id: intentId,
    terminal_intent_hash: intent.terminal_intent_hash,
    authority_id: billingAuthorityId,
    ledger_entry_id: ledgerId,
    terminal_event_id: eventId,
    terminal_outbox_id: outboxId,
    finished_at: finishedAt,
    events_retention_until: new Date(Date.parse(finishedAt) + 8 * 86_400_000).toISOString(),
    recovery_retention_until: new Date(Date.parse(finishedAt) + 31 * 86_400_000).toISOString(),
    retention_until: new Date(Date.parse(finishedAt) + 91 * 86_400_000).toISOString(),
  });
  assertEqual(
    `${finalized.status}|${finalized.billing_state}|${finalized.replayed}`,
    'SUCCEEDED|SETTLED|false',
    'execution-authored child terminal intent is finalized through controlled billing',
  );
  return intent;
}

function ceiling(targetAgent, targetRelease) {
  return {
    schema_version: 'g1-join-child-ceiling/1',
    target_ref: targetRef(targetAgent, targetRelease),
    max_calls: 2,
    max_depth: 2,
    max_ttl_seconds: 540,
    max_budget_credits: '30',
    delegation_policy_hash: sha('delegation'),
  };
}

function catalogEntry(bindingId, targetAgent, targetRelease, operationHash) {
  return {
    schema_version: 'agent-capability-catalog-entry/1',
    local_binding_id: bindingId,
    binding_kind: 'subagent',
    async_child_policy_hash: policyHash,
    join_child_ceiling: ceiling(targetAgent, targetRelease),
    target: {
      published_resource_kind: 'AGENT_RELEASE',
      resource_id: targetAgent,
      resource_version_id: targetRelease,
    },
    operations: [{ contract_hash: operationHash }],
  };
}

function plan(resolvedHash, catalog, agentId = ids.rootAgent, releaseId = ids.rootRelease) {
  const draft = {
    schema_version: 'compiled-agent-plan/1',
    agent_release: {
      workspace_id: ids.workspace,
      published_resource_kind: 'AGENT_RELEASE',
      resource_id: agentId,
      resource_version_id: releaseId,
      contract_hash: sha(`contract:${releaseId}`),
      binding_mode: 'pinned',
    },
    resolved_execution_plan_hash: resolvedHash,
    capability_closure_hash: sha(`closure:${resolvedHash}`),
    strategy: {
      strategy_pin: {
        strategy_release_id: 'strategy-release-1',
        implementation_digest: sha('implementation'),
      },
    },
    capability_catalog: catalog,
    checkpoint_contract_version: 'agent-strategy-checkpoint/1',
  };
  return { ...draft, plan_hash: canonicalHash(draft) };
}

async function issueAndRegisterPlan(
  runId,
  attemptId,
  executionId,
  attestationId,
  leased,
  compiledPlan,
) {
  await harness.psql(
    'ba_management_issuer_test',
    `SELECT auth.issue_agent_strategy_plan_attestation(
    '${attestationId}','${ids.workspace}','${runId}','${executionId}',
    'ba_execution_test'::name,${jsonb(compiledPlan)},decode('${planVerifier}','hex'),
    clock_timestamp()+interval '10 minutes');`,
    { scanFor: [planVerifier] },
  );
  await call('register_agent_strategy_execution', {
    ...leased,
    run_id: runId,
    attempt_id: attemptId,
    agent_strategy_execution_id: executionId,
    compiled_agent_plan: compiledPlan,
    plan_attestation_id: attestationId,
    plan_attestation_verifier: planVerifier,
  });
}

function admission(overrides = {}) {
  const parentRun = overrides.parent_run_id ?? ids.root;
  const childRun = overrides.child_run_id ?? ids.child;
  const parentPlan = overrides.parent_plan_hash ?? sha('root-plan');
  const childPlan = overrides.child_plan_hash ?? sha('child-plan');
  const targetAgent = overrides.target_agent_id ?? ids.childAgent;
  const targetRelease = overrides.target_agent_release_id ?? ids.childRelease;
  const ref = overrides.target_ref ?? targetRef(targetAgent, targetRelease);
  return {
    schema_version: 'g1-join-child-admission/1',
    workspace_id: ids.workspace,
    parent_run_id: parentRun,
    child_run_id: childRun,
    link_id: overrides.link_id ?? ids.childLink,
    billing_owner_run_id: ids.root,
    parent_plan_hash: parentPlan,
    parent_checkpoint_id: overrides.parent_checkpoint_id ?? ids.rootCheckpoint,
    parent_checkpoint_object_ref: `run-checkpoint://${parentRun}/${childRun}`,
    parent_checkpoint_sha256: sha(`checkpoint:${parentRun}:${childRun}`),
    child_plan_hash: childPlan,
    canonical_operation_hash: overrides.canonical_operation_hash ?? sha('spawn-child'),
    binding_id: overrides.binding_id ?? 'child',
    target_agent_id: targetAgent,
    target_agent_release_id: targetRelease,
    target_ref: ref,
    ancestor_target_refs: overrides.ancestor_target_refs ?? [
      targetRef(ids.rootAgent, ids.rootRelease),
    ],
    parent_depth: overrides.parent_depth ?? 0,
    child_depth: overrides.child_depth ?? 1,
    completed_child_calls: overrides.completed_child_calls ?? 0,
    call_sequence: overrides.call_sequence ?? 1,
    allocated_credits: 25,
    admission_snapshot_hash: sha(`admission:${childRun}`),
    accepted_output_schema_ref: 'schema://agent/output',
    accepted_output_schema_hash: sha('output'),
    dependency_pins_hash: sha(`dependencies:${childRun}`),
    context_projection_object_ref: `run-context://${childRun}`,
    context_projection_sha256: sha(`context:${childRun}`),
    delegation_reason: 'bounded test call',
    delegation: {
      schema_version: 'g1-bounded-child-delegation/1',
      policy_hash: sha('delegation'),
      allowed_target_refs: [ref],
      max_calls: 2,
      max_depth: 2,
      max_budget_credits: 30,
      issued_at: issuedAt,
      expires_at: expiresAt,
    },
    compiled_child_ceiling: ceiling(targetAgent, targetRelease),
    async_child_policy: asyncPolicy,
    created_at: createdAt,
    ...overrides,
  };
}

async function main() {
  const migrations = await loadMigrations(migrationsDirectory);
  await harness.start();
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), { echoErrors: true });
  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
SET LOCAL session_replication_role=replica;
INSERT INTO public.workspaces(id,name,credits_balance,credits_reserved_balance,credits_balance_version)
VALUES('${ids.workspace}','G1 Join Child',900,100,1);
INSERT INTO public.api_credentials(id,workspace_id,key_id,key_hint,credential_kind,secret_verifier_hmac)
VALUES('${ids.credential}','${ids.workspace}','${id(30)}','join','service_api',decode('${'11'.repeat(32)}','hex'));
INSERT INTO public.agent_releases(id,workspace_id,agent_id,source_draft_revision_id,contract_hash,
 dependency_manifest_hash,canonical_document,created_by) VALUES
('${ids.rootRelease}','${ids.workspace}','${ids.rootAgent}','${ids.sourceDraft}','${sha('root-contract')}',
 '${sha('root-deps')}','{"schema_version":"agent-release/1","agent_id":"${ids.rootAgent}","agent_release_id":"${ids.rootRelease}","source_draft_revision_id":"${ids.sourceDraft}"}','fixture'),
('${ids.childRelease}','${ids.workspace}','${ids.childAgent}','${ids.sourceDraft}','${sha('child-contract')}',
 '${sha('child-deps')}','{"schema_version":"agent-release/1","agent_id":"${ids.childAgent}","agent_release_id":"${ids.childRelease}","source_draft_revision_id":"${ids.sourceDraft}"}','fixture'),
('${ids.grandRelease}','${ids.workspace}','${ids.grandAgent}','${ids.sourceDraft}','${sha('grand-contract')}',
 '${sha('grand-deps')}','{"schema_version":"agent-release/1","agent_id":"${ids.grandAgent}","agent_release_id":"${ids.grandRelease}","source_draft_revision_id":"${ids.sourceDraft}"}','fixture');
INSERT INTO public.runs(workspace_id,id,billing_owner_run_id,accepted_request_id,accepted_principal_kind,
 accepted_credential_id,fixed_route,intent_hash,admission_snapshot_hash,accepted_plan_hash,
 accepted_output_schema_ref,accepted_output_schema_hash,dependency_pins_hash,target_kind,
 agent_deployment_id,agent_deployment_revision_id,agent_id,agent_release_id,experience_release_id,
 conversation_id,conversation_contract_hash,accepted_conversation_state_version,user_message_id,
 status,execution_status,billing_state,acceptance_receipt_data_redacted,last_event_sequence)
VALUES('${ids.workspace}','${ids.root}','${ids.root}','${ids.request}','credential','${ids.credential}',
 '/v1/oapi/agent/chat','${sha('root-intent')}','${sha('root-admission')}','${sha('root-plan')}',
 'schema://agent/output','${sha('output')}','${sha('root-deps')}','agent','${id(31)}','${id(32)}',
 '${ids.rootAgent}','${ids.rootRelease}','${id(33)}','${id(34)}','${sha('conversation')}',1,'${id(35)}',
 'QUEUED','QUEUED','PENDING','{}',0);
INSERT INTO public.run_attempts(workspace_id,id,run_id,attempt_number,status,runtime_protocol_version,lease_generation)
VALUES('${ids.workspace}','${ids.rootAttempt}','${ids.root}',1,'PENDING',5,0);
INSERT INTO public.credit_reservations(workspace_id,id,run_id,billing_owner_run_id,accepted_plan_hash,status,
 reserved_credits,settled_credits,released_credits,balance_version,expires_at)
VALUES('${ids.workspace}','${ids.reservation}','${ids.root}','${ids.root}','${sha('root-plan')}','HELD',100,0,0,1,
 clock_timestamp()+interval '15 minutes');
COMMIT;`,
  );
  await harness.psql(
    'ba_internal_issuer_test',
    `SELECT auth.issue_internal_service_attestation(
    '${ids.serviceAttestation}','${ids.workspace}','ba_execution_test'::name,'execution',
    'better-agent/internal-service/1',decode('${subjectBinding}','hex'),
    public.hmac(decode('${rawSecret}','hex'),convert_to('better-agent/internal-service-attestation-verifier/1','UTF8')||decode('00','hex'),'sha256'),
    clock_timestamp()+interval '10 minutes');`,
    { scanFor: [rawSecret] },
  );
  await harness.psql(
    'ba_internal_issuer_test',
    `SELECT auth.issue_internal_service_attestation(
    '${ids.finalizerAttestation}','${ids.workspace}','ba_finalizer_test'::name,'finalizer',
    'better-agent/internal-service/1',decode('${finalizerSubjectBinding}','hex'),
    public.hmac(decode('${finalizerSecret}','hex'),convert_to('better-agent/internal-service-attestation-verifier/1','UTF8')||decode('00','hex'),'sha256'),
    clock_timestamp()+interval '10 minutes');`,
    { scanFor: [finalizerSecret] },
  );

  const rootAuthority = await call('claim_run_attempt', {
    run_id: ids.root,
    attempt_id: ids.rootAttempt,
    duration_seconds: 300,
  });
  const rootLease = {
    run_id: ids.root,
    attempt_id: ids.rootAttempt,
    lease_token: rootAuthority.lease_token,
    lease_fencing_token: rootAuthority.lease_fencing_token,
  };
  await call('record_attempt_started', rootLease);
  const rootPlan = plan(sha('root-plan'), [
    catalogEntry('child', ids.childAgent, ids.childRelease, sha('spawn-child')),
    catalogEntry('recursive', ids.rootAgent, ids.rootRelease, sha('spawn-recursive')),
  ]);
  await issueAndRegisterPlan(
    ids.root,
    ids.rootAttempt,
    ids.rootExecution,
    ids.rootPlanAttestation,
    rootLease,
    rootPlan,
  );
  const recursiveAdmission = admission({
    child_run_id: ids.grandchild,
    link_id: ids.grandchildLink,
    binding_id: 'recursive',
    canonical_operation_hash: sha('spawn-recursive'),
    target_agent_id: ids.rootAgent,
    target_agent_release_id: ids.rootRelease,
  });
  await reject(
    'create_child_run',
    {
      admission: recursiveAdmission,
      allocation_id: ids.grandchildAllocation,
      parent_reservation_id: ids.reservation,
      attempt_id: ids.rootAttempt,
      lease_token: rootLease.lease_token,
      lease_fencing_token: rootLease.lease_fencing_token,
      child_event_id: ids.grandchildEvent,
      child_outbox_id: ids.grandchildOutbox,
      parent_wait_event_id: ids.rootWaitEvent,
      parent_wait_outbox_id: ids.rootWaitOutbox,
    },
    /recursive child target is denied/u,
    'ancestor target is rejected before allocation',
  );
  const deniedCount = await harness.psql(
    'ba_bootstrap_test',
    `SELECT
    (SELECT count(*) FROM public.runs WHERE id='${ids.grandchild}')||'|'||
    (SELECT count(*) FROM public.run_budget_allocations WHERE child_run_id='${ids.grandchild}');`,
    { tuplesOnly: true },
  );
  assertEqual(deniedCount.stdout.trim(), '0|0', 'denied recursion leaves no Run or allocation');
  const firstFact = {
    admission: admission(),
    allocation_id: ids.childAllocation,
    parent_reservation_id: ids.reservation,
    attempt_id: ids.rootAttempt,
    lease_token: rootLease.lease_token,
    lease_fencing_token: rootLease.lease_fencing_token,
    child_event_id: ids.childEvent,
    child_outbox_id: ids.childOutbox,
    parent_wait_event_id: ids.rootWaitEvent,
    parent_wait_outbox_id: ids.rootWaitOutbox,
  };
  const first = await call('create_child_run', firstFact);
  assertEqual(
    `${first.child_run_id}|${first.replayed}`,
    `${ids.child}|false`,
    'root child is admitted once',
  );
  const replay = await call('create_child_run', firstFact);
  assertEqual(
    String(replay.replayed),
    'true',
    'exact child admission replays after lease relinquishment',
  );
  await reject(
    'create_child_run',
    { ...firstFact, admission: { ...firstFact.admission, child_plan_hash: sha('changed') } },
    /replay conflict/u,
    'changed replay is rejected',
  );
  const topology = await harness.psql(
    'ba_bootstrap_test',
    `SELECT
    (SELECT run_kind||'|'||status FROM public.runs WHERE id='${ids.child}')||'|'||
    (SELECT status||'|'||allocated_credits FROM public.run_budget_allocations WHERE child_run_id='${ids.child}')||'|'||
    (SELECT status FROM public.runs WHERE id='${ids.root}');`,
    { tuplesOnly: true },
  );
  assertEqual(
    topology.stdout.trim(),
    'join_child|QUEUED|ACTIVE|25|WAITING_FOR_CHILD',
    'join topology and one billing allocation are atomic',
  );
  const directAllocationMutation = await harness.psql(
    'ba_execution_test',
    establish(
      `UPDATE public.run_budget_allocations SET status='RELEASED',released_credits=allocated_credits
WHERE child_run_id='${ids.child}';`,
    ),
    { allowFailure: true, scanFor: [rawSecret] },
  );
  assertRejected(
    directAllocationMutation,
    /permission denied|controlled billing close path/u,
    'execution cannot mutate a child billing allocation directly',
  );

  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
SET LOCAL session_replication_role=replica;
INSERT INTO public.run_attempts(workspace_id,id,run_id,attempt_number,status,runtime_protocol_version,lease_generation)
VALUES('${ids.workspace}','${ids.childAttempt}','${ids.child}',1,'PENDING',5,0);
COMMIT;`,
  );
  const childAuthority = await call('claim_run_attempt', {
    run_id: ids.child,
    attempt_id: ids.childAttempt,
    duration_seconds: 300,
  });
  const childLease = {
    run_id: ids.child,
    attempt_id: ids.childAttempt,
    lease_token: childAuthority.lease_token,
    lease_fencing_token: childAuthority.lease_fencing_token,
  };
  await call('record_attempt_started', childLease);
  const childPlan = plan(
    sha('child-plan'),
    [catalogEntry('grandchild', ids.grandAgent, ids.grandRelease, sha('spawn-grandchild'))],
    ids.childAgent,
    ids.childRelease,
  );
  await issueAndRegisterPlan(
    ids.child,
    ids.childAttempt,
    ids.childExecution,
    ids.childPlanAttestation,
    childLease,
    childPlan,
  );
  const ancestors = [
    targetRef(ids.rootAgent, ids.rootRelease),
    targetRef(ids.childAgent, ids.childRelease),
  ].sort();
  const grandchildAdmission = admission({
    parent_run_id: ids.child,
    child_run_id: ids.grandchild,
    link_id: ids.grandchildLink,
    parent_plan_hash: sha('child-plan'),
    child_plan_hash: sha('grandchild-plan'),
    binding_id: 'grandchild',
    canonical_operation_hash: sha('spawn-grandchild'),
    target_agent_id: ids.grandAgent,
    target_agent_release_id: ids.grandRelease,
    ancestor_target_refs: ancestors,
    parent_depth: 1,
    child_depth: 2,
    parent_checkpoint_id: ids.childCheckpoint,
  });
  const grandchildResult = await call('create_child_run', {
    admission: grandchildAdmission,
    allocation_id: ids.grandchildAllocation,
    parent_reservation_id: ids.reservation,
    attempt_id: ids.childAttempt,
    lease_token: childLease.lease_token,
    lease_fencing_token: childLease.lease_fencing_token,
    child_event_id: ids.grandchildEvent,
    child_outbox_id: ids.grandchildOutbox,
    parent_wait_event_id: ids.childWaitEvent,
    parent_wait_outbox_id: ids.childWaitOutbox,
  });
  assertEqual(
    `${grandchildResult.child_run_id}|${grandchildResult.replayed}`,
    `${ids.grandchild}|false`,
    'root to child to grandchild topology is admitted',
  );
  const lineage = await harness.psql(
    'ba_bootstrap_test',
    `SELECT
    (SELECT count(*) FROM public.run_parent_links)||'|'||
    (SELECT count(*) FROM public.run_budget_allocations)||'|'||
    (SELECT count(*) FROM public.credit_reservations)||'|'||
    (SELECT billing_owner_run_id FROM public.runs WHERE id='${ids.grandchild}')||'|'||
    (SELECT status FROM public.runs WHERE id='${ids.child}');`,
    { tuplesOnly: true },
  );
  assertEqual(
    lineage.stdout.trim(),
    `2|2|1|${ids.root}|WAITING_FOR_CHILD`,
    'grandchild shares the root reservation and leaves its parent waiting',
  );

  const grandchildResultPayload = { summary: 'grandchild completed safely' };
  const childResultPayload = { summary: 'child completed safely' };
  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
SET LOCAL session_replication_role=replica;
INSERT INTO public.run_attempts(workspace_id,id,run_id,attempt_number,status,runtime_protocol_version,lease_generation)
VALUES('${ids.workspace}','${ids.grandchildAttempt}','${ids.grandchild}',1,'PENDING',5,0);
COMMIT;`,
  );
  const grandchildTerminal = await terminalizeJoinChild({
    runId: ids.grandchild,
    attemptId: ids.grandchildAttempt,
    stepId: ids.grandchildStep,
    intentId: ids.grandchildTerminalIntent,
    billingAuthorityId: ids.grandchildBillingAuthority,
    ledgerId: ids.grandchildLedger,
    eventId: ids.grandchildTerminalEvent,
    outboxId: ids.grandchildTerminalOutbox,
    payload: grandchildResultPayload,
    settledCredits: 3,
    operationKey: 'join-child:grandchild:terminal',
  });
  const grandchildSettlementFact = {
    child_run_id: ids.grandchild,
    child_terminal_intent_hash: grandchildTerminal.terminal_intent_hash,
    settlement_id: ids.grandchildSettlement,
    terminal_payload_object_ref: `run-result://${ids.grandchild}`,
    terminal_payload_sha256: canonicalHash(grandchildResultPayload),
    parent_attempt_id: ids.childResumeAttempt,
    parent_event_id: ids.childResumeEvent,
    parent_outbox_id: ids.childResumeOutbox,
    settled_at: new Date(now.getTime() + 2_000).toISOString(),
  };
  const concurrentSettlements = await Promise.all([
    finalizerCall('settle_join_child', grandchildSettlementFact),
    finalizerCall('settle_join_child', grandchildSettlementFact),
  ]);
  assertEqual(
    concurrentSettlements
      .map((result) => String(result.replayed))
      .sort()
      .join('|'),
    'false|true',
    'concurrent exact settlement has one writer and one replay',
  );
  assertEqual(
    String(concurrentSettlements.some((result) => result.outcome === 'PARENT_RESUMED')),
    'true',
    'settled grandchild resumes the waiting child',
  );

  const childTerminal = await terminalizeJoinChild({
    runId: ids.child,
    attemptId: ids.childResumeAttempt,
    stepId: ids.childTerminalStep,
    intentId: ids.childTerminalIntent,
    billingAuthorityId: ids.childBillingAuthority,
    ledgerId: ids.childLedger,
    eventId: ids.childTerminalEvent,
    outboxId: ids.childTerminalOutbox,
    payload: childResultPayload,
    settledCredits: 5,
    operationKey: 'join-child:child:terminal',
  });
  const childSettlement = await finalizerCall('settle_join_child', {
    child_run_id: ids.child,
    child_terminal_intent_hash: childTerminal.terminal_intent_hash,
    settlement_id: ids.childSettlement,
    terminal_payload_object_ref: `run-result://${ids.child}`,
    terminal_payload_sha256: canonicalHash(childResultPayload),
    parent_attempt_id: ids.rootResumeAttempt,
    parent_event_id: ids.rootResumeEvent,
    parent_outbox_id: ids.rootResumeOutbox,
    settled_at: new Date(now.getTime() + 3_000).toISOString(),
  });
  assertEqual(
    `${childSettlement.parent_run_id}|${childSettlement.outcome}`,
    `${ids.root}|PARENT_RESUMED`,
    'settled descendant chain resumes the root',
  );
  const recovered = await harness.psql(
    'ba_bootstrap_test',
    `SELECT
    (SELECT status FROM public.runs WHERE id='${ids.root}')||'|'||
    (SELECT count(*) FROM public.join_child_settlement_receipts)||'|'||
    (SELECT count(*) FROM public.run_attempts WHERE id IN ('${ids.childResumeAttempt}','${ids.rootResumeAttempt}'))||'|'||
    (SELECT count(*) FROM public.join_child_terminal_intents)||'|'||
    (SELECT status||':'||settled_credits||':'||released_credits FROM public.run_budget_allocations
      WHERE child_run_id='${ids.grandchild}')||'|'||
    (SELECT status||':'||settled_credits||':'||released_credits FROM public.run_budget_allocations
      WHERE child_run_id='${ids.child}')||'|'||
    (SELECT status||':'||settled_credits||':'||released_credits FROM public.credit_reservations
      WHERE id='${ids.reservation}')||'|'||
    (SELECT count(*) FROM public.credits_ledger WHERE producer_run_id IN ('${ids.child}','${ids.grandchild}'));
  `,
    { tuplesOnly: true },
  );
  assertEqual(
    recovered.stdout.trim(),
    'QUEUED|2|2|2|SETTLED:3:22|SETTLED:5:20|HELD:8:0|2',
    'restart-safe receipts, exact allocation closure and root billing recover the descendant chain',
  );
  console.log(
    'G1-A5 PostgreSQL join-child harness passed: exact Plan policy, bounded root-to-grandchild admission, ancestor rejection, replay/conflict, one billing root, durable wait and settlement recovery are atomic.',
  );
  console.log('architecture-gate-suite/1 g1-join-child pass');
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
  failure ??= error;
}
if (failure) throw failure;
