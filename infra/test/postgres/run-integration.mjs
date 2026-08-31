import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadMigrations,
  renderDownMigrationSql,
  renderUpMigrationSql,
} from '../../../packages/db/dist/index.js';
import {
  decodeCatalogLines,
  describeCatalogDeltas,
  g005CatalogFingerprintSql,
  g005CatalogLinesSql,
} from './catalog-fingerprint.mjs';
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

function formatVersion(version) {
  return version.toString().padStart(3, '0');
}

function requireMigration(migrations, id) {
  const matches = migrations.filter((migration) => migration.id === id);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one migration ${id}, found ${String(matches.length)}`);
  }
  return matches[0];
}

function prefixThrough(migrations, id) {
  const target = requireMigration(migrations, id);
  return migrations.slice(0, target.version + 1);
}

function assertMigrationIds(migrations, expectedIds, label) {
  assertEqual(
    migrations.map((migration) => migration.id).join(','),
    expectedIds.join(','),
    `${label} selected migration ids`,
  );
}

function assertG005CatalogFingerprintCoverage() {
  for (const catalogField of [
    'relation.relrowsecurity',
    'relation.relforcerowsecurity',
    'relation.relreplident',
    'policy.polpermissive',
    'index_row.indisclustered',
    'index_row.indisreplident',
  ]) {
    if (!g005CatalogFingerprintSql.includes(catalogField)) {
      throw new Error(`shared G0-05 catalog fingerprint omitted ${catalogField}`);
    }
  }
}

async function assertAppliedMigrationIds(expectedIds, label) {
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT COALESCE(
  pg_catalog.string_agg(pg_catalog.lpad(version::text, 3, '0'), ',' ORDER BY version),
  ''
)
FROM better_agent_migrations.schema_migrations;`,
    ),
    expectedIds.join(','),
    `${label} applied migration ids`,
  );
}

async function readCatalogSnapshot() {
  return {
    fingerprint: await harness.queryScalar('ba_migrator_test', g005CatalogFingerprintSql),
    lines: decodeCatalogLines(await harness.queryScalar('ba_migrator_test', g005CatalogLinesSql)),
  };
}

