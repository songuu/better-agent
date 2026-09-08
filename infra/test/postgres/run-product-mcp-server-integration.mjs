import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harness = createPostgresHarness('product-mcp-server');
const migrationDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/migrations',
);
const workspaceId = 'f4000000-0000-4000-8000-000000000001';
const otherWorkspaceId = 'f4000000-0000-4000-8000-000000000002';
const actorId = 'f4000000-0000-4000-8000-000000000003';
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
     ('${workspaceId}','MCP Servers'),('${otherWorkspaceId}','Other Workspace');`,
  );
  const mcpServerId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT app.create_product_mcp_server('${workspaceId}','${actorId}',
      'Release MCP','Production receipt verifier','https://mcp.example.com/mcp','release_check');`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws('|',id,revision,name,endpoint_url,tool_name)
       FROM app.list_product_mcp_servers('${workspaceId}');`,
    ),
    `${mcpServerId}|1|Release MCP|https://mcp.example.com/mcp|release_check`,
    'created MCP server version',
  );
  const agentId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_draft_with_strategy_capabilities_v8(
      '${workspaceId}','${actorId}','Release Agent','','Report only verified state','gpt-5.6-sol',
      NULL,NULL,'text',NULL,${sqlLiteral(strategy)}::jsonb,NULL,NULL,NULL,NULL,'${mcpServerId}',1)).id;`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.update_product_mcp_server('${workspaceId}','${mcpServerId}',1,'${actorId}',
      'Release MCP','Production and rollback verifier','https://mcp.example.com/v2/mcp','release_verify');`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws('|',revision,endpoint_url,tool_name)
       FROM app.list_product_mcp_servers('${workspaceId}');`,
    ),
    '2|https://mcp.example.com/v2/mcp|release_verify',
    'CAS-updated MCP server head',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.update_product_mcp_server('${workspaceId}','${mcpServerId}',1,'${actorId}',
       'Stale','','https://mcp.example.com/stale','stale');`,
      { allowFailure: true },
    ),
    /MCP server revision conflict|40001/u,
    'stale MCP server update',
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
      `SELECT concat_ws('|',mcp_server_id,release_version,name,endpoint_url,tool_name)
       FROM app.read_agent_product_run_mcp_server('${workspaceId}','${runId}','${actorId}');`,
    ),
    `${mcpServerId}|1|Release MCP|https://mcp.example.com/mcp|release_check`,
    'published Agent reads exact historical MCP release',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT (app.create_agent_draft_with_strategy_capabilities_v8(
        '${otherWorkspaceId}','${actorId}','Foreign','','Reject','gpt-5.6-sol',NULL,NULL,'text',NULL,
        ${sqlLiteral(strategy)}::jsonb,NULL,NULL,NULL,NULL,'${mcpServerId}',1)).id;`,
      { allowFailure: true },
    ),
    /Agent MCP server binding is invalid|22023/u,
    'cross-workspace MCP binding',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      'SELECT count(*) FROM public.product_mcp_server_releases;',
      {
        allowFailure: true,
      },
    ),
    /permission denied|42501/u,
    'runtime direct MCP release read',
  );
  assertRejected(
    await harness.psql(
      'ba_bootstrap_test',
      `UPDATE public.product_mcp_server_releases SET tool_name='tampered'
       WHERE workspace_id='${workspaceId}' AND mcp_server_id='${mcpServerId}' AND version=1;`,
      { allowFailure: true },
    ),
    /product Flow history is immutable|55000/u,
    'immutable MCP server release',
  );
  process.stdout.write(
    `PostgreSQL 16 product MCP server passed: ${migrations.length} migrations, CAS heads, immutable releases, exact Agent snapshot, tenant isolation and direct-DML denial.\n`,
  );
  process.stdout.write('architecture-gate-suite/1 product-mcp-server pass\n');
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
if (failures.length > 1) throw new AggregateError(failures, 'product MCP server harness failed');
