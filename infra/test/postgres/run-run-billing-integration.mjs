import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadMigrations,
  renderDownMigrationSql,
  renderUpMigrationSql,
  selectMigrationMilestone,
} from '../../../packages/db/dist/index.js';

import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harnessDirectory = path.dirname(fileURLToPath(import.meta.url));
const composeFile = path.join(harnessDirectory, 'compose.yaml');
const migrationDirectory = path.resolve(harnessDirectory, '../../../packages/db/migrations');
const harness = createPostgresHarness('g006-run-billing');

function fixtureUuid(index) {
  return `a6000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function hash(label) {
  return `sha256:${createHash('sha256').update(label).digest('hex')}`;
}

function assertVerbosePostgresError(result, sqlState, exactMessage, context) {
  const diagnostics = result.stderr
    .split(/\r?\n/u)
    .map((line) => line.match(/^ERROR:[\t ]+([0-9A-Z]{5}):[\t ]+(.*)$/u))
    .filter((match) => match !== null)
    .map((match) => ({ message: match[2], sqlState: match[1] }));
  const matched = diagnostics.some(
    (diagnostic) => diagnostic.sqlState === sqlState && diagnostic.message === exactMessage,
  );
  if (!Number.isInteger(result.exitCode) || result.exitCode <= 0 || !matched) {
    throw new Error(
      `${context}: expected ERROR diagnostic ${sqlState}: ${exactMessage}, received ${result.stderr}`,
    );
  }
}

function assertVerbosePostgresErrorRejectsEchoOnly() {
  const sqlState = '42501';
  const exactMessage = 'session_user must be a direct inheriting ba_migrator member';
  assertVerbosePostgresError(
    { exitCode: 3, stderr: `ERROR:  ${sqlState}: ${exactMessage}`, stdout: '' },
    sqlState,
    exactMessage,
    'verbose PostgreSQL diagnostic parser accepts a real ERROR line',
  );

  let echoOnlyWasRejected = false;
  try {
    assertVerbosePostgresError(
      {
        exitCode: 3,
        stderr: `RAISE EXCEPTION '${exactMessage}' USING ERRCODE = '${sqlState}';`,
        stdout: '',
      },
      sqlState,
      exactMessage,
      'verbose PostgreSQL diagnostic parser rejects echo-only stderr',
    );
  } catch {
    echoOnlyWasRejected = true;
  }
  if (!echoOnlyWasRejected) {
    throw new Error('verbose PostgreSQL diagnostic parser accepted echo-only stderr');
  }

  let nullExitWasRejected = false;
  try {
    assertVerbosePostgresError(
      { exitCode: null, stderr: `ERROR:  ${sqlState}: ${exactMessage}`, stdout: '' },
      sqlState,
      exactMessage,
      'verbose PostgreSQL diagnostic parser rejects a signal-style null exit code',
    );
  } catch {
    nullExitWasRejected = true;
  }
  if (!nullExitWasRejected) {
    throw new Error('verbose PostgreSQL diagnostic parser accepted a null exit code');
  }
}

const ids = Object.freeze({
  admin: fixtureUuid(1),
  attestation: fixtureUuid(2),
  workspace: fixtureUuid(3),
  credential: fixtureUuid(4),
  credentialKey: fixtureUuid(5),
  flow: fixtureUuid(6),
  flowDraft: fixtureUuid(7),
  flowVersion: fixtureUuid(8),
  profilePolicy: fixtureUuid(9),
  profilePolicyVersion: fixtureUuid(10),
  grantPolicy: fixtureUuid(11),
  grantPolicyVersion: fixtureUuid(12),
  scopePolicy: fixtureUuid(13),
  scopePolicyVersion: fixtureUuid(14),
  flowDeployment: fixtureUuid(15),
  flowRevision: fixtureUuid(16),
  flowCreateGrant: fixtureUuid(17),
  flowReadGrant: fixtureUuid(18),
  flowEventsGrant: fixtureUuid(19),
  flowCancelGrant: fixtureUuid(20),
  ownerAttestation: fixtureUuid(21),
  terminalRun: fixtureUuid(400),
  terminalAcceptedRequest: fixtureUuid(401),
  terminalEvent: fixtureUuid(402),
  terminalPreEvent: fixtureUuid(403),
  terminalCheckpoint: fixtureUuid(404),
  terminalOutbox: fixtureUuid(405),
  archiveManifest: fixtureUuid(406),
  archiveVerification: fixtureUuid(407),
  archiveApproval: fixtureUuid(408),
  eventsPurgeReceipt: fixtureUuid(409),
  recoveryPurgeReceipt: fixtureUuid(410),
  recoveryBlockingOutbox: fixtureUuid(411),
  retentionAttentionRun: fixtureUuid(412),
  retentionAttentionEvent: fixtureUuid(413),
  retentionAttentionPurgeReceipt: fixtureUuid(414),
  retentionHeldReservation: fixtureUuid(415),
  archiveConflictRun: fixtureUuid(420),
  archiveConflictAcceptedRequest: fixtureUuid(421),
  archiveConflictTerminalEvent: fixtureUuid(422),
  archiveConflictManifest: fixtureUuid(423),
  archiveConflictVerification: fixtureUuid(424),
  archiveConflictApproval: fixtureUuid(425),
});

const material = Object.freeze({
  attestation: randomBytes(32).toString('hex'),
  credentialVerifier: randomBytes(32).toString('hex'),
  issuerSubject: randomBytes(32).toString('hex'),
  ownerAttestation: randomBytes(32).toString('hex'),
});

const hashes = Object.freeze({
  flow: hash('g006-flow-version'),
  flowDraft: hash('g006-flow-draft'),
  flowManifest: hash('g006-flow-manifest'),
  profilePolicy: hash('g006-profile-policy'),
  grantPolicy: hash('g006-entry-grant-policy'),
  scopePolicy: hash('g006-entry-scope-policy'),
  revision: hash('g006-flow-revision'),
  revisionManifest: hash('g006-flow-revision-manifest'),
  changeSet: hash('g006-flow-change-set'),
  mapping: hash('g006-empty-credential-mapping'),
  archive: hash('g006-terminal-run-archive'),
  verification: hash('g006-terminal-run-verification'),
  approval: hash('g006-terminal-run-approval'),
  terminalIntent: hash('g006-terminal-intent'),
  terminalAdmission: hash('g006-terminal-admission'),
  terminalPlan: hash('g006-terminal-plan'),
  terminalOutput: hash('g006-terminal-output'),
  terminalDependencies: hash('g006-terminal-dependencies'),
  terminalCheckpoint: hash('g006-terminal-checkpoint'),
});

const g006Relations = Object.freeze([
  ['conversations', 'ba_run_owner'],
  ['conversation_states', 'ba_run_owner'],
  ['conversation_messages', 'ba_run_owner'],
  ['run_idempotency_sentinels', 'ba_run_owner'],
  ['runs', 'ba_run_owner'],
  ['run_acceptance_receipts', 'ba_run_owner'],
  ['run_mutation_idempotency', 'ba_run_owner'],
  ['run_attempts', 'ba_run_owner'],
  ['run_steps', 'ba_run_owner'],
  ['run_events', 'ba_run_owner'],
  ['run_checkpoints', 'ba_run_owner'],
  ['human_gates', 'ba_run_owner'],
  ['outbox', 'ba_run_owner'],
  ['run_parent_links', 'ba_run_owner'],
  ['credit_reservations', 'ba_billing_owner'],
  ['credits_ledger', 'ba_billing_owner'],
  ['run_budget_allocations', 'ba_billing_owner'],
  ['run_billing_reconciliations', 'ba_billing_owner'],
  ['run_archive_manifests', 'ba_archive_evidence_owner'],
  ['run_archive_verification_receipts', 'ba_archive_evidence_owner'],
  ['run_archive_approval_receipts', 'ba_archive_evidence_owner'],
  ['run_retention_purge_receipts', 'ba_retention'],
]);

const runtimeOriginalRunFunctions = Object.freeze([
  'auth.authenticate_browser_session_identity(uuid,bytea,text,text,text)',
  'app.lock_original_run_idempotency_namespace(jsonb)',
  'app.read_original_run(uuid,jsonb)',
  'app.read_original_run_events(uuid,jsonb)',
  'app.request_run_cancellation(jsonb)',
]);

const internalOriginalRunFunctions = Object.freeze([
  'app.require_original_run_authorization(uuid,text,jsonb)',
  'app.authorize_agent_original_run(uuid,uuid,uuid,text,timestamp with time zone)',
  'app.authorize_flow_original_run(uuid,uuid,uuid,text,timestamp with time zone)',
  'auth.authorize_browser_original_run(uuid,uuid,uuid,uuid,text,bigint,bigint,bigint)',
]);

const ownerOnlyFunctions = Object.freeze([
  'app.create_prepared_conversation(jsonb)',
  'app.accept_prepared_agent_chat_run(jsonb)',
  'app.accept_prepared_flow_run(jsonb)',
  'app.finalize_run(jsonb)',
  'app.lock_run_retention_summary(uuid,uuid)',
  'app.create_child_run(jsonb)',
  'app.allocate_child_run_budget(jsonb)',
  'app.mutate_human_gate(text,jsonb)',
  'app.reserve_credits(uuid,uuid,uuid,uuid,bigint,text,text,text,text,timestamp with time zone,timestamp with time zone)',
  'app.settle_credits(uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,text,jsonb,timestamp with time zone)',
  'app.release_credits(uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,text,text,timestamp with time zone)',
  'app.expire_credit_reservation(uuid,uuid,uuid,uuid,text,text,text,timestamp with time zone)',
  'app.reconcile_run_billing(uuid,uuid,uuid,uuid,uuid,text,text,text,text,bigint,bigint,text,text,timestamp with time zone)',
  'app.register_run_archive_manifest(jsonb)',
  'app.verify_run_archive(jsonb)',
  'app.approve_run_archive(jsonb)',
  'app.purge_run_events(jsonb)',
  'app.purge_run_recovery_material(jsonb)',
]);

const g006OwnerFunctions = Object.freeze([
  ['ba_run_owner', 'app.reject_g006_immutable_change()'],
  ['ba_run_owner', 'app.reject_g006_unavailable_path()'],
  ['ba_run_owner', 'app.protect_run_change()'],
  ['ba_run_owner', 'app.protect_run_event_change()'],
  ['ba_run_owner', 'app.validate_billing_producer(uuid,uuid,uuid,uuid,bigint,uuid)'],
  ['ba_run_owner', 'app.create_prepared_conversation(jsonb)'],
  ['ba_run_owner', 'app.accept_prepared_agent_chat_run(jsonb)'],
  ['ba_run_owner', 'app.accept_prepared_flow_run(jsonb)'],
  ['ba_run_owner', 'app.finalize_run(jsonb)'],
  ['ba_run_owner', 'app.lock_run_retention_summary(uuid,uuid)'],
  ['ba_run_owner', 'app.create_child_run(jsonb)'],
  ['ba_run_owner', 'app.mutate_human_gate(text,jsonb)'],
  ['ba_run_owner', 'app.lock_original_run_idempotency_namespace(jsonb)'],
  ['ba_run_owner', 'app.require_original_run_authorization(uuid,text,jsonb)'],
  ['ba_run_owner', 'app.read_original_run(uuid,jsonb)'],
  ['ba_run_owner', 'app.read_original_run_events(uuid,jsonb)'],
  ['ba_run_owner', 'app.request_run_cancellation(jsonb)'],
  ['ba_billing_owner', 'app.lock_billing_workspace(uuid)'],
  ['ba_billing_owner', 'app.lock_billing_reservation_summary(uuid,uuid,uuid)'],
  [
    'ba_billing_owner',
    'app.reserve_credits(uuid,uuid,uuid,uuid,bigint,text,text,text,text,timestamp with time zone,timestamp with time zone)',
  ],
  [
    'ba_billing_owner',
    'app.settle_credits(uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,text,jsonb,timestamp with time zone)',
  ],
  [
    'ba_billing_owner',
    'app.release_credits(uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,text,text,timestamp with time zone)',
  ],
  [
    'ba_billing_owner',
    'app.expire_credit_reservation(uuid,uuid,uuid,uuid,text,text,text,timestamp with time zone)',
  ],
  [
    'ba_billing_owner',
    'app.reconcile_run_billing(uuid,uuid,uuid,uuid,uuid,text,text,text,text,bigint,bigint,text,text,timestamp with time zone)',
  ],
  ['ba_billing_owner', 'app.allocate_child_run_budget(jsonb)'],
  ['ba_archive_evidence_owner', 'app.register_run_archive_manifest(jsonb)'],
  ['ba_archive_evidence_owner', 'app.verify_run_archive(jsonb)'],
  ['ba_archive_evidence_owner', 'app.approve_run_archive(jsonb)'],
  ['ba_retention', 'app.purge_run_events(jsonb)'],
  ['ba_retention', 'app.purge_run_recovery_material(jsonb)'],
]);

const runOwnerExternalFunctions = Object.freeze([
  'app.validate_agent_acceptance_target(uuid,uuid,uuid,uuid,uuid,uuid,text)',
  'app.validate_flow_acceptance_target(uuid,uuid,uuid,uuid,uuid)',
  'app.authorize_agent_original_run(uuid,uuid,uuid,text,timestamp with time zone)',
  'app.authorize_flow_original_run(uuid,uuid,uuid,text,timestamp with time zone)',
  'auth.authenticate_browser_session_identity(uuid,bytea,text,text,text)',
  'auth.authorize_browser_original_run(uuid,uuid,uuid,uuid,text,bigint,bigint,bigint)',
  'app.lock_billing_workspace(uuid)',
  'app.lock_billing_reservation_summary(uuid,uuid,uuid)',
  'app.reserve_credits(uuid,uuid,uuid,uuid,bigint,text,text,text,text,timestamp with time zone,timestamp with time zone)',
  'app.settle_credits(uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,text,jsonb,timestamp with time zone)',
  'app.release_credits(uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,text,text,timestamp with time zone)',
  'app.expire_credit_reservation(uuid,uuid,uuid,uuid,text,text,text,timestamp with time zone)',
]);

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function bytea(hex) {
  return `decode('${hex}', 'hex')`;
}

function jsonb(value) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

function openInteractivePsql(role) {
  const child = spawn(
    'docker',
    [
      'compose',
      '--file',
      composeFile,
      '--project-name',
      harness.projectName,
      'exec',
      '--no-TTY',
      'postgres',
      'psql',
      '--no-psqlrc',
      '--quiet',
      '--set=ON_ERROR_STOP=1',
      '--set=VERBOSITY=verbose',
      '--username',
      role,
      '--dbname',
      'better_agent_test',
    ],
    {
      cwd: harnessDirectory,
      env: process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  let sequence = 0;
  let terminalError;
  let exitCode;
  const markerWaiters = new Set();
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  function rejectMarkerWaiters(error) {
    for (const waiter of markerWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    markerWaiters.clear();
  }

  function resolveVisibleMarkers() {
    for (const waiter of markerWaiters) {
      if (!stdout.includes(waiter.marker)) continue;
      clearTimeout(waiter.timeout);
      markerWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
    resolveVisibleMarkers();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  child.on('error', (error) => {
    terminalError = new Error(`interactive PostgreSQL client could not start: ${error.message}`);
    rejectMarkerWaiters(terminalError);
    resolveClosed();
  });
  child.on('close', (code) => {
    exitCode = code;
    if (code !== 0 && terminalError === undefined) {
      terminalError = new Error(
        `interactive PostgreSQL client exited with ${String(code)} (${String(stderr.length)} stderr bytes)`,
      );
    }
    if (terminalError !== undefined) rejectMarkerWaiters(terminalError);
    resolveClosed();
  });

  async function execute(sql, context) {
    if (terminalError !== undefined) throw terminalError;
    if (exitCode !== undefined) {
      throw new Error(`${context}: interactive PostgreSQL client is already closed`);
    }
    const marker = `__G006_RETENTION_${sequence}_${randomBytes(8).toString('hex')}__`;
    sequence += 1;
    const visible = new Promise((resolve, reject) => {
      const waiter = {
        marker,
        reject,
        resolve,
        timeout: setTimeout(() => {
          markerWaiters.delete(waiter);
          reject(new Error(`${context}: timed out waiting for the PostgreSQL transaction marker`));
        }, 15_000),
      };
      markerWaiters.add(waiter);
    });
    child.stdin.write(`${sql}\n\\echo ${marker}\n`);
    await visible;
  }

  async function close() {
    if (exitCode === undefined && terminalError === undefined) child.stdin.end('\\q\n');
    await closed;
    if (terminalError !== undefined) throw terminalError;
  }

  return Object.freeze({ close, execute });
}

async function waitForFunctionParentLock(
  waiterApplicationName,
  blockerApplicationName,
  functionName,
  parentTable,
  context,
) {
  const observationSql = `WITH RECURSIVE blocking_chain(
  waiter_pid, blocking_pid, visited_pids
) AS (
  SELECT waiter.pid, blocked_by.pid, ARRAY[waiter.pid, blocked_by.pid]
  FROM pg_catalog.pg_stat_activity AS waiter
  CROSS JOIN LATERAL unnest(
    pg_catalog.pg_blocking_pids(waiter.pid)
  ) AS blocked_by(pid)
  WHERE waiter.application_name = ${sqlLiteral(waiterApplicationName)}
  UNION ALL
  SELECT chain.waiter_pid, blocked_by.pid, chain.visited_pids || blocked_by.pid
  FROM blocking_chain AS chain
  CROSS JOIN LATERAL unnest(
    pg_catalog.pg_blocking_pids(chain.blocking_pid)
  ) AS blocked_by(pid)
  WHERE NOT blocked_by.pid = ANY(chain.visited_pids)
)
SELECT count(*)
FROM pg_catalog.pg_stat_activity AS waiter
WHERE waiter.application_name = ${sqlLiteral(waiterApplicationName)}
  AND waiter.wait_event_type = 'Lock'
  AND waiter.query LIKE ${sqlLiteral(`%SELECT app.${functionName}(%`)}
  AND EXISTS (
    SELECT 1
    FROM blocking_chain AS chain
    JOIN pg_catalog.pg_stat_activity AS blocker
      ON blocker.pid = chain.blocking_pid
    WHERE chain.waiter_pid = waiter.pid
      AND blocker.application_name = ${sqlLiteral(blockerApplicationName)}
      AND blocker.state = 'idle in transaction'
      AND blocker.query LIKE ${sqlLiteral(`%FROM public.${parentTable}%`)}
      AND blocker.query LIKE '%FOR UPDATE%'
  );`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const observed = await harness.queryScalar('ba_bootstrap_test', observationSql);
    if (observed === '1') return;
    if (observed !== '0') {
      throw new Error(`${context}: expected one lock waiter, observed ${observed}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${context}: expected blocking edge was not observed`);
}

function valuesSql(rows) {
  return rows.map((row) => `(${row.map(sqlLiteral).join(', ')})`).join(',\n    ');
}

function pin(kind, resourceId, resourceVersionId, contractHash) {
  return {
    binding_mode: 'pinned',
    contract_hash: contractHash,
    published_resource_kind: kind,
    resource_id: resourceId,
    resource_version_id: resourceVersionId,
    workspace_id: ids.workspace,
  };
}

function preparedResource({ document, fullPin, manifestHash, dependencies = [] }) {
  return {
    canonical_document: JSON.stringify(document),
    dependency_manifest: {
      dependencies,
      manifest_hash: manifestHash,
      owner: fullPin,
      schema_version: 'published-resource-dependency-manifest/1',
    },
    full_pin: fullPin,
    schema_version: 'prepared-published-resource/1',
  };
}

function policyPin(policyId, policyVersionId, contractHash) {
  return {
    contract_hash: contractHash,
    policy_id: policyId,
    policy_version_id: policyVersionId,
  };
}

function flowVersionPrepared() {
  const document = {
    credential_requirements: [],
    flow_id: ids.flow,
    flow_version_id: ids.flowVersion,
    schema_version: 'flow-ir/1',
    workspace_id: ids.workspace,
  };
  return preparedResource({
    document,
    fullPin: pin('FLOW_VERSION', ids.flow, ids.flowVersion, hashes.flow),
    manifestHash: hashes.flowManifest,
  });
}

function flowDeploymentPrepared() {
  const flowPin = pin('FLOW_VERSION', ids.flow, ids.flowVersion, hashes.flow);
  const revisionPin = pin(
    'DEPLOYMENT_REVISION',
    ids.flowDeployment,
    ids.flowRevision,
    hashes.revision,
  );
  const document = {
    change_set_hash: hashes.changeSet,
    credential_mapping_hash: hashes.mapping,
    credential_mappings: [],
    dependency_manifest_hash: hashes.revisionManifest,
    entry_grant_policy: policyPin(ids.grantPolicy, ids.grantPolicyVersion, hashes.grantPolicy),
    entry_scope_policy: policyPin(ids.scopePolicy, ids.scopePolicyVersion, hashes.scopePolicy),
    environment: 'staging',
    flow_deployment_id: ids.flowDeployment,
    flow_deployment_revision_id: ids.flowRevision,
    flow_id: ids.flow,
    flow_version: flowPin,
    ingress_channel: 'service_api',
    policy_profile: policyPin(ids.profilePolicy, ids.profilePolicyVersion, hashes.profilePolicy),
    revision_contract_hash: hashes.revision,
    schema_version: 'flow-deployment/1',
    workspace_id: ids.workspace,
  };
  return preparedResource({
    dependencies: [flowPin],
    document,
    fullPin: revisionPin,
    manifestHash: hashes.revisionManifest,
  });
}

function flowGrant(entryGrantId, scope) {
  return {
    authorization_epoch: 0,
    credential_id: ids.credential,
    credential_kind: 'service_api',
    entry_audience: 'flow_runtime_api',
    entry_grant_id: entryGrantId,
    flow_deployment_id: ids.flowDeployment,
    ingress_channel: 'service_api',
    principal_mode: 'credential_service_principal',
    schema_version: 'flow-deployment-entry-grant/1',
    scope,
    status: 'ACTIVE',
    target_cardinality: 'exactly_one_flow_deployment',
    workspace_id: ids.workspace,
  };
}

function acceptanceFact(base, idempotencyKey, reservedCredits) {
  const runId = fixtureUuid(base);
  const acceptedRequestId = fixtureUuid(base + 1);
  const acceptedAt = '2026-08-27T00:00:00.000Z';
  const acceptedPlanHash = hash(`g006-plan-${base}`);
  return Object.freeze({
    accepted_at: acceptedAt,
    accepted_event_id: fixtureUuid(base + 4),
    accepted_output_schema_hash: hash(`g006-output-${base}`),
    accepted_output_schema_ref: 'schema://g006/flow-output',
    accepted_plan_hash: acceptedPlanHash,
    accepted_request_id: acceptedRequestId,
    acceptance_receipt_data_redacted: {
      accepted_request_id: acceptedRequestId,
      events_url: `/v1/oapi/runs/${runId}/events`,
      operation_url: `/v1/oapi/runs/${runId}`,
      run_id: runId,
      status: 'QUEUED',
    },
    admission_snapshot_hash: hash(`g006-admission-${base}`),
    credential_id: ids.credential,
    dependency_pins_hash: hash(`g006-dependencies-${base}`),
    dispatch_outbox_id: fixtureUuid(base + 5),
    flow_deployment_id: ids.flowDeployment,
    flow_deployment_revision_id: ids.flowRevision,
    flow_id: ids.flow,
    flow_version_id: ids.flowVersion,
    idempotency_key: idempotencyKey,
    intent_hash: hash(`g006-intent-${base}`),
    receipt_id: fixtureUuid(base + 3),
    reservation_expires_at: '2026-08-28T00:00:00.000Z',
    reservation_id: fixtureUuid(base + 6),
    reserve_billing_intent_hash: hash(`g006-reserve-intent-${base}`),
    reserve_charge_attribution_hash: acceptedPlanHash,
    reserve_charge_key: `g006-reserve-${base}`,
    reserve_ledger_entry_id: fixtureUuid(base + 7),
    reserved_credits: String(reservedCredits),
    run_id: runId,
    sentinel_id: fixtureUuid(base + 2),
    workspace_id: ids.workspace,
  });
}

function failureTerminalFact(runFact, base, attemptId) {
  const finishedAt = '2026-08-27T02:00:00.000Z';
  return Object.freeze({
    attempt_id: attemptId,
    events_retention_until: '2026-09-03T02:00:00.000Z',
    finished_at: finishedAt,
    lease_fencing_token: '1',
    metering_detail_redacted: { outcome: 'failure' },
    producer_run_id: runFact.run_id,
    recovery_retention_until: '2026-09-26T02:00:00.000Z',
    release_charge_attribution_hash: hash(`g006-terminal-release-attribution-${base}`),
    release_charge_key: `g006-terminal-release-${base}`,
    release_billing_intent_hash: hash(`g006-terminal-release-intent-${base}`),
    release_ledger_entry_id: fixtureUuid(base + 6),
    release_reason_code: 'TERMINAL_RELEASE',
    released_credits: '0',
    reservation_id: runFact.reservation_id,
    retention_until: '2026-10-01T02:00:00.000Z',
    run_id: runFact.run_id,
    settle_charge_attribution_hash: hash(`g006-terminal-settle-attribution-${base}`),
    settle_charge_key: `g006-terminal-settle-${base}`,
    settle_billing_intent_hash: hash(`g006-terminal-settle-intent-${base}`),
    settle_ledger_entry_id: fixtureUuid(base + 5),
    settled_credits: '0',
    step_id: null,
    terminal_error_redacted: {
      code: 'G006_FIXTURE_FAILURE',
      retryable: false,
    },
    terminal_event_id: fixtureUuid(base + 2),
    terminal_intent_hash: hash(`g006-terminal-intent-${base}`),
    terminal_kind: 'FAILED',
    terminal_outbox_id: fixtureUuid(base + 3),
    terminal_step_id: fixtureUuid(base + 1),
    termination_reason: 'INTERNAL_FAILURE',
    workspace_id: ids.workspace,
  });
}

function controlContextSql(body) {
  return `BEGIN;
SELECT auth.establish_control_workspace_context(
  '${ids.attestation}',
  ${bytea(material.attestation)}
);
${body}
COMMIT;`;
}

function runtimeContextSql(body) {
  return `BEGIN;
DO $runtime_context$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM auth.authenticate_api_credential(
      '${ids.credentialKey}',
      ${bytea(material.credentialVerifier)}
    )
  ) THEN
    RAISE EXCEPTION 'fixture service credential failed authentication';
  END IF;
