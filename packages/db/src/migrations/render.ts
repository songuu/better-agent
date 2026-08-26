import type { DownMigrationOptions, Migration } from './types.js';
import { validateMigrationSqlBody } from './load.js';

const migrationLockKey = '839192720250826';

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function nullableSqlLiteral(value: string | undefined): string {
  return value === undefined ? 'NULL' : sqlLiteral(value);
}

function assertMigrationMetadata(migration: Migration): void {
  if (migration.id !== migration.version.toString().padStart(3, '0')) {
    throw new Error(
      `migration ${migration.id} does not match numeric version ${migration.version}`,
    );
  }
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(migration.name)) {
    throw new Error(`migration ${migration.id} has an unsafe name`);
  }
  if (!/^[a-f0-9]{64}$/u.test(migration.checksum)) {
    throw new Error(`migration ${migration.id} has an invalid SHA-256 checksum`);
  }
  if ((migration.downSql === undefined) !== (migration.downChecksum === undefined)) {
    throw new Error(`migration ${migration.id} down SQL and checksum must be present together`);
  }
  if (migration.downChecksum !== undefined && !/^[a-f0-9]{64}$/u.test(migration.downChecksum)) {
    throw new Error(`migration ${migration.id} has an invalid down SHA-256 checksum`);
  }
  validateMigrationSqlBody(migration.upSql, `migration ${migration.id} up SQL`);
  if (migration.downSql !== undefined) {
    validateMigrationSqlBody(migration.downSql, `migration ${migration.id} down SQL`);
  }
}

function assertMigrationChain(migrations: readonly Migration[]): void {
  for (const [expectedVersion, migration] of migrations.entries()) {
    assertMigrationMetadata(migration);
    if (migration.version !== expectedVersion) {
      throw new Error(
        `local migration chain must be contiguous: expected ${expectedVersion.toString().padStart(3, '0')}, found ${migration.id}`,
      );
    }
  }
}

function renderBootstrapSql(): string {
  return `DO $ba_postgres_version$
BEGIN
    IF current_setting('server_version_num')::integer < 160000 THEN
        RAISE EXCEPTION USING
            ERRCODE = 'feature_not_supported',
            MESSAGE = 'better-agent migrations require PostgreSQL 16 or newer';
    END IF;
END
$ba_postgres_version$;

CREATE SCHEMA IF NOT EXISTS better_agent_migrations;
REVOKE ALL ON SCHEMA better_agent_migrations FROM PUBLIC;

CREATE TABLE IF NOT EXISTS better_agent_migrations.schema_migrations (
    version integer PRIMARY KEY CHECK (version >= 0),
    name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]*$'),
    checksum character(64) NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
    down_checksum character(64) CHECK (down_checksum IS NULL OR down_checksum ~ '^[a-f0-9]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
REVOKE ALL ON TABLE better_agent_migrations.schema_migrations FROM PUBLIC;
`;
}

function renderChecksumGuard(migration: Migration): string {
  const label = `${migration.id}_${migration.name}`;
  return `DO $ba_guard_${migration.id}$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM better_agent_migrations.schema_migrations
        WHERE version = ${migration.version}
          AND (
              name <> ${sqlLiteral(migration.name)}
              OR checksum <> ${sqlLiteral(migration.checksum)}
              OR down_checksum IS DISTINCT FROM ${nullableSqlLiteral(migration.downChecksum)}
          )
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = 'data_exception',
            MESSAGE = ${sqlLiteral(`schema migration ${migration.id} checksum mismatch`)},
            DETAIL = ${sqlLiteral(`${label} differs from the immutable applied ledger`)};
    END IF;
END
$ba_guard_${migration.id}$;`;
}

function renderLedgerShapeGuard(migrations: readonly Migration[]): string {
  const maximumKnownVersion = migrations.length - 1;
  return `DO $ba_ledger_shape$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM better_agent_migrations.schema_migrations
        WHERE version > ${maximumKnownVersion}
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = 'data_exception',
            MESSAGE = 'database migration ledger contains a version unknown to this checkout';
    END IF;

    IF EXISTS (SELECT 1 FROM better_agent_migrations.schema_migrations)
       AND (
           SELECT min(version) <> 0 OR count(*)::integer <> max(version) + 1
           FROM better_agent_migrations.schema_migrations
       ) THEN
        RAISE EXCEPTION USING
            ERRCODE = 'data_exception',
            MESSAGE = 'database migration ledger is not a contiguous prefix';
    END IF;
END
$ba_ledger_shape$;`;
}

function renderTransactionPrefix(migrations: readonly Migration[]): string {
  return `\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(${migrationLockKey});

${renderBootstrapSql()}
${renderLedgerShapeGuard(migrations)}
`;
}

export function renderUpMigrationSql(migrations: readonly Migration[]): string {
  assertMigrationChain(migrations);
  const blocks = migrations.map((migration) => {
    return `${renderChecksumGuard(migration)}

SELECT NOT EXISTS (
    SELECT 1 FROM better_agent_migrations.schema_migrations WHERE version = ${migration.version}
) AS ba_apply_${migration.id} \\gset
\\if :ba_apply_${migration.id}
${migration.upSql.trimEnd()}

INSERT INTO better_agent_migrations.schema_migrations (version, name, checksum, down_checksum)
VALUES (
    ${migration.version},
    ${sqlLiteral(migration.name)},
    ${sqlLiteral(migration.checksum)},
    ${nullableSqlLiteral(migration.downChecksum)}
);
\\endif`;
  });

  return `${renderTransactionPrefix(migrations)}${blocks.length === 0 ? '' : `\n${blocks.join('\n\n')}`}\nCOMMIT;\n`;
}

export function renderDownMigrationSql(
  migrations: readonly Migration[],
  targetVersion: number,
  options: DownMigrationOptions,
): string {
  if (!options.allowDown) {
    throw new Error('rollback is disabled unless allowDown is explicitly true');
  }
  if (!Number.isSafeInteger(targetVersion) || targetVersion < -1) {
    throw new Error('rollback target must be a safe integer greater than or equal to -1');
  }
  assertMigrationChain(migrations);

  const selected = migrations
    .filter((migration) => migration.version > targetVersion)
    .sort((left, right) => right.version - left.version);
  for (const migration of selected) {
    if (migration.downSql === undefined) {
      throw new Error(`migration ${migration.id}_${migration.name} has no reviewed down migration`);
    }
  }

  const blocks = selected.map(
    (migration) => `${renderChecksumGuard(migration)}

SELECT EXISTS (
    SELECT 1 FROM better_agent_migrations.schema_migrations WHERE version = ${migration.version}
) AS ba_revert_${migration.id} \\gset
\\if :ba_revert_${migration.id}
${migration.downSql?.trimEnd()}

DELETE FROM better_agent_migrations.schema_migrations
WHERE version = ${migration.version};
\\endif`,
  );

  return `${renderTransactionPrefix(migrations)}${blocks.length === 0 ? '' : `\n${blocks.join('\n\n')}`}\nCOMMIT;\n`;
}

export function renderMigrationStatusSql(): string {
  return `\\set ON_ERROR_STOP on
SELECT
    current_setting('server_version_num')::integer AS server_version_num,
    current_setting('server_version') AS server_version,
    EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS pgvector_installed;

SELECT to_regclass('better_agent_migrations.schema_migrations') IS NOT NULL AS ba_has_ledger \\gset
\\if :ba_has_ledger
SELECT version, name, checksum, down_checksum, applied_at
FROM better_agent_migrations.schema_migrations
ORDER BY version;
\\else
SELECT 'migration ledger has not been initialized' AS migration_status;
\\endif
`;
}
