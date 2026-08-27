import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadMigrations,
  renderDownMigrationSql,
  renderUpMigrationSql,
} from '../../../packages/db/dist/index.js';

import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harnessDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageMigrationDirectory = path.resolve(harnessDirectory, '../../../packages/db/migrations');
const platformRolesFile = path.resolve(
  harnessDirectory,
  '../../../packages/db/bootstrap/platform-roles.sql',
);
const fixtureDirectory = path.join(harnessDirectory, 'fixtures', 'migrations');
const harness = createPostgresHarness('g0-db');
let temporaryMigrationDirectory;

const g005CatalogFingerprintSql = `WITH catalog_lines(line) AS (
  SELECT pg_catalog.format(
    'class|%I.%I|%s|%s|%s|%s|%s|%s',
    namespace_row.nspname,
    relation.relname,
    relation.relkind,
    relation.relowner::regrole::text,
    COALESCE(relation.relacl::text, ''),
    relation.relrowsecurity,
    relation.relforcerowsecurity,
    relation.relreplident
  )
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = relation.relnamespace
  WHERE namespace_row.nspname IN ('app', 'auth', 'public')
  UNION ALL
  SELECT pg_catalog.format(
    'attribute|%I.%I|%s|%s|%s|%s|%s|%s',
    namespace_row.nspname,
    relation.relname,
    attribute.attname,
    attribute.atttypid::regtype::text,
    attribute.attnotnull,
    attribute.attgenerated,
    COALESCE(attribute.attacl::text, ''),
    COALESCE(pg_catalog.pg_get_expr(attribute_default.adbin, attribute_default.adrelid), '')
  )
  FROM pg_catalog.pg_attribute AS attribute
  JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = relation.relnamespace
  LEFT JOIN pg_catalog.pg_attrdef AS attribute_default
    ON attribute_default.adrelid = attribute.attrelid
   AND attribute_default.adnum = attribute.attnum
  WHERE namespace_row.nspname IN ('app', 'auth', 'public')
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
  UNION ALL
  SELECT pg_catalog.format(
    'constraint|%I.%I|%s|%s',
    namespace_row.nspname,
    relation.relname,
    constraint_row.conname,
    pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
  )
  FROM pg_catalog.pg_constraint AS constraint_row
  JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = relation.relnamespace
  WHERE namespace_row.nspname IN ('app', 'auth', 'public')
  UNION ALL
  SELECT pg_catalog.format(
    'policy|%I.%I|%s|%s|%s|%s|%s|%s',
    namespace_row.nspname,
    relation.relname,
    policy.polname,
    policy.polpermissive,
    policy.polcmd,
    policy.polroles::text,
    COALESCE(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), ''),
    COALESCE(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid), '')
  )
  FROM pg_catalog.pg_policy AS policy
  JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = relation.relnamespace
  WHERE namespace_row.nspname IN ('app', 'auth', 'public')
  UNION ALL
  SELECT pg_catalog.format(
    'function|%I.%I(%s)|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
    namespace_row.nspname,
    procedure_row.proname,
    pg_catalog.pg_get_function_identity_arguments(procedure_row.oid),
    procedure_row.proowner::regrole::text,
    COALESCE(procedure_row.proacl::text, ''),
    procedure_row.prosecdef,
    procedure_row.prokind,
    procedure_row.provolatile,
    procedure_row.proparallel,
    procedure_row.proleakproof,
    procedure_row.proisstrict,
    procedure_row.proretset,
    COALESCE(procedure_row.proconfig::text, ''),
    pg_catalog.pg_get_function_result(procedure_row.oid),
    CASE
      WHEN procedure_row.prokind = 'a' THEN ''
      ELSE pg_catalog.pg_get_functiondef(procedure_row.oid)
    END
  )
  FROM pg_catalog.pg_proc AS procedure_row
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = procedure_row.pronamespace
  WHERE namespace_row.nspname IN ('app', 'auth', 'public')
  UNION ALL
  SELECT pg_catalog.format(
    'trigger|%I.%I|%s|%s|%s|%s',
    namespace_row.nspname,
    relation.relname,
    trigger_row.tgname,
    trigger_row.tgenabled,
    trigger_row.tgisinternal,
    pg_catalog.pg_get_triggerdef(trigger_row.oid, true)
  )
  FROM pg_catalog.pg_trigger AS trigger_row
  JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_row.tgrelid
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = relation.relnamespace
  WHERE namespace_row.nspname IN ('app', 'auth', 'public')
  UNION ALL
  SELECT pg_catalog.format(
    'index|%I.%I|%I|%s|%s|%s|%s|%s|%s|%s|%s|%s',
    namespace_row.nspname,
    table_relation.relname,
    index_relation.relname,
    index_row.indisunique,
    index_row.indisprimary,
    index_row.indisexclusion,
    index_row.indisvalid,
    index_row.indisready,
    index_row.indislive,
    index_row.indisclustered,
    index_row.indisreplident,
    pg_catalog.pg_get_indexdef(index_relation.oid)
  )
  FROM pg_catalog.pg_index AS index_row
  JOIN pg_catalog.pg_class AS table_relation ON table_relation.oid = index_row.indrelid
  JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = table_relation.relnamespace
  WHERE namespace_row.nspname IN ('app', 'auth', 'public')
  UNION ALL
  SELECT pg_catalog.format(
    'schema|%I|%s|%s',
    namespace_row.nspname,
    namespace_row.nspowner::regrole::text,
    COALESCE(namespace_row.nspacl::text, '')
  )
  FROM pg_catalog.pg_namespace AS namespace_row
  WHERE namespace_row.nspname IN ('app', 'auth', 'public')
)
SELECT pg_catalog.encode(
  public.digest(
    COALESCE(pg_catalog.string_agg(line, E'\\n' ORDER BY line), ''),
    'sha256'
  ),
  'hex'
)
FROM catalog_lines;`;