END;
$runtime_context$;
${body}
COMMIT;`;
}

function ownerControlContextPrelude(owner, beforeRole = '') {
  return `BEGIN;
DO $signed_owner_context$
BEGIN
  PERFORM set_config(
    'app.tenant_context',
    format(
      'control:%s:%s:%s:%s:%s',
      '${ids.workspace}'::uuid,
      '${ids.ownerAttestation}'::uuid,
      '${ids.admin}'::uuid,
      txid_current(),
      encode(
        public.hmac(
          convert_to(
            format(
              'control:%s:%s:%s:%s:%s',
              '${ids.workspace}'::uuid,
              '${ids.ownerAttestation}'::uuid,
              '${ids.admin}'::uuid,
              txid_current(),
              session_user
            ),
            'UTF8'
          ),
          ${bytea(material.ownerAttestation)},
          'sha256'
        ),
        'hex'
      )
    ),
    true
  );
END;
$signed_owner_context$;
${beforeRole}
SET LOCAL ROLE ${owner};
DO $owner_context$
BEGIN
  IF app.current_workspace_id() IS DISTINCT FROM '${ids.workspace}'::uuid THEN
    RAISE EXCEPTION 'owner fixture lost its signed Workspace context';
  END IF;
END;
$owner_context$;
`;
}

function ownerControlContextSql(owner, body, beforeRole = '') {
  return `${ownerControlContextPrelude(owner, beforeRole)}${body}
COMMIT;`;
}

function ownerCredentialContextSql(owner, body, beforeRole = '') {
  return `BEGIN;
DO $signed_owner_credential_context$
BEGIN
  PERFORM set_config(
    'app.tenant_context',
    format(
      'credential:%s:%s:%s:%s',
      '${ids.workspace}'::uuid,
      '${ids.credential}'::uuid,
      txid_current(),
      encode(
        public.hmac(
          convert_to(
            format(
              'credential:%s:%s:%s:%s',
              '${ids.workspace}'::uuid,
              '${ids.credential}'::uuid,
              txid_current(),
              session_user
            ),
            'UTF8'
          ),
          ${bytea(material.credentialVerifier)},
          'sha256'
        ),
        'hex'
      )
    ),
    true
  );
END;
$signed_owner_credential_context$;
${beforeRole}
SET LOCAL ROLE ${owner};
DO $owner_context$
BEGIN
  IF app.current_workspace_id() IS DISTINCT FROM '${ids.workspace}'::uuid
     OR app.current_api_credential_id() IS DISTINCT FROM '${ids.credential}'::uuid THEN
    RAISE EXCEPTION 'owner fixture lost its signed credential context';
  END IF;
END;
$owner_context$;
${body}
COMMIT;`;
}

async function expectRejected(role, sql, pattern, context) {
  const result = await harness.psql(role, sql, { allowFailure: true });
  assertRejected(result, pattern, context);
}

function ownerPsql(owner, body, options = {}) {
  return harness.psql('ba_migrator_test', ownerControlContextSql(owner, body), options);
}

async function expectOwnerRejected(owner, body, pattern, context) {
  const result = await ownerPsql(owner, body, { allowFailure: true });
  assertRejected(result, pattern, context);
}

async function assertConcurrentRetentionReplay(functionName, fact, materialKind) {
  const suffix = materialKind.toLowerCase();
  const blockerApplicationName = `g006-${suffix}-run-blocker-${process.pid}`;
  const waiterApplicationNames = [
    `g006-${suffix}-purge-a-${process.pid}`,
    `g006-${suffix}-purge-b-${process.pid}`,
  ];
  const blocker = openInteractivePsql('ba_migrator_test');
  const shadowSetup =
    materialKind === 'EVENTS'
      ? `CREATE TEMP TABLE run_events (
  event_id uuid PRIMARY KEY,
  marker text NOT NULL
);
INSERT INTO pg_temp.run_events (event_id, marker)
VALUES ('${fixtureUuid(9930)}', 'events-purge-attacker');`
      : `CREATE TEMP TABLE run_checkpoints (
  checkpoint_id uuid PRIMARY KEY,
  marker text NOT NULL
);
CREATE TEMP TABLE outbox (
  message_id uuid PRIMARY KEY,
  marker text NOT NULL
);
INSERT INTO pg_temp.run_checkpoints (checkpoint_id, marker)
VALUES ('${fixtureUuid(9931)}', 'recovery-checkpoint-attacker');
INSERT INTO pg_temp.outbox (message_id, marker)
VALUES ('${fixtureUuid(9932)}', 'recovery-outbox-attacker');`;
  const shadowReadback =
    materialKind === 'EVENTS'
      ? `DO $events_purge_temp_readback$
BEGIN
  IF (SELECT count(*) FROM pg_temp.run_events) <> 1 THEN
    RAISE EXCEPTION 'EVENTS purge mutated attacker pg_temp relation';
  END IF;
END;
$events_purge_temp_readback$;`
      : `DO $recovery_purge_temp_readback$
BEGIN
  IF (SELECT count(*) FROM pg_temp.run_checkpoints) <> 1
     OR (SELECT count(*) FROM pg_temp.outbox) <> 1 THEN
    RAISE EXCEPTION 'RECOVERY purge mutated attacker pg_temp relation';
  END IF;
END;
$recovery_purge_temp_readback$;`;
  let blockerCommitted = false;
  let outcomesPromise;
  let outcomes;
  const failures = [];

  try {
    await blocker.execute(
      `${ownerControlContextPrelude('ba_run_owner')}
SELECT set_config('application_name', ${sqlLiteral(blockerApplicationName)}, false);
SELECT 1
FROM public.runs
WHERE workspace_id = '${ids.workspace}'
  AND id = '${fact.run_id}'
FOR UPDATE;`,
      `hold ${materialKind} Run lock before both receipt prechecks`,
    );
    const outcomePromises = [];
    for (const applicationName of waiterApplicationNames) {
      outcomePromises.push(
        harness.psql(
          'ba_migrator_test',
          ownerControlContextSql(
            'ba_retention',
            `SELECT set_config('application_name', ${sqlLiteral(applicationName)}, false);
SELECT app.${functionName}(${jsonb(fact)});
RESET ROLE;
${shadowReadback}`,
            shadowSetup,
          ),
          { allowFailure: true },
        ),
      );
      outcomesPromise = Promise.all(outcomePromises);
      await waitForFunctionParentLock(
        applicationName,
        blockerApplicationName,
        functionName,
        'runs',
        `${materialKind} purge reaches the Run lock after an empty receipt precheck`,
      );
    }
    await blocker.execute('COMMIT;', `release ${materialKind} Run lock`);
    blockerCommitted = true;
    outcomes = await outcomesPromise;
  } catch (error) {
    failures.push(error);
  }

  if (!blockerCommitted) {
    try {
      await blocker.execute('COMMIT;', `release failed ${materialKind} Run blocker`);
      blockerCommitted = true;
    } catch (error) {
      failures.push(error);
    }
  }
  if (outcomesPromise !== undefined && outcomes === undefined) {
    try {
      outcomes = await outcomesPromise;
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await blocker.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `${materialKind} concurrent purge and cleanup failed`);
  }

  for (const [index, outcome] of outcomes.entries()) {
    assertEqual(
      String(outcome.exitCode),
      '0',
      `${materialKind} concurrent purge ${String(index + 1)} replays instead of colliding`,
    );
  }
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT count(*)
FROM public.run_retention_purge_receipts
WHERE workspace_id = '${ids.workspace}'
  AND run_id = '${fact.run_id}'
  AND material_kind = '${materialKind}';`,
    ),
    '1',
    `${materialKind} concurrent same-intent purge writes one durable receipt`,
  );
}

async function runConcurrentArchiveEvidence({
  blockerOwner,
  facts,
  functionName,
  label,
  parentPredicate,
  parentTable,
}) {
  const blockerApplicationName = `g006-${label}-parent-blocker-${process.pid}`;
  const waiterApplicationNames = [
    `g006-${label}-writer-a-${process.pid}`,
    `g006-${label}-writer-b-${process.pid}`,
  ];
  const blocker = openInteractivePsql('ba_migrator_test');
  let blockerCommitted = false;
  let outcomesPromise;
  let outcomes;
  const failures = [];

  try {
    await blocker.execute(
      `${ownerControlContextPrelude(blockerOwner)}
SELECT set_config('application_name', ${sqlLiteral(blockerApplicationName)}, false);
SELECT 1
FROM public.${parentTable}
WHERE ${parentPredicate}
FOR UPDATE;`,
      `hold ${label} authoritative parent lock before both first writes`,
    );
    const outcomePromises = [];
    for (const [index, applicationName] of waiterApplicationNames.entries()) {
      outcomePromises.push(
        ownerPsql(
          'ba_archive_evidence_owner',
          `SET LOCAL application_name = ${sqlLiteral(applicationName)};
SELECT app.${functionName}(${jsonb(facts[index])});`,
          { allowFailure: true, tuplesOnly: true },
        ),
      );
      outcomesPromise = Promise.all(outcomePromises);
      await waitForFunctionParentLock(
        applicationName,
        blockerApplicationName,
        functionName,
        parentTable,
        `${label} writer reaches the authoritative parent lock after an empty child precheck`,
      );
    }
    await blocker.execute('COMMIT;', `release ${label} authoritative parent lock`);
    blockerCommitted = true;
    outcomes = await outcomesPromise;
  } catch (error) {
    failures.push(error);
  }

  if (!blockerCommitted) {
    try {
      await blocker.execute('COMMIT;', `release failed ${label} parent blocker`);
      blockerCommitted = true;
    } catch (error) {
      failures.push(error);
    }
  }
  if (outcomesPromise !== undefined && outcomes === undefined) {
    try {
      outcomes = await outcomesPromise;
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await blocker.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `${label} concurrent writers and cleanup failed`);
  }
  return outcomes;
}

async function assertConcurrentArchiveReplay(options) {
  const { expectedId, label, rowCountSql } = options;
  const outcomes = await runConcurrentArchiveEvidence(options);
  for (const [index, outcome] of outcomes.entries()) {
    assertEqual(
      String(outcome.exitCode),
      '0',
      `${label} identical-intent writer ${String(index + 1)} succeeds`,
    );
    assertEqual(
      outcome.stdout.trim(),
      expectedId,
      `${label} identical-intent writer ${String(index + 1)} returns the canonical UUID`,
    );
  }
  assertEqual(
    await harness.queryScalar('ba_bootstrap_test', rowCountSql),
    '1',
    `${label} identical-intent first writes create one durable row`,
  );
}

async function assertConcurrentArchiveConflict(options) {
  const { conflictPattern, expectedId, label, rowCountSql } = options;
  const outcomes = await runConcurrentArchiveEvidence(options);
  const succeeded = outcomes.filter(({ exitCode }) => exitCode === 0);
  const rejected = outcomes.filter(({ exitCode }) => exitCode !== 0);
  assertEqual(
    `${succeeded.length}|${rejected.length}`,
    '1|1',
    `${label} different-intent first writes have exactly one winner`,
  );
  assertEqual(
    succeeded[0]?.stdout.trim() ?? '',
    expectedId,
    `${label} different-intent winner returns the canonical UUID`,
  );
  assertRejected(
    rejected[0],
    conflictPattern,
    `${label} different-intent loser reports its fact conflict`,
  );
  if (!/23505/u.test(rejected[0]?.stderr ?? '')) {
    throw new Error(`${label} different-intent loser did not report SQLSTATE 23505`);
  }
  assertEqual(
    await harness.queryScalar('ba_bootstrap_test', rowCountSql),
    '1',
    `${label} different-intent first writes create one durable row`,
  );
}

async function seedRunAttempt(runId, base) {
  const attemptId = fixtureUuid(base);
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.run_attempts (
  workspace_id, id, run_id, attempt_number, status,
  lease_owner, lease_token, lease_fencing_token, lease_expires_at,
  started_at, created_at
) VALUES (
  '${ids.workspace}', '${attemptId}', '${runId}', 1, 'RUNNING',
  'g006-owner-fixture', '${fixtureUuid(base + 1)}', 1,
  '2026-08-28T00:00:00.000Z',
  '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'
);`,
  );
  return attemptId;
}

async function assert004RejectsIndirectMigratorEnrollmentBeforeInstall() {
  const loadedMigrations = await loadMigrations(migrationDirectory);
  const through003 = selectMigrationMilestone(
    loadedMigrations,
    '003',
    'G0-06 indirect migrator prerequisite',
  );
  const through004 = selectMigrationMilestone(
    loadedMigrations,
    '004',
    'G0-06 indirect migrator rejection',
  );
  await harness.psql(
    'ba_bootstrap_test',
    `CREATE ROLE ba_g006_indirect_migrator_group
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE ba_g006_indirect_migrator_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
GRANT ba_migrator TO ba_g006_indirect_migrator_group WITH INHERIT TRUE;
GRANT ba_g006_indirect_migrator_group TO ba_g006_indirect_migrator_test
  WITH INHERIT TRUE;`,
  );

  let indirectApply;
  try {
    await harness.psql('ba_g006_indirect_migrator_test', renderUpMigrationSql(through003), {
      echoErrors: true,
    });
    indirectApply = await harness.psql(
      'ba_g006_indirect_migrator_test',
      renderUpMigrationSql(through004),
      { allowFailure: true },
    );
    assertVerbosePostgresError(
      indirectApply,
      '42501',
      'session_user must be a direct inheriting ba_migrator member',
      '004 rejects a pure indirect NOLOGIN-group migrator enrollment',
    );
    assertEqual(
      await harness.queryScalar(
        'ba_bootstrap_test',
        `SELECT concat_ws('|',
  (SELECT count(*) FROM better_agent_migrations.schema_migrations WHERE version = 4),
  (to_regclass('public.runs') IS NULL)::text,
  (to_regclass('public.credits_ledger') IS NULL)::text
);`,
      ),
      '0|true|true',
      'indirect migrator rejection happens before every 004 ledger and DDL fact',
    );
  } finally {
    await harness.psql(
      'ba_bootstrap_test',
      `REASSIGN OWNED BY ba_g006_indirect_migrator_test TO ba_migrator_test;
REVOKE ba_g006_indirect_migrator_group FROM ba_g006_indirect_migrator_test;
REVOKE ba_migrator FROM ba_g006_indirect_migrator_group;
DROP ROLE ba_g006_indirect_migrator_test;
DROP ROLE ba_g006_indirect_migrator_group;`,
    );
  }
}

async function installFreshSchema() {
  const loadedMigrations = await loadMigrations(migrationDirectory);
  const migrations = selectMigrationMilestone(
    loadedMigrations,
    '004',
    'G0-06 Run/Billing integration',
  );
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), {
    echoErrors: true,
  });

  assertEqual(
    await harness.queryScalar('ba_migrator_test', 'SHOW server_version_num;'),
    await harness.queryScalar(
      'ba_migrator_test',
      "SELECT current_setting('server_version_num') WHERE current_setting('server_version_num')::integer BETWEEN 160000 AND 169999;",
    ),
    'disposable database is PostgreSQL 16',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT string_agg(version::text, ',' ORDER BY version)
FROM better_agent_migrations.schema_migrations;`,
    ),
    '0,1,2,3,4',
    'fresh database applied exactly migrations 000 through 004',
  );

  // A second apply is the checksum/idempotency gate for the same immutable files.
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations));
  return migrations;
}

async function assert004PrerequisiteGuards(migrations) {
  const migration004 = migrations.find(({ id }) => id === '004');
  const prerequisite = migration004?.upSql.match(
    /DO \$g006_platform_prerequisites\$[\s\S]*?\$g006_platform_prerequisites\$;/u,
  )?.[0];
  if (prerequisite === undefined) {
    throw new Error('004 prerequisite block is unavailable for catalog drift probes');
  }

  const unsafePlatformRoles = await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
ALTER ROLE ba_migrator LOGIN;
ALTER ROLE ba_runtime SUPERUSER;
ALTER ROLE ba_control_executor CREATEDB;
ALTER ROLE ba_management_attestation_issuer CREATEROLE;
ALTER ROLE ba_subject_assertion_verifier REPLICATION BYPASSRLS;
SET SESSION AUTHORIZATION ba_migrator_test;
${prerequisite}
ROLLBACK;`,
    { allowFailure: true },
  );
  assertRejected(
    unsafePlatformRoles,
    /platform migration roles must be NOLOGIN and unprivileged: ba_control_executor, ba_management_attestation_issuer, ba_migrator, ba_runtime, ba_subject_assertion_verifier/u,
    '004 rechecks every migrator and executable-role trust attribute before applying',
  );

  const unsafeSession = await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
ALTER ROLE ba_migrator_test SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS;
SET SESSION AUTHORIZATION ba_migrator_test;
${prerequisite}
ROLLBACK;`,
    { allowFailure: true },
  );
  assertRejected(
    unsafeSession,
    /application migrations require an unprivileged LOGIN\+INHERIT session_user/u,
    '004 rechecks every elevated session_user trust attribute before applying',
  );

  const nonLoginSession = await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
ALTER ROLE ba_migrator_test NOLOGIN;
SET SESSION AUTHORIZATION ba_migrator_test;
${prerequisite}
ROLLBACK;`,
    { allowFailure: true },
  );
  assertRejected(
    nonLoginSession,
    /application migrations require an unprivileged LOGIN\+INHERIT session_user/u,
    '004 rejects a session_user whose LOGIN trust attribute drifted closed',
  );

  const nonInheritingSession = await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
ALTER ROLE ba_migrator_test NOINHERIT;
SET SESSION AUTHORIZATION ba_migrator_test;
${prerequisite}
ROLLBACK;`,
    { allowFailure: true },
  );
  assertRejected(
    nonInheritingSession,
    /application migrations require an unprivileged LOGIN\+INHERIT session_user/u,
    '004 rejects a session_user whose role-level INHERIT trust attribute drifted closed',
  );

  const nonInheritingEnrollment = await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
REVOKE ba_migrator FROM ba_migrator_test;
GRANT ba_migrator TO ba_migrator_test WITH INHERIT FALSE;
SET SESSION AUTHORIZATION ba_migrator_test;
${prerequisite}
ROLLBACK;`,
    { allowFailure: true },
  );
  assertRejected(
    nonInheritingEnrollment,
    /session_user must be a direct inheriting ba_migrator member/u,
    '004 rejects a direct ba_migrator enrollment whose edge disables inheritance',
  );

  await harness.psql(
    'ba_bootstrap_test',
    `CREATE ROLE ba_g006_owner_member_probe
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT ba_run_owner TO ba_g006_owner_member_probe;`,
  );
  try {
    await expectRejected(
      'ba_migrator_test',
      prerequisite,
      /owners may only be granted directly to ba_migrator|42501/u,
      '004 rejects an extra direct member of any owner role',
    );
  } finally {
    await harness.psql(
      'ba_bootstrap_test',
      `REVOKE ba_run_owner FROM ba_g006_owner_member_probe;
DROP ROLE ba_g006_owner_member_probe;`,
    );
  }

  await harness.psql('ba_bootstrap_test', 'GRANT ba_migrator, ba_runtime TO ba_plain_app_test;');
  try {
    assertEqual(
      await harness.queryScalar(
        'ba_bootstrap_test',
        `SELECT count(*)
