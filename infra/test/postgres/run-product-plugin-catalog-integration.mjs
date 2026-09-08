import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harness = createPostgresHarness('product-plugin-catalog');
const migrationDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/migrations',
);
const workspaceId = 'f3700000-0000-4000-8000-000000000001';
const otherWorkspaceId = 'f3700000-0000-4000-8000-000000000002';
const actorId = 'f3700000-0000-4000-8000-000000000003';
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const graph = {
  edges: [
    { id: 'input_plugin', source: 'input', target: 'plugin' },
    { id: 'plugin_output', source: 'plugin', target: 'output' },
  ],
  nodes: [
    { config: { key: 'message' }, id: 'input', label: 'Input', type: 'input' },
    {
      config: { operation: 'character_count', plugin: 'builtin.text.v1', source: 'input' },
      id: 'plugin',
      label: 'Text plugin',
      type: 'plugin',
    },
    { config: { source: 'plugin' }, id: 'output', label: 'Output', type: 'output' },
  ],
};
const graphSql = `${sqlLiteral(JSON.stringify(graph))}::jsonb`;

async function main() {
  await harness.start();
  const migrations = await loadMigrations(migrationDirectory);
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), { echoErrors: true });
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces(id,name) VALUES
('${workspaceId}','Plugin Catalog'),('${otherWorkspaceId}','Other Workspace');`,
  );

  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws('|',identity,manifest ->> 'runtime',installation_id IS NULL)
       FROM app.list_product_plugin_catalog('${workspaceId}');`,
    ),
    'builtin.text.v1|deterministic|t',
    'versioned plugin catalog before installation',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.create_product_flow_draft(
        '${workspaceId}','${actorId}','Blocked Flow','Plugin must be installed',${graphSql});`,
      { allowFailure: true },
    ),
    /plugin is not installed in this workspace|42501/u,
    'Flow draft referencing an uninstalled plugin',
  );

  const installationId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT app.install_product_plugin('${workspaceId}','${actorId}','builtin.text',1);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws('|',identity,installation_id,manifest -> 'operations')
       FROM app.list_product_plugin_catalog('${workspaceId}');`,
    ),
    `builtin.text.v1|${installationId}|["character_count", "word_count"]`,
    'workspace plugin installation readback',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT installation_id IS NULL FROM app.list_product_plugin_catalog('${otherWorkspaceId}');`,
    ),
    't',
    'plugin installation does not cross workspace boundaries',
  );

  const flowId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT app.create_product_flow_draft(
      '${workspaceId}','${actorId}','Installed Flow','Exact plugin release',${graphSql});`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT graph #>> '{nodes,1,config,plugin}'
       FROM app.list_product_flow_drafts('${workspaceId}') WHERE id = '${flowId}';`,
    ),
    'builtin.text.v1',
    'installed exact plugin identity persists in the Flow draft',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.create_product_flow_draft(
        '${otherWorkspaceId}','${actorId}','Foreign Flow','Must remain isolated',${graphSql});`,
      { allowFailure: true },
    ),
    /plugin is not installed in this workspace|42501/u,
    'cross-workspace plugin installation reuse',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.install_product_plugin('${workspaceId}','${actorId}','builtin.text',2);`,
      { allowFailure: true },
    ),
    /Plugin release not found|P0002/u,
    'unknown plugin release installation',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      'SELECT count(*) FROM public.product_plugin_installations;',
      { allowFailure: true },
    ),
    /permission denied|42501/u,
    'runtime direct plugin installation table read',
  );
  assertRejected(
    await harness.psql(
      'ba_bootstrap_test',
      `UPDATE public.product_plugin_releases SET name = 'tampered'
       WHERE plugin_id = 'builtin.text' AND version = 1;`,
      { allowFailure: true },
    ),
    /product Flow history is immutable|55000/u,
    'immutable plugin catalog release',
  );

  process.stdout.write(
    `PostgreSQL 16 product Plugin catalog passed: ${migrations.length} migrations, immutable catalog releases, workspace installation, Flow binding enforcement, tenant isolation and direct-DML denial.\n`,
  );
  process.stdout.write('architecture-gate-suite/1 product-plugin-catalog pass\n');
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
  throw new AggregateError(failures, 'product Plugin catalog harness failed');
}
