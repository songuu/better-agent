import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';

import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harnessDirectory = path.dirname(fileURLToPath(import.meta.url));
const composeFile = path.join(harnessDirectory, 'compose.yaml');
const migrationDirectory = path.resolve(harnessDirectory, '../../../packages/db/migrations');
const harness = createPostgresHarness('g006-run-conversation-browser');

function fixtureUuid(index) {
  return `b6000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function hash(label) {
  return `sha256:${createHash('sha256').update(label).digest('hex')}`;
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function bytea(hex) {
  return `decode('${hex}', 'hex')`;
}

function jsonb(value) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

const ids = Object.freeze({
  admin: fixtureUuid(1),
  ownerAttestation: fixtureUuid(2),
  workspace: fixtureUuid(3),
  agent: fixtureUuid(10),
  agentDraft: fixtureUuid(11),
  agentRelease: fixtureUuid(12),
  experience: fixtureUuid(13),
  experienceDraft: fixtureUuid(14),
  experienceRelease: fixtureUuid(15),
  profilePolicy: fixtureUuid(16),
  profilePolicyVersion: fixtureUuid(17),
  grantPolicy: fixtureUuid(18),
  grantPolicyVersion: fixtureUuid(19),
  scopePolicy: fixtureUuid(20),
  scopePolicyVersion: fixtureUuid(21),
  deployment: fixtureUuid(30),
  revision1: fixtureUuid(31),
  revision2: fixtureUuid(32),
  issuerSecretRef: fixtureUuid(40),
  issuerConfig: fixtureUuid(41),
  principal1: fixtureUuid(42),
  principal2: fixtureUuid(43),
  assertion1: fixtureUuid(50),
  assertion2: fixtureUuid(51),
  assertion3: fixtureUuid(52),
  assertion4: fixtureUuid(53),
  session1: fixtureUuid(60),
  session2: fixtureUuid(61),
  sessionFence: fixtureUuid(62),
  principalFenceSession: fixtureUuid(63),
  conversation: fixtureUuid(70),
  conversationState: fixtureUuid(71),
  raceConversation: fixtureUuid(80),
  raceConversationState: fixtureUuid(81),
});

const material = Object.freeze({
  issuerSubject: randomBytes(32).toString('hex'),
  ownerAttestation: randomBytes(32).toString('hex'),
  principal1Subject: randomBytes(32).toString('hex'),
  principal2Subject: randomBytes(32).toString('hex'),
  assertion1Nonce: randomBytes(32).toString('hex'),
  assertion2Nonce: randomBytes(32).toString('hex'),
  assertion3Nonce: randomBytes(32).toString('hex'),
  assertion4Nonce: randomBytes(32).toString('hex'),
  session1Verifier: randomBytes(32).toString('hex'),
  session2Verifier: randomBytes(32).toString('hex'),
  sessionFenceVerifier: randomBytes(32).toString('hex'),
  principalFenceVerifier: randomBytes(32).toString('hex'),
});

const hashes = Object.freeze({
  agent: hash('g006-browser-agent-release'),
  agentDraft: hash('g006-browser-agent-draft'),
  agentManifest: hash('g006-browser-agent-manifest'),
  experience: hash('g006-browser-experience-release'),
  experienceDraft: hash('g006-browser-experience-draft'),
  experienceManifest: hash('g006-browser-experience-manifest'),
  profilePolicy: hash('g006-browser-profile-policy'),
  grantPolicy: hash('g006-browser-grant-policy'),
  scopePolicy: hash('g006-browser-scope-policy'),
  mapping: hash('g006-browser-empty-mapping'),
  conversationContract: hash('g006-browser-conversation-contract'),
  revision1: hash('g006-browser-revision-1'),
  revision1Manifest: hash('g006-browser-revision-1-manifest'),
  revision1ChangeSet: hash('g006-browser-revision-1-change-set'),
  revision2: hash('g006-browser-revision-2'),
  revision2Manifest: hash('g006-browser-revision-2-manifest'),
  revision2ChangeSet: hash('g006-browser-revision-2-change-set'),
});

function ownerControlContextPrelude(owner) {
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

function ownerControlContextSql(owner, body) {
  return `${ownerControlContextPrelude(owner)}${body}
COMMIT;`;
}

function ownerPsql(owner, body, options = {}) {
  return harness.psql('ba_migrator_test', ownerControlContextSql(owner, body), options);
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
      // Keep SQL and fixture material out of the surfaced error. The caller
      // owns the semantic context for every interactive command.
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
    const marker = `__G006_INTERACTIVE_${sequence}_${randomBytes(8).toString('hex')}__`;
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

async function waitForBlockedActivity(
  waiterApplicationName,
  blockerApplicationName,
  context = 'PostgreSQL lock interleaving',
) {
  const lockObservationSql = `SELECT count(*)
FROM pg_catalog.pg_stat_activity AS waiter
WHERE waiter.application_name = ${sqlLiteral(waiterApplicationName)}
  AND waiter.wait_event_type = 'Lock'
  AND EXISTS (
    SELECT 1
    FROM unnest(pg_catalog.pg_blocking_pids(waiter.pid)) AS blocked_by(pid)
    JOIN pg_catalog.pg_stat_activity AS blocker
      ON blocker.pid = blocked_by.pid
    WHERE blocker.application_name = ${sqlLiteral(blockerApplicationName)}
  );`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const observed = await harness.queryScalar('ba_bootstrap_test', lockObservationSql);
    if (observed === '1') return;
    if (observed !== '0') {
      throw new Error(`${context}: expected one lock waiter, observed ${observed}`);
    }
    // This is a bounded observation poll, not a timing barrier: the transition
    // commits only after pg_stat_activity proves the exact blocking edge.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${context}: expected blocking edge was not observed`);
}

