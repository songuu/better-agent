import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harness = createPostgresHarness('product-flow-studio');
const migrationDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/migrations',
);
const workspaceId = 'f2200000-0000-4000-8000-000000000001';
const actorId = 'f2200000-0000-4000-8000-000000000002';
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const jsonb = (value) => `${sqlLiteral(JSON.stringify(value))}::jsonb`;
const graph = Object.freeze({
  edges: [
    { id: 'input_prompt', source: 'input', target: 'prompt' },
    { id: 'prompt_condition', source: 'prompt', target: 'condition' },
    { id: 'condition_output', source: 'condition', target: 'output' },
  ],
  nodes: [
    { config: { key: 'message' }, id: 'input', label: 'Input', type: 'input' },
    {
      config: { template: 'Processed: {{message}}' },
      id: 'prompt',
      label: 'Template',
      type: 'template',
    },
    {
      config: {
        operand: 'urgent',
        operator: 'contains',
        source: 'prompt',
        whenFalse: 'normal: {{value}}',
        whenTrue: 'urgent: {{value}}',
      },
      id: 'condition',
      label: 'Condition',
      type: 'condition',
    },
    { config: { source: 'condition' }, id: 'output', label: 'Output', type: 'output' },
  ],
});
const logs = Object.freeze([
  { nodeId: 'input', outputPreview: 'acceptance', status: 'completed' },
  { nodeId: 'prompt', outputPreview: 'Processed: acceptance', status: 'completed' },
  { nodeId: 'condition', outputPreview: 'normal: Processed: acceptance', status: 'completed' },
  { nodeId: 'output', outputPreview: 'normal: Processed: acceptance', status: 'completed' },
]);

async function main() {
  await harness.start();
  const migrations = await loadMigrations(migrationDirectory);
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), { echoErrors: true });
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces(id,name) VALUES('${workspaceId}','Product Flow Studio');`,
  );

  const flowId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT app.create_product_flow_draft(
  '${workspaceId}','${actorId}','Acceptance Flow','Condition-node mapping',${jsonb(graph)}
);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws('|',name,status,revision,published_version IS NULL,jsonb_array_length(deployments))
FROM app.list_product_flow_drafts('${workspaceId}') WHERE id='${flowId}';`,
    ),
    'Acceptance Flow|draft|1|t|0',
    'runtime reads the newly persisted Flow Draft through the definer surface',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `INSERT INTO public.product_flow_drafts(
  workspace_id,id,name,description,graph,created_by
) VALUES('${workspaceId}',gen_random_uuid(),'forbidden','',${jsonb(graph)},'${actorId}');`,
      { allowFailure: true },
    ),
    /permission denied|42501/u,
    'runtime cannot bypass the Flow definer surface with direct DML',
  );

  const preparedGraph = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT app.prepare_product_flow_debug('${workspaceId}','${flowId}',1,'${actorId}')::text;`,
  );
  if (!preparedGraph.includes('prompt_condition') || !preparedGraph.includes('condition_output')) {
    throw new Error('prepared Flow debug graph did not preserve the exact node mapping');
  }
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.record_product_flow_debug(
  '${workspaceId}','${flowId}',1,'${actorId}','acceptance','normal: Processed: acceptance',${jsonb(logs)}
);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws('|',draft_revision,status,input_text,output_text,jsonb_array_length(logs))
FROM app.list_product_flow_debug_runs('${workspaceId}','${flowId}');`,
    ),
    '1|completed|acceptance|normal: Processed: acceptance|4',
    'debug trace is durable and ordered behind a bounded readback function',
  );

  await harness.psql(
    'ba_runtime_test',
    `SELECT app.publish_product_flow('${workspaceId}','${flowId}',1,'${actorId}','staging');`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws('|',status,revision,published_version,
  deployments #>> '{0,environment}',deployments #>> '{0,release_version}')
FROM app.list_product_flow_drafts('${workspaceId}') WHERE id='${flowId}';`,
    ),
    'published|2|1|staging|1',
    'publish atomically seals an immutable release and switches one environment',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT graph #>> '{nodes,2,type}' FROM public.product_flow_releases
WHERE workspace_id='${workspaceId}' AND flow_id='${flowId}' AND version=1;`,
    ),
    'condition',
    'immutable Flow release preserves the exact executable condition node',
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.update_product_flow_draft(
  '${workspaceId}','${flowId}',2,'Acceptance Flow V2','Second release',${jsonb(graph)}
);`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.publish_product_flow('${workspaceId}','${flowId}',3,'${actorId}','staging');`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT string_agg(concat(version,':',name),',' ORDER BY version DESC)
FROM app.list_product_flow_releases('${workspaceId}','${flowId}');`,
    ),
    '2:Acceptance Flow V2,1:Acceptance Flow',
    'runtime reads bounded immutable Flow release history',
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.rollback_product_flow_deployment(
  '${workspaceId}','${flowId}','staging',2,1,'${actorId}','V2 acceptance regression'
);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',release_version,revision) FROM public.product_flow_deployments
WHERE workspace_id='${workspaceId}' AND flow_id='${flowId}' AND environment='staging';`,
    ),
    '1|3',
    'rollback atomically switches only the environment deployment pointer',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws('|',environment,from_release_version,target_release_version,reason)
FROM app.list_product_flow_rollbacks('${workspaceId}','${flowId}');`,
    ),
    'staging|2|1|V2 acceptance regression',
    'rollback produces an owner-read immutable audit receipt',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.rollback_product_flow_deployment(
  '${workspaceId}','${flowId}','staging',2,1,'${actorId}','stale retry'
);`,
      { allowFailure: true },
    ),
    /Flow deployment rollback conflict|40001/u,
    'stale rollback loses the deployment release CAS',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `INSERT INTO public.product_flow_deployment_rollbacks(
  workspace_id,id,flow_id,environment,from_release_version,target_release_version,reason,rolled_back_by
) VALUES('${workspaceId}',gen_random_uuid(),'${flowId}','staging',2,1,'forbidden','${actorId}');`,
      { allowFailure: true },
    ),
    /permission denied|42501/u,
    'runtime cannot forge rollback receipts with direct DML',
  );
  assertRejected(
    await harness.psql(
      'ba_bootstrap_test',
      `UPDATE public.product_flow_deployment_rollbacks SET reason='tampered'
WHERE workspace_id='${workspaceId}' AND flow_id='${flowId}';`,
      { allowFailure: true },
    ),
    /product Flow history is immutable|55000/u,
    'rollback receipts remain immutable to the fixture principal',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.update_product_flow_draft(
  '${workspaceId}','${flowId}',1,'stale','',${jsonb(graph)}
);`,
      { allowFailure: true },
    ),
    /Flow draft revision conflict|40001/u,
    'stale Flow mutation loses the revision CAS',
  );
  assertRejected(
    await harness.psql(
      'ba_bootstrap_test',
      `UPDATE public.product_flow_releases SET name='tampered'
WHERE workspace_id='${workspaceId}' AND flow_id='${flowId}' AND version=1;`,
      { allowFailure: true },
    ),
    /product Flow history is immutable|55000/u,
    'sealed Flow releases reject mutation even through the bootstrap fixture principal',
  );

  process.stdout.write(
    `PostgreSQL 16 product Flow Studio passed: ${migrations.length} migrations, executable condition nodes, owner-only Draft CAS, immutable releases, audited environment rollback, durable debug traces and direct-DML denial.\n`,
  );
  process.stdout.write('architecture-gate-suite/1 product-flow-studio pass\n');
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
  throw new AggregateError(failures, 'product Flow Studio harness failed');
}
