import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadMigrations,
  renderDownMigrationSql,
  renderUpMigrationSql,
} from '../../../packages/db/dist/index.js';

import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harnessDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationDirectory = path.resolve(harnessDirectory, '../../../packages/db/migrations');
const harness = createPostgresHarness('g005-release-deployment');

const pausedPublisherSignatures = Object.freeze([
  'app.publish_agent_strategy_release(jsonb)',
  'app.publish_agent_release(jsonb)',
  'app.publish_flow_version(jsonb)',
  'app.publish_experience_release(jsonb)',
  'app.publish_deployment_policy_version(uuid,uuid,text,text,text)',
  'app.publish_agent_deployment_revision(jsonb)',
  'app.publish_flow_deployment_revision(jsonb)',
]);

const ids = Object.freeze({
  admin: '91000000-0000-4000-8000-000000000001',
  attestation: '91000000-0000-4000-8000-000000000002',
  workspace: '91000000-0000-4000-8000-000000000003',
  credential: '91000000-0000-4000-8000-000000000004',
  credentialKey: '91000000-0000-4000-8000-000000000005',
  strategy: '91000000-0000-4000-8000-000000000006',
  strategyDraft: '91000000-0000-4000-8000-000000000007',
  strategyRelease: '91000000-0000-4000-8000-000000000008',
  flow: '91000000-0000-4000-8000-000000000009',
  flowDraft: '91000000-0000-4000-8000-00000000000a',
  flowVersion: '91000000-0000-4000-8000-00000000000b',
  profilePolicy: '91000000-0000-4000-8000-00000000000c',
  profilePolicyVersion: '91000000-0000-4000-8000-00000000000d',
  grantPolicy: '91000000-0000-4000-8000-00000000000e',
  grantPolicyVersion: '91000000-0000-4000-8000-00000000000f',
  scopePolicy: '91000000-0000-4000-8000-000000000010',
  scopePolicyVersion: '91000000-0000-4000-8000-000000000011',
  stagingDeployment: '91000000-0000-4000-8000-000000000012',
  stagingRevision: '91000000-0000-4000-8000-000000000013',
  stagingGrant: '91000000-0000-4000-8000-000000000014',
  productionDeployment: '91000000-0000-4000-8000-000000000015',
  publishCredential: '91000000-0000-4000-8000-000000000016',
  publishCredentialKey: '91000000-0000-4000-8000-000000000017',
  issuerSecretRef: '91000000-0000-4000-8000-000000000018',
  issuerConfig: '91000000-0000-4000-8000-000000000019',
  agent: '91000000-0000-4000-8000-00000000001a',
  agentDraft: '91000000-0000-4000-8000-00000000001b',
  agentRelease: '91000000-0000-4000-8000-00000000001c',
  experience: '91000000-0000-4000-8000-00000000001d',
  experienceDraft: '91000000-0000-4000-8000-00000000001e',
  experienceRelease: '91000000-0000-4000-8000-00000000001f',
  browserDeployment: '91000000-0000-4000-8000-000000000020',
  browserRevision: '91000000-0000-4000-8000-000000000021',
  browserGrant: '91000000-0000-4000-8000-000000000022',
  browserSession: '91000000-0000-4000-8000-000000000023',
  serviceAgentDeployment: '91000000-0000-4000-8000-000000000024',
  serviceAgentRevision: '91000000-0000-4000-8000-000000000025',
  serviceAgentGrant: '91000000-0000-4000-8000-000000000026',
});

const material = Object.freeze({
  attestation: randomBytes(32).toString('hex'),
  assertionNonceHash: randomBytes(32).toString('hex'),
  credentialVerifier: randomBytes(32).toString('hex'),
  issuerSubject: randomBytes(32).toString('hex'),
  publishVerifier: randomBytes(32).toString('hex'),
  sessionVerifierHmac: randomBytes(32).toString('hex'),
  subjectHash: randomBytes(32).toString('hex'),
});

function hash(label) {
  return `sha256:${createHash('sha256').update(label).digest('hex')}`;
}

const hashes = Object.freeze({
  changeSet: hash('g005-flow-change-set'),
  flow: hash('g005-flow-version'),
  flowDraft: hash('g005-flow-draft'),
  flowManifest: hash('g005-flow-manifest'),
  grantPolicy: hash('g005-entry-grant-policy'),
  mapping: hash('g005-empty-mapping'),
  profilePolicy: hash('g005-profile-policy'),
  revision: hash('g005-flow-deployment-revision'),
  revisionManifest: hash('g005-flow-deployment-manifest'),
  scopePolicy: hash('g005-entry-scope-policy'),
  strategy: hash('g005-strategy-release'),
  strategyDraft: hash('g005-strategy-draft'),
  strategyManifest: hash('g005-strategy-manifest'),
  agent: hash('g005-agent-release'),
  agentDraft: hash('g005-agent-draft'),
  agentManifest: hash('g005-agent-manifest'),
  browserChangeSet: hash('g005-browser-change-set'),
  browserRevision: hash('g005-browser-agent-deployment-revision'),
  browserRevisionManifest: hash('g005-browser-agent-deployment-manifest'),
  experience: hash('g005-experience-release'),
  experienceDraft: hash('g005-experience-draft'),
  experienceManifest: hash('g005-experience-manifest'),
  conversationContract: hash('g005-agent-conversation-contract'),
  serviceAgentChangeSet: hash('g005-service-agent-change-set'),
  serviceAgentRevision: hash('g005-service-agent-deployment-revision'),
  serviceAgentRevisionManifest: hash('g005-service-agent-deployment-manifest'),
});

