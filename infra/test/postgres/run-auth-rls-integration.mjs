import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';

import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harnessDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationDirectory = path.resolve(harnessDirectory, '../../../packages/db/migrations');
const prerequisiteMigration = path.join(migrationDirectory, '000_platform_prerequisites.up.sql');
const harness = createPostgresHarness('g0-auth-rls');

const ids = Object.freeze({
  adminA: '10000000-0000-4000-8000-000000000001',
  adminB: '10000000-0000-4000-8000-000000000002',
  attestationA: '20000000-0000-4000-8000-000000000001',
  issuerConfigA1: '30000000-0000-4000-8000-000000000001',
  publishCredential: '40000000-0000-4000-8000-000000000001',
  publishKey: '50000000-0000-4000-8000-000000000001',
  serviceCredential: '40000000-0000-4000-8000-000000000002',
  serviceKey: '50000000-0000-4000-8000-000000000002',
  rotationOldCredential: '40000000-0000-4000-8000-000000000003',
  rotationOldKey: '50000000-0000-4000-8000-000000000003',
  rotationReplacementCredential: '40000000-0000-4000-8000-000000000004',
  rotationReplacementKey: '50000000-0000-4000-8000-000000000004',
  rotationShortReplacementCredential: '40000000-0000-4000-8000-000000000005',
  rotationShortReplacementKey: '50000000-0000-4000-8000-000000000005',
  rotationGroup: '60000000-0000-4000-8000-000000000001',
  rotationShortGroup: '60000000-0000-4000-8000-000000000002',
  secretRefA1: '70000000-0000-4000-8000-000000000001',
  workspaceA: '80000000-0000-4000-8000-000000000001',
  workspaceB: '80000000-0000-4000-8000-000000000002',
});

const material = Object.freeze({
  attestation: randomBytes(32).toString('hex'),
  issuerSubject: randomBytes(32).toString('hex'),
  publishVerifier: randomBytes(32).toString('hex'),
  serviceVerifier: randomBytes(32).toString('hex'),
  rotationOldVerifier: randomBytes(32).toString('hex'),
  rotationReplacementVerifier: randomBytes(32).toString('hex'),
  rotationShortReplacementVerifier: randomBytes(32).toString('hex'),
});

function bytea(hex) {
  return `decode('${hex}', 'hex')`;
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function controlContextSql(body) {
  return `BEGIN;
SELECT auth.establish_control_workspace_context(
  '${ids.attestationA}',
  ${bytea(material.attestation)}
);
${body}
COMMIT;`;
}

function serviceCredentialSnapshotSql(expectedScopes) {
  const expectedScopeArray = `ARRAY[${expectedScopes.map(sqlLiteral).join(', ')}]::text[]`;
  return `SELECT concat_ws(
  '|',
  (
    authenticated.workspace_id = '${ids.workspaceA}'::uuid
    AND authenticated.credential_id = '${ids.serviceCredential}'::uuid
    AND authenticated.credential_kind = 'service_api'
    AND authenticated.credential_scopes = ${expectedScopeArray}
    AND authenticated.credential_scopes = authoritative.credential_scopes
    AND authenticated.credential_authorization_epoch
      = authoritative.credential_authorization_epoch
    AND authenticated.workspace_authorization_epoch
      = authoritative.workspace_authorization_epoch
  )::text,
  authenticated.credential_authorization_epoch::text,
  authenticated.workspace_authorization_epoch::text
)
FROM auth.authenticate_api_credential(
  '${ids.serviceKey}', ${bytea(material.serviceVerifier)}
) AS authenticated
CROSS JOIN LATERAL (
  SELECT
    ARRAY(
      SELECT scope_row.scope
      FROM public.api_credential_scopes AS scope_row
      WHERE scope_row.workspace_id = credential.workspace_id
        AND scope_row.credential_id = credential.id
        AND scope_row.credential_kind = credential.credential_kind
      ORDER BY scope_row.scope
    ) AS credential_scopes,
    credential.authorization_epoch AS credential_authorization_epoch,
    workspace.authorization_epoch AS workspace_authorization_epoch
  FROM public.api_credentials AS credential
  JOIN public.workspaces AS workspace
    ON workspace.id = credential.workspace_id
  WHERE credential.workspace_id = authenticated.workspace_id
    AND credential.id = authenticated.credential_id
) AS authoritative;`;
}

function parseServiceCredentialSnapshot(value, context) {
  const [matchesAuthority, credentialEpoch, workspaceEpoch, ...unexpected] = value.split('|');
  if (
    unexpected.length > 0 ||
    !/^\d+$/u.test(credentialEpoch ?? '') ||
    !/^\d+$/u.test(workspaceEpoch ?? '')
  ) {
    throw new Error(`${context} returned an invalid snapshot: ${value}`);
  }
  assertEqual(matchesAuthority, 'true', `${context} authoritative equality`);
  return Object.freeze({
    credentialEpoch: BigInt(credentialEpoch),
    workspaceEpoch: BigInt(workspaceEpoch),
  });
}

async function expectDatabaseRejection(role, sql, pattern, context) {
  const result = await harness.psql(role, sql, { allowFailure: true });
  assertRejected(result, pattern, context);
  return result;
}

async function installSchema() {
  const migrations = await loadMigrations(migrationDirectory);
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), {
    echoErrors: true,
  });
  return migrations.length;
}

