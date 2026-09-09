import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harness = createPostgresHarness('product-async-subagent');
const migrationDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/migrations',
);
const workspaceId = 'f4600000-0000-4000-8000-000000000001';
const actorId = 'f4600000-0000-4000-8000-000000000002';
const parentCallId = 'f4600000-0000-4000-8000-000000000003';
const fixedStrategy = JSON.stringify({
  forced_capability: 'none',
  max_input_tokens: 1000,
  max_iterations: 1,
  max_output_tokens: 200,
  max_tool_calls: 0,
  parameter_defaults: { database_contains: '', knowledge_query: '' },
  parameter_extraction: false,
  routes: [{ model: 'gpt-5.6-sol', description: 'fixed' }],
  routing_mode: 'fixed',
  schema_version: 'product-agent-strategy/2',
  temperature: 0,
});
const subagentStrategy = JSON.stringify({
  forced_capability: 'subagent',
  max_input_tokens: 2000,
  max_iterations: 2,
  max_output_tokens: 500,
  max_tool_calls: 1,
  parameter_defaults: { database_contains: '', knowledge_query: 'delegate' },
  parameter_extraction: false,
  routes: [{ model: 'gpt-5.6-sol', description: 'parent' }],
  routing_mode: 'fixed',
  schema_version: 'product-agent-strategy/5',
  temperature: 0,
});