function bytea(hex) {
  return `decode('${hex}', 'hex')`;
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function jsonb(value) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
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

function testOnlyPublisherAclSql(operation) {
  const targetKeyword = operation === 'GRANT' ? 'TO' : 'FROM';
  return `SET ROLE ba_authorization_owner;
${operation} EXECUTE ON FUNCTION ${pausedPublisherSignatures.join(',\n  ')}
  ${targetKeyword} ba_control_executor;
RESET ROLE;`;
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

async function expectRejected(role, sql, pattern, context) {
  const result = await harness.psql(role, sql, { allowFailure: true });
  assertRejected(result, pattern, context);
  return result;
}

async function installSchema() {
  const migrations = await loadMigrations(migrationDirectory);
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), {
    echoErrors: true,
  });
  return migrations;
}

async function assertCatalogAndAclBoundary() {
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `WITH expected(schema_name, table_name, owner_name) AS (
  VALUES
    ('public', 'published_resource_versions', 'ba_authorization_owner'),
    ('public', 'published_resource_dependencies', 'ba_authorization_owner'),
    ('public', 'publishable_resource_roots', 'ba_authorization_owner'),
    ('public', 'publishable_resource_draft_revisions', 'ba_authorization_owner'),
    ('public', 'agent_strategy_releases', 'ba_authorization_owner'),
    ('public', 'agent_releases', 'ba_authorization_owner'),
    ('public', 'flow_versions', 'ba_authorization_owner'),
    ('public', 'experience_releases', 'ba_authorization_owner'),
    ('public', 'deployment_policy_versions', 'ba_authorization_owner'),
    ('public', 'agent_deployments', 'ba_authorization_owner'),
    ('public', 'agent_deployment_revisions', 'ba_authorization_owner'),
    ('public', 'agent_deployment_entry_grants', 'ba_authorization_owner'),
    ('public', 'flow_deployments', 'ba_authorization_owner'),
    ('public', 'flow_deployment_revisions', 'ba_authorization_owner'),
    ('public', 'flow_deployment_entry_grants', 'ba_authorization_owner'),
    ('public', 'browser_sessions', 'ba_authorization_owner'),
    ('auth', 'browser_session_auth_index', 'ba_auth_owner')
)
SELECT count(*)
FROM expected
JOIN pg_catalog.pg_namespace AS namespace_row
  ON namespace_row.nspname = expected.schema_name
JOIN pg_catalog.pg_class AS relation
  ON relation.relnamespace = namespace_row.oid
 AND relation.relname = expected.table_name
JOIN pg_catalog.pg_roles AS owner_role
  ON owner_role.oid = relation.relowner
 AND owner_role.rolname = expected.owner_name
WHERE relation.relkind = 'r'
  AND relation.relrowsecurity
  AND relation.relforcerowsecurity;`,
    ),
    '17',
    'G0-05 table ownership plus ENABLE/FORCE RLS',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `WITH low_roles(role_name) AS (
  VALUES ('ba_runtime'), ('ba_control_executor'), ('ba_subject_assertion_verifier')
), forbidden(privilege_type) AS (
  VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')
)
SELECT count(*)
FROM information_schema.role_table_grants AS grant_row
JOIN low_roles ON low_roles.role_name = grant_row.grantee
JOIN forbidden ON forbidden.privilege_type = grant_row.privilege_type
WHERE grant_row.table_schema IN ('public', 'auth');`,
    ),
    '0',
    'low-capability roles have no direct DML',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT (
  NOT has_function_privilege(
    'ba_control_executor', 'app.publish_agent_strategy_release(jsonb)', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'ba_control_executor', 'app.publish_agent_release(jsonb)', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'ba_control_executor', 'app.publish_flow_version(jsonb)', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'ba_control_executor', 'app.publish_experience_release(jsonb)', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'ba_control_executor',
    'app.publish_deployment_policy_version(uuid,uuid,text,text,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'ba_control_executor', 'app.publish_agent_deployment_revision(jsonb)', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'ba_control_executor', 'app.publish_flow_deployment_revision(jsonb)', 'EXECUTE'
  )
  AND has_function_privilege(
    'ba_control_executor', 'app.promote_flow_deployment(uuid,uuid,bigint,text)', 'EXECUTE'
  )
  AND has_function_privilege(
    'ba_runtime', 'app.resolve_flow_service_admission(text,text)', 'EXECUTE'
  )
  AND has_function_privilege(
    'ba_runtime',
    'auth.authenticate_browser_session_facts(uuid,bytea,text,text,text)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'ba_subject_assertion_verifier',
    'auth.exchange_browser_subject_assertion_for_session(uuid,bytea,text,text,text,text,timestamptz,uuid,text,bytea,text,integer,bytea,timestamptz,timestamptz)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'ba_runtime', 'app.publish_flow_deployment_revision(jsonb)', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'ba_control_executor', 'app.resolve_flow_service_admission(text,text)', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'ba_subject_assertion_verifier',
    'auth.consume_browser_subject_assertion(uuid,text,bytea,text,text,integer,bytea,timestamptz,timestamptz)',
    'EXECUTE'
  )
);`,
    ),
    't',
    'owner-only publisher, admission and browser-exchange ACL',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `WITH executable_roles(role_name) AS (
  VALUES
    ('ba_runtime'),
    ('ba_control_executor'),
    ('ba_management_attestation_issuer'),
    ('ba_subject_assertion_verifier'),
    ('ba_auth_owner')
), paused_functions(signature) AS (
  VALUES
    ('app.publish_agent_strategy_release(jsonb)'),
    ('app.publish_agent_release(jsonb)'),
    ('app.publish_flow_version(jsonb)'),
    ('app.publish_experience_release(jsonb)'),
    ('app.publish_deployment_policy_version(uuid,uuid,text,text,text)'),
    ('app.publish_agent_deployment_revision(jsonb)'),
    ('app.publish_flow_deployment_revision(jsonb)'),
    ('auth.register_prepared_published_resource(jsonb,text,text,text)')
)
SELECT count(*)
FROM executable_roles
CROSS JOIN paused_functions
WHERE has_function_privilege(role_name, signature, 'EXECUTE');`,
    ),
    '0',
    'all executable platform roles are denied paused publisher helpers',
  );
}

async function assertPublisherExecutionPaused() {
  const flowPrepared = flowVersionPrepared();
  await expectRejected(
    'ba_control_test',
    `SELECT app.publish_flow_version(${jsonb(flowPrepared)});`,
    /permission denied.*publish_flow_version|42501/u,
    'control executor cannot self-assert a content hash before publisher attestation exists',
  );
}

async function grantTestOnlyPublishers() {
  await harness.psql('ba_migrator_test', testOnlyPublisherAclSql('GRANT'));
}

async function revokeTestOnlyPublishers() {
  await harness.psql('ba_migrator_test', testOnlyPublisherAclSql('REVOKE'));
  for (const signature of pausedPublisherSignatures) {
    assertEqual(
      await harness.queryScalar(
        'ba_migrator_test',
        `SELECT has_function_privilege(
  'ba_control_executor', ${sqlLiteral(signature)}, 'EXECUTE'
);`,
      ),
      'f',
      `test-only publisher privilege was removed for ${signature}`,
    );
  }
}

async function seedControlAndCredential() {
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces (id, name)
VALUES ('${ids.workspace}', 'G0-05 integration workspace');
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
  'g005-test-management-idp',
  ${bytea(material.issuerSubject)},
  ${bytea(material.attestation)},
  clock_timestamp() + interval '10 minutes'
);`,
  );
  await harness.psql(
    'ba_control_test',
    controlContextSql(`SELECT auth.create_api_credential(
  '${ids.credential}',
  '${ids.credentialKey}',
  'g005-service',
  'service_api',
  ${bytea(material.credentialVerifier)},
  ARRAY['flow:run:create', 'run:read', 'agent:conversation:write']::text[],
  '{}'::text[],
  NULL,
  NULL,
  NULL
);
SELECT auth.create_secret_ref(
  '${ids.issuerSecretRef}',
  'vault',
  'better-agent/g005/browser-issuer',
  '1',
  'browser-subject-verification',
  NULL,
  '{"classification":"public-key"}'::jsonb
);
SELECT auth.create_api_credential(
  '${ids.publishCredential}',
  '${ids.publishCredentialKey}',
  'g005-browser-publish',
  'publish',
  ${bytea(material.publishVerifier)},
  ARRAY['browser-session:exchange']::text[],
  ARRAY['https://app.example']::text[],
  NULL,
  NULL,
  NULL
);
SELECT auth.create_browser_subject_issuer_config(
  '${ids.issuerConfig}',
  'https://host.example/identity',
  'better-agent:browser-exchange',
  '${ids.issuerSecretRef}',
  1,
  ARRAY['https://app.example']::text[],
  300,
  30,
  NULL,
  NULL
);`),
  );
}