async function assertCatalogBoundary() {
  const rlsTableCount = await harness.queryScalar(
    'ba_migrator_test',
    `SELECT count(*)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = relation.relnamespace
WHERE relation.relkind = 'r'
  AND relation.relrowsecurity
  AND relation.relforcerowsecurity
  AND (namespace_row.nspname, relation.relname) IN (
    ('public', 'workspaces'),
    ('public', 'role_configs'),
    ('public', 'workspace_members'),
    ('public', 'secret_refs'),
    ('public', 'api_credentials'),
    ('public', 'api_credential_scopes'),
    ('public', 'permission_callbacks'),
    ('public', 'browser_subject_issuer_configs'),
    ('public', 'end_user_principals'),
    ('public', 'browser_subject_assertion_uses'),
    ('public', 'authorization_cache_invalidations'),
    ('auth', 'credential_auth_index'),
    ('auth', 'control_session_attestations'),
    ('auth', 'authorization_audit_events')
  );`,
  );
  assertEqual(rlsTableCount, '14', 'ENABLE/FORCE RLS table count');

  const insecureDefinerCount = await harness.queryScalar(
    'ba_migrator_test',
    `WITH allowed_search_paths(setting_value) AS (
  VALUES
    ('search_path=pg_catalog, app, pg_temp'),
    ('search_path=pg_catalog, auth, app, pg_temp'),
    ('search_path=pg_catalog, auth, pg_temp'),
    ('search_path=pg_catalog, public, app, pg_temp'),
    ('search_path=pg_catalog, public, auth, app, pg_temp'),
    ('search_path=pg_catalog, public, auth, pg_temp')
), reviewed_invoker_triggers(schema_name, function_name) AS (
  VALUES
    ('app', 'protect_run_change'),
    ('app', 'protect_run_event_change')
)
SELECT count(*)
FROM pg_catalog.pg_proc AS procedure_row
JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = procedure_row.pronamespace
WHERE namespace_row.nspname <> 'pg_catalog'
  AND namespace_row.nspname <> 'information_schema'
  AND namespace_row.nspname !~ '^pg_(toast|temp_)'
  AND (
    (
      namespace_row.nspname IN ('app', 'auth')
      AND NOT procedure_row.prosecdef
      AND NOT EXISTS (
        SELECT 1
        FROM reviewed_invoker_triggers AS reviewed
        WHERE reviewed.schema_name = namespace_row.nspname
          AND reviewed.function_name = procedure_row.proname
          AND procedure_row.prorettype = 'trigger'::regtype
      )
    )
    OR (
      (procedure_row.prosecdef OR namespace_row.nspname IN ('app', 'auth'))
      AND (
        procedure_row.proconfig IS NULL
        OR (
          SELECT count(*)
          FROM unnest(procedure_row.proconfig) AS configured(setting_value)
          WHERE configured.setting_value LIKE 'search_path=%'
        ) <> 1
        OR NOT EXISTS (
          SELECT 1
          FROM unnest(procedure_row.proconfig) AS configured(setting_value)
          JOIN allowed_search_paths AS allowed
            ON allowed.setting_value = configured.setting_value
        )
      )
    )
  );`,
  );
  assertEqual(
    insecureDefinerCount,
    '0',
    'non-system SECURITY DEFINER paths and app/auth definer inventory',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `WITH executable_role_names(role_name) AS (
  VALUES
    ('ba_runtime'),
    ('ba_control_executor'),
    ('ba_management_attestation_issuer'),
    ('ba_subject_assertion_verifier')
), attacker_roles(role_oid) AS (
  SELECT role_row.oid
  FROM pg_catalog.pg_roles AS role_row
  JOIN executable_role_names
    ON executable_role_names.role_name = role_row.rolname
  UNION
  SELECT login_role.oid
  FROM pg_catalog.pg_roles AS login_role
  WHERE login_role.rolcanlogin
    AND NOT login_role.rolsuper
    AND (
      NOT pg_catalog.pg_has_role(login_role.oid, 'ba_migrator'::regrole, 'MEMBER')
      OR EXISTS (
        SELECT 1
        FROM executable_role_names
        WHERE pg_catalog.pg_has_role(
          login_role.oid,
          executable_role_names.role_name::regrole,
          'MEMBER'
        )
      )
    )
), definer_schemas(schema_name) AS (
  VALUES ('public'), ('app'), ('auth')
)
SELECT count(*)
FROM attacker_roles
CROSS JOIN definer_schemas
WHERE has_schema_privilege(attacker_roles.role_oid, definer_schemas.schema_name, 'CREATE')
   OR has_database_privilege(
     attacker_roles.role_oid,
     current_database(),
     'TEMPORARY'
   );`,
    ),
    '0',
    'definer schemas are not writable by executable capabilities or application logins',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT (
  (
    SELECT count(*) = 3
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname IN (
        'browser_sessions',
        'agent_deployment_entry_grants',
        'flow_deployment_entry_grants'
      )
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  )
  AND to_regclass('public.service_principals') IS NULL
);`,
    ),
    't',
    'G0-05 typed entry/session facts use FORCE RLS while G0-07 facts remain absent',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT count(*)
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'api_credentials'
  AND column_name IN ('purpose', 'profile', 'deployment_id', 'resource_id');`,
    ),
    '0',
    'credential authority has no floating purpose/profile columns',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT current_setting('log_parameter_max_length') || ':'
  || current_setting('log_parameter_max_length_on_error') || ':'
  || current_setting('log_statement');`,
    ),
    '0:0:none',
    'PostgreSQL parameter logging guard',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT (
  NOT has_schema_privilege('ba_runtime', 'public', 'CREATE')
  AND NOT has_schema_privilege('ba_control_executor', 'public', 'CREATE')
  AND NOT has_schema_privilege('ba_authorization_owner', 'public', 'CREATE')
  AND NOT has_schema_privilege('ba_authorization_owner', 'auth', 'CREATE')
);`,
    ),
    't',
    'temporary ownership grants were revoked',
  );
}