FROM pg_catalog.pg_roles AS owner_role
WHERE owner_role.rolname = ANY (ARRAY[
  'ba_auth_owner',
  'ba_authorization_owner',
  'ba_run_owner',
  'ba_billing_owner',
  'ba_archive_evidence_owner',
  'ba_retention'
]::name[])
  AND pg_catalog.pg_has_role('ba_plain_app_test', owner_role.oid, 'MEMBER');`,
      ),
      '6',
      'transitive overlap fixture reaches all six owners only through ba_migrator',
    );
    await expectRejected(
      'ba_migrator_test',
      prerequisite,
      /non-super LOGIN cannot inherit executable and G0-06 owner capabilities/u,
      '004 rejects transitive executable and owner overlap on one non-super login',
    );
  } finally {
    await harness.psql(
      'ba_bootstrap_test',
      'REVOKE ba_migrator, ba_runtime FROM ba_plain_app_test;',
    );
  }
}

async function seedWorkspaceCredentialAndFlowTarget() {
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces (
  id, name, credits_balance, credits_reserved_balance, credits_balance_version
) VALUES ('${ids.workspace}', 'G0-06 Run/Billing fixture', 0, 0, 0);
INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES ('${ids.workspace}', '${ids.admin}', 'admin');`,
  );
  await harness.psql(
    'ba_management_issuer_test',
    `SELECT auth.issue_control_session_attestation(
  '${ids.attestation}',
  '${ids.workspace}',
  '${ids.admin}',
  'ba_control_test',
  'g006-test-management-idp',
  ${bytea(material.issuerSubject)},
  ${bytea(material.attestation)},
  clock_timestamp() + interval '10 minutes'
);
SELECT auth.issue_control_session_attestation(
  '${ids.ownerAttestation}',
  '${ids.workspace}',
  '${ids.admin}',
  'ba_migrator_test',
  'g006-test-management-idp',
  ${bytea(material.issuerSubject)},
  ${bytea(material.ownerAttestation)},
  clock_timestamp() + interval '10 minutes'
);`,
  );
  await harness.psql(
    'ba_control_test',
    controlContextSql(`SELECT auth.create_api_credential(
  '${ids.credential}',
  '${ids.credentialKey}',
  'g006-service',
  'service_api',
  ${bytea(material.credentialVerifier)},
  ARRAY[
    'flow:run:create',
    'run:read',
    'run:events:read',
    'run:cancel'
  ]::text[],
  '{}'::text[],
  NULL,
  NULL,
  NULL
);`),
  );

  const flowPrepared = flowVersionPrepared();
  const revisionPrepared = flowDeploymentPrepared();
  const grants = [
    flowGrant(ids.flowCreateGrant, 'flow:run:create'),
    flowGrant(ids.flowReadGrant, 'run:read'),
    flowGrant(ids.flowEventsGrant, 'run:events:read'),
    flowGrant(ids.flowCancelGrant, 'run:cancel'),
  ];
  await harness.psql(
    'ba_migrator_test',
    ownerControlContextSql(
      'ba_authorization_owner',
      `SELECT app.create_publishable_resource_root(
  'FLOW_VERSION', '${ids.flow}'
);
SELECT app.append_publishable_resource_draft_revision(
  '${ids.flowDraft}', 'FLOW_VERSION', '${ids.flow}', 1,
  '{"nodes":[],"edges":[]}'::jsonb, '${hashes.flowDraft}'
);
SELECT app.publish_flow_version(${jsonb(flowPrepared)});
SELECT app.publish_deployment_policy_version(
  '${ids.profilePolicyVersion}', '${ids.profilePolicy}',
  'deployment_profile', '${hashes.profilePolicy}',
  '{"schema_version":"deployment-profile/1"}'
);
SELECT app.publish_deployment_policy_version(
  '${ids.grantPolicyVersion}', '${ids.grantPolicy}',
  'entry_grant', '${hashes.grantPolicy}',
  '{"schema_version":"entry-grant-policy/1"}'
);
SELECT app.publish_deployment_policy_version(
  '${ids.scopePolicyVersion}', '${ids.scopePolicy}',
  'entry_scope', '${hashes.scopePolicy}',
  '{"schema_version":"entry-scope-policy/1"}'
);
SELECT app.create_flow_deployment(${jsonb({
        environment: 'staging',
        flow_deployment_id: ids.flowDeployment,
        flow_id: ids.flow,
        ingress_channel: 'service_api',
        public_selector: 'g006-flow-staging',
        schema_version: 'flow-deployment-stable/1',
        workspace_id: ids.workspace,
      })});
SELECT app.publish_flow_deployment_revision(${jsonb(revisionPrepared)});
SELECT app.promote_flow_deployment(
  '${ids.flowDeployment}', '${ids.flowRevision}', 0, 'G0-06 initial activation'
);
SELECT app.transition_flow_deployment_security(
  '${ids.flowDeployment}', 0, 'ACTIVE'
);
${grants.map((grant) => `SELECT app.create_flow_deployment_entry_grant(${jsonb(grant)});`).join('\n')}`,
    ),
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.flow_versions WHERE id = '${ids.flowVersion}'),
  (SELECT count(*) FROM public.flow_deployment_revisions WHERE id = '${ids.flowRevision}'),
  (SELECT count(*) FROM public.flow_deployment_active_pointers
    WHERE flow_deployment_id = '${ids.flowDeployment}'
      AND active_revision_id = '${ids.flowRevision}'),
  (SELECT count(*) FROM public.flow_deployment_entry_grants
    WHERE flow_deployment_id = '${ids.flowDeployment}' AND status = 'ACTIVE')
);`,
    ),
    '1|1|1|4',
    'valid active Flow target and all current original-Run scopes were seeded',
  );
}

async function assertOwnerFixtureRoleSwitchBoundary() {
  await expectRejected(
    'ba_bootstrap_test',
    `BEGIN;
SET LOCAL ROLE ba_control_executor;
SELECT auth.establish_control_workspace_context(
  '${ids.ownerAttestation}',
  ${bytea(material.ownerAttestation)}
);`,
    /isolated control executor login|42501/u,
    'bootstrap superuser cannot impersonate the isolated control login to mint owner context',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      ownerControlContextSql(
        'ba_run_owner',
        `SELECT concat_ws(':',
  current_user,
  app.current_workspace_id(),
  session_user
);`,
      ),
    ),
    `ba_run_owner:${ids.workspace}:ba_migrator_test`,
    'migrator ADMIN OPTION switches to the exact owner under a transaction-bound signed context',
  );
}

async function assertOwnerBoundary() {
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT count(*)
FROM pg_catalog.pg_roles AS role_row
WHERE role_row.rolname = ANY (ARRAY[
  'ba_auth_owner',
  'ba_authorization_owner',
  'ba_run_owner',
  'ba_billing_owner',
  'ba_archive_evidence_owner',
  'ba_retention'
]::name[])
  AND NOT role_row.rolcanlogin
  AND NOT role_row.rolinherit
  AND NOT role_row.rolsuper
  AND NOT role_row.rolcreatedb
  AND NOT role_row.rolcreaterole
  AND NOT role_row.rolreplication
  AND NOT role_row.rolbypassrls;`,
    ),
    '6',
    'all six security and G0-06 owners are isolated NOLOGIN/NOINHERIT roles',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `WITH owners(role_name) AS (
  VALUES
    ('ba_auth_owner'),
    ('ba_authorization_owner'),
    ('ba_run_owner'),
    ('ba_billing_owner'),
    ('ba_archive_evidence_owner'),
    ('ba_retention')
), forbidden(role_name) AS (
  VALUES
    ('ba_runtime'),
    ('ba_control_executor'),
    ('ba_management_attestation_issuer'),
    ('ba_subject_assertion_verifier'),
    ('ba_auth_owner'),
    ('ba_authorization_owner'),
    ('ba_run_owner'),
    ('ba_billing_owner'),
    ('ba_archive_evidence_owner'),
    ('ba_retention')
)
SELECT count(*)
FROM owners
CROSS JOIN forbidden
WHERE owners.role_name <> forbidden.role_name
  AND (
    pg_catalog.pg_has_role(owners.role_name, forbidden.role_name, 'MEMBER')
    OR pg_catalog.pg_has_role(forbidden.role_name, owners.role_name, 'MEMBER')
  );`,
    ),
    '0',
    'G0-06 owners have no executable-role or peer-owner inheritance path',
  );
}

async function assertRelationOwnershipAndRls() {
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `WITH expected(table_name, owner_name) AS (
  VALUES
    ${valuesSql(g006Relations)}
)
SELECT concat_ws('|',
  count(*) FILTER (
    WHERE relation.oid IS NOT NULL
      AND pg_catalog.pg_get_userbyid(relation.relowner) = expected.owner_name
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ),
  count(*) FILTER (
    WHERE relation.oid IS NULL
      OR pg_catalog.pg_get_userbyid(relation.relowner) <> expected.owner_name
      OR NOT relation.relrowsecurity
      OR NOT relation.relforcerowsecurity
  )
)
FROM expected
LEFT JOIN pg_catalog.pg_namespace AS namespace_row
  ON namespace_row.nspname = 'public'
LEFT JOIN pg_catalog.pg_class AS relation
  ON relation.relnamespace = namespace_row.oid
 AND relation.relname = expected.table_name
 AND relation.relkind = 'r';`,
    ),
    `${g006Relations.length}|0`,
    'every G0-06 table has its exact owner and FORCE RLS',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `WITH executable_roles(role_name) AS (
  VALUES
    ('ba_runtime'),
    ('ba_control_executor'),
    ('ba_management_attestation_issuer'),
    ('ba_subject_assertion_verifier')
), expected(table_name) AS (
  VALUES
    ${valuesSql(g006Relations.map(([tableName]) => [tableName]))}
), privileges(privilege_name) AS (
  VALUES
    ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
    ('REFERENCES'), ('TRIGGER')
)
SELECT count(*)
FROM executable_roles
CROSS JOIN expected
CROSS JOIN privileges
WHERE has_table_privilege(
  executable_roles.role_name,
  format('public.%I', expected.table_name),
  privileges.privilege_name
);`,
    ),
    '0',
    'all four executable roles have zero raw privileges across every G0-06 fact and privilege kind',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `WITH expected(table_name) AS (
  VALUES
    ${valuesSql(g006Relations.map(([tableName]) => [tableName]))}
)
SELECT count(*)
FROM expected
WHERE EXISTS (
  SELECT 1
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.contype = 'f'
    AND constraint_row.conrelid = format('public.%I', expected.table_name)::regclass
    AND constraint_row.confrelid = 'public.workspaces'::regclass
    AND constraint_row.conkey = ARRAY[
      (
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = constraint_row.conrelid
          AND attribute.attname = 'workspace_id'
          AND NOT attribute.attisdropped
      )
    ]::smallint[]
    AND constraint_row.confkey = ARRAY[
      (
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = constraint_row.confrelid
          AND attribute.attname = 'id'
          AND NOT attribute.attisdropped
      )
    ]::smallint[]
);`,
    ),
    String(g006Relations.length),
    'every G0-06 fact has its own direct Workspace foreign key',
  );

  await expectRejected(
    'ba_runtime_test',
    'SELECT * FROM public.runs LIMIT 1;',
    /permission denied|42501/u,
    'runtime raw Run SELECT is denied',
  );
  await expectRejected(
    'ba_runtime_test',
    'INSERT INTO public.run_events DEFAULT VALUES;',
    /permission denied|42501/u,
    'runtime raw Event INSERT is denied',
  );
  await expectRejected(
    'ba_runtime_test',
    "UPDATE public.credits_ledger SET entry_kind = 'RESERVE';",
    /permission denied|42501/u,
    'runtime raw Ledger UPDATE is denied',
  );
  await expectRejected(
    'ba_runtime_test',
    'DELETE FROM public.run_retention_purge_receipts;',
    /permission denied|42501/u,
    'runtime raw retention DELETE is denied',
  );
}

async function assertFunctionSurfaceAndSearchPath() {
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `WITH expected(owner_name, signature) AS (
  VALUES
    ${valuesSql(g006OwnerFunctions)}
), resolved AS (
  SELECT expected.owner_name, expected.signature,
         to_regprocedure(expected.signature) AS procedure_oid
  FROM expected
), actual AS (
  SELECT procedure_row.oid
  FROM pg_catalog.pg_proc AS procedure_row
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = procedure_row.pronamespace
  JOIN pg_catalog.pg_roles AS owner_role
    ON owner_role.oid = procedure_row.proowner
  WHERE namespace_row.nspname IN ('app', 'auth')
    AND owner_role.rolname = ANY (ARRAY[
      'ba_run_owner',
      'ba_billing_owner',
      'ba_archive_evidence_owner',
      'ba_retention'
    ]::name[])
)
SELECT concat_ws('|',
  (SELECT count(*) FROM resolved
    JOIN pg_catalog.pg_proc AS procedure_row ON procedure_row.oid = resolved.procedure_oid
    WHERE pg_catalog.pg_get_userbyid(procedure_row.proowner) = resolved.owner_name),
  (SELECT count(*) FROM resolved
    LEFT JOIN pg_catalog.pg_proc AS procedure_row ON procedure_row.oid = resolved.procedure_oid
    WHERE procedure_row.oid IS NULL
       OR pg_catalog.pg_get_userbyid(procedure_row.proowner) <> resolved.owner_name),
  (SELECT count(*) FROM actual
    LEFT JOIN resolved ON resolved.procedure_oid = actual.oid
    WHERE resolved.procedure_oid IS NULL)
);`,
    ),
    `${g006OwnerFunctions.length}|0|0`,
    'the complete four-owner function inventory has exact owners and no unreviewed additions',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT count(*)
FROM pg_catalog.pg_proc AS procedure_row
JOIN pg_catalog.pg_namespace AS namespace_row
  ON namespace_row.oid = procedure_row.pronamespace
WHERE namespace_row.nspname IN ('app', 'auth')
  AND procedure_row.proname = ANY (ARRAY[
    'authenticate_browser_session_identity',
    'lock_original_run_idempotency_namespace',
    'read_original_run',
    'read_original_run_events',
    'request_run_cancellation'
  ]::name[])
  AND has_function_privilege('ba_runtime', procedure_row.oid, 'EXECUTE');`,
    ),
    String(runtimeOriginalRunFunctions.length),
    'runtime exposes exactly the reviewed original-Run boundary',
  );

  for (const signature of runtimeOriginalRunFunctions) {
    assertEqual(
      await harness.queryScalar(
        'ba_migrator_test',
        `SELECT has_function_privilege(
  'ba_runtime', ${sqlLiteral(signature)}, 'EXECUTE'
);`,
      ),
      't',
      `runtime can execute ${signature}`,
    );
  }

  for (const signature of internalOriginalRunFunctions) {
    assertEqual(
      await harness.queryScalar(
        'ba_migrator_test',
        `SELECT has_function_privilege(
  'ba_runtime', ${sqlLiteral(signature)}, 'EXECUTE'
);`,
      ),
      'f',
      `runtime cannot bypass the reviewed boundary through ${signature}`,
    );
  }

  for (const signature of ownerOnlyFunctions) {
    assertEqual(
      await harness.queryScalar(
        'ba_migrator_test',
        `SELECT has_function_privilege(
  'ba_runtime', ${sqlLiteral(signature)}, 'EXECUTE'
);`,
      ),
      'f',
      `runtime cannot execute owner-only ${signature}`,
    );
  }

  for (const signature of runOwnerExternalFunctions) {
    assertEqual(
      await harness.queryScalar(
        'ba_migrator_test',
        `SELECT has_function_privilege(
  'ba_run_owner', ${sqlLiteral(signature)}, 'EXECUTE'
);`,
      ),
      't',
      `Run owner can execute only the required cross-owner helper ${signature}`,
    );
  }

  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT concat_ws('|',
  has_function_privilege(
    'ba_retention', 'app.lock_run_retention_summary(uuid,uuid)', 'EXECUTE'
  ),
  has_function_privilege(
    'ba_archive_evidence_owner',
    'app.lock_run_retention_summary(uuid,uuid)',
    'EXECUTE'
  ),
  has_table_privilege('ba_archive_evidence_owner', 'public.runs', 'UPDATE'),
  has_table_privilege('ba_retention', 'public.runs', 'UPDATE')
);`,
    ),
    't|t|f|f',
    'archive and retention owners can take the Run-owner lock without raw Run UPDATE',
  );

  for (const signature of [
    'app.reconcile_run_billing(uuid,uuid,uuid,uuid,uuid,text,text,text,text,bigint,bigint,text,text,timestamp with time zone)',
    'app.allocate_child_run_budget(jsonb)',
    'app.register_run_archive_manifest(jsonb)',
    'app.verify_run_archive(jsonb)',
    'app.approve_run_archive(jsonb)',
    'app.purge_run_events(jsonb)',
    'app.purge_run_recovery_material(jsonb)',
  ]) {
    assertEqual(
      await harness.queryScalar(
        'ba_migrator_test',
        `SELECT has_function_privilege(
  'ba_run_owner', ${sqlLiteral(signature)}, 'EXECUTE'
);`,
      ),
      'f',
      `Run owner cannot cross into ${signature}`,
    );
  }

  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `WITH protected(table_name) AS (
  VALUES ('run_steps'), ('run_events'), ('outbox')
), privileges(privilege_name) AS (
  VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
)
SELECT count(*)
FROM protected
CROSS JOIN privileges
WHERE has_table_privilege(
  'ba_billing_owner', format('public.%I', protected.table_name), privileges.privilege_name
);`,
    ),
    '0',
    'billing owner has no raw write privilege on Step, Event or Outbox facts',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `WITH terminal_columns(column_name) AS (
  VALUES
    ('status'), ('execution_status'), ('last_event_sequence'),
    ('termination_reason'), ('terminal_intent_hash'),
    ('terminal_result_redacted'), ('terminal_error_redacted'),
    ('terminal_billing_pending'), ('terminal_billing_pending_at'),
    ('terminal_event_id'), ('terminal_event_sequence'), ('finished_at'),
    ('events_retention_until'), ('recovery_retention_until'), ('retention_until')
), privileges(privilege_name) AS (
  VALUES ('INSERT'), ('UPDATE'), ('REFERENCES')
)
SELECT count(*)
FROM terminal_columns
CROSS JOIN privileges
WHERE has_column_privilege(
  'ba_billing_owner', 'public.runs', terminal_columns.column_name, privileges.privilege_name
);`,
    ),
    '0',
    'billing owner cannot write or reference any Run terminal projection column',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT count(*)
FROM pg_catalog.pg_proc AS procedure_row
JOIN pg_catalog.pg_namespace AS namespace_row
  ON namespace_row.oid = procedure_row.pronamespace
JOIN pg_catalog.pg_roles AS owner_role
  ON owner_role.oid = procedure_row.proowner
WHERE namespace_row.nspname IN ('app', 'auth')
  AND owner_role.rolname = ANY (ARRAY[
    'ba_run_owner',
    'ba_billing_owner',
    'ba_archive_evidence_owner',
    'ba_retention'
  ]::name[])
  AND NOT (
    procedure_row.proconfig @> ARRAY[
      'search_path=pg_catalog, public, auth, app, pg_temp'
    ]::text[]
  );`,
    ),
    '0',
    'every four-owner function pins the reviewed search_path',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `WITH exposed(signature) AS (
  VALUES
    ${valuesSql(runtimeOriginalRunFunctions.map((signature) => [signature]))}
)
SELECT count(*)
FROM exposed
JOIN pg_catalog.pg_proc AS procedure_row
  ON procedure_row.oid = to_regprocedure(exposed.signature)
WHERE procedure_row.prosecdef
  AND procedure_row.proconfig @> ARRAY[
    'search_path=pg_catalog, public, auth, app, pg_temp'
  ]::text[];`,
    ),
    String(runtimeOriginalRunFunctions.length),
    'all runtime original-Run functions are SECURITY DEFINER with pinned search_path',
  );
}

async function assertZeroCreditAcceptanceAndBillingIdempotency(zeroFact) {
  await ownerPsql('ba_run_owner', `SELECT app.accept_prepared_flow_run(${jsonb(zeroFact)});`);
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT concat_ws(':', status, billing_state, last_event_sequence)
    FROM public.runs WHERE id = '${zeroFact.run_id}'),
  (SELECT count(*) FROM public.run_events WHERE run_id = '${zeroFact.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${zeroFact.run_id}'),
  (SELECT concat_ws(':', status, reserved_credits, settled_credits,
    released_credits, balance_version)
    FROM public.credit_reservations WHERE id = '${zeroFact.reservation_id}'),
  (SELECT concat_ws(':', entry_kind, available_delta_credits,
    reserved_delta_credits, settled_delta_credits, balance_before,
    reserved_before, balance_after, reserved_after)
    FROM public.credits_ledger WHERE id = '${zeroFact.reserve_ledger_entry_id}'),
  (SELECT concat_ws(':', credits_balance, credits_reserved_balance,
    credits_balance_version) FROM public.workspaces WHERE id = '${ids.workspace}')
);`,
    ),
    'QUEUED:PENDING:1|1|1|HELD:0:0:0:0|RESERVE:0:0:0:0:0:0:0|0:0:0',
    'zero-credit acceptance atomically writes Run/Event/Outbox/reservation/ledger without balance drift',
  );

  await ownerPsql('ba_run_owner', `SELECT app.accept_prepared_flow_run(${jsonb(zeroFact)});`);
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.runs WHERE id = '${zeroFact.run_id}'),
  (SELECT count(*) FROM public.run_idempotency_sentinels
    WHERE id = '${zeroFact.sentinel_id}'),
  (SELECT count(*) FROM public.run_acceptance_receipts
    WHERE id = '${zeroFact.receipt_id}'),
  (SELECT count(*) FROM public.run_events WHERE run_id = '${zeroFact.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${zeroFact.run_id}'),
  (SELECT count(*) FROM public.credit_reservations WHERE run_id = '${zeroFact.run_id}'),
  (SELECT count(*) FROM public.credits_ledger WHERE run_id = '${zeroFact.run_id}')
);`,
    ),
    '1|1|1|1|1|1|1',
    'same acceptance namespace and intent replays without duplicate facts',
  );

  await expectOwnerRejected(
    'ba_run_owner',
    `SELECT app.accept_prepared_flow_run(${jsonb({
      ...zeroFact,
      intent_hash: hash('g006-conflicting-acceptance-intent'),
    })});`,
    /different Flow intent|23505/u,
    'same acceptance namespace with another intent conflicts',
  );

  const concurrentReplayFact = acceptanceFact(1300, 'g006-same-namespace-two-connections', 0);
  await Promise.all([
    ownerPsql(
      'ba_run_owner',
      `SELECT app.accept_prepared_flow_run(${jsonb(concurrentReplayFact)});`,
    ),
    ownerPsql(
      'ba_run_owner',
      `SELECT app.accept_prepared_flow_run(${jsonb(concurrentReplayFact)});`,
    ),
  ]);
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.run_idempotency_sentinels
    WHERE id = '${concurrentReplayFact.sentinel_id}'),
  (SELECT count(*) FROM public.runs
    WHERE id = '${concurrentReplayFact.run_id}'),
  (SELECT count(*) FROM public.run_acceptance_receipts
    WHERE id = '${concurrentReplayFact.receipt_id}'),
  (SELECT count(*) FROM public.run_events
    WHERE run_id = '${concurrentReplayFact.run_id}'),
  (SELECT count(*) FROM public.outbox
    WHERE run_id = '${concurrentReplayFact.run_id}'),
  (SELECT count(*) FROM public.credit_reservations
    WHERE run_id = '${concurrentReplayFact.run_id}'),
  (SELECT count(*) FROM public.credits_ledger
    WHERE run_id = '${concurrentReplayFact.run_id}')
);`,
    ),
    '1|1|1|1|1|1|1',
    'two connections sharing one acceptance namespace converge on one durable fact set',
  );

  const reserveCall = (
    billingIntentHash,
    attributionHash = zeroFact.reserve_charge_attribution_hash,
  ) => `SELECT app.reserve_credits(
  '${ids.workspace}',
  '${zeroFact.run_id}',
  '${zeroFact.reservation_id}',
  '${zeroFact.reserve_ledger_entry_id}',
  0,
  '${zeroFact.accepted_plan_hash}',
  '${zeroFact.reserve_charge_key}',
  '${billingIntentHash}',
  '${attributionHash}',
  '${zeroFact.reservation_expires_at}'::timestamptz,
  '${zeroFact.accepted_at}'::timestamptz
);`;
  await ownerPsql('ba_billing_owner', reserveCall(zeroFact.reserve_billing_intent_hash));
  await expectOwnerRejected(
    'ba_billing_owner',
    reserveCall(
      zeroFact.reserve_billing_intent_hash,
      hash('g006-reserve-attribution-does-not-match-plan'),
    ),
    /invalid reserve_credits intent|22023/u,
    'RESERVE attribution must be the accepted Plan hash even on replay',
  );
  await expectOwnerRejected(
    'ba_billing_owner',
    reserveCall(hash('g006-conflicting-zero-reserve-intent')),
    /different reserve intent|23505/u,
    'same billing charge key with another intent conflicts',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.credit_reservations WHERE run_id = '${zeroFact.run_id}'),
  (SELECT count(*) FROM public.credits_ledger WHERE run_id = '${zeroFact.run_id}'),
  (SELECT concat_ws(':', credits_balance, credits_reserved_balance,
    credits_balance_version) FROM public.workspaces WHERE id = '${ids.workspace}')
);`,
    ),
    '1|1|0:0:0',
    'billing replay and conflict leave the zero-credit triangle unchanged',
  );
}

async function assertConcurrentCreditReservation() {
  await harness.psql(
    'ba_bootstrap_test',
    `UPDATE public.workspaces