async function assertTypedDraftAndRelease() {
  const strategyDocument = {
    contract_hash: hashes.strategy,
    schema_version: 'agent-strategy-release/1',
    source_draft_revision_id: ids.strategyDraft,
    strategy_id: ids.strategy,
    strategy_release_id: ids.strategyRelease,
    workspace_id: ids.workspace,
  };
  const strategyPin = pin(
    'AGENT_STRATEGY_RELEASE',
    ids.strategy,
    ids.strategyRelease,
    hashes.strategy,
  );
  const strategyPrepared = preparedResource({
    document: strategyDocument,
    fullPin: strategyPin,
    manifestHash: hashes.strategyManifest,
  });

  await harness.psql(
    'ba_control_test',
    controlContextSql(`SELECT app.create_publishable_resource_root(
  'AGENT_STRATEGY_RELEASE', '${ids.strategy}'
);
SELECT app.append_publishable_resource_draft_revision(
  '${ids.strategyDraft}',
  'AGENT_STRATEGY_RELEASE',
  '${ids.strategy}',
  1,
  '{"prompt":"reviewed test draft"}'::jsonb,
  '${hashes.strategyDraft}'
);
SELECT app.publish_agent_strategy_release(${jsonb(strategyPrepared)});`),
  );

  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws(':',
  (SELECT count(*) FROM public.publishable_resource_draft_revisions
    WHERE id = '${ids.strategyDraft}'),
  (SELECT count(*) FROM public.agent_strategy_releases
    WHERE id = '${ids.strategyRelease}'),
  (SELECT count(*) FROM public.published_resource_versions
    WHERE resource_version_id = '${ids.strategyRelease}')
);`,
    ),
    '1:1:1',
    'typed Draft to immutable Strategy Release registry path',
  );
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

function policyPin(policyId, policyVersionId, contractHash) {
  return {
    contract_hash: contractHash,
    policy_id: policyId,
    policy_version_id: policyVersionId,
  };
}

function flowDeploymentPrepared() {
  const flowPin = pin('FLOW_VERSION', ids.flow, ids.flowVersion, hashes.flow);
  const revisionPin = pin(
    'DEPLOYMENT_REVISION',
    ids.stagingDeployment,
    ids.stagingRevision,
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
    flow_deployment_id: ids.stagingDeployment,
    flow_deployment_revision_id: ids.stagingRevision,
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

async function publishPoliciesAndFlowDeployment() {
  const flowPrepared = flowVersionPrepared();
  const revisionPrepared = flowDeploymentPrepared();
  const grant = {
    authorization_epoch: 0,
    credential_id: ids.credential,
    credential_kind: 'service_api',
    entry_audience: 'flow_runtime_api',
    entry_grant_id: ids.stagingGrant,
    flow_deployment_id: ids.stagingDeployment,
    ingress_channel: 'service_api',
    principal_mode: 'credential_service_principal',
    schema_version: 'flow-deployment-entry-grant/1',
    scope: 'flow:run:create',
    status: 'ACTIVE',
    target_cardinality: 'exactly_one_flow_deployment',
    workspace_id: ids.workspace,
  };

  await harness.psql(
    'ba_control_test',
    controlContextSql(`SELECT app.create_publishable_resource_root(
  'FLOW_VERSION', '${ids.flow}'
);
SELECT app.append_publishable_resource_draft_revision(
  '${ids.flowDraft}', 'FLOW_VERSION', '${ids.flow}', 1,
  '{"nodes":[],"edges":[]}'::jsonb, '${hashes.flowDraft}'
);
SELECT app.publish_flow_version(${jsonb(flowPrepared)});
SELECT app.publish_deployment_policy_version(
  '${ids.profilePolicyVersion}', '${ids.profilePolicy}',
  'deployment_profile', '${hashes.profilePolicy}', '{"schema_version":"deployment-profile/1"}'
);
SELECT app.publish_deployment_policy_version(
  '${ids.grantPolicyVersion}', '${ids.grantPolicy}',
  'entry_grant', '${hashes.grantPolicy}', '{"schema_version":"entry-grant-policy/1"}'
);
SELECT app.publish_deployment_policy_version(
  '${ids.scopePolicyVersion}', '${ids.scopePolicy}',
  'entry_scope', '${hashes.scopePolicy}', '{"schema_version":"entry-scope-policy/1"}'
);
SELECT app.create_flow_deployment(${jsonb({
      environment: 'staging',
      flow_deployment_id: ids.stagingDeployment,
      flow_id: ids.flow,
      ingress_channel: 'service_api',
      public_selector: 'g005-flow-staging',
      schema_version: 'flow-deployment-stable/1',
      workspace_id: ids.workspace,
    })});
SELECT app.publish_flow_deployment_revision(${jsonb(revisionPrepared)});
SELECT app.promote_flow_deployment(
  '${ids.stagingDeployment}', '${ids.stagingRevision}', 0, 'initial staging activation'
);
SELECT app.transition_flow_deployment_security(
  '${ids.stagingDeployment}', 0, 'ACTIVE'
);
SELECT app.create_flow_deployment_entry_grant(${jsonb(grant)});`),
  );
}

function browserResourceFixtures() {
  const strategyPin = pin(
    'AGENT_STRATEGY_RELEASE',
    ids.strategy,
    ids.strategyRelease,
    hashes.strategy,
  );
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
  const revisionPin = pin(
    'DEPLOYMENT_REVISION',
    ids.browserDeployment,
    ids.browserRevision,
    hashes.browserRevision,
  );
  const revisionDocument = {
    agent_deployment_id: ids.browserDeployment,
    agent_deployment_revision_id: ids.browserRevision,
    agent_id: ids.agent,
    agent_release: agentPin,
    allowed_origins: ['https://app.example'],
    browser_client_channels: ['WEB_SDK'],
    change_set_hash: hashes.browserChangeSet,
    credential_mapping_hash: hashes.mapping,
    credential_mappings: [],
    dependency_manifest_hash: hashes.browserRevisionManifest,
    entry_grant_policy: policyPin(ids.grantPolicy, ids.grantPolicyVersion, hashes.grantPolicy),
    entry_scope_policy: policyPin(ids.scopePolicy, ids.scopePolicyVersion, hashes.scopePolicy),
    environment: 'staging',
    experience_release: experiencePin,
    ingress_channel: 'browser',
    policy_profile: policyPin(ids.profilePolicy, ids.profilePolicyVersion, hashes.profilePolicy),
    revision_contract_hash: hashes.browserRevision,
    schema_version: 'agent-deployment/1',
    session_token_audience: 'agent_browser_api',
    workspace_id: ids.workspace,
  };

  return {
    agentPrepared: preparedResource({
      dependencies: [strategyPin],
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
    revisionPrepared: preparedResource({
      dependencies: [agentPin, experiencePin],
      document: revisionDocument,
      fullPin: revisionPin,
      manifestHash: hashes.browserRevisionManifest,
    }),
  };
}

function serviceAgentDeploymentFixture() {
  const agentPin = pin('AGENT_RELEASE', ids.agent, ids.agentRelease, hashes.agent);
  const experiencePin = pin(
    'EXPERIENCE_RELEASE',
    ids.experience,
    ids.experienceRelease,
    hashes.experience,
  );
  const revisionPin = pin(
    'DEPLOYMENT_REVISION',
    ids.serviceAgentDeployment,
    ids.serviceAgentRevision,
    hashes.serviceAgentRevision,
  );
  const revisionDocument = {
    agent_deployment_id: ids.serviceAgentDeployment,
    agent_deployment_revision_id: ids.serviceAgentRevision,
    agent_id: ids.agent,
    agent_release: agentPin,
    change_set_hash: hashes.serviceAgentChangeSet,
    conversation_contract_hash: hashes.conversationContract,
    credential_mapping_hash: hashes.mapping,
    credential_mappings: [],
    dependency_manifest_hash: hashes.serviceAgentRevisionManifest,
    entry_grant_policy: policyPin(ids.grantPolicy, ids.grantPolicyVersion, hashes.grantPolicy),
    entry_scope_policy: policyPin(ids.scopePolicy, ids.scopePolicyVersion, hashes.scopePolicy),
    environment: 'staging',
    experience_release: experiencePin,
    ingress_channel: 'service_api',
    policy_profile: policyPin(ids.profilePolicy, ids.profilePolicyVersion, hashes.profilePolicy),
    revision_contract_hash: hashes.serviceAgentRevision,
    schema_version: 'agent-deployment/1',
    workspace_id: ids.workspace,
  };
  return preparedResource({
    dependencies: [agentPin, experiencePin],
    document: revisionDocument,
    fullPin: revisionPin,
    manifestHash: hashes.serviceAgentRevisionManifest,
  });
}

async function publishAgentConversationDeploymentAndAssertAdmission() {
  const grant = {
    agent_deployment_id: ids.serviceAgentDeployment,
    authorization_epoch: 0,
    credential_id: ids.credential,
    credential_kind: 'service_api',
    entry_audience: 'agent_runtime_api',
    entry_grant_id: ids.serviceAgentGrant,
    ingress_channel: 'service_api',
    principal_mode: 'credential_service_principal',
    schema_version: 'agent-deployment-entry-grant/1',
    scope: 'agent:conversation:write',
    status: 'ACTIVE',
    target_cardinality: 'exactly_one_agent_deployment',
    workspace_id: ids.workspace,
  };

  await harness.psql(
    'ba_control_test',
    controlContextSql(`SELECT app.create_agent_deployment(${jsonb({
      agent_deployment_id: ids.serviceAgentDeployment,
      agent_id: ids.agent,
      environment: 'staging',
      ingress_channel: 'service_api',
      public_selector: 'g005-agent-conversation',
      schema_version: 'agent-deployment-stable/1',
      workspace_id: ids.workspace,
    })});
SELECT app.publish_agent_deployment_revision(${jsonb(serviceAgentDeploymentFixture())});
SELECT app.promote_agent_deployment(
  '${ids.serviceAgentDeployment}', '${ids.serviceAgentRevision}', 0,
  'activate Agent Conversation fixture'
);
SELECT app.transition_agent_deployment_security(
  '${ids.serviceAgentDeployment}', 0, 'ACTIVE'
);
SELECT app.create_agent_deployment_entry_grant(${jsonb(grant)});`),
  );

  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws(':',
  admission ->> 'schema_version',
  admission ->> 'agent_deployment_id',
  admission ->> 'agent_deployment_revision_id',
  admission ->> 'entry_scope'
)
FROM auth.authenticate_api_credential(
  '${ids.credentialKey}', ${bytea(material.credentialVerifier)}
) AS authenticated
CROSS JOIN LATERAL app.resolve_agent_service_admission(
  CASE
    WHEN authenticated.workspace_id = '${ids.workspace}'::uuid
      THEN 'g005-agent-conversation'
    ELSE NULL
  END,
  'agent:conversation:write'
) AS admission;`,
    ),
    `agent-deployment-entry-admission-facts/1:${ids.serviceAgentDeployment}:${ids.serviceAgentRevision}:agent:conversation:write`,
    'Agent Conversation scope remains identical from credential through typed admission',
  );
}

