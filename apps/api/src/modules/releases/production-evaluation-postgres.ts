import {
  EvaluationRunV1Schema,
  EvaluationSuiteReleaseV1Schema,
  type EvaluationEvidenceBundleV1,
  type EvaluationRunV1,
  type EvaluationSuiteReleaseV1,
} from '@better-agent/domain-contracts';
import {
  assembleEvaluationEvidenceBundle,
  boundedDataSnapshot,
  prepareEvaluationSuiteRelease,
  prepareProductionPromotionGateKey,
} from '@better-agent/release-core';

import type { G1SourceSqlQueryClient } from './g1-source-postgres-readback.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
type DecisionTargetStatus = 'APPROVED' | 'REJECTED' | 'INVALIDATED';
type EvaluationSqlErrorCode = 'INPUT_INVALID' | 'QUERY_FAILED' | 'RECEIPT_INVALID';

class ProductionEvaluationPostgresError extends Error {
  constructor(
    readonly code: EvaluationSqlErrorCode,
    options?: ErrorOptions,
  ) {
    super(
      code === 'INPUT_INVALID'
        ? 'production evaluation SQL rejected the input'
        : code === 'QUERY_FAILED'
          ? 'production evaluation SQL query failed'
          : 'production evaluation SQL returned an invalid receipt',
      options,
    );
    this.name = 'ProductionEvaluationPostgresError';
  }
}

function input<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ProductionEvaluationPostgresError) throw error;
    throw new ProductionEvaluationPostgresError('INPUT_INVALID', { cause: error });
  }
}

function exactUuid(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new Error('UUID is invalid');
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error('version is invalid');
  return value as number;
}

async function exactReceipt(
  client: G1SourceSqlQueryClient,
  sql: string,
  values: readonly unknown[],
  field: string,
  expected?: string,
): Promise<string> {
  let rows: readonly unknown[];
  try {
    ({ rows } = await client.query(sql, values));
  } catch (error) {
    throw new ProductionEvaluationPostgresError('QUERY_FAILED', { cause: error });
  }
  const row = rows[0];
  if (
    rows.length !== 1 ||
    typeof row !== 'object' ||
    row === null ||
    Array.isArray(row) ||
    Reflect.ownKeys(row).length !== 1 ||
    !Object.hasOwn(row, field) ||
    typeof Reflect.get(row, field) !== 'string' ||
    (expected !== undefined && Reflect.get(row, field) !== expected)
  ) {
    throw new ProductionEvaluationPostgresError('RECEIPT_INVALID');
  }
  return Reflect.get(row, field) as string;
}

