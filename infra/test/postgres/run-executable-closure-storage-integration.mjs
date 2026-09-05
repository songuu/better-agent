import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  loadMigrations,
  renderUpMigrationSql,
  renderDownMigrationSql,
} from '../../../packages/db/dist/index.js';
import {
  canonicalResourceNodeId,
  canonicalSha256,
  prepareExecutableSource,
} from '../../../packages/release-core/dist/index.js';
import {
  prepareExecutableClosureStorage,
  verifyExecutableClosureStorage,
} from '../../../packages/release-core/dist/executable-closure-storage.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harness = createPostgresHarness('g1-executable-closure-storage');
const workspace = '018f47f2-c541-7cc6-9292-4a2c35303eee';
const admin = '018f47f2-c541-7cc6-9292-4a2c35303e01';
const attestation = '018f47f2-c541-7cc6-9292-4a2c35303e02';
const flow = '018f47f2-c541-7cc6-9292-4a2c35303e05';
const secret = randomBytes(32).toString('hex');
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

function flowStorage(version) {
  const sourceInput = {
    schema_version: 'executable-source-candidate/1',
    workspace_id: workspace,
    document: {
      schema_version: 'flow-ir/1',
      flow_id: flow,
      flow_version_id: version,
      title: 'Storage integration fixture',
      input_schema: {},
      output_schema: {},
      resources: [],
      credential_requirements: [],
      execution_defaults: {},
      entry_graph: {
        graph_id: 'root',
        entry_node_id: 'start',
        exit_node_ids: ['output'],
        nodes: [
          {
            node_id: 'start',
            key: 'start',
            type: 'start',
            config: {},
            inputs: {},
            output_schema: {},
          },
          {
            node_id: 'output',
            key: 'output',
            type: 'output',
            config: {},
            inputs: {},
            output_schema: {},
          },
        ],
        edges: [
          {
            edge_id: 'edge',
            kind: 'control',
            from: { node_id: 'start', port: 'control' },
            to: { node_id: 'output', port: 'control' },
          },
        ],
      },
    },
  };
  const source = prepareExecutableSource(sourceInput);
  const budget = {
    schema_version: 'capability-budget/1',
    amount_credits: '0',
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    duration_ms: 0,
  };
  const requirements = {
    schema_version: 'capability-requirements/1',
    credential_requirements: [],
    principal_modes: ['none'],
    egress: [],
    readable_data_classification: 'public',
    output_data_classification: 'public',
    side_effect_class: 'safe',
    approval_required: false,
    operation_contract_hashes: [],
    minimum_limits: { calls: 0, depth: 0, parallelism: 0, budget },
  };
  // Explicitly a complete storage fixture, not a claim that the Flow compiler is implemented.
  const closure = {
    schema_version: 'compiled-capability-closure/1',
    root: source.root,
    assembly_pins: [],
    bindings: [],
    gate_specs: [],
    dependency_edges: [],
    disabled_binding_paths: [],
    resource_nodes: [
      {
        node_id: canonicalResourceNodeId(source.root.pin),
        node_role: 'root',
        pin: source.root.pin,
        dependency_manifest_hash: source.dependency_manifest.manifest_hash,
        intrinsic_policy: {
          schema_version: 'capability-requirement-expression/1',
          expression_kind: 'leaf',
          requirements,
        },
      },
    ],
    aggregate_limits: {
      credential_requirements: [],
      principal_modes: ['none'],
      egress: [],
      readable_data_classification_ceiling: 'public',
      output_data_classification: 'public',
      side_effect: { maximum_class: 'safe', approval: 'none' },
      operation_contract_hashes: [],
      max_calls: 0,
      max_depth: 0,
      max_parallelism: 0,
      budget,
    },
  };
  return prepareExecutableClosureStorage(sourceInput, {
    ...closure,
    closure_hash: canonicalSha256(closure),
  });
}

async function readback(pin) {
  const result = await harness.psql(
    'ba_migrator_test',
    ownerTransaction(`
SELECT jsonb_build_object(
 'prepared_resource', jsonb_build_object(
   'schema_version', 'prepared-published-resource/1',
   'full_pin', ${jsonb(pin)}, 'canonical_document', registry.canonical_document,
   'dependency_manifest', jsonb_build_object(
     'schema_version', 'published-resource-dependency-manifest/1',
     'owner', jsonb_build_object('workspace_id', registry.workspace_id,
       'published_resource_kind', registry.published_resource_kind,
       'resource_id', registry.resource_id, 'resource_version_id', registry.resource_version_id),
     'manifest_hash', registry.dependency_manifest_hash,
     'dependencies', COALESCE((SELECT jsonb_agg(jsonb_build_object(
       'workspace_id', dependency.workspace_id, 'published_resource_kind', dependency.dependency_kind,
       'resource_id', dependency.dependency_resource_id, 'resource_version_id', dependency.dependency_resource_version_id,
       'contract_hash', dependency.dependency_contract_hash, 'binding_mode', dependency.binding_mode
     ) ORDER BY dependency.ordinal) FROM public.published_resource_dependencies AS dependency
       WHERE dependency.workspace_id = registry.workspace_id
       AND dependency.owner_kind = registry.published_resource_kind
       AND dependency.owner_resource_id = registry.resource_id
       AND dependency.owner_resource_version_id = registry.resource_version_id), '[]'::jsonb))),
 'canonical_compiled_preimage', closure.canonical_compiled_preimage,
 'canonical_closure_preimage', closure.canonical_closure_preimage)
FROM public.published_executable_closures AS closure
JOIN public.published_resource_versions AS registry USING
 (workspace_id, published_resource_kind, resource_id, resource_version_id, contract_hash)
WHERE closure.resource_version_id = '${pin.resource_version_id}';`),
  );
  const line = result.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .find((value) => value.startsWith('{'));
  if (line === undefined) throw new Error('compiled registry readback row is missing');
  return verifyExecutableClosureStorage(pin, JSON.parse(line));
}

