import { describe, expect, it } from 'vitest';

import {
  EvaluationEvidenceBundleV1Schema,
  EvaluationRunV1Schema,
  EvaluationSuiteReleaseV1Schema,
} from '../src/index.js';

const hash = `sha256:${'a'.repeat(64)}`;
const otherHash = `sha256:${'b'.repeat(64)}`;
const agentPin = {
  workspace_id: '00000000-0000-4000-8000-000000000001',
  published_resource_kind: 'AGENT_RELEASE',
  resource_id: '00000000-0000-4000-8000-000000000002',
  resource_version_id: '00000000-0000-4000-8000-000000000003',
  contract_hash: hash,
  binding_mode: 'pinned',
} as const;

const suite = {
  schema_version: 'evaluation-suite-release/1',
  workspace_id: agentPin.workspace_id,
  evaluation_suite_release_id: '00000000-0000-4000-8000-000000000004',
  dataset_release_id: '00000000-0000-4000-8000-000000000005',
  dataset_hash: hash,
  evaluator_pins: [
    { evaluator_id: 'correctness', evaluator_release_id: 'correctness-v1', contract_hash: hash },
    { evaluator_id: 'safety', evaluator_release_id: 'safety-v1', contract_hash: otherHash },
  ],
  policy: {
    schema_version: 'production-evaluation-policy/1',
    minimum_pass_rate_ppm: 950_000,
    minimum_safety_rate_ppm: 1_000_000,
    maximum_cost_micredits: 5_000_000,
    maximum_p95_latency_ms: 10_000,
    minimum_case_count: 1,
  },
  policy_hash: hash,
  suite_hash: otherHash,
} as const;

const run = {
  schema_version: 'evaluation-run/1',
  workspace_id: agentPin.workspace_id,
  evaluation_run_id: '00000000-0000-4000-8000-000000000006',
  evaluation_suite_release_id: suite.evaluation_suite_release_id,
  evaluation_suite_hash: suite.suite_hash,
  candidate_deployment_kind: 'agent',
  candidate_deployment_id: '00000000-0000-4000-8000-000000000007',
  candidate_deployment_revision_id: '00000000-0000-4000-8000-000000000008',
  candidate_revision_contract_hash: hash,
  executable_target: agentPin,
  dependency_manifest_hash: hash,
  capability_closure_hash: otherHash,
  strategy_release_id: '00000000-0000-4000-8000-000000000009',
  strategy_contract_hash: hash,
  model_policy_hash: otherHash,
  knowledge_generation_ids: ['knowledge-a', 'knowledge-b'],
  status: 'PASSED',
  case_count: 10,
  passed_case_count: 10,
  safety_passed_case_count: 10,
  cost_micredits: 4000,
  p95_latency_ms: 900,
  evidence_hash: hash,
  observed_evidence_epoch_hash: otherHash,
  completed_at: '2026-09-05T00:00:00Z',
} as const;

describe('G1 production evaluation contracts', () => {
  it('accepts a closed immutable suite and requires canonical evaluator order', () => {
    expect(EvaluationSuiteReleaseV1Schema.safeParse(suite).success).toBe(true);
    expect(
      EvaluationSuiteReleaseV1Schema.safeParse({
        ...suite,
        evaluator_pins: [...suite.evaluator_pins].reverse(),
      }).success,
    ).toBe(false);
    expect(EvaluationSuiteReleaseV1Schema.safeParse({ ...suite, mutable: true }).success).toBe(
      false,
    );
  });

  it('binds a terminal run to exact candidate and dependency evidence', () => {
    expect(EvaluationRunV1Schema.safeParse(run).success).toBe(true);
    expect(
      EvaluationRunV1Schema.safeParse({
        ...run,
        knowledge_generation_ids: ['knowledge-b', 'knowledge-a'],
      }).success,
    ).toBe(false);
    expect(
      EvaluationRunV1Schema.safeParse({
        ...run,
        status: 'RUNNING',
        case_count: undefined,
        passed_case_count: undefined,
        safety_passed_case_count: undefined,
        cost_micredits: undefined,
        p95_latency_ms: undefined,
        evidence_hash: undefined,
        observed_evidence_epoch_hash: undefined,
        completed_at: undefined,
      }).success,
    ).toBe(true);
    expect(
      EvaluationRunV1Schema.safeParse({ ...run, status: 'PASSED', completed_at: undefined })
        .success,
    ).toBe(false);
    expect(EvaluationRunV1Schema.safeParse({ ...run, passed_case_count: 11 }).success).toBe(false);
  });

  it('requires a canonical all-passed evidence bundle with aggregate thresholds', () => {
    const bundle = {
      schema_version: 'evaluation-evidence-bundle/1',
      workspace_id: run.workspace_id,
      evaluation_suite_release_id: run.evaluation_suite_release_id,
      evaluation_suite_hash: run.evaluation_suite_hash,
      evaluation_policy_hash: suite.policy_hash,
      evaluation_run_ids: [run.evaluation_run_id],
      candidate_deployment_kind: run.candidate_deployment_kind,
      candidate_deployment_id: run.candidate_deployment_id,
      candidate_deployment_revision_id: run.candidate_deployment_revision_id,
      candidate_revision_contract_hash: run.candidate_revision_contract_hash,
      executable_target: run.executable_target,
      dependency_manifest_hash: run.dependency_manifest_hash,
      capability_closure_hash: run.capability_closure_hash,
      total_case_count: 10,
      passed_case_count: 10,
      safety_passed_case_count: 10,
      total_cost_micredits: 4000,
      p95_latency_ms: 900,
      observed_evidence_epoch_hash: run.observed_evidence_epoch_hash,
      evidence_bundle_hash: hash,
    } as const;
    expect(EvaluationEvidenceBundleV1Schema.safeParse(bundle).success).toBe(true);
    expect(
      EvaluationEvidenceBundleV1Schema.safeParse({
        ...bundle,
        evaluation_run_ids: [run.evaluation_run_id, run.evaluation_run_id],
      }).success,
    ).toBe(false);
    expect(
      EvaluationEvidenceBundleV1Schema.safeParse({ ...bundle, safety_passed_case_count: 11 })
        .success,
    ).toBe(false);
  });
});