async function seedTenantRoots() {
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces (id, name)
VALUES
  ('${ids.workspaceA}', 'Workspace A'),
  ('${ids.workspaceB}', 'Workspace B');
INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES
  ('${ids.workspaceA}', '${ids.adminA}', 'admin'),
  ('${ids.workspaceB}', '${ids.adminB}', 'admin');`,
  );

  await harness.psql(
    'ba_management_issuer_test',
    `SELECT auth.issue_control_session_attestation(
  '${ids.attestationA}',
  '${ids.workspaceA}',
  '${ids.adminA}',
  'ba_control_test',
  'test-management-idp',
  ${bytea(material.issuerSubject)},
  ${bytea(material.attestation)},
  clock_timestamp() + interval '10 minutes'
);`,
  );
}

async function assertControlBoundary() {
  assertEqual(
    await harness.queryScalar(
      'ba_control_other_test',
      `SELECT auth.establish_control_workspace_context(
  '${ids.attestationA}',
  ${bytea(material.attestation)}
) IS NULL;`,
    ),
    't',
    'control attestation is bound to session_user',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_control_test',
      `SELECT auth.establish_control_workspace_context(
  '${ids.attestationA}',
  ${bytea(randomBytes(32).toString('hex'))}
) IS NULL;`,
    ),
    't',
    'wrong control verifier establishes no context',
  );

  await expectDatabaseRejection(
    'ba_plain_app_test',
    `SELECT auth.establish_control_workspace_context(
  '${ids.attestationA}',
  ${bytea(randomBytes(32).toString('hex'))}
);`,
    /permission denied|42501/u,
    'plain app cannot establish control context',
  );
}

async function createAuthorizationFacts() {
  await harness.psql(
    'ba_control_test',
    controlContextSql(`SELECT auth.create_secret_ref(
  '${ids.secretRefA1}', 'vault', 'better-agent/test/issuer-v1', '1',
  'browser-subject-verification', NULL, '{"classification":"public-key"}'::jsonb
);
SELECT auth.create_api_credential(
  '${ids.publishCredential}', '${ids.publishKey}', 'publish-0001', 'publish',
  ${bytea(material.publishVerifier)},
  ARRAY['browser-session:exchange']::text[],
  ARRAY['https://app.example']::text[],
  NULL, NULL, NULL
);
SELECT auth.create_api_credential(
  '${ids.serviceCredential}', '${ids.serviceKey}', 'service-0002', 'service_api',
  ${bytea(material.serviceVerifier)},
  ARRAY['agent:run:create']::text[], '{}'::text[],
  NULL, NULL, NULL
);
SELECT auth.create_browser_subject_issuer_config(
  '${ids.issuerConfigA1}',
  'https://host.example/identity',
  'better-agent:browser-exchange',
  '${ids.secretRefA1}',
  1,
  ARRAY['https://app.example']::text[],
  300,
  30,
  NULL,
  NULL
);`),
  );

  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT count(*) FROM public.api_credentials WHERE workspace_id = '${ids.workspaceA}';`,
    ),
    '2',
    'controlled credential creation',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT count(*) FROM auth.credential_auth_index WHERE workspace_id = '${ids.workspaceA}';`,
    ),
    '2',
    'private authentication projection parity',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT count(*) > 0 FROM public.authorization_cache_invalidations
WHERE workspace_id = '${ids.workspaceA}';`,
    ),
    't',
    'durable authorization invalidation',
  );
}

