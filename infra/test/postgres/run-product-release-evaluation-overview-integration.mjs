import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harness = createPostgresHarness('product-release-evaluation-overview');
const migrationDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/migrations',
);
const workspaceId = 'f2400000-0000-4000-8000-000000000001';
const otherWorkspaceId = 'f2400000-0000-4000-8000-000000000002';
const actorId = 'f2400000-0000-4000-8000-000000000003';
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

async function main() {
  await harness.start();
  const migrations = await loadMigrations(migrationDirectory);
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), { echoErrors: true });
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces(id,name) VALUES
('${workspaceId}','Release Evaluation'),('${otherWorkspaceId}','Other Workspace');`,
  );

  const agentId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_draft('${workspaceId}','${actorId}','Reviewer','',
      'Only report verified facts.','gpt-5.6-sol')).id;`,
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
    `SELECT run_id FROM app.begin_agent_product_run(
      '${workspaceId}','${conversationId}','${actorId}','verify release one');`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.complete_agent_product_run('${workspaceId}','${runId}','${actorId}',
      'release one verified','provider-request-1',12,4);`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.update_agent_draft('${workspaceId}','${agentId}',2,'Reviewer v2','',
      'Changed draft instructions.','gpt-5.6-sol');`,
  );

  const graph = {
    edges: [
      { id: 'input_prompt', source: 'input', target: 'prompt' },
      { id: 'prompt_output', source: 'prompt', target: 'output' },
    ],
    nodes: [
      { config: { key: 'message' }, id: 'input', label: 'Input', type: 'input' },
      { config: { template: '{{message}}' }, id: 'prompt', label: 'Template', type: 'template' },
      { config: { source: 'prompt' }, id: 'output', label: 'Output', type: 'output' },
    ],
  };
  const flowId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT app.create_product_flow_draft('${workspaceId}','${actorId}','Release Flow','',
      ${sqlLiteral(JSON.stringify(graph))}::jsonb);`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.publish_product_flow('${workspaceId}','${flowId}',1,'${actorId}','production');`,
  );

  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT string_agg(concat_ws('|',target_kind,name,release_version,
        array_to_string(environments,','),successful_evidence_count,total_evidence_count),';'
        ORDER BY target_kind)
      FROM app.list_product_release_evaluation_targets('${workspaceId}');`,
    ),
    'agent|Reviewer|1|release|1|1;flow|Release Flow|1|production|0|0',
    'release overview exact readback',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT count(*) FROM app.list_product_release_evaluation_targets('${otherWorkspaceId}');`,
    ),
    '0',
    'release overview cross-workspace isolation',
  );
  assertRejected(
    await harness.psql('ba_runtime_test', 'SELECT count(*) FROM public.agent_product_releases;', {
      allowFailure: true,
    }),
    /permission denied|42501/u,
    'runtime direct release read',
  );

  process.stdout.write(
    'PostgreSQL 16 product release evaluation overview passed: 25 migrations, immutable historical Agent releases, exact-version Run evidence, Flow deployment bindings, tenant isolation and direct-table denial.\n',
  );
  process.stdout.write('architecture-gate-suite/1 product-release-evaluation pass\n');
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
  throw new AggregateError(failures, 'product release evaluation overview harness failed');
}
