import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJsonBytes } from '../../../packages/release-core/dist/index.js';
import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrationDirectory = path.resolve(directory, '../../../packages/db/migrations');
const harness = createPostgresHarness('g1-knowledge-database');
const id = (n) => `fb300000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ids = Object.freeze({
  workspace: id(1),
  credential: id(2),
  run: id(3),
  request: id(4),
  attempt: id(5),
  step: id(6),
  attestation: id(7),
  knowledge: id(8),
  knowledgeVersion: id(9),
  database: id(10),
  databaseVersion: id(11),
  knowledgeReceipt: id(12),
  databaseReceipt: id(13),
  subject: id(14),
});
const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const canonicalHash = (value) =>
  `sha256:${createHash('sha256').update(canonicalJsonBytes(value)).digest('hex')}`;
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const jsonb = (value) => `${sqlLiteral(JSON.stringify(value))}::jsonb`;
const rawSecret = randomBytes(32).toString('hex');
const subjectBinding = randomBytes(32).toString('hex');

function establish(body) {
  return `BEGIN;
SELECT auth.establish_internal_service_workspace_context(
  '${ids.attestation}', decode('${rawSecret}', 'hex'), 'execution'
);
${body}
COMMIT;`;
}

async function call(functionName, fact) {
  const result = await harness.psql(
    'ba_execution_test',
    establish(`SELECT app.${functionName}(${jsonb(fact)});`),
    { scanFor: [rawSecret], tuplesOnly: true },
  );
  const line = result.stdout
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .findLast((item) => item.startsWith('{'));
  if (line === undefined) throw new Error(`${functionName} returned no JSON object`);
  return JSON.parse(line);
}

async function reject(functionName, fact, pattern, context) {
  const result = await harness.psql(
    'ba_execution_test',
    establish(`SELECT app.${functionName}(${jsonb(fact)});`),
    { allowFailure: true, scanFor: [rawSecret] },
  );
  assertRejected(result, pattern, context);
}

function compiledKnowledge() {
  const draft = {
    schema_version: 'compiled-knowledge-query/1',
    generation_pin: {
      workspace_id: ids.workspace,
      published_resource_kind: 'KNOWLEDGE_INDEX_GENERATION',
      resource_id: ids.knowledge,
      resource_version_id: ids.knowledgeVersion,
      contract_hash: sha('knowledge-contract'),
      binding_mode: 'pinned',
    },
    authority_hash: sha('authority'),
    workspace_id: ids.workspace,
    subject_id: ids.subject,
    authorized_sources: [{ source_id: id(20), source_release_id: id(21) }],
    text: 'deployment policy',
    filters: [{ field: 'category', operator: 'eq', value: 'guide' }],
    embedding: { model: 'fixture' },
    retrieval: { top_k: 10 },
    rerank: { mode: 'none' },
    index_manifest: { shard_hashes: [sha('shard')] },
    timeout_ms: 800,
  };
  return { ...draft, compiled_hash: canonicalHash(draft) };
}

function compiledDatabase() {
  const draft = {
    schema_version: 'compiled-database-select/1',
    connector_id: id(30),
    connector_revision_id: id(31),
    database_operation_pin: {
      workspace_id: ids.workspace,
      published_resource_kind: 'DATABASE_OPERATION_RELEASE',
      resource_id: ids.database,
      resource_version_id: ids.databaseVersion,
      contract_hash: sha('database-contract'),
      binding_mode: 'pinned',
    },
    table_revision_id: id(32),
    operation_contract_hash: sha('database-operation'),
    sql: 'SELECT "title" FROM "app"."records" WHERE "workspace_id" = $1::uuid LIMIT 10',
    values: [ids.workspace],
    result_columns: ['title'],
    max_rows: 10,
    timeout_ms: 700,
    transaction_mode: 'read_only',
  };
  return { ...draft, compiled_hash: canonicalHash(draft) };
}

function receipt(schemaVersion, receiptId, operationKey, compiledKey, compiled, countKey) {
  const draft = {
    schema_version: schemaVersion,
    receipt_id: receiptId,
    operation_key: operationKey,
    [compiledKey]: compiled,
    result_ref: `snapshot://${operationKey}`,
    result_hash: sha(`${operationKey}-result`),
    [countKey]: 1,
    duration_ms: 25,
  };
  return { ...draft, receipt_hash: canonicalHash(draft) };
}

async function main() {
  const migrations = await loadMigrations(migrationDirectory);
  await harness.start();
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations), { echoErrors: true });
  const acceptedPlan = sha('accepted-plan');
  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.workspaces (id,name) VALUES ('${ids.workspace}','G1 capability integration');
