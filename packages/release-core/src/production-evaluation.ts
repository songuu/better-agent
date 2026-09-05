import {
  EvaluationEvidenceBundleV1Schema,
  EvaluationRunV1Schema,
  EvaluationSuiteReleaseV1Schema,
  ProductionPromotionGateKeyV1Schema,
  type EvaluationEvidenceBundleV1,
  type EvaluationSuiteReleaseV1,
  type ProductionEvaluationPolicyV1,
} from '@better-agent/domain-contracts';

import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import { deepFreezeJson } from './dependency-manifest.js';
import { ReleaseCoreError, type ReleaseCoreErrorCode } from './errors.js';
import { canonicalSha256, canonicalSha256ExcludingRootKeys } from './hash.js';

interface EvaluationSuiteReleaseDraftV1 {
  readonly schema_version: 'evaluation-suite-release/1';
  readonly workspace_id: string;
  readonly evaluation_suite_release_id: string;
  readonly dataset_release_id: string;
  readonly dataset_hash: string;
  readonly evaluator_pins: readonly {
    readonly evaluator_id: string;
    readonly evaluator_release_id: string;
    readonly contract_hash: string;
  }[];
  readonly policy: ProductionEvaluationPolicyV1;
}

interface EvidenceAssemblyOptions {
  readonly observedEvidenceEpochHash?: string;
}

function fail(code: ReleaseCoreErrorCode, path: string, reason: string): never {
  throw new ReleaseCoreError(code, path, reason);
}

function parseOrFail<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
  code: ReleaseCoreErrorCode,
  path: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail(code, path, 'value does not satisfy the closed contract');
  return parsed.data;
}

export function prepareEvaluationSuiteRelease(
  input: EvaluationSuiteReleaseDraftV1,
): Readonly<EvaluationSuiteReleaseV1> {
  const snapshot = boundedDataSnapshot(input, 'source') as EvaluationSuiteReleaseDraftV1;
  const evaluatorPins = [...snapshot.evaluator_pins].sort((left, right) =>
    left.evaluator_id < right.evaluator_id ? -1 : left.evaluator_id > right.evaluator_id ? 1 : 0,
  );
  const policyHash = canonicalSha256(snapshot.policy);
  const content = {
    ...snapshot,
    evaluator_pins: evaluatorPins,
    policy_hash: policyHash,
  };
  const prepared = {
    ...content,
    suite_hash: canonicalSha256(content),
  };
  return deepFreezeJson(
    parseOrFail(
      EvaluationSuiteReleaseV1Schema,
      prepared,
      'EVALUATION_SUITE_INVALID',
      '$.evaluation_suite',
    ),
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalSha256(left) === canonicalSha256(right);
}

function safeSum(values: readonly number[], path: string): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      fail('EVALUATION_EVIDENCE_INVALID', path, 'aggregate exceeds the safe integer range');
    }
  }
  return total;
}

function meetsRate(passed: number, total: number, minimumPpm: number): boolean {
  return BigInt(passed) * 1_000_000n >= BigInt(total) * BigInt(minimumPpm);
}

function terminalMetrics(run: ReturnType<typeof EvaluationRunV1Schema.parse>) {
  if (
    run.status !== 'PASSED' ||
    run.case_count === undefined ||
    run.passed_case_count === undefined ||
    run.safety_passed_case_count === undefined ||
    run.cost_micredits === undefined ||
    run.p95_latency_ms === undefined ||
    run.observed_evidence_epoch_hash === undefined
  ) {
    fail(
      'EVALUATION_EVIDENCE_INVALID',
      '$.evaluation_runs',
      'all runs must be complete and PASSED',
    );
  }
  return {
    caseCount: run.case_count,
    passedCaseCount: run.passed_case_count,
    safetyPassedCaseCount: run.safety_passed_case_count,
    costMicredits: run.cost_micredits,
    p95LatencyMs: run.p95_latency_ms,
    observedEvidenceEpochHash: run.observed_evidence_epoch_hash,
  };
}

