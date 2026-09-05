import { describe, expect, it } from 'vitest';

import {
  assembleEvaluationEvidenceBundle,
  prepareEvaluationSuiteRelease,
  prepareProductionPromotionGateKey,
} from '../src/index.js';

const hashA = `sha256:${'a'.repeat(64)}`;
const hashB = `sha256:${'b'.repeat(64)}`;
const workspaceId = '00000000-0000-4000-8000-000000000001';
const target = {
  workspace_id: workspaceId,
  published_resource_kind: 'AGENT_RELEASE',
  resource_id: '00000000-0000-4000-8000-000000000002',
  resource_version_id: '00000000-0000-4000-8000-000000000003',
  contract_hash: hashA,
  binding_mode: 'pinned',
} as const;

function passedRun(id: string, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'evaluation-run/1',
    workspace_id: workspaceId,
    evaluation_run_id: id,
    evaluation_suite_release_id: '00000000-0000-4000-8000-000000000004',
    evaluation_suite_hash: hashB,
    candidate_deployment_kind: 'agent',
    candidate_deployment_id: '00000000-0000-4000-8000-000000000005',
    candidate_deployment_revision_id: '00000000-0000-4000-8000-000000000006',
    candidate_revision_contract_hash: hashA,
    executable_target: target,
    dependency_manifest_hash: hashA,
    capability_closure_hash: hashB,
    strategy_release_id: '00000000-0000-4000-8000-000000000007',
    strategy_contract_hash: hashA,
    model_policy_hash: hashB,
    knowledge_generation_ids: ['knowledge-a'],
    status: 'PASSED',
    case_count: 10,
    passed_case_count: 10,
    safety_passed_case_count: 10,
    cost_micredits: 100,
    p95_latency_ms: 500,
    evidence_hash: hashA,
    observed_evidence_epoch_hash: hashB,
    completed_at: '2026-09-05T00:00:00Z',
    ...overrides,
  };
}

describe('production evaluation and promotion key', () => {
  it('canonicalizes the suite and computes both policy and suite hashes', () => {
    const suite = prepareEvaluationSuiteRelease({
      schema_version: 'evaluation-suite-release/1',
      workspace_id: workspaceId,
      evaluation_suite_release_id: '00000000-0000-4000-8000-000000000004',
      dataset_release_id: '00000000-0000-4000-8000-000000000008',
      dataset_hash: hashA,
      evaluator_pins: [
        { evaluator_id: 'safety', evaluator_release_id: 'v1', contract_hash: hashB },
        { evaluator_id: 'correctness', evaluator_release_id: 'v1', contract_hash: hashA },
      ],
      policy: {
        schema_version: 'production-evaluation-policy/1',
        minimum_pass_rate_ppm: 950_000,
        minimum_safety_rate_ppm: 1_000_000,
        maximum_cost_micredits: 1_000,
        maximum_p95_latency_ms: 1_000,
        minimum_case_count: 10,
      },
    });
    expect(suite.evaluator_pins.map((pin) => pin.evaluator_id)).toEqual(['correctness', 'safety']);
    expect(suite.policy_hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(suite.suite_hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(suite)).toBe(true);
  });

  it('rejects failed, crossed, stale or threshold-breaking evaluation evidence', () => {
    const suite = prepareEvaluationSuiteRelease({
      schema_version: 'evaluation-suite-release/1',
      workspace_id: workspaceId,
      evaluation_suite_release_id: '00000000-0000-4000-8000-000000000004',
      dataset_release_id: '00000000-0000-4000-8000-000000000008',
      dataset_hash: hashA,
      evaluator_pins: [
        { evaluator_id: 'safety', evaluator_release_id: 'v1', contract_hash: hashB },
      ],
      policy: {
        schema_version: 'production-evaluation-policy/1',
        minimum_pass_rate_ppm: 950_000,
        minimum_safety_rate_ppm: 1_000_000,
        maximum_cost_micredits: 1_000,
        maximum_p95_latency_ms: 1_000,
        minimum_case_count: 10,
      },
    });
    const base = passedRun('00000000-0000-4000-8000-000000000010', {
      evaluation_suite_hash: suite.suite_hash,
    });
    expect(() => assembleEvaluationEvidenceBundle(suite, [{ ...base, status: 'FAILED' }])).toThrow(
      /EVALUATION_EVIDENCE_INVALID/u,
    );
    expect(() =>
      assembleEvaluationEvidenceBundle(suite, [{ ...base, cost_micredits: 1001 }]),
    ).toThrow(/EVALUATION_THRESHOLD_FAILED/u);
    expect(() =>
      assembleEvaluationEvidenceBundle(suite, [{ ...base, observed_evidence_epoch_hash: hashA }], {
        observedEvidenceEpochHash: hashB,
      }),
    ).toThrow(/EVALUATION_EVIDENCE_STALE/u);
  });

  it('builds one canonical promotion key from sorted all-passed runs', () => {
    const suite = prepareEvaluationSuiteRelease({
      schema_version: 'evaluation-suite-release/1',
      workspace_id: workspaceId,
      evaluation_suite_release_id: '00000000-0000-4000-8000-000000000004',
      dataset_release_id: '00000000-0000-4000-8000-000000000008',
      dataset_hash: hashA,
      evaluator_pins: [
        { evaluator_id: 'safety', evaluator_release_id: 'v1', contract_hash: hashB },
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
    const second = passedRun('00000000-0000-4000-8000-000000000011', {
      evaluation_suite_hash: suite.suite_hash,
    });
    const first = passedRun('00000000-0000-4000-8000-000000000010', {
      evaluation_suite_hash: suite.suite_hash,
    });
    const bundle = assembleEvaluationEvidenceBundle(suite, [second, first]);
    const prepared = prepareProductionPromotionGateKey(bundle, 4);
    expect(bundle.evaluation_run_ids).toEqual([
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000011',
    ]);
    expect(prepared.key.expected_activation_epoch).toBe(4);
    expect(prepared.key.evidence_bundle_hash).toBe(bundle.evidence_bundle_hash);
    expect(prepared.key_hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });
});