async function expectRejected(role, sql, pattern, context) {
  const result = await harness.psql(role, sql, { allowFailure: true });
  assertRejected(result, pattern, context);
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

function policyPin(policyId, policyVersionId, contractHash) {
  return {
    contract_hash: contractHash,
    policy_id: policyId,
    policy_version_id: policyVersionId,
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

function resourceFixtures() {
  const agentPin = pin('AGENT_RELEASE', ids.agent, ids.agentRelease, hashes.agent);
  const experiencePin = pin(
    'EXPERIENCE_RELEASE',
    ids.experience,
    ids.experienceRelease,
    hashes.experience,
  );
  const agentDocument = {
    agent_id: ids.agent,
    agent_release_id: ids.agentRelease,
    capability_bindings: [],
    contract_hash: hashes.agent,
    public_capability_handles: [],
    schema_version: 'agent-release/1',
    source_draft_revision_id: ids.agentDraft,
    workspace_id: ids.workspace,
  };
  const experienceDocument = {
    compatible_agent_id: ids.agent,
    content_hash: hashes.experience,
    experience_id: ids.experience,
    experience_release_id: ids.experienceRelease,
    quick_entries: [],
    schema_version: 'experience-release/1',
    source_draft_revision_id: ids.experienceDraft,
    workspace_id: ids.workspace,
  };

  function revisionPrepared(revisionId, revisionHash, manifestHash, changeSetHash) {
    const revisionPin = pin('DEPLOYMENT_REVISION', ids.deployment, revisionId, revisionHash);
    const document = {
      agent_deployment_id: ids.deployment,
      agent_deployment_revision_id: revisionId,
      agent_id: ids.agent,
      agent_release: agentPin,
      allowed_origins: ['https://app.example'],
      browser_client_channels: ['WEB_SDK'],
      change_set_hash: changeSetHash,
      conversation_contract_hash: hashes.conversationContract,
      credential_mapping_hash: hashes.mapping,
      credential_mappings: [],
      dependency_manifest_hash: manifestHash,
      entry_grant_policy: policyPin(ids.grantPolicy, ids.grantPolicyVersion, hashes.grantPolicy),
      entry_scope_policy: policyPin(ids.scopePolicy, ids.scopePolicyVersion, hashes.scopePolicy),
      environment: 'staging',
      experience_release: experiencePin,
      ingress_channel: 'browser',
      policy_profile: policyPin(ids.profilePolicy, ids.profilePolicyVersion, hashes.profilePolicy),
      revision_contract_hash: revisionHash,
      schema_version: 'agent-deployment/1',
      session_token_audience: 'agent_browser_api',
      workspace_id: ids.workspace,
    };
    return preparedResource({
      dependencies: [agentPin, experiencePin],
      document,
      fullPin: revisionPin,
      manifestHash,
    });
  }

  return {
    agentPrepared: preparedResource({
      document: agentDocument,
      fullPin: agentPin,
      manifestHash: hashes.agentManifest,
    }),
    experiencePrepared: preparedResource({
      dependencies: [agentPin],
      document: experienceDocument,
      fullPin: experiencePin,
      manifestHash: hashes.experienceManifest,
    }),
    revision1Prepared: revisionPrepared(
      ids.revision1,
      hashes.revision1,
      hashes.revision1Manifest,
      hashes.revision1ChangeSet,
    ),
    revision2Prepared: revisionPrepared(
      ids.revision2,
      hashes.revision2,
      hashes.revision2Manifest,
      hashes.revision2ChangeSet,
    ),
  };
}

function conversationFact(conversationId, stateId, createdAt) {
  return {
    agent_deployment_id: ids.deployment,
    agent_id: ids.agent,
    agent_release_id: ids.agentRelease,
    conversation_contract_hash: hashes.conversationContract,
    conversation_id: conversationId,
    created_at: createdAt,
    created_deployment_revision_id: ids.revision1,
    end_user_principal_id: ids.principal1,
    experience_release_id: ids.experienceRelease,
    principal_kind: 'end_user',
    session_store_redacted: { locale: 'zh-CN' },
    state_hash: hash(`conversation-state-0:${conversationId}`),
    state_id: stateId,
    variables_redacted: { turn: 0 },
    workspace_id: ids.workspace,
  };
}

function acceptanceFact(base, conversationId, idempotencyKey, acceptedAt) {
  const runId = fixtureUuid(base);
  const acceptedRequestId = fixtureUuid(base + 1);
  const acceptedPlanHash = hash(`accepted-plan:${base}`);
  return Object.freeze({
    acceptance_receipt_data_redacted: {
      accepted_request_id: acceptedRequestId,
      events_url: `/v1/oapi/runs/${runId}/events`,
      operation_url: `/v1/oapi/runs/${runId}`,
      run_id: runId,
      status: 'QUEUED',
    },
    accepted_at: acceptedAt,
    accepted_event_id: fixtureUuid(base + 5),
    accepted_output_schema_hash: hash(`accepted-output:${base}`),
    accepted_output_schema_ref: 'schema://g006/agent-chat-output',
    accepted_plan_hash: acceptedPlanHash,
    accepted_request_id: acceptedRequestId,
    admission_snapshot_hash: hash(`admission-snapshot:${base}`),
    agent_deployment_id: ids.deployment,
    agent_deployment_revision_id: ids.revision1,
    agent_id: ids.agent,
    agent_release_id: ids.agentRelease,
    conversation_contract_hash: hashes.conversationContract,
    conversation_id: conversationId,
    dependency_pins_hash: hash(`dependency-pins:${base}`),
    dispatch_outbox_id: fixtureUuid(base + 6),
    end_user_principal_id: ids.principal1,
    expected_state_version: 0,
    experience_release_id: ids.experienceRelease,
    idempotency_key: idempotencyKey,
    intent_hash: hash(`agent-chat-intent:${base}`),
    next_session_store_redacted: { last_run_id: runId },
    next_state_hash: hash(`conversation-state-1:${base}`),
    next_state_version: 1,
    next_variables_redacted: { turn: 1 },
    principal_kind: 'end_user',
    receipt_id: fixtureUuid(base + 3),
    reservation_expires_at: '2026-08-28T12:00:00.000Z',
    reservation_id: fixtureUuid(base + 7),
    reserve_billing_intent_hash: hash(`reserve-intent:${base}`),
    reserve_charge_attribution_hash: acceptedPlanHash,
    reserve_charge_key: `g006-agent-chat-reserve-${base}`,
    reserve_ledger_entry_id: fixtureUuid(base + 8),
    reserved_credits: '0',
    run_id: runId,
    sentinel_id: fixtureUuid(base + 2),
    user_message_content_hash: hash(`user-message:${base}`),
    user_message_content_redacted: { text: `fixture-message-${base}` },
    user_message_id: fixtureUuid(base + 4),
    workspace_id: ids.workspace,
  });
}

function browserIdentityBlock(sessionId, verifierHex, body) {
  return `BEGIN;
SELECT set_config('app.g006_browser_verifier_hex', '${verifierHex}', true);
DO $browser_runtime$
DECLARE
  v_identity jsonb;
  v_browser_identity jsonb;
  v_result jsonb;
  v_events jsonb;
BEGIN
  v_identity := auth.authenticate_browser_session_identity(
    '${sessionId}',
    decode(current_setting('app.g006_browser_verifier_hex'), 'hex'),
    'https://app.example',
    'agent_browser_api',
    'WEB_SDK'
  );
  v_browser_identity := jsonb_build_object(
    'browserSessionId', v_identity ->> 'browser_session_id',
    'endUserPrincipalId', v_identity ->> 'end_user_principal_id',
    'agentDeploymentId', v_identity ->> 'agent_deployment_id',
    'sessionAuthorizationEpoch', (v_identity ->> 'session_epoch')::bigint,
    'principalAuthorizationEpoch',
      (v_identity ->> 'observed_principal_session_epoch')::bigint,
    'deploymentAuthorizationEpoch',
      (v_identity ->> 'observed_deployment_revoke_epoch')::bigint
  );
${body}
END;
$browser_runtime$;
COMMIT;`;
}

function signedBrowserOriginalRunBlock(sessionId, principalId, verifierHex, body) {
  return `BEGIN;
SELECT set_config('app.g006_browser_verifier_hex', '${verifierHex}', true);
DO $browser_original_run$
DECLARE
  v_signature text;
  v_browser_identity jsonb;
  v_result jsonb;
BEGIN
  v_signature := encode(
    public.hmac(
      convert_to(
        format(
          'browser:%s:%s:%s:%s:%s:%s',
          '${ids.workspace}'::uuid,
          '${sessionId}'::uuid,
          '${principalId}'::uuid,
          '${ids.deployment}'::uuid,
          txid_current(),
          session_user
        ),
        'UTF8'
      ),
      decode(current_setting('app.g006_browser_verifier_hex'), 'hex'),
      'sha256'
    ),
    'hex'
  );
  PERFORM set_config(
    'app.tenant_context',
    format(
      'browser:%s:%s:%s:%s:%s:%s',
      '${ids.workspace}'::uuid,
      '${sessionId}'::uuid,
      '${principalId}'::uuid,
      '${ids.deployment}'::uuid,
      txid_current(),
      v_signature
    ),
    true
  );
  IF app.current_workspace_id() IS DISTINCT FROM '${ids.workspace}'::uuid THEN
    RAISE EXCEPTION 'browser original Run fixture could not establish signed context';
  END IF;
  v_browser_identity := jsonb_build_object(
    'browserSessionId', '${sessionId}',
    'endUserPrincipalId', '${principalId}',
    'agentDeploymentId', '${ids.deployment}',
    'sessionAuthorizationEpoch', 0,
    'principalAuthorizationEpoch', 0,
    'deploymentAuthorizationEpoch', 1
  );
${body}
END;
$browser_original_run$;
COMMIT;`;
}

function namespaceProbeBody(fact) {
  return `  v_result := app.lock_original_run_idempotency_namespace(
    jsonb_build_object(
      'schema_version', 'run-idempotency-namespace/1',
      'workspace_id', '${ids.workspace}',
      'authenticated_principal', jsonb_build_object(
        'schema_version', 'conversation-principal/1',
        'kind', 'end_user',
        'end_user_principal_id', '${ids.principal1}'
      ),
      'fixed_route', '/v1/oapi/agent/chat',
      'idempotency_key', '${fact.idempotency_key}',
      'browserIdentity', v_browser_identity
    )
  );
  IF v_result ->> 'runId' IS DISTINCT FROM '${fact.run_id}'
     OR v_result ->> 'intentHash' IS DISTINCT FROM '${fact.intent_hash}'
     OR v_result -> 'namespace' ? 'browserIdentity' THEN
    RAISE EXCEPTION 'browser principal namespace did not resolve the persisted Run';
  END IF;`;
}

async function installFreshSchema() {
  const migrations = await loadMigrations(migrationDirectory);
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), {
    echoErrors: true,
  });
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      "SELECT current_setting('server_version_num')::integer BETWEEN 160000 AND 169999;",
    ),
    't',
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
  return migrations;
}