async function publishBrowserDeploymentAndExchangeSession() {
  const { agentPrepared, experiencePrepared, revisionPrepared } = browserResourceFixtures();
  const grant = {
    agent_deployment_id: ids.browserDeployment,
    authorization_epoch: 0,
    credential_id: ids.publishCredential,
    credential_kind: 'publish',
    entry_audience: 'browser_session_exchange',
    entry_grant_id: ids.browserGrant,
    ingress_channel: 'browser',
    principal_mode: 'issuer_asserted_end_user',
    schema_version: 'agent-deployment-entry-grant/1',
    scope: 'browser-session:exchange',
    status: 'ACTIVE',
    target_cardinality: 'exactly_one_agent_deployment',
    workspace_id: ids.workspace,
  };

  await harness.psql(
    'ba_control_test',
    controlContextSql(`SELECT app.create_publishable_resource_root(
  'AGENT_RELEASE', '${ids.agent}'
);
SELECT app.append_publishable_resource_draft_revision(
  '${ids.agentDraft}', 'AGENT_RELEASE', '${ids.agent}', 1,
  '{"name":"browser agent"}'::jsonb, '${hashes.agentDraft}'
);
SELECT app.publish_agent_release(${jsonb(agentPrepared)});
SELECT app.create_publishable_resource_root(
  'EXPERIENCE_RELEASE', '${ids.experience}'
);
SELECT app.append_publishable_resource_draft_revision(
  '${ids.experienceDraft}', 'EXPERIENCE_RELEASE', '${ids.experience}', 1,
  '{"quick_entries":[]}'::jsonb, '${hashes.experienceDraft}'
);
SELECT app.publish_experience_release(${jsonb(experiencePrepared)});
SELECT app.create_agent_deployment(${jsonb({
      agent_deployment_id: ids.browserDeployment,
      agent_id: ids.agent,
      environment: 'staging',
      ingress_channel: 'browser',
      public_selector: 'g005-browser-agent',
      schema_version: 'agent-deployment-stable/1',
      workspace_id: ids.workspace,
    })});
SELECT app.publish_agent_deployment_revision(${jsonb(revisionPrepared)});
SELECT app.promote_agent_deployment(
  '${ids.browserDeployment}', '${ids.browserRevision}', 0, 'initial browser activation'
);
SELECT app.transition_agent_deployment_security(
  '${ids.browserDeployment}', 0, 'ACTIVE'
);
SELECT app.create_agent_deployment_entry_grant(${jsonb(grant)});`),
  );

  assertEqual(
    await harness.queryScalar(
      'ba_assertion_verifier_test',
      `SELECT exchange.browser_session_id
FROM auth.authenticate_publish_exchange_credential(
  '${ids.publishCredentialKey}', ${bytea(material.publishVerifier)}
) AS authenticated
CROSS JOIN LATERAL auth.exchange_browser_subject_assertion_for_session(
  '${ids.browserSession}',
  ${bytea(material.sessionVerifierHmac)},
  CASE
    WHEN authenticated.workspace_id = '${ids.workspace}'::uuid
      THEN 'g005-browser-agent'
    ELSE NULL
  END,
  'WEB_SDK',
  'https://app.example',
  'agent_browser_api',
  clock_timestamp() + interval '90 seconds',
  '${ids.issuerConfig}',
  'https://host.example/identity',
  ${bytea(material.subjectHash)},
  'better-agent:browser-exchange',
  1,
  ${bytea(material.assertionNonceHash)},
  clock_timestamp() - interval '1 second',
  clock_timestamp() + interval '120 seconds'
) AS exchange;`,
    ),
    ids.browserSession,
    'atomic browser assertion exchange creates a session',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (session_row.status = 'ACTIVE')::text,
  (private_row.status = 'ACTIVE')::text,
  (session_row.session_epoch = private_row.session_epoch)::text,
  (session_row.expires_at = private_row.expires_at)::text,
  (principal.status = 'active')::text,
  (principal.session_epoch = session_row.observed_principal_session_epoch)::text,
  (security.status = 'ACTIVE')::text,
  (security.revoke_epoch = session_row.observed_deployment_revoke_epoch)::text,
  (revision.ingress_channel = 'browser')::text,
  ('https://app.example' = ANY(revision.allowed_origins))::text,
  ('WEB_SDK' = ANY(revision.browser_client_channels))::text,
  (revision.session_token_audience = 'agent_browser_api')::text
)
FROM public.browser_sessions AS session_row
JOIN auth.browser_session_auth_index AS private_row
  ON private_row.workspace_id = session_row.workspace_id
 AND private_row.browser_session_id = session_row.id
JOIN public.end_user_principals AS principal
  ON principal.workspace_id = session_row.workspace_id
 AND principal.id = session_row.principal_id
JOIN public.agent_deployment_security_states AS security
  ON security.workspace_id = session_row.workspace_id
 AND security.agent_deployment_id = session_row.agent_deployment_id
JOIN public.agent_deployment_active_pointers AS pointer
  ON pointer.workspace_id = session_row.workspace_id
 AND pointer.agent_deployment_id = session_row.agent_deployment_id
JOIN public.agent_deployment_revisions AS revision
  ON revision.workspace_id = pointer.workspace_id
 AND revision.agent_deployment_id = pointer.agent_deployment_id
 AND revision.id = pointer.active_revision_id
WHERE session_row.id = '${ids.browserSession}';`,
    ),
    'true|true|true|true|true|true|true|true|true|true|true|true',
    'browser public/private projection and bound epoch parity',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SET ROLE ba_auth_owner;
SELECT concat_ws('|',
  (SELECT count(*) FROM auth.browser_session_auth_index
    WHERE browser_session_id = '${ids.browserSession}'),
  (SELECT count(*) FROM public.browser_sessions
    WHERE id = '${ids.browserSession}'),
  (SELECT count(*) FROM public.end_user_principals),
  (SELECT count(*) FROM public.agent_deployments
    WHERE id = '${ids.browserDeployment}'),
  (SELECT count(*) FROM public.agent_deployment_security_states
    WHERE agent_deployment_id = '${ids.browserDeployment}'),
  (SELECT count(*) FROM public.agent_deployment_active_pointers
    WHERE agent_deployment_id = '${ids.browserDeployment}'),
  (SELECT count(*) FROM public.agent_deployment_revisions
    WHERE id = '${ids.browserRevision}'),
  (SELECT count(*) FROM public.workspaces WHERE id = '${ids.workspace}')
);
RESET ROLE;`,
    ),
    '1|1|1|1|1|1|1|1',
    'auth owner pre-context RLS visibility for browser session authentication',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SET ROLE ba_auth_owner;
