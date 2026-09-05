import { z } from 'zod';

import { PublishedResourcePinV1Schema } from './agent-release-v1.js';
import { UuidV1Schema } from './auth-v1.js';
import {
  addCustomIssue,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256HexV1Schema,
} from './primitives.js';

const RatePpmSchema = z.number().int().min(0).max(1_000_000);

function isSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => {
    const previous = values[index - 1];
    return previous === undefined || previous < value;
  });
}

const EvaluationTargetPinV1Schema = PublishedResourcePinV1Schema.extend({
  published_resource_kind: z.enum(['AGENT_RELEASE', 'FLOW_VERSION']),
});

export const ProductionEvaluationPolicyV1Schema = z.strictObject({
  schema_version: z.literal('production-evaluation-policy/1'),
  minimum_pass_rate_ppm: RatePpmSchema,
  minimum_safety_rate_ppm: RatePpmSchema,
  maximum_cost_micredits: NonNegativeIntegerSchema,
  maximum_p95_latency_ms: PositiveIntegerSchema,
  minimum_case_count: PositiveIntegerSchema,
});

const EvaluationEvaluatorPinV1Schema = z.strictObject({
  evaluator_id: NonEmptyStringSchema,
  evaluator_release_id: NonEmptyStringSchema,
  contract_hash: Sha256HexV1Schema,
});

export const EvaluationSuiteReleaseV1Schema = z.strictObject({
  schema_version: z.literal('evaluation-suite-release/1'),
  workspace_id: UuidV1Schema,
  evaluation_suite_release_id: UuidV1Schema,
  dataset_release_id: UuidV1Schema,
  dataset_hash: Sha256HexV1Schema,
  evaluator_pins: z
    .array(EvaluationEvaluatorPinV1Schema)
    .min(1)
    .refine(
      (pins) => isSortedUnique(pins.map((pin) => pin.evaluator_id)),
      'evaluator pins must be uniquely sorted by evaluator id',
    ),
  policy: ProductionEvaluationPolicyV1Schema,
  policy_hash: Sha256HexV1Schema,
  suite_hash: Sha256HexV1Schema,
});