async function assertRoleSeparation(prerequisiteSql) {
  await harness.psql(
    'ba_bootstrap_test',
    `CREATE ROLE ba_bad_runtime_verifier_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  IN ROLE ba_runtime, ba_subject_assertion_verifier;
CREATE ROLE ba_bad_issuer_control_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  IN ROLE ba_management_attestation_issuer, ba_control_executor;
CREATE ROLE ba_bad_runtime_migrator_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  IN ROLE ba_runtime, ba_migrator;`,
  );

  await expectDatabaseRejection(
    'ba_migrator_test',
    `BEGIN;
${prerequisiteSql}
ROLLBACK;`,
    /separate login roles|separate login|42501/u,
    'recursive login capability separation prerequisite',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_bad_runtime_verifier_test',
      `SELECT count(*) FROM auth.authenticate_api_credential(
  '${ids.serviceKey}', ${bytea(material.serviceVerifier)}
);`,
    ),
    '0',
    'runtime+verifier composite cannot use generic authenticator',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bad_runtime_verifier_test',
      `SELECT count(*) FROM auth.authenticate_publish_exchange_credential(
  '${ids.publishKey}', ${bytea(material.publishVerifier)}
);`,
    ),
    '0',
    'runtime+verifier composite cannot use verifier authenticator',
  );

  await expectDatabaseRejection(
    'ba_bad_issuer_control_test',
    `SELECT auth.issue_control_session_attestation(
  '20000000-0000-4000-8000-000000000099',
  '${ids.workspaceA}',
  '${ids.adminA}',
  'ba_bad_issuer_control_test',
  'bad-composite',
  ${bytea(randomBytes(32).toString('hex'))},
  ${bytea(randomBytes(32).toString('hex'))},
  clock_timestamp() + interval '5 minutes'
);`,
    /isolated management issuer|42501/u,
    'issuer+control composite cannot mint its own context',
  );
}

