import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harness = createPostgresHarness('product-database-studio');
const migrationDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/migrations',
);
const workspaceId = 'f2600000-0000-4000-8000-000000000001';
const otherWorkspaceId = 'f2600000-0000-4000-8000-000000000002';
const actorId = 'f2600000-0000-4000-8000-000000000003';

async function main() {
  await harness.start();
  const migrations = await loadMigrations(migrationDirectory);
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), { echoErrors: true });
  await harness.psql(
    'ba_bootstrap_test',
    `INSERT INTO public.workspaces(id,name) VALUES
('${workspaceId}','Database Studio'),('${otherWorkspaceId}','Other Workspace');`,
  );

  const tableId = await harness.queryScalar(
    'ba_runtime_test',
    `SELECT app.create_product_database_table(
      '${workspaceId}','${actorId}','customers','Customer projection',
      '["customer_id","status","enabled"]'::jsonb);`,
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT columns::text FROM app.list_product_database_tables('${workspaceId}')
       WHERE id = '${tableId}';`,
    ),
    '["customer_id", "status", "enabled"]',
    'declared Database columns',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT app.append_product_database_rows(
        '${workspaceId}','${tableId}','${actorId}',
        '[{"customer_id":7,"status":"active","enabled":true},{"customer_id":8,"status":"paused","enabled":false}]'::jsonb);`,
    ),
    '2',
    'appended Database row count',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT (record ->> 'customer_id') || ':' || version::text
       FROM app.query_product_database_table(
         '${workspaceId}','${tableId}','status','active',20);`,
    ),
    '7:1',
    'parameterized Database query exposes the base version',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT version::text || ':' || (record ->> 'status') || ':' || deleted::text
       FROM app.mutate_product_database_row(
         '${workspaceId}','${tableId}',0,1,'${actorId}','update',
         '{"customer_id":7,"status":"paused","enabled":true}'::jsonb);`,
    ),
    '2:paused:false',
    'CAS Database row update receipt',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT * FROM app.mutate_product_database_row(
        '${workspaceId}','${tableId}',0,1,'${actorId}','update',
        '{"customer_id":7,"status":"stale","enabled":true}'::jsonb);`,
      { allowFailure: true },
    ),
    /revision conflict|40001/u,
    'stale Database row update',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT version::text || ':' || deleted::text
       FROM app.mutate_product_database_row(
         '${workspaceId}','${tableId}',1,1,'${actorId}','delete',NULL);`,
    ),
    '2:true',
    'CAS Database row delete receipt',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT row_count FROM app.list_product_database_tables('${workspaceId}')
       WHERE id = '${tableId}';`,
    ),
    '1',
    'active Database row count excludes tombstones',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT version::text || ':' || (record ->> 'status')
       FROM app.query_product_database_table(
         '${workspaceId}','${tableId}','status','',20);`,
    ),
    '2:paused',
    'Database query projects only the current non-deleted version',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_runtime_test',
      `SELECT count(*) FROM app.query_product_database_table(
        '${otherWorkspaceId}','${tableId}','status','',20);`,
    ),
    '0',
    'cross-workspace Database isolation',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT app.append_product_database_rows(
        '${workspaceId}','${tableId}','${actorId}',
        '[{"customer_id":9,"status":"active"}]'::jsonb);`,
      { allowFailure: true },
    ),
    /declared columns|22023/u,
    'row with missing declared column',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT * FROM app.query_product_database_table(
        '${workspaceId}','${tableId}','secret','',20);`,
      { allowFailure: true },
    ),
    /query is invalid|22023/u,
    'query outside the column allowlist',
  );
  assertRejected(
    await harness.psql(
      'ba_runtime_test',
      `SELECT * FROM app.mutate_product_database_row(
        '${otherWorkspaceId}','${tableId}',0,2,'${actorId}','delete',NULL);`,
      { allowFailure: true },
    ),
    /not found|P0002/u,
    'cross-workspace Database mutation isolation',
  );
  assertRejected(
    await harness.psql('ba_runtime_test', 'SELECT count(*) FROM public.product_database_rows;', {
      allowFailure: true,
    }),
    /permission denied|42501/u,
    'runtime direct Database row read',
  );
  assertRejected(
    await harness.psql(
      'ba_migrator_test',
      `SET ROLE ba_authorization_owner;
       UPDATE public.product_database_rows SET record = '{}'::jsonb
       WHERE workspace_id = '${workspaceId}' AND table_id = '${tableId}' AND ordinal = 0;`,
      { allowFailure: true },
    ),
    /immutable|55000/u,
    'immutable Database row history',
  );
  assertRejected(
    await harness.psql(
      'ba_migrator_test',
      `SET ROLE ba_authorization_owner;
       UPDATE public.product_database_row_versions SET record = '{}'::jsonb
       WHERE workspace_id = '${workspaceId}' AND table_id = '${tableId}' AND ordinal = 0;`,
      { allowFailure: true },
    ),
    /immutable|55000/u,
    'immutable Database row version history',
  );

  process.stdout.write(
    `PostgreSQL 16 product Database Studio passed: ${migrations.length} migrations, declared columns, append-only base rows, CAS update/delete versions, bounded current reads, tenant isolation, direct-table denial and immutable history.\n`,
  );
  process.stdout.write('architecture-gate-suite/1 product-database-studio pass\n');
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
  throw new AggregateError(failures, 'product Database Studio harness failed');
}