async function seedWorkspaceAndOwnerContext() {
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces (
  id, name, credits_balance, credits_reserved_balance, credits_balance_version
) VALUES ('${ids.workspace}', 'G0-06 Agent Chat/browser fixture', 0, 0, 0);
INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES ('${ids.workspace}', '${ids.admin}', 'admin');`,
  );
  await harness.psql(
    'ba_management_issuer_test',
    `SELECT auth.issue_control_session_attestation(
  '${ids.ownerAttestation}',
  '${ids.workspace}',
  '${ids.admin}',
  'ba_migrator_test',
  'g006-agent-chat-test-idp',
  ${bytea(material.issuerSubject)},
  ${bytea(material.ownerAttestation)},
  clock_timestamp() + interval '10 minutes'
);`,
  );
}

async function publishBrowserDeployment() {
  const fixtures = resourceFixtures();
  await ownerPsql(
    'ba_authorization_owner',
    `SELECT app.create_publishable_resource_root('AGENT_RELEASE', '${ids.agent}');
SELECT app.append_publishable_resource_draft_revision(
  '${ids.agentDraft}', 'AGENT_RELEASE', '${ids.agent}', 1,
  '{"name":"G0-06 browser agent"}'::jsonb, '${hashes.agentDraft}'
);
SELECT app.publish_agent_release(${jsonb(fixtures.agentPrepared)});
SELECT app.create_publishable_resource_root('EXPERIENCE_RELEASE', '${ids.experience}');
SELECT app.append_publishable_resource_draft_revision(
  '${ids.experienceDraft}', 'EXPERIENCE_RELEASE', '${ids.experience}', 1,
  '{"quick_entries":[]}'::jsonb, '${hashes.experienceDraft}'
);
SELECT app.publish_experience_release(${jsonb(fixtures.experiencePrepared)});
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
SELECT app.create_agent_deployment(${jsonb({
      agent_deployment_id: ids.deployment,
      agent_id: ids.agent,
      environment: 'staging',
      ingress_channel: 'browser',
      public_selector: 'g006-browser-agent',
      schema_version: 'agent-deployment-stable/1',
      workspace_id: ids.workspace,
    })});
SELECT app.publish_agent_deployment_revision(${jsonb(fixtures.revision1Prepared)});
SELECT app.publish_agent_deployment_revision(${jsonb(fixtures.revision2Prepared)});
SELECT app.promote_agent_deployment(
  '${ids.deployment}', '${ids.revision1}', 0, 'activate first browser revision'
);
SELECT app.transition_agent_deployment_security('${ids.deployment}', 0, 'ACTIVE');`,
  );
}

async function seedBrowserIdentityFacts() {
  const assertions = [
    [ids.assertion1, ids.principal1, material.principal1Subject, material.assertion1Nonce],
    [ids.assertion2, ids.principal1, material.principal1Subject, material.assertion2Nonce],
    [ids.assertion3, ids.principal1, material.principal1Subject, material.assertion3Nonce],
    [ids.assertion4, ids.principal2, material.principal2Subject, material.assertion4Nonce],
  ];
  const sessions = [
    [ids.session1, ids.principal1, ids.assertion1],
    [ids.session2, ids.principal1, ids.assertion2],
    [ids.sessionFence, ids.principal1, ids.assertion3],
    [ids.principalFenceSession, ids.principal2, ids.assertion4],
  ];
  await ownerPsql(
    'ba_authorization_owner',
    `INSERT INTO public.secret_refs (
  id, workspace_id, provider, opaque_locator, purpose, status
) VALUES (
  '${ids.issuerSecretRef}', '${ids.workspace}', 'env',
  'G006_BROWSER_ISSUER_KEY', 'browser assertion verification', 'active'
);
INSERT INTO public.browser_subject_issuer_configs (
  id, workspace_id, issuer, audience, verification_key_ref_id,
  key_version, allowed_origins, status
) VALUES (
  '${ids.issuerConfig}', '${ids.workspace}', 'https://issuer.example',
  'better-agent:browser-exchange', '${ids.issuerSecretRef}', 1,
  ARRAY['https://app.example']::text[], 'active'
);
INSERT INTO public.end_user_principals (
  id, workspace_id, issuer_config_id, issuer, subject_hash,
  status, session_epoch
) VALUES
  ('${ids.principal1}', '${ids.workspace}', '${ids.issuerConfig}',
   'https://issuer.example', ${bytea(material.principal1Subject)}, 'active', 0),
  ('${ids.principal2}', '${ids.workspace}', '${ids.issuerConfig}',
   'https://issuer.example', ${bytea(material.principal2Subject)}, 'active', 0);
INSERT INTO public.browser_subject_assertion_uses (
  id, workspace_id, issuer_config_id, principal_id, assertion_nonce_hash,
  subject_hash, audience, canonical_origin, key_version,
  assertion_issued_at, assertion_expires_at
) VALUES
  ${assertions
    .map(
      ([assertionId, principalId, subjectHash, nonceHash]) =>
        `('${assertionId}', '${ids.workspace}', '${ids.issuerConfig}', '${principalId}',
   ${bytea(nonceHash)}, ${bytea(subjectHash)}, 'better-agent:browser-exchange',
   'https://app.example', 1, clock_timestamp() - interval '1 second',
   clock_timestamp() + interval '5 minutes')`,
    )
    .join(',\n  ')};
INSERT INTO public.browser_sessions (
  id, workspace_id, agent_deployment_id, principal_id, assertion_use_id,
  client_channel, canonical_origin, token_audience,
  observed_principal_session_epoch, observed_deployment_revoke_epoch,
  session_epoch, status, issued_at, expires_at
) VALUES
  ${sessions
    .map(
      ([sessionId, principalId, assertionId]) =>
        `('${sessionId}', '${ids.workspace}', '${ids.deployment}', '${principalId}',
   '${assertionId}', 'WEB_SDK', 'https://app.example', 'agent_browser_api',
   0, 1, 0, 'ACTIVE', clock_timestamp(), clock_timestamp() + interval '10 minutes')`,
    )
    .join(',\n  ')};`,
  );

  const verifierRows = [
    [ids.session1, material.session1Verifier],
    [ids.session2, material.session2Verifier],
    [ids.sessionFence, material.sessionFenceVerifier],
    [ids.principalFenceSession, material.principalFenceVerifier],
  ];
  await ownerPsql(
    'ba_auth_owner',
    `INSERT INTO auth.browser_session_auth_index (
  browser_session_id, workspace_id, verifier_hmac, verifier_algorithm,
  status, session_epoch, expires_at
)
SELECT session_row.id, session_row.workspace_id, fixture.verifier_hmac,
       'hmac-sha-256', 'ACTIVE', session_row.session_epoch,
       session_row.expires_at
FROM (VALUES
  ${verifierRows
    .map(([sessionId, verifier]) => `('${sessionId}'::uuid, ${bytea(verifier)})`)
    .join(',\n  ')}
) AS fixture(session_id, verifier_hmac)
JOIN public.browser_sessions AS session_row
  ON session_row.id = fixture.session_id
 AND session_row.workspace_id = '${ids.workspace}';`,
  );
}

async function assertOwnerOnlyAgentChatPath() {
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT concat_ws('|',
  has_function_privilege('ba_runtime_test', 'app.create_prepared_conversation(jsonb)', 'EXECUTE'),
  has_function_privilege('ba_runtime_test', 'app.accept_prepared_agent_chat_run(jsonb)', 'EXECUTE'),
  has_function_privilege('ba_control_test', 'app.create_prepared_conversation(jsonb)', 'EXECUTE'),
  has_function_privilege('ba_control_test', 'app.accept_prepared_agent_chat_run(jsonb)', 'EXECUTE')
);`,
    ),
    'f|f|f|f',
    'Conversation creation and Agent Chat acceptance remain owner-only',
  );

  const acceptedAt = '2026-08-27T10:00:00.000Z';
  const fact = acceptanceFact(100, ids.conversation, 'agent-chat-primary', acceptedAt);
  await ownerPsql(
    'ba_run_owner',
    `SELECT app.create_prepared_conversation(${jsonb(
      conversationFact(ids.conversation, ids.conversationState, acceptedAt),
    )});
SELECT app.accept_prepared_agent_chat_run(${jsonb(fact)});`,
  );

  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT current_state_version FROM public.conversations
    WHERE id = '${ids.conversation}'),
  (SELECT state_version FROM public.conversation_states
    WHERE conversation_id = '${ids.conversation}'),
  (SELECT count(*) FROM public.conversation_messages
    WHERE conversation_id = '${ids.conversation}'),
  (SELECT count(*) FROM public.runs WHERE id = '${fact.run_id}'),
  (SELECT count(*) FROM public.credit_reservations
    WHERE id = '${fact.reservation_id}' AND reserved_credits = 0 AND status = 'HELD'),
  (SELECT count(*) FROM public.credits_ledger
    WHERE id = '${fact.reserve_ledger_entry_id}'
      AND available_delta_credits = 0 AND reserved_delta_credits = 0
      AND settled_delta_credits = 0 AND balance_version = 0),
  (SELECT count(*) FROM public.run_events WHERE run_id = '${fact.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${fact.run_id}'),
  (SELECT count(*) FROM public.run_acceptance_receipts WHERE run_id = '${fact.run_id}'),
  (SELECT count(*) FROM public.run_idempotency_sentinels WHERE id = '${fact.sentinel_id}'),
  (SELECT credits_balance FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT credits_reserved_balance FROM public.workspaces WHERE id = '${ids.workspace}'),
  (SELECT credits_balance_version FROM public.workspaces WHERE id = '${ids.workspace}')
);`,
    ),
    '1|1|1|1|1|1|1|1|1|1|0|0|0',
    'Agent Chat acceptance atomically writes one message, CAS state, Run, zero billing, Event and Outbox',
  );
  return fact;
}

async function assertConversationCasRace() {
  const acceptedAt = '2026-08-27T10:01:00.000Z';
  await ownerPsql(
    'ba_run_owner',
    `SELECT app.create_prepared_conversation(${jsonb(
      conversationFact(ids.raceConversation, ids.raceConversationState, acceptedAt),
    )});`,
  );
  const facts = [
    acceptanceFact(200, ids.raceConversation, 'agent-chat-race-a', acceptedAt),
    acceptanceFact(220, ids.raceConversation, 'agent-chat-race-b', acceptedAt),
  ];
  const results = await Promise.all(
    facts.map((fact) =>
      ownerPsql('ba_run_owner', `SELECT app.accept_prepared_agent_chat_run(${jsonb(fact)});`, {
        allowFailure: true,
      }),
    ),
  );
  const successes = results.filter((result) => result.exitCode === 0);
  const failures = results.filter((result) => result.exitCode !== 0);
  const winningFact = facts[results.findIndex((result) => result.exitCode === 0)];
  assertEqual(String(successes.length), '1', 'exactly one concurrent Conversation CAS wins');
  assertEqual(String(failures.length), '1', 'exactly one concurrent Conversation CAS loses');
  assertRejected(
    failures[0],
    /Conversation principal, target, contract or CAS version does not match|40001/u,
    'concurrent stale Conversation acceptance',
  );

  const idsSql = (values) => values.map((value) => sqlLiteral(value)).join(', ');
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT current_state_version FROM public.conversations
    WHERE id = '${ids.raceConversation}'),
  (SELECT state_version FROM public.conversation_states
    WHERE conversation_id = '${ids.raceConversation}'),
  (SELECT count(*) FROM public.conversation_messages
    WHERE conversation_id = '${ids.raceConversation}'),
  (SELECT count(*) FROM public.runs WHERE id IN (${idsSql(facts.map((fact) => fact.run_id))})),
  (SELECT count(*) FROM public.credit_reservations
    WHERE id IN (${idsSql(facts.map((fact) => fact.reservation_id))})),
  (SELECT count(*) FROM public.credits_ledger
    WHERE id IN (${idsSql(facts.map((fact) => fact.reserve_ledger_entry_id))})),
  (SELECT count(*) FROM public.run_events
    WHERE id IN (${idsSql(facts.map((fact) => fact.accepted_event_id))})),
  (SELECT count(*) FROM public.outbox
    WHERE id IN (${idsSql(facts.map((fact) => fact.dispatch_outbox_id))})),
  (SELECT count(*) FROM public.run_acceptance_receipts
    WHERE id IN (${idsSql(facts.map((fact) => fact.receipt_id))})),
  (SELECT count(*) FROM public.run_idempotency_sentinels
    WHERE id IN (${idsSql(facts.map((fact) => fact.sentinel_id))})),
  (SELECT credits_balance_version FROM public.workspaces WHERE id = '${ids.workspace}')
);`,
    ),
    '1|1|1|1|1|1|1|1|1|1|0',
    'losing Conversation CAS transaction leaves no partial Run, billing, Event, Outbox or idempotency fact',
  );
  return winningFact;
}

