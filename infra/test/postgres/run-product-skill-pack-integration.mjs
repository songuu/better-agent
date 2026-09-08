import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harness = createPostgresHarness('product-skill-pack');
const migrationDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/migrations',
);
const workspaceId = 'f3900000-0000-4000-8000-000000000001';
const otherWorkspaceId = 'f3900000-0000-4000-8000-000000000002';
const actorId = 'f3900000-0000-4000-8000-000000000003';
const strategy = JSON.stringify({
  forced_capability: 'none',
  max_input_tokens: 32000,
  max_iterations: 1,
  max_output_tokens: 2000,
  max_tool_calls: 0,
  parameter_defaults: { database_contains: '', knowledge_query: '' },
  parameter_extraction: false,
  routes: [{ description: 'default', model: 'gpt-5.6-sol' }],
  routing_mode: 'fixed',
  schema_version: 'product-agent-strategy/2',
  temperature: 0.2,
});
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

async function main() {
  await harness.start();
  const migrations = await loadMigrations(migrationDirectory);
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), { echoErrors: true });
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces(id,name) VALUES
     ('${workspaceId}','Skill Packs'),('${otherWorkspaceId}','Other Workspace');`,
  );
  const packId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT app.create_product_skill_pack('${workspaceId}','${actorId}',
      'Release Guard','Production receipt rules','VERIFY RECEIPT V1');`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws('|',id,revision,name,instructions)
       FROM app.list_product_skill_packs('${workspaceId}');`,
    ),
    `${packId}|1|Release Guard|VERIFY RECEIPT V1`,
    'created Skill Pack version',
  );
  const agentId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_draft_with_strategy_capabilities_v7(
      '${workspaceId}','${actorId}','Release Agent','','Report only verified state','gpt-5.6-sol',
      NULL,NULL,'text',NULL,${sqlLiteral(strategy)}::jsonb,NULL,NULL,'${packId}',1)).id;`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.update_product_skill_pack('${workspaceId}','${packId}',1,'${actorId}',
      'Release Guard','Production and rollback receipt rules','VERIFY RECEIPT V2');`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws('|',revision,instructions) FROM app.list_product_skill_packs('${workspaceId}');`,
    ),
    '2|VERIFY RECEIPT V2',
    'CAS-updated Skill Pack head',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.update_product_skill_pack('${workspaceId}','${packId}',1,'${actorId}','Stale','','STALE');`,
      { allowFailure: true },
    ),
    /Skill Pack revision conflict|40001/u,
    'stale Skill Pack update',
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.publish_agent_draft('${workspaceId}','${agentId}',1,'${actorId}');`,
  );
  const conversationId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_product_conversation('${workspaceId}','${agentId}','${actorId}')).id;`,
  );
  const runId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT run_id FROM app.begin_agent_product_run('${workspaceId}','${conversationId}','${actorId}','status');`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws('|',skill_pack_id,release_version,name,instructions)
       FROM app.read_agent_product_run_skill_pack('${workspaceId}','${runId}','${actorId}');`,
    ),
    `${packId}|1|Release Guard|VERIFY RECEIPT V1`,
    'published Agent reads exact historical Skill Pack release',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT (app.create_agent_draft_with_strategy_capabilities_v7(
        '${otherWorkspaceId}','${actorId}','Foreign','','Reject','gpt-5.6-sol',NULL,NULL,'text',NULL,
        ${sqlLiteral(strategy)}::jsonb,NULL,NULL,'${packId}',1)).id;`,
      { allowFailure: true },
    ),
    /Agent Skill Pack binding is invalid|22023/u,
    'cross-workspace Skill Pack binding',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      'SELECT count(*) FROM public.product_skill_pack_releases;',
      {
        allowFailure: true,
      },
    ),
    /permission denied|42501/u,
    'runtime direct Skill Pack release read',
  );
  assertRejected(
    await harness.psql(
      'ba_bootstrap_test',
      `UPDATE public.product_skill_pack_releases SET instructions='TAMPERED'
       WHERE workspace_id='${workspaceId}' AND skill_pack_id='${packId}' AND version=1;`,
      { allowFailure: true },
    ),
    /product Flow history is immutable|55000/u,
    'immutable Skill Pack release',
  );
  process.stdout.write(
    `PostgreSQL 16 product Skill Pack passed: ${migrations.length} migrations, CAS heads, immutable releases, exact Agent snapshot, tenant isolation and direct-DML denial.\n`,
  );
  process.stdout.write('architecture-gate-suite/1 product-skill-pack pass\n');
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
if (failures.length > 1) throw new AggregateError(failures, 'product Skill Pack harness failed');
