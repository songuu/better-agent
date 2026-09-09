import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harness = createPostgresHarness('product-database-operation');
const migrationDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/migrations',
);
const workspaceId = 'f4200000-0000-4000-8000-000000000001';
const otherWorkspaceId = 'f4200000-0000-4000-8000-000000000002';
const actorId = 'f4200000-0000-4000-8000-000000000003';
const strategy = JSON.stringify({
  forced_capability: 'database',
  max_input_tokens: 32000,
  max_iterations: 1,
  max_output_tokens: 2000,
  max_tool_calls: 1,
  parameter_defaults: { database_contains: '', knowledge_query: '' },
  parameter_extraction: false,
  routes: [{ description: 'database', model: 'gpt-5.6-sol' }],
  routing_mode: 'fixed',
  schema_version: 'product-agent-strategy/2',
  temperature: 0.2,
});
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const jsonb = (value) => `${sqlLiteral(JSON.stringify(value))}::jsonb`;

async function main() {
  await harness.start();
  const migrations = await loadMigrations(migrationDirectory);
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), { echoErrors: true });
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces(id,name) VALUES
     ('${workspaceId}','Database Operations'),('${otherWorkspaceId}','Other Workspace');`,
  );
  const tableId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT app.create_product_database_table(
      '${workspaceId}','${actorId}','customers','Operation source',
      '["customer_id","status","secret"]'::jsonb);`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.append_product_database_rows(
      '${workspaceId}','${tableId}','${actorId}',
      '[{"customer_id":"b","status":"paused","secret":"x"},{"customer_id":"a","status":"active","secret":"y"},{"customer_id":"c","status":"active","secret":"z"}]'::jsonb);`,
  );
  const operationId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT app.create_product_database_operation(
      '${workspaceId}','${actorId}','${tableId}','Active customers','Pinned read policy',
      '["customer_id","status"]'::jsonb,'status','customer_id','asc',2);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT string_agg((record->>'customer_id')||':'||(record->>'status')||':'||(record ? 'secret')::text,',' ORDER BY ordinal)
       FROM app.execute_product_database_operation('${workspaceId}','${operationId}',1,'active');`,
    ),
    'a:active:false,c:active:false',
    'operation projection, filter and limit',
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.update_product_database_operation(
      '${workspaceId}','${operationId}',1,'${actorId}','${tableId}','Newest active customer',
      'Second immutable policy','["customer_id","status"]'::jsonb,'status','customer_id','desc',1);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT record->>'customer_id' FROM app.execute_product_database_operation(
        '${workspaceId}','${operationId}',2,'active');`,
    ),
    'c',
    'new operation release policy',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT string_agg(record->>'customer_id',',' ORDER BY ordinal)
       FROM app.execute_product_database_operation('${workspaceId}','${operationId}',1,'active');`,
    ),
    'a,c',
    'old operation release remains executable',
  );
  const graph = {
    edges: [
      { id: 'input_database', source: 'input', target: 'database' },
      { id: 'database_output', source: 'database', target: 'output' },
    ],
    nodes: [
      { config: { key: 'message' }, id: 'input', label: 'Input', type: 'input' },
      {
        config: { operationId, operationRevision: 1, source: 'input' },
        id: 'database',
        label: 'Active customers',
        type: 'database',
      },
      { config: { source: 'database' }, id: 'output', label: 'Output', type: 'output' },
    ],
  };
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.create_product_flow_draft(
      '${workspaceId}','${actorId}','Database Flow','Pinned operation',${jsonb(graph)});`,
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.create_product_flow_draft(
        '${otherWorkspaceId}','${actorId}','Foreign Database Flow','Invalid pin',${jsonb(graph)});`,
      { allowFailure: true },
    ),
    /snapshot is not pinned|42501/u,
    'cross-workspace Flow operation pin',
  );
  const agentId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_draft_with_strategy_capabilities_v9(
      '${workspaceId}','${actorId}','Database Agent','','Use pinned operation','gpt-5.6-sol',
      NULL,NULL,'text',NULL,${sqlLiteral(strategy)}::jsonb,NULL,NULL,NULL,NULL,NULL,NULL,
      '${operationId}',1)).id;`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.publish_agent_draft('${workspaceId}','${agentId}',1,'${actorId}');`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.mutate_product_database_row(
      '${workspaceId}','${tableId}',1,1,'${actorId}','update',
      '{"customer_id":"a","status":"paused","secret":"changed"}'::jsonb);
     SELECT app.append_product_database_rows(
      '${workspaceId}','${tableId}','${actorId}',
      '[{"customer_id":"d","status":"active","secret":"later"}]'::jsonb);`,
  );
  const conversationId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_product_conversation('${workspaceId}','${agentId}','${actorId}')).id;`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT string_agg((record->>'customer_id')||':'||(record ? 'secret')::text,',' ORDER BY row_ordinal)
       FROM app.read_agent_product_conversation_database(
         '${workspaceId}','${conversationId}','active',20);`,
    ),
    'a:false,c:false',
    'Agent release keeps exact operation policy and publication-time rows',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      'SELECT count(*) FROM public.product_database_operation_releases;',
      { allowFailure: true },
    ),
    /permission denied|42501/u,
    'runtime direct operation release read',
  );
  assertRejected(
    await harness.psql(
      'ba_migrator_test',
      `SET ROLE ba_authorization_owner;
       UPDATE public.product_database_operation_releases SET row_limit=100
       WHERE workspace_id='${workspaceId}' AND operation_id='${operationId}' AND revision=1;`,
      { allowFailure: true },
    ),
    /immutable|55000/u,
    'immutable operation release',
  );

  process.stdout.write(
    `PostgreSQL 16 product Database Operation passed: ${migrations.length} migrations, immutable versioned policies, bounded projection/filter/order/limit, Flow pins, Agent publication snapshots, tenant isolation and direct-table denial.\n`,
  );
  process.stdout.write('architecture-gate-suite/1 product-database-operation pass\n');
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
  throw new AggregateError(failures, 'product Database Operation harness failed');
}
