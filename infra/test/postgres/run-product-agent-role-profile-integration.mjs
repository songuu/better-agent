import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harness = createPostgresHarness('product-agent-role-profile');
const migrationDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/migrations',
);
const workspaceId = 'f2800000-0000-4000-8000-000000000001';
const otherWorkspaceId = 'f2800000-0000-4000-8000-000000000002';
const actorId = 'f2800000-0000-4000-8000-000000000003';
const initialProfile = JSON.stringify({
  audience: { content: 'operators', weight: 70 },
  constraints: { content: 'never guess', weight: 100 },
  expertise: { content: 'PostgreSQL', weight: 80 },
  identity: { content: 'reliability advisor', weight: 90 },
  objective: { content: 'report verified health', weight: 100 },
  process: { content: 'inspect then answer', weight: 90 },
  tone: { content: 'concise', weight: 60 },
});
const updatedProfile = JSON.stringify({
  audience: { content: 'incident commanders', weight: 80 },
  constraints: { content: 'never guess', weight: 100 },
  expertise: { content: 'PostgreSQL and services', weight: 90 },
  identity: { content: 'incident response lead', weight: 100 },
  objective: { content: 'resolve verified incidents', weight: 100 },
  process: { content: 'triage, inspect, answer', weight: 95 },
  tone: { content: 'direct', weight: 70 },
});

async function main() {
  await harness.start();
  const migrations = await loadMigrations(migrationDirectory);
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), { echoErrors: true });
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces(id,name) VALUES
('${workspaceId}','Agent Roles'),('${otherWorkspaceId}','Other Workspace');`,
  );

  const agentId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_draft_with_role_capabilities(
      '${workspaceId}','${actorId}','Role Agent','','CALLER V1 MUST BE IGNORED','gpt-5.6-sol',
      NULL,NULL,'structured','${initialProfile}'::jsonb)).id;`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT role_profile -> 'identity' ->> 'content'
       FROM app.list_agent_drafts_with_role_capabilities('${workspaceId}')
       WHERE id = '${agentId}';`,
    ),
    'reliability advisor',
    'structured draft role readback',
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.publish_agent_draft('${workspaceId}','${agentId}',1,'${actorId}');`,
  );
  const conversationV1 = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_product_conversation(
      '${workspaceId}','${agentId}','${actorId}')).id;`,
  );

  await harness.psql(
    'ba_runtime_test',
    `SELECT app.update_agent_draft_with_role_capabilities(
      '${workspaceId}','${agentId}',2,'Role Agent v2','','CALLER V2 MUST BE IGNORED','gpt-5.6-sol',
      NULL,NULL,'structured','${updatedProfile}'::jsonb);`,
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
      `SELECT position('reliability advisor' in instructions) > 0
       FROM app.begin_agent_product_run(
        '${workspaceId}','${conversationV1}','${actorId}','old release');`,
    ),
    't',
    'existing conversation keeps release v1 role instructions',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT position('incident response lead' in instructions) > 0
       FROM app.begin_agent_product_run(
        '${workspaceId}','${conversationV2}','${actorId}','new release');`,
    ),
    't',
    'new conversation receives release v2 role instructions',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_migrator_test',
      `SET ROLE ba_authorization_owner;
       SELECT role_profile -> 'identity' ->> 'content'
       FROM public.agent_product_releases
       WHERE workspace_id = '${workspaceId}' AND agent_id = '${agentId}' AND version = 1;`,
    ),
    'reliability advisor',
    'release v1 retains the exact structured role profile',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT count(*) FROM app.list_agent_drafts_with_role_capabilities('${otherWorkspaceId}')
       WHERE id = '${agentId}';`,
    ),
    '0',
    'structured role cross-workspace isolation',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.create_agent_draft_with_role_capabilities(
        '${workspaceId}','${actorId}','Invalid','','INVALID','gpt-5.6-sol',
        NULL,NULL,'structured','{"identity":{"content":"open","weight":1}}'::jsonb);`,
      { allowFailure: true },
    ),
    /structured role profile is invalid|22023/u,
    'incomplete structured role profile',
  );
  assertRejected(
    await harness.psql('ba_runtime_test', 'SELECT count(*) FROM public.agent_product_releases;', {
      allowFailure: true,
    }),
    /permission denied|42501/u,
    'runtime direct Agent release read',
  );
  assertRejected(
    await harness.psql(
      'ba_migrator_test',
      `SET ROLE ba_authorization_owner;
       UPDATE public.agent_product_releases SET role_profile = '${updatedProfile}'::jsonb
       WHERE workspace_id = '${workspaceId}' AND agent_id = '${agentId}' AND version = 1;`,
      { allowFailure: true },
    ),
    /immutable|55000/u,
    'immutable published role profile',
  );

  process.stdout.write(
    `PostgreSQL 16 product Agent role profile passed: ${migrations.length} migrations, closed seven-theme validation, immutable release snapshots, conversation version pinning, tenant isolation and direct-table denial.\n`,
  );
  process.stdout.write('architecture-gate-suite/1 product-agent-role-profile pass\n');
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
  throw new AggregateError(failures, 'product Agent role profile harness failed');
}
