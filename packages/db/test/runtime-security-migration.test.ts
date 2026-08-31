import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadMigrations, renderDownMigrationSql, renderUpMigrationSql } from '../src/index.js';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = path.resolve(packageDirectory, '..', '..');
const migrationDirectory = path.join(packageDirectory, 'migrations');
const ecmaScriptTrimCharactersSql = String.raw`U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'`;

const phaseRoles = [
  'ba_internal_service_attestation_issuer',
  'ba_admission_executor',
  'ba_execution_executor',
  'ba_metering_executor',
  'ba_finalizer_executor',
  'ba_reclaimer_executor',
  'ba_reconciliation_executor',
  'ba_archive_evidence_executor',
  'ba_retention_executor',
] as const;

const phaseExecutorRoles = phaseRoles.filter(
  (role) => role !== 'ba_internal_service_attestation_issuer',
);

const phaseTestLoginGraph = [
  ['ba_internal_issuer_test', 'ba_internal_service_attestation_issuer'],
  ['ba_admission_test', 'ba_admission_executor'],
  ['ba_execution_test', 'ba_execution_executor'],
  ['ba_execution_other_test', 'ba_execution_executor'],
  ['ba_metering_test', 'ba_metering_executor'],
  ['ba_finalizer_test', 'ba_finalizer_executor'],
  ['ba_reclaimer_test', 'ba_reclaimer_executor'],
  ['ba_reconciliation_test', 'ba_reconciliation_executor'],
  ['ba_archive_evidence_test', 'ba_archive_evidence_executor'],
  ['ba_retention_executor_test', 'ba_retention_executor'],
] as const;

const legacyQuiescenceInventory = [
  'public.workspaces',
  'public.conversations',
  'public.conversation_states',
  'public.conversation_messages',
  'public.run_idempotency_sentinels',
  'public.runs',
  'public.run_acceptance_receipts',
  'public.run_mutation_idempotency',
  'public.run_attempts',
  'public.run_steps',
  'public.run_events',
  'public.run_checkpoints',
  'public.human_gates',
  'public.outbox',
  'public.run_parent_links',
  'public.credit_reservations',
  'public.credits_ledger',
  'public.run_budget_allocations',
  'public.run_billing_reconciliations',
  'public.run_archive_manifests',
  'public.run_archive_verification_receipts',
  'public.run_archive_approval_receipts',
  'public.run_retention_purge_receipts',
] as const;

const legacyOwnerPreflightRelations = {
  ba_billing_owner: [
    'public.credit_reservations',
    'public.run_budget_allocations',
    'public.credits_ledger',
    'public.run_billing_reconciliations',
  ],
  ba_run_owner: ['public.runs', 'public.run_attempts', 'public.outbox'],
} as const;

const frozenLegacyMigrationDigests = {
  '000_platform_prerequisites.up.sql':
    '5a8c4822d56d5557bb53b1a2004543c0d02d3b68118613dfb389fafb8acfd04f',
  '001_tenant_identity.up.sql': '39813459ea75c9aaba7d147f39ea399771cf1d5afc62de0d5088d70c8f204d56',
  '002_auth_context_rls.up.sql': '19403f29c72b6d9718441cfc834ece18d44479604d78f58c24400f446a7bd6d9',
  '003_release_deployment.down.sql':
    '9a67939546b02618a3eaae81d0a2f68cd8ac453264b018299cd91ec4fdae6ea0',
  '003_release_deployment.up.sql':
    '403f4b1297acda0fde2ab10b4f3e549011933ac9e7eb1cdc5ab0a11dd1a128bb',
  '004_run_billing.down.sql': '6cacb9e4bd83946c4f975595f0ad15dd554eb417618baf17b5ffff7af038ab4e',
  '004_run_billing.up.sql': 'eff5fa33d011c7785ef5f78ba4b3564a00d7144239796c0c8d83b270a15a87e1',
} as const;

type FunctionOracle = Readonly<{
  args: string;
  grantees: readonly string[];
  name: string;
  owner: string;
  returns: string;
  schema: 'app' | 'auth';
}>;

const functionOracle: readonly FunctionOracle[] = [
  {
    args: 'uuid, uuid, name, text, text, bytea, bytea, timestamptz',
    grantees: ['ba_internal_service_attestation_issuer'],
    name: 'issue_internal_service_attestation',
    owner: 'ba_auth_owner',
    returns: 'void',
    schema: 'auth',
  },
  {
    args: 'uuid, text',
    grantees: ['ba_internal_service_attestation_issuer'],
    name: 'revoke_internal_service_attestation',
    owner: 'ba_auth_owner',
    returns: 'void',
    schema: 'auth',
  },
  {
    args: 'uuid, bytea, text',
    grantees: phaseExecutorRoles,
    name: 'establish_internal_service_workspace_context',
    owner: 'ba_auth_owner',
    returns: 'uuid',
    schema: 'auth',
  },
  {
    args: 'text',
    grantees: ['ba_run_owner', 'ba_billing_owner', 'ba_archive_evidence_owner', 'ba_retention'],
    name: 'require_internal_service_phase',
    owner: 'ba_auth_owner',
    returns: 'uuid',
    schema: 'auth',
  },
  {
    args: 'jsonb',
    grantees: ['ba_run_owner'],
    name: 'require_execution_owner_lease',
    owner: 'ba_run_owner',
    returns: 'jsonb',
    schema: 'app',
  },
  {
    args: 'uuid, uuid',
    grantees: ['ba_billing_owner'],
    name: 'lock_open_run_for_attributed_settlement',
    owner: 'ba_run_owner',
    returns: 'void',
    schema: 'app',
  },
  {
    args: '',
    grantees: ['ba_run_owner'],
    name: 'lock_finalizer_workspace_billing_fence',
    owner: 'ba_billing_owner',
    returns: 'void',
    schema: 'app',
  },
  {
    args: 'jsonb',
    grantees: ['ba_run_owner', 'ba_billing_owner'],
    name: 'require_committed_producer_attribution',
    owner: 'ba_run_owner',
    returns: 'jsonb',
    schema: 'app',
  },
  {
    args: 'jsonb',
    grantees: ['ba_billing_owner'],
    name: 'require_transaction_finalizer_claim',
    owner: 'ba_run_owner',
    returns: 'jsonb',
    schema: 'app',
  },
  ...['apply_credit_settlement_kernel', 'apply_credit_release_kernel'].map(
    (name): FunctionOracle => ({
      args: 'jsonb',
      grantees: [],
      name,
      owner: 'ba_billing_owner',
      returns: 'uuid',
      schema: 'app',
    }),
  ),
  ...['apply_attributed_settlement', 'apply_attributed_release', 'apply_claimed_release'].map(
    (name): FunctionOracle => ({
      args: 'jsonb',
      grantees: ['ba_run_owner'],
      name,
      owner: 'ba_billing_owner',
      returns: 'uuid',
      schema: 'app',
    }),
  ),
  ...[
    'claim_run_attempt',
    'renew_run_attempt_lease',
    'relinquish_run_attempt_lease',
    'record_attempt_started',
    'record_attempt_retry_wait',
    'record_attempt_recovering',
    'record_attempt_finished',
    'record_step_started',
    'record_step_finished',
    'record_execution_checkpoint',
    'record_execution_effect_envelope',
    'record_execution_effect_receipt',
    'record_usage_attribution',
    'record_leased_termination_intent',
    'claim_run_dispatch',
    'renew_run_dispatch_lease',
    'complete_run_dispatch',
    'fail_run_dispatch',
  ].map(
    (name): FunctionOracle => ({
      args: 'jsonb',
      grantees: ['ba_execution_executor'],
      name,
      owner: 'ba_run_owner',
      returns: 'jsonb',
      schema: 'app',
    }),
  ),
  ...['retire_run_attempts_for_finalizer', 'retire_run_dispatches_for_finalizer'].map(
    (name): FunctionOracle => ({
      args: 'jsonb',
      grantees: [],
      name,
      owner: 'ba_run_owner',
      returns: 'jsonb',
      schema: 'app',
    }),
  ),
  {
    args: 'jsonb',
    grantees: ['ba_metering_executor'],
    name: 'settle_attributed_credits',
    owner: 'ba_billing_owner',
    returns: 'jsonb',
    schema: 'app',
  },
  ...['finalize_attributed_run', 'finalize_claimed_run'].map(
    (name): FunctionOracle => ({
      args: 'jsonb',
      grantees: ['ba_finalizer_executor'],
      name,
      owner: 'ba_run_owner',
      returns: 'jsonb',
      schema: 'app',
    }),
  ),
  ...['fence_expired_run_attempt', 'record_recovery_hold_intent', 'fence_expired_run_dispatch'].map(
    (name): FunctionOracle => ({
      args: 'jsonb',
      grantees: ['ba_reclaimer_executor'],
      name,
      owner: 'ba_run_owner',
      returns: 'jsonb',
      schema: 'app',
    }),
  ),
  {
    args: 'jsonb',
    grantees: ['ba_reconciliation_executor'],
    name: 'reconcile_needs_attention_billing',
    owner: 'ba_billing_owner',
    returns: 'uuid',
    schema: 'app',
  },
  {
    args: 'jsonb',
    grantees: ['ba_archive_evidence_executor'],
    name: 'register_phase_run_archive_manifest',
    owner: 'ba_archive_evidence_owner',
    returns: 'uuid',
    schema: 'app',
  },
  ...['purge_phase_run_events', 'purge_phase_run_recovery_material'].map(
    (name): FunctionOracle => ({
      args: 'jsonb',
      grantees: ['ba_retention_executor'],
      name,
      owner: 'ba_retention',
      returns: 'uuid',
      schema: 'app',
    }),
  ),
];

const replacedFunctionOracle: readonly FunctionOracle[] = [
  {
    args: '',
    grantees: [],
    name: 'current_workspace_id',
    owner: 'ba_auth_owner',
    returns: 'uuid',
    schema: 'app',
  },
  {
    args: '',
    grantees: [],
    name: 'current_authenticated_principal_id',
    owner: 'ba_auth_owner',
    returns: 'text',
    schema: 'app',
  },
  {
    args: 'uuid, uuid, uuid, uuid, uuid, uuid, bigint, uuid, bigint, text, text, text, jsonb, timestamptz',
    grantees: [],
    name: 'settle_credits',
    owner: 'ba_billing_owner',
    returns: 'uuid',
    schema: 'app',
  },
  {
    args: 'uuid, uuid, uuid, uuid, uuid, uuid, bigint, uuid, bigint, text, text, text, text, timestamptz',
    grantees: [],
    name: 'release_credits',
    owner: 'ba_billing_owner',
    returns: 'uuid',
    schema: 'app',
  },
  {
    args: 'jsonb',
    grantees: [],
    name: 'finalize_run',
    owner: 'ba_run_owner',
    returns: 'jsonb',
    schema: 'app',
  },
];

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function signaturePattern(entry: FunctionOracle): string {
  const args = entry.args
    .split(',')
    .map((argument) => argument.trim())
    .filter((argument) => argument.length > 0)
    .map(escapeRegularExpression)
    .join('\\s*,\\s*');
  return `${entry.schema}\\.${entry.name}\\(\\s*${args}\\s*\\)`;
}

function requireFunctionDefinition(sql: string, entry: FunctionOracle): string {
  const definition = sql.match(
    new RegExp(
      `CREATE(?: OR REPLACE)? FUNCTION ${entry.schema}\\.${entry.name}\\([\\s\\S]*?\\$function\\$;`,
      'u',
    ),
  )?.[0];
  expect(
    definition,
    `${entry.schema}.${entry.name} must have an inspectable definition`,
  ).toBeDefined();
  return definition ?? '';
}

function requireCheckConstraintDefinition(sql: string, constraintName: string): string {
  const header = new RegExp(
    `(?:CONSTRAINT|ADD\\s+CONSTRAINT)\\s+${escapeRegularExpression(constraintName)}\\s+CHECK\\s*\\(`,
    'u',
  ).exec(sql);
  expect(header, `${constraintName} must have an inspectable CHECK definition`).toBeDefined();
  if (header === null) return '';

  const openingParenthesis = header.index + header[0].lastIndexOf('(');
  let depth = 0;
  let inSingleQuotedLiteral = false;
  let inDoubleQuotedIdentifier = false;

  for (let index = openingParenthesis; index < sql.length; index += 1) {
    const character = sql[index];
    const nextCharacter = sql[index + 1];

    if (inSingleQuotedLiteral) {
      if (character === "'" && nextCharacter === "'") {
        index += 1;
      } else if (character === "'") {
        inSingleQuotedLiteral = false;
      }
      continue;
    }
    if (inDoubleQuotedIdentifier) {
      if (character === '"' && nextCharacter === '"') {
        index += 1;
      } else if (character === '"') {
        inDoubleQuotedIdentifier = false;
      }
      continue;
    }
    if (character === "'") {
      inSingleQuotedLiteral = true;
      continue;
    }
    if (character === '"') {
      inDoubleQuotedIdentifier = true;
      continue;
    }
    if (character === '(') {
      depth += 1;
      continue;
    }
    if (character !== ')') continue;

    depth -= 1;
    if (depth === 0) return sql.slice(header.index, index + 1);
  }

  expect.fail(`${constraintName} CHECK definition must have balanced parentheses`);
}

function canonicalFunctionBody(definition: string): string {
  const body = definition.match(/RETURNS[\s\S]*?\$function\$;/u)?.[0];
  expect(body, 'function must expose an inspectable canonical body').toBeDefined();
  return body?.replace(/\r\n/gu, '\n').trim() ?? '';
}

function directGrantRoles(sql: string, entry: FunctionOracle): string[] {
  const signature = signaturePattern(entry);
  const grant = sql.match(
    new RegExp(`GRANT EXECUTE ON FUNCTION ${signature}\\s+TO\\s+([^;]+);`, 'u'),
  )?.[1];
  if (grant === undefined) return [];
  return grant
    .split(',')
    .map((role) => role.trim())
    .filter((role) => role.length > 0)
    .sort();
}