async function assertCatalogSnapshot(expected, label) {
  const actual = await readCatalogSnapshot();
  if (
    actual.fingerprint === expected.fingerprint &&
    JSON.stringify(actual.lines) === JSON.stringify(expected.lines)
  ) {
    return;
  }
  throw new Error(
    `${label}: fingerprint ${expected.fingerprint} -> ${actual.fingerprint}; ${describeCatalogDeltas(expected.lines, actual.lines)}`,
  );
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

async function assertCatalogFingerprintDetectsInternalRiTriggerStateMutation(expectedFingerprint) {
  const mutatedFingerprint = await harness.queryScalar(
    'ba_bootstrap_test',
    `BEGIN;
DO $probe$
DECLARE
  target_schema name;
  target_relation name;
  target_trigger name;
BEGIN
  SELECT
    namespace_row.nspname,
    relation.relname,
    trigger_row.tgname
  INTO STRICT target_schema, target_relation, target_trigger
  FROM pg_catalog.pg_trigger AS trigger_row
  JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_row.tgrelid
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = relation.relnamespace
  JOIN pg_catalog.pg_constraint AS constraint_row
    ON constraint_row.oid = trigger_row.tgconstraint
  WHERE namespace_row.nspname IN ('app', 'auth', 'public')
    AND trigger_row.tgisinternal
    AND trigger_row.tgenabled <> 'D'
    AND constraint_row.contype = 'f'
  ORDER BY
    namespace_row.nspname,
    relation.relname,
    constraint_row.conname,
    trigger_row.tgtype
  LIMIT 1;

  EXECUTE pg_catalog.format(
    'ALTER TABLE %I.%I DISABLE TRIGGER %I',
    target_schema,
    target_relation,
    target_trigger
  );
END;
$probe$;
${g005CatalogFingerprintSql}
ROLLBACK;`,
  );
  if (mutatedFingerprint === expectedFingerprint) {
    throw new Error('G0-05 catalog fingerprint ignored an internal RI trigger state mutation');
  }
  assertEqual(
    await harness.queryScalar('ba_migrator_test', g005CatalogFingerprintSql),
    expectedFingerprint,
    'internal RI trigger fingerprint mutation probe rolls back exactly',
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
  const through003 = prefixThrough(migrations, '003');
  const through004 = prefixThrough(migrations, '004');
  const through005 = prefixThrough(migrations, '005');
  const probeMigration = requireMigration(migrations, formatVersion(probeVersion));
  assertMigrationIds(through003, ['000', '001', '002', '003'], 'through-003');
  assertMigrationIds(through004, ['000', '001', '002', '003', '004'], 'through-004');
  assertMigrationIds(through005, ['000', '001', '002', '003', '004', '005'], 'through-005');
  assertG005CatalogFingerprintCoverage();
  assertEqual(probeMigration.version, probeVersion, 'dynamic probe migration version');
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

  await harness.psql('ba_migrator_test', renderUpMigrationSql(through003), {
    echoErrors: true,
  });
  await assertAppliedMigrationIds(['000', '001', '002', '003'], 'through-003');
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
  const through003Catalog = await readCatalogSnapshot();
  await assertCatalogFingerprintDetectsReplicaIdentityMutation(through003Catalog.fingerprint);
  await assertCatalogFingerprintDetectsInternalRiTriggerStateMutation(
    through003Catalog.fingerprint,
  );

  await harness.psql('ba_migrator_test', renderUpMigrationSql(through004), {
    echoErrors: true,
  });
  await assertAppliedMigrationIds(['000', '001', '002', '003', '004'], 'through-004');
  const through004Catalog = await readCatalogSnapshot();

  await harness.psql('ba_migrator_test', renderUpMigrationSql(through005), {
    echoErrors: true,
  });
  await assertAppliedMigrationIds(
    ['000', '001', '002', '003', '004', '005'],
    'through-005 initial apply',
  );
  const through005Catalog = await readCatalogSnapshot();

  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), { echoErrors: true });
  await assertAppliedMigrationIds(
    ['000', '001', '002', '003', '004', '005', probeMigration.id],
    'through dynamic probe',
  );
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
    renderDownMigrationSql(downTampered, requireMigration(migrations, '005').version, {
      allowDown: true,
    }),
    { allowFailure: true },
  );
  assertRejected(downTamperResult, /checksum mismatch/u, 'down checksum tamper');

  await harness.psql(
    'ba_migrator_test',
    renderDownMigrationSql(migrations, requireMigration(migrations, '005').version, {
      allowDown: true,
    }),
  );
  await assertAppliedMigrationIds(
    ['000', '001', '002', '003', '004', '005'],
    'reviewed probe rollback',
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
    String(through005.length),
    'rollback ledger',
  );
  await assertCatalogSnapshot(
    through005Catalog,
    'probe rollback did not restore the exact initial through-005 catalog',
  );

  await harness.psql(
    'ba_migrator_test',
    renderDownMigrationSql(migrations, requireMigration(migrations, '004').version, {
      allowDown: true,
    }),
    { echoErrors: true },
  );
  await assertAppliedMigrationIds(['000', '001', '002', '003', '004'], 'reviewed G0-07 rollback');
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SELECT (
  to_regclass('auth.internal_service_attestations') IS NULL
  AND to_regclass('public.run_billing_authority_receipts') IS NULL
  AND to_regclass('public.runs') IS NOT NULL
  AND to_regclass('public.credit_reservations') IS NOT NULL
);`,
    ),
    't',
    'empty G0-07 reviewed rollback preserves the through-004 catalog',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      'SELECT count(*) FROM better_agent_migrations.schema_migrations;',
    ),
    String(through004.length),
    'G0-07 rollback ledger',
  );
  await assertCatalogSnapshot(
    through004Catalog,
    '005 down did not restore the exact initial through-004 catalog',
  );

  await harness.psql(
    'ba_migrator_test',
    renderDownMigrationSql(migrations, requireMigration(migrations, '003').version, {
      allowDown: true,
    }),
    { echoErrors: true },
  );
  await assertAppliedMigrationIds(['000', '001', '002', '003'], 'reviewed G0-06 rollback');
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
  await assertCatalogSnapshot(
    through003Catalog,
    '004 down did not restore the exact pre-004 G0-05 catalog',
  );
  await assertG005RollbackSemantics();
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      'SELECT count(*) FROM better_agent_migrations.schema_migrations;',
    ),
    String(through003.length),
    'G0-06 rollback ledger',
  );

  await harness.psql('ba_migrator_test', renderUpMigrationSql(through005));
  await assertAppliedMigrationIds(
    ['000', '001', '002', '003', '004', '005'],
    'through-005 reapply',
  );
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
  await assertCatalogSnapshot(
    through005Catalog,
    '004+005 reapply did not restore the exact initial through-005 catalog',
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