const g005CatalogLinesSql = `${g005CatalogFingerprintSql.slice(
  0,
  g005CatalogFingerprintSql.lastIndexOf('\nSELECT pg_catalog.encode('),
)}
SELECT pg_catalog.encode(pg_catalog.convert_to(line, 'UTF8'), 'hex')
FROM catalog_lines
ORDER BY line;`;

function decodeCatalogLines(encodedLines) {
  if (encodedLines === '') return [];
  return encodedLines.split('\n').map((line) => Buffer.from(line, 'hex').toString('utf8'));
}

function catalogLineKey(line) {
  const parts = line.split('|');
  if (parts[0] === 'function') return parts.slice(0, 3).join('|');
  if (parts[0] === 'trigger' || parts[0] === 'index') return parts.slice(0, 4).join('|');
  return line;
}

function describeCatalogDeltas(expectedLines, actualLines) {
  const expectedByKey = new Map(expectedLines.map((line) => [catalogLineKey(line), line]));
  const actualByKey = new Map(actualLines.map((line) => [catalogLineKey(line), line]));
  const keys = new Set([...expectedByKey.keys(), ...actualByKey.keys()]);
  return [...keys]
    .filter((key) => expectedByKey.get(key) !== actualByKey.get(key))
    .slice(0, 12)
    .map((key) => {
      const expected = expectedByKey.get(key);
      const actual = actualByKey.get(key);
      if (expected === undefined) return `added ${key}`;
      if (actual === undefined) return `removed ${key}`;
      let offset = 0;
      while (offset < expected.length && expected[offset] === actual[offset]) offset += 1;
      return `changed ${key} at character ${String(offset)}`;
    })
    .join('; ');
}

function formatVersion(version) {
  return version.toString().padStart(3, '0');
}

