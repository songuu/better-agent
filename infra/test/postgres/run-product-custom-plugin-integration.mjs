import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harness = createPostgresHarness('product-custom-plugin');
const migrationDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/migrations',
);
const workspaceId = 'f4100000-0000-4000-8000-000000000001';
const otherWorkspaceId = 'f4100000-0000-4000-8000-000000000002';
const actorId = 'f4100000-0000-4000-8000-000000000003';
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

function graph(pluginId, revision, operation, endpointUrl, responsePath) {
  const identity = `custom.${pluginId.replaceAll('-', '')}.v${revision}`;
  return {
    edges: [
      { id: 'input_plugin', source: 'input', target: 'plugin' },
      { id: 'plugin_output', source: 'plugin', target: 'output' },
    ],
    nodes: [
      { config: { key: 'message' }, id: 'input', label: 'Input', type: 'input' },
      {
        config: {
          endpointUrl,
          operation,
          plugin: identity,
          pluginId,
          pluginRevision: revision,
          responsePath,
          source: 'input',
        },
        id: 'plugin',
        label: 'Custom Plugin',
        type: 'plugin',
      },
      { config: { source: 'plugin' }, id: 'output', label: 'Output', type: 'output' },
    ],
  };
}

async function main() {
  await harness.start();
  const migrations = await loadMigrations(migrationDirectory);
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), { echoErrors: true });
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces(id,name) VALUES
('${workspaceId}','Custom Plugin'),('${otherWorkspaceId}','Other Workspace');`,
  );

  const pluginId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT app.create_product_custom_plugin(
    '${workspaceId}','${actorId}','Summarizer','Summarize text','summarize',
    'https://plugins.example.com/v1/summarize','result.text');`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws('|',id,revision,operation,endpoint_url,response_path)
      FROM app.list_product_custom_plugins('${workspaceId}');`,
    ),
    `${pluginId}|1|summarize|https://plugins.example.com/v1/summarize|result.text`,
    'created custom Plugin release',
  );
  const catalogId = `custom.${pluginId.replaceAll('-', '')}`;
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws('|',identity,manifest->>'runtime',installation_id IS NOT NULL)
      FROM app.list_product_plugin_catalog('${workspaceId}') WHERE plugin_id='${catalogId}';`,
    ),
    `${catalogId}.v1|https|t`,
    'private release is auto-installed in its owner workspace',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT count(*) FROM app.list_product_plugin_catalog('${otherWorkspaceId}')
      WHERE plugin_id='${catalogId}';`,
    ),
    '0',
    'custom Plugin catalog is tenant isolated',
  );

  await harness.psql(
    'ba_runtime_test',
    `SELECT app.update_product_custom_plugin(
    '${workspaceId}','${pluginId}',1,'${actorId}','Summarizer','Version two','summarize_v2',
    'https://plugins.example.com/v2/summarize','data.summary');`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws('|',revision,operation,endpoint_url)
      FROM app.list_product_custom_plugins('${workspaceId}');`,
    ),
    '2|summarize_v2|https://plugins.example.com/v2/summarize',
    'CAS-updated custom Plugin head',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.update_product_custom_plugin(
      '${workspaceId}','${pluginId}',1,'${actorId}','Stale','','stale','https://plugins.example.com/stale','');`,
      { allowFailure: true },
    ),
    /Custom Plugin revision conflict|40001/u,
    'stale custom Plugin update',
  );

  const revisionTwo = graph(
    pluginId,
    2,
    'summarize_v2',
    'https://plugins.example.com/v2/summarize',
    'data.summary',
  );
  const flowId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT app.create_product_flow_draft(
    '${workspaceId}','${actorId}','Plugin Flow','Pinned custom Plugin',${literal(JSON.stringify(revisionTwo))}::jsonb);`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.publish_product_flow('${workspaceId}','${flowId}',1,'${actorId}','development');`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT graph#>>'{nodes,1,config,plugin}' FROM public.product_flow_releases
      WHERE workspace_id='${workspaceId}' AND flow_id='${flowId}' AND version=1;`,
    ),
    `${catalogId}.v2`,
    'published Flow retains exact custom Plugin identity',
  );

  const tampered = graph(
    pluginId,
    2,
    'summarize_v2',
    'https://evil.example.net/collect',
    'data.summary',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.create_product_flow_draft(
      '${workspaceId}','${actorId}','Tampered','Must reject',${literal(JSON.stringify(tampered))}::jsonb);`,
      { allowFailure: true },
    ),
    /custom Plugin snapshot does not match installed release|42501/u,
    'tampered custom Plugin endpoint',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      'SELECT count(*) FROM public.product_custom_plugin_releases;',
      { allowFailure: true },
    ),
    /permission denied|42501/u,
    'runtime direct custom Plugin release read',
  );
  assertRejected(
    await harness.psql(
      'ba_bootstrap_test',
      `UPDATE public.product_custom_plugin_releases SET endpoint_url='https://evil.example.net'
      WHERE workspace_id='${workspaceId}' AND plugin_id='${pluginId}' AND version=1;`,
      { allowFailure: true },
    ),
    /product Flow history is immutable|55000/u,
    'immutable custom Plugin release',
  );

  process.stdout.write(
    `PostgreSQL 16 product custom Plugin passed: ${migrations.length} migrations, private CAS heads, immutable HTTPS releases, exact Flow snapshot, tenant isolation and direct-DML denial.\n`,
  );
  process.stdout.write('architecture-gate-suite/1 product-custom-plugin pass\n');
}

let mainFailure;
try {
  await main();
} catch (error) {
  mainFailure = error;
}
const cleanup = await Promise.allSettled([harness.stop()]);
const cleanupFailures = cleanup.flatMap((result) =>
  result.status === 'rejected' ? [result.reason] : [],
);
const failures = mainFailure === undefined ? cleanupFailures : [mainFailure, ...cleanupFailures];
if (failures.length === 1) throw failures[0];
if (failures.length > 1) throw new AggregateError(failures, 'product custom Plugin harness failed');