SET credits_balance = 100,
    credits_reserved_balance = 0,
    credits_balance_version = 0
WHERE id = '${ids.workspace}';`,
  );
  const first = acceptanceFact(1100, 'g006-concurrent-reserve-a', 80);
  const second = acceptanceFact(1200, 'g006-concurrent-reserve-b', 80);
  const outcomes = await Promise.all([
    ownerPsql('ba_run_owner', `SELECT app.accept_prepared_flow_run(${jsonb(first)});`, {
      allowFailure: true,
    }),
    ownerPsql('ba_run_owner', `SELECT app.accept_prepared_flow_run(${jsonb(second)});`, {
      allowFailure: true,
    }),
  ]);
  assertEqual(
    String(outcomes.filter(({ exitCode }) => exitCode === 0).length),
    '1',
    'two concurrent 80-credit reservations against 100 credits have one winner',
  );
  const rejected = outcomes.find(({ exitCode }) => exitCode !== 0);
  if (rejected === undefined || !/insufficient Workspace credits|23514/u.test(rejected.stderr)) {
    throw new Error(`concurrent loser did not fail with insufficient credits: ${rejected?.stderr}`);
  }
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT concat_ws(':', credits_balance, credits_reserved_balance,
    credits_balance_version, credits_balance >= 0,
    credits_reserved_balance >= 0)
    FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT count(*) FROM public.runs
    WHERE id IN ('${first.run_id}', '${second.run_id}')),
  (SELECT count(*) FROM public.run_idempotency_sentinels
    WHERE id IN ('${first.sentinel_id}', '${second.sentinel_id}')),
  (SELECT count(*) FROM public.credit_reservations
    WHERE run_id IN ('${first.run_id}', '${second.run_id}')
      AND reserved_credits = 80 AND status = 'HELD'),
  (SELECT count(*) FROM public.credits_ledger
    WHERE run_id IN ('${first.run_id}', '${second.run_id}')
      AND entry_kind = 'RESERVE'
      AND available_delta_credits = -80
      AND reserved_delta_credits = 80)
);`,
    ),
    '20:80:1:t:t|1|1|1|1',
    'concurrent reservation preserves nonnegative balance and rolls back every losing fact',
  );
}

async function assertFlowNamespaceIsolationAndRollback(zeroFact) {
  const competingFact = acceptanceFact(2000, 'g006-concurrent-different-intent', 0);
  const competingIntentFact = acceptanceFact(2020, 'g006-concurrent-different-intent', 0);
  const outcomes = await Promise.all([
    ownerPsql('ba_run_owner', `SELECT app.accept_prepared_flow_run(${jsonb(competingFact)});`, {
      allowFailure: true,
    }),
    ownerPsql(
      'ba_run_owner',
      `SELECT app.accept_prepared_flow_run(${jsonb(competingIntentFact)});`,
      { allowFailure: true },
    ),
  ]);
  assertEqual(
    String(outcomes.filter(({ exitCode }) => exitCode === 0).length),
    '1',
    'two connections with one Flow namespace and different intents have one winner',
  );
  const rejected = outcomes.find(({ exitCode }) => exitCode !== 0);
  if (
    rejected === undefined ||
    !/23505: Idempotency-Key was reused with a different Flow intent/u.test(rejected.stderr)
  ) {
    throw new Error(
      `different-intent Flow loser did not report the namespace conflict: ${rejected?.stderr}`,
    );
  }
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.run_idempotency_sentinels
    WHERE id IN ('${competingFact.sentinel_id}', '${competingIntentFact.sentinel_id}')
      AND intent_hash IN ('${competingFact.intent_hash}', '${competingIntentFact.intent_hash}')),
  (SELECT count(*) FROM public.runs
    WHERE id IN ('${competingFact.run_id}', '${competingIntentFact.run_id}')),
  (SELECT count(*) FROM public.run_acceptance_receipts
    WHERE run_id IN ('${competingFact.run_id}', '${competingIntentFact.run_id}')),
  (SELECT count(*) FROM public.credit_reservations
    WHERE run_id IN ('${competingFact.run_id}', '${competingIntentFact.run_id}')),
  (SELECT count(*) FROM public.credits_ledger
    WHERE run_id IN ('${competingFact.run_id}', '${competingIntentFact.run_id}')),
  (SELECT count(*) FROM public.run_events
    WHERE run_id IN ('${competingFact.run_id}', '${competingIntentFact.run_id}')),
  (SELECT count(*) FROM public.outbox
    WHERE run_id IN ('${competingFact.run_id}', '${competingIntentFact.run_id}'))
);`,
    ),
    '1|1|1|1|1|1|1',
    'different-intent Flow race commits exactly one complete durable fact set',
  );

  const crossRouteKey = 'g006-same-raw-key-across-routes';
  const agentRouteSentinelId = fixtureUuid(2090);
  await ownerPsql(
    'ba_run_owner',
    `INSERT INTO public.run_idempotency_sentinels (
  workspace_id, id, principal_kind, credential_id,
  fixed_route, idempotency_key, intent_hash, created_at
) VALUES (
  '${ids.workspace}', '${agentRouteSentinelId}', 'credential', '${ids.credential}',
  '/v1/oapi/agent/chat', '${crossRouteKey}',
  '${hash('g006-agent-route-sentinel-intent')}', '2026-08-27T00:00:00.000Z'
);`,
  );
  const crossRouteFlowFact = acceptanceFact(2100, crossRouteKey, 0);
  await ownerPsql(
    'ba_run_owner',
    `SELECT app.accept_prepared_flow_run(${jsonb(crossRouteFlowFact)});`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.run_idempotency_sentinels
    WHERE workspace_id = '${ids.workspace}'
      AND credential_id = '${ids.credential}'
      AND idempotency_key = '${crossRouteKey}'),
  (SELECT string_agg(fixed_route, ',' ORDER BY fixed_route)
    FROM public.run_idempotency_sentinels
    WHERE workspace_id = '${ids.workspace}'
      AND credential_id = '${ids.credential}'
      AND idempotency_key = '${crossRouteKey}'),
  (SELECT count(*) FROM public.runs WHERE id = '${crossRouteFlowFact.run_id}'),
  (SELECT count(*) FROM public.run_acceptance_receipts
    WHERE run_id = '${crossRouteFlowFact.run_id}')
);`,
    ),
    '2|/v1/oapi/agent/chat,/v1/oapi/flow/run|1|1',
    'the same raw key is an independent namespace on each fixed route',
  );

  const rollbackFact = {
    ...acceptanceFact(2200, 'g006-flow-late-receipt-failure', 1),
    // The duplicate receipt fails after Run, billing, Event, and Outbox writes were staged.
    receipt_id: zeroFact.receipt_id,
  };
  const workspaceBefore = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT concat_ws(':', credits_balance, credits_reserved_balance,
  credits_balance_version)
FROM public.workspaces
WHERE id = '${ids.workspace}';`,
  );
  await expectOwnerRejected(
    'ba_run_owner',
    `SELECT app.accept_prepared_flow_run(${jsonb(rollbackFact)});`,
    /duplicate key value violates unique constraint|23505/u,
    'a late receipt conflict rolls back the complete Flow acceptance transaction',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.run_idempotency_sentinels
    WHERE id = '${rollbackFact.sentinel_id}'),
  (SELECT count(*) FROM public.runs WHERE id = '${rollbackFact.run_id}'),
  (SELECT count(*) FROM public.run_acceptance_receipts
    WHERE run_id = '${rollbackFact.run_id}'),
  (SELECT count(*) FROM public.credit_reservations
    WHERE id = '${rollbackFact.reservation_id}'),
  (SELECT count(*) FROM public.credits_ledger
    WHERE id = '${rollbackFact.reserve_ledger_entry_id}'),
  (SELECT count(*) FROM public.run_events
    WHERE id = '${rollbackFact.accepted_event_id}'),
  (SELECT count(*) FROM public.outbox
    WHERE id = '${rollbackFact.dispatch_outbox_id}'),
  (SELECT concat_ws(':', credits_balance, credits_reserved_balance,
    credits_balance_version)
    FROM public.workspaces WHERE id = '${ids.workspace}')
);`,
    ),
    `0|0|0|0|0|0|0|${workspaceBefore}`,
    'late Flow failure leaves no sentinel, Run, reservation, ledger, Event, Outbox, or balance drift',
  );
}