async function promotePointerAwayFromAcceptedRevision() {
  await ownerPsql(
    'ba_authorization_owner',
    `SELECT app.promote_agent_deployment(
  '${ids.deployment}', '${ids.revision2}', 1,
  'prove original Run authorization is stable-target and pointer-free'
);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|', pointer.active_revision_id, pointer.activation_epoch, run_row.agent_deployment_revision_id)
FROM public.agent_deployment_active_pointers AS pointer
CROSS JOIN public.runs AS run_row
WHERE pointer.agent_deployment_id = '${ids.deployment}'
  AND run_row.id = '${fixtureUuid(100)}';`,
    ),
    `${ids.revision2}|2|${ids.revision1}`,
    'active pointer moved while the accepted Run retained its immutable revision pin',
  );
}

async function assertBrowserNamespaceReadEventsAndCancel(fact, conflictFact) {
  await harness.psql(
    'ba_runtime_test',
    browserIdentityBlock(ids.session1, material.session1Verifier, namespaceProbeBody(fact)),
  );
  await harness.psql(
    'ba_runtime_other_test',
    browserIdentityBlock(ids.session2, material.session2Verifier, namespaceProbeBody(fact)),
  );

  const beforeMutationCounts = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT concat_ws('|',
  (SELECT count(*) FROM public.run_events WHERE run_id = '${fact.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${fact.run_id}')
);`,
  );
  assertEqual(beforeMutationCounts, '1|1', 'accepted browser Run starts with one Event and Outbox');

  for (const [field, value] of [
    ['sessionAuthorizationEpoch', 9],
    ['principalAuthorizationEpoch', 9],
    ['deploymentAuthorizationEpoch', 9],
  ]) {
    await expectRejected(
      'ba_runtime_test',
      browserIdentityBlock(
        ids.session1,
        material.session1Verifier,
        `  v_browser_identity := jsonb_set(
    v_browser_identity,
    '{${field}}',
    '${value}'::jsonb
  );
  v_result := app.request_run_cancellation(
    jsonb_build_object(
      'workspaceId', '${ids.workspace}',
      'authenticatedPrincipal', jsonb_build_object(
        'schema_version', 'conversation-principal/1',
        'kind', 'end_user',
        'end_user_principal_id', '${ids.principal1}'
      ),
      'browserIdentity', v_browser_identity,
      'idempotencyKey', 'tampered-${field}',
      'runId', '${fact.run_id}',
      'requiredScope', 'run:cancel'
    )
  );`,
      ),
      /browser session does not authorize persisted original Run target|42501/u,
      `persisted target ${field} fence`,
    );
    assertEqual(
      await harness.queryScalar(
        'ba_bootstrap_test',
        `SELECT concat_ws('|',
  (SELECT count(*) FROM public.run_events WHERE run_id = '${fact.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${fact.run_id}')
);`,
      ),
      beforeMutationCounts,
      `failed ${field} authorization leaves Event and Outbox unchanged`,
    );
  }

  await harness.psql(
    'ba_runtime_test',
    browserIdentityBlock(
      ids.session1,
      material.session1Verifier,
      `  v_result := app.read_original_run(
    '${fact.run_id}',
    jsonb_build_object(
      'auth_mode', 'browser',
      'workspaceId', '${ids.workspace}',
      'browserIdentity', v_browser_identity
    )
  );
  IF v_result ->> 'runId' IS DISTINCT FROM '${fact.run_id}'
     OR v_result ->> 'deploymentId' IS DISTINCT FROM '${ids.deployment}'
     OR v_result ->> 'browserSessionId' IS DISTINCT FROM '${ids.session1}' THEN
    RAISE EXCEPTION 'pointer-free original Run read returned the wrong authorization facts';
  END IF;
  v_events := app.read_original_run_events(
    '${fact.run_id}',
    jsonb_build_object(
      'auth_mode', 'browser',
      'workspaceId', '${ids.workspace}',
      'browserIdentity', v_browser_identity
    )
  );
  IF jsonb_array_length(v_events) <> 1
     OR v_events -> 0 ->> 'event_type' <> 'RUN_ACCEPTED' THEN
    RAISE EXCEPTION 'browser original Run event replay is incomplete';
  END IF;
  v_result := app.request_run_cancellation(
    jsonb_build_object(
      'workspaceId', '${ids.workspace}',
      'authenticatedPrincipal', jsonb_build_object(
        'schema_version', 'conversation-principal/1',
        'kind', 'end_user',
        'end_user_principal_id', '${ids.principal1}'
      ),
      'browserIdentity', v_browser_identity,
      'idempotencyKey', 'browser-cancel-primary',
      'runId', '${fact.run_id}',
      'requiredScope', 'run:cancel'
    )
  );
  IF v_result ->> 'outcome' <> 'ACCEPTED'
     OR v_result -> 'receipt' ->> 'http_status' <> '202'
     OR v_result -> 'receipt' -> 'data' ->> 'status' <> 'CANCEL_REQUESTED' THEN
    RAISE EXCEPTION 'browser cancellation did not return the canonical accepted receipt';
  END IF;
  v_events := app.read_original_run_events(
    '${fact.run_id}',
    jsonb_build_object(
      'auth_mode', 'browser',
      'workspaceId', '${ids.workspace}',
      'browserIdentity', v_browser_identity
    )
  );
  IF jsonb_array_length(v_events) <> 2
     OR v_events -> 1 ->> 'event_type' <> 'RUN_CANCEL_REQUESTED' THEN
    RAISE EXCEPTION 'browser cancellation event is not durably replayable';
  END IF;`,
    ),
  );

  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT status FROM public.runs WHERE id = '${fact.run_id}'),
  (SELECT execution_status FROM public.runs WHERE id = '${fact.run_id}'),
  (SELECT last_event_sequence FROM public.runs WHERE id = '${fact.run_id}'),
  (SELECT count(*) FROM public.run_events WHERE run_id = '${fact.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${fact.run_id}'),
  (SELECT count(*) FROM public.run_mutation_idempotency
    WHERE target_run_id = '${fact.run_id}' AND completed_at IS NOT NULL)
);`,
    ),
    'CANCEL_REQUESTED|CANCELLING|2|2|2|1',
    'pointer-free browser cancellation writes exactly one Event, Outbox and durable receipt',
  );

  await harness.psql(
    'ba_runtime_other_test',
    browserIdentityBlock(
      ids.session2,
      material.session2Verifier,
      `  v_result := app.request_run_cancellation(
    jsonb_build_object(
      'workspaceId', '${ids.workspace}',
      'authenticatedPrincipal', jsonb_build_object(
        'schema_version', 'conversation-principal/1',
        'kind', 'end_user',
        'end_user_principal_id', '${ids.principal1}'
      ),
      'browserIdentity', v_browser_identity,
      'idempotencyKey', 'browser-cancel-primary',
      'runId', '${fact.run_id}',
      'requiredScope', 'run:cancel'
    )
  );
  IF v_result ->> 'outcome' <> 'REPLAY'
     OR v_result -> 'receipt' ->> 'http_status' <> '202'
     OR v_result -> 'receipt' -> 'data' ->> 'status' <> 'CANCEL_REQUESTED' THEN
    RAISE EXCEPTION 'same-intent cancellation did not replay its committed receipt';
  END IF;`,
    ),
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.run_events WHERE run_id = '${fact.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${fact.run_id}'),
  (SELECT count(*) FROM public.run_mutation_idempotency
    WHERE target_run_id = '${fact.run_id}'
      AND idempotency_key = 'browser-cancel-primary'
      AND completed_at IS NOT NULL)
);`,
    ),
    '2|2|1',
    'same-principal cross-session cancellation replay adds no Event, Outbox or receipt row',
  );

  await expectRejected(
    'ba_runtime_other_test',
    browserIdentityBlock(
      ids.session2,
      material.session2Verifier,
      `  v_result := app.request_run_cancellation(
    jsonb_build_object(
      'workspaceId', '${ids.workspace}',
      'authenticatedPrincipal', jsonb_build_object(
        'schema_version', 'conversation-principal/1',
        'kind', 'end_user',
        'end_user_principal_id', '${ids.principal1}'
      ),
      'browserIdentity', v_browser_identity,
      'idempotencyKey', 'browser-cancel-primary',
      'runId', '${conflictFact.run_id}',
      'requiredScope', 'run:cancel'
    )
  );`,
    ),
    /Idempotency-Key was reused for another Run target|23505/u,
    'same cancellation key with a different original Run target',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.run_events WHERE run_id = '${fact.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${fact.run_id}'),
  (SELECT count(*) FROM public.run_events WHERE run_id = '${conflictFact.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${conflictFact.run_id}'),
  (SELECT count(*) FROM public.run_mutation_idempotency
    WHERE end_user_principal_id = '${ids.principal1}'
      AND idempotency_key = 'browser-cancel-primary')
);`,
    ),
    '2|2|1|1|1',
    'different-target cancellation conflict leaves both Runs and the committed receipt unchanged',
  );

  await harness.psql(
    'ba_runtime_other_test',
    browserIdentityBlock(
      ids.principalFenceSession,
      material.principalFenceVerifier,
      `  v_result := app.read_original_run(
    '${fact.run_id}',
    jsonb_build_object(
      'auth_mode', 'browser',
      'workspaceId', '${ids.workspace}',
      'browserIdentity', v_browser_identity
    )
  );
  IF v_result IS NOT NULL THEN
    RAISE EXCEPTION 'another principal observed an original Run';
  END IF;`,
    ),
  );
  await expectRejected(
    'ba_runtime_other_test',
    browserIdentityBlock(
      ids.principalFenceSession,
      material.principalFenceVerifier,
      `  v_result := app.request_run_cancellation(
    jsonb_build_object(
      'workspaceId', '${ids.workspace}',
      'authenticatedPrincipal', jsonb_build_object(
        'schema_version', 'conversation-principal/1',
        'kind', 'end_user',
        'end_user_principal_id', '${ids.principal2}'
      ),
      'browserIdentity', v_browser_identity,
      'idempotencyKey', 'wrong-principal-cancel',
      'runId', '${fact.run_id}',
      'requiredScope', 'run:cancel'
    )
  );`,
    ),
    /browser identity does not own persisted original Run target|42501/u,
    'different browser principal cannot mutate another principal original Run',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.run_events WHERE run_id = '${fact.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${fact.run_id}'),
  (SELECT count(*) FROM public.run_mutation_idempotency
    WHERE idempotency_key = 'wrong-principal-cancel')
);`,
    ),
    '2|2|0',
    'wrong-principal read is invisible and failed cancellation leaves no durable mutation facts',
  );
}

async function assertBrowserSessionRevokeInterleaving(fact) {
  const blockerApplicationName = `g006-session-private-blocker-${process.pid}`;
  const revokerApplicationName = `g006-session-revoker-${process.pid}`;
  const waiterApplicationName = `g006-session-auth-waiter-${process.pid}`;
  const legacyWaiterApplicationName = `g006-session-legacy-auth-waiter-${process.pid}`;
  const blocker = openInteractivePsql('ba_migrator_test');
  const revoker = openInteractivePsql('ba_migrator_test');
  let blockerCommitted = false;
  let revokerCommitted = false;
  let revokerPromise;
  let waiterPromise;
  let waiterResult;
  let legacyWaiterPromise;
  let legacyWaiterResult;
  const failures = [];

  try {
    await blocker.execute(
      `BEGIN;