SELECT session_row.id
FROM public.browser_sessions AS session_row
JOIN auth.browser_session_auth_index AS private_row
  ON private_row.workspace_id = session_row.workspace_id
 AND private_row.browser_session_id = session_row.id
JOIN public.end_user_principals AS principal
  ON principal.workspace_id = session_row.workspace_id
 AND principal.id = session_row.principal_id
JOIN public.agent_deployments AS deployment
  ON deployment.workspace_id = session_row.workspace_id
 AND deployment.id = session_row.agent_deployment_id
JOIN public.agent_deployment_security_states AS security
  ON security.workspace_id = deployment.workspace_id
 AND security.agent_deployment_id = deployment.id
JOIN public.agent_deployment_active_pointers AS pointer
  ON pointer.workspace_id = deployment.workspace_id
 AND pointer.agent_deployment_id = deployment.id
JOIN public.agent_deployment_revisions AS revision
  ON revision.workspace_id = pointer.workspace_id
 AND revision.id = pointer.active_revision_id
 AND revision.agent_deployment_id = deployment.id
JOIN public.workspaces AS workspace
  ON workspace.id = session_row.workspace_id
WHERE session_row.id = '${ids.browserSession}'
  AND session_row.status = 'ACTIVE'
  AND session_row.session_epoch = private_row.session_epoch
  AND session_row.expires_at = private_row.expires_at
  AND session_row.expires_at > clock_timestamp()
  AND session_row.canonical_origin = 'https://app.example'
  AND session_row.token_audience = 'agent_browser_api'
  AND session_row.client_channel = 'WEB_SDK'
  AND principal.status = 'active'
  AND principal.session_epoch = session_row.observed_principal_session_epoch
  AND security.status = 'ACTIVE'
  AND security.revoke_epoch = session_row.observed_deployment_revoke_epoch
  AND revision.ingress_channel = 'browser'
  AND 'https://app.example' = ANY(revision.allowed_origins)
  AND 'WEB_SDK' = ANY(revision.browser_client_channels)
  AND revision.session_token_audience = 'agent_browser_api';
