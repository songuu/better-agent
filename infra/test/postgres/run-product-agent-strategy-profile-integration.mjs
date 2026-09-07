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
  max_iterations: 2,
  max_output_tokens: 200,
  max_tool_calls: 2,
  parameter_defaults: { database_contains: 'healthy', knowledge_query: 'production health' },
  parameter_extraction: true,
  routes: [
    { model: 'gpt-5.4-mini', description: 'fast' },
    { model: 'gpt-5.6-sol', description: 'reasoning' },
  ],
  routing_mode: 'autonomous',
  schema_version: 'product-agent-strategy/3',
  temperature: 0.3,
});
const fixed = JSON.stringify({
  forced_capability: 'none',
  max_input_tokens: 500,
  max_iterations: 1,
  max_output_tokens: 100,
  max_tool_calls: 0,
  parameter_defaults: { database_contains: '', knowledge_query: 'fixed default' },
  parameter_extraction: false,
  routes: [{ model: 'gpt-5.6-sol', description: 'default' }],
  routing_mode: 'fixed',
  schema_version: 'product-agent-strategy/2',
  temperature: 0,
});
const actionStrategy = JSON.stringify({
  forced_capability: 'knowledge',
  max_input_tokens: 500,
  max_iterations: 2,
  max_output_tokens: 100,
  max_tool_calls: 1,
  parameter_defaults: { database_contains: '', knowledge_query: 'healthz' },
  parameter_extraction: false,
  routes: [{ model: 'gpt-5.6-sol', description: 'tool decision' }],
  routing_mode: 'fixed',
  schema_version: 'product-agent-strategy/4',
  temperature: 0,
});
const subagentStrategy = JSON.stringify({
  forced_capability: 'subagent',
  max_input_tokens: 500,
  max_iterations: 2,
  max_output_tokens: 100,
  max_tool_calls: 1,
  parameter_defaults: { database_contains: '', knowledge_query: 'delegate' },
  parameter_extraction: false,
  routes: [{ model: 'gpt-5.6-sol', description: 'parent' }],
  routing_mode: 'fixed',
  schema_version: 'product-agent-strategy/5',
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
    `SELECT * FROM app.resolve_agent_product_run_parameters('${workspaceId}','${runV1}','${actorId}',
      '{"database_contains":"healthy","knowledge_query":"production health"}'::jsonb,
      '{"database_contains":"","knowledge_query":""}'::jsonb,'resp-parameters-1',30,5);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT parameter_source||':'||(effective_parameters->>'database_contains')||':'||
        (effective_parameters->>'knowledge_query')||':'||(extracted_parameters->>'knowledge_query')||':'||
        parameter_provider_request_id||':'||parameter_input_tokens||':'||parameter_output_tokens
       FROM app.list_agent_product_runs('${workspaceId}') WHERE id='${runV1}';`,
    ),
    'extracted:healthy:production health::resp-parameters-1:30:5',
    'effective parameter fallback and extraction evidence',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT * FROM app.resolve_agent_product_run_parameters('${workspaceId}','${runV1}','${actorId}',
        '{"database_contains":"changed","knowledge_query":"changed"}'::jsonb,
        '{"database_contains":"changed","knowledge_query":"changed"}'::jsonb,
        'resp-parameters-replay',1,1);`,
      { allowFailure: true },
    ),
    /parameter resolution conflict|40001/u,
    'parameter resolution replay',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.complete_agent_product_run('${workspaceId}','${runV1}','${actorId}','bypass','resp-bypass',100,80);`,
      { allowFailure: true },
    ),
    /iteration|40001/u,
    'v3 completion before iteration evidence',
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.record_agent_product_run_iteration('${workspaceId}','${runV1}','${actorId}',1,
      'gpt-5.4-mini','draft','resp-iteration-1',40,30);`,
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.record_agent_product_run_iteration('${workspaceId}','${runV1}','${actorId}',1,
        'gpt-5.4-mini','duplicate','resp-iteration-duplicate',1,1);`,
      { allowFailure: true },
    ),
    /iteration|40001/u,
    'iteration sequence replay',
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.record_agent_product_run_iteration('${workspaceId}','${runV1}','${actorId}',2,
      'gpt-5.4-mini','done','resp-iteration-2',60,50);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT iteration_count||':'||(iteration_trace->0->>'output_text')||':'||
        (iteration_trace->1->>'provider_request_id')
       FROM app.list_agent_product_runs('${workspaceId}') WHERE id='${runV1}';`,
    ),
    '2:draft:resp-iteration-2',
    'ordered immutable iteration evidence',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.complete_agent_product_run('${workspaceId}','${runV1}','${actorId}','forged','resp-iteration-2',100,80);`,
      { allowFailure: true },
    ),
    /iteration|40001/u,
    'terminal output must match final iteration',
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.complete_agent_product_run('${workspaceId}','${runV1}','${actorId}','done','resp-iteration-2',100,80);`,
  );
  const fixedRun = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT run_id FROM app.begin_agent_product_run('${workspaceId}','${conversationV2}','${actorId}','no extraction');`,
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT * FROM app.resolve_agent_product_run_parameters('${workspaceId}','${fixedRun}','${actorId}',
        '{"database_contains":"","knowledge_query":"forged"}'::jsonb,
        '{"database_contains":"","knowledge_query":"forged"}'::jsonb,
        'resp-parameters-denied',1,1);`,
      { allowFailure: true },
    ),
    /parameter resolution conflict|40001/u,
    'disabled extraction rejects provider evidence',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.complete_agent_product_run('${workspaceId}','${fixedRun}','${actorId}','bypass','resp-bypass',1,1);`,
      { allowFailure: true },
    ),
    /parameter|40001/u,
    'completion before parameter resolution',
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT * FROM app.resolve_agent_product_run_parameters('${workspaceId}','${fixedRun}','${actorId}',
      '{"database_contains":"","knowledge_query":"fixed default"}'::jsonb,NULL,NULL,0,0);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT parameter_source||':'||(effective_parameters->>'knowledge_query')
       FROM app.list_agent_product_runs('${workspaceId}') WHERE id='${fixedRun}';`,
    ),
    'defaults:fixed default',
    'database-authored fixed defaults',
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.complete_agent_product_run('${workspaceId}','${fixedRun}','${actorId}','fixed done','resp-fixed',10,10);`,
  );
  const knowledgeBaseId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT app.create_product_knowledge_base('${workspaceId}','${actorId}','Actions','Bound evidence');`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.ingest_product_knowledge_document('${workspaceId}','${knowledgeBaseId}','${actorId}',
      'Action Manual','[{"ordinal":0,"content":"healthz is the production readiness endpoint"}]'::jsonb);`,
  );
  const actionAgentId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_draft_with_strategy_capabilities('${workspaceId}','${actorId}',
      'Action Agent','','choose evidence','gpt-5.6-sol','${knowledgeBaseId}',NULL,'text',NULL,
      '${actionStrategy}'::jsonb)).id;`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.publish_agent_draft('${workspaceId}','${actionAgentId}',1,'${actorId}');`,
  );
  const actionConversation = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_product_conversation('${workspaceId}','${actionAgentId}','${actorId}')).id;`,
  );
  const actionRun = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT run_id FROM app.begin_agent_product_run('${workspaceId}','${actionConversation}','${actorId}','is it healthy');`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT * FROM app.resolve_agent_product_run_parameters('${workspaceId}','${actionRun}','${actorId}',
      '{"database_contains":"","knowledge_query":"healthz"}'::jsonb,NULL,NULL,0,0);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT knowledge::text||':'||database::text FROM app.read_agent_product_run_capabilities(
        '${workspaceId}','${actionRun}','${actorId}');`,
    ),
    'true:false',
    'release-bound action capabilities',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.record_agent_product_run_decision('${workspaceId}','${actionRun}','${actorId}',1,
        'gpt-5.6-sol','final',NULL,NULL,NULL,'unverified','resp-premature',5,2);`,
      { allowFailure: true },
    ),
    /tool decision|40001/u,
    'forced capability before final',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.record_agent_product_run_decision('${workspaceId}','${actionRun}','${actorId}',1,
        'gpt-5.6-sol','tool','database','healthy','[]',NULL,'resp-unbound',5,2);`,
      { allowFailure: true },
    ),
    /tool decision|40001/u,
    'unbound model tool decision',
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.record_agent_product_run_decision('${workspaceId}','${actionRun}','${actorId}',1,
      'gpt-5.6-sol','tool','knowledge','healthz','[{"content":"readiness endpoint"}]',NULL,
      'resp-tool',20,8);`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.record_agent_product_run_decision('${workspaceId}','${actionRun}','${actorId}',2,
      'gpt-5.6-sol','final',NULL,NULL,NULL,'healthy via healthz','resp-final',30,12);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT iteration_count||':'||(iteration_trace->0->>'action')||':'||
        (iteration_trace->0->>'capability')||':'||(iteration_trace->1->>'action')
       FROM app.list_agent_product_runs('${workspaceId}') WHERE id='${actionRun}';`,
    ),
    '2:tool:knowledge:final',
    'ordered model tool and final decisions',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.complete_agent_product_run('${workspaceId}','${actionRun}','${actorId}',
        'forged','resp-final',50,20);`,
      { allowFailure: true },
    ),
    /iteration|40001/u,
    'v4 terminal output matches final decision',
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.complete_agent_product_run('${workspaceId}','${actionRun}','${actorId}',
      'healthy via healthz','resp-final',50,20);`,
  );
  const childId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_draft_with_strategy_capabilities_v5('${workspaceId}','${actorId}',
      'Verifier','','verify dependencies','gpt-5.6-sol',NULL,NULL,'text',NULL,'${fixed}'::jsonb,NULL)).id;`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.publish_agent_draft('${workspaceId}','${childId}',1,'${actorId}');`,
  );
  const parentId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_draft_with_strategy_capabilities_v5('${workspaceId}','${actorId}',
      'Coordinator','','delegate exactly once','gpt-5.6-sol',NULL,NULL,'text',NULL,
      '${subagentStrategy}'::jsonb,'${childId}')).id;`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.publish_agent_draft('${workspaceId}','${parentId}',1,'${actorId}');`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.update_agent_draft_with_strategy_capabilities_v5('${workspaceId}','${childId}',2,
      'Verifier v2','','verify dependencies v2','gpt-5.6-sol',NULL,NULL,'text',NULL,'${fixed}'::jsonb,NULL);
     SELECT app.publish_agent_draft('${workspaceId}','${childId}',3,'${actorId}');`,
  );
  const parentConversation = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_product_conversation('${workspaceId}','${parentId}','${actorId}')).id;`,
  );
  const parentRun = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT run_id FROM app.begin_agent_product_run('${workspaceId}','${parentConversation}','${actorId}','check payment');`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT * FROM app.resolve_agent_product_run_parameters('${workspaceId}','${parentRun}','${actorId}',
      '{"database_contains":"","knowledge_query":"delegate"}'::jsonb,NULL,NULL,0,0);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT knowledge||':'||database||':'||subagent FROM app.read_agent_product_run_capabilities('${workspaceId}','${parentRun}','${actorId}');`,
    ),
    'false:false:true',
    'v5 pinned SubAgent capability',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT agent_id||':'||release_version||':'||name FROM app.read_agent_product_run_subagent('${workspaceId}','${parentRun}','${actorId}');`,
    ),
    `${childId}:1:Verifier`,
    'parent release keeps exact child release v1 after child v2 publication',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.update_agent_draft_with_strategy_capabilities_v5('${workspaceId}','${parentId}',2,
        'Coordinator','','delegate exactly once','gpt-5.6-sol',NULL,NULL,'text',NULL,
        '${subagentStrategy}'::jsonb,'${parentId}');`,
      { allowFailure: true },
    ),
    /child binding|22023/u,
    'self SubAgent binding',
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.record_agent_product_run_decision_v5('${workspaceId}','${parentRun}','${actorId}',1,
      'gpt-5.6-sol','tool','subagent','check payment','SUBAGENT_CONTEXT verified',NULL,
      'resp-parent-tool',9,4,7,6,'resp-child');
     SELECT app.record_agent_product_run_decision_v5('${workspaceId}','${parentRun}','${actorId}',2,
      'gpt-5.6-sol','final',NULL,NULL,NULL,'healthy','resp-parent-final',11,5,0,0,NULL);
     `,
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.complete_agent_product_run('${workspaceId}','${parentRun}','${actorId}',
        'healthy','resp-parent-final',20,9);`,
      { allowFailure: true },
    ),
    /aggregate budget conflict|40001/u,
    'forged child usage aggregate',
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.complete_agent_product_run('${workspaceId}','${parentRun}','${actorId}',
      'healthy','resp-parent-final',27,15);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT input_tokens||':'||output_tokens||':'||(iteration_trace->0->>'target_release_version')
       FROM app.list_agent_product_runs('${workspaceId}') WHERE id='${parentRun}';`,
    ),
    '27:15:1',
    'v5 child model usage and exact release evidence',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      'SELECT * FROM public.agent_product_release_subagent_bindings;',
      { allowFailure: true },
    ),
    /permission denied|42501/u,
    'runtime direct SubAgent binding read',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.record_agent_product_run_parameters('${workspaceId}','${deniedRun}','${actorId}',
        '{"database_contains":"","knowledge_query":"legacy"}'::jsonb,'resp-legacy',1,1);`,
      { allowFailure: true },
    ),
    /permission denied|42501/u,
    'legacy extraction mutation surface',
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
    `PostgreSQL 16 product Agent strategy passed: ${migrations.length} migrations, closed v1/v2/v3/v4/v5 profiles, versioned defaults, immutable releases, conversation pinning, autonomous route allowlist, database-authored effective parameters, audited extraction fallback, ordered iteration/action traces, release-bound model tool decisions, exact child release pinning and aggregate token budgets.\n`,
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