async function assertRuntimeAndRlsBoundary() {
  const initialSnapshot = parseServiceCredentialSnapshot(
    await harness.queryScalar(
      'ba_runtime_test',
      serviceCredentialSnapshotSql(['agent:run:create']),
    ),
    'initial credential authentication snapshot',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT visible.safe_count
FROM auth.authenticate_api_credential(
  '${ids.serviceKey}', ${bytea(material.serviceVerifier)}
) AS authenticated
CROSS JOIN LATERAL (
  SELECT count(*)::text AS safe_count
  FROM public.api_credentials AS credential
  WHERE credential.workspace_id = authenticated.workspace_id
) AS visible;`,
    ),
    '2',
    'runtime safe-column read after authentication',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT visible.cross_count
FROM auth.authenticate_api_credential(
  '${ids.serviceKey}', ${bytea(material.serviceVerifier)}
) AS authenticated
CROSS JOIN LATERAL (
  SELECT count(*)::text AS cross_count
  FROM public.workspaces AS workspace_row
  WHERE workspace_row.id = '${ids.workspaceB}'
    AND authenticated.workspace_id = '${ids.workspaceA}'
) AS visible;`,
    ),
    '0',
    'cross-workspace RLS isolation',
  );

  assertEqual(
    await harness.queryScalar('ba_runtime_test', 'SELECT app.current_workspace_id() IS NULL;'),
    't',
    'credential context does not survive transaction end',
  );

  const capturedContext = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT current_setting('app.tenant_context')
