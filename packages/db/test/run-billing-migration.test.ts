import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadMigrations, renderDownMigrationSql, renderUpMigrationSql } from '../src/index.js';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = path.resolve(packageDirectory, '..', '..');

const g006OwnerRoles = [
  'ba_auth_owner',
  'ba_authorization_owner',
  'ba_run_owner',
  'ba_billing_owner',
  'ba_archive_evidence_owner',
  'ba_retention',
] as const;

const executableRoles = [
  'ba_runtime',
  'ba_control_executor',
  'ba_management_attestation_issuer',
  'ba_subject_assertion_verifier',
] as const;

function prerequisiteGateWouldPass(sql: string): boolean {
  const prerequisite = sql.match(
    /DO \$g006_platform_prerequisites\$[\s\S]*?\$g006_platform_prerequisites\$;/u,
  );
  if (prerequisite?.index === undefined) return false;

  // Fail closed on every executable prefix, including DO/CALL and future SQL
  // syntax. Before the prerequisite guard, only file comments are legitimate.
  const prefixWithoutComments = sql
    .slice(0, prerequisite.index)
    .replace(/--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\//gu, '');
  return prefixWithoutComments.trim().length === 0;
}

const requiredFactTables = [
  { label: 'Conversation', pattern: /^conversations$/u, owner: 'ba_run_owner' },
  {
    label: 'Conversation message',
    pattern: /^conversation_messages$/u,
    owner: 'ba_run_owner',
  },
  {
    label: 'Conversation state',
    pattern: /^conversation_(?:session_)?states$/u,
    owner: 'ba_run_owner',
  },
  {
    label: 'Run idempotency sentinel',
    pattern: /^run_(?:acceptance_)?idempotency_(?:namespaces|sentinels)$/u,
    owner: 'ba_run_owner',
  },
  {
    label: 'Run acceptance receipt',
    pattern: /^run_(?:acceptance_)?(?:idempotency_)?receipts$/u,
    owner: 'ba_run_owner',
  },
  {
    label: 'Run mutation idempotency',
    pattern: /^run_mutation_idempotenc(?:y|ies)$/u,
    owner: 'ba_run_owner',
  },
  { label: 'Run', pattern: /^runs$/u, owner: 'ba_run_owner' },
  { label: 'Run attempt', pattern: /^run_attempts$/u, owner: 'ba_run_owner' },
  { label: 'Run step', pattern: /^run_steps$/u, owner: 'ba_run_owner' },
  { label: 'Run event', pattern: /^run_events$/u, owner: 'ba_run_owner' },
  { label: 'Run checkpoint', pattern: /^run_checkpoints$/u, owner: 'ba_run_owner' },
  { label: 'Human Gate', pattern: /^human_gates$/u, owner: 'ba_run_owner' },
  { label: 'Outbox', pattern: /^(?:run_)?outbox$/u, owner: 'ba_run_owner' },
  {
    label: 'credit reservation',
    pattern: /^credit_reservations$/u,
    owner: 'ba_billing_owner',
  },
  { label: 'credits ledger', pattern: /^credits_ledger$/u, owner: 'ba_billing_owner' },
  {
    label: 'billing reconciliation',
    pattern: /^run_billing_reconciliations$/u,
    owner: 'ba_billing_owner',
  },
  {
    label: 'archive manifest',
    pattern: /^(?:run_)?archive_manifests$/u,
    owner: 'ba_archive_evidence_owner',
  },
  {
    label: 'archive verification receipt',
    pattern: /^(?:run_)?archive_verification(?:_receipts|s)$/u,
    owner: 'ba_archive_evidence_owner',
  },
  {
    label: 'archive approval receipt',
    pattern: /^(?:run_)?archive_approval(?:_receipts|s)$/u,
    owner: 'ba_archive_evidence_owner',
  },
  {
    label: 'retention purge receipt',
    pattern: /^run_retention_purge_receipts$/u,
    owner: 'ba_retention',
  },
] as const;

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function createdTableNames(sql: string): string[] {
  return [
    ...sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+public\.([a-z][a-z0-9_]*)\s*\(/giu),
  ].map((match) => match[1] ?? '');
}

function createdFunctionNames(sql: string): string[] {
  return [...sql.matchAll(/CREATE FUNCTION\s+(?:app|auth)\.([a-z][a-z0-9_]*)\s*\(/giu)].map(
    (match) => match[1] ?? '',
  );
}

function requireFunctionDefinition(sql: string, schema: 'app' | 'auth', name: string): string {
  const definition = sql.match(
    new RegExp(
      `CREATE(?: OR REPLACE)? FUNCTION ${schema}\\.${escapeRegularExpression(name)}\\([\\s\\S]*?\\$function\\$;`,
      'u',
    ),
  )?.[0];
  expect(definition, `${schema}.${name} must have an inspectable definition`).toBeDefined();
  return definition ?? '';
}

function functionBody(definition: string): string {
  const body = definition.match(/RETURNS[\s\S]*?\$function\$;/u)?.[0];
  expect(body, 'function must expose an inspectable canonical body').toBeDefined();
  return body ?? '';
}

function requireMatchingName(names: string[], label: string, pattern: RegExp): string {
  const name = names.find((candidate) => pattern.test(candidate));
  expect(name, `004 must create the ${label} fact`).toBeDefined();
  return name ?? '';
}

function expectTableBoundary(sql: string, tableName: string, owner: string): void {
  const escapedTableName = escapeRegularExpression(tableName);
  const tableBody = sql.match(
    new RegExp(
      `CREATE TABLE(?: IF NOT EXISTS)?\\s+public\\.${escapedTableName}\\s*\\(([\\s\\S]*?)\\n\\);`,
      'iu',
    ),
  )?.[1];

  expect(tableBody, `${tableName} must have an inspectable CREATE TABLE body`).toBeDefined();
  expect(tableBody).toMatch(
    /\bworkspace_id\s+uuid\s+NOT NULL\s+REFERENCES public\.workspaces\(id\)/iu,
  );
  expect(tableBody).toMatch(/\b(?:PRIMARY KEY|UNIQUE)\s*\(\s*workspace_id\s*,/iu);
  expect(sql).toMatch(
    new RegExp(`ALTER TABLE public\\.${escapedTableName} ENABLE ROW LEVEL SECURITY\\s*;`, 'iu'),
  );
  expect(sql).toMatch(
    new RegExp(`ALTER TABLE public\\.${escapedTableName} FORCE ROW LEVEL SECURITY\\s*;`, 'iu'),
  );
  expect(sql).toMatch(
    new RegExp(
      `ALTER TABLE public\\.${escapedTableName} OWNER TO ${escapeRegularExpression(owner)}\\s*;`,
      'iu',
    ),
  );
}

function requireOwnedFunction(
  sql: string,
  functionNames: string[],
  label: string,
  pattern: RegExp,
  owner: string,
): string {
  const functionName = requireMatchingName(functionNames, label, pattern);
  expect(sql).toMatch(
    new RegExp(
      `ALTER FUNCTION (?:app|auth)\\.${escapeRegularExpression(functionName)}\\([^;]*\\) OWNER TO ${escapeRegularExpression(owner)}\\s*;`,
      'iu',
    ),
  );
  return functionName;
}

describe('G0-06 bootstrap owner boundary', () => {
  it('creates isolated NOLOGIN owner roles and keeps 004 free of G0-07 phase roles', async () => {
    const sql = await readFile(
      path.join(packageDirectory, 'bootstrap', 'platform-roles.sql'),
      'utf8',
    );

    for (const owner of g006OwnerRoles) {
      expect(sql).toContain(`'${owner}'::name`);
      expect(sql).toMatch(
        new RegExp(
          `ALTER ROLE ${owner}\\s+NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS\\s*;`,
          'u',
        ),
      );
    }

    expect(sql).toMatch(
      /GRANT\s+ba_auth_owner,\s+ba_authorization_owner,\s+ba_run_owner,\s+ba_billing_owner,\s+ba_archive_evidence_owner,\s+ba_retention\s+TO ba_migrator WITH ADMIN OPTION;/u,
    );
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const g006Sql = migrations.find(({ id }) => id === '004')?.upSql ?? '';
    expect(g006Sql).not.toMatch(
      /\bba_(?:admission|metering|finalizer|archive_evidence|retention|run|billing)_executor\b/u,
    );
  });

  it('keeps owners mutually isolated from every current executable role in the disposable catalog probe', async () => {
    const bootstrapProbe = await readFile(
      path.join(repositoryDirectory, 'infra', 'test', 'postgres', 'bootstrap-test.sql'),
      'utf8',
    );

    for (const owner of g006OwnerRoles) {
      expect(bootstrapProbe).toContain(`'${owner}'`);
    }
    for (const executableRole of executableRoles) {
      expect(bootstrapProbe).toContain(`'${executableRole}'`);
    }
    expect(bootstrapProbe).toContain('ba_migrator must be the only direct G0-06 owner member');
    expect(bootstrapProbe).toContain(
      'G0-06 owners must not inherit executable or peer owner roles',
    );
  });
});

describe('004 Run and billing migration static gate', () => {
  it('runs the platform prerequisite guard before every mutating 004 statement', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const sql = migrations.find(({ id }) => id === '004')?.upSql ?? '';
    const prerequisite = sql.match(
      /DO \$g006_platform_prerequisites\$[\s\S]*?\$g006_platform_prerequisites\$;/u,
    );

    expect(prerequisite, '004 must expose one inspectable prerequisite guard').toBeDefined();
    expect(prerequisiteGateWouldPass(sql)).toBe(true);

    const mutationHiddenInDo = `DO $hidden_mutation$
BEGIN
  EXECUTE 'CREATE TABLE public.before_g006_guard(id integer)';
END;
$hidden_mutation$;
${sql}`;
    expect(prerequisiteGateWouldPass(mutationHiddenInDo)).toBe(false);
  });

  it('binds the indirect migrator rejection to one verbose ERROR diagnostic without SQL echo', async () => {
    const integration = await readFile(
      path.join(
        repositoryDirectory,
        'infra',
        'test',
        'postgres',
        'run-run-billing-integration.mjs',
      ),
      'utf8',
    );
    const probe = integration.match(
      /async function assert004RejectsIndirectMigratorEnrollmentBeforeInstall\(\)[\s\S]*?\n\}\n\nasync function installFreshSchema/u,
    )?.[0];
    const rejectedApply = probe?.match(
      /indirectApply = await harness\.psql\([\s\S]*?\n\s*\);/u,
    )?.[0];

    expect(probe, 'indirect migrator integration probe must remain inspectable').toBeDefined();
    expect(rejectedApply, 'expected-failure psql call must remain inspectable').toBeDefined();
    expect(rejectedApply).toContain('{ allowFailure: true }');
    expect(rejectedApply).not.toContain('echoErrors');
    expect(probe).toMatch(
      /assertVerbosePostgresError\(\s*indirectApply,\s*'42501',\s*'session_user must be a direct inheriting ba_migrator member'/u,
    );
    expect(integration).toMatch(
      /assertVerbosePostgresErrorRejectsEchoOnly\(\);\s*await harness\.start\(\);/u,
    );
  });

  it('freezes inventory, tenant isolation, ownership, ACL, safe-definer and down-guard boundaries', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const migration = migrations.find(({ id }) => id === '004');

    expect(
      migration,
      'T5 red gate: add the reviewed 004_run_billing up/down pair before this gate can pass',
    ).toMatchObject({ id: '004', name: 'run_billing' });
    expect(migration?.downSql).toBeDefined();
    expect(migration?.downSql).toMatch(/ERRCODE\s*=\s*'55000'/u);
    expect(renderUpMigrationSql(migrations)).toContain('\\if :ba_apply_004');
    expect(renderDownMigrationSql(migrations, 3, { allowDown: true })).toContain(
      '\\if :ba_revert_004',
    );

    const sql = migration?.upSql ?? '';
    const tableNames = createdTableNames(sql);
    const functionNames = createdFunctionNames(sql);

    for (const requiredFact of requiredFactTables) {
      const tableName = requireMatchingName(tableNames, requiredFact.label, requiredFact.pattern);
      expectTableBoundary(sql, tableName, requiredFact.owner);
    }

    for (const legacyRegistryTable of [
      'published_resource_versions',
      'published_resource_dependencies',
      'agent_strategy_releases',
      'agent_releases',
      'flow_versions',
      'experience_releases',
      'deployment_policy_versions',
    ]) {
      expect(tableNames).not.toContain(legacyRegistryTable);
    }

    const definerCount = sql.match(/\bSECURITY DEFINER\b/gu)?.length ?? 0;
    const safeDefinerCount =
      sql.match(
        /\bSECURITY DEFINER\s+SET search_path\s*=\s*pg_catalog,\s*public,\s*auth,\s*app,\s*pg_temp\b/giu,
      )?.length ?? 0;
    expect(definerCount).toBeGreaterThan(0);
    expect(safeDefinerCount).toBe(definerCount);

    requireOwnedFunction(sql, functionNames, 'Run finalizer', /^finalize_run$/u, 'ba_run_owner');
    for (const [label, pattern] of [
      ['credit reservation primitive', /^reserve_credits$/u],
      ['credit settlement primitive', /^settle_credits$/u],
      ['credit release primitive', /^release_credits$/u],
      ['credit expiry primitive', /^expire_(?:credit_reservation|credits)$/u],
      ['billing reconciliation primitive', /^reconcile_(?:run_)?billing$/u],
    ] as const) {
      requireOwnedFunction(sql, functionNames, label, pattern, 'ba_billing_owner');
    }
    for (const [label, pattern] of [
      ['archive manifest registration', /^register_.*archive_manifest$/u],
      ['archive verification registration', /^(?:register_)?verify_.*archive/u],
      ['archive approval registration', /^(?:register_)?approve_.*archive/u],
    ] as const) {
      requireOwnedFunction(sql, functionNames, label, pattern, 'ba_archive_evidence_owner');
    }
    for (const [label, pattern] of [
      ['event purge', /^purge_.*events$/u],
      ['recovery purge', /^purge_.*(?:recovery|material)$/u],
    ] as const) {
      requireOwnedFunction(sql, functionNames, label, pattern, 'ba_retention');
    }

    expect(sql).toMatch(
      /GRANT SELECT\s*\([^;]*credits_balance[^;]*credits_reserved_balance[^;]*credits_balance_version[^;]*\)\s+ON TABLE public\.workspaces TO ba_billing_owner;/iu,
    );
    expect(sql).toMatch(
      /GRANT UPDATE\s*\([^;]*credits_balance[^;]*credits_reserved_balance[^;]*credits_balance_version[^;]*\)\s+ON TABLE public\.workspaces TO ba_billing_owner;/iu,
    );
    expect(sql).toMatch(
      /GRANT SELECT\s*\([^;]*billing_state[^;]*billing_settled_at[^;]*\)\s+ON TABLE public\.runs TO ba_billing_owner;/iu,
    );
    expect(sql).toMatch(
      /GRANT UPDATE\s*\(\s*billing_state\s*,\s*billing_settled_at\s*\)\s+ON TABLE public\.runs TO ba_billing_owner;/iu,
    );
    expect(sql).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)\s+ON TABLE public\.(?:workspaces|runs)\s+TO ba_billing_owner;/iu,
    );
    expect(sql).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]*ON TABLE public\.credits_ledger\s+TO ba_run_owner;/iu,
    );

    const executeGrants = sql.match(/GRANT EXECUTE ON FUNCTION[\s\S]*?;/giu) ?? [];
    const runtimeExecuteGrants = executeGrants.filter((grant) =>
      /\bTO ba_runtime\s*;/iu.test(grant),
    );
    expect(runtimeExecuteGrants.join('\n')).toMatch(/original.*run|run.*original/iu);
    expect(runtimeExecuteGrants.join('\n')).toMatch(/events/iu);
    expect(runtimeExecuteGrants.join('\n')).toContain('request_run_cancellation');

    for (const grant of executeGrants) {
      if (executableRoles.some((role) => grant.includes(role))) {
        expect(grant).toMatch(/\bTO ba_runtime\s*;/iu);
        expect(grant).toMatch(/(?:original.*run|run.*original|request_run_cancellation)/iu);
      }
    }

    expect(sql).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]*ON(?: TABLE)?[^;]*TO\s+ba_(?:runtime|control_executor|management_attestation_issuer|subject_assertion_verifier)\b/iu,
    );
    expect(sql).not.toMatch(
      /\bba_(?:admission|metering|finalizer|archive_evidence|retention|run|billing)_executor\b/u,
    );
  });

  it('keeps original-Run authorization on database time and locks the current service grant fence', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const sql = migrations.find(({ id }) => id === '004')?.upSql ?? '';
    const originalRunAuthorization = requireFunctionDefinition(
      sql,
      'app',
      'require_original_run_authorization',
    );

    expect(originalRunAuthorization).not.toMatch(/p_auth\s*->>\s*'now'/u);
    for (const functionName of ['authorize_agent_original_run', 'authorize_flow_original_run']) {
      const serviceAuthorization = requireFunctionDefinition(sql, 'app', functionName);
      expect(serviceAuthorization).toContain('public.api_credentials');
      expect(serviceAuthorization).toContain('public.api_credential_scopes');
      expect(serviceAuthorization).toMatch(
        /credential\.credential_kind\s*=\s*grant_row\.credential_kind/u,
      );
      expect(serviceAuthorization).toMatch(/grant_row\.credential_kind\s*=\s*'service_api'/u);
      expect(serviceAuthorization).toMatch(/deployment\.ingress_channel\s*=\s*'service_api'/u);
      expect(serviceAuthorization).toMatch(/FOR SHARE/u);
    }
  });

  it('prevents reservation audit time from moving backward in storage or billing primitives', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const sql = migrations.find(({ id }) => id === '004')?.upSql ?? '';
    const reservationTable = sql.match(
      /CREATE TABLE public\.credit_reservations\s*\(([\s\S]*?)\n\);/u,
    )?.[1];

    expect(reservationTable).toBeDefined();
    expect(reservationTable).toMatch(/expires_at\s*>\s*created_at/u);
    expect(reservationTable).toMatch(/updated_at\s*>=\s*created_at/u);
    expect(reservationTable).toMatch(/settled_at[\s\S]*?BETWEEN created_at AND updated_at/iu);
    expect(reservationTable).toMatch(/released_at[\s\S]*?BETWEEN created_at AND updated_at/iu);

    for (const [functionName, timestampParameter] of [
      ['settle_credits', 'p_created_at'],
      ['release_credits', 'p_created_at'],
      ['expire_credit_reservation', 'p_now'],
      ['reconcile_run_billing', 'p_resolved_at'],
    ] as const) {
      const definition = requireFunctionDefinition(sql, 'app', functionName);
      expect(definition).toMatch(
        new RegExp(`${timestampParameter}\\s*<\\s*v_reservation\\.updated_at`, 'u'),
      );
    }
  });

  it('serializes Workspace balances without upgrading foreign-key key-share locks', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const sql = migrations.find(({ id }) => id === '004')?.upSql ?? '';

    for (const functionName of [
      'lock_billing_workspace',
      'reserve_credits',
      'settle_credits',
      'release_credits',
      'expire_credit_reservation',
      'reconcile_run_billing',
    ]) {
      const definition = requireFunctionDefinition(sql, 'app', functionName);
      expect(definition).toMatch(
        /FROM public\.workspaces AS workspace_row[\s\S]*?WHERE workspace_row\.id = p_workspace_id\s+FOR NO KEY UPDATE;/u,
      );
      expect(definition).not.toMatch(
        /FROM public\.workspaces AS workspace_row[\s\S]*?WHERE workspace_row\.id = p_workspace_id\s+FOR UPDATE;/u,
      );
    }
  });

  it('lets Agent and Flow acceptance arbitrate every sentinel uniqueness conflict before locking the full namespace', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const sql = migrations.find(({ id }) => id === '004')?.upSql ?? '';

    for (const [functionName, fixedRoute] of [
      ['accept_prepared_agent_chat_run', '/v1/oapi/agent/chat'],
      ['accept_prepared_flow_run', '/v1/oapi/flow/run'],
    ] as const) {
      const definition = requireFunctionDefinition(sql, 'app', functionName);
      expect(definition).toMatch(
        /INSERT INTO public\.run_idempotency_sentinels[\s\S]*?ON CONFLICT DO NOTHING RETURNING id INTO v_inserted_sentinel;/u,
      );
      expect(definition).not.toMatch(
        /ON CONFLICT ON CONSTRAINT run_idempotency_sentinels_namespace_key/u,
      );
      expect(definition).toMatch(
        new RegExp(
          `SELECT sentinel\\.intent_hash[\\s\\S]*?FROM public\\.run_idempotency_sentinels AS sentinel[\\s\\S]*?sentinel\\.workspace_id = v_workspace_id[\\s\\S]*?sentinel\\.principal_kind =[\\s\\S]*?sentinel\\.fixed_route = '${escapeRegularExpression(fixedRoute)}'[\\s\\S]*?sentinel\\.idempotency_key = v_key[\\s\\S]*?FOR UPDATE;`,
          'u',
        ),
      );
      expect(definition).toMatch(
        /IF v_saved_intent_hash IS DISTINCT FROM v_intent_hash THEN[\s\S]*?ERRCODE = '23505'/u,
      );
      expect(definition).toMatch(
        /IF NOT FOUND THEN[\s\S]*?missing its acceptance receipt[\s\S]*?ERRCODE = '55000'/u,
      );
    }
  });

  it('keeps only the two current-user-sensitive trigger guards as reviewed invokers', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const sql = migrations.find(({ id }) => id === '004')?.upSql ?? '';
    const appFunctionNames = [
      ...sql.matchAll(/CREATE FUNCTION\s+app\.([a-z][a-z0-9_]*)\s*\(/giu),
    ].map((match) => match[1] ?? '');
    const invokerTriggers = appFunctionNames
      .filter((functionName) => {
        const definition = requireFunctionDefinition(sql, 'app', functionName);
        return /RETURNS trigger/u.test(definition) && !/SECURITY DEFINER/u.test(definition);
      })
      .sort();

    expect(invokerTriggers).toEqual(['protect_run_change', 'protect_run_event_change']);
    for (const functionName of invokerTriggers) {
      expect(requireFunctionDefinition(sql, 'app', functionName)).toMatch(
        /SET search_path = pg_catalog, public, auth, app, pg_temp/u,
      );
    }
  });

  it('ignores only the not-yet-recomputed generated principal projection in Run updates', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const sql = migrations.find(({ id }) => id === '004')?.upSql ?? '';
    const protection = requireFunctionDefinition(sql, 'app', 'protect_run_change');
    const comparisonExclusions = protection.match(
      /v_comparison_excluded_columns\s+text\[\]\s*:=\s*ARRAY\[([\s\S]*?)\];/u,
    )?.[1];

    expect(comparisonExclusions).toContain("'accepted_principal_id'");
    expect(comparisonExclusions).not.toContain("'accepted_credential_id'");
    expect(comparisonExclusions).not.toContain("'accepted_end_user_principal_id'");
    expect(protection).toMatch(
      /'accepted_principal_id'\s*,\s*'billing_state'\s*,\s*'billing_settled_at'/u,
    );
  });

  it('lets retention see eligible and blocking rows without broadening its delete allowlist', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const sql = migrations.find(({ id }) => id === '004')?.upSql ?? '';

    for (const tableName of ['run_events', 'run_checkpoints', 'outbox']) {
      expect(sql).toMatch(
        new RegExp(
          `CREATE POLICY ${tableName}_retention_read ON public\\.${tableName}\\s+FOR SELECT TO ba_retention USING \\(workspace_id = app\\.current_workspace_id\\(\\)\\)`,
          'u',
        ),
      );
    }
    expect(sql).toMatch(
      /CREATE POLICY outbox_retention_delete ON public\.outbox[\s\S]*?status\s*=\s*'DELIVERED'/u,
    );
  });

  it('derives cancellation intent inside PostgreSQL instead of trusting caller hashes', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const sql = migrations.find(({ id }) => id === '004')?.upSql ?? '';
    const cancellation = requireFunctionDefinition(sql, 'app', 'request_run_cancellation');

    expect(cancellation).not.toMatch(/p_fact\s*->>\s*'intent_hash'/u);
    expect(cancellation).not.toMatch(
      /p_fact\s*->>\s*'(?:requested_at|mutation_id|event_id|outbox_id)'/u,
    );
    expect(cancellation).toMatch(/v_requested_at\s+timestamptz\s*:=\s*clock_timestamp\(\)/u);
    expect(cancellation).toMatch(/digest\s*\(/u);
  });

  it('keeps the G0-05 Agent revision publisher valid after adding the Conversation projection', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const sql = migrations.find(({ id }) => id === '004')?.upSql ?? '';
    const generatedProjection =
      /ADD COLUMN conversation_contract_hash\s+text\s+GENERATED ALWAYS AS\s*\([\s\S]*?canonical_document[\s\S]*?\)\s+STORED/iu.test(
        sql,
      );
    const compatiblePublisher =
      /CREATE OR REPLACE FUNCTION app\.publish_agent_deployment_revision\([\s\S]*?INSERT INTO public\.agent_deployment_revisions\s*\([\s\S]*?conversation_contract_hash/iu.test(
        sql,
      );

    expect(generatedProjection || compatiblePublisher).toBe(true);
  });

  it('closes terminal projections and emits only canonical Run Event and Outbox kinds', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const sql = migrations.find(({ id }) => id === '004')?.upSql ?? '';
    const runsTable = sql.match(/CREATE TABLE public\.runs\s*\(([\s\S]*?)\n\);/u)?.[1];
    const eventsTable = sql.match(/CREATE TABLE public\.run_events\s*\(([\s\S]*?)\n\);/u)?.[1];
    const outboxTable = sql.match(/CREATE TABLE public\.outbox\s*\(([\s\S]*?)\n\);/u)?.[1];
    const finalizer = requireFunctionDefinition(sql, 'app', 'finalize_run');
    const cancellation = requireFunctionDefinition(sql, 'app', 'request_run_cancellation');

    expect(runsTable).toMatch(/status = 'FAILED'[\s\S]*?termination_reason IN \(/u);
    expect(runsTable).toMatch(/status = 'CANCELLED'[\s\S]*?'USER_CANCELLED'/u);
    expect(runsTable).toMatch(/status = 'TIMED_OUT'[\s\S]*?'RUN_TIMED_OUT'/u);
    expect(runsTable).toMatch(/status = 'NEEDS_ATTENTION'[\s\S]*?'SIDE_EFFECT_UNKNOWN'/u);
    expect(runsTable).toMatch(
      /status = 'NEEDS_ATTENTION'[\s\S]*?terminal_error_redacted\s*=\s*jsonb_build_object\([\s\S]*?'code', termination_reason[\s\S]*?'requires_operator_action', true/u,
    );
    expect(runsTable).toMatch(
      /status <> 'NEEDS_ATTENTION'[\s\S]*?terminal_error_redacted\s*=\s*jsonb_build_object\([\s\S]*?'code', termination_reason[\s\S]*?'category', 'EXECUTION'/u,
    );
    expect(runsTable).not.toContain('jsonb_object_length');

    for (const eventKind of ['RUN_ACCEPTED', 'RUN_CANCEL_REQUESTED', 'RUN_FINISHED', 'SSE_TASK']) {
      expect(eventsTable).toContain(`'${eventKind}'`);
    }
    for (const messageType of [
      'RUN_DISPATCH',
      'SSE_WAKE',
      'WEBHOOK_DELIVERY',
      'ANALYTICS_PROJECTION',
    ]) {
      expect(outboxTable).toContain(`'${messageType}'`);
    }
    expect(eventsTable).not.toContain('RUN_TERMINAL');
    expect(outboxTable).not.toContain('RUN_TERMINAL');

    expect(finalizer).toContain("'RUN_FINISHED'");
    expect(finalizer).toContain("'SSE_WAKE'");
    expect(finalizer).toMatch(
      /v_terminal_error_redacted\s*:=\s*jsonb_build_object\([\s\S]*?'code'[\s\S]*?v_termination_reason[\s\S]*?'retryable'[\s\S]*?false[\s\S]*?'category'[\s\S]*?'EXECUTION'/u,
    );
    expect(finalizer).not.toMatch(
      /terminal_error_redacted\s*=\s*p_fact\s*->\s*'terminal_error_redacted'/u,
    );
    expect(finalizer).toMatch(
      /v_termination_reason IN \('HUMAN_REJECTED', 'HUMAN_GATE_EXPIRED'\)[\s\S]*?ERRCODE = '0A000'/u,
    );
    expect(cancellation).toContain("'RUN_CANCEL_REQUESTED'");
    expect(cancellation).toContain("'SSE_WAKE'");
    expect(sql).not.toContain("'RUN_CANCELLATION_REQUESTED'");
    expect(sql).not.toContain("'RUN_CANCEL'");
  });

  it('binds reserve and reconciliation attribution and preserves closed reservation evidence', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const sql = migrations.find(({ id }) => id === '004')?.upSql ?? '';
    const summary = requireFunctionDefinition(sql, 'app', 'lock_billing_reservation_summary');
    const reserve = requireFunctionDefinition(sql, 'app', 'reserve_credits');
    const reconcile = requireFunctionDefinition(sql, 'app', 'reconcile_run_billing');
    const finalizer = requireFunctionDefinition(sql, 'app', 'finalize_run');

    expect(summary).toMatch(/'updated_at'\s*,\s*v_reservation\.updated_at/u);
    expect(reserve).toMatch(/p_charge_attribution_hash\s+IS DISTINCT FROM\s+p_accepted_plan_hash/u);
    expect(reserve).toMatch(/'RESERVE'[\s\S]*?p_billing_intent_hash\s*,\s*p_accepted_plan_hash/u);
    expect(reconcile).toMatch(/p_charge_attribution_hash\s+IS DISTINCT FROM\s+p_evidence_sha256/u);
    expect(reconcile).toMatch(
      /'RECONCILIATION'[\s\S]*?p_billing_intent_hash\s*,\s*p_evidence_sha256/u,
    );
    expect(reconcile).toMatch(/v_evidence_only\s+boolean/u);
    expect(reconcile).toMatch(
      /v_reservation\.status IN \('SETTLED', 'RELEASED', 'EXPIRED'\)[\s\S]*?p_settle_credits = 0[\s\S]*?p_release_credits = 0/u,
    );
    expect(reconcile).toMatch(
      /IF NOT v_evidence_only THEN[\s\S]*?UPDATE public\.credit_reservations/u,
    );
    expect(reconcile).toMatch(
      /status = CASE[\s\S]*?v_reservation\.reserved_credits = 0[\s\S]*?THEN 'SETTLED'/u,
    );
    expect(reconcile).toMatch(
      /settled_at = CASE[\s\S]*?v_reservation\.reserved_credits = 0[\s\S]*?THEN p_resolved_at/u,
    );
    expect(reconcile).not.toMatch(
      /released_at = CASE[\s\S]*?v_reservation\.settled_credits \+ p_settle_credits = 0[\s\S]*?THEN p_resolved_at/u,
    );
    expect(finalizer).toMatch(
      /v_finished_at\s*<\s*\(v_reservation\s*->>\s*'updated_at'\)::timestamptz/u,
    );
  });

  it('locks retention horizons, uses database time and enforces evidence chronology', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const sql = migrations.find(({ id }) => id === '004')?.upSql ?? '';
    const lockSummary = requireFunctionDefinition(sql, 'app', 'lock_run_retention_summary');
    const purgeEvents = requireFunctionDefinition(sql, 'app', 'purge_run_events');
    const purgeRecovery = requireFunctionDefinition(sql, 'app', 'purge_run_recovery_material');
    const verification = requireFunctionDefinition(sql, 'app', 'verify_run_archive');
    const approval = requireFunctionDefinition(sql, 'app', 'approve_run_archive');
    const manifest = requireFunctionDefinition(sql, 'app', 'register_run_archive_manifest');
    const legacyBrowserFacts = requireFunctionDefinition(
      sql,
      'auth',
      'authenticate_browser_session_facts',
    );
    const browserIdentity = requireFunctionDefinition(
      sql,
      'auth',
      'authenticate_browser_session_identity',
    );

    expect(sql).toMatch(
      /FROM pg_catalog\.pg_auth_members AS membership[\s\S]*?member_role\.rolname <> 'ba_migrator'[\s\S]*?G0-06 owners may only be granted directly to ba_migrator/u,
    );
    expect(sql).toMatch(
      /login_role\.rolcanlogin[\s\S]*?pg_catalog\.pg_has_role\([\s\S]*?executable_role\.oid[\s\S]*?'MEMBER'[\s\S]*?pg_catalog\.pg_has_role\(login_role\.oid, owner_role\.oid, 'MEMBER'\)[\s\S]*?non-super LOGIN cannot inherit executable and G0-06 owner capabilities/u,
    );
    for (const platformRole of ['ba_migrator', ...executableRoles]) {
      expect(sql).toMatch(
        new RegExp(
          `role_row\\.rolname = ANY \\(ARRAY\\[[\\s\\S]*?'${platformRole}'[\\s\\S]*?role_row\\.rolcanlogin[\\s\\S]*?role_row\\.rolsuper[\\s\\S]*?role_row\\.rolcreatedb[\\s\\S]*?role_row\\.rolcreaterole[\\s\\S]*?role_row\\.rolreplication[\\s\\S]*?role_row\\.rolbypassrls`,
          'u',
        ),
      );
    }
    expect(sql).toMatch(
      /NOT role_row\.rolcanlogin[\s\S]*?NOT role_row\.rolinherit[\s\S]*?role_row\.rolsuper[\s\S]*?role_row\.rolcreatedb[\s\S]*?role_row\.rolcreaterole[\s\S]*?role_row\.rolreplication[\s\S]*?role_row\.rolbypassrls[\s\S]*?role_row\.rolname = session_user/u,
    );
    expect(sql).toMatch(
      /FROM pg_catalog\.pg_auth_members AS membership[\s\S]*?granted_role\.oid = membership\.roleid[\s\S]*?member_role\.oid = membership\.member[\s\S]*?granted_role\.rolname = 'ba_migrator'[\s\S]*?member_role\.rolname = session_user[\s\S]*?membership\.inherit_option[\s\S]*?session_user must be a direct inheriting ba_migrator member/u,
    );
    expect(sql).not.toMatch(/pg_catalog\.pg_has_role\(session_user, 'ba_migrator', 'MEMBER'\)/u);
    expect(lockSummary).toMatch(/FROM public\.runs AS run_row[\s\S]*?FOR UPDATE/u);
    expect(lockSummary).toMatch(/'terminal_intent_hash'\s*,\s*v_run\.terminal_intent_hash/u);
    expect(lockSummary).toMatch(/'terminal_event_id'\s*,\s*v_run\.terminal_event_id/u);
    expect(lockSummary).toMatch(/'terminal_event_sequence'\s*,\s*v_run\.terminal_event_sequence/u);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.lock_run_retention_summary\(uuid, uuid\) TO[\s\S]*?ba_archive_evidence_owner[\s\S]*?ba_retention/u,
    );
    for (const purge of [purgeEvents, purgeRecovery]) {
      expect(purge).toMatch(/v_run\s*:=\s*app\.lock_run_retention_summary\(/u);
      expect(purge).toMatch(/v_now\s*:=\s*clock_timestamp\(\)/u);
      expect(purge).not.toMatch(/p_fact\s*->>\s*'purged_at'/u);
      expect(purge).toMatch(/run_billing_reconciliations/u);
      const receiptReads = [
        ...purge.matchAll(/FROM public\.run_retention_purge_receipts AS receipt/gu),
      ];
      expect(receiptReads).toHaveLength(2);
      const runLock = purge.indexOf('v_run := app.lock_run_retention_summary(');
      expect(receiptReads[0]?.index ?? -1).toBeLessThan(runLock);
      expect(receiptReads[1]?.index ?? -1).toBeGreaterThan(runLock);
      for (const intentField of [
        'manifest_id',
        'verification_receipt_id',
        'approval_receipt_id',
        'archive_ref',
        'archive_sha256',
        'verification_receipt_sha256',
        'approval_receipt_sha256',
      ]) {
        expect(purge).toMatch(
          new RegExp(
            `v_existing\\.${intentField}\\s+IS DISTINCT FROM\\s+(?:\\(p_fact ->> '${intentField}'\\)::uuid|p_fact ->> '${intentField}')`,
            'u',
          ),
        );
      }
    }
    expect(purgeEvents).not.toMatch(/status IN \('PENDING', 'LEASED'\)/u);
    expect(purgeEvents).not.toMatch(/reservation\.status = 'HELD'/u);
    expect(purgeRecovery).toMatch(/status IN \('PENDING', 'LEASED'\)/u);
    expect(purgeRecovery).toMatch(/reservation\.status = 'HELD'/u);
    expect(verification).toMatch(
      /\(p_fact\s*->>\s*'verified_at'\)::timestamptz\s*<\s*v_manifest\.created_at/u,
    );
    expect(approval).toMatch(
      /\(p_fact\s*->>\s*'approved_at'\)::timestamptz\s*<\s*v_verification\.verified_at/u,
    );
    const manifestRunLock = manifest.indexOf('v_run := app.lock_run_retention_summary(');
    const manifestReplayRead = manifest.indexOf('FROM public.run_archive_manifests AS manifest');
    expect(manifestRunLock).toBeGreaterThan(-1);
    expect(manifestReplayRead).toBeGreaterThan(manifestRunLock);

    const verificationManifestLock = verification.indexOf(
      'FROM public.run_archive_manifests AS manifest',
    );
    const verificationReplayRead = verification.indexOf(
      'FROM public.run_archive_verification_receipts AS receipt',
    );
    expect(verification.slice(verificationManifestLock, verificationReplayRead)).toMatch(
      /FOR UPDATE/u,
    );
    expect(verificationReplayRead).toBeGreaterThan(verificationManifestLock);

    const approvalManifestLock = approval.indexOf('FROM public.run_archive_manifests AS manifest');
    const approvalVerificationLock = approval.indexOf(
      'FROM public.run_archive_verification_receipts AS receipt',
    );
    const approvalReplayRead = approval.indexOf(
      'FROM public.run_archive_approval_receipts AS receipt',
    );
    expect(approval.slice(approvalManifestLock, approvalReplayRead)).toMatch(/FOR UPDATE/u);
    expect(approvalReplayRead).toBeGreaterThan(approvalManifestLock);
    expect(approvalVerificationLock).toBeGreaterThan(approvalReplayRead);
    expect(approval.slice(approvalVerificationLock)).toMatch(/FOR UPDATE/u);
    for (const [definition, fields] of [
      [manifest, ['id', 'archive_ref', 'archive_sha256', 'created_at']],
      [
        verification,
        [
          'id',
          'run_id',
          'archive_ref',
          'archive_sha256',
          'receipt_ref',
          'receipt_sha256',
          'verified_at',
        ],
      ],
      [
        approval,
        [
          'id',
          'verification_receipt_id',
          'verification_receipt_sha256',
          'run_id',
          'archive_ref',
          'archive_sha256',
          'receipt_ref',
          'receipt_sha256',
          'approved_at',
        ],
      ],
    ] as const) {
      for (const field of fields) {
        expect(definition).toContain(`v_existing.${field}`);
      }
    }

    const publicLock = browserIdentity.indexOf('FROM public.browser_sessions AS session_row');
    const privateLock = browserIdentity.indexOf(
      'FROM auth.browser_session_auth_index AS private_row',
    );
    expect(publicLock).toBeGreaterThan(-1);
    expect(privateLock).toBeGreaterThan(publicLock);
    expect(browserIdentity.slice(publicLock, privateLock)).toMatch(/FOR SHARE/u);

    const legacyPublicLock = legacyBrowserFacts.indexOf(
      'FROM public.browser_sessions AS session_row',
    );
    const legacyPrivateLock = legacyBrowserFacts.indexOf(
      'FROM auth.browser_session_auth_index AS private_row',
    );
    expect(legacyPublicLock).toBeGreaterThan(-1);
    expect(legacyPrivateLock).toBeGreaterThan(legacyPublicLock);
    expect(legacyBrowserFacts.slice(legacyPublicLock, legacyPrivateLock)).toMatch(/FOR SHARE/u);
  });

  it('restores the exact 003 legacy browser authentication definition on down', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const g005Sql = migrations.find(({ id }) => id === '003')?.upSql ?? '';
    const g006DownSql = migrations.find(({ id }) => id === '004')?.downSql ?? '';
    const legacyDefinition = requireFunctionDefinition(
      g005Sql,
      'auth',
      'authenticate_browser_session_facts',
    );
    const restoredDefinition = requireFunctionDefinition(
      g006DownSql,
      'auth',
      'authenticate_browser_session_facts',
    );

    expect(functionBody(restoredDefinition)).toBe(functionBody(legacyDefinition));
  });

  it('fingerprints policy mode, replica identity and index catalog state', async () => {
    const integration = await readFile(
      path.join(repositoryDirectory, 'infra', 'test', 'postgres', 'run-integration.mjs'),
      'utf8',
    );
    for (const catalogField of [
      'relation.relreplident',
      'policy.polpermissive',
      'index_row.indisclustered',
      'index_row.indisreplident',
    ]) {
      expect(integration).toContain(catalogField);
    }
  });
});
