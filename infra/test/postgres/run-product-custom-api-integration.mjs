import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harness = createPostgresHarness('product-custom-api');
const migrationDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/migrations',
);
const workspaceId = 'f3800000-0000-4000-8000-000000000001';
const otherWorkspaceId = 'f3800000-0000-4000-8000-000000000002';
const actorId = 'f3800000-0000-4000-8000-000000000003';
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

function apiGraph(apiId, revision, method, url, responsePath) {
  return {
    edges: [
      { id: 'input_api', source: 'input', target: 'api' },
      { id: 'api_output', source: 'api', target: 'output' },
    ],
    nodes: [
      { config: { key: 'message' }, id: 'input', label: 'Input', type: 'input' },
      {
        config: {
          apiId,
          apiRevision: revision,
          method,
          responsePath,
          source: 'input',
          url,
        },
        id: 'api',
        label: 'Order API',
        type: 'api',
      },
      { config: { source: 'api' }, id: 'output', label: 'Output', type: 'output' },
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
('${workspaceId}','Custom API'),('${otherWorkspaceId}','Other Workspace');`,
  );

  const apiId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT app.create_product_custom_api(
      '${workspaceId}','${actorId}','Order API','Read order status','POST',
      'https://api.example.com/v1/orders','data.answer');`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws('|',id,revision,method,endpoint_url,response_path)
       FROM app.list_product_custom_apis('${workspaceId}');`,
    ),
    `${apiId}|1|POST|https://api.example.com/v1/orders|data.answer`,
    'created Custom API exact revision',
  );

  await harness.psql(
    'ba_runtime_test',
    `SELECT app.update_product_custom_api(
      '${workspaceId}','${apiId}',1,'${actorId}','Order API','Read order state','GET',
      'https://api.example.com/v2/orders','data.status');`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws('|',revision,method,endpoint_url,response_path)
       FROM app.list_product_custom_apis('${workspaceId}');`,
    ),
    '2|GET|https://api.example.com/v2/orders|data.status',
    'CAS-updated Custom API head',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.update_product_custom_api(
        '${workspaceId}','${apiId}',1,'${actorId}','Stale','', 'GET',
        'https://api.example.com/stale','');`,
      { allowFailure: true },
    ),
    /Custom API revision conflict|40001/u,
    'stale Custom API update',
  );

  const revisionOneGraph = apiGraph(
    apiId,
    1,
    'POST',
    'https://api.example.com/v1/orders',
    'data.answer',
  );
  const graphSql = `${sqlLiteral(JSON.stringify(revisionOneGraph))}::jsonb`;
  const flowId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT app.create_product_flow_draft(
      '${workspaceId}','${actorId}','API Flow','Pinned API revision',${graphSql});`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT app.prepare_product_flow_debug('${workspaceId}','${flowId}',1,'${actorId}')
        #>> '{nodes,1,config,apiRevision}';`,
    ),
    '1',
    'historical exact API revision remains executable',
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.publish_product_flow('${workspaceId}','${flowId}',1,'${actorId}','development');`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT graph #>> '{nodes,1,config,url}' FROM public.product_flow_releases
       WHERE workspace_id = '${workspaceId}' AND flow_id = '${flowId}' AND version = 1;`,
    ),
    'https://api.example.com/v1/orders',
    'published Flow retains immutable API transport snapshot',
  );

  const tamperedGraph = apiGraph(
    apiId,
    1,
    'POST',
    'https://evil.example.net/collect',
    'data.answer',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.create_product_flow_draft(
        '${workspaceId}','${actorId}','Tampered Flow','Must reject',
        ${sqlLiteral(JSON.stringify(tamperedGraph))}::jsonb);`,
      { allowFailure: true },
    ),
    /Flow API resource snapshot is not pinned|42501/u,
    'tampered endpoint snapshot',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.create_product_flow_draft(
        '${otherWorkspaceId}','${actorId}','Foreign Flow','Must remain isolated',${graphSql});`,
      { allowFailure: true },
    ),
    /Flow API resource snapshot is not pinned|42501/u,
    'cross-workspace API release reuse',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.create_product_custom_api(
        '${workspaceId}','${actorId}','Unsafe','','GET','http://127.0.0.1/admin','');`,
      { allowFailure: true },
    ),
    /violates check constraint|23514/u,
    'non-HTTPS API resource',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      'SELECT count(*) FROM public.product_custom_api_releases;',
      { allowFailure: true },
    ),
    /permission denied|42501/u,
    'runtime direct Custom API release read',
  );
  assertRejected(
    await harness.psql(
      'ba_bootstrap_test',
      `UPDATE public.product_custom_api_releases SET endpoint_url = 'https://evil.example.net'
       WHERE workspace_id = '${workspaceId}' AND api_id = '${apiId}' AND revision = 1;`,
      { allowFailure: true },
    ),
    /product Flow history is immutable|55000/u,
    'immutable Custom API release',
  );

  process.stdout.write(
    `PostgreSQL 16 product Custom API passed: ${migrations.length} migrations, CAS resource heads, immutable exact revisions, Flow snapshot binding, tenant isolation and direct-DML denial.\n`,
  );
  process.stdout.write('architecture-gate-suite/1 product-custom-api pass\n');
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
if (failures.length > 1) {
  throw new AggregateError(failures, 'product Custom API harness failed');
}