async function assertPlatformOwnerMembershipDriftFailsClosed() {
  const platformRolesSql = await readFile(platformRolesFile, 'utf8');
  const ownerRoles = [
    'ba_auth_owner',
    'ba_authorization_owner',
    'ba_run_owner',
    'ba_billing_owner',
    'ba_archive_evidence_owner',
    'ba_retention',
  ];
  const directDriftRole = 'ba_g006_direct_owner_drift_test';
  await harness.psql(
    'ba_bootstrap_test',
    `CREATE ROLE ${directDriftRole}
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
GRANT ${ownerRoles.join(', ')} TO ${directDriftRole};`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT count(*)
FROM pg_catalog.pg_roles AS owner_role
WHERE owner_role.rolname = ANY (ARRAY[${ownerRoles.map((role) => `'${role}'`).join(', ')}]::name[])
  AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = owner_role.oid
      AND membership.member = '${directDriftRole}'::regrole
  );`,
    ),
    '6',
    'direct membership fixture covers every G0-06 owner without an executable role',
  );

  const directRejected = await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;\n${platformRolesSql}\nCOMMIT;`,
    { allowFailure: true },
  );
  assertRejected(
    directRejected,
    /unexpected G0-06 owner membership:/u,
    'platform bootstrap rejects direct owner membership drift with its exact boundary message',
  );
  for (const ownerRole of ownerRoles) {
    if (!directRejected.stderr.includes(`${directDriftRole}->${ownerRole}`)) {
      throw new Error(`direct owner drift message omitted ${ownerRole}`);
    }
  }
  await harness.psql(
    'ba_bootstrap_test',
    `REVOKE ${ownerRoles.join(', ')} FROM ${directDriftRole};
DROP ROLE ${directDriftRole};
${platformRolesSql}`,
  );

  const transitiveDriftRole = 'ba_g006_transitive_owner_overlap_test';
  await harness.psql(
    'ba_bootstrap_test',
    `CREATE ROLE ${transitiveDriftRole}
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
GRANT ba_runtime, ba_migrator TO ${transitiveDriftRole};`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  pg_catalog.pg_has_role('${transitiveDriftRole}', 'ba_runtime', 'MEMBER'),
  (SELECT count(*)
   FROM pg_catalog.pg_roles AS owner_role
   WHERE owner_role.rolname = ANY (ARRAY[${ownerRoles.map((role) => `'${role}'`).join(', ')}]::name[])
     AND pg_catalog.pg_has_role('${transitiveDriftRole}', owner_role.oid, 'MEMBER')),
  (SELECT count(*)
   FROM pg_catalog.pg_auth_members AS membership
   JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = membership.roleid
   WHERE owner_role.rolname = ANY (ARRAY[${ownerRoles.map((role) => `'${role}'`).join(', ')}]::name[])
     AND membership.member = '${transitiveDriftRole}'::regrole)
);`,
    ),
    't|6|0',
    'transitive fixture reaches all owners through ba_migrator with zero direct owner grants',
  );
  const transitiveRejected = await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;\n${platformRolesSql}\nCOMMIT;`,
    { allowFailure: true },
  );
  assertRejected(
    transitiveRejected,
    /non-super LOGIN inherits executable and G0-06 owner capabilities: ba_g006_transitive_owner_overlap_test/u,
    'platform bootstrap rejects transitive executable/owner overlap with its exact boundary message',
  );
  await harness.psql(
    'ba_bootstrap_test',
    `REVOKE ba_runtime, ba_migrator FROM ${transitiveDriftRole};
DROP ROLE ${transitiveDriftRole};
${platformRolesSql}`,
  );
}

async function assertCatalogFingerprintDetectsReplicaIdentityMutation(expectedFingerprint) {
  const mutatedFingerprint = await harness.queryScalar(
    'ba_migrator_test',
    `BEGIN;
SET LOCAL ROLE ba_authorization_owner;
ALTER TABLE public.browser_sessions REPLICA IDENTITY FULL;
RESET ROLE;
${g005CatalogFingerprintSql}
ROLLBACK;`,
  );
  if (mutatedFingerprint === expectedFingerprint) {
    throw new Error('G0-05 catalog fingerprint ignored a replica-identity mutation');
  }
  assertEqual(
    await harness.queryScalar('ba_migrator_test', g005CatalogFingerprintSql),
    expectedFingerprint,
    'replica-identity fingerprint mutation probe rolls back exactly',
  );
}

