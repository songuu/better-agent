import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations, renderUpMigrationSql } from '../../../packages/db/dist/index.js';
import {
  assembleEvaluationEvidenceBundle,
  prepareEvaluationSuiteRelease,
  prepareProductionPromotionGateKey,
} from '../../../packages/release-core/dist/index.js';
import { assertEqual, assertRejected, createPostgresHarness } from './harness.mjs';

const harness = createPostgresHarness('g1-production-evaluation');
const migrationDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/migrations',
);
const uuid = (value) => `a7000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const ids = Object.freeze({
  workspace: uuid(1),
  admin: uuid(2),
  controlAttestation: uuid(4),
  agent: uuid(5),
  release: uuid(6),
  deployment: uuid(7),
  revision: uuid(8),
  suite: uuid(9),
  dataset: uuid(10),
  run1: uuid(11),
  run2: uuid(12),
  failedRun: uuid(13),
  strategy: uuid(14),
  decision: uuid(15),
});
const secrets = Object.freeze({
  control: randomBytes(32).toString('hex'),
  subject: randomBytes(32).toString('hex'),
});
const hash = (character) => `sha256:${character.repeat(64)}`;
const bytea = (hex) => `decode('${hex}','hex')`;
const jsonb = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;

const target = Object.freeze({
  workspace_id: ids.workspace,
  published_resource_kind: 'AGENT_RELEASE',
  resource_id: ids.agent,
  resource_version_id: ids.release,
  contract_hash: hash('a'),
  binding_mode: 'pinned',
});

function contextSql(attestation, secret, body) {
  return `BEGIN;
SELECT auth.establish_control_workspace_context('${attestation}',${bytea(secret)});
${body}
COMMIT;`;
}

function evaluationRun(id, suite, overrides = {}) {
  return {
    schema_version: 'evaluation-run/1',
    workspace_id: ids.workspace,
    evaluation_run_id: id,
    evaluation_suite_release_id: suite.evaluation_suite_release_id,
    evaluation_suite_hash: suite.suite_hash,
    candidate_deployment_kind: 'agent',
    candidate_deployment_id: ids.deployment,
    candidate_deployment_revision_id: ids.revision,
    candidate_revision_contract_hash: hash('b'),
    executable_target: target,
    dependency_manifest_hash: hash('c'),
    capability_closure_hash: hash('d'),
    strategy_release_id: ids.strategy,
    strategy_contract_hash: hash('e'),
    model_policy_hash: hash('f'),
    knowledge_generation_ids: ['knowledge-generation-a'],
    status: 'PASSED',
    case_count: 10,
    passed_case_count: 10,
    safety_passed_case_count: 10,
    cost_micredits: 100,
    p95_latency_ms: 500,
    evidence_hash: hash('1'),
    observed_evidence_epoch_hash: hash('2'),
    completed_at: '2026-09-05T00:00:00Z',
    ...overrides,
  };
}

async function seedAuthorityAndCandidate() {
  const canonicalRevision = JSON.stringify({
    schema_version: 'agent-deployment/1',
    workspace_id: ids.workspace,
    agent_deployment_id: ids.deployment,
    agent_deployment_revision_id: ids.revision,
    agent_id: ids.agent,
    revision_contract_hash: hash('b'),
    conversation_contract_hash: hash('9'),
  }).replaceAll("'", "''");
  await harness.psql(
    'ba_bootstrap_test',
    `BEGIN;
SET LOCAL session_replication_role=replica;
INSERT INTO public.workspaces(id,name) VALUES('${ids.workspace}','G1 production evaluation');
INSERT INTO public.workspace_members(workspace_id,user_id,role)
VALUES('${ids.workspace}','${ids.admin}','admin');
INSERT INTO public.agent_deployments(
  id,workspace_id,agent_id,public_selector,environment,ingress_channel,created_by)
VALUES('${ids.deployment}','${ids.workspace}','${ids.agent}','g1-production-agent',
  'production','service_api','fixture');
INSERT INTO public.agent_deployment_security_states(
  workspace_id,agent_deployment_id,status,revoke_epoch,updated_by)
VALUES('${ids.workspace}','${ids.deployment}','ACTIVE',0,'fixture');
INSERT INTO public.agent_deployment_revisions(
  id,workspace_id,agent_deployment_id,agent_id,environment,ingress_channel,
  agent_release_id,agent_release_contract_hash,experience_id,experience_release_id,
  experience_contract_hash,policy_profile_id,policy_profile_version_id,
  policy_profile_contract_hash,entry_grant_policy_id,entry_grant_policy_version_id,
  entry_grant_policy_contract_hash,entry_scope_policy_id,entry_scope_policy_version_id,
  entry_scope_policy_contract_hash,credential_mapping_hash,dependency_manifest_hash,
  change_set_hash,revision_contract_hash,canonical_document,created_by)
VALUES('${ids.revision}','${ids.workspace}','${ids.deployment}','${ids.agent}',
  'production','service_api','${ids.release}','${hash('a')}','${uuid(20)}','${uuid(21)}',
  '${hash('3')}','${uuid(22)}','${uuid(23)}','${hash('4')}','${uuid(24)}','${uuid(25)}',
  '${hash('5')}','${uuid(26)}','${uuid(27)}','${hash('6')}','${hash('7')}','${hash('c')}',
  '${hash('8')}','${hash('b')}','${canonicalRevision}','fixture');
INSERT INTO public.published_executable_closures(
  workspace_id,published_resource_kind,resource_id,resource_version_id,contract_hash,
  dependency_manifest_hash,semantic_seed_hash,capability_closure_hash,
  canonical_compiled_preimage,canonical_closure_preimage,stored_by)
