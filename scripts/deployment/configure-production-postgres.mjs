import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CONTAINER_NAME = 'better-agent-business-postgres';
export const DATABASE_NAME = 'better_agent';
export const ADMIN_USER = 'better_agent_admin';
export const HOST = '127.0.0.1';
export const PORT = '55435';
export const IMAGE =
  'pgvector/pgvector:0.8.1-pg16@sha256:33198da2828a14c30348d2ccb4750833d5ed9a44c88d840a0e523d7417120337';

export const LOGIN_ROLES = Object.freeze([
  ['migrator', 'better_agent_migrator', 'ba_migrator'],
  ['runtime', 'better_agent_runtime', 'ba_runtime'],
  ['control', 'better_agent_control', 'ba_control_executor'],
  ['management-issuer', 'better_agent_management_issuer', 'ba_management_attestation_issuer'],
  ['subject-verifier', 'better_agent_subject_verifier', 'ba_subject_assertion_verifier'],
  ['internal-issuer', 'better_agent_internal_issuer', 'ba_internal_service_attestation_issuer'],
  ['admission', 'better_agent_admission', 'ba_admission_executor'],
  ['execution', 'better_agent_execution', 'ba_execution_executor'],
  ['metering', 'better_agent_metering', 'ba_metering_executor'],
  ['finalizer', 'better_agent_finalizer', 'ba_finalizer_executor'],
  ['reclaimer', 'better_agent_reclaimer', 'ba_reclaimer_executor'],
  ['reconciliation', 'better_agent_reconciliation', 'ba_reconciliation_executor'],
  ['archive-evidence', 'better_agent_archive_evidence', 'ba_archive_evidence_executor'],
  ['retention', 'better_agent_retention', 'ba_retention_executor'],
]);

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..', '..');
const platformRolesPath = path.join(
  repositoryRoot,
  'packages',
  'db',
  'bootstrap',
  'platform-roles.sql',
);
const migrationDirectory = path.join(repositoryRoot, 'packages', 'db', 'migrations');
// Deployment reads this only in the uncached remote entry point; Turbo tasks must not inherit it.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: intentionally excluded from Turbo's environment.
const configuredPrivateRoot = process.env.BETTER_AGENT_POSTGRES_ROOT;
const expectedConfiguredPrivateRoot = path.resolve('/opt/better-agent/shared/postgres');
if (
  configuredPrivateRoot &&
  process.platform !== 'win32' &&
  path.resolve(configuredPrivateRoot) !== expectedConfiguredPrivateRoot
) {
  fail(`BETTER_AGENT_POSTGRES_ROOT must be ${expectedConfiguredPrivateRoot}`);
}
const privateRoot = configuredPrivateRoot
  ? path.resolve(configuredPrivateRoot)
  : path.join(os.homedir(), '.better-agent', 'postgres');
const dataDirectory = path.join(privateRoot, 'data');
const secretsDirectory = path.join(privateRoot, 'secrets');
const environmentDirectory = path.join(privateRoot, 'env');
const expectedMigrationCount = fs
  .readdirSync(migrationDirectory)
  .filter((entry) => /^[0-9]{3}_[a-z0-9_]+\.up\.sql$/u.test(entry)).length;

function fail(message) {
  throw new Error(`business PostgreSQL configuration failed: ${message}`);
}

