import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  loadMigrations,
  renderDownMigrationSql,
  renderUpMigrationSql,
} from '../../../packages/db/dist/index.js';
import {
  canonicalJsonBytes,
  prepareAgentStrategySource,
  prepareG1PublishedSourceStorage,
  verifyG1PublishedSourceStorage,
} from '../../../packages/release-core/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harness = createPostgresHarness('g1-published-source-registry');
const workspace = '018f47f2-c541-7cc6-9292-4a2c35304eee';
const admin = '018f47f2-c541-7cc6-9292-4a2c35304e01';
const attestation = '018f47f2-c541-7cc6-9292-4a2c35304e02';
const strategy = '018f47f2-c541-7cc6-9292-4a2c35304e03';
const release = '018f47f2-c541-7cc6-9292-4a2c35304e04';
const controlAttestation = '018f47f2-c541-7cc6-9292-4a2c35304e05';
const attestedRelease = '018f47f2-c541-7cc6-9292-4a2c35304e06';
const publicationAttestation = '018f47f2-c541-7cc6-9292-4a2c35304e07';
const revokedRelease = '018f47f2-c541-7cc6-9292-4a2c35304e08';
const revokedPublicationAttestation = '018f47f2-c541-7cc6-9292-4a2c35304e09';
const failedRelease = '018f47f2-c541-7cc6-9292-4a2c35304e0a';
const failedPublicationAttestation = '018f47f2-c541-7cc6-9292-4a2c35304e0b';
const secret = randomBytes(32).toString('hex');
const controlSecret = randomBytes(32).toString('hex');
const publicationVerifier = randomBytes(32).toString('hex');
const hash = `sha256:${'a'.repeat(64)}`;
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const jsonb = (value) => `${quote(JSON.stringify(value))}::jsonb`;

function ownerTransaction(body) {
  return `BEGIN;
SELECT set_config('app.tenant_context', format('control:%s:%s:%s:%s:%s',
  '${workspace}'::uuid, '${attestation}'::uuid, '${admin}'::uuid, txid_current(),
  encode(public.hmac(convert_to(format('control:%s:%s:%s:%s:%s',
    '${workspace}'::uuid, '${attestation}'::uuid, '${admin}'::uuid,
    txid_current(), session_user), 'UTF8'), decode('${secret}', 'hex'), 'sha256'), 'hex')), true);
SET LOCAL ROLE ba_authorization_owner;
${body}
COMMIT;`;
}

function controlTransaction(body) {
  return `BEGIN;
SELECT auth.establish_control_workspace_context(
  '${controlAttestation}', decode('${controlSecret}', 'hex'));
${body}
COMMIT;`;
}

function jsonLine(result) {
  const line = result.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .find((value) => value.startsWith('{') || value.startsWith('['));
  if (line === undefined) throw new Error('G1 source registry JSON row is missing');
  return JSON.parse(line);
}

function lastScalarLine(result) {
  const line = result.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => /^[0-9a-f]{8}[0-9a-f-]{28}$/u.test(value))
    .at(-1);
  if (line === undefined) throw new Error('G1 source registry scalar row is missing');
  return line;
}

function storageFixture(releaseId = release) {
  const source = prepareAgentStrategySource({
    schema_version: 'agent-strategy-source-candidate/1',
    workspace_id: workspace,
    document: {
      schema_version: 'agent-strategy-source/1',
      strategy_id: strategy,
      strategy_release_id: releaseId,
      abi_version: 'agent-strategy-abi/1',
      implementation_digest: hash,
      config: { planning: { mode: 'react' } },
      config_schema: { type: 'object' },
      input_schema: { type: 'object' },
      state_schema: { type: 'object' },
      decision_schema: { type: 'object' },
      observation_schema: { type: 'object' },
      sandbox_profile: {
        schema_version: 'strategy-sandbox-profile/1',
        profile_id: 'isolated-strategy/1',
        host_abi: 'agent-strategy-abi/1',
        network: 'deny',
        filesystem: 'deny',
        database: 'deny',
        secrets: 'deny',
        maximum_memory_bytes: 67_108_864,
        maximum_instruction_count: 1_000_000,
      },
      allowed_model_policy: {
        schema_version: 'strategy-model-policy/1',
        models: [
          {
            descriptor_id: 'primary',
            provider_id: 'provider',
            model_id: 'chat',
            model_revision: '2026-01',
            model_contract_hash: hash,
          },
        ],
        maximum_input_tokens: 32768,
        maximum_output_tokens: 4096,
      },
      allowed_capability_binding_ids: [],
      allowed_gate_spec_ids: [],
      max_iterations: 10,
      max_model_attempts: 5,
      max_tool_calls: 5,
    },
  });
  return prepareG1PublishedSourceStorage(source, []);
}