RESET ROLE;`,
    ),
    ids.browserSession,
    'auth owner can read the exact browser authentication fact set',
  );
}

async function assertBrowserSessionVerifierAndEpochFence() {
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws(':',
  facts ->> 'schema_version',
  facts ->> 'browser_session_id',
  facts ->> 'agent_deployment_id',
  facts ->> 'observed_revoke_epoch'
)
FROM auth.authenticate_browser_session_facts(
  '${ids.browserSession}',
  ${bytea(material.sessionVerifierHmac)},
  'https://app.example',
  'agent_browser_api',
  'WEB_SDK'
) AS facts;`,
    ),
    `agent-deployment-entry-admission-facts/1:${ids.browserSession}:${ids.browserDeployment}:1`,
    'correct browser-session verifier returns closed admission facts',
  );

  await expectRejected(
    'ba_runtime_test',
    `SELECT auth.authenticate_browser_session_facts(
  '${ids.browserSession}',
  ${bytea(randomBytes(32).toString('hex'))},
  'https://app.example',
  'agent_browser_api',
  'WEB_SDK'
);`,
    /browser session authentication rejected|42501/u,
    'wrong browser-session verifier',
  );

  await harness.psql(
    'ba_control_test',
    controlContextSql(`SELECT app.transition_agent_deployment_security(
  '${ids.browserDeployment}', 1, 'SUSPENDED'
);`),
  );
  await expectRejected(
    'ba_runtime_test',
    `SELECT set_config(
  'app.g005_session_verifier_hex',
  '${material.sessionVerifierHmac}',
  false
);
SELECT auth.authenticate_browser_session_facts(
  '${ids.browserSession}',
  decode(current_setting('app.g005_session_verifier_hex'), 'hex'),
  'https://app.example',
  'agent_browser_api',
  'WEB_SDK'
);`,
    /browser session lifecycle or bound Deployment facts rejected|42501/u,
    'browser session deployment revoke-epoch fence',
  );
}

