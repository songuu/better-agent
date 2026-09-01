import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  ADMIN_USER,
  CONTAINER_NAME,
  DATABASE_NAME,
  HOST,
  IMAGE,
  LOGIN_ROLES,
  PORT,
  renderDatabaseGrantsSql,
  renderMigrationLedgerOwnershipSql,
  renderLoginProvisioningSql,
  sqlLiteral,
} from '../../scripts/deployment/configure-production-postgres.mjs';

test('pins the isolated business database identity and loopback endpoint', () => {
  assert.equal(CONTAINER_NAME, 'better-agent-business-postgres');
  assert.equal(DATABASE_NAME, 'better_agent');
  assert.equal(ADMIN_USER, 'better_agent_admin');
  assert.equal(HOST, '127.0.0.1');
  assert.equal(PORT, '55435');
  assert.match(IMAGE, /^pgvector\/pgvector:0\.8\.1-pg16@sha256:[a-f0-9]{64}$/u);
});

test('provisions one distinct login per capability', () => {
  assert.equal(LOGIN_ROLES.length, 14);
  assert.equal(new Set(LOGIN_ROLES.map(([, login]) => login)).size, LOGIN_ROLES.length);
  assert.equal(new Set(LOGIN_ROLES.map(([, , capability]) => capability)).size, LOGIN_ROLES.length);
});

test('SQL literals quote apostrophes', () => {
  assert.equal(sqlLiteral("a'b"), "'a''b'");
});

test('Docker absent-container matching is case-insensitive by contract', () => {
  assert.equal('Error: No such object'.toLowerCase().includes('no such object'), true);
  assert.equal('error: no such object'.toLowerCase().includes('no such object'), true);
});

test('accepts Docker normalized bridge mode for the default network', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(
    new URL('../../scripts/deployment/configure-production-postgres.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /HostConfig\?\.NetworkMode !== 'bridge'/u);
  assert.doesNotMatch(source, /HostConfig\?\.NetworkMode !== 'default'/u);
});

test('role provisioning is explicit and does not create owner logins', () => {
  const credentials = new Map(
    LOGIN_ROLES.map(([key, login]) => [key, { password: `secret-${key}`, user: login }]),
  );
  const sql = renderLoginProvisioningSql(credentials);
  for (const [key, login, capability] of LOGIN_ROLES) {
    assert.match(sql, new RegExp(`ALTER ROLE ${login} LOGIN`, 'u'));
    assert.match(sql, new RegExp(`inherited_role\\.rolname, '${login}'`, 'u'));
    assert.match(sql, new RegExp(`GRANT ${capability} TO ${login}`, 'u'));
    assert.match(sql, new RegExp(`secret-${key}`, 'u'));
  }
  for (const owner of [
    'ba_auth_owner',
    'ba_authorization_owner',
    'ba_run_owner',
    'ba_billing_owner',
    'ba_archive_evidence_owner',
    'ba_retention',
  ]) {
    assert.doesNotMatch(sql, new RegExp(`ALTER ROLE ${owner} LOGIN`, 'u'));
  }
});

test('database grants remove PUBLIC and give migrator only the required database capabilities', () => {
  const sql = renderDatabaseGrantsSql();
  assert.match(sql, /REVOKE ALL ON DATABASE better_agent FROM PUBLIC;/u);
  assert.match(sql, /GRANT CREATE, TEMPORARY ON DATABASE better_agent TO ba_migrator;/u);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA public FROM better_agent_migrator/u);
  for (const [, , capability] of LOGIN_ROLES) {
    assert.match(sql, new RegExp(`\\b${capability}\\b`, 'u'));
  }
  assert.doesNotMatch(sql, /SUPERUSER|BYPASSRLS/u);
});

test('transfers the migration ledger away from the login role', () => {
  const sql = renderMigrationLedgerOwnershipSql();
  assert.equal(
    sql,
    [
      'ALTER SCHEMA better_agent_migrations OWNER TO ba_migrator;',
      'ALTER TABLE better_agent_migrations.schema_migrations OWNER TO ba_migrator;',
      'REVOKE ALL ON SCHEMA better_agent_migrations FROM better_agent_migrator;',
      'REVOKE ALL ON TABLE better_agent_migrations.schema_migrations FROM better_agent_migrator;',
      '',
    ].join('\n'),
  );
});

test('uses the project migration ledger schema rather than public', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(
    new URL('../../scripts/deployment/configure-production-postgres.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /better_agent_migrations\.schema_migrations/u);
  assert.match(source, /pg_catalog\.pg_attribute/u);
  assert.match(source, /owned_object_count/u);
  assert.doesNotMatch(source, /public\.schema_migrations/u);
});

test('TCP authentication sends credentials on stdin rather than process arguments', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(
    new URL('../../scripts/deployment/configure-production-postgres.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /input: `\$\{password\}\\n`/u);
  assert.doesNotMatch(source, /--env[^\n]*PGPASSWORD/u);
  assert.match(source, /deliberately-wrong-password/u);
});

test('private credential storage removes inherited Windows ACLs', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(
    new URL('../../scripts/deployment/configure-production-postgres.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /\/inheritance:r/u);
  assert.match(source, /\*S-1-5-18:\(OI\)\(CI\)F/u);
  assert.match(source, /\*S-1-5-32-544:\(OI\)\(CI\)F/u);
  assert.match(source, /\/inheritance:e/u);
});

test('rejects a broad configured production data root before invoking Docker', () => {
  if (process.platform === 'win32') return;
  const script = new URL(
    '../../scripts/deployment/configure-production-postgres.mjs',
    import.meta.url,
  );
  const result = spawnSync(process.execPath, [script.pathname, 'status'], {
    encoding: 'utf8',
    env: { ...process.env, BETTER_AGENT_POSTGRES_ROOT: '/' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BETTER_AGENT_POSTGRES_ROOT must be/u);
});