async function assertBillingReplayExpiryAndReconciliation() {
  const replayRun = acceptanceFact(2300, 'g006-billing-charge-replay', 7);
  const workspaceBeforeReplay = (
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws(':', credits_balance, credits_reserved_balance,
  credits_balance_version)
FROM public.workspaces WHERE id = '${ids.workspace}';`,
    )
  )
    .split(':')
    .map(Number);
  await ownerPsql('ba_run_owner', `SELECT app.accept_prepared_flow_run(${jsonb(replayRun)});`);
  const replayAttempt = await seedRunAttempt(replayRun.run_id, 2320);
  const replayLedgerId = fixtureUuid(2330);
  const replayChargeKey = 'g006-concurrent-same-release-charge';
  const replayIntentHash = hash('g006-concurrent-same-release-intent');
  const replayAttributionHash = hash('g006-concurrent-same-release-attribution');
  const releaseCall = ({ amount = 7, intentHash = replayIntentHash } = {}) =>
    `SELECT app.release_credits(
  '${ids.workspace}', '${replayRun.run_id}', '${replayRun.reservation_id}',
  '${replayLedgerId}', '${replayRun.run_id}', '${replayAttempt}', 1, NULL,
  ${amount}, '${replayChargeKey}', '${intentHash}', '${replayAttributionHash}',
  'CONCURRENT_REPLAY', '2026-08-27T04:00:00.000Z'::timestamptz
);`;
  const replayOutcomes = await Promise.all([
    ownerPsql('ba_billing_owner', releaseCall()),
    ownerPsql('ba_billing_owner', releaseCall()),
  ]);
  assertEqual(
    String(replayOutcomes.filter(({ exitCode }) => exitCode === 0).length),
    '2',
    'two connections with one release charge and intent both return successfully',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT concat_ws(':', credits_balance, credits_reserved_balance,
    credits_balance_version) FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT concat_ws(':', status, reserved_credits, settled_credits,
    released_credits) FROM public.credit_reservations
    WHERE id = '${replayRun.reservation_id}'),
  (SELECT count(*) FROM public.credits_ledger WHERE run_id = '${replayRun.run_id}'),
  (SELECT count(*) FROM public.credits_ledger
    WHERE run_id = '${replayRun.run_id}' AND entry_kind = 'RELEASE'
      AND charge_key = '${replayChargeKey}' AND available_delta_credits = 7)
);`,
    ),
    `${workspaceBeforeReplay[0]}:${workspaceBeforeReplay[1]}:${
      (workspaceBeforeReplay[2] ?? Number.NaN) + 2
    }|RELEASED:7:0:7|2|1`,
    'concurrent same-charge replay creates one release ledger and exactly restores the reserve',
  );
  const stateAfterReplay = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT concat_ws('|',
  (SELECT concat_ws(':', credits_balance, credits_reserved_balance,
    credits_balance_version) FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT concat_ws(':', status, settled_credits, released_credits, balance_version)
    FROM public.credit_reservations WHERE id = '${replayRun.reservation_id}'),
  (SELECT count(*) FROM public.credits_ledger WHERE run_id = '${replayRun.run_id}')
);`,
  );
  await expectOwnerRejected(
    'ba_billing_owner',
    releaseCall({ amount: 6, intentHash: hash('g006-conflicting-release-charge-intent') }),
    /billing charge key was reused with a different release intent|23505/u,
    'same release charge key with another amount and intent conflicts before funds move',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT concat_ws(':', credits_balance, credits_reserved_balance,
    credits_balance_version) FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT concat_ws(':', status, settled_credits, released_credits, balance_version)
    FROM public.credit_reservations WHERE id = '${replayRun.reservation_id}'),
  (SELECT count(*) FROM public.credits_ledger WHERE run_id = '${replayRun.run_id}')
);`,
    ),
    stateAfterReplay,
    'release charge conflict preserves Workspace, reservation and ledger facts byte-for-byte',
  );

  const expiryRun = acceptanceFact(2400, 'g006-expiry-replay', 3);
  await ownerPsql('ba_run_owner', `SELECT app.accept_prepared_flow_run(${jsonb(expiryRun)});`);
  const expiryLedgerId = fixtureUuid(2420);
  const expiryChargeKey = 'g006-expiry-replay-charge';
  const expiryIntentHash = hash('g006-expiry-replay-intent');
  const expiryCall = (intentHash, now = '2026-08-29T00:00:00.000Z') =>
    `SELECT app.expire_credit_reservation(
  '${ids.workspace}', '${expiryRun.run_id}', '${expiryRun.reservation_id}',
  '${expiryLedgerId}', '${expiryChargeKey}', '${intentHash}',
  '${hash('g006-expiry-replay-attribution')}', '${now}'::timestamptz
);`;
  const expiryBefore = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT concat_ws('|',
  (SELECT concat_ws(':', credits_balance, credits_reserved_balance,
    credits_balance_version) FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT concat_ws(':', status, settled_credits, released_credits, balance_version)
    FROM public.credit_reservations WHERE id = '${expiryRun.reservation_id}'),
  (SELECT count(*) FROM public.credits_ledger WHERE run_id = '${expiryRun.run_id}')
);`,
  );
  await expectOwnerRejected(
    'ba_billing_owner',
    expiryCall(expiryIntentHash, '2026-08-27T05:00:00.000Z'),
    /reservation is not eligible for expiry|23514/u,
    'reservation cannot expire before its durable expiry horizon',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT concat_ws(':', credits_balance, credits_reserved_balance,
    credits_balance_version) FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT concat_ws(':', status, settled_credits, released_credits, balance_version)
    FROM public.credit_reservations WHERE id = '${expiryRun.reservation_id}'),
  (SELECT count(*) FROM public.credits_ledger WHERE run_id = '${expiryRun.run_id}')
);`,
    ),
    expiryBefore,
    'early expiry rejection leaves funds and facts unchanged',
  );
  await ownerPsql('ba_billing_owner', expiryCall(expiryIntentHash));
  await ownerPsql('ba_billing_owner', expiryCall(expiryIntentHash));
  const expiredState = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT concat_ws('|',
  (SELECT concat_ws(':', status, reserved_credits, settled_credits,
    released_credits) FROM public.credit_reservations
    WHERE id = '${expiryRun.reservation_id}'),
  (SELECT count(*) FROM public.credits_ledger WHERE run_id = '${expiryRun.run_id}'),
  (SELECT count(*) FROM public.credits_ledger
    WHERE id = '${expiryLedgerId}' AND entry_kind = 'EXPIRED'
      AND available_delta_credits = 3 AND reserved_delta_credits = -3)
);`,
  );
  assertEqual(
    expiredState,
    'EXPIRED:3:0:3|2|1',
    'eligible expiry and its replay converge on one exact EXPIRED ledger fact',
  );
  await expectOwnerRejected(
    'ba_billing_owner',
    expiryCall(hash('g006-conflicting-expiry-intent')),
    /billing charge key was reused with a different expiry intent|23505/u,
    'same expiry charge with another intent conflicts',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT concat_ws(':', status, reserved_credits, settled_credits,
    released_credits) FROM public.credit_reservations
    WHERE id = '${expiryRun.reservation_id}'),
  (SELECT count(*) FROM public.credits_ledger WHERE run_id = '${expiryRun.run_id}'),
  (SELECT count(*) FROM public.credits_ledger
    WHERE id = '${expiryLedgerId}' AND entry_kind = 'EXPIRED'
      AND available_delta_credits = 3 AND reserved_delta_credits = -3)
);`,
    ),
    expiredState,
    'expiry conflict cannot alter its terminal reservation or ledger',
  );

  const zeroExpiryRun = acceptanceFact(2450, 'g006-zero-expiry-version', 0);
  const zeroExpiryVersionBefore = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT credits_balance_version FROM public.workspaces WHERE id = '${ids.workspace}';`,
  );
  await ownerPsql('ba_run_owner', `SELECT app.accept_prepared_flow_run(${jsonb(zeroExpiryRun)});`);
  await ownerPsql(
    'ba_billing_owner',
    `SELECT app.expire_credit_reservation(
  '${ids.workspace}', '${zeroExpiryRun.run_id}', '${zeroExpiryRun.reservation_id}',
  '${fixtureUuid(2470)}', 'g006-zero-expiry-charge',
  '${hash('g006-zero-expiry-intent')}', '${hash('g006-zero-expiry-attribution')}',
  '2026-08-29T00:00:00.000Z'::timestamptz
);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT credits_balance_version FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT concat_ws(':', status, reserved_credits, released_credits, balance_version)
    FROM public.credit_reservations WHERE id = '${zeroExpiryRun.reservation_id}'),
  (SELECT count(*) FROM public.credits_ledger WHERE run_id = '${zeroExpiryRun.run_id}'),
  (SELECT count(*) FROM public.credits_ledger
    WHERE run_id = '${zeroExpiryRun.run_id}'
      AND available_delta_credits = 0 AND reserved_delta_credits = 0
      AND settled_delta_credits = 0)
);`,
    ),
    `${zeroExpiryVersionBefore}|EXPIRED:0:0:${zeroExpiryVersionBefore}|2|2`,
    'zero reserve and zero expiry write audit facts without advancing the balance version',
  );

  const reconciliationRun = acceptanceFact(2500, 'g006-positive-reconciliation', 6);
  const reconciliationBefore = (
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws(':', credits_balance, credits_reserved_balance,
  credits_balance_version)
FROM public.workspaces WHERE id = '${ids.workspace}';`,
    )
  )
    .split(':')
    .map(Number);
  await ownerPsql(
    'ba_run_owner',
    `SELECT app.accept_prepared_flow_run(${jsonb(reconciliationRun)});`,
  );
  const reconciliationAttempt = await seedRunAttempt(reconciliationRun.run_id, 2510);
  await ownerPsql(
    'ba_run_owner',
    `SELECT app.finalize_run(${jsonb({
      ...failureTerminalFact(reconciliationRun, 2512, reconciliationAttempt),
      terminal_kind: 'SIDE_EFFECT_UNKNOWN',
      termination_reason: 'SIDE_EFFECT_UNKNOWN',
    })});`,
  );
  const reconciliationId = fixtureUuid(2520);
  const reconciliationLedgerId = fixtureUuid(2521);
  const reconciliationKey = 'g006-positive-reconciliation-key';
  const reconciliationIntentHash = hash('g006-positive-reconciliation-intent');
  const reconciliationEvidenceHash = hash('g006-positive-reconciliation-evidence');
  const reconciliationCall = ({
    attributionHash = reconciliationEvidenceHash,
    intentHash = reconciliationIntentHash,
  } = {}) =>
    `SELECT app.reconcile_run_billing(
  '${ids.workspace}', '${reconciliationRun.run_id}', '${reconciliationRun.reservation_id}',
  '${reconciliationId}', '${reconciliationLedgerId}', '${reconciliationKey}',
  '${intentHash}', 'g006-positive-reconciliation-charge',
  '${attributionHash}', 2, 4,
  'fixture://g006/positive-reconciliation',
  '${reconciliationEvidenceHash}',
  '2026-08-27T06:00:00.000Z'::timestamptz
);`;
  await expectOwnerRejected(
    'ba_billing_owner',
    reconciliationCall({ attributionHash: hash('g006-mismatched-reconciliation-attribution') }),
    /invalid reconcile_run_billing intent|22023/u,
    'reconciliation attribution cannot differ from its evidence hash',
  );
  await ownerPsql('ba_billing_owner', reconciliationCall());
  await ownerPsql('ba_billing_owner', reconciliationCall());
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT concat_ws(':', credits_balance, credits_reserved_balance,
    credits_balance_version) FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT concat_ws(':', status, reserved_credits, settled_credits,
    released_credits, balance_version) FROM public.credit_reservations
    WHERE id = '${reconciliationRun.reservation_id}'),
  (SELECT concat_ws(':', billing_state, billing_settled_at IS NOT NULL)
    FROM public.runs WHERE id = '${reconciliationRun.run_id}'),
  (SELECT concat_ws(':', entry_kind, available_delta_credits,
    reserved_delta_credits, settled_delta_credits, balance_before,
    reserved_before, balance_after, reserved_after)
    FROM public.credits_ledger WHERE id = '${reconciliationLedgerId}'),
  (SELECT concat_ws(':', settled_credits, released_credits,
    ledger_entry_id, evidence_sha256)
    FROM public.run_billing_reconciliations WHERE id = '${reconciliationId}'),
  (SELECT count(*) FROM public.credits_ledger
    WHERE run_id = '${reconciliationRun.run_id}')
);`,
    ),
    `${(reconciliationBefore[0] ?? Number.NaN) - 2}:${reconciliationBefore[1]}:${
      (reconciliationBefore[2] ?? Number.NaN) + 2
    }|SETTLED:6:2:4:${
      (reconciliationBefore[2] ?? Number.NaN) + 2
    }|SETTLED:t|RECONCILIATION:4:-6:2:${
      (reconciliationBefore[0] ?? Number.NaN) - 6
    }:${(reconciliationBefore[1] ?? Number.NaN) + 6}:${
      (reconciliationBefore[0] ?? Number.NaN) - 2
    }:${reconciliationBefore[1]}|2:4:${reconciliationLedgerId}:${hash(
      'g006-positive-reconciliation-evidence',
    )}|2`,
    'positive reconciliation closes the exact Workspace, reservation, ledger and Run triangle once',
  );
  const reconciliationState = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT concat_ws('|',
  (SELECT concat_ws(':', credits_balance, credits_reserved_balance,
    credits_balance_version) FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT count(*) FROM public.credits_ledger WHERE run_id = '${reconciliationRun.run_id}'),
  (SELECT count(*) FROM public.run_billing_reconciliations
    WHERE run_id = '${reconciliationRun.run_id}')
);`,
  );
  await expectOwnerRejected(
    'ba_billing_owner',
    reconciliationCall({ intentHash: hash('g006-conflicting-reconciliation-intent') }),
    /reconciliation key was reused with a different intent|23505/u,
    'same reconciliation key with another intent conflicts before funds move',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT concat_ws(':', credits_balance, credits_reserved_balance,
    credits_balance_version) FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT count(*) FROM public.credits_ledger WHERE run_id = '${reconciliationRun.run_id}'),
  (SELECT count(*) FROM public.run_billing_reconciliations
    WHERE run_id = '${reconciliationRun.run_id}')
);`,
    ),
    reconciliationState,
    'reconciliation conflict leaves the exact settled facts unchanged',
  );
}

async function assertSideEffectUnknownReconciliation() {
  const runFact = acceptanceFact(2600, 'g006-side-effect-unknown', 4);
  const workspaceBefore = (
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws(':', credits_balance, credits_reserved_balance,
  credits_balance_version)
FROM public.workspaces WHERE id = '${ids.workspace}';`,
    )
  )
    .split(':')
    .map(Number);
  await ownerPsql('ba_run_owner', `SELECT app.accept_prepared_flow_run(${jsonb(runFact)});`);
  const attemptId = await seedRunAttempt(runFact.run_id, 2620);
  const terminal = {
    ...failureTerminalFact(runFact, 2640, attemptId),
    terminal_error_redacted: {
      code: 'SIDE_EFFECT_RESULT_UNKNOWN',
      retryable: false,
    },
    terminal_kind: 'SIDE_EFFECT_UNKNOWN',
    termination_reason: 'SIDE_EFFECT_UNKNOWN',
  };
  await ownerPsql('ba_run_owner', `SELECT app.finalize_run(${jsonb(terminal)});`);
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT concat_ws(':', status, execution_status, billing_state,
    last_event_sequence, terminal_event_id, terminal_event_sequence)
    FROM public.runs WHERE id = '${runFact.run_id}'),
  (SELECT concat_ws(':', status, reserved_credits, settled_credits,
    released_credits) FROM public.credit_reservations
    WHERE id = '${runFact.reservation_id}'),
  (SELECT concat_ws(':', credits_balance, credits_reserved_balance,
    credits_balance_version) FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT count(*) FROM public.credits_ledger WHERE run_id = '${runFact.run_id}'),
  (SELECT count(*) FROM public.run_steps
    WHERE run_id = '${runFact.run_id}' AND status = 'NEEDS_ATTENTION'),
  (SELECT count(*) FROM public.run_events WHERE run_id = '${runFact.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${runFact.run_id}')
);`,
    ),
    `NEEDS_ATTENTION:NEEDS_ATTENTION:NEEDS_ATTENTION:2:${
      terminal.terminal_event_id
    }:2|HELD:4:0:0|${(workspaceBefore[0] ?? Number.NaN) - 4}:${
      (workspaceBefore[1] ?? Number.NaN) + 4
    }:${(workspaceBefore[2] ?? Number.NaN) + 1}|1|1|2|2`,
    'SIDE_EFFECT_UNKNOWN atomically persists terminal evidence while leaving held credits untouched',
  );

  const reconciliationId = fixtureUuid(2660);
  const reconciliationLedgerId = fixtureUuid(2661);
  await ownerPsql(
    'ba_billing_owner',
    `SELECT app.reconcile_run_billing(
  '${ids.workspace}', '${runFact.run_id}', '${runFact.reservation_id}',
  '${reconciliationId}', '${reconciliationLedgerId}',
  'g006-side-effect-reconciliation',
  '${hash('g006-side-effect-reconciliation-intent')}',
  'g006-side-effect-reconciliation-charge',
  '${hash('g006-side-effect-reconciliation-evidence')}',
  1, 3, 'fixture://g006/side-effect-reconciliation',
  '${hash('g006-side-effect-reconciliation-evidence')}',
  '2026-08-27T07:00:00.000Z'::timestamptz
);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT concat_ws(':', status, execution_status, billing_state,
    last_event_sequence, terminal_event_id, terminal_event_sequence,
    billing_settled_at IS NOT NULL)
    FROM public.runs WHERE id = '${runFact.run_id}'),
  (SELECT concat_ws(':', status, reserved_credits, settled_credits,
    released_credits, balance_version) FROM public.credit_reservations
    WHERE id = '${runFact.reservation_id}'),
  (SELECT concat_ws(':', credits_balance, credits_reserved_balance,
    credits_balance_version) FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT concat_ws(':', entry_kind, available_delta_credits,
    reserved_delta_credits, settled_delta_credits)
    FROM public.credits_ledger WHERE id = '${reconciliationLedgerId}'),
  (SELECT concat_ws(':', settled_credits, released_credits,
    ledger_entry_id, evidence_sha256)
    FROM public.run_billing_reconciliations WHERE id = '${reconciliationId}'),
  (SELECT count(*) FROM public.credits_ledger WHERE run_id = '${runFact.run_id}'),
  (SELECT count(*) FROM public.run_steps WHERE run_id = '${runFact.run_id}'),
  (SELECT count(*) FROM public.run_events WHERE run_id = '${runFact.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${runFact.run_id}')
);`,
    ),
    `NEEDS_ATTENTION:NEEDS_ATTENTION:SETTLED:2:${
      terminal.terminal_event_id
    }:2:t|SETTLED:4:1:3:${(workspaceBefore[2] ?? Number.NaN) + 2}|${
      (workspaceBefore[0] ?? Number.NaN) - 1
    }:${workspaceBefore[1]}:${
      (workspaceBefore[2] ?? Number.NaN) + 2
    }|RECONCILIATION:3:-4:1|1:3:${reconciliationLedgerId}:${hash(
      'g006-side-effect-reconciliation-evidence',
    )}|2|1|2|2`,
    'reconciliation atomically settles billing without rewriting the SIDE_EFFECT_UNKNOWN tombstone',
  );

  const zeroHeldRun = acceptanceFact(2710, 'g006-zero-held-reconciliation', 0);
  const zeroHeldVersionBefore = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT credits_balance_version FROM public.workspaces WHERE id = '${ids.workspace}';`,
  );
  await ownerPsql('ba_run_owner', `SELECT app.accept_prepared_flow_run(${jsonb(zeroHeldRun)});`);
  const zeroHeldAttemptId = await seedRunAttempt(zeroHeldRun.run_id, 2720);
  await ownerPsql(
    'ba_run_owner',
    `SELECT app.finalize_run(${jsonb({
      ...failureTerminalFact(zeroHeldRun, 2730, zeroHeldAttemptId),
      terminal_kind: 'SIDE_EFFECT_UNKNOWN',
      termination_reason: 'SIDE_EFFECT_UNKNOWN',
    })});`,
  );
  const zeroHeldReconciliationId = fixtureUuid(2740);
  const zeroHeldLedgerId = fixtureUuid(2741);
  const zeroHeldEvidenceHash = hash('g006-zero-held-reconciliation-evidence');
  await ownerPsql(
    'ba_billing_owner',
    `SELECT app.reconcile_run_billing(
  '${ids.workspace}', '${zeroHeldRun.run_id}', '${zeroHeldRun.reservation_id}',
  '${zeroHeldReconciliationId}', '${zeroHeldLedgerId}',
  'g006-zero-held-reconciliation-key',
  '${hash('g006-zero-held-reconciliation-intent')}',
  'g006-zero-held-reconciliation-charge', '${zeroHeldEvidenceHash}',
  0, 0, 'fixture://g006/zero-held-reconciliation',
  '${zeroHeldEvidenceHash}', '2026-08-27T08:00:00.000Z'::timestamptz
);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT concat_ws(':', status, reserved_credits, settled_credits,
    released_credits, settled_at = '2026-08-27T08:00:00.000Z'::timestamptz,
    released_at IS NULL, status_reason_code, balance_version)
    FROM public.credit_reservations WHERE id = '${zeroHeldRun.reservation_id}'),
  (SELECT concat_ws(':', billing_state, billing_settled_at IS NOT NULL)
    FROM public.runs WHERE id = '${zeroHeldRun.run_id}'),
  (SELECT concat_ws(':', entry_kind, available_delta_credits,
    reserved_delta_credits, settled_delta_credits, balance_version)
    FROM public.credits_ledger WHERE id = '${zeroHeldLedgerId}'),
  (SELECT concat_ws(':', settled_credits, released_credits, evidence_sha256)
    FROM public.run_billing_reconciliations WHERE id = '${zeroHeldReconciliationId}'),
  (SELECT credits_balance_version FROM public.workspaces WHERE id = '${ids.workspace}')
);`,
    ),
    `SETTLED:0:0:0:t:t:RECONCILED:${zeroHeldVersionBefore}|SETTLED:t|RECONCILIATION:0:0:0:${zeroHeldVersionBefore}|0:0:${zeroHeldEvidenceHash}|${zeroHeldVersionBefore}`,
    'zero-credit HELD reconciliation closes as SETTLED with settled_at and no release timestamp',
  );

  const closedRun = acceptanceFact(2670, 'g006-side-effect-closed-reservation', 4);
  await ownerPsql('ba_run_owner', `SELECT app.accept_prepared_flow_run(${jsonb(closedRun)});`);
  const closedAttemptId = await seedRunAttempt(closedRun.run_id, 2680);
  await ownerPsql(
    'ba_billing_owner',
    `SELECT app.release_credits(
  '${ids.workspace}', '${closedRun.run_id}', '${closedRun.reservation_id}',
  '${fixtureUuid(2685)}', '${closedRun.run_id}', '${closedAttemptId}', 1, NULL,
  4, 'g006-side-effect-closed-release',
  '${hash('g006-side-effect-closed-release-intent')}',
  '${hash('g006-side-effect-closed-release-attribution')}',
  'PRE_FINALIZER_RELEASE', '2026-08-27T01:00:00.000Z'::timestamptz
);`,
  );
  const closedTerminal = {
    ...failureTerminalFact(closedRun, 2690, closedAttemptId),
    terminal_kind: 'SIDE_EFFECT_UNKNOWN',
    termination_reason: 'SIDE_EFFECT_UNKNOWN',
  };
  await ownerPsql('ba_run_owner', `SELECT app.finalize_run(${jsonb(closedTerminal)});`);
  const closedReservationBefore = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT row_to_json(snapshot)::text
FROM (
  SELECT status, reserved_credits, settled_credits, released_credits,
         balance_version, settled_at, released_at, updated_at
  FROM public.credit_reservations
  WHERE id = '${closedRun.reservation_id}'
) AS snapshot;`,
  );
  const closedWorkspaceBefore = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT concat_ws(':', credits_balance, credits_reserved_balance, credits_balance_version)
FROM public.workspaces WHERE id = '${ids.workspace}';`,
  );
  const closedTerminalBefore = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT concat_ws(':', terminal_intent_hash, terminal_event_id,
  terminal_event_sequence, finished_at, terminal_billing_pending_at)
FROM public.runs WHERE id = '${closedRun.run_id}';`,
  );
  const closedEvidenceHash = hash('g006-side-effect-closed-evidence');
  const closedReconciliationId = fixtureUuid(2700);
  const closedReconciliationLedgerId = fixtureUuid(2701);
  await ownerPsql(
    'ba_billing_owner',
    `SELECT app.reconcile_run_billing(
  '${ids.workspace}', '${closedRun.run_id}', '${closedRun.reservation_id}',
  '${closedReconciliationId}', '${closedReconciliationLedgerId}',
  'g006-side-effect-closed-reconciliation',
  '${hash('g006-side-effect-closed-reconciliation-intent')}',
  'g006-side-effect-closed-reconciliation-charge', '${closedEvidenceHash}',
  0, 0, 'fixture://g006/side-effect-closed-reconciliation',
  '${closedEvidenceHash}', '2026-08-27T03:00:00.000Z'::timestamptz
);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT row_to_json(snapshot)::text FROM (
    SELECT status, reserved_credits, settled_credits, released_credits,
           balance_version, settled_at, released_at, updated_at
    FROM public.credit_reservations WHERE id = '${closedRun.reservation_id}'
  ) AS snapshot),
  (SELECT concat_ws(':', credits_balance, credits_reserved_balance,
    credits_balance_version) FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT concat_ws(':', terminal_intent_hash, terminal_event_id,
    terminal_event_sequence, finished_at, terminal_billing_pending_at)
    FROM public.runs WHERE id = '${closedRun.run_id}'),
  (SELECT concat_ws(':', billing_state, billing_settled_at IS NOT NULL)
    FROM public.runs WHERE id = '${closedRun.run_id}'),
  (SELECT concat_ws(':', entry_kind, available_delta_credits,
    reserved_delta_credits, settled_delta_credits, charge_attribution_hash)
    FROM public.credits_ledger WHERE id = '${closedReconciliationLedgerId}'),
  (SELECT concat_ws(':', settled_credits, released_credits, evidence_sha256)
    FROM public.run_billing_reconciliations WHERE id = '${closedReconciliationId}')
);`,
    ),
    `${closedReservationBefore}|${closedWorkspaceBefore}|${closedTerminalBefore}|SETTLED:t|RECONCILIATION:0:0:0:${closedEvidenceHash}|0:0:${closedEvidenceHash}`,
    'evidence-only reconciliation closes billing without changing a previously closed reservation, balance or terminal timestamps',
  );
}

async function assertLedgerAppendOnly(zeroFact) {
  await expectRejected(
    'ba_bootstrap_test',
    `UPDATE public.credits_ledger
SET metering_detail_redacted = '{"tampered":true}'::jsonb
WHERE id = '${zeroFact.reserve_ledger_entry_id}';`,
    /immutable|55000/u,
    'ledger UPDATE is rejected by the append-only trigger even for fixture superuser',
  );
  await expectRejected(
    'ba_bootstrap_test',
    `DELETE FROM public.credits_ledger
WHERE id = '${zeroFact.reserve_ledger_entry_id}';`,
    /immutable|55000/u,
    'ledger DELETE is rejected by the append-only trigger even for fixture superuser',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT count(*) FROM public.credits_ledger
WHERE id = '${zeroFact.reserve_ledger_entry_id}';`,
    ),
    '1',
    'rejected ledger mutations preserve the durable entry',
  );
}

async function assertUnavailablePathsHaveNoSideEffects(zeroFact) {
  const factCountSql = `SELECT concat_ws('|',
  (SELECT count(*) FROM public.runs),
  (SELECT count(*) FROM public.run_events),
  (SELECT count(*) FROM public.outbox),
  (SELECT count(*) FROM public.credit_reservations),
  (SELECT count(*) FROM public.credits_ledger),
  (SELECT count(*) FROM public.run_parent_links),
  (SELECT count(*) FROM public.run_budget_allocations),
  (SELECT count(*) FROM public.human_gates)
);`;
  const before = await harness.queryScalar('ba_bootstrap_test', factCountSql);
  await expectOwnerRejected(
    'ba_run_owner',
    `SELECT app.create_child_run('{}'::jsonb);`,
    /unavailable|0A000/u,
    'child Run creation is unavailable before G0-07',
  );
  await expectOwnerRejected(
    'ba_run_owner',
    `SELECT app.mutate_human_gate('approve', '{}'::jsonb);`,
    /unavailable|0A000/u,
    'HumanGate mutation is unavailable before its authority exists',
  );
  await expectOwnerRejected(
    'ba_run_owner',
    `SELECT app.finalize_run(${jsonb({
      events_retention_until: '2026-09-04T00:00:00.000Z',
      finished_at: '2026-08-27T00:00:00.000Z',
      recovery_retention_until: '2026-09-27T00:00:00.000Z',
      released_credits: '0',
      retention_until: '2026-10-01T00:00:00.000Z',
      run_id: zeroFact.run_id,
      settled_credits: '0',
      terminal_error_redacted: {},
      terminal_intent_hash: hash('g006-unavailable-success-terminal'),
      terminal_kind: 'SUCCEEDED',
      workspace_id: ids.workspace,
    })});`,
    /unavailable before G0-07|0A000/u,
    'SUCCEEDED finalization is unavailable without trusted validation',
  );
  assertEqual(
    await harness.queryScalar('ba_bootstrap_test', factCountSql),
    before,
    'child, Gate and SUCCEEDED rejections leave every G0-06 fact count unchanged',
  );
}

async function assertPgTempShadowingIsHarmless(zeroFact) {
  await harness.psql(
    'ba_migrator_test',
    ownerControlContextSql(
      'ba_billing_owner',
      `DO $billing_shadow_probe$
DECLARE
  v_reservation_id uuid;
BEGIN
  v_reservation_id := app.reserve_credits(
    '${ids.workspace}',
    '${zeroFact.run_id}',
    '${zeroFact.reservation_id}',
    '${zeroFact.reserve_ledger_entry_id}',
    0,
    '${zeroFact.accepted_plan_hash}',
    '${zeroFact.reserve_charge_key}',
    '${zeroFact.reserve_billing_intent_hash}',
    '${zeroFact.reserve_charge_attribution_hash}',
    '${zeroFact.reservation_expires_at}'::timestamptz,
    '${zeroFact.accepted_at}'::timestamptz
  );
  IF v_reservation_id IS DISTINCT FROM '${zeroFact.reservation_id}'::uuid THEN
    RAISE EXCEPTION 'billing primitive returned attacker pg_temp identity';
  END IF;
END;
$billing_shadow_probe$;
RESET ROLE;
DO $billing_temp_readback$
BEGIN
  IF (SELECT count(*) FROM pg_temp.credits_ledger) <> 1 THEN
    RAISE EXCEPTION 'billing primitive mutated attacker pg_temp relation';
  END IF;
END;
$billing_temp_readback$;`,
      `CREATE TEMP TABLE credits_ledger (
  charge_key text PRIMARY KEY,
  reservation_id uuid NOT NULL
);
INSERT INTO pg_temp.credits_ledger (charge_key, reservation_id)
VALUES ('${zeroFact.reserve_charge_key}', '${fixtureUuid(9900)}');`,
    ),
  );
  await harness.psql(
    'ba_migrator_test',
    ownerCredentialContextSql(
      'ba_run_owner',
      `DO $original_run_shadow_probe$
DECLARE
  v_fact jsonb;
BEGIN
  v_fact := app.read_original_run(
    '${zeroFact.run_id}',
    jsonb_build_object(
      'auth_mode', 'service',
      'workspaceId', '${ids.workspace}'
    )
  );
  IF v_fact ->> 'runId' IS DISTINCT FROM '${zeroFact.run_id}' THEN
    RAISE EXCEPTION 'original Run read returned attacker pg_temp identity';
  END IF;
END;
$original_run_shadow_probe$;
RESET ROLE;
DO $original_run_temp_readback$
BEGIN
  IF (SELECT count(*) FROM pg_temp.runs) <> 1 THEN
    RAISE EXCEPTION 'original Run read mutated attacker pg_temp relation';
  END IF;
END;
$original_run_temp_readback$;`,
      `CREATE TEMP TABLE runs (
  run_id uuid PRIMARY KEY,
  marker text NOT NULL
);
INSERT INTO pg_temp.runs (run_id, marker)
VALUES ('${fixtureUuid(9901)}', 'attacker');`,
    ),
  );

  const shadowAcceptance = acceptanceFact(2800, 'g006-pgtemp-acceptance', 0);
  await harness.psql(
    'ba_migrator_test',
    ownerControlContextSql(
      'ba_run_owner',
      `SELECT app.accept_prepared_flow_run(${jsonb(shadowAcceptance)});
RESET ROLE;
DO $acceptance_temp_readback$
BEGIN
  IF (SELECT count(*) FROM pg_temp.runs) <> 1 THEN
    RAISE EXCEPTION 'Flow acceptance mutated attacker pg_temp Run relation';
  END IF;
END;
$acceptance_temp_readback$;`,
      `CREATE TEMP TABLE runs (
  run_id uuid PRIMARY KEY,
  marker text NOT NULL
);
INSERT INTO pg_temp.runs (run_id, marker)
VALUES ('${fixtureUuid(9920)}', 'acceptance-attacker');`,
    ),
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.runs WHERE id = '${shadowAcceptance.run_id}'),
  (SELECT count(*) FROM public.run_events WHERE run_id = '${shadowAcceptance.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${shadowAcceptance.run_id}'),
  (SELECT count(*) FROM public.credit_reservations
    WHERE run_id = '${shadowAcceptance.run_id}'),
  (SELECT count(*) FROM public.credits_ledger
    WHERE run_id = '${shadowAcceptance.run_id}')
);`,
    ),
    '1|1|1|1|1',
    'Flow acceptance under a pg_temp Run shadow writes only the public durable fact set',
  );

  const shadowAttempt = await seedRunAttempt(shadowAcceptance.run_id, 2820);
  const shadowTerminal = failureTerminalFact(shadowAcceptance, 2840, shadowAttempt);
  await harness.psql(
    'ba_migrator_test',
    ownerControlContextSql(
      'ba_run_owner',
      `SELECT app.finalize_run(${jsonb(shadowTerminal)});
