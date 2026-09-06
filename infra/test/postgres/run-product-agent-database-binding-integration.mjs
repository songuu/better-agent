import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harness = createPostgresHarness('product-agent-database-binding');
const migrationDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/migrations',
);
const workspaceId = 'f2700000-0000-4000-8000-000000000001';
const otherWorkspaceId = 'f2700000-0000-4000-8000-000000000002';
const actorId = 'f2700000-0000-4000-8000-000000000003';

async function main() {
  await harness.start();
  const migrations = await loadMigrations(migrationDirectory);
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), { echoErrors: true });
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces(id,name) VALUES
('${workspaceId}','Agent Database'),('${otherWorkspaceId}','Other Workspace');`,
  );

  const tableId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT app.create_product_database_table(
      '${workspaceId}','${actorId}','service_status','Release-pinned rows',
      '["service","status"]'::jsonb);`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.append_product_database_rows(
      '${workspaceId}','${tableId}','${actorId}',
      '[{"service":"web","status":"healthy"}]'::jsonb);`,
  );
  const agentId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_draft_with_capabilities(
      '${workspaceId}','${actorId}','Database Agent','','Use release data.',
      'gpt-5.6-sol',NULL,'${tableId}')).id;`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT database_table_id FROM app.list_agent_drafts_with_capabilities('${workspaceId}')
       WHERE id = '${agentId}';`,
    ),
    tableId,
    'draft Database binding readback',
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.publish_agent_draft('${workspaceId}','${agentId}',1,'${actorId}');`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.append_product_database_rows(
      '${workspaceId}','${tableId}','${actorId}',
      '[{"service":"worker","status":"late"}]'::jsonb);`,
  );
  const conversationV1 = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_product_conversation(
      '${workspaceId}','${agentId}','${actorId}')).id;`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT string_agg(record ->> 'service',',' ORDER BY row_ordinal)
       FROM app.read_agent_product_conversation_database(
         '${workspaceId}','${conversationV1}',20);`,
    ),
    'web',
    'release v1 excludes rows appended after publication',
  );

  await harness.psql(
    'ba_runtime_test',
    `SELECT app.update_agent_draft_with_capabilities(
      '${workspaceId}','${agentId}',2,'Database Agent v2','','Run without Database.',
      'gpt-5.6-sol',NULL,NULL);`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.publish_agent_draft('${workspaceId}','${agentId}',3,'${actorId}');`,
  );
  const conversationV2 = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_product_conversation(
      '${workspaceId}','${agentId}','${actorId}')).id;`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT count(*) FROM app.read_agent_product_conversation_database(
        '${workspaceId}','${conversationV2}',20);`,
    ),
    '0',
    'unbound release v2 has no Database rows',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT count(*) FROM app.read_agent_product_conversation_database(
        '${otherWorkspaceId}','${conversationV1}',20);`,
    ),
    '0',
    'Agent Database cross-workspace isolation',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      'SELECT count(*) FROM public.agent_product_release_database_rows;',
      { allowFailure: true },
    ),
    /permission denied|42501/u,
    'runtime direct Agent Database snapshot read',
  );
  assertRejected(
    await harness.psql(
      'ba_migrator_test',
      `SET ROLE ba_authorization_owner;
       DELETE FROM public.agent_product_release_database_bindings
       WHERE workspace_id = '${workspaceId}' AND agent_id = '${agentId}' AND release_version = 1;`,
      { allowFailure: true },
    ),
    /immutable|55000/u,
    'immutable release Database binding',
  );

  process.stdout.write(
    `PostgreSQL 16 product Agent Database binding passed: ${migrations.length} migrations, draft selection, immutable release row snapshots, conversation-pinned reads, unbound releases, tenant isolation and direct-table denial.\n`,
  );
  process.stdout.write('architecture-gate-suite/1 product-agent-database pass\n');
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
  throw new AggregateError(failures, 'product Agent Database binding harness failed');
}