SELECT set_config('application_name', ${sqlLiteral(blockerApplicationName)}, false);
SET LOCAL ROLE ba_auth_owner;
SELECT 1
FROM auth.browser_session_auth_index
WHERE browser_session_id = '${ids.sessionFence}'
FOR UPDATE;`,
      'hold the private browser-session projection lock',
    );

    revokerPromise = revoker.execute(
      `${ownerControlContextPrelude('ba_auth_owner')}
SELECT set_config('application_name', ${sqlLiteral(revokerApplicationName)}, false);
SELECT auth.revoke_browser_session('${ids.sessionFence}', 0);`,
      'revoke the public browser session before its private projection',
    );
    await waitForBlockedActivity(
      revokerApplicationName,
      blockerApplicationName,
      'browser-session revoke waits on the private projection after locking the public session',
    );

    waiterPromise = harness.psql(
      'ba_runtime_test',
      `SET application_name = ${sqlLiteral(waiterApplicationName)};
${browserIdentityBlock(ids.sessionFence, material.sessionFenceVerifier, namespaceProbeBody(fact))}`,
      { allowFailure: true },
    );
    await waitForBlockedActivity(
      waiterApplicationName,
      revokerApplicationName,
      'browser authentication locks the public session before the private verifier',
    );

    legacyWaiterPromise = harness.psql(
      'ba_runtime_test',
      `BEGIN;