async function assertCasProductionAndAdmission() {
  await expectRejected(
    'ba_control_test',
    controlContextSql(`SELECT app.promote_flow_deployment(
  '${ids.stagingDeployment}', '${ids.stagingRevision}', 0, 'stale CAS'
);`),
    /compare-and-swap failed|40001/u,
    'stale activation epoch CAS',
  );

  await harness.psql(
    'ba_control_test',
    controlContextSql(
      `SELECT app.create_flow_deployment(${jsonb({
        environment: 'production',
        flow_deployment_id: ids.productionDeployment,
        flow_id: ids.flow,
        ingress_channel: 'service_api',
        public_selector: 'g005-flow-production',
        schema_version: 'flow-deployment-stable/1',
        workspace_id: ids.workspace,
      })});`,
    ),
  );
  await expectRejected(
    'ba_control_test',
    controlContextSql(`SELECT app.promote_flow_deployment(
  '${ids.productionDeployment}', '${ids.stagingRevision}', 0, 'must be human gated'
);`),
    /production activation requires|42501/u,
    'production activation fail-closed',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws(':',
  admission ->> 'schema_version',
  admission ->> 'flow_deployment_id',
  admission ->> 'flow_deployment_revision_id',
  admission ->> 'admission_activation_epoch',
  admission ->> 'observed_revoke_epoch'
)
FROM auth.authenticate_api_credential(
  '${ids.credentialKey}', ${bytea(material.credentialVerifier)}
) AS authenticated
CROSS JOIN LATERAL app.resolve_flow_service_admission(
  CASE
    WHEN authenticated.workspace_id = '${ids.workspace}'::uuid
      THEN 'g005-flow-staging'
    ELSE NULL
  END,
  'flow:run:create'
) AS admission;`,
    ),
    `flow-deployment-entry-admission-facts/1:${ids.stagingDeployment}:${ids.stagingRevision}:1:1`,
    'typed service admission returns locked activation/revoke facts',
  );

  await expectRejected(
    'ba_runtime_test',
    `SELECT app.resolve_flow_service_admission('g005-flow-staging', 'flow:run:create');`,
    /isolated runtime credential context|42501/u,
    'admission without authenticated transaction context',
  );

  await harness.psql(
    'ba_runtime_test',
    `DO $run_scope_probe$
BEGIN
  PERFORM admission
  FROM auth.authenticate_api_credential(
  '${ids.credentialKey}', ${bytea(material.credentialVerifier)}
) AS authenticated
CROSS JOIN LATERAL app.resolve_flow_service_admission(
  CASE
    WHEN authenticated.workspace_id = '${ids.workspace}'::uuid
      THEN 'g005-flow-staging'
    ELSE NULL
  END,
  'run:read'
) AS admission;
  RAISE EXCEPTION 'selector-based admission accepted an original-Run scope';
EXCEPTION
  WHEN insufficient_privilege THEN
    IF SQLERRM <> 'Flow service admission requires an isolated runtime credential context' THEN
      RAISE;
    END IF;
END;
$run_scope_probe$;`,
  );

  const revokePromise = harness.psql(
    'ba_control_test',
    controlContextSql(`SELECT app.revoke_flow_deployment_entry_grant(
  '${ids.stagingGrant}', 0
);
SELECT pg_sleep(2);`),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  await harness.psql(
    'ba_runtime_test',
    `DO $revoke_race_probe$
BEGIN
  PERFORM admission
  FROM auth.authenticate_api_credential(
  '${ids.credentialKey}', ${bytea(material.credentialVerifier)}
) AS authenticated
CROSS JOIN LATERAL app.resolve_flow_service_admission(
  CASE
    WHEN authenticated.workspace_id = '${ids.workspace}'::uuid
      THEN 'g005-flow-staging'
    ELSE NULL
  END,
  'flow:run:create'
) AS admission;
  RAISE EXCEPTION 'concurrent grant revoke admitted a stale target';
EXCEPTION
  WHEN insufficient_privilege THEN
    IF SQLERRM <> 'Flow Deployment selector, pointer or security state rejected' THEN
      RAISE;
    END IF;
END;
$revoke_race_probe$;`,
  );
  await revokePromise;
}

async function assertDirectDmlAndRollbackGuard(migrations) {
  await expectRejected(
    'ba_control_test',
    `INSERT INTO public.flow_deployments (
  id, workspace_id, flow_id, public_selector, environment, ingress_channel, created_by
) VALUES (
  public.gen_random_uuid(), '${ids.workspace}', '${ids.flow}', 'raw-bypass',
  'staging', 'service_api', 'attacker'
);`,
    /permission denied|42501/u,
    'control executor cannot bypass kind-specific functions with raw DML',
  );
  await expectRejected(
    'ba_runtime_test',
    `UPDATE public.flow_deployment_security_states
SET status = 'REVOKED'
WHERE flow_deployment_id = '${ids.stagingDeployment}';`,
    /permission denied|42501/u,
    'runtime cannot mutate Deployment security state',
  );
  await expectRejected(
    'ba_migrator_test',
    renderDownMigrationSql(migrations, 2, { allowDown: true }),
    /cannot remove G0-05: .* contains durable facts|55000/u,
    'reviewed down migration refuses non-empty G0-05 facts',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT count(*) FROM better_agent_migrations.schema_migrations WHERE version = 3;`,
    ),
    '1',
    'failed non-empty down keeps the migration ledger',
  );
}

