import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harness = createPostgresHarness('product-agent-strategy-profile');
const migrationDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/migrations',
);
const workspaceId = 'f2900000-0000-4000-8000-000000000001';
const actorId = 'f2900000-0000-4000-8000-000000000002';
const autonomous = JSON.stringify({
  forced_capability: 'none',
  max_input_tokens: 1000,
  max_iterations: 1,
  max_output_tokens: 200,
  max_tool_calls: 2,
  parameter_extraction: true,
  routes: [
    { model: 'gpt-5.4-mini', description: 'fast' },
    { model: 'gpt-5.6-sol', description: 'reasoning' },
  ],
  routing_mode: 'autonomous',
  schema_version: 'product-agent-strategy/1',
  temperature: 0.3,
});
const fixed = JSON.stringify({
  forced_capability: 'none',
  max_input_tokens: 500,
  max_iterations: 1,
  max_output_tokens: 100,
  max_tool_calls: 0,
  parameter_extraction: false,
  routes: [{ model: 'gpt-5.6-sol', description: 'default' }],
  routing_mode: 'fixed',
  schema_version: 'product-agent-strategy/1',
  temperature: 0,
});

async function main() {
  await harness.start();
  const migrations = await loadMigrations(migrationDirectory);
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), { echoErrors: true });
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces(id,name) VALUES('${workspaceId}','Strategies');`,
  );
  const agentId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_draft_with_strategy_capabilities(
    '${workspaceId}','${actorId}','Router','','route safely','gpt-5.6-sol',NULL,NULL,'text',NULL,'${autonomous}'::jsonb)).id;`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.publish_agent_draft('${workspaceId}','${agentId}',1,'${actorId}');`,
  );
  const conversationV1 = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_product_conversation('${workspaceId}','${agentId}','${actorId}')).id;`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.update_agent_draft_with_strategy_capabilities('${workspaceId}','${agentId}',2,
    'Router','','route safely','gpt-5.6-sol',NULL,NULL,'text',NULL,'${fixed}'::jsonb);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT strategy_version FROM app.list_agent_drafts_with_role_capabilities('${workspaceId}') WHERE id='${agentId}';`,
    ),
    '2',
    'draft strategy version',
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.publish_agent_draft('${workspaceId}','${agentId}',3,'${actorId}');`,
  );
  const conversationV2 = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_product_conversation('${workspaceId}','${agentId}','${actorId}')).id;`,
  );
  const runV1 = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT run_id FROM app.begin_agent_product_run('${workspaceId}','${conversationV1}','${actorId}','complex issue');`,
  );
  const deniedRun = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT run_id FROM app.begin_agent_product_run('${workspaceId}','${conversationV1}','${actorId}','unsupported route');`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT (strategy_profile->>'routing_mode')||':'||strategy_version FROM app.begin_agent_product_run('${workspaceId}','${conversationV2}','${actorId}','simple issue');`,
    ),
    'fixed:2',
    'new conversation pins strategy v2',
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.route_agent_product_run('${workspaceId}','${runV1}','${actorId}','gpt-5.4-mini','resp-route-1',20,4);`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.record_agent_product_run_parameters('${workspaceId}','${runV1}','${actorId}',
      '{"database_contains":"healthy","knowledge_query":"production health"}'::jsonb,
      'resp-parameters-1',30,5);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT extracted_parameters->>'knowledge_query'||':'||parameter_provider_request_id||':'||parameter_input_tokens||':'||parameter_output_tokens
       FROM app.list_agent_product_runs('${workspaceId}') WHERE id='${runV1}';`,
    ),
    'production health:resp-parameters-1:30:5',
    'parameter extraction evidence',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.record_agent_product_run_parameters('${workspaceId}','${runV1}','${actorId}',
        '{"database_contains":"changed","knowledge_query":"changed"}'::jsonb,
        'resp-parameters-replay',1,1);`,
      { allowFailure: true },
    ),
    /parameter extraction conflict|40001/u,
    'parameter extraction replay',
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.complete_agent_product_run('${workspaceId}','${runV1}','${actorId}','done','resp-1',100,80);`,
  );
  const fixedRun = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT run_id FROM app.begin_agent_product_run('${workspaceId}','${conversationV2}','${actorId}','no extraction');`,
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.record_agent_product_run_parameters('${workspaceId}','${fixedRun}','${actorId}',
        '{"database_contains":"","knowledge_query":"no extraction"}'::jsonb,
        'resp-parameters-denied',1,1);`,
      { allowFailure: true },
    ),
    /parameter extraction conflict|40001/u,
    'disabled parameter extraction',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.route_agent_product_run('${workspaceId}','${deniedRun}','${actorId}','gpt-5.5','resp-route-denied',0,0);`,
      { allowFailure: true },
    ),
    /routing conflict|40001/u,
    'unapproved route',
  );
  assertRejected(
    await harness.psql('ba_runtime_test', 'SELECT strategy_profile FROM public.agent_drafts;', {
      allowFailure: true,
    }),
    /permission denied|42501/u,
    'runtime direct strategy read',
  );
  assertRejected(
    await harness.psql(
      'ba_migrator_test',
      `SET ROLE ba_authorization_owner; UPDATE public.agent_product_releases SET strategy_version=99 WHERE workspace_id='${workspaceId}';`,
      { allowFailure: true },
    ),
    /immutable|55000/u,
    'immutable strategy release',
  );
  process.stdout.write(
    `PostgreSQL 16 product Agent strategy passed: ${migrations.length} migrations, closed profiles, versioned drafts, immutable releases, conversation pinning, autonomous route allowlist, audited parameter extraction and aggregate token budgets.\n`,
  );
  process.stdout.write('architecture-gate-suite/1 product-agent-strategy-profile pass\n');
}

let mainFailure;
try {
  await main();
} catch (error) {
  mainFailure = error;
}
const cleanup = await Promise.allSettled([harness.stop()]);
const failures = [
  mainFailure,
  ...cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason),
].filter(Boolean);
if (failures.length === 1) throw failures[0];
if (failures.length > 1)
  throw new AggregateError(failures, 'product Agent strategy harness failed');
