import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harness = createPostgresHarness('product-agent-knowledge-binding');
const migrationDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/migrations',
);
const workspaceId = 'f2500000-0000-4000-8000-000000000001';
const otherWorkspaceId = 'f2500000-0000-4000-8000-000000000002';
const actorId = 'f2500000-0000-4000-8000-000000000003';

async function main() {
  await harness.start();
  const migrations = await loadMigrations(migrationDirectory);
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), { echoErrors: true });
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces(id,name) VALUES
('${workspaceId}','Agent Knowledge'),('${otherWorkspaceId}','Other Workspace');`,
  );

  const knowledgeBaseId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT app.create_product_knowledge_base(
      '${workspaceId}','${actorId}','Operations','Release-pinned facts');`,
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.ingest_product_knowledge_document(
      '${workspaceId}','${knowledgeBaseId}','${actorId}','Published Manual',
      '[{"ordinal":0,"content":"healthz release-pinned evidence"}]'::jsonb);`,
  );
  const agentId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_draft_with_knowledge(
      '${workspaceId}','${actorId}','Knowledge Agent','',
      'Use verified release context.','gpt-5.6-sol','${knowledgeBaseId}')).id;`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT knowledge_base_id FROM app.list_agent_drafts_with_knowledge('${workspaceId}')
       WHERE id = '${agentId}';`,
    ),
    knowledgeBaseId,
    'draft Knowledge binding readback',
  );
  await harness.psql(
    'ba_runtime_test',
    `SELECT app.publish_agent_draft('${workspaceId}','${agentId}',1,'${actorId}');`,
  );

  await harness.psql(
    'ba_runtime_test',
    `SELECT app.ingest_product_knowledge_document(
      '${workspaceId}','${knowledgeBaseId}','${actorId}','Late Manual',
      '[{"ordinal":0,"content":"healthz late mutable addition"}]'::jsonb);`,
  );
  const conversationV1 = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT (app.create_agent_product_conversation(
      '${workspaceId}','${agentId}','${actorId}')).id;`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT string_agg(document_title,',' ORDER BY document_title)
       FROM app.search_agent_product_conversation_knowledge(
         '${workspaceId}','${conversationV1}','healthz',8);`,
    ),
    'Published Manual',
    'release v1 excludes documents ingested after publication',
  );

  await harness.psql(
    'ba_runtime_test',
    `SELECT app.update_agent_draft_with_knowledge(
      '${workspaceId}','${agentId}',2,'Knowledge Agent v2','',
      'Run without Knowledge.','gpt-5.6-sol',NULL);`,
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
      `SELECT count(*) FROM app.search_agent_product_conversation_knowledge(
        '${workspaceId}','${conversationV2}','healthz',8);`,
    ),
    '0',
    'unbound release v2 has no Knowledge retrieval',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT count(*) FROM app.search_agent_product_conversation_knowledge(
        '${otherWorkspaceId}','${conversationV1}','healthz',8);`,
    ),
    '0',
    'Agent Knowledge cross-workspace isolation',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      'SELECT count(*) FROM public.agent_product_release_knowledge_documents;',
      { allowFailure: true },
    ),
    /permission denied|42501/u,
    'runtime direct Agent Knowledge snapshot read',
  );
  assertRejected(
    await harness.psql(
      'ba_migrator_test',
      `SET ROLE ba_authorization_owner;
       DELETE FROM public.agent_product_release_knowledge_bindings
       WHERE workspace_id = '${workspaceId}' AND agent_id = '${agentId}' AND release_version = 1;`,
      { allowFailure: true },
    ),
    /immutable|55000/u,
    'immutable release Knowledge binding',
  );

  process.stdout.write(
    'PostgreSQL 16 product Agent Knowledge binding passed: 26 migrations, draft selection, immutable release document snapshots, conversation-pinned retrieval, unbound releases, tenant isolation and direct-table denial.\n',
  );
  process.stdout.write('architecture-gate-suite/1 product-agent-knowledge pass\n');
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
  throw new AggregateError(failures, 'product Agent Knowledge binding harness failed');
}