async function assertSecretAndBrowserProjectionBoundary() {
  await expectRejected(
    'ba_runtime_test',
    'SELECT * FROM auth.browser_session_auth_index;',
    /permission denied|42501/u,
    'runtime cannot read private browser session verifier projection',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT count(*)
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'browser_sessions'
  AND column_name ~ '(secret|verifier|token_hash)';`,
    ),
    '0',
    'public browser session facts contain no bearer-equivalent column',
  );

  const logs = await harness.logs();
  for (const [label, secret] of Object.entries(material)) {
    if (logs.stdout.includes(secret) || logs.stderr.includes(secret)) {
      throw new Error(`${label} material was present in PostgreSQL container logs`);
    }
  }
}

async function main() {
  await harness.start();
  const migrations = await installSchema();
  await assertCatalogAndAclBoundary();
  await seedControlAndCredential();
  await assertPublisherExecutionPaused();
  await grantTestOnlyPublishers();
  await assertTypedDraftAndRelease();
  await publishPoliciesAndFlowDeployment();
  await assertCasProductionAndAdmission();
  await publishBrowserDeploymentAndExchangeSession();
  await publishAgentConversationDeploymentAndAssertAdmission();
  await assertBrowserSessionVerifierAndEpochFence();
  await revokeTestOnlyPublishers();
  await assertDirectDmlAndRollbackGuard(migrations);
  await assertSecretAndBrowserProjectionBoundary();

  process.stdout.write(
    `PostgreSQL 16 G0-05 release/deployment integration passed: ${migrations.length} migrations, FORCE RLS/owners, owner-only publishers, explicit executable-role deny, disposable fixture grants, typed Draft to Release, Flow Deployment CAS, production gate, Agent Conversation scope parity, revoke-race-safe typed service admission, target-bound Run-scope denial, atomic browser exchange, verifier/epoch fences, direct-DML denial, non-empty down guard and secret-log boundary.\n`,
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
  throw new AggregateError(failures, 'G0-05 release/deployment harness and cleanup failed');
}