SELECT set_config('application_name', ${sqlLiteral(legacyWaiterApplicationName)}, false);
SELECT set_config(
  'app.g006_legacy_browser_verifier_hex',
  '${material.sessionFenceVerifier}',
  true
);
SELECT auth.authenticate_browser_session_facts(
  '${ids.sessionFence}',
  decode(current_setting('app.g006_legacy_browser_verifier_hex'), 'hex'),
  'https://app.example', 'agent_browser_api', 'WEB_SDK'
);
COMMIT;`,
      { allowFailure: true },
    );
    await waitForBlockedActivity(
      legacyWaiterApplicationName,
      revokerApplicationName,
      'legacy browser-facts authentication locks public before private',
    );

    await blocker.execute('COMMIT;', 'release the private browser-session projection lock');
    blockerCommitted = true;
    await revokerPromise;
    await revoker.execute('COMMIT;', 'commit browser-session revoke');
    revokerCommitted = true;
    waiterResult = await waiterPromise;
    legacyWaiterResult = await legacyWaiterPromise;
  } catch (error) {
    failures.push(error);
  }

  if (!blockerCommitted) {
    try {
      await blocker.execute('COMMIT;', 'release failed private projection blocker');
      blockerCommitted = true;
    } catch (error) {
      failures.push(error);
    }
  }
  if (revokerPromise !== undefined) {
    try {
      await revokerPromise;
    } catch (error) {
      failures.push(error);
    }
  }
  if (!revokerCommitted && revokerPromise !== undefined) {
    try {
      await revoker.execute('COMMIT;', 'commit browser-session revoke during cleanup');
      revokerCommitted = true;
    } catch (error) {
      failures.push(error);
    }
  }
  for (const client of [blocker, revoker]) {
    try {
      await client.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (waiterPromise !== undefined && waiterResult === undefined) {
    try {
      waiterResult = await waiterPromise;
    } catch (error) {
      failures.push(error);
    }
  }
  if (legacyWaiterPromise !== undefined && legacyWaiterResult === undefined) {
    try {
      legacyWaiterResult = await legacyWaiterPromise;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'browser-session revoke interleaving and cleanup failed');
  }

  if (/40P01|deadlock detected/iu.test(waiterResult.stderr)) {
    throw new Error('browser authentication and session revoke deadlocked');
  }
  if (/40P01|deadlock detected/iu.test(legacyWaiterResult.stderr)) {
    throw new Error('legacy browser-facts authentication and session revoke deadlocked');
  }
  assertRejected(
    waiterResult,
    /browser session verifier or private lifecycle rejected|browser session identity lifecycle or stable Deployment rejected|42501/u,
    'authentication rechecks a committed browser-session revoke after the observed lock wait',
  );
  assertRejected(
    legacyWaiterResult,
    /browser session authentication rejected|browser session lifecycle or bound Deployment facts rejected|42501/u,
    'legacy browser-facts entry rechecks a committed revoke after the observed public lock wait',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|', public_session.status, public_session.session_epoch,
  private_session.status, private_session.session_epoch)
FROM public.browser_sessions AS public_session
JOIN auth.browser_session_auth_index AS private_session
  ON private_session.workspace_id = public_session.workspace_id
 AND private_session.browser_session_id = public_session.id
WHERE public_session.id = '${ids.sessionFence}';`,
    ),
    'REVOKED|1|REVOKED|1',
    'session revoke commits matching public and private lifecycle epochs',
  );
}