RESET ROLE;
DO $finalizer_temp_readback$
BEGIN
  IF (SELECT count(*) FROM pg_temp.runs) <> 1 THEN
    RAISE EXCEPTION 'Run finalizer mutated attacker pg_temp Run relation';
  END IF;
END;
$finalizer_temp_readback$;`,
      `CREATE TEMP TABLE runs (
  run_id uuid PRIMARY KEY,
  marker text NOT NULL
);
INSERT INTO pg_temp.runs (run_id, marker)
VALUES ('${fixtureUuid(9921)}', 'finalizer-attacker');`,
    ),
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT concat_ws(':', status, execution_status, billing_state,
    terminal_event_id, terminal_event_sequence)
    FROM public.runs WHERE id = '${shadowAcceptance.run_id}'),
  (SELECT count(*) FROM public.run_steps WHERE run_id = '${shadowAcceptance.run_id}'),
  (SELECT count(*) FROM public.run_events WHERE run_id = '${shadowAcceptance.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${shadowAcceptance.run_id}'),
  (SELECT count(*) FROM public.credits_ledger WHERE run_id = '${shadowAcceptance.run_id}')
);`,
    ),
    `FAILED:FAILED:SETTLED:${shadowTerminal.terminal_event_id}:2|1|2|2|2`,
    'Run finalization under a pg_temp shadow writes only the public terminal and billing facts',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT has_database_privilege('ba_runtime', 'better_agent_test', 'TEMP');`,
    ),
    'f',
    'pg_temp attack coverage does not mutate the runtime database ACL',
  );
}

async function assertRuntimeOriginalRunBoundary(zeroFact) {
  const serviceAuthorization = {
    auth_mode: 'service',
    workspaceId: ids.workspace,
  };
  const namespace = {
    authenticated_principal: {
      credential_id: ids.credential,
      kind: 'credential',
      schema_version: 'conversation-principal/1',
    },
    fixed_route: '/v1/oapi/flow/run',
    idempotency_key: zeroFact.idempotency_key,
    schema_version: 'run-idempotency-namespace/1',
    workspace_id: ids.workspace,
  };
  const lockedNamespace = JSON.parse(
    await harness.queryScalar(
      'ba_runtime_test',
      runtimeContextSql(`SELECT app.lock_original_run_idempotency_namespace(${jsonb(namespace)});`),
    ),
  );
  assertEqual(
    `${lockedNamespace.runId}|${lockedNamespace.intentHash}|${lockedNamespace.receipt.http_status}|${lockedNamespace.receipt.data.status}`,
    `${zeroFact.run_id}|${zeroFact.intent_hash}|202|QUEUED`,
    'runtime namespace lock authorizes the persisted target before returning its frozen receipt',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      runtimeContextSql(`SELECT concat_ws('|',
  app.read_original_run('${zeroFact.run_id}', ${jsonb(serviceAuthorization)}) ->> 'runId',
  app.read_original_run('${zeroFact.run_id}', ${jsonb(serviceAuthorization)})
    -> 'acceptedPrincipal' ->> 'credential_id',
  app.read_original_run('${zeroFact.run_id}', ${jsonb(serviceAuthorization)})
    ->> 'deploymentId',
  jsonb_array_length(
    app.read_original_run_events('${zeroFact.run_id}', ${jsonb(serviceAuthorization)})
  )
);`),
    ),
    `${zeroFact.run_id}|${ids.credential}|${ids.flowDeployment}|1`,
    'formal runtime read and event functions return only the authorized original Run target',
  );
  await expectOwnerRejected(
    'ba_run_owner',
    `UPDATE public.runs
SET accepted_credential_id = '${fixtureUuid(9999)}'
WHERE workspace_id = '${ids.workspace}'
  AND id = '${zeroFact.run_id}';`,
    /accepted Run identity and target pins are immutable|55000/u,
    'Run trigger still rejects a source principal mutation while excluding its generated projection',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT accepted_credential_id FROM public.runs
WHERE workspace_id = '${ids.workspace}' AND id = '${zeroFact.run_id}';`,
    ),
    ids.credential,
    'rejected principal mutation preserves the accepted Run identity',
  );

  const cancellation = {
    authenticatedPrincipal: {
      credential_id: ids.credential,
      kind: 'credential',
      schema_version: 'conversation-principal/1',
    },
    browserIdentity: null,
    idempotencyKey: 'g006-original-run-cancel',
    requiredScope: 'run:cancel',
    runId: zeroFact.run_id,
    workspaceId: ids.workspace,
  };
  const cancellationCountsBefore = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT concat_ws('|',
  (SELECT count(*) FROM public.run_events WHERE run_id = '${zeroFact.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${zeroFact.run_id}'),
  (SELECT count(*) FROM public.run_mutation_idempotency
    WHERE target_run_id = '${zeroFact.run_id}')
);`,
  );
  const firstCancellation = JSON.parse(
    await harness.queryScalar(
      'ba_runtime_test',
      runtimeContextSql(`SELECT app.request_run_cancellation(${jsonb(cancellation)});`),
    ),
  );
  assertEqual(
    `${firstCancellation.outcome}|${firstCancellation.receipt.http_status}|${firstCancellation.receipt.data.run_id}|${firstCancellation.receipt.data.accepted_request_id}|${firstCancellation.receipt.data.status}`,
    `ACCEPTED|202|${zeroFact.run_id}|${zeroFact.accepted_request_id}|CANCEL_REQUESTED`,
    'first formal runtime cancellation returns the frozen canonical 202 receipt',
  );
  const replayedCancellation = JSON.parse(
    await harness.queryScalar(
      'ba_runtime_other_test',
      runtimeContextSql(`SELECT app.request_run_cancellation(${jsonb(cancellation)});`),
    ),
  );
  assertEqual(
    replayedCancellation.outcome,
    'REPLAY',
    'same-key cancellation from another runtime connection replays',
  );
  assertEqual(
    JSON.stringify(replayedCancellation.receipt),
    JSON.stringify(firstCancellation.receipt),
    'same-key cancellation replays byte-equivalent canonical receipt data',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT concat_ws(':', status, execution_status, last_event_sequence)
    FROM public.runs WHERE id = '${zeroFact.run_id}'),
  (SELECT count(*) FROM public.run_events WHERE run_id = '${zeroFact.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${zeroFact.run_id}'),
  (SELECT count(*) FROM public.run_mutation_idempotency
    WHERE target_run_id = '${zeroFact.run_id}'
      AND idempotency_key = '${cancellation.idempotencyKey}'
      AND http_status = 202
      AND completed_at IS NOT NULL),
  (SELECT event_type FROM public.run_events
    WHERE run_id = '${zeroFact.run_id}' AND sequence = 2),
  (SELECT message_type FROM public.outbox
    WHERE run_id = '${zeroFact.run_id}' AND dedupe_key LIKE 'cancel:%')
);`,
    ),
    'CANCEL_REQUESTED:CANCELLING:2|2|2|1|RUN_CANCEL_REQUESTED|SSE_WAKE',
    'accepted and replayed cancellation produce exactly one mutation/event/outbox fact',
  );

  await harness.psql(
    'ba_control_test',
    controlContextSql(`SELECT app.revoke_flow_deployment_entry_grant(
  '${ids.flowCancelGrant}', 0
);`),
  );
  const rejectedCancellation = {
    ...cancellation,
    idempotencyKey: 'g006-cancel-after-grant-revoke',
  };
  await expectRejected(
    'ba_runtime_test',
    runtimeContextSql(`SELECT app.request_run_cancellation(${jsonb(rejectedCancellation)});`),
    /does not authorize original Flow Run scope|42501/u,
    'revoked literal cancel grant denies the formal runtime mutation',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.run_events WHERE run_id = '${zeroFact.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${zeroFact.run_id}'),
  (SELECT count(*) FROM public.run_mutation_idempotency
    WHERE target_run_id = '${zeroFact.run_id}')
);`,
    ),
    cancellationCountsBefore
      .split('|')
      .map((value) => String(Number(value) + 1))
      .join('|'),
    'authorization failure adds no cancellation mutation, event or Outbox fact',
  );

  await harness.psql(
    'ba_control_test',
    controlContextSql(`SELECT app.revoke_flow_deployment_entry_grant(
  '${ids.flowReadGrant}', 0
);`),
  );
  await expectRejected(
    'ba_runtime_test',
    runtimeContextSql(`SELECT app.lock_original_run_idempotency_namespace(${jsonb(namespace)});`),
    /does not authorize original Flow Run scope|42501/u,
    'revoked read grant prevents direct namespace-lock receipt disclosure',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      runtimeContextSql(`SELECT COALESCE(
  app.read_original_run('${zeroFact.run_id}', ${jsonb(serviceAuthorization)})::text,
  'NULL'
);`),
    ),
    'NULL',
    'revoked read grant makes the non-disclosing runtime read uniformly invisible',
  );
}

async function assertReservationTimeMonotonicity(zeroFact) {
  const attemptId = await seedRunAttempt(zeroFact.run_id, 1500);
  const regressedAt = '2026-08-26T00:00:00.000Z';
  const regressedTerminal = {
    ...failureTerminalFact(zeroFact, 1520, attemptId),
    events_retention_until: '2026-09-02T00:00:00.000Z',
    finished_at: regressedAt,
    recovery_retention_until: '2026-09-25T00:00:00.000Z',
    terminal_kind: 'SIDE_EFFECT_UNKNOWN',
    termination_reason: 'SIDE_EFFECT_UNKNOWN',
  };
  await expectOwnerRejected(
    'ba_run_owner',
    `SELECT app.finalize_run(${jsonb(regressedTerminal)});`,
    /finalization timestamp predates the reservation update|23514/u,
    'every finalizer kind rejects a timestamp before the locked reservation update',
  );
  await ownerPsql(
    'ba_run_owner',
    `SELECT app.finalize_run(${jsonb({
      ...failureTerminalFact(zeroFact, 1530, attemptId),
      terminal_kind: 'SIDE_EFFECT_UNKNOWN',
      termination_reason: 'SIDE_EFFECT_UNKNOWN',
    })});`,
  );
  const readbackSql = `SELECT concat_ws('|',
  (SELECT concat_ws(':', status, reserved_credits, settled_credits,
    released_credits, created_at, updated_at, expires_at)
    FROM public.credit_reservations WHERE id = '${zeroFact.reservation_id}'),
  (SELECT concat_ws(':', credits_balance, credits_reserved_balance,
    credits_balance_version) FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT count(*) FROM public.credits_ledger),
  (SELECT count(*) FROM public.run_billing_reconciliations),
  (SELECT billing_state FROM public.runs WHERE id = '${zeroFact.run_id}')
);`;
  const before = await harness.queryScalar('ba_bootstrap_test', readbackSql);

  await expectOwnerRejected(
    'ba_billing_owner',
    `SELECT app.settle_credits(
  '${ids.workspace}', '${zeroFact.run_id}', '${zeroFact.reservation_id}',
  '${fixtureUuid(1510)}', '${zeroFact.run_id}', '${attemptId}', 1, NULL,
  0, 'g006-regressed-settle', '${hash('g006-regressed-settle-intent')}',
  '${hash('g006-regressed-settle-attribution')}', '{}'::jsonb,
  '${regressedAt}'::timestamptz
);`,
    /settlement timestamp predates the reservation update|23514/u,
    'settlement cannot move the reservation clock backwards',
  );
  await expectOwnerRejected(
    'ba_billing_owner',
    `SELECT app.release_credits(
  '${ids.workspace}', '${zeroFact.run_id}', '${zeroFact.reservation_id}',
  '${fixtureUuid(1511)}', '${zeroFact.run_id}', '${attemptId}', 1, NULL,
  0, 'g006-regressed-release', '${hash('g006-regressed-release-intent')}',
  '${hash('g006-regressed-release-attribution')}', 'REGRESSION_PROBE',
  '${regressedAt}'::timestamptz
);`,
    /release timestamp predates the reservation update|23514/u,
    'release cannot move the reservation clock backwards',
  );
  await expectOwnerRejected(
    'ba_billing_owner',
    `SELECT app.expire_credit_reservation(
  '${ids.workspace}', '${zeroFact.run_id}', '${zeroFact.reservation_id}',
  '${fixtureUuid(1512)}', 'g006-regressed-expiry',
  '${hash('g006-regressed-expiry-intent')}',
  '${hash('g006-regressed-expiry-attribution')}',
  '${regressedAt}'::timestamptz
);`,
    /expiry timestamp predates the reservation update|23514/u,
    'expiry cannot move the reservation clock backwards',
  );
  await expectOwnerRejected(
    'ba_billing_owner',
    `SELECT app.reconcile_run_billing(
  '${ids.workspace}', '${zeroFact.run_id}', '${zeroFact.reservation_id}',
  '${fixtureUuid(1513)}', '${fixtureUuid(1514)}',
  'g006-regressed-reconciliation',
  '${hash('g006-regressed-reconciliation-intent')}',
  'g006-regressed-reconciliation-charge',
  '${hash('g006-regressed-reconciliation-evidence')}',
  0, 0, 'fixture://g006/regressed-reconciliation',
  '${hash('g006-regressed-reconciliation-evidence')}',
  '${regressedAt}'::timestamptz
);`,
    /reconciliation timestamp predates the reservation update|23514/u,
    'reconciliation cannot move the reservation clock backwards',
  );
  await expectRejected(
    'ba_bootstrap_test',
    `UPDATE public.credit_reservations
SET expires_at = created_at
WHERE workspace_id = '${ids.workspace}'
  AND id = '${zeroFact.reservation_id}';`,
    /credit_reservations_time_check|23514/u,
    'reservation table rejects a non-forward expiry even outside primitives',
  );
  assertEqual(
    await harness.queryScalar('ba_bootstrap_test', readbackSql),
    before,
    'every rejected time regression preserves reservation, balances, ledger and reconciliation facts',
  );
}

async function assertFailureFinalizerTransactions() {
  const runFact = acceptanceFact(1600, 'g006-terminal-finalizer', 0);
  await ownerPsql('ba_run_owner', `SELECT app.accept_prepared_flow_run(${jsonb(runFact)});`);
  const attemptId = await seedRunAttempt(runFact.run_id, 1620);
  const terminal = failureTerminalFact(runFact, 1640, attemptId);
  await expectOwnerRejected(
    'ba_run_owner',
    `SELECT app.finalize_run(${jsonb({
      ...terminal,
      termination_reason: 'HUMAN_REJECTED',
    })});`,
    /Human Gate terminal finalization is unavailable|0A000/u,
    'Human Gate terminal reasons stay unavailable until GateSpec is published',
  );
  await expectOwnerRejected(
    'ba_run_owner',
    `SELECT app.finalize_run(${jsonb({
      ...terminal,
      termination_reason: 'USER_CANCELLED',
    })});`,
    /termination reason does not map to terminal kind|22023/u,
    'terminal kind cannot be paired with a reason from another closed status',
  );
  await Promise.all([
    ownerPsql('ba_run_owner', `SELECT app.finalize_run(${jsonb(terminal)});`),
    ownerPsql('ba_run_owner', `SELECT app.finalize_run(${jsonb(terminal)});`),
  ]);
  const terminalFactReadback = `SELECT concat_ws('|',
  (SELECT concat_ws(':', status, execution_status, billing_state,
    last_event_sequence, terminal_event_id, terminal_event_sequence,
    termination_reason, terminal_error_redacted ->> 'code',
    terminal_error_redacted ->> 'retryable',
    terminal_error_redacted ->> 'category',
    terminal_error_redacted ? 'requires_operator_action')
    FROM public.runs WHERE id = '${runFact.run_id}'),
  (SELECT concat_ws(':', status, reserved_credits, settled_credits,
    released_credits) FROM public.credit_reservations
    WHERE id = '${runFact.reservation_id}'),
  (SELECT count(*) FROM public.credits_ledger WHERE run_id = '${runFact.run_id}'),
  (SELECT count(*) FROM public.run_steps WHERE run_id = '${runFact.run_id}'
    AND status = 'FAILED'),
  (SELECT count(*) FROM public.run_events WHERE run_id = '${runFact.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${runFact.run_id}'),
  (SELECT event_type FROM public.run_events WHERE id = '${terminal.terminal_event_id}'),
  (SELECT message_type FROM public.outbox WHERE id = '${terminal.terminal_outbox_id}')
);`;
  assertEqual(
    await harness.queryScalar('ba_bootstrap_test', terminalFactReadback),
    `FAILED:FAILED:SETTLED:2:${terminal.terminal_event_id}:2:INTERNAL_FAILURE:INTERNAL_FAILURE:false:EXECUTION:f|SETTLED:0:0:0|2|1|2|2|RUN_FINISHED|SSE_WAKE`,
    'concurrent same-intent failure finalization converges on one terminal and billing fact set',
  );
  const beforeReplay = await harness.queryScalar('ba_bootstrap_test', terminalFactReadback);
  const replay = JSON.parse(
    await harness.queryScalar(
      'ba_migrator_test',
      ownerControlContextSql('ba_run_owner', `SELECT app.finalize_run(${jsonb(terminal)});`),
    ),
  );
  assertEqual(
    `${replay.run_id}|${replay.status}|${replay.billing_state}|${replay.terminal_event_id}|${replay.terminal_event_sequence}`,
    `${runFact.run_id}|FAILED|SETTLED|${terminal.terminal_event_id}|2`,
    'same terminal intent replays the durable tombstone',
  );
  assertEqual(
    await harness.queryScalar('ba_bootstrap_test', terminalFactReadback),
    beforeReplay,
    'terminal replay does not duplicate ledger, step, event or Outbox facts',
  );
  await expectOwnerRejected(
    'ba_run_owner',
    `SELECT app.finalize_run(${jsonb({
      ...terminal,
      terminal_intent_hash: hash('g006-conflicting-terminal-intent'),
    })});`,
    /terminal intent conflicts with its durable tombstone|23505/u,
    'different terminal intent conflicts with the durable tombstone',
  );

  const rollbackRun = acceptanceFact(1700, 'g006-terminal-rollback', 0);
  await ownerPsql('ba_run_owner', `SELECT app.accept_prepared_flow_run(${jsonb(rollbackRun)});`);
  const rollbackAttemptId = await seedRunAttempt(rollbackRun.run_id, 1720);
  const rollbackTerminal = {
    ...failureTerminalFact(rollbackRun, 1740, rollbackAttemptId),
    terminal_step_id: terminal.terminal_step_id,
  };
  await expectOwnerRejected(
    'ba_run_owner',
    `SELECT app.finalize_run(${jsonb(rollbackTerminal)});`,
    /duplicate key value violates unique constraint|23505/u,
    'downstream terminal Step failure rejects the outer finalization transaction',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT concat_ws(':', status, execution_status, billing_state,
    last_event_sequence, terminal_intent_hash IS NULL)
    FROM public.runs WHERE id = '${rollbackRun.run_id}'),
  (SELECT concat_ws(':', status, settled_credits, released_credits)
    FROM public.credit_reservations WHERE id = '${rollbackRun.reservation_id}'),
  (SELECT count(*) FROM public.credits_ledger WHERE run_id = '${rollbackRun.run_id}'),
  (SELECT count(*) FROM public.run_steps WHERE run_id = '${rollbackRun.run_id}'),
  (SELECT count(*) FROM public.run_events WHERE run_id = '${rollbackRun.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${rollbackRun.run_id}')
);`,
    ),
    'QUEUED:ACCEPTED:PENDING:1:t|HELD:0:0|1|0|1|1',
    'failed finalizer rolls billing and every terminal fact back to the accepted snapshot',
  );
}

