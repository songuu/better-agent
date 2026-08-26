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
const fixtureDirectory = path.join(harnessDirectory, 'fixtures', 'migrations');
const harness = createPostgresHarness('g0-db');
let temporaryMigrationDirectory;

function formatVersion(version) {
  return version.toString().padStart(3, '0');
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
  await harness.start();

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