async function assertG005RollbackSemantics() {
  const workspaceId = 'd0050000-0000-4000-8000-000000000001';
  const principalId = 'd0050000-0000-4000-8000-000000000002';
  const attestationId = 'd0050000-0000-4000-8000-000000000003';
  const immutableResourceId = 'd0050000-0000-4000-8000-000000000004';
  const verifierHex = 'a5'.repeat(32);

  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces (id, name)
VALUES ('${workspaceId}', 'G0-05 rollback semantic probe');
INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES ('${workspaceId}', '${principalId}', 'admin');`,
  );
  await harness.psql(
    'ba_management_issuer_test',
    `SELECT auth.issue_control_session_attestation(
  '${attestationId}',
  '${workspaceId}',
  '${principalId}',
  'ba_control_test',
  'g005-rollback-probe',
  decode('${'b6'.repeat(32)}', 'hex'),
  decode('${verifierHex}', 'hex'),
  clock_timestamp() + interval '5 minutes'
);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_control_test',
      `BEGIN;
DO $g005_auth_probe$
BEGIN
  PERFORM auth.establish_control_workspace_context(
    '${attestationId}', decode('${verifierHex}', 'hex')
  );
END;
$g005_auth_probe$;
SELECT concat_ws('|', app.current_workspace_id(), app.current_authenticated_principal_id());
COMMIT;`,
    ),
    `${workspaceId}|user:${principalId}`,
    '004 down preserves signed control-context authentication semantics',
  );

  const immutableMutation = await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
INSERT INTO public.publishable_resource_roots (
  workspace_id, published_resource_kind, resource_id, created_by
) VALUES (
  '${workspaceId}', 'AGENT_RELEASE', '${immutableResourceId}', 'rollback-probe'
);
UPDATE public.publishable_resource_roots
SET created_by = 'tampered'
WHERE workspace_id = '${workspaceId}'
  AND published_resource_kind = 'AGENT_RELEASE'
  AND resource_id = '${immutableResourceId}';
COMMIT;`,
    { allowFailure: true },
  );
  assertRejected(
    immutableMutation,
    /published and revision facts are immutable|55000/u,
    '004 down preserves G0-05 immutable-fact trigger semantics',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT count(*) FROM public.publishable_resource_roots
WHERE workspace_id = '${workspaceId}'
  AND published_resource_kind = 'AGENT_RELEASE'
  AND resource_id = '${immutableResourceId}';`,
    ),
    '0',
    'failed immutable semantic probe rolls its fixture back',
  );
}

async function materializeMigrationChainWithProbe() {
  temporaryMigrationDirectory = await mkdtemp(
    path.join(tmpdir(), 'better-agent-db-integration-migrations-'),
  );
  const packageFiles = (await readdir(packageMigrationDirectory)).filter((name) =>
    name.endsWith('.sql'),
  );
  await Promise.all(
    packageFiles.map(async (name) => {
      const bytes = await readFile(path.join(packageMigrationDirectory, name));
      await writeFile(path.join(temporaryMigrationDirectory, name), bytes);
    }),
  );

  const productionMigrations = await loadMigrations(temporaryMigrationDirectory);
  const probeVersion = productionMigrations.length;
  const probeId = formatVersion(probeVersion);
  const [probeUp, probeDown] = await Promise.all([
    readFile(path.join(fixtureDirectory, '001_probe.up.sql'), 'utf8'),
    readFile(path.join(fixtureDirectory, '001_probe.down.sql'), 'utf8'),
  ]);
  await Promise.all([
    writeFile(path.join(temporaryMigrationDirectory, `${probeId}_probe.up.sql`), probeUp, 'utf8'),
    writeFile(
      path.join(temporaryMigrationDirectory, `${probeId}_probe.down.sql`),
      probeDown,
      'utf8',
    ),
  ]);
  return {
    migrations: await loadMigrations(temporaryMigrationDirectory),
    probeVersion,
    productionMigrationCount: productionMigrations.length,
  };
}