VALUES('${ids.workspace}','AGENT_RELEASE','${ids.agent}','${ids.release}','${hash('a')}',
  '${hash('c')}','${hash('9')}','${hash('d')}','{}','{}','fixture');
COMMIT;`,
  );
  await harness.psql(
    'ba_management_issuer_test',
    `SELECT auth.issue_control_session_attestation('${ids.controlAttestation}',
  '${ids.workspace}','${ids.admin}','ba_control_test','g1-a7-control',
  ${bytea(secrets.subject)},${bytea(secrets.control)},clock_timestamp()+interval '10 minutes');`,
  );
}

async function assertEvaluationAndPromotion() {
  const suite = prepareEvaluationSuiteRelease({
    schema_version: 'evaluation-suite-release/1',
    workspace_id: ids.workspace,
    evaluation_suite_release_id: ids.suite,
    dataset_release_id: ids.dataset,
    dataset_hash: hash('0'),
    evaluator_pins: [
      { evaluator_id: 'safety', evaluator_release_id: 'safety-v1', contract_hash: hash('1') },
    ],
    policy: {
      schema_version: 'production-evaluation-policy/1',
      minimum_pass_rate_ppm: 950_000,
      minimum_safety_rate_ppm: 1_000_000,
      maximum_cost_micredits: 1_000,
      maximum_p95_latency_ms: 1_000,
      minimum_case_count: 20,
    },
  });
  const run1 = evaluationRun(ids.run1, suite);
  const run2 = evaluationRun(ids.run2, suite);
  const failedRun = evaluationRun(ids.failedRun, suite, {
    status: 'FAILED',
    passed_case_count: 0,
    safety_passed_case_count: 0,
  });
  await harness.psql(
    'ba_management_issuer_test',
    `SELECT app.register_evaluation_suite_release(${jsonb(suite)});
SELECT app.register_evaluation_run(${jsonb(run1)});
SELECT app.register_evaluation_run(${jsonb(run2)});
SELECT app.register_evaluation_run(${jsonb(failedRun)});`,
  );
  const bundle = assembleEvaluationEvidenceBundle(suite, [run2, run1]);
  await harness.psql(
    'ba_management_issuer_test',
    `SELECT app.register_evaluation_evidence_bundle(${jsonb(bundle)});`,
  );
  const rejectedBundle = {
    ...bundle,
    evaluation_run_ids: [ids.failedRun],
    total_case_count: 10,
    passed_case_count: 0,
    safety_passed_case_count: 0,
  };
  assertRejected(
    await harness.psql(
      'ba_management_issuer_test',
      `SELECT app.register_evaluation_evidence_bundle(${jsonb(rejectedBundle)});`,
      { allowFailure: true },
    ),
    /evaluation evidence aggregate mismatch|42501/u,
    'failed evaluation Run cannot enter production evidence',
  );
  const prepared = prepareProductionPromotionGateKey(bundle, 0);
  await harness.psql(
    'ba_management_issuer_test',
    `SELECT app.create_production_promotion_decision('${ids.decision}',${jsonb(prepared.key)},
  '${prepared.key_hash}',clock_timestamp()+interval '5 minutes');
SELECT app.transition_production_promotion_decision('${ids.workspace}','${ids.decision}',1,
  'APPROVED','reviewed');`,
  );
  assertRejected(
    await harness.psql(
      'ba_control_test',
      contextSql(
        ids.controlAttestation,
        secrets.control,
        `UPDATE public.production_promotion_decisions SET status='CONSUMED'
WHERE workspace_id='${ids.workspace}' AND id='${ids.decision}';`,
      ),
      { allowFailure: true },
    ),
    /permission denied|42501/u,
    'control executor has no direct decision DML',
  );
  await harness.psql(
    'ba_control_test',
    contextSql(
      ids.controlAttestation,
      secrets.control,
      `SELECT app.consume_production_promotion_decision('${ids.decision}',2,'promote reviewed candidate');`,
    ),
  );
  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',pointer.activation_epoch,pointer.active_revision_id,
  decision.status,decision.decision_version,
  (SELECT count(*) FROM public.deployment_promotion_audits audit
    WHERE audit.workspace_id=pointer.workspace_id AND audit.deployment_id=pointer.agent_deployment_id))
FROM public.agent_deployment_active_pointers pointer
JOIN public.production_promotion_decisions decision ON decision.workspace_id=pointer.workspace_id
WHERE pointer.workspace_id='${ids.workspace}' AND pointer.agent_deployment_id='${ids.deployment}';`,
    ),
    `1|${ids.revision}|CONSUMED|3|1`,
    'approved decision atomically switches the production pointer once',
  );
  assertRejected(
    await harness.psql(
      'ba_control_test',
      contextSql(
        ids.controlAttestation,
        secrets.control,
        `SELECT app.consume_production_promotion_decision('${ids.decision}',3,'replay');`,
      ),
      { allowFailure: true },
    ),
    /approved production promotion decision unavailable|42501/u,
    'consumed decision cannot be replayed',
  );
}

async function main() {
  await harness.start();
  const migrations = await loadMigrations(migrationDirectory);
  await harness.psql('ba_migrator_test', renderUpMigrationSql(migrations));
  await seedAuthorityAndCandidate();
  await assertEvaluationAndPromotion();
  process.stdout.write(
    `PostgreSQL 16 G1 production evaluation passed: ${migrations.length} migrations, immutable suite/runs, exact threshold aggregation, reviewer/control separation and one-use Agent/Flow production CAS.\n`,
  );
  process.stdout.write('architecture-gate-suite/1 g1-production-evaluation pass\n');
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
  throw new AggregateError(failures, 'G1 production evaluation harness failed');
}