async function assertDeploymentRevokeInterleaving(fact) {
  const revokerApplicationName = `g006-deployment-revoker-${process.pid}`;
  const waiterApplicationName = `g006-browser-auth-waiter-${process.pid}`;
  const revoker = openInteractivePsql('ba_migrator_test');
  let committed = false;
  let waiterPromise;
  let waiterResult;
  const failures = [];

  try {
    await revoker.execute(
      `${ownerControlContextPrelude('ba_authorization_owner')}
SELECT set_config('application_name', ${sqlLiteral(revokerApplicationName)}, false);
SELECT app.transition_agent_deployment_security(
  '${ids.deployment}', 1, 'SUSPENDED'
);`,
      'hold stable Deployment revoke transition before commit',
    );

    waiterPromise = harness.psql(
      'ba_runtime_test',
      `SET application_name = ${sqlLiteral(waiterApplicationName)};
${signedBrowserOriginalRunBlock(
  ids.session1,
  ids.principal1,
  material.session1Verifier,
  `  v_result := app.request_run_cancellation(
    jsonb_build_object(
      'workspaceId', '${ids.workspace}',
      'authenticatedPrincipal', jsonb_build_object(
        'schema_version', 'conversation-principal/1',
        'kind', 'end_user',
        'end_user_principal_id', '${ids.principal1}'
      ),
      'browserIdentity', v_browser_identity,
      'idempotencyKey', 'deployment-revoke-interleaving',
      'runId', '${fact.run_id}',
      'requiredScope', 'run:cancel'
    )
  );`,
)}`,
      { allowFailure: true },
    );

    await waitForBlockedActivity(waiterApplicationName, revokerApplicationName);
    await revoker.execute('COMMIT;', 'commit stable Deployment revoke transition');
    committed = true;
    waiterResult = await waiterPromise;
  } catch (error) {
    failures.push(error);
  }

  if (!committed) {
    try {
      await revoker.execute('ROLLBACK;', 'roll back failed Deployment interleaving fixture');
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await revoker.close();
  } catch (error) {
    failures.push(error);
  }
  if (waiterPromise !== undefined && waiterResult === undefined) {
    try {
      waiterResult = await waiterPromise;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Deployment revoke interleaving and cleanup failed');
  }

  assertRejected(
    waiterResult,
    /browser session does not authorize persisted original Run target|42501/u,
    'browser original Run authorization rechecks a committed Deployment revoke after lock wait',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT status FROM public.agent_deployment_security_states
    WHERE agent_deployment_id = '${ids.deployment}'),
  (SELECT revoke_epoch FROM public.agent_deployment_security_states
    WHERE agent_deployment_id = '${ids.deployment}'),
  (SELECT count(*) FROM public.run_events WHERE run_id = '${fact.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${fact.run_id}'),
  (SELECT count(*) FROM public.run_mutation_idempotency
    WHERE idempotency_key = 'deployment-revoke-interleaving')
);`,
    ),
    'SUSPENDED|2|2|2|0',
    'committed Deployment revoke rejects the observed browser lock waiter without partial facts',
  );
}

async function assertLifecycleFencesLeaveRunFactsUntouched(fact) {
  const durableCounts = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT concat_ws('|',
  (SELECT count(*) FROM public.run_events WHERE run_id = '${fact.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${fact.run_id}')
);`,
  );

  await assertBrowserSessionRevokeInterleaving(fact);

  await ownerPsql(
    'ba_authorization_owner',
    `SELECT auth.revoke_end_user_principal(
  '${ids.principal2}', 'exercise principal session-epoch fence'
);`,
  );
  await expectRejected(
    'ba_runtime_other_test',
    browserIdentityBlock(
      ids.principalFenceSession,
      material.principalFenceVerifier,
      namespaceProbeBody(fact),
    ),
    /browser session identity lifecycle or stable Deployment rejected|42501/u,
    'end-user principal epoch/revoke fence',
  );

  await assertDeploymentRevokeInterleaving(fact);

  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.run_events WHERE run_id = '${fact.run_id}'),
  (SELECT count(*) FROM public.outbox WHERE run_id = '${fact.run_id}')
);`,
    ),
    durableCounts,
    'session, principal and Deployment fence failures leave Run Event and Outbox counts unchanged',
  );
}

async function assertNoTemporaryAclOrSecretLogLeak() {
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT count(*)
FROM information_schema.role_routine_grants
WHERE grantee IN ('ba_runtime', 'ba_runtime_test', 'ba_control_executor', 'ba_control_test')
  AND routine_schema = 'app'
  AND routine_name IN ('create_prepared_conversation', 'accept_prepared_agent_chat_run');`,
    ),
    '0',
    'owner-only Agent Chat functions have no executable-role ACL residue',
  );
  const logs = await harness.logs();
  for (const [label, secret] of Object.entries(material)) {
    if (logs.stdout.includes(secret) || logs.stderr.includes(secret)) {
      throw new Error(`${label} fixture material was present in PostgreSQL container logs`);
    }
  }
}