FROM auth.authenticate_api_credential(
  '${ids.serviceKey}', ${bytea(material.serviceVerifier)}
);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_other_test',
      `WITH forged AS MATERIALIZED (
  SELECT set_config('app.tenant_context', ${sqlLiteral(capturedContext)}, true)
)
SELECT app.current_workspace_id() IS NULL FROM forged;`,
    ),
    't',
    'signed context cannot cross database sessions',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `WITH forged AS MATERIALIZED (
  SELECT set_config(
    'app.tenant_context',
    'credential:${ids.workspaceB}:${ids.serviceCredential}:0:${'0'.repeat(64)}',
    true
  )
)
SELECT app.current_workspace_id() IS NULL FROM forged;`,
    ),
    't',
    'caller-written tenant GUC is not authoritative',
  );

  await expectDatabaseRejection(
    'ba_runtime_test',
    `BEGIN;
SELECT * FROM auth.authenticate_api_credential(
  '${ids.serviceKey}', ${bytea(material.serviceVerifier)}
);
SELECT * FROM public.api_credentials;
COMMIT;`,
    /permission denied|42501/u,
    'runtime SELECT * cannot expose verifier',
  );
  await expectDatabaseRejection(
    'ba_runtime_test',
    `SELECT secret_verifier_hmac FROM public.api_credentials LIMIT 1;`,
    /permission denied|42501/u,
    'runtime verifier-column read',
  );
  await expectDatabaseRejection(
    'ba_runtime_test',
    'SELECT * FROM auth.credential_auth_index LIMIT 1;',
    /permission denied|42501/u,
    'runtime private auth projection read',
  );
  await expectDatabaseRejection(
    'ba_runtime_test',
    `UPDATE public.api_credentials SET key_hint = 'forbidden' WHERE id = '${ids.serviceCredential}';`,
    /permission denied|42501/u,
    'runtime direct authorization DML',
  );
  await expectDatabaseRejection(
    'ba_runtime_test',
    'CREATE TEMP TABLE api_credentials (id uuid);',
    /permission denied|42501/u,
    'runtime temp-table shadowing',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SET ROLE ba_authorization_owner;
SELECT count(*) FROM public.api_credentials;
RESET ROLE;`,
    ),
    '0',
    'FORCE RLS applies to relation owner',
  );

  await harness.psql(
    'ba_control_test',
    controlContextSql(`SELECT auth.add_api_credential_scope(
  '${ids.serviceCredential}', 'run:read'
);`),
  );
  const advancedSnapshot = parseServiceCredentialSnapshot(
    await harness.queryScalar(
      'ba_runtime_test',
      serviceCredentialSnapshotSql(['agent:run:create', 'run:read']),
    ),
    'scope-mutated credential authentication snapshot',
  );
  assertEqual(
    String(advancedSnapshot.credentialEpoch - initialSnapshot.credentialEpoch),
    '1',
    'scope mutation advances credential authorization epoch exactly once',
  );
  assertEqual(
    String(advancedSnapshot.workspaceEpoch - initialSnapshot.workspaceEpoch),
    '1',
    'scope mutation advances workspace authorization epoch exactly once',
  );
}

async function assertPhysicalSessionTransactionReuse() {
  const result = await harness.psql(
    'ba_runtime_test',
    `SELECT set_config('app.harness_backend_pid', pg_backend_pid()::text, false);
BEGIN;
SELECT * FROM auth.authenticate_api_credential(
  '${ids.serviceKey}', ${bytea(material.serviceVerifier)}
);
SELECT 'commit-authenticated:' || (
  app.current_workspace_id() = '${ids.workspaceA}'::uuid
)::text;
COMMIT;
BEGIN;
SELECT 'commit-cleared:' || (
  current_setting('app.harness_backend_pid', true) = pg_backend_pid()::text
  AND app.current_workspace_id() IS NULL
  AND COALESCE(current_setting('app.tenant_context', true), '') = ''
)::text;
COMMIT;
BEGIN;
SELECT * FROM auth.authenticate_api_credential(
  '${ids.serviceKey}', ${bytea(material.serviceVerifier)}
);
SELECT 'rollback-authenticated:' || (
  app.current_workspace_id() = '${ids.workspaceA}'::uuid
)::text;
ROLLBACK;
BEGIN;
SELECT 'rollback-cleared:' || (
  current_setting('app.harness_backend_pid', true) = pg_backend_pid()::text
  AND app.current_workspace_id() IS NULL
  AND COALESCE(current_setting('app.tenant_context', true), '') = ''
)::text;
COMMIT;`,
    { tuplesOnly: true },
  );
  const observations = new Set(
    result.stdout
      .split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  for (const expected of [
    'commit-authenticated:true',
    'commit-cleared:true',
    'rollback-authenticated:true',
    'rollback-cleared:true',
  ]) {
    if (!observations.has(expected)) {
      throw new Error(
        `same-session transaction-local context check missed ${expected}: ${result.stdout}`,
      );
    }
  }
}

async function assertCredentialLifecycle() {
  await expectDatabaseRejection(
    'ba_control_test',
    controlContextSql(`SELECT auth.add_api_credential_scope(
  '${ids.serviceCredential}', 'browser-session:exchange'
);`),
    /scope|23514/u,
    'closed credential scope vocabulary',
  );

  await harness.psql(
    'ba_control_test',
    controlContextSql(`SELECT auth.create_api_credential(
  '${ids.rotationOldCredential}', '${ids.rotationOldKey}', 'rotation-old', 'service_api',
  ${bytea(material.rotationOldVerifier)},
  ARRAY['run:read']::text[], '{}'::text[],
  NULL, NULL, '${ids.rotationGroup}'
);
SELECT auth.create_api_credential(
  '${ids.rotationReplacementCredential}', '${ids.rotationReplacementKey}', 'rotation-new', 'service_api',
  ${bytea(material.rotationReplacementVerifier)},
  ARRAY['run:read']::text[], '{}'::text[],
  NULL, clock_timestamp() + interval '2 days', '${ids.rotationGroup}'
);
SELECT auth.create_api_credential(
  '${ids.rotationShortReplacementCredential}', '${ids.rotationShortReplacementKey}', 'rotation-short', 'service_api',
  ${bytea(material.rotationShortReplacementVerifier)},
  ARRAY['run:read']::text[], '{}'::text[],
  NULL, clock_timestamp() + interval '20 minutes', '${ids.rotationShortGroup}'
);`),
  );

  await expectDatabaseRejection(
    'ba_control_test',
    controlContextSql(`SELECT auth.transition_api_credential(
  '${ids.rotationOldCredential}',
  'overlap',
  clock_timestamp() + interval '1 hour',
  '${ids.rotationShortGroup}',
  'replacement expires too soon'
);`),
    /replacement.*overlap|23514/u,
    'expired-before-overlap replacement is rejected',
  );

  await harness.psql(
    'ba_control_test',
    controlContextSql(`SELECT auth.transition_api_credential(
  '${ids.rotationOldCredential}',
  'overlap',
  clock_timestamp() + interval '1 hour',
  '${ids.rotationGroup}',
  'normal rotation'
);`),
  );
  await expectDatabaseRejection(
    'ba_control_test',
    controlContextSql(`SELECT auth.transition_api_credential(
  '${ids.rotationOldCredential}',
  'overlap',
  clock_timestamp() + interval '2 hours',
  '${ids.rotationGroup}',
  'attempted extension'
);`),
    /overlap requires an active source|23514/u,
    'overlap cannot be extended',
  );

  await harness.psql(
    'ba_control_test',
    controlContextSql(`SELECT auth.transition_api_credential(
  '${ids.serviceCredential}', 'revoked', NULL, NULL, 'test revocation'
);`),
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT count(*) FROM auth.authenticate_api_credential(
  '${ids.serviceKey}', ${bytea(material.serviceVerifier)}
);`,
    ),
    '0',
    'revoked credential cannot authenticate',
  );
  await expectDatabaseRejection(
    'ba_control_test',
    controlContextSql(`SELECT auth.transition_api_credential(
  '${ids.serviceCredential}', 'active', NULL, NULL, 'forbidden reactivation'
);`),
    /terminal credential cannot transition|target status|23514/u,
    'revoked credential cannot reactivate',
  );
}