export function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function docker(arguments_, options = {}) {
  const result = spawnSync('docker', arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  if (result.error) fail(`could not start Docker: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    fail(`docker ${arguments_[0]} exited ${String(result.status)}${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function ensureOrdinaryDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const status = fs.lstatSync(directory);
  if (!status.isDirectory() || status.isSymbolicLink())
    fail(`${directory} must be an ordinary directory`);
}

function ensurePrivateFile(file, createValue, allowRecreate = true) {
  if (fs.existsSync(file)) {
    const status = fs.lstatSync(file);
    if (!status.isFile() || status.isSymbolicLink()) fail(`${file} must be an ordinary file`);
    return fs.readFileSync(file, 'utf8').trim();
  }
  if (!allowRecreate)
    fail(`private credential is missing for initialized data: ${path.basename(file)}`);
  const value = createValue();
  fs.writeFileSync(file, `${value}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return value;
}

function writePrivateEnvironment(file, user, password) {
  const contents = [
    `PGHOST=${HOST}`,
    `PGPORT=${PORT}`,
    `PGDATABASE=${DATABASE_NAME}`,
    `PGUSER=${user}`,
    `PGPASSWORD=${password}`,
    'PGSSLMODE=disable',
    'PGCONNECT_TIMEOUT=5',
    '',
  ].join('\n');
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
}

function hardenPrivateTree() {
  if (process.platform === 'win32') {
    const identityResult = spawnSync('whoami', [], { encoding: 'utf8', shell: false });
    if (identityResult.status !== 0) fail('could not resolve the Windows operator identity');
    const identity = String(identityResult.stdout).trim();
    const aclResult = spawnSync(
      'icacls',
      [
        privateRoot,
        '/inheritance:r',
        '/grant:r',
        `${identity}:(OI)(CI)F`,
        '*S-1-5-18:(OI)(CI)F',
        '*S-1-5-32-544:(OI)(CI)F',
        '/Q',
      ],
      { encoding: 'utf8', shell: false },
    );
    if (aclResult.status !== 0) fail('could not restrict the Windows credential ACL');
    const inheritanceResult = spawnSync(
      'icacls',
      [path.join(privateRoot, '*'), '/inheritance:e', '/T', '/C', '/Q'],
      { encoding: 'utf8', shell: false },
    );
    if (inheritanceResult.status !== 0) fail('could not propagate the restricted Windows ACL');
    return;
  }
  fs.chmodSync(privateRoot, 0o700);
  for (const directory of [dataDirectory, secretsDirectory, environmentDirectory]) {
    fs.chmodSync(directory, 0o700);
  }
  for (const directory of [secretsDirectory, environmentDirectory]) {
    for (const entry of fs.readdirSync(directory)) fs.chmodSync(path.join(directory, entry), 0o600);
  }
}

function assertPrivateRootBoundary() {
  const repositoryRelative = path.relative(repositoryRoot, privateRoot);
  if (
    repositoryRelative === '' ||
    (!path.isAbsolute(repositoryRelative) &&
      !repositoryRelative.startsWith(`..${path.sep}`) &&
      repositoryRelative !== '..')
  ) {
    fail('private PostgreSQL root must remain outside the repository');
  }

  let existingAncestor = privateRoot;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  if (fs.existsSync(existingAncestor)) {
    const resolvedAncestor = fs.realpathSync(existingAncestor);
    if (resolvedAncestor !== path.resolve(existingAncestor)) {
      fail(`private PostgreSQL ancestor must not be a symbolic link: ${existingAncestor}`);
    }
  }
}

function loadOrCreateCredentials() {
  const initialized = fs.existsSync(path.join(dataDirectory, 'PG_VERSION'));
  const credentials = new Map();
  const all = [['admin', ADMIN_USER, null], ...LOGIN_ROLES];
  for (const [key, user] of all) {
    const secretFile = path.join(secretsDirectory, `${key}.password`);
    const password = ensurePrivateFile(
      secretFile,
      () => randomBytes(32).toString('base64url'),
      !initialized,
    );
    if (!/^[A-Za-z0-9_-]{43}$/u.test(password))
      fail(`invalid generated credential shape for ${key}`);
    credentials.set(key, { password, secretFile, user });
    writePrivateEnvironment(path.join(environmentDirectory, `${key}.env`), user, password);
  }
  return credentials;
}

function loadOrCreateProductEnvironment(credentials) {
  const runtime = credentials.get('runtime');
  if (!runtime) fail('runtime credential is required for the product environment');
  const workspaceId = ensurePrivateFile(path.join(secretsDirectory, 'product-workspace-id'), () =>
    randomUUID(),
  );
  const actorId = ensurePrivateFile(path.join(secretsDirectory, 'product-actor-id'), () =>
    randomUUID(),
  );
  const adminPassword = ensurePrivateFile(
    path.join(secretsDirectory, 'product-admin.password'),
    () => randomBytes(24).toString('base64url'),
  );
  const sessionSecret = ensurePrivateFile(
    path.join(secretsDirectory, 'product-session.secret'),
    () => randomBytes(32).toString('base64url'),
  );
  if (
    ![workspaceId, actorId].every((value) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value),
    )
  ) {
    fail('invalid product identity shape');
  }
  const file = path.join(environmentDirectory, 'product.env');
  const contents = [
    `PGHOST=${HOST}`,
    `PGPORT=${PORT}`,
    `PGDATABASE=${DATABASE_NAME}`,
    `PGUSER=${runtime.user}`,
    `PGPASSWORD=${runtime.password}`,
    'PGSSLMODE=disable',
    'PGCONNECT_TIMEOUT=5',
    `BETTER_AGENT_PRODUCT_WORKSPACE_ID=${workspaceId}`,
    `BETTER_AGENT_PRODUCT_ACTOR_ID=${actorId}`,
    `BETTER_AGENT_ADMIN_PASSWORD=${adminPassword}`,
    `BETTER_AGENT_SESSION_SECRET=${sessionSecret}`,
    '',
  ].join('\n');
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return { actorId, workspaceId };
}

export function renderLoginProvisioningSql(credentials) {
  const statements = [];
  for (const [key, login, capability] of LOGIN_ROLES) {
    const credential = credentials.get(key);
    if (!credential) fail(`missing in-memory credential for ${key}`);
    statements.push(
      `DO $provision$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${sqlLiteral(login)}) THEN\n    CREATE ROLE ${login};\n  END IF;\nEND\n$provision$;`,
    );
    statements.push(
      `ALTER ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${sqlLiteral(credential.password)};`,
    );
    statements.push(
      `DO $membership$\nDECLARE inherited_role record;\nBEGIN\n  FOR inherited_role IN SELECT granted.rolname FROM pg_catalog.pg_auth_members membership JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid WHERE member_role.rolname = ${sqlLiteral(login)} LOOP\n    EXECUTE format('REVOKE %I FROM %I', inherited_role.rolname, ${sqlLiteral(login)});\n  END LOOP;\nEND\n$membership$;`,
    );
    statements.push(`GRANT ${capability} TO ${login};`);
  }
  return `${statements.join('\n')}\n`;
}

export function renderDatabaseGrantsSql() {
  const executableCapabilities = LOGIN_ROLES.map(([, , capability]) => capability);
  const managedLogins = LOGIN_ROLES.map(([, login]) => login).join(', ');
  const statements = [
    `REVOKE ALL ON DATABASE ${DATABASE_NAME} FROM PUBLIC;`,
    `REVOKE ALL ON DATABASE ${DATABASE_NAME} FROM ${managedLogins};`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${managedLogins};`,
    `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${managedLogins};`,
    `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${managedLogins};`,
    `REVOKE ALL ON SCHEMA public FROM ${managedLogins};`,
    `GRANT CONNECT ON DATABASE ${DATABASE_NAME} TO ${executableCapabilities.join(', ')};`,
    `GRANT CREATE, TEMPORARY ON DATABASE ${DATABASE_NAME} TO ba_migrator;`,
  ];
  for (const [, login] of LOGIN_ROLES) {
    statements.push(
      `DO $acl$\nDECLARE managed_schema record;\nBEGIN\n  FOR managed_schema IN SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' LOOP\n    EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I', managed_schema.nspname, ${sqlLiteral(login)});\n    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %I', managed_schema.nspname, ${sqlLiteral(login)});\n    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM %I', managed_schema.nspname, ${sqlLiteral(login)});\n    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I FROM %I', managed_schema.nspname, ${sqlLiteral(login)});\n  END LOOP;\nEND\n$acl$;`,
    );
  }
  statements.push(`GRANT USAGE ON SCHEMA public TO ${executableCapabilities.join(', ')};`, '');
  return statements.join('\n');
}

export function renderMigrationLedgerOwnershipSql() {
  return [
    'ALTER SCHEMA better_agent_migrations OWNER TO ba_migrator;',
    'ALTER TABLE better_agent_migrations.schema_migrations OWNER TO ba_migrator;',
    'GRANT ALL ON SCHEMA better_agent_migrations TO ba_migrator;',
    'GRANT ALL ON TABLE better_agent_migrations.schema_migrations TO ba_migrator;',
    'REVOKE ALL ON SCHEMA better_agent_migrations FROM better_agent_migrator;',
    'REVOKE ALL ON TABLE better_agent_migrations.schema_migrations FROM better_agent_migrator;',
    '',
  ].join('\n');
}

export function renderMigrationLedgerPreflightSql() {
  return `DO $ledger_preflight$
BEGIN
  IF pg_catalog.to_regnamespace('better_agent_migrations') IS NOT NULL THEN
    EXECUTE 'ALTER SCHEMA better_agent_migrations OWNER TO ba_migrator';
    EXECUTE 'GRANT ALL ON SCHEMA better_agent_migrations TO ba_migrator';
  END IF;
  IF pg_catalog.to_regclass('better_agent_migrations.schema_migrations') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE better_agent_migrations.schema_migrations OWNER TO ba_migrator';
    EXECUTE 'GRANT ALL ON TABLE better_agent_migrations.schema_migrations TO ba_migrator';
  END IF;
END
$ledger_preflight$;
`;
}

function containerExists() {
  const result = spawnSync('docker', ['inspect', CONTAINER_NAME], {
    encoding: 'utf8',
    shell: false,
  });
  if (result.error) fail(`could not start Docker: ${result.error.message}`);
  if (result.status === 0) return true;
  if (String(result.stderr).toLowerCase().includes('no such object')) return false;
  fail(`docker inspect exited ${String(result.status)}: ${String(result.stderr).trim()}`);
}

function assertExistingContainerShape() {
  const inspected = JSON.parse(docker(['inspect', CONTAINER_NAME]))[0];
  const portBindings = inspected?.HostConfig?.PortBindings;
  const postgresPorts = portBindings?.['5432/tcp'];
  const mounts = inspected?.Mounts ?? [];
  const dataMount = mounts.find((mount) => mount.Destination === '/var/lib/postgresql/data');
  const secretMount = mounts.find(
    (mount) => mount.Destination === '/run/secrets/postgres_admin_password',
  );
  if (inspected?.Config?.Image !== IMAGE) fail('existing container uses an unexpected image');
  if (
    Object.keys(portBindings ?? {}).length !== 1 ||
    !Array.isArray(postgresPorts) ||
    postgresPorts.length !== 1 ||
    postgresPorts[0]?.HostIp !== HOST ||
    postgresPorts[0]?.HostPort !== PORT
  ) {
    fail('existing container uses an unexpected host binding');
  }
  if (path.resolve(String(dataMount?.Source || '')) !== path.resolve(dataDirectory)) {
    fail('existing container uses an unexpected data directory');
  }
  if (
    mounts.length !== 2 ||
    path.resolve(String(secretMount?.Source || '')) !==
      path.resolve(path.join(secretsDirectory, 'admin.password')) ||
    secretMount?.RW !== false ||
    inspected?.HostConfig?.Privileged !== false ||
    inspected?.HostConfig?.NetworkMode !== 'bridge' ||
    (inspected?.HostConfig?.CapAdd ?? []).length !== 0 ||
    !(inspected?.HostConfig?.SecurityOpt ?? []).includes('no-new-privileges:true') ||
    inspected?.HostConfig?.LogConfig?.Type !== 'local' ||
    inspected?.HostConfig?.LogConfig?.Config?.['max-size'] !== '10m' ||
    inspected?.HostConfig?.LogConfig?.Config?.['max-file'] !== '3'
  ) {
    fail('existing container security boundary drifted');
  }
}

function createOrStartContainer(credentials) {
  if (containerExists()) {
    assertExistingContainerShape();
    docker(['start', CONTAINER_NAME]);
    return;
  }
  docker([
    'run',
    '--detach',
    '--name',
    CONTAINER_NAME,
    '--restart',
    'unless-stopped',
    '--security-opt',
    'no-new-privileges:true',
    '--log-driver',
    'local',
    '--log-opt',
    'max-size=10m',
    '--log-opt',
    'max-file=3',
    '--publish',
    `${HOST}:${PORT}:5432`,
    '--mount',
    `type=bind,source=${dataDirectory},target=/var/lib/postgresql/data`,
    '--mount',
    `type=bind,source=${credentials.get('admin').secretFile},target=/run/secrets/postgres_admin_password,readonly`,
    '--env',
    `POSTGRES_DB=${DATABASE_NAME}`,
    '--env',
    `POSTGRES_USER=${ADMIN_USER}`,
    '--env',
    'POSTGRES_PASSWORD_FILE=/run/secrets/postgres_admin_password',
    '--env',
    'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=trust',
    '--health-cmd',
    `pg_isready --dbname=${DATABASE_NAME} --username=${ADMIN_USER}`,
    '--health-interval',
    '2s',
    '--health-timeout',
    '3s',
    '--health-retries',
    '30',
    '--health-start-period',
    '5s',
    IMAGE,
    'postgres',
    '-c',
    'log_parameter_max_length=0',
    '-c',
    'log_parameter_max_length_on_error=0',
    '-c',
    'log_statement=none',
  ]);
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const health = docker(['inspect', '--format', '{{.State.Health.Status}}', CONTAINER_NAME]);
    if (health === 'healthy') {
      const databaseProbe = spawnSync(
        'docker',
        [
          'exec',
          CONTAINER_NAME,
          'psql',
          '--no-psqlrc',
          '--tuples-only',
          '--no-align',
          '--username',
          ADMIN_USER,
          '--dbname',
          DATABASE_NAME,
          '--command',
          'SELECT 1',
        ],
        { encoding: 'utf8', shell: false },
      );
      if (databaseProbe.status === 0 && String(databaseProbe.stdout).trim() === '1') return;
    }
    if (health === 'unhealthy') fail('container healthcheck is unhealthy');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail('container did not become healthy within 60 seconds');
}

function psqlAs(user, sql) {
  return docker(
    [
      'exec',
      '--interactive',
      CONTAINER_NAME,
      'psql',
      '--no-psqlrc',
      '--set=ON_ERROR_STOP=1',
      '--set=VERBOSITY=verbose',
      '--username',
      user,
      '--dbname',
      DATABASE_NAME,
    ],
    { input: sql },
  );
}

function tcpAuthenticationProbe(user, password) {
  return spawnSync(
    'docker',
    [
      'exec',
      '--interactive',
      CONTAINER_NAME,
      'sh',
      '-ceu',
      'IFS= read -r PGPASSWORD; export PGPASSWORD; exec psql --no-psqlrc --tuples-only --no-align --host=127.0.0.1 --username="$1" --dbname="$2" --command="SELECT 1"',
      'business-postgres-auth-probe',
      user,
      DATABASE_NAME,
    ],
    { encoding: 'utf8', input: `${password}\n`, shell: false },
  );
}

function verifyTcpAuthentication(credentials) {
  for (const { password, user } of credentials.values()) {
    const result = tcpAuthenticationProbe(user, password);
    if (result.status !== 0 || String(result.stdout).trim() !== '1') {
      fail(`TCP password authentication failed for ${user}`);
    }
  }
  const rejected = tcpAuthenticationProbe(LOGIN_ROLES[0][1], 'deliberately-wrong-password');
  if (rejected.status === 0) fail('TCP password authentication accepted an invalid credential');
  return credentials.size;
}

async function renderMigrations() {
  const loadModule = await import(
    pathToFileURL(path.join(repositoryRoot, 'packages', 'db', 'dist', 'migrations', 'load.js'))
  );
  const renderModule = await import(
    pathToFileURL(path.join(repositoryRoot, 'packages', 'db', 'dist', 'migrations', 'render.js'))
  );
  const migrations = await loadModule.loadMigrations(migrationDirectory);
  // Individual migrations temporarily assume their object-owner role and then RESET ROLE.
  // Reassert the NOLOGIN migrator owner so the next migration can delegate schema CREATE.
  return renderModule
    .renderUpMigrationSql(migrations)
    .replaceAll('\nRESET ROLE;', '\nRESET ROLE;\nSET LOCAL ROLE ba_migrator;');
}

function verifyProvisioning() {
  const expectedLogins = LOGIN_ROLES.length + 1;
  const managedLogins = LOGIN_ROLES.map(([, login]) => login);
  const expectedMemberships = LOGIN_ROLES.map(
    ([, login, capability]) => `(${sqlLiteral(login)}, ${sqlLiteral(capability)})`,
  ).join(',');
  const managedLoginArray = `ARRAY[${managedLogins.map(sqlLiteral).join(',')}]`;
  const membershipJoin = `FROM pg_catalog.pg_auth_members membership JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member JOIN pg_catalog.pg_roles capability_role ON capability_role.oid = membership.roleid WHERE member_role.rolname = ANY (${managedLoginArray})`;
  const directAclCount = `(SELECT count(*) FROM (SELECT acl.grantee FROM pg_catalog.pg_database object, LATERAL pg_catalog.aclexplode(object.datacl) acl WHERE object.datname = current_database() UNION ALL SELECT acl.grantee FROM pg_catalog.pg_namespace object, LATERAL pg_catalog.aclexplode(object.nspacl) acl UNION ALL SELECT acl.grantee FROM pg_catalog.pg_class object, LATERAL pg_catalog.aclexplode(object.relacl) acl UNION ALL SELECT acl.grantee FROM pg_catalog.pg_attribute object, LATERAL pg_catalog.aclexplode(object.attacl) acl UNION ALL SELECT acl.grantee FROM pg_catalog.pg_proc object, LATERAL pg_catalog.aclexplode(object.proacl) acl) direct_acl JOIN pg_catalog.pg_roles grantee ON grantee.oid = direct_acl.grantee WHERE grantee.rolname = ANY (${managedLoginArray}))`;
  const ownedObjectCount = `(SELECT count(*) FROM (SELECT datdba owner FROM pg_catalog.pg_database WHERE datname = current_database() UNION ALL SELECT nspowner FROM pg_catalog.pg_namespace UNION ALL SELECT relowner FROM pg_catalog.pg_class UNION ALL SELECT proowner FROM pg_catalog.pg_proc UNION ALL SELECT typowner FROM pg_catalog.pg_type) owned JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = owned.owner WHERE owner_role.rolname = ANY (${managedLoginArray}))`;
  const query = `SELECT json_build_object(\n  'server_version', current_setting('server_version'),\n  'vector_version', (SELECT extversion FROM pg_catalog.pg_extension WHERE extname = 'vector'),\n  'pgcrypto_version', (SELECT extversion FROM pg_catalog.pg_extension WHERE extname = 'pgcrypto'),\n  'migration_count', (SELECT count(*) FROM better_agent_migrations.schema_migrations),\n  'login_count', (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname = ANY (ARRAY[${[ADMIN_USER, ...managedLogins].map(sqlLiteral).join(',')}])),\n  'membership_count', (SELECT count(*) ${membershipJoin}),\n  'unexpected_membership_count', (SELECT count(*) ${membershipJoin} AND NOT EXISTS (SELECT 1 FROM (VALUES ${expectedMemberships}) AS expected(login, capability) WHERE expected.login = member_role.rolname AND expected.capability = capability_role.rolname)),\n  'direct_acl_count', ${directAclCount},\n  'owned_object_count', ${ownedObjectCount}\n);`;
  const output = docker([
    'exec',
    CONTAINER_NAME,
    'psql',
    '--no-psqlrc',
    '--tuples-only',
    '--no-align',
    '--username',
    ADMIN_USER,
    '--dbname',
    DATABASE_NAME,
    '--command',
    query,
  ]);
  const result = JSON.parse(output);
  if (!String(result.server_version).startsWith('16.')) fail('PostgreSQL 16 verification failed');
  if (result.vector_version !== '0.8.1') fail('pgvector 0.8.1 verification failed');
  if (!result.pgcrypto_version) fail('pgcrypto verification failed');
  if (Number(result.migration_count) !== expectedMigrationCount) {
    fail(`expected exactly ${String(expectedMigrationCount)} applied migrations`);
  }
  if (Number(result.login_count) !== expectedLogins) fail('login inventory verification failed');
  if (Number(result.membership_count) !== LOGIN_ROLES.length) {
    fail('managed capability membership count verification failed');
  }
  if (Number(result.unexpected_membership_count) !== 0) {
    fail('unexpected managed capability membership detected');
  }
  if (Number(result.direct_acl_count) !== 0) fail('managed login direct ACL detected');
  if (Number(result.owned_object_count) !== 0) fail('managed login object ownership detected');
  return result;
}

async function up() {
  assertPrivateRootBoundary();
  for (const directory of [privateRoot, dataDirectory, secretsDirectory, environmentDirectory]) {
    ensureOrdinaryDirectory(directory);
  }
  const credentials = loadOrCreateCredentials();
  hardenPrivateTree();
  createOrStartContainer(credentials);
  await waitForHealth();
  psqlAs(ADMIN_USER, fs.readFileSync(platformRolesPath, 'utf8'));
  psqlAs(ADMIN_USER, renderLoginProvisioningSql(credentials));
  psqlAs(ADMIN_USER, renderDatabaseGrantsSql());
  psqlAs(ADMIN_USER, renderMigrationLedgerPreflightSql());
  psqlAs('better_agent_migrator', `SET ROLE ba_migrator;\n${await renderMigrations()}`);
  psqlAs(ADMIN_USER, renderMigrationLedgerOwnershipSql());
  const product = loadOrCreateProductEnvironment(credentials);
  psqlAs(
    ADMIN_USER,
    `INSERT INTO public.workspaces (id, name) VALUES (${sqlLiteral(product.workspaceId)}::uuid, '独立工作区') ON CONFLICT (id) DO NOTHING;`,
  );
  hardenPrivateTree();
  const result = verifyProvisioning();
  const authenticatedLoginCount = verifyTcpAuthentication(credentials);
  process.stdout.write(
    `${JSON.stringify({
      configured: true,
      container: CONTAINER_NAME,
      endpoint: `${HOST}:${PORT}`,
      database: DATABASE_NAME,
      dataDirectory,
      environmentDirectory,
      authenticatedLoginCount,
      ...result,
    })}\n`,
  );
}

function status() {
  if (!containerExists()) fail('container is not configured');
  assertExistingContainerShape();
  const result = verifyProvisioning();
  process.stdout.write(
    `${JSON.stringify({ configured: true, container: CONTAINER_NAME, endpoint: `${HOST}:${PORT}`, database: DATABASE_NAME, ...result })}\n`,
  );
}

async function main() {
  const command = process.argv[2] || 'up';
  if (command === 'up') await up();
  else if (command === 'status') status();
  else fail('usage: node configure-business-postgres.mjs [up|status]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