async function main() {
  await harness.start();
  const migrations = await installFreshSchema();
  await seedWorkspaceAndOwnerContext();
  await publishBrowserDeployment();
  await seedBrowserIdentityFacts();
  const primaryFact = await assertOwnerOnlyAgentChatPath();
  const raceWinnerFact = await assertConversationCasRace();
  await promotePointerAwayFromAcceptedRevision();
  await assertBrowserNamespaceReadEventsAndCancel(primaryFact, raceWinnerFact);
  await assertLifecycleFencesLeaveRunFactsUntouched(primaryFact);
  await assertNoTemporaryAclOrSecretLogLeak();

  process.stdout.write(
    `PostgreSQL 16 G0-06 Agent Chat/browser integration passed: ${migrations.length} migrations, migrator SET LOCAL ROLE owner fixtures without temporary grants, atomic Conversation CAS plus zero-credit Run acceptance, two-connection single-winner rollback, same-end-user cross-session idempotency lookup, active-pointer-independent historical read/events/cancel, exact cancellation receipt replay and different-target conflict, wrong-principal invisibility, and observed session/principal/Deployment lock-and-epoch fences with zero failed-write leakage. Disposable database only; no production or cloud state was exercised.\n`,
  );
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
  throw new AggregateError(failures, 'G0-06 Agent Chat/browser harness and cleanup failed');
}