async function main() {
  await harness.start();
  const migrations = await loadMigrations(
    fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)),
  );
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations));
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces(id,name) VALUES ('${workspace}','closure fixture');
INSERT INTO public.workspace_members(workspace_id,user_id,role) VALUES ('${workspace}','${admin}','admin');`,
  );
  await harness.psql(
    'ba_management_issuer_test',
    `SELECT auth.issue_control_session_attestation(
 '${attestation}', '${workspace}', '${admin}', 'ba_migrator_test', 'closure-test-idp',
 decode('${randomBytes(32).toString('hex')}', 'hex'), decode('${secret}', 'hex'),
 clock_timestamp() + interval '10 minutes');`,
  );
  await harness.psql(
    'ba_migrator_test',
    ownerTransaction(`SELECT app.create_publishable_resource_root('FLOW_VERSION','${flow}');`),
  );

  const storage = flowStorage('018f47f2-c541-7cc6-9292-4a2c35303e06');
  await harness.psql(
    'ba_migrator_test',
    ownerTransaction(`SELECT app.publish_compiled_flow_version(${jsonb(storage)});`),
  );
  const verified = await readback(storage.prepared_resource.full_pin);
  assertEqual(
    verified.full_pin.contract_hash,
    storage.prepared_resource.full_pin.contract_hash,
    'independent compiled pin readback',
  );
  for (const role of [
    'ba_runtime',
    'ba_control_executor',
    'ba_management_attestation_issuer',
    'ba_subject_assertion_verifier',
    'ba_auth_owner',
  ]) {
    assertEqual(
      await harness.queryScalar(
        'ba_migrator_test',
        `SELECT has_function_privilege('${role}', 'app.publish_compiled_flow_version(jsonb)', 'EXECUTE');`,
      ),
      'f',
      `${role} publisher denied`,
    );
    assertEqual(
      await harness.queryScalar(
        'ba_migrator_test',
        `SELECT has_table_privilege('${role}', 'public.published_executable_closures', 'INSERT,UPDATE,DELETE,TRUNCATE');`,
      ),
      'f',
      `${role} direct DML denied`,
    );
  }
  const changed = flowStorage('018f47f2-c541-7cc6-9292-4a2c35303e07');
  const invalid = {
    ...changed,
    canonical_closure_preimage: `${changed.canonical_closure_preimage} `,
  };
  assertRejected(
    await harness.psql(
      'ba_migrator_test',
      ownerTransaction(`SELECT app.publish_compiled_flow_version(${jsonb(invalid)});`),
      { allowFailure: true },
    ),
    /22023|not bound/u,
    'late closure failure rejects publication',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT count(*) FROM public.flow_versions WHERE id='${changed.prepared_resource.full_pin.resource_version_id}';`,
    ),
    '0',
    'late failure rolls typed row back',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT count(*) FROM public.published_resource_versions WHERE resource_version_id='${changed.prepared_resource.full_pin.resource_version_id}';`,
    ),
    '0',
    'late failure rolls registry row back',
  );
  await harness.psql(
    'ba_migrator_test',
    ownerTransaction(`SELECT app.publish_compiled_flow_version(${jsonb(changed)});`),
  );
  await readback(changed.prepared_resource.full_pin);
  assertRejected(
    await harness.psql(
      'ba_migrator_test',
      ownerTransaction(`UPDATE public.published_executable_closures SET stored_by='changed';`),
      { allowFailure: true },
    ),
    /55000|immutable/u,
    'stored closure is immutable',
  );
  assertRejected(
    await harness.psql(
      'ba_migrator_test',
      renderDownMigrationSql(migrations, 5, { allowDown: true }),
      { allowFailure: true },
    ),
    /55000|after publication/u,
    'non-empty rollback rejects across tenant context',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT relforcerowsecurity FROM pg_class WHERE oid='public.published_executable_closures'::regclass;`,
    ),
    't',
    'failed down restores FORCE RLS',
  );
  process.stdout.write(
    'G1 PostgreSQL executable closure storage passed: typed publication, independent source/hash readback, owner-only ACL, late-failure rollback/retry, immutable evidence and guarded down.\n',
  );
  process.stdout.write('architecture-gate-suite/1 executable-closure-storage pass\n');
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
      : new AggregateError([failure, error], 'closure storage test and cleanup failed');
}
if (failure !== undefined) throw failure;