export function assembleEvaluationEvidenceBundle(
  suiteInput: unknown,
  runInputs: readonly unknown[],
  options: EvidenceAssemblyOptions = {},
): Readonly<EvaluationEvidenceBundleV1> {
  const suite = parseOrFail(
    EvaluationSuiteReleaseV1Schema,
    boundedDataSnapshot(suiteInput, 'source'),
    'EVALUATION_SUITE_INVALID',
    '$.evaluation_suite',
  );
  if (canonicalSha256ExcludingRootKeys(suite, ['suite_hash']) !== suite.suite_hash) {
    fail('EVALUATION_SUITE_INVALID', '$.evaluation_suite.suite_hash', 'suite hash mismatch');
  }
  if (canonicalSha256(suite.policy) !== suite.policy_hash) {
    fail('EVALUATION_SUITE_INVALID', '$.evaluation_suite.policy_hash', 'policy hash mismatch');
  }
  const runs = runInputs
    .map((run, index) =>
      parseOrFail(
        EvaluationRunV1Schema,
        boundedDataSnapshot(run, 'source'),
        'EVALUATION_EVIDENCE_INVALID',
        `$.evaluation_runs[${String(index)}]`,
      ),
    )
    .sort((left, right) =>
      left.evaluation_run_id < right.evaluation_run_id
        ? -1
        : left.evaluation_run_id > right.evaluation_run_id
          ? 1
          : 0,
    );
  const [first] = runs;
  if (first === undefined) {
    fail('EVALUATION_EVIDENCE_INVALID', '$.evaluation_runs', 'at least one run is required');
  }
  if (new Set(runs.map((run) => run.evaluation_run_id)).size !== runs.length) {
    fail('EVALUATION_EVIDENCE_INVALID', '$.evaluation_runs', 'run identities must be unique');
  }
  const identity = {
    workspace_id: first.workspace_id,
    evaluation_suite_release_id: first.evaluation_suite_release_id,
    evaluation_suite_hash: first.evaluation_suite_hash,
    candidate_deployment_kind: first.candidate_deployment_kind,
    candidate_deployment_id: first.candidate_deployment_id,
    candidate_deployment_revision_id: first.candidate_deployment_revision_id,
    candidate_revision_contract_hash: first.candidate_revision_contract_hash,
    executable_target: first.executable_target,
    dependency_manifest_hash: first.dependency_manifest_hash,
    capability_closure_hash: first.capability_closure_hash,
    model_policy_hash: first.model_policy_hash,
    knowledge_generation_ids: first.knowledge_generation_ids,
    observed_evidence_epoch_hash: first.observed_evidence_epoch_hash,
  };
  for (const run of runs) {
    if (run.status !== 'PASSED') {
      fail('EVALUATION_EVIDENCE_INVALID', '$.evaluation_runs', 'all runs must be PASSED');
    }
    if (
      run.workspace_id !== suite.workspace_id ||
      run.evaluation_suite_release_id !== suite.evaluation_suite_release_id ||
      run.evaluation_suite_hash !== suite.suite_hash ||
      !sameValue(identity, {
        workspace_id: run.workspace_id,
        evaluation_suite_release_id: run.evaluation_suite_release_id,
        evaluation_suite_hash: run.evaluation_suite_hash,
        candidate_deployment_kind: run.candidate_deployment_kind,
        candidate_deployment_id: run.candidate_deployment_id,
        candidate_deployment_revision_id: run.candidate_deployment_revision_id,
        candidate_revision_contract_hash: run.candidate_revision_contract_hash,
        executable_target: run.executable_target,
        dependency_manifest_hash: run.dependency_manifest_hash,
        capability_closure_hash: run.capability_closure_hash,
        model_policy_hash: run.model_policy_hash,
        knowledge_generation_ids: run.knowledge_generation_ids,
        observed_evidence_epoch_hash: run.observed_evidence_epoch_hash,
      })
    ) {
      fail('EVALUATION_EVIDENCE_INVALID', '$.evaluation_runs', 'run authority bindings differ');
    }
  }
  const observedEpoch = terminalMetrics(first).observedEvidenceEpochHash;
  if (
    options.observedEvidenceEpochHash !== undefined &&
    options.observedEvidenceEpochHash !== observedEpoch
  ) {
    fail('EVALUATION_EVIDENCE_STALE', '$.observed_evidence_epoch_hash', 'evidence epoch changed');
  }
  const metrics = runs.map(terminalMetrics);
  const totalCaseCount = safeSum(
    metrics.map(({ caseCount }) => caseCount),
    '$.total_case_count',
  );
  const passedCaseCount = safeSum(
    metrics.map(({ passedCaseCount: count }) => count),
    '$.passed_case_count',
  );
  const safetyPassedCaseCount = safeSum(
    metrics.map(({ safetyPassedCaseCount: count }) => count),
    '$.safety_passed_case_count',
  );
  const totalCost = safeSum(
    metrics.map(({ costMicredits }) => costMicredits),
    '$.total_cost_micredits',
  );
  const p95Latency = Math.max(...metrics.map(({ p95LatencyMs }) => p95LatencyMs));
  const policy = suite.policy;
  if (
    totalCaseCount < policy.minimum_case_count ||
    !meetsRate(passedCaseCount, totalCaseCount, policy.minimum_pass_rate_ppm) ||
    !meetsRate(safetyPassedCaseCount, totalCaseCount, policy.minimum_safety_rate_ppm) ||
    totalCost > policy.maximum_cost_micredits ||
    p95Latency > policy.maximum_p95_latency_ms
  ) {
    fail('EVALUATION_THRESHOLD_FAILED', '$.evaluation_runs', 'production thresholds are not met');
  }
  const content = {
    schema_version: 'evaluation-evidence-bundle/1' as const,
    workspace_id: first.workspace_id,
    evaluation_suite_release_id: suite.evaluation_suite_release_id,
    evaluation_suite_hash: suite.suite_hash,
    evaluation_policy_hash: suite.policy_hash,
    evaluation_run_ids: runs.map((run) => run.evaluation_run_id),
    candidate_deployment_kind: first.candidate_deployment_kind,
    candidate_deployment_id: first.candidate_deployment_id,
    candidate_deployment_revision_id: first.candidate_deployment_revision_id,
    candidate_revision_contract_hash: first.candidate_revision_contract_hash,
    executable_target: first.executable_target,
    dependency_manifest_hash: first.dependency_manifest_hash,
    capability_closure_hash: first.capability_closure_hash,
    total_case_count: totalCaseCount,
    passed_case_count: passedCaseCount,
    safety_passed_case_count: safetyPassedCaseCount,
    total_cost_micredits: totalCost,
    p95_latency_ms: p95Latency,
    observed_evidence_epoch_hash: observedEpoch,
  };
  const bundle = { ...content, evidence_bundle_hash: canonicalSha256(content) };
  return deepFreezeJson(
    parseOrFail(
      EvaluationEvidenceBundleV1Schema,
      bundle,
      'EVALUATION_EVIDENCE_INVALID',
      '$.evidence_bundle',
    ),
  );
}