async function main() {
  const { migrations, probeVersion, productionMigrationCount } =
    await materializeMigrationChainWithProbe();
  const g005Migrations = migrations.slice(0, productionMigrationCount - 1);
  const productionMigrations = migrations.slice(0, productionMigrationCount);
  await harness.start();
  await assertPlatformOwnerMembershipDriftFailsClosed();

  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      "SELECT to_regclass('better_agent_migrations.schema_migrations') IS NULL;",
    ),
    't',
    'fresh migration ledger',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      "SELECT to_regclass('public.migration_probe') IS NULL;",
    ),
    't',
    'fresh probe schema',
  );

  await harness.psql('ba_migrator_test', renderUpMigrationSql(g005Migrations), {
    echoErrors: true,
  });
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT (
  to_regclass('public.agent_deployments') IS NOT NULL
  AND to_regclass('public.runs') IS NULL
);`,
    ),
    't',
    'pre-004 G0-05 catalog baseline',
  );
  const g005CatalogFingerprint = await harness.queryScalar(
    'ba_migrator_test',
    g005CatalogFingerprintSql,
  );
  const g005CatalogLines = decodeCatalogLines(
    await harness.queryScalar('ba_migrator_test', g005CatalogLinesSql),
  );
  await assertCatalogFingerprintDetectsReplicaIdentityMutation(g005CatalogFingerprint);

  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), { echoErrors: true });
  const postgresVersion = await harness.queryScalar('ba_migrator_test', 'SHOW server_version;');
  const pgvectorVersion = await harness.queryScalar(
    'ba_migrator_test',
    "SELECT extversion FROM pg_extension WHERE extname = 'vector';",
  );
  const pgcryptoVersion = await harness.queryScalar(
    'ba_migrator_test',
    "SELECT extversion FROM pg_extension WHERE extname = 'pgcrypto';",
  );
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      "SELECT current_setting('server_version_num')::integer / 10000;",
    ),
    '16',
    'PostgreSQL major version',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      'SELECT count(*) FROM better_agent_migrations.schema_migrations;',
    ),
    String(migrations.length),
    'empty-database migration count',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      'SELECT applied_once FROM public.migration_probe WHERE id = 1;',
    ),
    'first-application',
    'probe fixture',
  );

  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations));
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      'SELECT count(*) FROM better_agent_migrations.schema_migrations;',
    ),
    String(migrations.length),
    'second apply migration count',
  );
  assertEqual(
    await harness.queryScalar('ba_migrator_test', 'SELECT count(*) FROM public.migration_probe;'),
    '1',
    'second apply idempotence',
  );

  await harness.psql(
    'ba_migrator_test',
    `INSERT INTO better_agent_migrations.schema_migrations (version, name, checksum)
VALUES (999, 'unknown_checkout', '${'d'.repeat(64)}');`,
  );
  const unknownVersionResult = await harness.psql(
    'ba_migrator_test',
    renderUpMigrationSql(migrations),
    { allowFailure: true },
  );
  assertRejected(unknownVersionResult, /version unknown to this checkout/u, 'unknown checkout');
  await harness.psql(
    'ba_migrator_test',
    'DELETE FROM better_agent_migrations.schema_migrations WHERE version = 999;',
  );

  await harness.psql(
    'ba_migrator_test',
    'DELETE FROM better_agent_migrations.schema_migrations WHERE version = 0;',
  );
  const ledgerGapResult = await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), {
    allowFailure: true,
  });
  assertRejected(ledgerGapResult, /ledger is not a contiguous prefix/u, 'ledger gap');
  const platformMigration = migrations[0];
  if (platformMigration === undefined) throw new Error('platform migration is missing');
  await harness.psql(
    'ba_migrator_test',
    `INSERT INTO better_agent_migrations.schema_migrations (version, name, checksum, down_checksum)