async function assertAppendOnlyAndRedaction() {
  await expectDatabaseRejection(
    'ba_bootstrap_test',
    "UPDATE auth.authorization_audit_events SET reason = 'tamper';",
    /append-only|42501/u,
    'authorization audit append-only',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT count(*) = 1
FROM pg_catalog.pg_trigger AS trigger_row
WHERE trigger_row.tgrelid = 'public.browser_subject_assertion_uses'::regclass
  AND trigger_row.tgname = 'browser_subject_assertion_uses_append_only'
  AND NOT trigger_row.tgisinternal
  AND trigger_row.tgenabled <> 'D';`,
    ),
    't',
    'assertion use append-only trigger remains installed behind session exchange',
  );

  const logs = await harness.logs();
  const bearerEquivalentMaterials = {
    attestation: material.attestation,
    publishVerifier: material.publishVerifier,
    rotationOldVerifier: material.rotationOldVerifier,
    rotationReplacementVerifier: material.rotationReplacementVerifier,
    rotationShortReplacementVerifier: material.rotationShortReplacementVerifier,
    serviceVerifier: material.serviceVerifier,
  };
  for (const [label, secret] of Object.entries(bearerEquivalentMaterials)) {
    if (logs.stdout.includes(secret) || logs.stderr.includes(secret)) {
      throw new Error(`${label} material was present in PostgreSQL container logs`);
    }
  }
}

async function main() {
  await harness.start();
  const [migrationCount, prerequisiteSql] = await Promise.all([
    installSchema(),
    import('node:fs/promises').then(({ readFile }) => readFile(prerequisiteMigration, 'utf8')),
  ]);

  await assertCatalogBoundary();
  await seedTenantRoots();
  await assertControlBoundary();
  await createAuthorizationFacts();
  await assertPhysicalSessionTransactionReuse();
  await assertRoleSeparation(prerequisiteSql);
  await assertRuntimeAndRlsBoundary();
  await assertCredentialLifecycle();
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT (
  NOT has_function_privilege(
    'ba_subject_assertion_verifier',
    'auth.consume_browser_subject_assertion(uuid,text,bytea,text,text,integer,bytea,timestamptz,timestamptz)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'ba_subject_assertion_verifier',
    'auth.exchange_browser_subject_assertion_for_session(uuid,bytea,text,text,text,text,timestamptz,uuid,text,bytea,text,integer,bytea,timestamptz,timestamptz)',
    'EXECUTE'
  )
);`,
    ),
    't',
    'subject assertion consumption is sealed behind atomic browser-session exchange',
  );
  await assertAppendOnlyAndRedaction();

  process.stdout.write(
    `PostgreSQL 16 auth/RLS integration passed: ${migrationCount} migrations, role separation, exact definer paths, authoritative credential snapshots, same-session transaction cleanup, FORCE RLS, credential lifecycle, verifier isolation, and assertion consumption sealed behind atomic session exchange.\n`,
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
  throw new AggregateError(failures, 'auth/RLS harness and cleanup failed');
}