export function prepareProductionPromotionGateKey(
  bundleInput: unknown,
  expectedActivationEpoch: number,
) {
  const bundle = parseOrFail(
    EvaluationEvidenceBundleV1Schema,
    boundedDataSnapshot(bundleInput, 'source'),
    'PRODUCTION_PROMOTION_KEY_INVALID',
    '$.evidence_bundle',
  );
  const expectedBundleHash = canonicalSha256ExcludingRootKeys(bundle, ['evidence_bundle_hash']);
  if (bundle.evidence_bundle_hash !== expectedBundleHash) {
    fail('PRODUCTION_PROMOTION_KEY_INVALID', '$.evidence_bundle_hash', 'bundle hash mismatch');
  }
  const key = parseOrFail(
    ProductionPromotionGateKeyV1Schema,
    {
      schema_version: 'production-promotion-gate-key/1',
      workspace_id: bundle.workspace_id,
      deployment_kind: bundle.candidate_deployment_kind,
      deployment_id: bundle.candidate_deployment_id,
      candidate_deployment_revision_id: bundle.candidate_deployment_revision_id,
      candidate_revision_contract_hash: bundle.candidate_revision_contract_hash,
      executable_target: bundle.executable_target,
      dependency_manifest_hash: bundle.dependency_manifest_hash,
      capability_closure_hash: bundle.capability_closure_hash,
      evaluation_suite_release_id: bundle.evaluation_suite_release_id,
      evaluation_policy_hash: bundle.evaluation_policy_hash,
      evaluation_run_ids: bundle.evaluation_run_ids,
      evidence_bundle_hash: bundle.evidence_bundle_hash,
      observed_evidence_epoch_hash: bundle.observed_evidence_epoch_hash,
      expected_activation_epoch: expectedActivationEpoch,
    },
    'PRODUCTION_PROMOTION_KEY_INVALID',
    '$.key',
  );
  return deepFreezeJson({ key, key_hash: canonicalSha256(key) });
}