VALUES (0, '${platformMigration.name}', '${platformMigration.checksum}', NULL);`,
  );

  const tampered = migrations.map((migration) =>
    migration.version === probeVersion
      ? { ...migration, checksum: 'c'.repeat(64), upSql: `${migration.upSql}\n-- tampered` }
      : migration,
  );
  const tamperResult = await harness.psql('ba_migrator_test', renderUpMigrationSql(tampered), {
    allowFailure: true,
  });
  assertRejected(tamperResult, /checksum mismatch/u, 'up checksum tamper');

  const downTampered = migrations.map((migration) =>
    migration.version === probeVersion
      ? {
          ...migration,
          downChecksum: 'e'.repeat(64),
          downSql: `${migration.downSql}\n-- tampered rollback`,
        }
      : migration,
  );
  const downTamperResult = await harness.psql(
    'ba_migrator_test',
    renderDownMigrationSql(downTampered, productionMigrationCount - 1, { allowDown: true }),
    { allowFailure: true },
  );
  assertRejected(downTamperResult, /checksum mismatch/u, 'down checksum tamper');

  await harness.psql(
    'ba_migrator_test',
    renderDownMigrationSql(migrations, productionMigrationCount - 1, { allowDown: true }),
  );
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      "SELECT to_regclass('public.migration_probe') IS NULL;",
    ),
    't',
    'reviewed rollback',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      'SELECT count(*) FROM better_agent_migrations.schema_migrations;',
    ),
    String(productionMigrationCount),
    'rollback ledger',
  );

  await harness.psql(
    'ba_migrator_test',
    renderDownMigrationSql(migrations, productionMigrationCount - 2, { allowDown: true }),
  );
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT (
  to_regclass('public.runs') IS NULL
  AND to_regclass('public.credit_reservations') IS NULL
  AND to_regclass('public.agent_deployments') IS NOT NULL
);`,
    ),
    't',
    'empty G0-06 reviewed rollback preserves the G0-05 catalog',
  );
  const restoredG005CatalogFingerprint = await harness.queryScalar(
    'ba_migrator_test',
    g005CatalogFingerprintSql,
  );
  if (restoredG005CatalogFingerprint !== g005CatalogFingerprint) {
    const restoredCatalogLines = decodeCatalogLines(
      await harness.queryScalar('ba_migrator_test', g005CatalogLinesSql),
    );
    throw new Error(
      `004 down did not restore the exact pre-004 G0-05 catalog: ${describeCatalogDeltas(
        g005CatalogLines,
        restoredCatalogLines,
      )}`,
    );
  }
  await assertG005RollbackSemantics();
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      'SELECT count(*) FROM better_agent_migrations.schema_migrations;',
    ),
    String(productionMigrationCount - 1),
    'G0-06 rollback ledger',
  );

  await harness.psql('ba_migrator_test', renderUpMigrationSql(productionMigrations));
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT (
  to_regclass('public.runs') IS NOT NULL
  AND to_regclass('public.credit_reservations') IS NOT NULL
);`,
    ),
    't',
    'G0-06 reapply restores its catalog',
  );

  await harness.psql(
    'ba_migrator_test',
    renderDownMigrationSql(migrations, 2, { allowDown: true }),
  );
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT (
  to_regclass('public.published_resource_versions') IS NULL
  AND to_regclass('public.agent_deployments') IS NULL
  AND to_regclass('auth.browser_session_auth_index') IS NULL
);`,
    ),
    't',
    'empty G0-05 reviewed rollback removes its catalog',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      'SELECT count(*) FROM better_agent_migrations.schema_migrations;',
    ),
    '3',
    'G0-05 rollback ledger',
  );

  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations));
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT (
  to_regclass('public.published_resource_versions') IS NOT NULL
  AND to_regclass('public.agent_deployments') IS NOT NULL
  AND to_regclass('auth.browser_session_auth_index') IS NOT NULL
);`,
    ),
    't',
    'G0-05 reapply restores its catalog',
  );

  let failedClosed = false;
  try {
    renderDownMigrationSql(migrations, -1, { allowDown: true });
  } catch (error) {
    failedClosed = error instanceof Error && error.message.includes('no reviewed down migration');
  }
  if (!failedClosed)
    throw new Error('platform rollback must fail closed without reviewed down files');

  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations));
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      'SELECT count(*) FROM better_agent_migrations.schema_migrations;',
    ),
    String(migrations.length),
    'reapply after reviewed rollback',
  );

  process.stdout.write(
    `PostgreSQL ${postgresVersion}/pgvector ${pgvectorVersion}/pgcrypto ${pgcryptoVersion} integration passed: ${productionMigrationCount} production migrations plus dynamic probe, idempotence, ledger/checksum guards, reviewed rollback and reapply.\n`,
  );
}

let mainFailure;
try {
  await main();
} catch (error) {
  mainFailure = error;
}

const cleanupResults = await Promise.allSettled([
  harness.stop(),
  temporaryMigrationDirectory === undefined
    ? Promise.resolve()
    : rm(temporaryMigrationDirectory, { force: true, recursive: true }),
]);
const cleanupFailures = cleanupResults.flatMap((result) =>
  result.status === 'rejected' ? [result.reason] : [],
);
const failures = mainFailure === undefined ? cleanupFailures : [mainFailure, ...cleanupFailures];
if (failures.length === 1) throw failures[0];
if (failures.length > 1) throw new AggregateError(failures, 'database harness and cleanup failed');