INSERT INTO public.runs (
  workspace_id,id,billing_owner_run_id,accepted_request_id,accepted_principal_kind,
  accepted_credential_id,fixed_route,intent_hash,admission_snapshot_hash,accepted_plan_hash,
  accepted_output_schema_ref,accepted_output_schema_hash,dependency_pins_hash,target_kind,
  flow_deployment_id,flow_deployment_revision_id,flow_id,flow_version_id,status,
  execution_status,billing_state,acceptance_receipt_data_redacted,last_event_sequence
) VALUES (
  '${ids.workspace}','${ids.run}','${ids.run}','${ids.request}','credential','${ids.credential}',
  '/v1/oapi/flow/run','${sha('intent')}','${sha('admission')}','${acceptedPlan}',
  'schema://output','${sha('output')}','${sha('dependencies')}','flow',
  '${id(40)}','${id(41)}','${id(42)}','${id(43)}','QUEUED','QUEUED','PENDING','{}'::jsonb,0
);
INSERT INTO public.run_attempts (
  workspace_id,id,run_id,attempt_number,status,runtime_protocol_version,lease_generation
) VALUES ('${ids.workspace}','${ids.attempt}','${ids.run}',1,'PENDING',5,0);
INSERT INTO public.published_g1_resource_sources (
  workspace_id,published_resource_kind,resource_id,resource_version_id,contract_hash,
  dependency_manifest_hash,source_schema_version,canonical_document,
  canonical_source_preimage,canonical_source_artifact,stored_by
) VALUES
  ('${ids.workspace}','KNOWLEDGE_INDEX_GENERATION','${ids.knowledge}',
   '${ids.knowledgeVersion}','${sha('knowledge-contract')}','${sha('knowledge-dependencies')}',
   'knowledge-index-generation-source/1','{}','{}','{}','fixture'),
  ('${ids.workspace}','DATABASE_OPERATION_RELEASE','${ids.database}',
   '${ids.databaseVersion}','${sha('database-contract')}','${sha('database-dependencies')}',
   'database-operation-source/1','{}','{}','{}','fixture');
COMMIT;`,
  );
  await harness.psql(
    'ba_internal_issuer_test',
    `SELECT auth.issue_internal_service_attestation(
  '${ids.attestation}','${ids.workspace}','ba_execution_test'::name,'execution',
  'better-agent/internal-service/1',decode('${subjectBinding}','hex'),
  public.hmac(decode('${rawSecret}','hex'),
    convert_to('better-agent/internal-service-attestation-verifier/1','UTF8') || decode('00','hex'),
    'sha256'),clock_timestamp()+interval '10 minutes'
);`,
    { scanFor: [rawSecret] },
  );
  const authority = await call('claim_run_attempt', {
    run_id: ids.run,
    attempt_id: ids.attempt,
    duration_seconds: 300,
  });
  const leased = {
    run_id: ids.run,
    attempt_id: ids.attempt,
    lease_token: authority.lease_token,
    lease_fencing_token: authority.lease_fencing_token,
  };
  await call('record_attempt_started', leased);
  const stepLeased = { ...leased, step_id: ids.step };
  await call('record_step_started', {
    ...stepLeased,
    step_key: 'capability',
    input_hash: sha('capability-input'),
  });

  const knowledgeReceipt = receipt(
    'knowledge-query-execution-receipt/1',
    ids.knowledgeReceipt,
    'knowledge:v1:search',
    'compiled_query',
    compiledKnowledge(),
    'result_count',
  );
  const databaseReceipt = receipt(
    'database-operation-execution-receipt/1',
    ids.databaseReceipt,
    'database:v1:select',
    'compiled_select',
    compiledDatabase(),
    'row_count',
  );
  const recordedKnowledge = await call('record_knowledge_query_receipt', {
    ...stepLeased,
    receipt: knowledgeReceipt,
  });
  assertEqual(String(recordedKnowledge.replayed), 'false', 'Knowledge receipt commits once');
  const replayedKnowledge = await call('record_knowledge_query_receipt', {
    ...stepLeased,
    receipt: knowledgeReceipt,
  });
  assertEqual(String(replayedKnowledge.replayed), 'true', 'Knowledge receipt replays exactly');
  const recordedDatabase = await call('record_database_operation_receipt', {
    ...stepLeased,
    receipt: databaseReceipt,
  });
  assertEqual(String(recordedDatabase.replayed), 'false', 'Database receipt commits once');
  await reject(
    'record_database_operation_receipt',
    {
      ...stepLeased,
      receipt: { ...databaseReceipt, result_hash: sha('changed-result') },
    },
    /compiled or receipt hash is invalid|55000/u,
    'tampered Database receipt is rejected',
  );
  const conflictingDraft = { ...databaseReceipt, receipt_id: id(99) };
  const conflicting = {
    ...conflictingDraft,
    receipt_hash: canonicalHash(
      Object.fromEntries(
        Object.entries(conflictingDraft).filter(([key]) => key !== 'receipt_hash'),
      ),
    ),
  };
  await reject(
    'record_database_operation_receipt',
    { ...stepLeased, receipt: conflicting },
    /operation key conflicts|23505/u,
    'Database operation key cannot identify another receipt',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.knowledge_query_receipts WHERE workspace_id='${ids.workspace}'),
  (SELECT count(*) FROM public.database_operation_receipts WHERE workspace_id='${ids.workspace}')
);`,
    ),
    '1|1',
    'both immutable capability receipts are exactly once',
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT NOT has_table_privilege('ba_execution_test','public.knowledge_query_receipts','SELECT,INSERT,UPDATE,DELETE')
AND NOT has_table_privilege('ba_execution_test','public.database_operation_receipts','SELECT,INSERT,UPDATE,DELETE');`,
    ),
    't',
    'execution login has no direct capability receipt DML',
  );
  process.stdout.write(
    'PostgreSQL 16 G1-A3 Knowledge/Database passed: exact generation/source pins, lease-bound immutable receipts, conflict and tamper rejection.\n',
  );
  process.stdout.write('architecture-gate-suite/1 g1-knowledge-database pass\n');
}

let failure;
try {
  await main();
} catch (error) {
  failure = error;
}
try {
  await harness.stop();
} catch (error) {
  failure =
    failure === undefined
      ? error
      : new AggregateError([failure, error], 'capability integration and cleanup failed');
}
if (failure !== undefined) throw failure;