async function readback(pin) {
  const result = await harness.psql(
    'ba_control_test',
    controlTransaction(`SELECT app.resolve_g1_published_source(${jsonb(pin)});`),
  );
  return verifyG1PublishedSourceStorage(pin, jsonLine(result), []);
}

async function main() {
  await harness.start();
  const migrations = await loadMigrations(
    fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)),
  );
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations));
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces(id,name) VALUES ('${workspace}','G1 source fixture');
INSERT INTO public.workspace_members(workspace_id,user_id,role)
VALUES ('${workspace}','${admin}','admin');`,
  );
  await harness.psql(
    'ba_management_issuer_test',
    `SELECT auth.issue_control_session_attestation(
 '${attestation}', '${workspace}', '${admin}', 'ba_migrator_test', 'g1-source-idp',
 decode('${randomBytes(32).toString('hex')}', 'hex'), decode('${secret}', 'hex'),
 clock_timestamp() + interval '10 minutes');`,
  );
  await harness.psql(
    'ba_management_issuer_test',
    `SELECT auth.issue_control_session_attestation(
 '${controlAttestation}', '${workspace}', '${admin}', 'ba_control_test',
 'g1-source-control-idp', decode('${randomBytes(32).toString('hex')}', 'hex'),
 decode('${controlSecret}', 'hex'), clock_timestamp() + interval '10 minutes');`,
  );

  const storage = storageFixture();
  await harness.psql(
    'ba_migrator_test',
    ownerTransaction(`SELECT app.publish_agent_strategy_source(${jsonb(storage)});`),
  );
  const verified = await readback(storage.full_pin);
  assertEqual(
    verified.full_pin.contract_hash,
    storage.full_pin.contract_hash,
    'independent G1 source readback',
  );
  const resolvedPins = jsonLine(
    await harness.psql(
      'ba_control_test',
      controlTransaction(
        `SELECT app.resolve_registered_dependency_pins(${jsonb([storage.full_pin])});`,
      ),
    ),
  );
  assertEqual(
    canonicalJsonBytes(resolvedPins).toString('utf8'),
    canonicalJsonBytes([storage.full_pin]).toString('utf8'),
    'exact requested dependency pin readback',
  );

  const attestedStorage = storageFixture(attestedRelease);
  await harness.psql(
    'ba_management_issuer_test',
    `SELECT auth.issue_g1_source_publication_attestation(
      '${publicationAttestation}', '${workspace}', 'ba_control_test',
      ${jsonb(attestedStorage)}, decode('${publicationVerifier}', 'hex'),
      clock_timestamp() + interval '10 minutes');`,
  );
  assertRejected(
    await harness.psql(
      'ba_control_test',
      controlTransaction(
        `SELECT app.publish_attested_agent_strategy_source(
          '${publicationAttestation}', decode('${randomBytes(32).toString('hex')}', 'hex'),
          ${jsonb(attestedStorage)});`,
      ),
      { allowFailure: true },
    ),
    /42501|attestation is unavailable/u,
    'wrong publication verifier rejected',
  );
  assertRejected(
    await harness.psql(
      'ba_control_test',
      controlTransaction(
        `SELECT app.publish_attested_agent_strategy_source(
          '${publicationAttestation}', decode('${publicationVerifier}', 'hex'),
          ${jsonb({ ...attestedStorage, canonical_source_artifact: '{}' })});`,
      ),
      { allowFailure: true },
    ),
    /42501|attestation is unavailable/u,
    'different source bytes rejected',
  );
  assertEqual(
    lastScalarLine(
      await harness.psql(
        'ba_control_test',
        controlTransaction(
          `SELECT app.publish_attested_agent_strategy_source(
          '${publicationAttestation}', decode('${publicationVerifier}', 'hex'),
          ${jsonb(attestedStorage)});`,
        ),
      ),
    ),
    attestedRelease,
    'exact attested source publication',
  );
  await readback(attestedStorage.full_pin);
  assertRejected(
    await harness.psql(
      'ba_control_test',
      controlTransaction(
        `SELECT app.publish_attested_agent_strategy_source(
          '${publicationAttestation}', decode('${publicationVerifier}', 'hex'),
          ${jsonb(attestedStorage)});`,
      ),
      { allowFailure: true },
    ),
    /42501|attestation is unavailable/u,
    'publication attestation is one-use',
  );

  const revokedStorage = storageFixture(revokedRelease);
  await harness.psql(
    'ba_management_issuer_test',
    `SELECT auth.issue_g1_source_publication_attestation(
      '${revokedPublicationAttestation}', '${workspace}', 'ba_control_test',
      ${jsonb(revokedStorage)}, decode('${publicationVerifier}', 'hex'),
      clock_timestamp() + interval '10 minutes');
    SELECT auth.revoke_g1_source_publication_attestation(
      '${revokedPublicationAttestation}', 'review withdrawn');`,
  );
  assertRejected(
    await harness.psql(
      'ba_control_test',
      controlTransaction(
        `SELECT app.publish_attested_agent_strategy_source(
          '${revokedPublicationAttestation}', decode('${publicationVerifier}', 'hex'),
          ${jsonb(revokedStorage)});`,
      ),
      { allowFailure: true },
    ),
    /42501|attestation is unavailable/u,
    'revoked publication attestation rejected',
  );

  const invalidStorage = {
    ...storageFixture(failedRelease),
    canonical_source_preimage: '{}',
  };
  await harness.psql(
    'ba_management_issuer_test',
    `SELECT auth.issue_g1_source_publication_attestation(
      '${failedPublicationAttestation}', '${workspace}', 'ba_control_test',
      ${jsonb(invalidStorage)}, decode('${publicationVerifier}', 'hex'),
      clock_timestamp() + interval '10 minutes');`,
  );
  assertRejected(
    await harness.psql(
      'ba_control_test',
      controlTransaction(
        `SELECT app.publish_attested_agent_strategy_source(
          '${failedPublicationAttestation}', decode('${publicationVerifier}', 'hex'),
          ${jsonb(invalidStorage)});`,
      ),
      { allowFailure: true },
    ),
    /22023|identity|bytes|schema|manifest/u,
    'failed publication rolls back',
  );
  await harness.psql(
    'ba_management_issuer_test',
    `SELECT auth.revoke_g1_source_publication_attestation(
      '${failedPublicationAttestation}', 'failed source withdrawn');`,
  );

  const publishers = [
    'app.publish_agent_strategy_source(jsonb)',
    'app.publish_instruction_skill_release(jsonb)',
    'app.publish_knowledge_index_generation(jsonb)',
    'app.publish_database_operation_release(jsonb)',
    'app.publish_plugin_tool_release(jsonb)',
    'app.publish_a2a_agent_release(jsonb)',
    'app.publish_skill_pack_release(jsonb)',
  ];
  const attestedPublishers = [
    'app.publish_attested_agent_strategy_source(uuid,bytea,jsonb)',
    'app.publish_attested_instruction_skill_release(uuid,bytea,jsonb)',
    'app.publish_attested_knowledge_index_generation(uuid,bytea,jsonb)',
    'app.publish_attested_database_operation_release(uuid,bytea,jsonb)',
    'app.publish_attested_plugin_tool_release(uuid,bytea,jsonb)',
    'app.publish_attested_a2a_agent_release(uuid,bytea,jsonb)',
    'app.publish_attested_skill_pack_release(uuid,bytea,jsonb)',
  ];
  for (const role of [
    'ba_runtime',
    'ba_control_executor',
    'ba_management_attestation_issuer',
    'ba_subject_assertion_verifier',
    'ba_auth_owner',
  ]) {
    for (const publisher of publishers) {
      assertEqual(
        await harness.queryScalar(
          'ba_migrator_test',
          `SELECT has_function_privilege('${role}', '${publisher}', 'EXECUTE');`,
        ),
        'f',
        `${role} ${publisher} denied`,
      );
    }
    assertEqual(
      await harness.queryScalar(
        'ba_migrator_test',
        `SELECT has_table_privilege('${role}', 'public.published_g1_resource_sources',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE');`,
      ),
      'f',
      `${role} direct DML denied`,
    );
  }
  for (const publisher of attestedPublishers) {
    assertEqual(
      await harness.queryScalar(
        'ba_migrator_test',
        `SELECT has_function_privilege('ba_control_executor', '${publisher}', 'EXECUTE');`,
      ),
      't',
      `control may execute ${publisher}`,
    );
    for (const role of [
      'ba_runtime',
      'ba_management_attestation_issuer',
      'ba_subject_assertion_verifier',
      'ba_auth_owner',
    ])
      assertEqual(
        await harness.queryScalar(
          'ba_migrator_test',
          `SELECT has_function_privilege('${role}', '${publisher}', 'EXECUTE');`,
        ),
        'f',
        `${role} ${publisher} denied`,
      );
  }
  for (const role of [
    'ba_runtime',
    'ba_control_executor',
    'ba_management_attestation_issuer',
    'ba_subject_assertion_verifier',
    'ba_auth_owner',
  ])
    assertEqual(
      await harness.queryScalar(
        'ba_migrator_test',
        `SELECT has_table_privilege('${role}', 'auth.g1_source_publication_attestations',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE');`,
      ),
      'f',
      `${role} publication attestation table denied`,
    );

  for (const signature of [
    'app.resolve_registered_dependency_pins(jsonb)',
    'app.resolve_g1_published_source(jsonb)',
  ]) {
    assertEqual(
      await harness.queryScalar(
        'ba_migrator_test',
        `SELECT has_function_privilege('ba_control_executor', '${signature}', 'EXECUTE');`,
      ),
      't',
      `control may execute ${signature}`,
    );
    for (const role of [
      'ba_runtime',
      'ba_management_attestation_issuer',
      'ba_subject_assertion_verifier',
      'ba_auth_owner',
    ])
      assertEqual(
        await harness.queryScalar(
          'ba_migrator_test',
          `SELECT has_function_privilege('${role}', '${signature}', 'EXECUTE');`,
        ),
        'f',
        `${role} ${signature} denied`,
      );
  }

  for (const [label, call] of [
    [
      'duplicate dependency pins',
      `SELECT app.resolve_registered_dependency_pins(${jsonb([
        storage.full_pin,
        storage.full_pin,
      ])});`,
    ],
    [
      'unknown dependency pin',
      `SELECT app.resolve_registered_dependency_pins(${jsonb([
        { ...storage.full_pin, resource_version_id: '018f47f2-c541-7cc6-9292-4a2c35304eff' },
      ])});`,
    ],
    [
      'cross-workspace source pin',
      `SELECT app.resolve_g1_published_source(${jsonb({
        ...storage.full_pin,
        workspace_id: '018f47f2-c541-7cc6-9292-4a2c35304eff',
      })});`,
    ],
    [
      'open source pin',
      `SELECT app.resolve_g1_published_source(${jsonb({ ...storage.full_pin, extra: true })});`,
    ],
  ])
    assertRejected(
      await harness.psql('ba_control_test', controlTransaction(call), { allowFailure: true }),
      /22023|23503|invalid|duplicate|registered|closed|cross-workspace/u,
      label,
    );

  assertRejected(
    await harness.psql(
      'ba_migrator_test',
      ownerTransaction(`UPDATE public.published_g1_resource_sources SET stored_by='changed';`),
      { allowFailure: true },
    ),
    /55000|immutable/u,
    'G1 source is immutable',
  );
  assertRejected(
    await harness.psql(
      'ba_migrator_test',
      renderDownMigrationSql(migrations, 6, { allowDown: true }),
      { allowFailure: true },
    ),
    /55000|attestations exist/u,
    'non-empty G1 source downgrade rejected',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT relforcerowsecurity FROM pg_class
      WHERE oid='public.published_g1_resource_sources'::regclass;`,
    ),
    't',
    'failed down restores FORCE RLS',
  );

  process.stdout.write(
    'G1 PostgreSQL published source registry passed: exact source bytes, host-reviewed one-use publication, authoritative control readback, independent replay, owner-only table ACL, immutable evidence and guarded down.\n',
  );
  process.stdout.write('architecture-gate-suite/1 g1-published-source-registry pass\n');
}

let failure;
try {
  await main();
} catch (error) {
  failure = error;
}
try {
  await harness.stop();
} catch (error) {
  failure =
    failure === undefined
      ? error
      : new AggregateError([failure, error], 'G1 source registry test and cleanup failed');
}
if (failure !== undefined) throw failure;
