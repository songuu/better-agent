import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harness = createPostgresHarness('product-knowledge-center');
const migrationDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/migrations',
);
const workspaceId = 'f2300000-0000-4000-8000-000000000001';
const actorId = 'f2300000-0000-4000-8000-000000000002';
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const jsonb = (value) => `${sqlLiteral(JSON.stringify(value))}::jsonb`;

async function main() {
  await harness.start();
  const migrations = await loadMigrations(migrationDirectory);
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), { echoErrors: true });
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces(id,name) VALUES('${workspaceId}','Product Knowledge Center');`,
  );

  const knowledgeBaseId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT app.create_product_knowledge_base(
  '${workspaceId}','${actorId}','Operations Knowledge','Reviewed production runbooks'
);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws('|',name,description,document_count)
FROM app.list_product_knowledge_bases('${workspaceId}') WHERE id='${knowledgeBaseId}';`,
    ),
    'Operations Knowledge|Reviewed production runbooks|0',
    'runtime reads the newly persisted Knowledge base through the definer surface',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `INSERT INTO public.product_knowledge_bases(
  workspace_id,id,name,description,created_by
) VALUES('${workspaceId}',gen_random_uuid(),'forbidden','','${actorId}');`,
      { allowFailure: true },
    ),
    /permission denied|42501/u,
    'runtime cannot bypass the Knowledge definer surface with direct DML',
  );

  const chunks = [
    { content: '服务健康检查使用 /better-agent/api/healthz。', ordinal: 0 },
    { content: '数据库异常时先核对 PostgreSQL 连接与迁移账本。', ordinal: 1 },
  ];
  const documentId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT id FROM app.ingest_product_knowledge_document(
  '${workspaceId}','${knowledgeBaseId}','${actorId}','Production Runbook',${jsonb(chunks)}
);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws('|',title,chunk_count)
FROM app.list_product_knowledge_documents('${workspaceId}','${knowledgeBaseId}');`,
    ),
    'Production Runbook|2',
    'ingestion stores the document and exact ordered chunk count',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT concat_ws('|',document_title,ordinal,content,score > 0)
FROM app.search_product_knowledge('${workspaceId}','${knowledgeBaseId}','健康检查',8);`,
    ),
    'Production Runbook|0|服务健康检查使用 /better-agent/api/healthz。|t',
    'retrieval supports bounded Chinese substring readback with a positive score',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.ingest_product_knowledge_document(
  '${workspaceId}','${knowledgeBaseId}','${actorId}','Invalid',
  ${jsonb([{ content: 'bad ordinal', ordinal: 1 }])}
);`,
      { allowFailure: true },
    ),
    /Knowledge chunk sequence is invalid|22023/u,
    'ingestion rejects a non-canonical chunk sequence before storing facts',
  );
  assertRejected(
    await harness.psql(
      'ba_bootstrap_test',
      `UPDATE public.product_knowledge_documents SET title='tampered'
WHERE workspace_id='${workspaceId}' AND id='${documentId}';`,
      { allowFailure: true },
    ),
    /product Knowledge ingestion history is immutable|55000/u,
    'ingested documents reject mutation even through the bootstrap fixture principal',
  );

  process.stdout.write(
    `PostgreSQL 16 product Knowledge Center passed: ${migrations.length} migrations, owner-only ingestion, immutable ordered chunks, bounded Chinese retrieval and direct-DML denial.\n`,
  );
  process.stdout.write('architecture-gate-suite/1 product-knowledge-center pass\n');
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
  throw new AggregateError(failures, 'product Knowledge Center harness failed');
}