export function createProductionEvaluationPostgres(client: G1SourceSqlQueryClient) {
  return Object.freeze({
    async registerSuite(draft: unknown): Promise<Readonly<EvaluationSuiteReleaseV1>> {
      const suite = input(() =>
        prepareEvaluationSuiteRelease(boundedDataSnapshot(draft, 'closure') as never),
      );
      await exactReceipt(
        client,
        'SELECT app.register_evaluation_suite_release($1::jsonb) AS evaluation_suite_release_id',
        [JSON.stringify(suite)],
        'evaluation_suite_release_id',
        suite.evaluation_suite_release_id,
      );
      return suite;
    },

    async registerRun(runInput: unknown): Promise<Readonly<EvaluationRunV1>> {
      const run = input(() =>
        EvaluationRunV1Schema.parse(boundedDataSnapshot(runInput, 'closure')),
      );
      await exactReceipt(
        client,
        'SELECT app.register_evaluation_run($1::jsonb) AS evaluation_run_id',
        [JSON.stringify(run)],
        'evaluation_run_id',
        run.evaluation_run_id,
      );
      return run;
    },

    async registerEvidence(
      suiteInput: unknown,
      runInputs: readonly unknown[],
    ): Promise<Readonly<EvaluationEvidenceBundleV1>> {
      const bundle = input(() => {
        const suite = EvaluationSuiteReleaseV1Schema.parse(
          boundedDataSnapshot(suiteInput, 'closure'),
        );
        const runs = boundedDataSnapshot(runInputs, 'closure') as readonly unknown[];
        return assembleEvaluationEvidenceBundle(suite, runs);
      });
      await exactReceipt(
        client,
        'SELECT app.register_evaluation_evidence_bundle($1::jsonb) AS evidence_bundle_hash',
        [JSON.stringify(bundle)],
        'evidence_bundle_hash',
        bundle.evidence_bundle_hash,
      );
      return bundle;
    },

    async createDecision(
      decisionIdInput: unknown,
      bundleInput: unknown,
      expectedActivationEpochInput: unknown,
      expiresAtInput: unknown,
    ) {
      const prepared = input(() => {
        const decisionId = exactUuid(decisionIdInput);
        if (
          !Number.isSafeInteger(expectedActivationEpochInput) ||
          (expectedActivationEpochInput as number) < 0
        ) {
          throw new Error('activation epoch is invalid');
        }
        if (typeof expiresAtInput !== 'string' || Number.isNaN(Date.parse(expiresAtInput))) {
          throw new Error('expiry is invalid');
        }
        return {
          decisionId,
          expiresAt: expiresAtInput,
          ...prepareProductionPromotionGateKey(bundleInput, expectedActivationEpochInput as number),
        };
      });
      await exactReceipt(
        client,
        'SELECT app.create_production_promotion_decision($1::uuid,$2::jsonb,$3::text,$4::timestamptz) AS decision_id',
        [prepared.decisionId, JSON.stringify(prepared.key), prepared.key_hash, prepared.expiresAt],
        'decision_id',
        prepared.decisionId,
      );
      return Object.freeze({
        decision_id: prepared.decisionId,
        key: prepared.key,
        key_hash: prepared.key_hash,
      });
    },

    async transitionDecision(
      workspaceIdInput: unknown,
      decisionIdInput: unknown,
      expectedVersionInput: unknown,
      targetStatusInput: unknown,
      reasonInput: unknown,
    ): Promise<number> {
      const request = input(() => {
        const targetStatus = targetStatusInput as DecisionTargetStatus;
        if (!['APPROVED', 'REJECTED', 'INVALIDATED'].includes(targetStatus))
          throw new Error('status is invalid');
        if (typeof reasonInput !== 'string' || reasonInput.trim().length === 0)
          throw new Error('reason is invalid');
        return {
          workspaceId: exactUuid(workspaceIdInput),
          decisionId: exactUuid(decisionIdInput),
          version: positiveInteger(expectedVersionInput),
          targetStatus,
          reason: reasonInput,
        };
      });
      const receipt = await exactReceipt(
        client,
        'SELECT app.transition_production_promotion_decision($1::uuid,$2::uuid,$3::bigint,$4::text,$5::text)::text AS decision_version',
        [
          request.workspaceId,
          request.decisionId,
          request.version,
          request.targetStatus,
          request.reason,
        ],
        'decision_version',
      );
      return positiveInteger(Number(receipt));
    },

    async consumeDecision(
      decisionIdInput: unknown,
      expectedVersionInput: unknown,
      reasonInput: unknown,
    ): Promise<number> {
      const request = input(() => {
        if (typeof reasonInput !== 'string' || reasonInput.trim().length === 0)
          throw new Error('reason is invalid');
        return {
          decisionId: exactUuid(decisionIdInput),
          version: positiveInteger(expectedVersionInput),
          reason: reasonInput,
        };
      });
      const receipt = await exactReceipt(
        client,
        'SELECT app.consume_production_promotion_decision($1::uuid,$2::bigint,$3::text)::text AS activation_epoch',
        [request.decisionId, request.version, request.reason],
        'activation_epoch',
      );
      return positiveInteger(Number(receipt));
    },
  });
}