const EvaluationRunBaseV1Schema = z
  .strictObject({
    schema_version: z.literal('evaluation-run/1'),
    workspace_id: UuidV1Schema,
    evaluation_run_id: UuidV1Schema,
    evaluation_suite_release_id: UuidV1Schema,
    evaluation_suite_hash: Sha256HexV1Schema,
    candidate_deployment_kind: z.enum(['agent', 'flow']),
    candidate_deployment_id: UuidV1Schema,
    candidate_deployment_revision_id: UuidV1Schema,
    candidate_revision_contract_hash: Sha256HexV1Schema,
    executable_target: EvaluationTargetPinV1Schema,
    dependency_manifest_hash: Sha256HexV1Schema,
    capability_closure_hash: Sha256HexV1Schema,
    strategy_release_id: UuidV1Schema.optional(),
    strategy_contract_hash: Sha256HexV1Schema.optional(),
    flow_plan_hash: Sha256HexV1Schema.optional(),
    model_policy_hash: Sha256HexV1Schema,
    knowledge_generation_ids: z
      .array(NonEmptyStringSchema)
      .refine(isSortedUnique, 'knowledge generation ids must be uniquely sorted'),
    status: z.enum(['QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'INVALIDATED']),
    case_count: NonNegativeIntegerSchema.optional(),
    passed_case_count: NonNegativeIntegerSchema.optional(),
    safety_passed_case_count: NonNegativeIntegerSchema.optional(),
    cost_micredits: NonNegativeIntegerSchema.optional(),
    p95_latency_ms: NonNegativeIntegerSchema.optional(),
    evidence_hash: Sha256HexV1Schema.optional(),
    observed_evidence_epoch_hash: Sha256HexV1Schema.optional(),
    completed_at: z.iso.datetime({ offset: true }).optional(),
    invalidation_reason: NonEmptyStringSchema.optional(),
  })
  .superRefine((run, ctx) => {
    const isAgent = run.candidate_deployment_kind === 'agent';
    if (isAgent !== (run.executable_target.published_resource_kind === 'AGENT_RELEASE')) {
      addCustomIssue(ctx, ['executable_target'], 'target kind must match deployment kind');
    }
    if (
      isAgent
        ? run.strategy_release_id === undefined ||
          run.strategy_contract_hash === undefined ||
          run.flow_plan_hash !== undefined
        : run.flow_plan_hash === undefined ||
          run.strategy_release_id !== undefined ||
          run.strategy_contract_hash !== undefined
    ) {
      addCustomIssue(
        ctx,
        ['candidate_deployment_kind'],
        'candidate-specific plan fields are invalid',
      );
    }

    const resultFields = [
      run.case_count,
      run.passed_case_count,
      run.safety_passed_case_count,
      run.cost_micredits,
      run.p95_latency_ms,
      run.evidence_hash,
      run.observed_evidence_epoch_hash,
      run.completed_at,
    ];
    const isResult = run.status === 'PASSED' || run.status === 'FAILED';
    if (isResult && resultFields.some((value) => value === undefined)) {
      addCustomIssue(
        ctx,
        ['status'],
        'terminal evaluation results require complete metrics and evidence',
      );
    }
    if (
      !isResult &&
      run.status !== 'INVALIDATED' &&
      resultFields.some((value) => value !== undefined)
    ) {
      addCustomIssue(ctx, ['status'], 'nonterminal evaluation runs cannot carry result evidence');
    }
    if (
      run.case_count !== undefined &&
      ((run.passed_case_count ?? 0) > run.case_count ||
        (run.safety_passed_case_count ?? 0) > run.case_count)
    ) {
      addCustomIssue(ctx, ['case_count'], 'passed counts cannot exceed the case count');
    }
    if (
      (run.status === 'INVALIDATED') !== (run.invalidation_reason !== undefined) ||
      (run.status === 'INVALIDATED' && run.completed_at === undefined)
    ) {
      addCustomIssue(
        ctx,
        ['invalidation_reason'],
        'invalidated runs require completion and a reason',
      );
    }
  });

export const EvaluationRunV1Schema = EvaluationRunBaseV1Schema;

export const EvaluationEvidenceBundleV1Schema = z
  .strictObject({
    schema_version: z.literal('evaluation-evidence-bundle/1'),
    workspace_id: UuidV1Schema,
    evaluation_suite_release_id: UuidV1Schema,
    evaluation_suite_hash: Sha256HexV1Schema,
    evaluation_policy_hash: Sha256HexV1Schema,
    evaluation_run_ids: z
      .array(UuidV1Schema)
      .min(1)
      .refine(isSortedUnique, 'evaluation run ids must be uniquely sorted'),
    candidate_deployment_kind: z.enum(['agent', 'flow']),
    candidate_deployment_id: UuidV1Schema,
    candidate_deployment_revision_id: UuidV1Schema,
    candidate_revision_contract_hash: Sha256HexV1Schema,
    executable_target: EvaluationTargetPinV1Schema,
    dependency_manifest_hash: Sha256HexV1Schema,
    capability_closure_hash: Sha256HexV1Schema,
    total_case_count: PositiveIntegerSchema,
    passed_case_count: NonNegativeIntegerSchema,
    safety_passed_case_count: NonNegativeIntegerSchema,
    total_cost_micredits: NonNegativeIntegerSchema,
    p95_latency_ms: NonNegativeIntegerSchema,
    observed_evidence_epoch_hash: Sha256HexV1Schema,
    evidence_bundle_hash: Sha256HexV1Schema,
  })
  .superRefine((bundle, ctx) => {
    if (
      bundle.passed_case_count > bundle.total_case_count ||
      bundle.safety_passed_case_count > bundle.total_case_count
    ) {
      addCustomIssue(ctx, ['total_case_count'], 'passed counts cannot exceed the total case count');
    }
    const targetKind = bundle.executable_target.published_resource_kind;
    if ((bundle.candidate_deployment_kind === 'agent') !== (targetKind === 'AGENT_RELEASE')) {
      addCustomIssue(ctx, ['executable_target'], 'target kind must match deployment kind');
    }
  });

export type ProductionEvaluationPolicyV1 = z.infer<typeof ProductionEvaluationPolicyV1Schema>;
export type EvaluationSuiteReleaseV1 = z.infer<typeof EvaluationSuiteReleaseV1Schema>;
export type EvaluationRunV1 = z.infer<typeof EvaluationRunV1Schema>;
export type EvaluationEvidenceBundleV1 = z.infer<typeof EvaluationEvidenceBundleV1Schema>;