async function beginRun(parentId, input) {
  const conversationId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_product_conversation('${workspaceId}','${parentId}','${actorId}')).id;`,
  );
  const runId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT run_id FROM app.begin_agent_product_run('${workspaceId}','${conversationId}','${actorId}','${input}');`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT * FROM app.resolve_agent_product_run_parameters('${workspaceId}','${runId}','${actorId}',
      '{"database_contains":"","knowledge_query":"delegate"}'::jsonb,NULL,NULL,0,0);`,
  );
  return runId;
}

async function main() {
  await harness.start();
  const migrations = await loadMigrations(migrationDirectory);
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), { echoErrors: true });
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces(id,name) VALUES('${workspaceId}','Async SubAgents');`,
  );

  const childOne = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_draft_with_strategy_capabilities_v5('${workspaceId}','${actorId}',
      'Researcher','','research independently','gpt-5.6-sol',NULL,NULL,'text',NULL,
      '${fixedStrategy}'::jsonb,NULL)).id;`,
  );
  const childTwo = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_draft_with_strategy_capabilities_v5('${workspaceId}','${actorId}',
      'Auditor','','audit independently','gpt-5.6-sol',NULL,NULL,'text',NULL,
      '${fixedStrategy}'::jsonb,NULL)).id;`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.publish_agent_draft('${workspaceId}','${childOne}',1,'${actorId}');
     SELECT app.publish_agent_draft('${workspaceId}','${childTwo}',1,'${actorId}');`,
  );
  const parentId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_draft_with_strategy_capabilities_v10('${workspaceId}','${actorId}',
      'Coordinator','','delegate asynchronously','gpt-5.6-sol',NULL,NULL,'text',NULL,
      '${subagentStrategy}'::jsonb,ARRAY['${childOne}'::uuid,'${childTwo}'::uuid],
      NULL,NULL,NULL,NULL,NULL,NULL,NULL)).id;`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.publish_agent_draft('${workspaceId}','${parentId}',1,'${actorId}');`,
  );

  const runId = await beginRun(parentId, 'investigate');
  const childRunId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT app.dispatch_agent_product_async_subagent_job('${workspaceId}','${runId}','${actorId}',
      '${parentCallId}',1,'investigate');`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT app.dispatch_agent_product_async_subagent_job('${workspaceId}','${runId}','${actorId}',
        '${parentCallId}',1,'investigate');`,
    ),
    childRunId,
    'same dispatch intent replays the child Run identity',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.dispatch_agent_product_async_subagent_job('${workspaceId}','${runId}','${actorId}',
        '${parentCallId}',1,'changed');`,
      { allowFailure: true },
    ),
    /dispatch intent conflict|40001/u,
    'different dispatch intent under one parent call',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.claim_agent_product_async_subagent_job('runtime',45);`,
      { allowFailure: true },
    ),
    /permission denied|42501/u,
    'runtime cannot claim execution work',
  );
  assertRejected(
    await harness.psql(
      'ba_execution_test',
      `SELECT * FROM public.agent_product_async_subagent_jobs;`,
      { allowFailure: true },
    ),
    /permission denied|42501/u,
    'execution role cannot read queue tables directly',
  );

  const claim = JSON.parse(
    await harness.queryScalar(
      'ba_execution_test',
      `SELECT app.claim_agent_product_async_subagent_job('worker-a',45);`,
    ),
  );
  assertEqual(claim.childRunId, childRunId, 'claim returns dispatched child Run');
  assertEqual(String(claim.chains.length), '2', 'claim carries two immutable branches');
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.renew_agent_product_async_subagent_job('${childRunId}','${claim.leaseToken}',
        ${claim.leaseGeneration},45);`,
      { allowFailure: true },
    ),
    /permission denied|42501/u,
    'runtime cannot renew execution work',
  );
  assertRejected(
    await harness.psql(
      'ba_execution_other_test',
      `SELECT app.renew_agent_product_async_subagent_job('${childRunId}',
        '00000000-0000-4000-8000-000000000097',${claim.leaseGeneration},45);`,
      { allowFailure: true },
    ),
    /lease conflict|40001/u,
    'a foreign lease cannot renew execution work',
  );
  await harness.psql(
    'ba_execution_test',
    `SELECT app.renew_agent_product_async_subagent_job('${childRunId}','${claim.leaseToken}',
      ${claim.leaseGeneration},45);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_execution_other_test',
      `SELECT app.claim_agent_product_async_subagent_job('worker-b',45) IS NULL;`,
    ),
    't',
    'leased work is invisible to another worker',
  );

  const invocationOne = JSON.stringify({
    agentId: childOne,
    aggregateInputTokens: 5,
    aggregateOutputTokens: 3,
    branch: 1,
    depth: 1,
    exclusiveInputTokens: 5,
    exclusiveOutputTokens: 3,
    inputText: 'investigate',
    model: 'gpt-5.6-sol',
    name: 'Researcher',
    outputText: 'research evidence',
    parentIteration: 1,
    providerRequestId: 'response-child-1',
    releaseVersion: 1,
  });
  const invocationTwo = JSON.stringify({
    agentId: childTwo,
    aggregateInputTokens: 7,
    aggregateOutputTokens: 4,
    branch: 2,
    depth: 1,
    exclusiveInputTokens: 7,
    exclusiveOutputTokens: 4,
    inputText: 'investigate',
    model: 'gpt-5.6-sol',
    name: 'Auditor',
    outputText: 'audit evidence',
    parentIteration: 1,
    providerRequestId: 'response-child-2',
    releaseVersion: 1,
  });
  assertRejected(
    await harness.psql(
      'ba_execution_test',
      `SELECT app.record_agent_product_async_subagent_invocation('${childRunId}',
        '00000000-0000-4000-8000-000000000099',${claim.leaseGeneration},'${invocationOne}'::jsonb);`,
      { allowFailure: true },
    ),
    /lease conflict|40001/u,
    'wrong lease token cannot write receipts',
  );
  await harness.psql(
    'ba_execution_test',
    `SELECT app.record_agent_product_async_subagent_invocation('${childRunId}',
      '${claim.leaseToken}',${claim.leaseGeneration},'${invocationOne}'::jsonb);
     SELECT app.record_agent_product_async_subagent_invocation('${childRunId}',
      '${claim.leaseToken}',${claim.leaseGeneration},'${invocationTwo}'::jsonb);`,
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.complete_agent_product_async_subagent_job('${childRunId}','${claim.leaseToken}',
        ${claim.leaseGeneration},12,7,'complete evidence','response-child-1');`,
      { allowFailure: true },
    ),
    /permission denied|42501/u,
    'runtime cannot forge worker completion',
  );
  await harness.psql(
    'ba_execution_test',
    `SELECT app.complete_agent_product_async_subagent_job('${childRunId}','${claim.leaseToken}',
      ${claim.leaseGeneration},12,7,'complete evidence','response-child-1');
     SELECT app.complete_agent_product_async_subagent_job('${childRunId}','${claim.leaseToken}',
      ${claim.leaseGeneration},12,7,'complete evidence','response-child-1');`,
  );
  assertRejected(
    await harness.psql(
      'ba_execution_other_test',
      `SELECT app.complete_agent_product_async_subagent_job('${childRunId}',
        '00000000-0000-4000-8000-000000000098',${claim.leaseGeneration},
        12,7,'complete evidence','response-child-1');`,
      { allowFailure: true },
    ),
    /lease conflict|40001/u,
    'terminal replay remains bound to the original lease token',
  );
  assertRejected(
    await harness.psql(
      'ba_execution_test',
      `SELECT app.complete_agent_product_async_subagent_job('${childRunId}','${claim.leaseToken}',
        ${claim.leaseGeneration},13,7,'changed','response-child-1');`,
      { allowFailure: true },
    ),
    /terminal conflict|40001/u,
    'completed child rejects a different terminal replay',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT (app.read_agent_product_async_subagent_run('${workspaceId}','${runId}','${actorId}',
        '${parentCallId}')->>'status')||':'||
        (app.read_agent_product_async_subagent_run('${workspaceId}','${runId}','${actorId}',
        '${parentCallId}')->>'outputText');`,
    ),
    'completed:complete evidence',
    'runtime reads the settled child Run through its parent call',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT string_agg(kind,',' ORDER BY sequence)
       FROM app.list_agent_product_async_subagent_events('${workspaceId}','${runId}','${actorId}');`,
    ),
    'queued,started,completed',
    'child Run publishes an independent ordered terminal event',
  );

  const cascadeRun = await beginRun(parentId, 'cascade');
  const cascadeCall = 'f4600000-0000-4000-8000-000000000004';
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.dispatch_agent_product_async_subagent_job('${workspaceId}','${cascadeRun}','${actorId}',
      '${cascadeCall}',1,'cascade');
     SELECT app.fail_agent_product_run('${workspaceId}','${cascadeRun}','${actorId}','model_provider_unreachable');`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT app.read_agent_product_async_subagent_run('${workspaceId}','${cascadeRun}','${actorId}',
        '${cascadeCall}')->>'errorCode';`,
    ),
    'parent_run_failed',
    'parent failure cascades to an unsettled child',
  );

  process.stdout.write(
    `PostgreSQL 16 product async SubAgent passed: ${migrations.length} migrations, atomic dispatch, immutable child context, role-separated SKIP LOCKED claim, lease renewal/fencing, exact receipts, idempotent terminalization, independent events and parent cascade.\n`,
  );
  process.stdout.write('architecture-gate-suite/1 product-async-subagent pass\n');
}

try {
  await main();
} finally {
  await harness.stop();
}