async function assertSettleReleaseAndExpireRaces() {
  const balanceBeforeSettleReleaseRace = (
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws(':', credits_balance, credits_reserved_balance,
  credits_balance_version)
FROM public.workspaces WHERE id = '${ids.workspace}';`,
    )
  )
    .split(':')
    .map(Number);
  const settleReleaseRun = acceptanceFact(1800, 'g006-settle-release-race', 10);
  await ownerPsql(
    'ba_run_owner',
    `SELECT app.accept_prepared_flow_run(${jsonb(settleReleaseRun)});`,
  );
  const settleReleaseAttempt = await seedRunAttempt(settleReleaseRun.run_id, 1820);
  const settledAt = '2026-08-27T03:00:00.000Z';
  const settleCall = `SELECT app.settle_credits(
  '${ids.workspace}', '${settleReleaseRun.run_id}',
  '${settleReleaseRun.reservation_id}', '${fixtureUuid(1840)}',
  '${settleReleaseRun.run_id}', '${settleReleaseAttempt}', 1, NULL, 10,
  'g006-race-settle', '${hash('g006-race-settle-intent')}',
  '${hash('g006-race-settle-attribution')}', '{"race":"settle"}'::jsonb,
  '${settledAt}'::timestamptz
);`;
  const releaseCall = `SELECT app.release_credits(
  '${ids.workspace}', '${settleReleaseRun.run_id}',
  '${settleReleaseRun.reservation_id}', '${fixtureUuid(1841)}',
  '${settleReleaseRun.run_id}', '${settleReleaseAttempt}', 1, NULL, 10,
  'g006-race-release', '${hash('g006-race-release-intent')}',
  '${hash('g006-race-release-attribution')}', 'RACE_RELEASE',
  '${settledAt}'::timestamptz
);`;
  const settleReleaseOutcomes = await Promise.all([
    ownerPsql('ba_billing_owner', settleCall, { allowFailure: true }),
    ownerPsql('ba_billing_owner', releaseCall, { allowFailure: true }),
  ]);
  assertEqual(
    String(settleReleaseOutcomes.filter(({ exitCode }) => exitCode === 0).length),
    '1',
    'settle and full release race has exactly one winner',
  );
  const settleReleaseLoser = settleReleaseOutcomes.find(({ exitCode }) => exitCode !== 0);
  if (
    settleReleaseLoser === undefined ||
    !/reservation cannot (?:settle|release) requested credits|23514/u.test(
      settleReleaseLoser.stderr,
    )
  ) {
    throw new Error(`settle/release race loser was not closed: ${settleReleaseLoser?.stderr}`);
  }
  const settleReleaseReadback = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT concat_ws('|',
  (SELECT concat_ws(':', credits_balance, credits_reserved_balance,
    credits_balance >= 0, credits_reserved_balance >= 0)
    FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT concat_ws(':', status, settled_credits, released_credits)
    FROM public.credit_reservations WHERE id = '${settleReleaseRun.reservation_id}'),
  (SELECT count(*) FROM public.credits_ledger
    WHERE run_id = '${settleReleaseRun.run_id}'),
  (SELECT count(*) FROM public.credits_ledger
    WHERE run_id = '${settleReleaseRun.run_id}'
      AND entry_kind IN ('SETTLE', 'RELEASE'))
);`,
  );
  const validSettleReleaseClosures = new Set([
    `${(balanceBeforeSettleReleaseRace[0] ?? Number.NaN) - 10}:${
      balanceBeforeSettleReleaseRace[1]
    }:t:t|SETTLED:10:0|2|1`,
    `${balanceBeforeSettleReleaseRace[0]}:${
      balanceBeforeSettleReleaseRace[1]
    }:t:t|RELEASED:0:10|2|1`,
  ]);
  if (!validSettleReleaseClosures.has(settleReleaseReadback)) {
    throw new Error(`settle/release race produced an invalid closure: ${settleReleaseReadback}`);
  }

  const balanceBeforeExpiryRace = (
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws(':', credits_balance, credits_reserved_balance,
  credits_balance_version)
FROM public.workspaces WHERE id = '${ids.workspace}';`,
    )
  )
    .split(':')
    .map(Number);
  const expiryRun = acceptanceFact(1900, 'g006-expire-release-race', 5);
  await ownerPsql('ba_run_owner', `SELECT app.accept_prepared_flow_run(${jsonb(expiryRun)});`);
  const expiryAttempt = await seedRunAttempt(expiryRun.run_id, 1920);
  const expiredAt = '2026-08-29T00:00:00.000Z';
  const expireCall = `SELECT app.expire_credit_reservation(
  '${ids.workspace}', '${expiryRun.run_id}', '${expiryRun.reservation_id}',
  '${fixtureUuid(1940)}', 'g006-race-expire',
  '${hash('g006-race-expire-intent')}', '${hash('g006-race-expire-attribution')}',
  '${expiredAt}'::timestamptz
);`;
  const expiryReleaseCall = `SELECT app.release_credits(
  '${ids.workspace}', '${expiryRun.run_id}', '${expiryRun.reservation_id}',
  '${fixtureUuid(1941)}', '${expiryRun.run_id}', '${expiryAttempt}', 1, NULL, 5,
  'g006-expiry-race-release', '${hash('g006-expiry-race-release-intent')}',
  '${hash('g006-expiry-race-release-attribution')}', 'EXPIRY_RACE_RELEASE',
  '${expiredAt}'::timestamptz
);`;
  const expiryReleaseOutcomes = await Promise.all([
    ownerPsql('ba_billing_owner', expireCall, { allowFailure: true }),
    ownerPsql('ba_billing_owner', expiryReleaseCall, { allowFailure: true }),
  ]);
  assertEqual(
    String(expiryReleaseOutcomes.filter(({ exitCode }) => exitCode === 0).length),
    '1',
    'expiry and full release race has exactly one winner',
  );
  const expiryReleaseLoser = expiryReleaseOutcomes.find(({ exitCode }) => exitCode !== 0);
  if (
    expiryReleaseLoser === undefined ||
    !/(?:reservation is not eligible for expiry|reservation cannot release requested credits|23514)/u.test(
      expiryReleaseLoser.stderr,
    )
  ) {
    throw new Error(`expire/release race loser was not closed: ${expiryReleaseLoser?.stderr}`);
  }
  const expiryReadback = (
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT concat_ws(':', credits_balance, credits_reserved_balance,
    credits_balance_version, credits_balance >= 0,
    credits_reserved_balance >= 0)
    FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT concat_ws(':', status, settled_credits, released_credits)
    FROM public.credit_reservations WHERE id = '${expiryRun.reservation_id}'),
  (SELECT count(*) FROM public.credits_ledger WHERE run_id = '${expiryRun.run_id}'),
  (SELECT count(*) FROM public.credits_ledger
    WHERE run_id = '${expiryRun.run_id}'
      AND entry_kind IN ('EXPIRED', 'RELEASE'))
);`,
    )
  ).split('|');
  const [availableAfter, reservedAfter, versionAfter, nonnegativeAvailable, nonnegativeReserved] = (
    expiryReadback[0] ?? ''
  ).split(':');
  const validExpiryClosure = new Set(['EXPIRED:0:5', 'RELEASED:0:5']);
  assertEqual(
    `${availableAfter}:${reservedAfter}`,
    `${balanceBeforeExpiryRace[0]}:${balanceBeforeExpiryRace[1]}`,
    'expire/release race returns the exact reserved amount to available balance',
  );
  assertEqual(
    versionAfter,
    String((balanceBeforeExpiryRace[2] ?? Number.NaN) + 2),
    'expire/release race advances balance version once for reserve and once for closure',
  );
  assertEqual(
    `${nonnegativeAvailable}:${nonnegativeReserved}|${validExpiryClosure.has(expiryReadback[1] ?? '')}|${expiryReadback[2]}|${expiryReadback[3]}`,
    't:t|true|2|1',
    'expire/release race closes one reservation with one nonnegative ledger outcome',
  );
}

async function seedTerminalRetentionFixture() {
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.runs (
  workspace_id,
  id,
  billing_owner_run_id,
  accepted_request_id,
  accepted_principal_kind,
  accepted_credential_id,
  fixed_route,
  intent_hash,
  admission_snapshot_hash,
  accepted_plan_hash,
  accepted_output_schema_ref,
  accepted_output_schema_hash,
  dependency_pins_hash,
  target_kind,
  flow_deployment_id,
  flow_deployment_revision_id,
  flow_id,
  flow_version_id,
  status,
  execution_status,
  billing_state,
  billing_settled_at,
  acceptance_receipt_data_redacted,
  last_event_sequence,
  termination_reason,
  terminal_intent_hash,
  terminal_error_redacted,
  terminal_billing_pending,
  terminal_billing_pending_at,
  terminal_event_id,
  terminal_event_sequence,
  finished_at,
  events_retention_until,
  recovery_retention_until,
  retention_until,
  accepted_at
) VALUES (
  '${ids.workspace}',
  '${ids.terminalRun}',
  '${ids.terminalRun}',
  '${ids.terminalAcceptedRequest}',
  'credential',
  '${ids.credential}',
  '/v1/oapi/flow/run',
  '${hash('g006-terminal-public-intent')}',
  '${hashes.terminalAdmission}',
  '${hashes.terminalPlan}',
  'schema://g006/terminal-output',
  '${hashes.terminalOutput}',
  '${hashes.terminalDependencies}',
  'flow',
  '${ids.flowDeployment}',
  '${ids.flowRevision}',
  '${ids.flow}',
  '${ids.flowVersion}',
  'FAILED',
  'FAILED',
  'SETTLED',
  '2026-01-01T00:00:00.000Z',
  jsonb_build_object('run_id', '${ids.terminalRun}', 'status', 'QUEUED'),
  2,
  'INTERNAL_FAILURE',
  '${hashes.terminalIntent}',
  '{"code":"INTERNAL_FAILURE","retryable":false,"category":"EXECUTION"}'::jsonb,
  false,
  '2026-01-01T00:00:00.000Z',
  '${ids.terminalEvent}',
  2,
  '2026-01-01T00:00:00.000Z',
  '2026-01-08T00:00:00.000Z',
  '2026-01-31T00:00:00.000Z',
  '2026-02-01T00:00:00.000Z',
  '2025-12-31T23:59:00.000Z'
);
INSERT INTO public.run_events (
  workspace_id, id, run_id, sequence, event_type, dedupe_key,
  payload_redacted, occurred_at
) VALUES
  (
    '${ids.workspace}', '${ids.terminalPreEvent}', '${ids.terminalRun}', 1,
    'RUN_ACCEPTED', 'accepted', '{"status":"QUEUED"}'::jsonb,
    '2025-12-31T23:59:00.000Z'
  ),
  (
    '${ids.workspace}', '${ids.terminalEvent}', '${ids.terminalRun}', 2,
    'RUN_FINISHED', 'terminal', '{"status":"FAILED"}'::jsonb,
    '2026-01-01T00:00:00.000Z'
  );
INSERT INTO public.run_checkpoints (
  workspace_id, id, run_id, checkpoint_hash, payload_ref,
  payload_redacted, created_at
) VALUES (
  '${ids.workspace}', '${ids.terminalCheckpoint}', '${ids.terminalRun}',
  '${hashes.terminalCheckpoint}', 'fixture://checkpoint/g006-terminal',
  '{"cursor":"terminal"}'::jsonb, '2026-01-01T00:00:00.000Z'
);
INSERT INTO public.outbox (
  workspace_id, id, run_id, message_type, dedupe_key, payload_ref,
  payload_hash, producer_fencing_token, payload_redacted, status,
  available_at, delivered_at, created_at
) VALUES (
  '${ids.workspace}', '${ids.terminalOutbox}', '${ids.terminalRun}',
  'SSE_WAKE', 'terminal', 'fixture://outbox/g006-terminal',
  '${hashes.terminalPlan}', 1, '{"status":"FAILED"}'::jsonb, 'DELIVERED',
  '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z',
  '2026-01-01T00:00:00.000Z'
);
INSERT INTO public.runs (
  workspace_id, id, billing_owner_run_id, accepted_request_id,
  accepted_principal_kind, accepted_credential_id, fixed_route, intent_hash,
  admission_snapshot_hash, accepted_plan_hash, accepted_output_schema_ref,
  accepted_output_schema_hash, dependency_pins_hash, target_kind,
  flow_deployment_id, flow_deployment_revision_id, flow_id, flow_version_id,
  status, execution_status, billing_state, billing_settled_at,
  acceptance_receipt_data_redacted, last_event_sequence, termination_reason,
  terminal_intent_hash, terminal_error_redacted, terminal_billing_pending,
  terminal_billing_pending_at, terminal_event_id, terminal_event_sequence,
  finished_at, events_retention_until, recovery_retention_until,
  retention_until, accepted_at
)
SELECT
  workspace_id, '${ids.retentionAttentionRun}', '${ids.retentionAttentionRun}',
  '${fixtureUuid(417)}', accepted_principal_kind, accepted_credential_id,
  fixed_route, '${hash('g006-retention-attention-public-intent')}',
  admission_snapshot_hash, accepted_plan_hash, accepted_output_schema_ref,
  accepted_output_schema_hash, dependency_pins_hash, target_kind,
  flow_deployment_id, flow_deployment_revision_id, flow_id, flow_version_id,
  'NEEDS_ATTENTION', 'NEEDS_ATTENTION', 'SETTLED',
  '2026-01-01T00:00:00.000Z',
  jsonb_build_object('run_id', '${ids.retentionAttentionRun}', 'status', 'QUEUED'),
  1, 'SIDE_EFFECT_UNKNOWN', '${hash('g006-retention-attention-terminal')}',
  '{"code":"SIDE_EFFECT_UNKNOWN","retryable":false,"category":"EXECUTION","requires_operator_action":true}'::jsonb,
  false, '2026-01-01T00:00:00.000Z', '${ids.retentionAttentionEvent}', 1,
  '2026-01-01T00:00:00.000Z', '2026-01-08T00:00:00.000Z',
  '2026-01-31T00:00:00.000Z', '2026-02-01T00:00:00.000Z',
  '2025-12-31T23:59:00.000Z'
FROM public.runs
WHERE workspace_id = '${ids.workspace}' AND id = '${ids.terminalRun}'
;
INSERT INTO public.runs (
  workspace_id, id, billing_owner_run_id, accepted_request_id,
  accepted_principal_kind, accepted_credential_id, fixed_route, intent_hash,
  admission_snapshot_hash, accepted_plan_hash, accepted_output_schema_ref,
  accepted_output_schema_hash, dependency_pins_hash, target_kind,
  flow_deployment_id, flow_deployment_revision_id, flow_id, flow_version_id,
  status, execution_status, billing_state, billing_settled_at,
  acceptance_receipt_data_redacted, last_event_sequence, termination_reason,
  terminal_intent_hash, terminal_error_redacted, terminal_billing_pending,
  terminal_billing_pending_at, terminal_event_id, terminal_event_sequence,
  finished_at, events_retention_until, recovery_retention_until,
  retention_until, accepted_at
)
SELECT
  workspace_id, '${ids.archiveConflictRun}', '${ids.archiveConflictRun}',
  '${ids.archiveConflictAcceptedRequest}', accepted_principal_kind,
  accepted_credential_id, fixed_route,
  '${hash('g006-archive-conflict-public-intent')}', admission_snapshot_hash,
  accepted_plan_hash, accepted_output_schema_ref, accepted_output_schema_hash,
  dependency_pins_hash, target_kind, flow_deployment_id,
  flow_deployment_revision_id, flow_id, flow_version_id,
  'FAILED', 'FAILED', 'SETTLED', '2026-01-01T00:00:00.000Z',
  jsonb_build_object('run_id', '${ids.archiveConflictRun}', 'status', 'QUEUED'),
  1, 'INTERNAL_FAILURE', '${hash('g006-archive-conflict-terminal-intent')}',
  terminal_error_redacted, false, '2026-01-01T00:00:00.000Z',
  '${ids.archiveConflictTerminalEvent}', 1, '2026-01-01T00:00:00.000Z',
  '2026-01-08T00:00:00.000Z', '2026-01-31T00:00:00.000Z',
  '2026-02-01T00:00:00.000Z', '2025-12-31T23:59:00.000Z'
FROM public.runs
WHERE workspace_id = '${ids.workspace}' AND id = '${ids.terminalRun}'
;`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT concat_ws(':', status, billing_state, terminal_event_sequence)
    FROM public.runs WHERE id = '${ids.terminalRun}'),
  (SELECT count(*) FROM public.run_events WHERE run_id = '${ids.terminalRun}'),
  (SELECT count(*) FROM public.run_checkpoints WHERE run_id = '${ids.terminalRun}'),
  (SELECT count(*) FROM public.outbox
    WHERE run_id = '${ids.terminalRun}' AND status = 'DELIVERED')
);`,
    ),
    'FAILED:SETTLED:2|2|1|1',
    'terminal retention fixture has exact tombstone, events, checkpoint and delivered Outbox',
  );
}

function archiveFacts() {
  const archiveRef = 's3://better-agent-fixture/g006/terminal-run';
  return Object.freeze({
    approval: {
      approval_receipt_id: ids.archiveApproval,
      approved_at: '2026-02-02T00:02:00.000Z',
      archive_ref: archiveRef,
      archive_sha256: hashes.archive,
      manifest_id: ids.archiveManifest,
      receipt_ref: 'fixture://archive/approval',
      receipt_sha256: hashes.approval,
      run_id: ids.terminalRun,
      verification_receipt_id: ids.archiveVerification,
      verification_receipt_sha256: hashes.verification,
      workspace_id: ids.workspace,
    },
    manifest: {
      archive_ref: archiveRef,
      archive_sha256: hashes.archive,
      created_at: '2026-02-02T00:00:00.000Z',
      manifest_id: ids.archiveManifest,
      run_id: ids.terminalRun,
      workspace_id: ids.workspace,
    },
    verification: {
      archive_ref: archiveRef,
      archive_sha256: hashes.archive,
      manifest_id: ids.archiveManifest,
      receipt_ref: 'fixture://archive/verification',
      receipt_sha256: hashes.verification,
      run_id: ids.terminalRun,
      verification_receipt_id: ids.archiveVerification,
      verified_at: '2026-02-02T00:01:00.000Z',
      workspace_id: ids.workspace,
    },
  });
}

function archiveConflictFacts({
  approvalReceiptSha256 = hash('g006-archive-conflict-approval-a'),
  archiveSha256 = hash('g006-archive-conflict-manifest-a'),
  verificationReceiptSha256 = hash('g006-archive-conflict-verification-a'),
} = {}) {
  const archiveRef = 's3://better-agent-fixture/g006/archive-conflict-run';
  return Object.freeze({
    approval: {
      approval_receipt_id: ids.archiveConflictApproval,
      approved_at: '2026-02-03T00:02:00.000Z',
      archive_ref: archiveRef,
      archive_sha256: archiveSha256,
      manifest_id: ids.archiveConflictManifest,
      receipt_ref: 'fixture://archive/conflict-approval',
      receipt_sha256: approvalReceiptSha256,
      run_id: ids.archiveConflictRun,
      verification_receipt_id: ids.archiveConflictVerification,
      verification_receipt_sha256: verificationReceiptSha256,
      workspace_id: ids.workspace,
    },
    manifest: {
      archive_ref: archiveRef,
      archive_sha256: archiveSha256,
      created_at: '2026-02-03T00:00:00.000Z',
      manifest_id: ids.archiveConflictManifest,
      run_id: ids.archiveConflictRun,
      workspace_id: ids.workspace,
    },
    verification: {
      archive_ref: archiveRef,
      archive_sha256: archiveSha256,
      manifest_id: ids.archiveConflictManifest,
      receipt_ref: 'fixture://archive/conflict-verification',
      receipt_sha256: verificationReceiptSha256,
      run_id: ids.archiveConflictRun,
      verification_receipt_id: ids.archiveConflictVerification,
      verified_at: '2026-02-03T00:01:00.000Z',
      workspace_id: ids.workspace,
    },
  });
}

async function assertConcurrentArchiveIntentConflicts() {
  const first = archiveConflictFacts();
  const competingArchiveSha256 = hash('g006-archive-conflict-manifest-b');
  await assertConcurrentArchiveConflict({
    blockerOwner: 'ba_run_owner',
    conflictPattern: /Run archive manifest already exists with different evidence/u,
    expectedId: ids.archiveConflictManifest,
    facts: [first.manifest, { ...first.manifest, archive_sha256: competingArchiveSha256 }],
    functionName: 'register_run_archive_manifest',
    label: 'archive-manifest-conflict',
    parentPredicate: `workspace_id = '${ids.workspace}' AND id = '${ids.archiveConflictRun}'`,
    parentTable: 'runs',
    rowCountSql: `SELECT count(*) FROM public.run_archive_manifests
WHERE workspace_id = '${ids.workspace}' AND run_id = '${ids.archiveConflictRun}';`,
  });

  const winningArchiveSha256 = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT archive_sha256 FROM public.run_archive_manifests
WHERE workspace_id = '${ids.workspace}' AND id = '${ids.archiveConflictManifest}';`,
  );
  const withWinningManifest = archiveConflictFacts({ archiveSha256: winningArchiveSha256 });
  const competingVerificationSha256 = hash('g006-archive-conflict-verification-b');
  await assertConcurrentArchiveConflict({
    blockerOwner: 'ba_archive_evidence_owner',
    conflictPattern: /archive verification already exists with different evidence/u,
    expectedId: ids.archiveConflictVerification,
    facts: [
      withWinningManifest.verification,
      {
        ...withWinningManifest.verification,
        receipt_sha256: competingVerificationSha256,
      },
    ],
    functionName: 'verify_run_archive',
    label: 'archive-verification-conflict',
    parentPredicate: `workspace_id = '${ids.workspace}' AND id = '${ids.archiveConflictManifest}'`,
    parentTable: 'run_archive_manifests',
    rowCountSql: `SELECT count(*) FROM public.run_archive_verification_receipts
WHERE workspace_id = '${ids.workspace}' AND manifest_id = '${ids.archiveConflictManifest}';`,
  });

  const winningVerificationSha256 = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT receipt_sha256 FROM public.run_archive_verification_receipts
WHERE workspace_id = '${ids.workspace}' AND id = '${ids.archiveConflictVerification}';`,
  );
  const withWinningVerification = archiveConflictFacts({
    archiveSha256: winningArchiveSha256,
    verificationReceiptSha256: winningVerificationSha256,
  });
  const competingApprovalSha256 = hash('g006-archive-conflict-approval-b');
  await assertConcurrentArchiveConflict({
    blockerOwner: 'ba_archive_evidence_owner',
    conflictPattern: /archive approval already exists with different evidence/u,
    expectedId: ids.archiveConflictApproval,
    facts: [
      withWinningVerification.approval,
      { ...withWinningVerification.approval, receipt_sha256: competingApprovalSha256 },
    ],
    functionName: 'approve_run_archive',
    label: 'archive-approval-conflict',
    parentPredicate: `workspace_id = '${ids.workspace}' AND id = '${ids.archiveConflictVerification}'`,
    parentTable: 'run_archive_verification_receipts',
    rowCountSql: `SELECT count(*) FROM public.run_archive_approval_receipts
WHERE workspace_id = '${ids.workspace}' AND manifest_id = '${ids.archiveConflictManifest}';`,
  });
}

function purgeFact(evidence, purgeReceiptId, purgedAt) {
  return {
    approval_receipt_id: ids.archiveApproval,
    approval_receipt_sha256: hashes.approval,
    archive_ref: evidence.manifest.archive_ref,
    archive_sha256: hashes.archive,
    manifest_id: ids.archiveManifest,
    purge_receipt_id: purgeReceiptId,
    purged_at: purgedAt,
    run_id: ids.terminalRun,
    verification_receipt_id: ids.archiveVerification,
    verification_receipt_sha256: hashes.verification,
    workspace_id: ids.workspace,
  };
}