function firstLockInventory(sql: string): string[] {
  const withoutLeadingComments = sql
    .replace(/^(?:\s|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/u, '')
    .trimStart();
  const lock = withoutLeadingComments.match(
    /^LOCK TABLE\s+([\s\S]*?)\s+IN ACCESS EXCLUSIVE MODE NOWAIT\s*;/u,
  );
  expect(
    lock,
    'the first executable statement must be one multi-relation NOWAIT lock',
  ).toBeDefined();
  return (lock?.[1] ?? '')
    .split(',')
    .map((relation) => relation.trim())
    .filter((relation) => relation.length > 0);
}

function createdRelationInventory(sql: string): string[] {
  return [
    ...sql.matchAll(
      /CREATE\s+(?:UNLOGGED\s+)?TABLE(?:\s+IF NOT EXISTS)?\s+((?:app|auth|public)\.[a-z][a-z0-9_]*)\s*\(/giu,
    ),
  ]
    .map((match) => match[1]?.toLowerCase() ?? '')
    .filter((relation) => relation.length > 0);
}

async function runtimeSecuritySql(): Promise<{ downSql: string; upSql: string }> {
  const migrations = await loadMigrations(migrationDirectory);
  const migration = migrations.find(({ id }) => id === '005');
  expect(migration).toMatchObject({ id: '005', name: 'runtime_security', version: 5 });
  expect(migration?.downSql, '005_runtime_security.down.sql must exist').toBeDefined();
  return { downSql: migration?.downSql ?? '', upSql: migration?.upSql ?? '' };
}

describe('G0-07 bootstrap phase-role boundary', () => {
  it('creates the exact issuer/executor set as isolated NOLOGIN capability roles', async () => {
    const sql = await readFile(
      path.join(packageDirectory, 'bootstrap', 'platform-roles.sql'),
      'utf8',
    );

    for (const role of phaseRoles) {
      expect(sql).toContain(`'${role}'::name`);
      expect(sql).toMatch(
        new RegExp(
          `ALTER ROLE ${role}\\s+NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS\\s*;`,
          'u',
        ),
      );
    }
    expect(sql).toContain('$g0_07_phase_role_contract$');
    expect(sql).toContain('G0-07 phase roles must be NOLOGIN/NOINHERIT/NOBYPASSRLS');
    expect(sql).toContain('G0-07 phase roles must not inherit legacy or peer capabilities');
    expect(sql).not.toMatch(
      /GRANT\s+[\s\S]*?ba_(?:auth|authorization|run|billing|archive_evidence)_owner[\s\S]*?TO\s+ba_(?:internal_service_attestation_issuer|admission_executor|execution_executor|metering_executor|finalizer_executor|reclaimer_executor|reconciliation_executor|archive_evidence_executor|retention_executor)/u,
    );
  });

  it('enrolls one test login per capability plus a same-phase wrong-session login', async () => {
    const sql = await readFile(
      path.join(repositoryDirectory, 'infra', 'test', 'postgres', 'bootstrap-test.sql'),
      'utf8',
    );

    for (const [login, role] of phaseTestLoginGraph) {
      expect(sql).toMatch(
        new RegExp(
          `CREATE ROLE ${login}\\s+LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS\\s+IN ROLE ${role}\\s*;`,
          'u',
        ),
      );
    }
    expect(sql).toContain('$g0_07_test_login_contract$');
    expect(sql).toContain('G0-07 test login membership graph is incomplete or has extra edges');
    expect(sql).toContain('G0-07 test logins must not inherit legacy executable or owner roles');
    expect(sql).toMatch(
      /GRANT CONNECT ON DATABASE better_agent_test TO[\s\S]*?ba_internal_service_attestation_issuer[\s\S]*?ba_retention_executor\s*;/u,
    );
    expect(sql).toMatch(
      /GRANT USAGE ON SCHEMA public TO[\s\S]*?ba_internal_service_attestation_issuer[\s\S]*?ba_retention_executor\s*;/u,
    );
    for (const role of phaseRoles) {
      expect(sql).not.toMatch(
        new RegExp(`GRANT (?:CREATE|TEMPORARY|TEMP)[^;]*TO[^;]*${role}`, 'u'),
      );
    }
  });
});

describe('005 runtime-security migration static red gate', () => {
  it('pins every PostgreSQL integration suite to its reviewed migration milestone', async () => {
    const milestoneCases = [
      ['run-auth-rls-integration.mjs', '005'],
      ['run-release-deployment-integration.mjs', '005'],
      ['run-run-billing-integration.mjs', '004'],
      ['run-run-conversation-browser-integration.mjs', '004'],
      ['run-runtime-security-integration.mjs', '005'],
    ] as const;

    for (const [fileName, throughId] of milestoneCases) {
      const source = await readFile(
        path.join(repositoryDirectory, 'infra', 'test', 'postgres', fileName),
        'utf8',
      );
      expect(source, `${fileName} must select an explicit migration milestone`).toMatch(
        new RegExp(`selectMigrationMilestone\\(\\s*loadedMigrations,\\s*'${throughId}'\\s*,`, 'u'),
      );
      expect(source, `${fileName} must not render the moving migration head`).not.toMatch(
        /renderUpMigrationSql\(loadedMigrations\)/u,
      );
    }

    const migrationSuite = await readFile(
      path.join(repositoryDirectory, 'infra', 'test', 'postgres', 'run-integration.mjs'),
      'utf8',
    );
    expect(migrationSuite).toContain("prefixThrough(migrations, '005')");
  });

  it('adds the exact reviewed migration pair without changing 000 through 004', async () => {
    for (const [fileName, digest] of Object.entries(frozenLegacyMigrationDigests)) {
      const bytes = await readFile(path.join(migrationDirectory, fileName));
      expect(createHash('sha256').update(bytes).digest('hex'), fileName).toBe(digest);
    }

    const migrations = await loadMigrations(migrationDirectory);
    const migration = migrations.find(({ id }) => id === '005');
    expect(migration).toMatchObject({ id: '005', name: 'runtime_security', version: 5 });
    expect(migration?.downSql).toBeDefined();
    expect(renderUpMigrationSql(migrations)).toContain('\\if :ba_apply_005');
    expect(renderDownMigrationSql(migrations, 4, { allowDown: true })).toContain(
      '\\if :ba_revert_005',
    );

    const g006Sql = migrations.find(({ id }) => id === '004')?.upSql ?? '';
    for (const role of phaseRoles) expect(g006Sql).not.toContain(role);
  });

  it('makes one complete NOWAIT lock the first up/down statement', async () => {
    const { downSql, upSql } = await runtimeSecuritySql();
    expect(firstLockInventory(upSql)).toEqual([...legacyQuiescenceInventory]);

    const newRelations = createdRelationInventory(upSql);
    for (const relation of [
      'auth.internal_service_attestations',
      'public.run_billing_authority_receipts',
      'public.run_dispatch_retirement_receipts',
      'public.run_recovery_ticket_dispositions',
    ]) {
      expect(newRelations).toContain(relation);
    }
    expect(
      newRelations.some((relation) => relation.endsWith('.finalizer_transaction_claims')),
    ).toBe(true);
    expect(firstLockInventory(downSql)).toEqual([
      ...legacyQuiescenceInventory,
      ...newRelations.filter(
        (relation) =>
          !legacyQuiescenceInventory.includes(
            relation as (typeof legacyQuiescenceInventory)[number],
          ),
      ),
    ]);
  });

  it('scans FORCE-RLS legacy facts as their exact owners and restores FORCE before persistent DDL', async () => {
    const { upSql } = await runtimeSecuritySql();
    const persistentDdl = upSql.indexOf('GRANT USAGE, CREATE ON SCHEMA app TO');
    const prerequisite = upSql.match(
      /DO \$g007_platform_prerequisites\$[\s\S]*?\$g007_platform_prerequisites\$;/u,
    )?.[0];

    expect(prerequisite).toMatch(/relowner/u);
    expect(prerequisite).toMatch(/relrowsecurity/u);
    expect(prerequisite).toMatch(/relforcerowsecurity/u);
    expect(upSql).not.toContain('DISABLE ROW LEVEL SECURITY');

    for (const [owner, relations] of Object.entries(legacyOwnerPreflightRelations)) {
      const guardName = owner === 'ba_run_owner' ? 'g007_legacy_run_guard' : 'g007_legacy_guard';
      const roleStart = upSql.indexOf(`SET LOCAL ROLE ${owner};`);
      const guardStart = upSql.indexOf(`DO $${guardName}$`, roleStart);
      const guardEnd = upSql.indexOf(`$${guardName}$;`, guardStart);
      const roleReset = upSql.indexOf('RESET ROLE;', guardEnd);

      expect(roleStart, `${owner} preflight must assume the exact table owner`).toBeGreaterThan(-1);
      expect(guardStart).toBeGreaterThan(roleStart);
      expect(guardEnd).toBeGreaterThan(guardStart);
      expect(roleReset).toBeGreaterThan(guardEnd);
      expect(persistentDdl).toBeGreaterThan(roleReset);
      if (owner === 'ba_run_owner') {
        expect(upSql.indexOf('SET LOCAL ROLE ba_billing_owner;')).toBeGreaterThan(roleReset);
      }

      for (const relation of relations) {
        const [schema, table] = relation.split('.');
        expect(prerequisite).toContain(`('${schema}', '${table}', '${owner}')`);
        const noForce = upSql.indexOf(
          `ALTER TABLE ${relation} NO FORCE ROW LEVEL SECURITY;`,
          roleStart,
        );
        const restoreForce = upSql.indexOf(
          `ALTER TABLE ${relation} FORCE ROW LEVEL SECURITY;`,
          guardEnd,
        );
        expect(noForce, `${relation} must be owner-visible during preflight`).toBeGreaterThan(
          roleStart,
        );
        expect(noForce).toBeLessThan(guardStart);
        expect(restoreForce, `${relation} must restore FORCE RLS`).toBeGreaterThan(guardEnd);
        expect(restoreForce).toBeLessThan(roleReset);
        expect(upSql.split(`ALTER TABLE ${relation} NO FORCE ROW LEVEL SECURITY;`)).toHaveLength(2);
        expect(upSql.split(`ALTER TABLE ${relation} FORCE ROW LEVEL SECURITY;`)).toHaveLength(2);
      }
    }
  });

  it('runs the down protocol-v5 column guards through exact owners without weakening RLS', async () => {
    const { downSql } = await runtimeSecuritySql();
    const ownerGuards = {
      ba_billing_owner: {
        guard: 'g007_down_billing_guard',
        relations: ['public.credits_ledger'],
      },
      ba_run_owner: {
        guard: 'g007_down_run_guard',
        relations: ['public.run_attempts', 'public.run_checkpoints', 'public.outbox'],
      },
    } as const;
    const persistentDdl = downSql.indexOf('GRANT USAGE, CREATE ON SCHEMA app TO');

    expect(downSql).not.toContain('DISABLE ROW LEVEL SECURITY');
    for (const [owner, { guard, relations }] of Object.entries(ownerGuards)) {
      const roleStart = downSql.indexOf(`SET LOCAL ROLE ${owner};`);
      const guardStart = downSql.indexOf(`DO $${guard}$`, roleStart);
      const guardEnd = downSql.indexOf(`$${guard}$;`, guardStart);
      const roleReset = downSql.indexOf('RESET ROLE;', guardEnd);
      expect(roleStart).toBeGreaterThan(-1);
      expect(guardStart).toBeGreaterThan(roleStart);
      expect(guardEnd).toBeGreaterThan(guardStart);
      expect(roleReset).toBeGreaterThan(guardEnd);
      expect(persistentDdl).toBeGreaterThan(roleReset);
      for (const relation of relations) {
        expect(
          downSql.indexOf(`ALTER TABLE ${relation} NO FORCE ROW LEVEL SECURITY;`, roleStart),
        ).toBeLessThan(guardStart);
        expect(
          downSql.indexOf(`ALTER TABLE ${relation} FORCE ROW LEVEL SECURITY;`, guardEnd),
        ).toBeLessThan(roleReset);
      }
    }
  });

  it('runs role prerequisites and owner-visible legacy preflight before persistent 005 DDL', async () => {
    const { upSql } = await runtimeSecuritySql();
    const lockEnd = upSql.indexOf('IN ACCESS EXCLUSIVE MODE NOWAIT;');
    const prerequisite = upSql.match(
      /DO \$g007_platform_prerequisites\$[\s\S]*?\$g007_platform_prerequisites\$;/u,
    );
    const runLegacy = upSql.match(
      /DO \$g007_legacy_run_guard\$[\s\S]*?\$g007_legacy_run_guard\$;/u,
    );
    const billingLegacy = upSql.match(/DO \$g007_legacy_guard\$[\s\S]*?\$g007_legacy_guard\$;/u);
    const runRoleStart = upSql.indexOf('SET LOCAL ROLE ba_run_owner;');
    const billingRoleStart = upSql.indexOf('SET LOCAL ROLE ba_billing_owner;', runRoleStart);
    const billingRoleReset = upSql.indexOf(
      'RESET ROLE;',
      (billingLegacy?.index ?? 0) + (billingLegacy?.[0].length ?? 0),
    );
    const firstPersistentDdl = upSql.indexOf('GRANT USAGE, CREATE ON SCHEMA app TO');

    expect(lockEnd).toBeGreaterThan(-1);
    expect(prerequisite?.index).toBeGreaterThan(lockEnd);
    expect(runRoleStart).toBeGreaterThan(prerequisite?.index ?? Number.MAX_SAFE_INTEGER);
    expect(runLegacy?.index).toBeGreaterThan(runRoleStart);
    expect(billingRoleStart).toBeGreaterThan(
      (runLegacy?.index ?? 0) + (runLegacy?.[0].length ?? 0),
    );
    expect(billingLegacy?.index).toBeGreaterThan(billingRoleStart);
    expect(billingRoleReset).toBeGreaterThan(
      (billingLegacy?.index ?? 0) + (billingLegacy?.[0].length ?? 0),
    );
    expect(firstPersistentDdl).toBeGreaterThan(billingRoleReset);
    expect(upSql.indexOf('CREATE TABLE auth.internal_service_attestations')).toBeGreaterThan(
      firstPersistentDdl,
    );
    for (const role of phaseRoles) expect(prerequisite?.[0]).toContain(`'${role}'`);
    expect(prerequisite?.[0]).toMatch(/pg_catalog\.pg_auth_members/u);
    expect(prerequisite?.[0]).toMatch(/ERRCODE\s*=\s*'42501'/u);
    expect(
      prerequisite?.[0].match(/WHERE login_role\.rolcanlogin\s+AND NOT login_role\.rolsuper/gu),
      'superusers are implicit members of every role and must not be classified as phase logins',
    ).toHaveLength(2);
    expect(runLegacy?.[0]).toMatch(/ERRCODE\s*=\s*'55000'/u);
    expect(billingLegacy?.[0]).toMatch(/ERRCODE\s*=\s*'55000'/u);
    expect(billingLegacy?.[0]).toContain('9007199254740991');
    expect(billingLegacy?.[0]).toMatch(/v_ledger\.balance_version NOT BETWEEN 0 AND v_safe_max/u);
    for (const snapshot of [
      'balance_before',
      'reserved_before',
      'balance_after',
      'reserved_after',
    ]) {
      expect(billingLegacy?.[0]).not.toContain(`v_ledger.${snapshot} NOT BETWEEN 0 AND v_safe_max`);
    }
    const legacyGuards = `${runLegacy?.[0] ?? ''}\n${billingLegacy?.[0] ?? ''}`;
    for (const fact of [
      'public.runs',
      'public.run_attempts',
      'public.outbox',
      'public.credit_reservations',
      'public.run_budget_allocations',
      'public.credits_ledger',
    ]) {
      expect(legacyGuards).toContain(fact);
    }

    const legacyGuard = billingLegacy?.[0] ?? '';
    expect(legacyGuard).toMatch(/FOR\s+v_ledger\s+IN[\s\S]*?FROM public\.credits_ledger/u);
    expect(legacyGuard).toMatch(
      /LEFT JOIN public\.credit_reservations[\s\S]*?LEFT JOIN public\.run_billing_reconciliations/u,
    );
    for (const intentKind of ['RESERVE', 'SETTLE', 'RELEASE', 'EXPIRED', 'RECONCILIATION']) {
      expect(legacyGuard, `missing BillingIntentV1 reconstruction for ${intentKind}`).toContain(
        `'${intentKind}'`,
      );
    }
    expect(legacyGuard).toMatch(
      /'schema_version',\s*'billing-intent\/1'[\s\S]*?'billing_owner_run_id'[\s\S]*?'reservation_id'[\s\S]*?'charge_key'/u,
    );
    expect(legacyGuard).toMatch(
      /string_agg\([\s\S]*?to_json\(intent_field\.key\)::text[\s\S]*?jsonb_typeof\(intent_field\.value\)[\s\S]*?ORDER BY intent_field\.key COLLATE "C"/u,
    );
    expect(legacyGuard).toMatch(
      /'sha256:'\s*\|\|\s*encode\([\s\S]*?public\.digest\([\s\S]*?convert_to\(v_canonical_intent,\s*'UTF8'\)[\s\S]*?'sha256'/u,
    );
    expect(legacyGuard).toMatch(
      /v_expected_intent_hash\s+IS DISTINCT FROM\s+v_ledger\.billing_intent_hash/u,
    );
    expect(legacyGuard).toMatch(
      /reservation_accepted_plan_hash IS NULL[\s\S]*?reservation_accepted_plan_hash\s*!~\s*'\^sha256:\[0-9a-f\]\{64\}\$'/u,
    );
    expect(legacyGuard).toMatch(
      /reconciliation_id IS NULL[\s\S]*?reconciliation_billing_intent_hash IS DISTINCT FROM[\s\S]*?reconciliation_evidence_sha256 IS DISTINCT FROM/u,
    );
    expect(legacyGuard).toContain(
      'through-004 ledger does not satisfy CreditLedgerEntryV1: workspace %, ledger %',
    );
    expect(legacyGuard).toContain(
      'through-004 ledger BillingIntentV1 hash mismatch: workspace %, ledger %',
    );
    expect(legacyGuard).toMatch(
      /v_ledger\.entry_kind\s*=\s*'SETTLE'[\s\S]*?available_delta_credits\s*=\s*0[\s\S]*?reserved_delta_credits\s*=\s*-v_ledger\.settled_delta_credits/u,
    );
    expect(legacyGuard).toMatch(
      /v_ledger\.entry_kind\s+IN\s*\('RELEASE',\s*'EXPIRED'\)[\s\S]*?reserved_delta_credits\s*=\s*-v_ledger\.available_delta_credits/u,
    );
  });

  it('temporarily grants schema creation only for ownership transfer and revokes it on up/down', async () => {
    const { downSql, upSql } = await runtimeSecuritySql();
    const legacyGuardEnd = upSql.indexOf(
      '$g007_legacy_guard$;',
      upSql.indexOf('DO $g007_legacy_guard$'),
    );
    const upGrant = upSql.indexOf('GRANT USAGE, CREATE ON SCHEMA app TO');
    const firstRuntimeTable = upSql.indexOf('CREATE TABLE auth.internal_service_attestations');

    expect(upGrant).toBeGreaterThan(legacyGuardEnd);
    expect(firstRuntimeTable).toBeGreaterThan(upGrant);
    expect(upSql).toMatch(/GRANT CREATE ON SCHEMA public TO\s+ba_run_owner,\s+ba_billing_owner;/u);
    expect(upSql.slice(upGrant, firstRuntimeTable)).not.toContain('ba_auth_owner');
    expect(upSql).not.toMatch(/GRANT (?:USAGE, )?CREATE ON SCHEMA auth TO ba_auth_owner/u);
    expect(upSql).toMatch(
      /REVOKE CREATE ON SCHEMA app FROM[\s\S]*?ba_retention;[\s\S]*?REVOKE CREATE ON SCHEMA public FROM\s+ba_run_owner,\s+ba_billing_owner;/u,
    );
    expect(upSql).not.toMatch(/REVOKE CREATE ON SCHEMA auth FROM ba_auth_owner/u);

    const downGuardEnd = downSql.indexOf(
      '$g007_down_guard$;',
      downSql.indexOf('DO $g007_down_guard$'),
    );
    const downGrant = downSql.indexOf('GRANT USAGE, CREATE ON SCHEMA app TO');
    expect(downGrant).toBeGreaterThan(downGuardEnd);
    expect(downSql.slice(downGrant, downSql.indexOf('REVOKE EXECUTE ON FUNCTION'))).not.toContain(
      'ba_auth_owner',
    );
    expect(downSql).not.toMatch(/GRANT (?:USAGE, )?CREATE ON SCHEMA auth TO ba_auth_owner/u);
    expect(downSql.lastIndexOf('REVOKE CREATE ON SCHEMA app FROM')).toBeGreaterThan(
      downSql.lastIndexOf('ALTER FUNCTION app.finalize_run(jsonb) OWNER TO ba_run_owner;'),
    );
    expect(downSql).not.toMatch(/REVOKE CREATE ON SCHEMA auth FROM ba_auth_owner/u);
  });

  it('grants phase roles only the schema USAGE required to resolve their exact facades', async () => {
    const { downSql, upSql } = await runtimeSecuritySql();
    const issuerGrant = upSql.match(
      /GRANT USAGE ON SCHEMA auth TO ba_internal_service_attestation_issuer;/u,
    )?.[0];
    const executorGrant = upSql.match(
      /GRANT USAGE ON SCHEMA app, auth TO[\s\S]*?ba_retention_executor;/u,
    )?.[0];
    const executorRevoke = downSql.match(
      /REVOKE USAGE ON SCHEMA app, auth FROM[\s\S]*?ba_retention_executor;/u,
    )?.[0];

    expect(issuerGrant).toBeDefined();
    expect(executorGrant).not.toContain('ba_internal_service_attestation_issuer');
    expect(downSql).toContain(
      'REVOKE USAGE ON SCHEMA auth FROM ba_internal_service_attestation_issuer;',
    );
    for (const role of phaseExecutorRoles) {
      expect(executorGrant).toContain(role);
      expect(executorRevoke).toContain(role);
    }
    for (const role of phaseRoles) {
      expect(upSql).not.toMatch(new RegExp(`GRANT CREATE ON SCHEMA [^;]+ TO[^;]*${role}`, 'u'));
    }
  });

  it('grants only the missing auth schema resolution capability to phase-function owners', async () => {
    const { downSql, upSql } = await runtimeSecuritySql();
    const owners = ['ba_archive_evidence_owner', 'ba_billing_owner', 'ba_retention'];
    const ownerGrant = upSql.match(
      /GRANT USAGE ON SCHEMA auth TO\s+ba_billing_owner,\s+ba_archive_evidence_owner,\s+ba_retention;/u,
    )?.[0];
    const ownerRevoke = downSql.match(
      /REVOKE USAGE ON SCHEMA auth FROM\s+ba_billing_owner,\s+ba_archive_evidence_owner,\s+ba_retention;/u,
    )?.[0];

    expect(ownerGrant).toBeDefined();
    expect(ownerRevoke).toBeDefined();
    for (const owner of owners) {
      expect(upSql).not.toMatch(
        new RegExp(`GRANT (?:USAGE, )?CREATE ON SCHEMA auth TO[^;]*${owner}`, 'u'),
      );
    }
    expect(ownerGrant).not.toContain('ba_run_owner');
    expect(ownerRevoke).not.toContain('ba_run_owner');
  });

  it('keeps run-owned reservation inspection workspace-scoped and column-read-only', async () => {
    const { downSql, upSql } = await runtimeSecuritySql();
    const policy = upSql.match(
      /CREATE POLICY credit_reservations_g007_run_owner_read\s+ON public\.credit_reservations\s+FOR SELECT TO ba_run_owner\s+USING \(workspace_id = app\.current_workspace_id\(\)\);/u,
    )?.[0];
    const upGrant = upSql.match(
      /GRANT SELECT \(([\s\S]*?)\) ON TABLE public\.credit_reservations TO ba_run_owner;/u,
    );
    const downRevoke = downSql.match(
      /REVOKE SELECT \(([\s\S]*?)\) ON TABLE public\.credit_reservations FROM ba_run_owner;/u,
    );
    const expectedColumns = [
      'billing_owner_run_id',
      'id',
      'released_credits',
      'reserved_credits',
      'run_id',
      'settled_credits',
      'status',
      'workspace_id',
    ];
    const parseColumns = (columns: string | undefined): string[] =>
      (columns ?? '')
        .split(',')
        .map((column) => column.trim())
        .filter((column) => column.length > 0)
        .sort();
    const runOwnerReservationGrants = [
      ...upSql.matchAll(/GRANT[^;]*ON(?: TABLE)? public\.credit_reservations TO ba_run_owner;/gu),
    ].map(([grant]) => grant);
    const runOwnerReservationPolicies = [
      ...upSql.matchAll(
        /CREATE POLICY[^;]*ON public\.credit_reservations[^;]*TO ba_run_owner[^;]*;/gu,
      ),
    ].map(([reservationPolicy]) => reservationPolicy);

    expect(policy).toMatch(/FOR SELECT TO ba_run_owner/u);
    expect(parseColumns(upGrant?.[1])).toEqual(expectedColumns);
    expect(parseColumns(downRevoke?.[1])).toEqual(expectedColumns);
    expect(runOwnerReservationGrants).toEqual([upGrant?.[0]]);
    expect(runOwnerReservationPolicies).toEqual([policy]);
    expect(downSql).toMatch(
      /DROP POLICY credit_reservations_g007_run_owner_read\s+ON public\.credit_reservations;/u,
    );
    expect(upSql).not.toMatch(
      /GRANT[^;]*\b(?:INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)\b[^;]*ON TABLE public\.credit_reservations TO ba_run_owner;/u,
    );
    expect(upSql).not.toMatch(
      /CREATE POLICY[^;]*ON public\.credit_reservations[^;]*FOR (?:ALL|INSERT|UPDATE|DELETE) TO ba_run_owner/u,
    );

    for (const name of [
      'record_leased_termination_intent',
      'finalize_attributed_run',
      'finalize_claimed_run',
    ]) {
      const entry = functionOracle.find((candidate) => candidate.name === name);
      expect(entry, `missing function oracle for ${name}`).toBeDefined();
      if (entry === undefined) continue;
      const definition = requireFunctionDefinition(upSql, entry);
      const reservationRead = definition.match(
        /SELECT\s+reservation\.id,\s*reservation\.status,\s*reservation\.reserved_credits,\s*reservation\.settled_credits,\s*reservation\.released_credits[\s\S]*?FROM public\.credit_reservations AS reservation[\s\S]*?;/u,
      )?.[0];

      expect(definition).toMatch(/v_reservation record;/u);
      expect(reservationRead, `${name} must use the reviewed reservation projection`).toBeDefined();
      expect(reservationRead).not.toMatch(/FOR (?:NO KEY )?UPDATE/u);
      expect(definition).not.toMatch(/SELECT\s+reservation\.\*/u);

      if (name !== 'record_leased_termination_intent') {
        const workspaceFence = definition.indexOf(
          'PERFORM app.lock_finalizer_workspace_billing_fence()',
        );
        const reservationReadIndex = definition.indexOf(
          'FROM public.credit_reservations AS reservation',
        );
        expect(workspaceFence).toBeGreaterThanOrEqual(0);
        expect(reservationReadIndex).toBeGreaterThan(workspaceFence);
      }
    }
  });

  it('serializes every active reservation writer behind the Workspace billing fence', async () => {
    const { upSql } = await runtimeSecuritySql();
    const writers = [
      ...functionOracle.filter(({ name }) =>
        ['apply_credit_settlement_kernel', 'apply_credit_release_kernel'].includes(name),
      ),
      ...replacedFunctionOracle.filter(({ name }) =>
        ['settle_credits', 'release_credits'].includes(name),
      ),
    ];

    expect(writers).toHaveLength(4);
    for (const entry of writers) {
      const definition = requireFunctionDefinition(upSql, entry);
      const workspaceFence = definition.indexOf('FROM public.workspaces AS workspace_row');
      const reservationLock = definition.indexOf('FROM public.credit_reservations AS reservation');
      const reservationMutation = definition.indexOf('UPDATE public.credit_reservations');

      expect(workspaceFence, `${entry.name} must lock the Workspace first`).toBeGreaterThanOrEqual(
        0,
      );
      expect(reservationLock, `${entry.name} must inspect the reservation`).toBeGreaterThan(
        workspaceFence,
      );
      expect(
        definition.slice(workspaceFence, reservationLock),
        `${entry.name} must use the global billing fence`,
      ).toContain('FOR NO KEY UPDATE');
      expect(
        definition.slice(reservationLock, reservationMutation),
        `${entry.name} must lock the reservation before mutation`,
      ).toContain('FOR UPDATE');
      expect(
        reservationMutation,
        `${entry.name} must mutate only after both locks`,
      ).toBeGreaterThan(reservationLock);
    }
  });

  it('fails closed before a non-zero billing write can exceed the safe balance version', async () => {
    const { upSql } = await runtimeSecuritySql();
    const writers = [
      ...functionOracle.filter(({ name }) =>
        ['apply_credit_settlement_kernel', 'apply_credit_release_kernel'].includes(name),
      ),
      ...replacedFunctionOracle.filter(({ name }) =>
        ['settle_credits', 'release_credits'].includes(name),
      ),
    ];

    expect(writers).toHaveLength(4);
    for (const entry of writers) {
      const definition = requireFunctionDefinition(upSql, entry);
      const amount = entry.name.startsWith('apply_credit_') ? 'v_amount' : 'p_amount_credits';
      const workspaceFence = definition.indexOf('FROM public.workspaces AS workspace_row');
      const serializedReplay = definition.indexOf('RETURN v_existing.', workspaceFence);
      const versionGuard = definition.indexOf('v_version >= 9007199254740991');
      const firstMutation = Math.min(
        ...['UPDATE public.workspaces', 'UPDATE public.credit_reservations', 'INSERT INTO public.']
          .map((statement) => definition.indexOf(statement))
          .filter((index) => index >= 0),
      );

      expect(serializedReplay, `${entry.name} must preserve exact replay first`).toBeGreaterThan(
        workspaceFence,
      );
      expect(versionGuard, `${entry.name} must enforce the safe version ceiling`).toBeGreaterThan(
        serializedReplay,
      );
      expect(
        definition.slice(serializedReplay, versionGuard + 160),
        `${entry.name} must allow zero-credit writes to preserve their version`,
      ).toContain(`${amount} <> 0`);
      expect(definition.slice(versionGuard, versionGuard + 200)).toMatch(
        /RAISE EXCEPTION[\s\S]*?USING ERRCODE = '22003'/u,
      );
      expect(versionGuard, `${entry.name} must reject before any mutation`).toBeLessThan(
        firstMutation,
      );
    }
  });

  it('enforces the safe balance version at every authoritative persistence layer', async () => {
    const { downSql, upSql } = await runtimeSecuritySql();
    const safeVersionConstraints = [
      {
        column: 'credits_balance_version',
        constraint: 'workspaces_credits_balance_version_safe_check',
        relation: 'workspaces',
      },
      {
        column: 'balance_version',
        constraint: 'credit_reservations_balance_version_safe_check',
        relation: 'credit_reservations',
      },
      {
        column: 'balance_version',
        constraint: 'credits_ledger_balance_version_safe_check',
        relation: 'credits_ledger',
      },
    ] as const;

    for (const { column, constraint, relation } of safeVersionConstraints) {
      expect(upSql).toMatch(
        new RegExp(
          `ALTER TABLE public\\.${relation}[\\s\\S]*?ADD CONSTRAINT ${constraint}[\\s\\S]*?CHECK \\(\\s*${column} BETWEEN 0 AND 9007199254740991\\s*\\)`,
          'u',
        ),
      );
      expect(downSql).toMatch(
        new RegExp(`ALTER TABLE public\\.${relation}[\\s\\S]*?DROP CONSTRAINT ${constraint}`, 'u'),
      );
    }
  });

  it('routes metering Run/source inspection through narrow run-owner capabilities', async () => {
    const { upSql } = await runtimeSecuritySql();
    const helperEntry = functionOracle.find(
      ({ name }) => name === 'lock_open_run_for_attributed_settlement',
    );
    const facadeEntry = functionOracle.find(({ name }) => name === 'settle_attributed_credits');
    const applyEntry = functionOracle.find(({ name }) => name === 'apply_attributed_settlement');

    expect(helperEntry).toBeDefined();
    expect(facadeEntry).toBeDefined();
    expect(applyEntry).toBeDefined();
    if (helperEntry === undefined || facadeEntry === undefined || applyEntry === undefined) return;
    const helper = requireFunctionDefinition(upSql, helperEntry);
    const facade = requireFunctionDefinition(upSql, facadeEntry);
    const apply = requireFunctionDefinition(upSql, applyEntry);

    expect(helper).toMatch(/FROM public\.runs AS run_row[\s\S]*?FOR UPDATE/u);
    expect(helper).toMatch(
      /status IN \('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION'\)[\s\S]*?billing_state = 'NEEDS_ATTENTION'[\s\S]*?terminal_intent_hash IS NOT NULL/u,
    );
    expect(facade).toMatch(/PERFORM app\.lock_open_run_for_attributed_settlement\(/u);
    expect(facade).toMatch(/v_ledger_id := app\.apply_attributed_settlement\(p_fact\);/u);
    expect(facade).not.toMatch(/FROM public\.(?:runs|run_usage_attributions)/u);
    const firstReplay = facade.indexOf('SELECT receipt.* INTO v_existing');
    const workspaceLock = facade.indexOf('PERFORM 1 FROM public.workspaces');
    const serializedReplay = facade.indexOf('SELECT receipt.* INTO v_existing', workspaceLock);
    const runGate = facade.indexOf('PERFORM app.lock_open_run_for_attributed_settlement');
    expect(firstReplay, 'exact replay must bypass mutation locks').toBeGreaterThanOrEqual(0);
    expect(workspaceLock, 'committed miss must serialize on Workspace').toBeGreaterThan(
      firstReplay,
    );
    expect(
      serializedReplay,
      'a Workspace-lock waiter must recheck committed replay',
    ).toBeGreaterThan(workspaceLock);
    expect(runGate, 'Run admission must follow serialized replay').toBeGreaterThan(
      serializedReplay,
    );
    expect(facade.match(/'amount', v_existing\.amount::text/gu)).toHaveLength(3);
    expect(facade).not.toMatch(/'amount', v_existing\.amount(?:,|\s*\))/u);
    expect(apply).toMatch(
      /p_fact \? 'reservation_id'[\s\S]*?v_source ->> 'reservation_id' IS DISTINCT FROM p_fact ->> 'reservation_id'/u,
    );
    expect(upSql).not.toMatch(
      /GRANT[^;]*(?:SELECT|UPDATE)[^;]*ON(?: TABLE)? public\.(?:runs|run_usage_attributions) TO ba_billing_owner;/u,
    );
  });

  it('routes both run-owner finalizers through one billing-owned Workspace fence', async () => {
    const { downSql, upSql } = await runtimeSecuritySql();
    const helperEntry = functionOracle.find(
      ({ name }) => name === 'lock_finalizer_workspace_billing_fence',
    );

    expect(helperEntry).toBeDefined();
    if (helperEntry === undefined) return;
    const helper = requireFunctionDefinition(upSql, helperEntry);

    expect(helper).toMatch(/auth\.require_internal_service_phase\('finalizer'\)/u);
    expect(helper).toMatch(/FROM public\.workspaces AS workspace_row[\s\S]*?FOR NO KEY UPDATE/u);
    for (const name of ['finalize_attributed_run', 'finalize_claimed_run']) {
      const entry = functionOracle.find((candidate) => candidate.name === name);
      expect(entry).toBeDefined();
      if (entry === undefined) continue;
      const definition = requireFunctionDefinition(upSql, entry);
      const workspaceFence = definition.indexOf(
        'PERFORM app.lock_finalizer_workspace_billing_fence()',
      );
      const runLock = definition.indexOf('FROM public.runs AS run_row');

      expect(workspaceFence, `${name} must acquire the billing fence`).toBeGreaterThanOrEqual(0);
      expect(runLock, `${name} must lock the Run after the Workspace`).toBeGreaterThan(
        workspaceFence,
      );
      expect(definition).not.toMatch(/FROM public\.workspaces/u);
    }
    expect(upSql).not.toMatch(
      /GRANT[^;]*(?:SELECT|UPDATE)[^;]*ON(?: TABLE)? public\.workspaces TO ba_run_owner;/u,
    );
    expect(downSql).toMatch(/DROP FUNCTION app\.lock_finalizer_workspace_billing_fence\(\);/u);
  });

  it('seals every execution and dispatch authority path after termination attribution', async () => {
    const { upSql } = await runtimeSecuritySql();
    const privateDispatchValidator: FunctionOracle = {
      args: 'jsonb',
      grantees: [],
      name: 'require_run_dispatch_lease',
      owner: 'ba_run_owner',
      returns: 'jsonb',
      schema: 'app',
    };
    const entries = [
      functionOracle.find(({ name }) => name === 'require_execution_owner_lease'),
      functionOracle.find(({ name }) => name === 'claim_run_attempt'),
      privateDispatchValidator,
      functionOracle.find(({ name }) => name === 'claim_run_dispatch'),
    ];

    for (const entry of entries) {
      expect(entry).toBeDefined();
      if (entry === undefined) continue;
      const definition = requireFunctionDefinition(upSql, entry);
      const resourceLock = definition.search(
        entry.name.includes('dispatch')
          ? /FROM public\.outbox AS message/u
          : /FROM public\.run_attempts AS attempt/u,
      );
      const terminationGuard = definition.search(
        /EXISTS\s*\(\s*SELECT 1\s*FROM public\.run_termination_intents AS source\s*WHERE source\.workspace_id = v_workspace_id\s*AND source\.run_id = v_run\.id\s*\)/u,
      );

      expect(terminationGuard, `${entry.name} must reject a sealed Run`).toBeGreaterThanOrEqual(0);
      expect(resourceLock, `${entry.name} must lock its execution resource`).toBeGreaterThan(
        terminationGuard,
      );
    }
  });

  it('installs the exact SECURITY DEFINER owner and direct-grantee oracle', async () => {
    const { upSql } = await runtimeSecuritySql();

    for (const entry of functionOracle) {
      const definition = requireFunctionDefinition(upSql, entry);
      const signature = signaturePattern(entry);
      expect(definition).toMatch(new RegExp(`RETURNS\\s+${entry.returns}\\b`, 'u'));
      expect(definition).toContain('SECURITY DEFINER');
      expect(definition).toMatch(/SET search_path = pg_catalog, public, auth, app, pg_temp\s/u);
      expect(upSql).toMatch(
        new RegExp(`ALTER FUNCTION ${signature} OWNER TO ${entry.owner}\\s*;`, 'u'),
      );
      expect(upSql).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC\\s*;`, 'u'),
      );
      expect(directGrantRoles(upSql, entry)).toEqual([...entry.grantees].sort());
    }
  });

  it('forward-replaces only the five reviewed 004 functions and restores their bodies on down', async () => {
    const { downSql, upSql } = await runtimeSecuritySql();
    const g006Sql = await readFile(path.join(migrationDirectory, '004_run_billing.up.sql'), 'utf8');

    for (const entry of replacedFunctionOracle) {
      const upDefinition = requireFunctionDefinition(upSql, entry);
      const restoredDefinition = requireFunctionDefinition(downSql, entry);
      const legacyDefinition = requireFunctionDefinition(g006Sql, entry);
      const signature = signaturePattern(entry);

      expect(upDefinition).toMatch(new RegExp(`RETURNS\\s+${entry.returns}\\b`, 'u'));
      expect(upSql).toMatch(
        new RegExp(`ALTER FUNCTION ${signature} OWNER TO ${entry.owner}\\s*;`, 'u'),
      );
      expect(canonicalFunctionBody(restoredDefinition)).toBe(
        canonicalFunctionBody(legacyDefinition),
      );
      expect(downSql).toMatch(
        new RegExp(`ALTER FUNCTION ${signature} OWNER TO ${entry.owner}\\s*;`, 'u'),
      );
    }

    for (const role of phaseRoles) {
      expect(upSql).not.toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION app\\.(?:current_workspace_id|current_authenticated_principal_id|settle_credits|release_credits|finalize_run)\\([^;]*TO[^;]*${role}`,
          'u',
        ),
      );
    }
  });

  it('binds ledger /2 rows one-to-one to immutable authority receipts while preserving /1 shape', async () => {
    const { upSql } = await runtimeSecuritySql();
    const receiptTable = upSql.match(
      /CREATE TABLE public\.run_billing_authority_receipts\s*\([\s\S]*?\n\);/u,
    )?.[0];

    expect(receiptTable).toBeDefined();
    expect(receiptTable).toMatch(
      /authority_kind\s+text[\s\S]*?CHECK\s*\(authority_kind IN\s*\(\s*'EXECUTION_USAGE',\s*'EXECUTION_TERMINATION',\s*'DURABLE_CANCEL'\s*\)\)/u,
    );
    expect(receiptTable).toMatch(/source_(?:authority_)?id\s+uuid\s+NOT NULL/u);
    expect(receiptTable).toMatch(/source_authority_(?:hash|sha256)\s+text\s+NOT NULL/u);
    expect(receiptTable).toMatch(/ledger_entry_id\s+uuid\s+NOT NULL/u);
    expect(receiptTable).toMatch(/UNIQUE\s*\(workspace_id, ledger_entry_id\)/u);
    expect(upSql).toMatch(
      /FOREIGN KEY\s*\(\s*workspace_id,\s*ledger_entry_id,\s*id,\s*authority_kind\s*\)[\s\S]*?REFERENCES public\.credits_ledger[\s\S]*?DEFERRABLE INITIALLY DEFERRED/u,
    );
    expect(upSql).toMatch(
      /FOREIGN KEY\s*\(\s*workspace_id,\s*authority_id,\s*authority_kind,\s*id\s*\)[\s\S]*?REFERENCES public\.run_billing_authority_receipts[\s\S]*?DEFERRABLE INITIALLY DEFERRED/u,
    );
    expect(upSql).toMatch(/entry_schema_version\s+integer[\s\S]*?IN\s*\(1, 2\)/u);
    expect(upSql).toMatch(
      /entry_schema_version\s*=\s*1[\s\S]*?authority_schema_version IS NULL[\s\S]*?authority_kind IS NULL[\s\S]*?authority_id IS NULL/u,
    );
    expect(upSql).toMatch(
      /entry_schema_version\s*=\s*2[\s\S]*?authority_schema_version\s*=\s*1[\s\S]*?authority_kind IS NOT NULL[\s\S]*?authority_id IS NOT NULL/u,
    );
    expect(receiptTable).toMatch(
      /authority_kind\s*=\s*'EXECUTION_USAGE'[\s\S]*?operation\s*=\s*'SETTLE'/u,
    );
    expect(receiptTable).toMatch(
      /authority_kind\s*=\s*'EXECUTION_TERMINATION'[\s\S]*?operation\s*=\s*'RELEASE'/u,
    );
    expect(receiptTable).toMatch(
      /authority_kind\s*=\s*'DURABLE_CANCEL'[\s\S]*?operation\s*=\s*'RELEASE'/u,
    );
    expect(upSql).toMatch(
      /entry_schema_version\s*=\s*2[\s\S]*?authority_kind\s*=\s*'EXECUTION_USAGE'[\s\S]*?entry_kind\s*=\s*'SETTLE'/u,
    );
    expect(upSql).toMatch(
      /entry_schema_version\s*=\s*2[\s\S]*?authority_kind\s*=\s*'EXECUTION_TERMINATION'[\s\S]*?entry_kind\s*=\s*'RELEASE'/u,
    );
    expect(upSql).toMatch(
      /entry_schema_version\s*=\s*2[\s\S]*?authority_kind\s*=\s*'DURABLE_CANCEL'[\s\S]*?entry_kind\s*=\s*'RELEASE'/u,
    );
    expect(upSql).toMatch(/CONSTRAINT[\s\S]*?DEFERRABLE INITIALLY DEFERRED/u);
  });

  it('deduplicates keyed effects without collapsing independent keyless envelopes', async () => {
    const { upSql } = await runtimeSecuritySql();
    const envelopeTable = upSql.match(
      /CREATE TABLE public\.run_retry_effect_envelopes\s*\([\s\S]*?\n\);/u,
    )?.[0];
    const receiptTable = upSql.match(
      /CREATE TABLE public\.run_side_effect_receipts\s*\([\s\S]*?\n\);/u,
    )?.[0];

    expect(envelopeTable).toBeDefined();
    expect(receiptTable).toBeDefined();
    expect(envelopeTable).toMatch(/step_id\s+uuid\s+NOT NULL/u);
    expect(envelopeTable).toMatch(/operation_intent_sha256\s+text\s+NOT NULL/u);
    expect(envelopeTable).toMatch(/effect_payload_sha256\s+text\s+NOT NULL/u);
    expect(envelopeTable).toMatch(/producer_lease_expires_at\s+timestamptz\s+NOT NULL/u);
    expect(envelopeTable).toMatch(
      /UNIQUE\s*\(\s*workspace_id,\s*run_id,\s*attempt_id,\s*step_id,\s*operation_intent_sha256\s*\)/u,
    );
    expect(envelopeTable).toMatch(/created_at < producer_lease_expires_at/u);
    expect(envelopeTable).toMatch(
      /CONSTRAINT run_retry_effect_envelopes_operation_key\s+UNIQUE\s*\(workspace_id, run_id, operation_key\)/u,
    );
    expect(envelopeTable).not.toMatch(/UNIQUE NULLS NOT DISTINCT/u);
    expect(envelopeTable).toMatch(
      /effect_class = 'requires_key'\s+AND operation_key IS NOT NULL\s+AND length\(btrim\(operation_key,\s+U&'[^']+'\)\) BETWEEN 1 AND 300[\s\S]*?effect_class <> 'requires_key' AND operation_key IS NULL/u,
    );
    expect(receiptTable).toMatch(
      /disposition = 'CONFIRMED'\s+AND result_ref IS NOT NULL\s+AND length\(btrim\(result_ref,\s+U&'[^']+'\)\) > 0\s+AND result_sha256 IS NOT NULL/u,
    );
    expect(receiptTable).toMatch(/unknown_reason_code\s+text/u);
    expect(receiptTable).toMatch(/result_payload_sha256\s+text\s+NOT NULL/u);
    expect(receiptTable).toMatch(/producer_lease_expires_at\s+timestamptz\s+NOT NULL/u);
    expect(receiptTable).toMatch(
      /disposition = 'UNKNOWN'[\s\S]*?result_ref IS NULL[\s\S]*?result_sha256 IS NULL[\s\S]*?length\(btrim\(unknown_reason_code,\s+U&'[^']+'\)\) BETWEEN 1 AND 200/u,
    );
    expect(receiptTable).toMatch(/created_at < producer_lease_expires_at/u);
  });

  it('validates generated authority consumption after stored columns materialize', async () => {
    const { upSql } = await runtimeSecuritySql();

    for (const table of ['run_usage_attributions', 'run_termination_intents']) {
      expect(upSql, `${table} must expose computed columns to the consumption validator`).toMatch(
        new RegExp(
          `CREATE TRIGGER ${table}_controlled_change\\s+AFTER UPDATE OR DELETE ON public\\.${table}`,
          'u',
        ),
      );
    }
    expect(upSql).toMatch(
      /CREATE TRIGGER run_recovery_hold_intents_controlled_change\s+BEFORE UPDATE OR DELETE ON public\.run_recovery_hold_intents/u,
    );
  });

  it('commits a canonical pre-call effect envelope before any receipt exists', async () => {
    const { downSql, upSql } = await runtimeSecuritySql();
    const entry = functionOracle.find(({ name }) => name === 'record_execution_effect_envelope');

    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const definition = requireFunctionDefinition(upSql, entry);
    const existingEnvelope = definition.indexOf(
      'FROM public.run_retry_effect_envelopes AS envelope',
    );
    const currentLease = definition.indexOf('app.require_execution_owner_lease');

    expect(definition).toMatch(/operation_intent_sha256[\s\S]*?effect_payload_sha256/u);
    expect(definition).toMatch(
      /jsonb_typeof\(p_fact -> 'operation_key'\) IS DISTINCT FROM 'string'/u,
    );
    expect(definition).toMatch(/'SAFE'[\s\S]*?'REQUIRES_KEY'[\s\S]*?'UNSAFE'/u);
    expect(definition).toMatch(/'REPLAY_SAFE'[\s\S]*?'REPLAY_WITH_KEY'[\s\S]*?'HOLD'/u);
    expect(definition).toMatch(
      /app\.g007_sha256\(\s*'better-agent\/run-retry-effect-envelope\/1',[\s\S]*?app\.g007_canonical_json\(v_contract\)/u,
    );
    expect(
      existingEnvelope,
      'committed response replay must be checked first',
    ).toBeGreaterThanOrEqual(0);
    expect(currentLease, 'only a committed miss needs the current lease').toBeGreaterThan(
      existingEnvelope,
    );
    expect(definition).toMatch(/INSERT INTO public\.run_retry_effect_envelopes/u);
    expect(definition).not.toMatch(/INSERT INTO public\.run_side_effect_receipts/u);
    expect(downSql).toMatch(/DROP FUNCTION app\.record_execution_effect_envelope\(jsonb\);/u);
  });

  it('binds a replayed effect receipt to the current claimed recovery decision', async () => {
    const { upSql } = await runtimeSecuritySql();
    const entry = functionOracle.find(({ name }) => name === 'record_execution_effect_receipt');

    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const definition = requireFunctionDefinition(upSql, entry);

    expect(definition).toMatch(/retry_effect_envelope_id[\s\S]*?retry_effect_envelope_sha256/u);
    expect(definition).toMatch(
      /result_payload_sha256[\s\S]*?external_receipt_ref[\s\S]*?external_receipt_sha256[\s\S]*?unknown_reason_code/u,
    );
    for (const field of [
      'external_receipt_ref',
      'external_receipt_sha256',
      'unknown_reason_code',
    ]) {
      expect(definition).toMatch(
        new RegExp(`jsonb_typeof\\(p_fact -> '${field}'\\) IS DISTINCT FROM 'string'`, 'u'),
      );
    }
    expect(definition).not.toMatch(/INSERT INTO public\.run_retry_effect_envelopes/u);
    expect(definition).toMatch(
      /JOIN public\.run_recovery_ticket_dispositions AS disposition[\s\S]*?disposition_kind = 'CLAIMED'[\s\S]*?claim_fencing_token[\s\S]*?claim_lease_token/u,
    );
    expect(definition).toMatch(
      /ticket\.resource_kind = 'ATTEMPT'[\s\S]*?ticket\.resource_id =\s*\(v_authority ->> 'attempt_id'\)::uuid[\s\S]*?ticket\.fenced_generation \+ 1 =\s*\(v_authority ->> 'lease_fencing_token'\)::bigint/u,
    );
    expect(definition).not.toMatch(/attempt\.recovery_ticket_id/u);
    expect(definition).toMatch(
      /jsonb_array_elements\(v_ticket\.effect_decisions\)[\s\S]*?'REPLAY_SAFE'[\s\S]*?'REPLAY_WITH_KEY'/u,
    );
    expect(definition).toMatch(
      /FROM public\.run_retry_effect_envelopes AS envelope[\s\S]*?envelope_sha256[\s\S]*?FOR UPDATE/u,
    );
    expect(definition).toMatch(
      /FROM public\.run_side_effect_receipts AS receipt[\s\S]*?receipt_sha256[\s\S]*?'replayed', true/u,
    );
    expect(definition).toMatch(
      /app\.g007_sha256\(\s*'better-agent\/run-side-effect-receipt\/1',[\s\S]*?app\.g007_canonical_json\(v_contract\)/u,
    );
    const responseReplayRead = definition.indexOf(
      'FROM public.run_retry_effect_envelopes AS envelope',
    );
    const currentLeaseLock = definition.indexOf('app.require_execution_owner_lease');
    expect(responseReplayRead).toBeGreaterThanOrEqual(0);
    expect(currentLeaseLock).toBeGreaterThan(responseReplayRead);
    expect(definition).toMatch(
      /IF v_lookup_pass = 1 THEN[\s\S]*?FROM public\.run_retry_effect_envelopes AS envelope[\s\S]*?ELSE[\s\S]*?FROM public\.run_retry_effect_envelopes AS envelope[\s\S]*?FOR UPDATE;[\s\S]*?IF v_lookup_pass = 1 THEN\s+v_authority := app\.require_execution_owner_lease/u,
    );
    expect(definition).toMatch(
      /claim_lease_expires_at\s*<=\s*\(v_authority ->> 'lease_expires_at'\)::timestamptz/u,
    );

    const claimEntry = functionOracle.find(({ name }) => name === 'claim_run_attempt');
    expect(claimEntry).toBeDefined();
    if (claimEntry === undefined) return;
    const claim = requireFunctionDefinition(upSql, claimEntry);
    expect(claim).toMatch(
      /SET status = 'RUNNING',[\s\S]*?recovery_ticket_id = NULL[\s\S]*?lease_generation = v_generation/u,
    );
  });

  it('locks and confirms the complete Step effect set before usage attribution', async () => {
    const { upSql } = await runtimeSecuritySql();
    const entry = functionOracle.find(({ name }) => name === 'record_usage_attribution');

    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const definition = requireFunctionDefinition(upSql, entry);

    expect(definition).toMatch(
      /app\.require_execution_owner_lease[\s\S]*?FROM public\.run_retry_effect_envelopes AS envelope[\s\S]*?ORDER BY envelope\.id\s+FOR UPDATE/u,
    );
    expect(definition).toMatch(
      /FROM public\.run_side_effect_receipts AS receipt[\s\S]*?ORDER BY envelope\.id\s+FOR UPDATE OF receipt/u,
    );
    expect(definition).toMatch(
      /IF EXISTS\s*\([\s\S]*?LEFT JOIN public\.run_side_effect_receipts AS receipt[\s\S]*?receipt\.disposition IS DISTINCT FROM 'CONFIRMED'[\s\S]*?complete Step effect set/u,
    );
  });

  it('refuses to clear an Attempt lease until its complete effect set is safely CLOSED', async () => {
    const { upSql } = await runtimeSecuritySql();
    const progressEntry: FunctionOracle = {
      args: 'jsonb, text',
      grantees: [],
      name: 'record_execution_progress',
      owner: 'ba_run_owner',
      returns: 'jsonb',
      schema: 'app',
    };
    const definition = requireFunctionDefinition(upSql, progressEntry);
    const leaseEntry = functionOracle.find(({ name }) => name === 'require_execution_owner_lease');
    expect(leaseEntry).toBeDefined();
    if (leaseEntry === undefined) return;
    const leaseDefinition = requireFunctionDefinition(upSql, leaseEntry);
    const finishBranch = definition.slice(definition.indexOf("p_event_type = 'ATTEMPT_FINISHED'"));
    const leaseClear = finishBranch.indexOf('UPDATE public.run_attempts');

    expect(finishBranch).toMatch(
      /FROM public\.run_retry_effect_envelopes AS envelope[\s\S]*?ORDER BY envelope\.id\s+FOR UPDATE;[\s\S]*?IF NOT FOUND THEN[\s\S]*?ERRCODE = '55000'/u,
    );
    expect(finishBranch).toMatch(
      /FROM public\.run_side_effect_receipts AS receipt[\s\S]*?ORDER BY envelope\.id\s+FOR UPDATE OF receipt/u,
    );
    expect(finishBranch).toMatch(
      /envelope\.effect_class = 'unsafe'[\s\S]*?envelope\.effect_class = 'requires_key'[\s\S]*?envelope\.operation_key IS NULL[\s\S]*?receipt\.disposition IS DISTINCT FROM 'CONFIRMED'/u,
    );
    expect(leaseClear).toBeGreaterThan(finishBranch.indexOf('FOR UPDATE OF receipt'));
    expect(finishBranch.slice(0, leaseClear)).toMatch(/ERRCODE = '55000'/u);
    expect(definition).toMatch(
      /p_event_type = 'ATTEMPT_FINISHED'[\s\S]*?p_fact - ARRAY\[[\s\S]*?'attempt_status'[\s\S]*?execution progress fact shape is invalid/u,
    );
    expect(leaseDefinition).toMatch(
      /jsonb_typeof\(p_fact -> 'run_id'\) IS DISTINCT FROM 'string'[\s\S]*?jsonb_typeof\(p_fact -> 'lease_fencing_token'\) IS DISTINCT FROM 'string'[\s\S]*?execution lease authority shape is invalid/u,
    );
  });

  it('persists a protocol-v5 checkpoint that directly matches the registered contract', async () => {
    const { downSql, upSql } = await runtimeSecuritySql();
    const entry = functionOracle.find(({ name }) => name === 'record_execution_checkpoint');
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const definition = requireFunctionDefinition(upSql, entry);
    const checkpointAlter = upSql.match(
      /ALTER TABLE public\.run_checkpoints[\s\S]*?REFERENCES public\.run_attempts\(workspace_id, run_id, id\);/u,
    )?.[0];

    expect(checkpointAlter).toBeDefined();
    for (const field of [
      'checkpoint_sequence',
      'producer_lease_expires_at',
      'authorized_at',
      'schema_version',
      'checkpoint_id',
      'attempt_id',
      'checkpoint_ref',
      'checkpoint_sha256',
      'lease_owner',
      'lease_token',
      'lease_fencing_token',
      'lease_expires_at',
    ]) {
      expect(checkpointAlter, `missing checkpoint contract field ${field}`).toMatch(
        new RegExp(`\\b${field}\\b`, 'u'),
      );
      expect(downSql, `down migration must restore checkpoint field ${field}`).toMatch(
        new RegExp(`DROP COLUMN ${field}\\b`, 'u'),
      );
    }
    expect(checkpointAlter).toMatch(
      /run_checkpoints_sequence_key[\s\S]*?UNIQUE \(workspace_id, run_id, checkpoint_sequence\)/u,
    );
    expect(definition).toMatch(
      /'checkpoint_ref', 'checkpoint_sha256'[\s\S]*?execution checkpoint fact shape is invalid[\s\S]*?app\.require_execution_owner_lease/u,
    );
    expect(definition).not.toMatch(/p_fact ->> 'payload_ref'|p_fact ->> 'checkpoint_hash'/u);
    expect(definition).toMatch(
      /max\(checkpoint\.checkpoint_sequence\)[\s\S]*?'schema_version', 'run-execution-checkpoint\/1'[\s\S]*?'checkpoint_sequence', v_checkpoint_sequence::text/u,
    );
    expect(definition).toMatch(
      /'producer_session_user'[\s\S]*?'lease_expires_at'[\s\S]*?'authorized_at'/u,
    );
  });

  it('makes usage and termination producer commits exact-replay idempotent', async () => {
    const { upSql } = await runtimeSecuritySql();
    const usageEntry = functionOracle.find(({ name }) => name === 'record_usage_attribution');
    const terminationEntry = functionOracle.find(
      ({ name }) => name === 'record_leased_termination_intent',
    );
    expect(usageEntry).toBeDefined();
    expect(terminationEntry).toBeDefined();
    if (usageEntry === undefined || terminationEntry === undefined) return;
    const usage = requireFunctionDefinition(upSql, usageEntry);
    const termination = requireFunctionDefinition(upSql, terminationEntry);

    expect(upSql).toMatch(
      /run_usage_attributions_producer_request_key\s+UNIQUE \(workspace_id, run_id, producer_operation_key\)/u,
    );
    for (const [name, definition, resultVersion, sourceField] of [
      ['usage', usage, 'run-usage-attribution-record-result/1', 'source'],
      ['termination', termination, 'run-termination-intent-record-result/1', 'intent'],
    ] as const) {
      const replayRead = definition.indexOf(
        name === 'usage'
          ? 'FROM public.run_usage_attributions AS source'
          : 'FROM public.run_termination_intents AS source',
      );
      const leaseCheck = definition.indexOf('app.require_execution_owner_lease');
      expect(replayRead, `${name} must read an immutable response first`).toBeGreaterThanOrEqual(0);
      expect(leaseCheck, `${name} must defer active-lease validation`).toBeGreaterThan(replayRead);
      expect(definition).toMatch(
        /FOR v_lookup_pass IN 1\.\.2 LOOP[\s\S]*?IF v_lookup_pass = 1 THEN[\s\S]*?ELSE[\s\S]*?FOR UPDATE;[\s\S]*?producer_request_sha256 IS DISTINCT FROM v_request_hash[\s\S]*?ERRCODE = '23505'/u,
      );
      const producerSessionBinding = definition.indexOf(
        'v_existing.producer_session_user IS DISTINCT FROM session_user',
      );
      const producerRequestBinding = definition.indexOf(
        'v_existing.producer_request_sha256 IS DISTINCT FROM v_request_hash',
      );
      expect(
        producerSessionBinding,
        `${name} replay must remain bound to the committing session_user`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        producerRequestBinding,
        `${name} replay must authenticate the producer before comparing request identity`,
      ).toBeGreaterThan(producerSessionBinding);
      expect(definition.slice(producerSessionBinding, producerRequestBinding)).toMatch(
        /ERRCODE = '42501'/u,
      );
      expect(definition).toContain(`'schema_version', '${resultVersion}'`);
      expect(definition).toMatch(
        new RegExp(`'${sourceField}', v_source_contract[\\s\\S]*?'replayed', true`, 'u'),
      );
      expect(definition).toMatch(
        new RegExp(`'${sourceField}', v_source_contract[\\s\\S]*?'replayed', false`, 'u'),
      );
      expect(definition).toMatch(/'producer_operation_key'/u);
    }
  });

  it('uses the ECMAScript TrimString set for every SQL nonblank boundary', async () => {
    const { upSql } = await runtimeSecuritySql();
    const btrimLines = upSql.split(/\r?\n/u).filter((line) => line.includes('btrim('));

    expect(btrimLines.length).toBeGreaterThan(0);
    for (const line of btrimLines) {
      expect(line, `default PostgreSQL btrim boundary: ${line.trim()}`).toContain(
        `, ${ecmaScriptTrimCharactersSql})`,
      );
    }
    for (const expression of [
      'operation_key',
      "p_fact ->> 'operation_key'",
      'producer_operation_key',
      "p_fact ->> 'producer_operation_key'",
      'metering_unit',
      "p_fact ->> 'metering_unit'",
      'payload_ref',
      "p_fact ->> 'checkpoint_ref'",
      'result_ref',
      "p_fact ->> 'external_receipt_ref'",
      'unknown_reason_code',
      "p_fact ->> 'unknown_reason_code'",
      'settlement_operation_key',
      'release_operation_key',
      'release_reason_code',
      'charge_key',
      "p_fact ->> 'charge_key'",
      'p_charge_key',
      "p_fact ->> 'reason_code'",
      'p_reason_code',
    ]) {
      expect(upSql).toContain(`btrim(${expression}, ${ecmaScriptTrimCharactersSql})`);
    }
    expect(
      upSql.match(/length\(settlement_operation_key\) BETWEEN 1 AND 300/gu) ?? [],
    ).toHaveLength(2);
    expect(upSql.match(/length\(release_operation_key\) BETWEEN 1 AND 300/gu) ?? []).toHaveLength(
      1,
    );
    expect(upSql.match(/length\(release_reason_code\) BETWEEN 1 AND 200/gu) ?? []).toHaveLength(1);
    expect(upSql.match(/length\(charge_key\) BETWEEN 1 AND 300/gu) ?? []).toHaveLength(1);
    expect(
      upSql.match(/length\(p_fact ->> 'charge_key'\) NOT BETWEEN 1 AND 300/gu) ?? [],
    ).toHaveLength(2);
    expect(
      upSql.match(/length\(p_fact ->> 'reason_code'\) NOT BETWEEN 1 AND 200/gu) ?? [],
    ).toHaveLength(1);
    expect(upSql.match(/length\(p_charge_key\) NOT BETWEEN 1 AND 300/gu) ?? []).toHaveLength(2);
    expect(upSql.match(/length\(p_reason_code\) NOT BETWEEN 1 AND 200/gu) ?? []).toHaveLength(1);
  });

  it('validates canonical usage scalars before casts and supports metering-first close', async () => {
    const { upSql } = await runtimeSecuritySql();
    const usageEntry = functionOracle.find(({ name }) => name === 'record_usage_attribution');
    const terminationEntry = functionOracle.find(
      ({ name }) => name === 'record_leased_termination_intent',
    );
    expect(usageEntry).toBeDefined();
    expect(terminationEntry).toBeDefined();
    if (usageEntry === undefined || terminationEntry === undefined) return;
    const usage = requireFunctionDefinition(upSql, usageEntry);
    const termination = requireFunctionDefinition(upSql, terminationEntry);

    expect(usage).toMatch(
      /jsonb_typeof\(p_fact -> 'quantity'\) IS DISTINCT FROM 'string'[\s\S]*?jsonb_typeof\(p_fact -> 'amount'\) IS DISTINCT FROM 'string'/u,
    );
    expect(usage).toMatch(
      /quantity'[\s\S]*?\^\(0\|\[1-9\]\[0-9\]\*\)\$[\s\S]*?amount'[\s\S]*?\^\(0\|\[1-9\]\[0-9\]\*\)\$/u,
    );
    expect(usage).toMatch(
      /length\(p_fact ->> 'metering_unit'\)[\s\S]*?length\(btrim\(p_fact ->> 'metering_unit',\s+U&'[^']+'\)\)/u,
    );
    expect(termination).toMatch(
      /FROM public\.run_usage_attributions AS source[\s\S]*?ORDER BY source\.id\s+FOR UPDATE;/u,
    );
    expect(termination).toMatch(
      /v_reservation\.status = 'HELD'[\s\S]*?source\.consumed_at IS NULL[\s\S]*?v_reservation\.status IN \('SETTLED', 'RELEASED', 'EXPIRED'\)/u,
    );
    expect(termination).toMatch(
      /LEFT JOIN public\.run_billing_authority_receipts AS receipt[\s\S]*?source\.consumed_at IS NULL[\s\S]*?receipt\.source_authority_hash[\s\S]*?receipt\.source_consumption_generation[\s\S]*?v_intended_release := 0/u,
    );
  });

  it('keeps an undisposed CLOSED recovery ticket reachable by the trusted finalizer', async () => {
    const { downSql, upSql } = await runtimeSecuritySql();
    const ticketTable = upSql.match(
      /CREATE TABLE public\.run_recovery_tickets\s*\([\s\S]*?\n\);/u,
    )?.[0];
    const holdTable = upSql.match(
      /CREATE TABLE public\.run_recovery_hold_intents\s*\([\s\S]*?\n\);/u,
    )?.[0];
    const recoveryCheckpointValidation = upSql.match(
      /CREATE FUNCTION app\.validate_g007_recovery_ticket\(\)[\s\S]*?\$function\$;/u,
    )?.[0];
    const finalizeEntry = functionOracle.find(({ name }) => name === 'finalize_claimed_run');
    const retireEntry = functionOracle.find(
      ({ name }) => name === 'retire_run_attempts_for_finalizer',
    );

    expect(finalizeEntry).toBeDefined();
    expect(retireEntry).toBeDefined();
    expect(ticketTable).toBeDefined();
    expect(holdTable).toBeDefined();
    expect(recoveryCheckpointValidation).toBeDefined();
    if (finalizeEntry === undefined || retireEntry === undefined) {
      throw new Error('runtime-security function oracle is incomplete');
    }
    expect(upSql).toMatch(
      /ALTER TABLE public\.run_attempts[\s\S]*?ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp\(\)/u,
    );
    expect(upSql).toMatch(
      /status = 'PENDING'[\s\S]*?lease_generation = 0[\s\S]*?recovery_ticket_id IS NULL[\s\S]*?started_at IS NULL[\s\S]*?lease_generation BETWEEN 1 AND 9007199254740991[\s\S]*?recovery_ticket_id IS NOT NULL/u,
    );
    expect(downSql).toMatch(/ALTER TABLE public\.run_attempts[\s\S]*?DROP COLUMN updated_at/u);
    expect(ticketTable).toMatch(/checkpoint_id\s+uuid[\s\S]*?checkpoint_sha256\s+text/u);
    expect(ticketTable).toMatch(
      /effect_decisions\s+jsonb\s+NOT NULL[\s\S]*?jsonb_array_length\(effect_decisions\)\s*>\s*0/u,
    );
    expect(ticketTable).toMatch(/effect_decisions_sha256\s+text\s+NOT NULL/u);
    expect(ticketTable).not.toMatch(/^\s*recovery_decision\s+text/mu);
    expect(ticketTable).not.toMatch(/^\s*effect_closure_sha256\s+text/mu);
    expect(holdTable).toMatch(
      /hold_reason\s+text[\s\S]*?'MISSING_ENVELOPE'[\s\S]*?'UNSAFE_EFFECT'[\s\S]*?'SIDE_EFFECT_UNKNOWN'[\s\S]*?'EFFECT_CLOSURE_OPEN'[\s\S]*?'EFFECT_CLOSURE_UNKNOWN'/u,
    );
    expect(holdTable).toMatch(
      /effect_closure_disposition\s+text[\s\S]*?effect_closure_sha256\s+text/u,
    );
    expect(recoveryCheckpointValidation).toMatch(
      /checkpoint\.workspace_id = NEW\.workspace_id[\s\S]*?checkpoint\.run_id = NEW\.run_id[\s\S]*?checkpoint\.id = NEW\.checkpoint_id[\s\S]*?checkpoint\.checkpoint_hash = NEW\.checkpoint_sha256[\s\S]*?checkpoint\.producer_attempt_id = NEW\.resource_id/u,
    );
    expect(upSql).toMatch(
      /CREATE TRIGGER run_recovery_hold_intents_validate\s+BEFORE INSERT ON public\.run_recovery_hold_intents\s+FOR EACH ROW EXECUTE FUNCTION app\.validate_g007_recovery_ticket\(\)/u,
    );
    const finalizeDefinition = requireFunctionDefinition(upSql, finalizeEntry);
    const retireDefinition = requireFunctionDefinition(upSql, retireEntry);

    expect(finalizeDefinition).toMatch(
      /attempt\.status\s*=\s*'PENDING'[\s\S]*?attempt\.recovery_ticket_id IS NOT NULL[\s\S]*?ticket\.resource_kind\s*=\s*'ATTEMPT'[\s\S]*?ticket\.fenced_generation\s*=\s*attempt\.lease_generation/u,
    );
    expect(finalizeDefinition).toMatch(
      /ticket\.effect_decisions_sha256[\s\S]*?app\.g007_sha256\([\s\S]*?'better-agent\/run-recovery-effect-decision-set\/1'/u,
    );
    expect(finalizeDefinition).toMatch(
      /NOT EXISTS\s*\([\s\S]*?run_recovery_ticket_dispositions[\s\S]*?recovery_ticket_id\s*=\s*ticket\.id/u,
    );
    expect(finalizeDefinition).toMatch(/receipt\.disposition\s*=\s*'UNKNOWN'/u);
    expect(retireDefinition).toMatch(
      /'TERMINAL_RETIRED'[\s\S]*?v_ticket\.fenced_generation[\s\S]*?SET status = v_target_status/u,
    );
  });

  it('persists the exact recovery disposition and terminal source/status ABI', async () => {
    const { upSql } = await runtimeSecuritySql();
    const dispositionTable = upSql.match(
      /CREATE TABLE public\.run_recovery_ticket_dispositions\s*\([\s\S]*?\n\);/u,
    )?.[0];
    const validatorEntry: FunctionOracle = {
      args: '',
      grantees: [],
      name: 'validate_recovery_ticket_disposition',
      owner: 'ba_run_owner',
      returns: 'trigger',
      schema: 'app',
    };
    const validator = requireFunctionDefinition(upSql, validatorEntry);

    expect(dispositionTable).toBeDefined();
    for (const field of [
      'recovery_ticket_sha256',
      'ticket_fencing_token',
      'disposition_kind',
      'claim_fencing_token',
      'claim_session_user',
      'claim_lease_owner',
      'claim_lease_token',
      'claim_lease_expires_at',
      'terminal_source_kind',
      'terminal_source_id',
      'terminal_source_sha256',
      'terminal_intent_sha256',
      'terminal_resource_status',
      'disposed_at',
    ]) {
      expect(dispositionTable, `missing recovery disposition field ${field}`).toMatch(
        new RegExp(`\\b${field}\\b`, 'u'),
      );
    }
    expect(dispositionTable).toMatch(
      /disposition_kind\s+text[\s\S]*?'CLAIMED'[\s\S]*?'TERMINAL_RETIRED'/u,
    );
    expect(dispositionTable).toMatch(
      /terminal_source_kind\s+text[\s\S]*?'TERMINATION_ATTRIBUTION'[\s\S]*?'DURABLE_CANCEL'[\s\S]*?'RECOVERY_HOLD'/u,
    );
    expect(dispositionTable).not.toMatch(/'EXECUTION_TERMINATION'/u);
    expect(dispositionTable).toMatch(
      /resource_kind\s*=\s*'RUN_DISPATCH'[\s\S]*?terminal_resource_status\s*=\s*'DEAD'/u,
    );
    expect(dispositionTable).toMatch(
      /terminal_source_kind\s*=\s*'RECOVERY_HOLD'[\s\S]*?terminal_resource_status\s*=\s*'RELINQUISHED'/u,
    );
    expect(dispositionTable).toMatch(
      /terminal_source_kind\s*=\s*'DURABLE_CANCEL'[\s\S]*?terminal_resource_status\s*=\s*'CANCELLED'/u,
    );
    expect(dispositionTable).toMatch(
      /terminal_source_kind\s*=\s*'TERMINATION_ATTRIBUTION'[\s\S]*?terminal_resource_status\s+IN\s*\(\s*'CANCELLED',\s*'FAILED'\s*\)/u,
    );

    expect(validator).toMatch(
      /NEW\.recovery_ticket_sha256\s+IS DISTINCT FROM\s+v_ticket\.ticket_sha256/u,
    );
    expect(validator).toMatch(
      /NEW\.ticket_fencing_token\s+IS DISTINCT FROM\s+v_ticket\.fenced_generation/u,
    );
    expect(validator).toMatch(
      /NEW\.claim_fencing_token\s+IS DISTINCT FROM\s+v_ticket\.fenced_generation\s*\+\s*1/u,
    );
    expect(validator).toMatch(
      /NEW\.claim_session_user\s+IS DISTINCT FROM\s+NEW\.claim_lease_owner/u,
    );
    expect(validator).toMatch(/NEW\.disposed_at\s*>=\s*NEW\.claim_lease_expires_at/u);

    for (const name of [
      'claim_run_attempt',
      'claim_run_dispatch',
      'retire_run_attempts_for_finalizer',
      'retire_run_dispatches_for_finalizer',
    ]) {
      const entry = functionOracle.find((candidate) => candidate.name === name);
      expect(entry, `missing function oracle for ${name}`).toBeDefined();
      if (entry === undefined) continue;
      const definition = requireFunctionDefinition(upSql, entry);
      expect(definition).toMatch(/recovery_ticket_sha256/u);
      expect(definition).toMatch(/ticket_fencing_token/u);
      expect(definition).toMatch(/disposition_kind/u);
    }
  });

  it('seals full dispatch retirement history and strict DEAD failure evidence', async () => {
    const { downSql, upSql } = await runtimeSecuritySql();
    const retirementTable = upSql.match(
      /CREATE TABLE public\.run_dispatch_retirement_receipts\s*\([\s\S]*?\n\);/u,
    )?.[0];
    const failEntry = functionOracle.find(({ name }) => name === 'fail_run_dispatch');
    const retireEntry = functionOracle.find(
      ({ name }) => name === 'retire_run_dispatches_for_finalizer',
    );
    expect(failEntry).toBeDefined();
    expect(retireEntry).toBeDefined();
    if (failEntry === undefined || retireEntry === undefined) return;
    const failDefinition = requireFunctionDefinition(upSql, failEntry);
    const retireDefinition = requireFunctionDefinition(upSql, retireEntry);

    expect(retirementTable).toBeDefined();
    for (const field of [
      'old_lease_owner',
      'old_lease_token',
      'old_lease_fencing_token',
      'old_lease_expires_at',
      'old_delivery_generation',
      'new_delivery_generation',
      'retired_status',
      'last_error_code',
      'terminal_source_kind',
      'terminal_source_id',
      'terminal_source_sha256',
      'terminal_intent_sha256',
      'receipt_sha256',
      'retired_at',
    ]) {
      expect(retirementTable, `missing dispatch retirement field ${field}`).toMatch(
        new RegExp(`\\b${field}\\b`, 'u'),
      );
    }
    expect(retirementTable).toMatch(
      /old_status\s+text[\s\S]*?IN\s*\(\s*'PENDING',\s*'LEASED'\s*\)/u,
    );
    expect(retirementTable).toMatch(/retired_status\s+text\s+NOT NULL[\s\S]*?=\s*'DEAD'/u);
    expect(retirementTable).toMatch(
      /last_error_code\s+text\s+NOT NULL[\s\S]*?=\s*'RUN_TERMINATED_BEFORE_DISPATCH'/u,
    );
    expect(retirementTable).toMatch(
      /terminal_source_kind\s+text[\s\S]*?'TERMINATION_ATTRIBUTION'[\s\S]*?'DURABLE_CANCEL'[\s\S]*?'RECOVERY_HOLD'/u,
    );
    expect(retirementTable).not.toMatch(/'EXECUTION_TERMINATION'/u);
    expect(retireDefinition).toMatch(/v_receipt_contract\s+jsonb/u);
    expect(retireDefinition).toMatch(
      /'old_lease_owner'[\s\S]*?'old_lease_token'[\s\S]*?'old_lease_fencing_token'[\s\S]*?'old_lease_expires_at'/u,
    );
    expect(retireDefinition).toMatch(
      /app\.g007_sha256\(\s*'better-agent\/run-dispatch-retirement-receipt\/1',\s*v_receipt_contract::text/u,
    );

    expect(upSql).toMatch(
      /ADD COLUMN delivery_failure_evidence_sha256\s+text[\s\S]*?\^sha256:\[0-9a-f\]\{64\}\$/u,
    );
    expect(failDefinition).toMatch(/p_fact\s*->>\s*'disposition'/u);
    expect(failDefinition).not.toMatch(/p_fact\s*->>\s*'retryable'/u);
    expect(failDefinition).toMatch(
      /v_disposition\s*=\s*'DEAD'[\s\S]*?delivery_failure_evidence_sha256[\s\S]*?\^sha256:\[0-9a-f\]\{64\}\$/u,
    );
    expect(failDefinition).toMatch(
      /v_disposition\s*=\s*'RETRY'[\s\S]*?delivery_failure_evidence_sha256[\s\S]*?IS NOT NULL/u,
    );
    expect(downSql).toMatch(/delivery_failure_evidence_sha256 IS NOT NULL/u);
    expect(downSql).toMatch(/DROP COLUMN delivery_failure_evidence_sha256/u);
  });

  it('stores strict producer sources and derives the canonical billing-v2 hash DAG', async () => {
    const { upSql } = await runtimeSecuritySql();
    const usageTable = upSql.match(
      /CREATE TABLE public\.run_usage_attributions\s*\([\s\S]*?\n\);/u,
    )?.[0];
    const terminationTable = upSql.match(
      /CREATE TABLE public\.run_termination_intents\s*\([\s\S]*?\n\);/u,
    )?.[0];
    expect(usageTable).toBeDefined();
    expect(terminationTable).toBeDefined();

    for (const field of [
      'lease_owner',
      'lease_token',
      'lease_fencing_token',
      'lease_expires_at',
      'producer_operation_key',
      'producer_request_sha256',
      'metering_quantity',
      'amount_credits',
      'settlement_operation_key',
      'operation_intent_sha256',
      'execution_effect_payload_sha256',
      'consumption_generation',
    ]) {
      expect(usageTable, `missing usage source field ${field}`).toMatch(
        new RegExp(`\\b${field}\\b`, 'u'),
      );
    }
    for (const field of [
      'step_id',
      'lease_owner',
      'lease_token',
      'lease_fencing_token',
      'lease_expires_at',
      'producer_operation_key',
      'producer_request_sha256',
      'terminal_status',
      'usage_attribution_ids',
      'intended_settle_credits',
      'settlement_operation_key',
      'intended_release_credits',
      'release_operation_key',
      'release_reason_code',
      'operation_intent_sha256',
      'consumption_generation',
    ]) {
      expect(terminationTable, `missing termination source field ${field}`).toMatch(
        new RegExp(`\\b${field}\\b`, 'u'),
      );
    }
    expect(terminationTable).toMatch(/step_id\s+uuid\s+NOT NULL/u);
    expect(terminationTable).toMatch(/usage_attribution_ids\s+uuid\[\]\s+NOT NULL/u);

    expect(upSql).toMatch(/CREATE FUNCTION app\.g007_canonical_json\(p_value jsonb\)/u);
    expect(upSql).toMatch(/CREATE FUNCTION app\.g007_canonical_sha256\(p_value jsonb\)/u);
    for (const hash of [
      'sha256:367977effd85124e39490e5d18b586c251e44e4d29d34a6c6a27169072c62dd2',
      'sha256:b92e3d1381c68ee6cbe7921494e72edc4a609fb67841cf1c6c6b7d7d2ba1c375',
      'sha256:0d71b017793fdaf4e92db810b99dd5a2c10dd7dbf739915d9edf56324d36ba2d',
      'sha256:e632bb5a5893c1779563bd0ee268c225aa038fd28d8a1349d638a75251e8adf8',
      'sha256:26a38e9d30c50ca8739117e3a3df6a977f9772228beca3ce82aeaaaeb724504e',
      'sha256:721b9de33a2eee3688cfe00a62ac3a183672e3296dd1c4777e6607241650d4e3',
    ]) {
      expect(upSql, `missing cross-language billing hash vector ${hash}`).toContain(hash);
    }

    for (const name of [
      'apply_attributed_settlement',
      'apply_attributed_release',
      'apply_claimed_release',
    ]) {
      const entry = functionOracle.find((candidate) => candidate.name === name);
      expect(entry).toBeDefined();
      if (entry === undefined) continue;
      const definition = requireFunctionDefinition(upSql, entry);
      expect(definition).toMatch(
        /v_charge_hash\s*:=\s*(?:v_source\s*->>\s*'source_authority_hash'|v_claim\s*->>\s*'source_sha256')/u,
      );
      expect(definition).toMatch(/'schema_version',\s*'billing-intent\/2'/u);
      expect(definition).toMatch(/'authority',\s*jsonb_build_object/u);
      expect(definition).toMatch(/app\.g007_canonical_sha256\(v_billing_intent\)/u);
      expect(definition).not.toMatch(/better-agent\/charge-attribution\/2/u);
      expect(definition).not.toMatch(/better-agent\/billing-intent\/2/u);
    }
  });

  it('finalizes termination only after locked effect revalidation and all declared usage settlement', async () => {
    const { upSql } = await runtimeSecuritySql();
    const finalizeEntry = functionOracle.find(({ name }) => name === 'finalize_attributed_run');
    const recordEntry = functionOracle.find(
      ({ name }) => name === 'record_leased_termination_intent',
    );
    const executionLeaseEntry = functionOracle.find(
      ({ name }) => name === 'require_execution_owner_lease',
    );
    expect(finalizeEntry).toBeDefined();
    expect(recordEntry).toBeDefined();
    expect(executionLeaseEntry).toBeDefined();
    if (
      finalizeEntry === undefined ||
      recordEntry === undefined ||
      executionLeaseEntry === undefined
    )
      return;
    const definition = requireFunctionDefinition(upSql, finalizeEntry);
    const recordDefinition = requireFunctionDefinition(upSql, recordEntry);
    const executionLeaseDefinition = requireFunctionDefinition(upSql, executionLeaseEntry);

    expect(executionLeaseDefinition).toMatch(
      /EXISTS\s*\([\s\S]*?FROM public\.run_termination_intents[\s\S]*?source\.run_id\s*=\s*v_run\.id/u,
    );
    expect(executionLeaseDefinition).toMatch(
      /'lease_fencing_token',\s*v_attempt\.lease_fencing_token::text/u,
    );

    expect(recordDefinition).toMatch(
      /IF NOT EXISTS\s*\([\s\S]*?FROM public\.run_retry_effect_envelopes[\s\S]*?attempt_id\s*=\s*\(v_authority\s*->>\s*'attempt_id'\)::uuid[\s\S]*?\)\s*OR EXISTS/u,
    );
    expect(recordDefinition).toMatch(
      /LEFT JOIN public\.run_side_effect_receipts[\s\S]*?receipt\.disposition IS DISTINCT FROM 'CONFIRMED'/u,
    );

    expect(definition).toMatch(
      /run_retry_effect_envelopes[\s\S]*?run_side_effect_receipts[\s\S]*?FOR UPDATE/u,
    );
    expect(definition).toMatch(
      /attempt\.started_at IS NOT NULL[\s\S]*?NOT EXISTS\s*\([\s\S]*?run_retry_effect_envelopes[\s\S]*?envelope\.attempt_id\s*=\s*attempt\.id/u,
    );
    expect(definition).toMatch(/receipt\.disposition IS DISTINCT FROM 'CONFIRMED'/u);
    expect(definition).toMatch(
      /app\.g007_attempt_effect_closure_sha256\([\s\S]*?effect_closure_sha256/u,
    );
    expect(definition).toMatch(
      /unnest\(v_source\.usage_attribution_ids\)|jsonb_array_elements_text\(v_source\s*->\s*'usage_attribution_ids'\)/u,
    );
    expect(definition).toMatch(/app\.apply_attributed_settlement\(/u);
    expect(definition).toMatch(
      /intended_settle_credits[\s\S]*?intended_release_credits[\s\S]*?reserved_credits/u,
    );
    expect(definition.indexOf('app.apply_attributed_settlement')).toBeLessThan(
      definition.indexOf('app.apply_attributed_release'),
    );
    expect(definition).toMatch(/source_kind',\s*'TERMINATION_ATTRIBUTION'/u);
    expect(upSql).toMatch(
      /CREATE FUNCTION app\.apply_g007_terminal_projection[\s\S]*?terminal_error_redacted\s*=\s*CASE[\s\S]*?v_status = 'NEEDS_ATTENTION'[\s\S]*?'requires_operator_action', true[\s\S]*?ELSE jsonb_build_object\([\s\S]*?'category', 'EXECUTION'[\s\S]*?END/u,
    );
    expect(upSql).toMatch(
      /'source_kind', 'RECOVERY_HOLD'[\s\S]*?'source_sha256', v_hold\.hold_evidence_sha256[\s\S]*?'terminal_kind', 'NEEDS_ATTENTION'[\s\S]*?'termination_reason', 'SIDE_EFFECT_UNKNOWN'/u,
    );
    expect(upSql).not.toMatch(/'termination_reason',\s*v_hold\.hold_reason/u);
  });

  it('blocks a used or forward-diverged schema before pristine down and never cascades', async () => {
    const { downSql } = await runtimeSecuritySql();
    const downGuard = downSql.match(/DO \$g007_down_guard\$[\s\S]*?\$g007_down_guard\$;/u)?.[0];
    const downRunGuard = downSql.match(
      /DO \$g007_down_run_guard\$[\s\S]*?\$g007_down_run_guard\$;/u,
    )?.[0];
    const downBillingGuard = downSql.match(
      /DO \$g007_down_billing_guard\$[\s\S]*?\$g007_down_billing_guard\$;/u,
    )?.[0];

    expect(downGuard).toBeDefined();
    expect(downGuard).toMatch(/version\s*>\s*5/u);
    expect(downGuard).toMatch(/ERRCODE\s*=\s*'55000'/u);
    for (const fact of [
      'internal_service_attestations',
      'run_retry_effect_envelopes',
      'run_side_effect_receipts',
      'run_recovery_tickets',
      'run_recovery_ticket_dispositions',
      'run_recovery_hold_intents',
      'run_usage_attributions',
      'run_termination_intents',
      'run_billing_authority_receipts',
      'finalizer_transaction_claims',
    ]) {
      expect(downGuard).toContain(fact);
    }
    expect(downGuard).toMatch(/phase_operation_audit(?:s)?/u);
    expect(downBillingGuard).toMatch(/entry_schema_version\s*=\s*2/u);
    expect(downBillingGuard).toMatch(/authority_id IS NOT NULL/u);
    expect(downRunGuard).toMatch(/FROM public\.run_attempts[\s\S]*?lease_generation\s*<>\s*0/u);
    expect(downRunGuard).toMatch(
      /FROM public\.run_checkpoints[\s\S]*?producer_attempt_id IS NOT NULL[\s\S]*?producer_lease_token IS NOT NULL[\s\S]*?producer_lease_fencing_token IS NOT NULL[\s\S]*?producer_session_user IS NOT NULL/u,
    );
    expect(downRunGuard).toMatch(/FROM public\.outbox[\s\S]*?delivery_generation\s*<>\s*0/u);
    expect(downSql).not.toMatch(/\bCASCADE\b/u);
  });

  it('drops every recovery-ticket validator trigger before its shared function on down', async () => {
    const { downSql } = await runtimeSecuritySql();
    const validatorDrop = downSql.indexOf('DROP FUNCTION app.validate_g007_recovery_ticket();');

    expect(validatorDrop).toBeGreaterThan(-1);
    for (const trigger of ['run_recovery_tickets_validate', 'run_recovery_hold_intents_validate']) {
      const triggerDrop = downSql.indexOf(`DROP TRIGGER ${trigger}`);
      expect(triggerDrop, `${trigger} must be dropped explicitly`).toBeGreaterThan(-1);
      expect(triggerDrop, `${trigger} must be dropped before its function`).toBeLessThan(
        validatorDrop,
      );
    }
  });

  it('rejects recursively non-finite JavaScript JSON numbers before usage persistence', async () => {
    const { downSql, upSql } = await runtimeSecuritySql();
    const validator = upSql.match(
      /CREATE FUNCTION app\.g007_json_numbers_are_finite\(p_value jsonb\)[\s\S]*?\$function\$;/u,
    )?.[0];

    expect(validator).toBeDefined();
    expect(validator).toMatch(/jsonb_each\(p_value\)/u);
    expect(validator).toMatch(/jsonb_array_elements\(p_value\)/u);
    expect(validator).toMatch(/numeric_value_out_of_range/u);
    expect(validator).toMatch(/abs\(v_numeric\) < 1/u);
    expect(validator).toMatch(/IMMUTABLE[\s\S]*?STRICT[\s\S]*?PARALLEL SAFE/u);
    expect(upSql).toMatch(
      /run_usage_attributions_detail_json_check[\s\S]*?app\.g007_json_numbers_are_finite\(detail_redacted\)/u,
    );
    expect(upSql).toMatch(
      /credits_ledger_metering_detail_json_check[\s\S]*?app\.g007_json_numbers_are_finite\(metering_detail_redacted\)/u,
    );

    const usageEntry = functionOracle.find(({ name }) => name === 'record_usage_attribution');
    const settlementEntry = functionOracle.find(
      ({ name }) => name === 'apply_credit_settlement_kernel',
    );
    expect(usageEntry).toBeDefined();
    expect(settlementEntry).toBeDefined();
    if (usageEntry !== undefined) {
      expect(requireFunctionDefinition(upSql, usageEntry)).toMatch(
        /app\.g007_json_numbers_are_finite\(\s*COALESCE\(p_fact -> 'detail_redacted', '\{\}'::jsonb\)\s*\)/u,
      );
    }
    if (settlementEntry !== undefined) {
      expect(requireFunctionDefinition(upSql, settlementEntry)).toMatch(
        /app\.g007_json_numbers_are_finite\(\s*COALESCE\(p_fact -> 'detail_redacted', '\{\}'::jsonb\)\s*\)/u,
      );
    }
    expect(upSql).toMatch(
      /CREATE OR REPLACE FUNCTION app\.settle_credits\([\s\S]*?app\.g007_json_numbers_are_finite\(p_metering_detail_redacted\)/u,
    );

    const validatorDrop = downSql.indexOf('DROP FUNCTION app.g007_json_numbers_are_finite(jsonb);');
    expect(validatorDrop).toBeGreaterThan(-1);
    expect(
      downSql.indexOf('DROP CONSTRAINT credits_ledger_metering_detail_json_check'),
    ).toBeLessThan(validatorDrop);
    expect(downSql.indexOf('DROP TABLE public.run_usage_attributions;')).toBeLessThan(
      validatorDrop,
    );
    expect(downSql.lastIndexOf('CREATE OR REPLACE FUNCTION app.settle_credits(')).toBeLessThan(
      validatorDrop,
    );
  });

  it('makes every protocol-v5 nullable required tuple fail closed under SQL CHECK semantics', async () => {
    const { upSql } = await runtimeSecuritySql();

    const failClosedConstraintNames = [
      'internal_service_attestations_revocation_check',
      'run_attempts_protocol_v5_state_check',
      'run_checkpoints_protocol_v5_shape_check',
      'run_recovery_hold_intents_evidence_shape_check',
      'run_dispatch_retirement_receipts_lease_shape_check',
      'run_billing_authority_receipts_shape_check',
      'credits_ledger_authority_shape_check',
    ] as const;
    for (const constraintName of failClosedConstraintNames) {
      const definition = requireCheckConstraintDefinition(upSql, constraintName);
      expect(definition).toMatch(/CHECK \(\([\s\S]*\) IS TRUE\)$/u);

      // Guard the static oracle itself: removing this constraint's own fail-closed
      // suffix must not let the assertion drift into a later constraint.
      const mutatedDefinition = definition.replace(/\) IS TRUE\)$/u, '))');
      expect(mutatedDefinition).not.toBe(definition);
      const mutatedSql = upSql.replace(definition, mutatedDefinition);
      expect(requireCheckConstraintDefinition(mutatedSql, constraintName)).not.toMatch(
        /CHECK \(\([\s\S]*\) IS TRUE\)$/u,
      );
    }

    expect(
      requireCheckConstraintDefinition(upSql, 'internal_service_attestations_revocation_check'),
    ).toMatch(/revoked_at IS NOT NULL[\s\S]*?revocation_reason IS NOT NULL/u);

    expect(upSql).toMatch(
      /status = 'RUNNING'[\s\S]*?lease_fencing_token IS NOT NULL[\s\S]*?lease_fencing_token = lease_generation/u,
    );
    expect(upSql).toMatch(
      /run_checkpoints_protocol_v5_shape_check[\s\S]*?producer_lease_fencing_token IS NOT NULL[\s\S]*?producer_lease_fencing_token BETWEEN 1 AND 9007199254740991[\s\S]*?checkpoint_sequence IS NOT NULL[\s\S]*?checkpoint_sequence BETWEEN 1 AND 9007199254740991/u,
    );
    expect(upSql).toMatch(
      /old_status = 'LEASED'[\s\S]*?old_lease_fencing_token IS NOT NULL[\s\S]*?old_lease_fencing_token = old_delivery_generation/u,
    );
    expect(upSql).toMatch(
      /hold_reason IN \('EFFECT_CLOSURE_OPEN', 'EFFECT_CLOSURE_UNKNOWN'\)[\s\S]*?effect_closure_disposition IS NOT NULL[\s\S]*?effect_closure_disposition = CASE hold_reason/u,
    );

    const receiptTable = upSql.match(
      /CREATE TABLE public\.run_billing_authority_receipts\s*\([\s\S]*?\n\);/u,
    )?.[0];
    expect(receiptTable).toBeDefined();
    for (const authorityKind of ['EXECUTION_USAGE', 'EXECUTION_TERMINATION']) {
      expect(receiptTable).toMatch(
        new RegExp(
          `authority_kind = '${authorityKind}'[\\s\\S]*?producer_attempt_id IS NOT NULL[\\s\\S]*?producer_lease_fencing_token IS NOT NULL[\\s\\S]*?producer_lease_fencing_token BETWEEN 1 AND 9007199254740991[\\s\\S]*?step_id IS NOT NULL`,
          'u',
        ),
      );
    }

    const ledgerAlter = upSql.match(
      /ALTER TABLE public\.credits_ledger[\s\S]*?ADD CONSTRAINT credits_ledger_authority_fkey/u,
    )?.[0];
    expect(ledgerAlter).toBeDefined();
    for (const authorityKind of ['EXECUTION_USAGE', 'EXECUTION_TERMINATION']) {
      expect(ledgerAlter).toMatch(
        new RegExp(
          `entry_schema_version = 2[\\s\\S]*?authority_schema_version IS NOT NULL[\\s\\S]*?authority_schema_version = 1[\\s\\S]*?authority_kind = '${authorityKind}'[\\s\\S]*?producer_lease_fencing_token IS NOT NULL[\\s\\S]*?producer_lease_fencing_token BETWEEN 1 AND 9007199254740991[\\s\\S]*?step_id IS NOT NULL`,
          'u',
        ),
      );
    }
  });
});