async function assertArchiveAndRetention() {
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT count(*)
FROM (VALUES
  ('ba_retention', 'app.register_run_archive_manifest(jsonb)'),
  ('ba_retention', 'app.verify_run_archive(jsonb)'),
  ('ba_retention', 'app.approve_run_archive(jsonb)'),
  ('ba_archive_evidence_owner', 'app.purge_run_events(jsonb)'),
  ('ba_archive_evidence_owner', 'app.purge_run_recovery_material(jsonb)')
) AS forbidden(role_name, signature)
WHERE has_function_privilege(role_name, signature, 'EXECUTE');`,
    ),
    '0',
    'archive writer and retention owner cannot execute each other functions',
  );
  await expectRejected(
    'ba_migrator_test',
    `SET ROLE ba_retention;
INSERT INTO public.run_archive_manifests DEFAULT VALUES;`,
    /permission denied|42501/u,
    'retention owner cannot write archive evidence directly',
  );
  await expectRejected(
    'ba_migrator_test',
    `SET ROLE ba_archive_evidence_owner;
INSERT INTO public.run_retention_purge_receipts DEFAULT VALUES;`,
    /permission denied|42501/u,
    'archive evidence owner cannot write purge receipts directly',
  );

  const evidence = archiveFacts();
  const eligibleEvents = purgeFact(evidence, ids.eventsPurgeReceipt, '2026-01-09T00:00:00.000Z');
  const attentionEvents = {
    ...eligibleEvents,
    purge_receipt_id: ids.retentionAttentionPurgeReceipt,
    run_id: ids.retentionAttentionRun,
  };
  await expectOwnerRejected(
    'ba_retention',
    `SELECT app.purge_run_events(${jsonb(attentionEvents)});`,
    /NEEDS_ATTENTION retention requires billing reconciliation|23514/u,
    'a reconciled billing projection is mandatory before NEEDS_ATTENTION retention',
  );

  await expectOwnerRejected(
    'ba_archive_evidence_owner',
    `SELECT app.verify_run_archive(${jsonb(evidence.verification)});`,
    /archive verification does not match the exact manifest|23503/u,
    'verification cannot be registered before its exact manifest exists',
  );
  await expectOwnerRejected(
    'ba_retention',
    `SELECT app.purge_run_events(${jsonb(eligibleEvents)});`,
    /requires exact verified and approved evidence|23503/u,
    'eligible EVENTS retention still rejects missing archive evidence',
  );
  await assertConcurrentArchiveReplay({
    blockerOwner: 'ba_run_owner',
    expectedId: ids.archiveManifest,
    facts: [evidence.manifest, evidence.manifest],
    functionName: 'register_run_archive_manifest',
    label: 'archive-manifest-replay',
    parentPredicate: `workspace_id = '${ids.workspace}' AND id = '${ids.terminalRun}'`,
    parentTable: 'runs',
    rowCountSql: `SELECT count(*) FROM public.run_archive_manifests
WHERE workspace_id = '${ids.workspace}' AND run_id = '${ids.terminalRun}';`,
  });
  await expectOwnerRejected(
    'ba_archive_evidence_owner',
    `SELECT app.register_run_archive_manifest(${jsonb({
      ...evidence.manifest,
      archive_sha256: hash('g006-conflicting-archive-manifest'),
    })});`,
    /Run archive manifest already exists with different evidence|23505/u,
    'a terminal Run cannot replace its durable archive hash',
  );
  await expectOwnerRejected(
    'ba_archive_evidence_owner',
    `SELECT app.register_run_archive_manifest(${jsonb({
      ...evidence.manifest,
      created_at: '2026-02-02T00:00:00.001Z',
    })});`,
    /Run archive manifest already exists with different evidence|23505/u,
    'manifest replay compares the persisted creation timestamp',
  );
  await expectOwnerRejected(
    'ba_archive_evidence_owner',
    `SELECT app.verify_run_archive(${jsonb({
      ...evidence.verification,
      verified_at: '2026-02-01T23:59:59.000Z',
    })});`,
    /archive verification cannot predate its manifest|23514/u,
    'archive verification chronology starts at the exact manifest creation',
  );
  await expectOwnerRejected(
    'ba_archive_evidence_owner',
    `SELECT app.verify_run_archive(${jsonb({
      ...evidence.verification,
      archive_sha256: hash('g006-wrong-verification-archive'),
    })});`,
    /archive verification does not match the exact manifest|23503/u,
    'verification rejects an archive hash that does not match the manifest',
  );
  await assertConcurrentArchiveReplay({
    blockerOwner: 'ba_archive_evidence_owner',
    expectedId: ids.archiveVerification,
    facts: [evidence.verification, evidence.verification],
    functionName: 'verify_run_archive',
    label: 'archive-verification-replay',
    parentPredicate: `workspace_id = '${ids.workspace}' AND id = '${ids.archiveManifest}'`,
    parentTable: 'run_archive_manifests',
    rowCountSql: `SELECT count(*) FROM public.run_archive_verification_receipts
WHERE workspace_id = '${ids.workspace}' AND manifest_id = '${ids.archiveManifest}';`,
  });
  await expectOwnerRejected(
    'ba_archive_evidence_owner',
    `SELECT app.verify_run_archive(${jsonb({
      ...evidence.verification,
      receipt_sha256: hash('g006-conflicting-verification-receipt'),
    })});`,
    /archive verification already exists with different evidence|23505/u,
    'verification replay cannot replace its durable receipt hash',
  );
  for (const [label, patch] of [
    ['Run identity', { run_id: fixtureUuid(9940) }],
    ['archive reference', { archive_ref: 'fixture://archive/g006-terminal-run-other' }],
    ['archive hash', { archive_sha256: hash('g006-conflicting-verification-archive') }],
    ['receipt reference', { receipt_ref: 'fixture://archive/g006-verification-other' }],
    ['verification timestamp', { verified_at: '2026-02-02T00:01:00.001Z' }],
  ]) {
    await expectOwnerRejected(
      'ba_archive_evidence_owner',
      `SELECT app.verify_run_archive(${jsonb({ ...evidence.verification, ...patch })});`,
      /archive verification already exists with different evidence|23505/u,
      `verification replay compares its persisted ${label}`,
    );
  }
  await expectOwnerRejected(
    'ba_archive_evidence_owner',
    `SELECT app.approve_run_archive(${jsonb({
      ...evidence.approval,
      approved_at: '2026-02-02T00:00:30.000Z',
    })});`,
    /archive approval cannot predate its verification|23514/u,
    'archive approval chronology starts at the exact verification receipt',
  );
  await expectOwnerRejected(
    'ba_archive_evidence_owner',
    `SELECT app.approve_run_archive(${jsonb({
      ...evidence.approval,
      verification_receipt_sha256: hash('g006-wrong-approval-verification'),
    })});`,
    /archive approval does not match exact verified evidence|23503/u,
    'approval rejects a verification receipt hash mismatch',
  );
  await assertConcurrentArchiveReplay({
    blockerOwner: 'ba_archive_evidence_owner',
    expectedId: ids.archiveApproval,
    facts: [evidence.approval, evidence.approval],
    functionName: 'approve_run_archive',
    label: 'archive-approval-replay',
    parentPredicate: `workspace_id = '${ids.workspace}' AND id = '${ids.archiveVerification}'`,
    parentTable: 'run_archive_verification_receipts',
    rowCountSql: `SELECT count(*) FROM public.run_archive_approval_receipts
WHERE workspace_id = '${ids.workspace}' AND manifest_id = '${ids.archiveManifest}';`,
  });
  await expectOwnerRejected(
    'ba_archive_evidence_owner',
    `SELECT app.approve_run_archive(${jsonb({
      ...evidence.approval,
      receipt_sha256: hash('g006-conflicting-approval-receipt'),
    })});`,
    /archive approval already exists with different evidence|23505/u,
    'approval replay cannot replace its durable receipt hash',
  );
  for (const [label, patch] of [
    ['verification identity', { verification_receipt_id: fixtureUuid(9941) }],
    [
      'verification hash',
      { verification_receipt_sha256: hash('g006-conflicting-approval-verification') },
    ],
    ['Run identity', { run_id: fixtureUuid(9942) }],
    ['archive reference', { archive_ref: 'fixture://archive/g006-terminal-run-other' }],
    ['archive hash', { archive_sha256: hash('g006-conflicting-approval-archive') }],
    ['receipt reference', { receipt_ref: 'fixture://archive/g006-approval-other' }],
    ['approval timestamp', { approved_at: '2026-02-02T00:02:00.001Z' }],
  ]) {
    await expectOwnerRejected(
      'ba_archive_evidence_owner',
      `SELECT app.approve_run_archive(${jsonb({ ...evidence.approval, ...patch })});`,
      /archive approval already exists with different evidence|23505/u,
      `approval replay compares its persisted ${label}`,
    );
  }
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.run_archive_manifests
    WHERE id = '${ids.archiveManifest}'
      AND run_id = '${ids.terminalRun}'
      AND archive_sha256 = '${hashes.archive}'),
  (SELECT count(*) FROM public.run_archive_verification_receipts
    WHERE id = '${ids.archiveVerification}'
      AND manifest_id = '${ids.archiveManifest}'
      AND receipt_sha256 = '${hashes.verification}'
      AND status = 'VERIFIED'),
  (SELECT count(*) FROM public.run_archive_approval_receipts
    WHERE id = '${ids.archiveApproval}'
      AND verification_receipt_id = '${ids.archiveVerification}'
      AND verification_receipt_sha256 = '${hashes.verification}'
      AND receipt_sha256 = '${hashes.approval}'
      AND status = 'APPROVED')
);`,
    ),
    '1|1|1',
    'manifest, verification and approval are exact hash-bound durable evidence',
  );
  await assertConcurrentArchiveIntentConflicts();

  const ledgerCountBefore = await harness.queryScalar(
    'ba_bootstrap_test',
    'SELECT count(*) FROM public.credits_ledger;',
  );
  const earlyEvents = purgeFact(evidence, ids.eventsPurgeReceipt, '2026-01-07T00:00:00.000Z');
  const earlyRecovery = purgeFact(evidence, ids.recoveryPurgeReceipt, '2026-01-15T00:00:00.000Z');
  const eligibleRecovery = purgeFact(
    evidence,
    ids.recoveryPurgeReceipt,
    '2026-02-02T00:00:00.000Z',
  );
  await expectRejected(
    'ba_migrator_test',
    ownerControlContextSql(
      'ba_run_owner',
      `UPDATE public.runs
SET events_retention_until = '2099-01-01T00:00:00.000Z',
    recovery_retention_until = '2099-02-01T00:00:00.000Z',
    retention_until = '2099-03-01T00:00:00.000Z'
WHERE workspace_id = '${ids.workspace}' AND id = '${ids.terminalRun}';
RESET ROLE;
SET LOCAL ROLE ba_retention;
SELECT app.purge_run_events(${jsonb(earlyEvents)});`,
    ),
    /not eligible for EVENTS retention|23514/u,
    'EVENTS purge locks and re-reads an in-transaction horizon extension',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT count(*) FROM public.run_events WHERE run_id = '${ids.terminalRun}';`,
    ),
    '2',
    'early EVENTS rejection preserves every Run event',
  );
  await expectOwnerRejected(
    'ba_retention',
    `SELECT app.purge_run_events(${jsonb({
      ...eligibleEvents,
      approval_receipt_sha256: hash('g006-wrong-events-approval'),
    })});`,
    /requires exact verified and approved evidence|23503/u,
    'EVENTS purge rejects a mismatched approval hash after all evidence exists',
  );
  await assertConcurrentRetentionReplay('purge_run_events', eligibleEvents, 'EVENTS');
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.run_events WHERE run_id = '${ids.terminalRun}'),
  (SELECT count(*) FROM public.run_checkpoints WHERE run_id = '${ids.terminalRun}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${ids.terminalRun}'),
  (SELECT concat_ws(':', material_kind, purged_events, purged_checkpoints,
    purged_outbox, financial_ledger_purged)
    FROM public.run_retention_purge_receipts
    WHERE id = '${ids.eventsPurgeReceipt}'),
  (SELECT purged_at > clock_timestamp() - interval '5 minutes'
      AND purged_at <> '2026-01-09T00:00:00.000Z'::timestamptz
    FROM public.run_retention_purge_receipts
    WHERE id = '${ids.eventsPurgeReceipt}')
);`,
    ),
    '0|1|1|EVENTS:2:0:0:f|t',
    'EVENTS purge and replay delete only events and stamp one DB-clock nonfinancial receipt',
  );
  for (const [label, patch] of [
    ['receipt identity', { purge_receipt_id: fixtureUuid(9943) }],
    ['manifest identity', { manifest_id: fixtureUuid(9944) }],
    ['verification identity', { verification_receipt_id: fixtureUuid(9945) }],
    ['approval identity', { approval_receipt_id: fixtureUuid(9946) }],
    ['archive reference', { archive_ref: 'fixture://archive/g006-terminal-run-other' }],
    ['archive hash', { archive_sha256: hash('g006-events-purge-other-archive') }],
    [
      'verification hash',
      { verification_receipt_sha256: hash('g006-events-purge-other-verification') },
    ],
    ['approval hash', { approval_receipt_sha256: hash('g006-events-purge-other-approval') }],
  ]) {
    await expectOwnerRejected(
      'ba_retention',
      `SELECT app.purge_run_events(${jsonb({ ...eligibleEvents, ...patch })});`,
      /EVENTS purge intent conflicts with durable receipt|23505/u,
      `EVENTS replay compares its persisted ${label}`,
    );
  }
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT count(*) FROM public.runs
WHERE id = '${ids.terminalRun}'
  AND events_retention_until <= '2026-01-09T00:00:00.000Z'::timestamptz
  AND retention_until > '2026-01-09T00:00:00.000Z'::timestamptz;`,
    ),
    '1',
    'EVENTS purge uses its independent events horizon before aggregate retention is eligible',
  );

  await expectRejected(
    'ba_migrator_test',
    ownerControlContextSql(
      'ba_run_owner',
      `UPDATE public.runs
SET recovery_retention_until = '2099-02-01T00:00:00.000Z',
    retention_until = '2099-03-01T00:00:00.000Z'
WHERE workspace_id = '${ids.workspace}' AND id = '${ids.terminalRun}';
RESET ROLE;
SET LOCAL ROLE ba_retention;
SELECT app.purge_run_recovery_material(${jsonb(earlyRecovery)});`,
    ),
    /not eligible for RECOVERY retention|23514/u,
    'RECOVERY purge locks and re-reads an in-transaction horizon extension',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.run_checkpoints WHERE run_id = '${ids.terminalRun}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${ids.terminalRun}')
);`,
    ),
    '1|1',
    'early RECOVERY rejection preserves checkpoint and delivered Outbox',
  );
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.credit_reservations (
  workspace_id, id, run_id, billing_owner_run_id, accepted_plan_hash,
  status, reserved_credits, settled_credits, released_credits,
  balance_version, expires_at, created_at, updated_at
) VALUES (
  '${ids.workspace}', '${ids.retentionHeldReservation}', '${ids.terminalRun}',
  '${ids.terminalRun}', '${hashes.terminalPlan}', 'HELD', 0, 0, 0,
  (SELECT credits_balance_version FROM public.workspaces WHERE id = '${ids.workspace}'),
  '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z'
);`,
  );
  await expectOwnerRejected(
    'ba_retention',
    `SELECT app.purge_run_recovery_material(${jsonb(eligibleRecovery)});`,
    /HELD reservation blocks RECOVERY retention|23514/u,
    'a HELD reservation blocks aggregate recovery purge',
  );
  await harness.psql(
    'ba_bootstrap_test',
    `DELETE FROM public.credit_reservations
WHERE workspace_id = '${ids.workspace}' AND id = '${ids.retentionHeldReservation}';`,
  );
  await expectOwnerRejected(
    'ba_retention',
    `SELECT app.purge_run_recovery_material(${jsonb({
      ...eligibleRecovery,
      purge_receipt_id: ids.eventsPurgeReceipt,
    })});`,
    /duplicate key value violates unique constraint|23505/u,
    'one receipt identity cannot be reused for another retention material kind',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.run_checkpoints WHERE run_id = '${ids.terminalRun}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${ids.terminalRun}'),
  (SELECT count(*) FROM public.run_retention_purge_receipts
    WHERE run_id = '${ids.terminalRun}')
);`,
    ),
    '1|1|1',
    'material-kind receipt conflict rolls checkpoint and Outbox deletion back',
  );
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.outbox (
  workspace_id, id, run_id, message_type, dedupe_key, payload_ref,
  payload_hash, producer_fencing_token, payload_redacted, status,
  available_at, created_at
) VALUES (
  '${ids.workspace}', '${ids.recoveryBlockingOutbox}', '${ids.terminalRun}',
  'SSE_WAKE', 'recovery-blocker',
  'fixture://outbox/g006-recovery-blocker', '${hash('g006-recovery-blocker')}',
  1, '{"status":"PENDING"}'::jsonb, 'PENDING',
  '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'
);`,
  );
  await expectOwnerRejected(
    'ba_retention',
    `SELECT app.purge_run_recovery_material(${jsonb(eligibleRecovery)});`,
    /pending or leased Outbox blocks RECOVERY retention|23514/u,
    'PENDING Outbox blocks an otherwise eligible RECOVERY purge',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.run_checkpoints WHERE run_id = '${ids.terminalRun}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${ids.terminalRun}'),
  (SELECT count(*) FROM public.run_retention_purge_receipts
    WHERE id = '${ids.recoveryPurgeReceipt}')
);`,
    ),
    '1|2|0',
    'blocked RECOVERY purge deletes nothing and writes no receipt',
  );
  await harness.psql(
    'ba_bootstrap_test',
    `UPDATE public.outbox
SET status = 'DELIVERED',
    delivered_at = '2026-02-02T00:00:00.000Z'
WHERE workspace_id = '${ids.workspace}'
  AND id = '${ids.recoveryBlockingOutbox}';`,
  );
  await assertConcurrentRetentionReplay(
    'purge_run_recovery_material',
    eligibleRecovery,
    'RECOVERY',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.runs WHERE id = '${ids.terminalRun}'
    AND status = 'FAILED' AND billing_state = 'SETTLED'
    AND terminal_event_id = '${ids.terminalEvent}'),
  (SELECT count(*) FROM public.run_checkpoints WHERE run_id = '${ids.terminalRun}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${ids.terminalRun}'),
  (SELECT concat_ws(':', material_kind, purged_events, purged_checkpoints,
    purged_outbox, financial_ledger_purged)
    FROM public.run_retention_purge_receipts
    WHERE id = '${ids.recoveryPurgeReceipt}'),
  (SELECT count(*) FROM public.run_archive_manifests WHERE id = '${ids.archiveManifest}'),
  (SELECT count(*) FROM public.run_archive_verification_receipts
    WHERE id = '${ids.archiveVerification}'),
  (SELECT count(*) FROM public.run_archive_approval_receipts
    WHERE id = '${ids.archiveApproval}')
);`,
    ),
    '1|0|0|RECOVERY:0:1:2:f|1|1|1',
    'RECOVERY purge and replay preserve terminal tombstone and exact immutable evidence',
  );
  for (const [label, patch] of [
    ['receipt identity', { purge_receipt_id: fixtureUuid(9947) }],
    ['manifest identity', { manifest_id: fixtureUuid(9948) }],
    ['verification identity', { verification_receipt_id: fixtureUuid(9949) }],
    ['approval identity', { approval_receipt_id: fixtureUuid(9950) }],
    ['archive reference', { archive_ref: 'fixture://archive/g006-terminal-run-other' }],
    ['archive hash', { archive_sha256: hash('g006-recovery-purge-other-archive') }],
    [
      'verification hash',
      { verification_receipt_sha256: hash('g006-recovery-purge-other-verification') },
    ],
    ['approval hash', { approval_receipt_sha256: hash('g006-recovery-purge-other-approval') }],
  ]) {
    await expectOwnerRejected(
      'ba_retention',
      `SELECT app.purge_run_recovery_material(${jsonb({ ...eligibleRecovery, ...patch })});`,
      /RECOVERY purge intent conflicts with durable receipt|23505/u,
      `RECOVERY replay compares its persisted ${label}`,
    );
  }
  assertEqual(
    await harness.queryScalar('ba_bootstrap_test', 'SELECT count(*) FROM public.credits_ledger;'),
    ledgerCountBefore,
    'EVENTS and RECOVERY purge never change financial ledger facts',
  );
}

async function assertNonEmptyDownGuard(migrations) {
  const factCountUnion = g006Relations
    .map(([tableName]) => `SELECT count(*)::bigint AS fact_count FROM public.${tableName}`)
    .join('\nUNION ALL\n');
  const durableStateSql = `WITH fact_counts AS (
  ${factCountUnion}
)
SELECT concat_ws('|',
  (SELECT count(*) FROM public.runs),
  (SELECT count(*) FROM public.credits_ledger),
  (SELECT sum(fact_count) FROM fact_counts),
  (SELECT jsonb_build_object(
    'version', version,
    'name', name,
    'checksum', checksum,
    'down_checksum', down_checksum,
    'applied_at', applied_at
  )::text
  FROM better_agent_migrations.schema_migrations
  WHERE version = 4)
);`;
  const before = await harness.queryScalar('ba_bootstrap_test', durableStateSql);
  await expectRejected(
    'ba_migrator_test',
    renderDownMigrationSql(migrations, 3, { allowDown: true }),
    /cannot remove G0-06.*durable facts|55000/u,
    '004 down refuses a nonempty durable Run and billing catalog',
  );
  assertEqual(
    await harness.queryScalar('ba_bootstrap_test', durableStateSql),
    before,
    'rejected nonempty down preserves Run, ledger, aggregate fact counts and the exact 004 ledger row',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT count(*)
FROM better_agent_migrations.schema_migrations
WHERE version = 4
  AND to_regclass('public.runs') IS NOT NULL
  AND to_regclass('public.credits_ledger') IS NOT NULL;`,
    ),
    '1',
    '004 remains applied with both core relations after the fail-closed down attempt',
  );
}

async function main() {
  assertVerbosePostgresErrorRejectsEchoOnly();
  await harness.start();
  await assert004RejectsIndirectMigratorEnrollmentBeforeInstall();
  const migrations = await installFreshSchema();
  await assert004PrerequisiteGuards(migrations);
  await assertOwnerBoundary();
  await assertRelationOwnershipAndRls();
  await assertFunctionSurfaceAndSearchPath();
  await seedWorkspaceCredentialAndFlowTarget();
  await assertOwnerFixtureRoleSwitchBoundary();

  const zeroFact = acceptanceFact(1000, 'g006-zero-credit-acceptance', 0);
  await assertZeroCreditAcceptanceAndBillingIdempotency(zeroFact);
  await assertConcurrentCreditReservation();
  await assertFlowNamespaceIsolationAndRollback(zeroFact);
  await assertBillingReplayExpiryAndReconciliation();
  await assertSideEffectUnknownReconciliation();
  await assertLedgerAppendOnly(zeroFact);
  await assertUnavailablePathsHaveNoSideEffects(zeroFact);
  await assertPgTempShadowingIsHarmless(zeroFact);
  await assertRuntimeOriginalRunBoundary(zeroFact);
  await assertReservationTimeMonotonicity(zeroFact);
  await assertFailureFinalizerTransactions();
  await assertSettleReleaseAndExpireRaces();

  await seedTerminalRetentionFixture();
  await assertArchiveAndRetention();
  await assertFunctionSurfaceAndSearchPath();
  await assertNonEmptyDownGuard(migrations);

  process.stdout.write(
    `PostgreSQL 16 G0-06 Run/Billing passed: ${migrations.length} migrations, six isolated owners, ${g006Relations.length} exact owner/FORCE-RLS tables, five-function runtime surface, zero-credit/replay/conflict facts, Workspace/reservation concurrency, terminal replay/conflict/rollback, monotonic reservation time, immutable ledger, unavailable-path rollback, pg_temp defense, exact archive evidence and two-phase nonfinancial retention.\n`,
  );
  process.stdout.write('architecture-gate-suite/1 run-billing pass\n');
}

let mainFailure;
try {
  await main();
} catch (error) {
  mainFailure = error;
}

const cleanupResults = await Promise.allSettled([harness.stop()]);
const cleanupFailures = cleanupResults.flatMap((result) =>
  result.status === 'rejected' ? [result.reason] : [],
);
const failures = mainFailure === undefined ? cleanupFailures : [mainFailure, ...cleanupFailures];
if (failures.length === 1) throw failures[0];
if (failures.length > 1) {
  throw new AggregateError(failures, 'G0-06 Run/Billing harness and cleanup failed');
}
