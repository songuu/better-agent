import {
  type CompiledFlowPlanV1,
  CompiledFlowPlanV1Schema,
  type FlowModelUsageReceiptV1,
  FlowModelUsageReceiptV1Schema,
  type FlowStepCheckpointV1,
  FlowStepCheckpointV1Schema,
} from '@better-agent/domain-contracts';
import {
  boundedDataSnapshot,
  canonicalSha256ExcludingRootKeys,
  verifyCompiledFlowPlan,
} from '@better-agent/release-core';

import type { G1SourceSqlQueryClient } from '../releases/g1-source-postgres-readback.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const positiveFencePattern = /^[1-9][0-9]{0,15}$/u;
const verifierPattern = /^[0-9a-f]{64}$/u;

export interface FlowExecutionLeaseFact {
  readonly run_id: string;
  readonly attempt_id: string;
  readonly lease_token: string;
  readonly lease_fencing_token: string;
}

export interface IssueFlowPlanAttestationInput {
  readonly attestation_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly flow_execution_id: string;
  readonly bound_session_user: string;
  readonly compiled_flow_plan: CompiledFlowPlanV1;
  readonly verifier_hex: string;
  readonly expires_at: string;
}

export interface RegisterFlowExecutionInput extends FlowExecutionLeaseFact {
  readonly flow_execution_id: string;
  readonly compiled_flow_plan: CompiledFlowPlanV1;
  readonly plan_attestation_id: string;
  readonly plan_attestation_verifier: string;
}

export interface RecordFlowModelUsageInput extends FlowExecutionLeaseFact {
  readonly reservation_id: string;
  readonly step_id: string;
  readonly receipt: FlowModelUsageReceiptV1;
}

export interface RecordFlowStepCheckpointInput extends FlowExecutionLeaseFact {
  readonly step_id: string;
  readonly checkpoint: FlowStepCheckpointV1;
}

export interface FlowExecutionRegistrationResult {
  readonly schema_version: 'flow-execution-registration-result/1';
  readonly flow_execution_id: string;
  readonly compiled_flow_plan_hash: string;
  readonly replayed: boolean;
}

export interface FlowModelUsageRecordResult {
  readonly schema_version: 'flow-model-usage-record-result/1';
  readonly receipt: FlowModelUsageReceiptV1;
  readonly usage_attribution_id: string;
  readonly replayed: boolean;
}

export interface FlowStepCheckpointRecordResult {
  readonly schema_version: 'flow-step-checkpoint-record-result/1';
  readonly run_checkpoint_id: string;
  readonly checkpoint: FlowStepCheckpointV1;
  readonly replayed: boolean;
}

type FlowExecutionPostgresErrorCode = 'INPUT_INVALID' | 'QUERY_FAILED' | 'PROJECTION_INVALID';

export class FlowExecutionPostgresError extends Error {
  constructor(
    readonly code: FlowExecutionPostgresErrorCode,
    options?: ErrorOptions,
  ) {
    super(
      code === 'INPUT_INVALID'
        ? 'Flow execution PostgreSQL adapter rejected the input'
        : code === 'QUERY_FAILED'
          ? 'Flow execution PostgreSQL query failed'
          : 'Flow execution PostgreSQL projection is invalid',
      options,
    );
    this.name = 'FlowExecutionPostgresError';
  }
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validLease(value: Record<string, unknown>) {
  return (
    uuidPattern.test(String(value.run_id)) &&
    uuidPattern.test(String(value.attempt_id)) &&
    uuidPattern.test(String(value.lease_token)) &&
    typeof value.lease_fencing_token === 'string' &&
    positiveFencePattern.test(value.lease_fencing_token)
  );
}

function snapshot<T>(input: T): T {
  try {
    return boundedDataSnapshot(input, 'closure') as T;
  } catch (error) {
    throw new FlowExecutionPostgresError('INPUT_INVALID', { cause: error });
  }
}

async function queryOne(
  client: G1SourceSqlQueryClient,
  sql: string,
  values: readonly unknown[],
): Promise<unknown> {
  try {
    const { rows } = await client.query(sql, values);
    if (rows.length !== 1) throw new FlowExecutionPostgresError('PROJECTION_INVALID');
    return rows[0];
  } catch (error) {
    if (error instanceof FlowExecutionPostgresError) throw error;
    throw new FlowExecutionPostgresError('QUERY_FAILED', { cause: error });
  }
}

function invalidInput(cause?: unknown): never {
  throw new FlowExecutionPostgresError('INPUT_INVALID', { cause });
}

function projectionInvalid(): never {
  throw new FlowExecutionPostgresError('PROJECTION_INVALID');
}

function parsePlan(input: unknown): CompiledFlowPlanV1 {
  const parsed = CompiledFlowPlanV1Schema.safeParse(input);
  if (!parsed.success) invalidInput(parsed.error);
  try {
    return verifyCompiledFlowPlan(parsed.data, parsed.data.compiled_hash);
  } catch (error) {
    invalidInput(error);
  }
}

export function createFlowExecutionPostgresAdapter(client: G1SourceSqlQueryClient) {
  return Object.freeze({
    async issuePlanAttestation(input: IssueFlowPlanAttestationInput): Promise<void> {
      const safe = snapshot(input);
      const plan = parsePlan(safe.compiled_flow_plan);
      const expiresAt = Date.parse(safe.expires_at);
      if (
        !isExactObject(safe, [
          'attestation_id',
          'workspace_id',
          'run_id',
          'flow_execution_id',
          'bound_session_user',
          'compiled_flow_plan',
          'verifier_hex',
          'expires_at',
        ]) ||
        ![safe.attestation_id, safe.workspace_id, safe.run_id, safe.flow_execution_id].every(
          (value) => typeof value === 'string' && uuidPattern.test(value),
        ) ||
        typeof safe.bound_session_user !== 'string' ||
        safe.bound_session_user.trim().length < 1 ||
        safe.bound_session_user.length > 63 ||
        typeof safe.verifier_hex !== 'string' ||
        !verifierPattern.test(safe.verifier_hex) ||
        !Number.isFinite(expiresAt)
      )
        invalidInput();
      await queryOne(
        client,
        "SELECT auth.issue_flow_execution_plan_attestation($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::name,$6::jsonb,decode($7,'hex'),$8::timestamptz) AS issued",
        [
          safe.attestation_id,
          safe.workspace_id,
          safe.run_id,
          safe.flow_execution_id,
          safe.bound_session_user,
          JSON.stringify(plan),
          safe.verifier_hex,
          safe.expires_at,
        ],
      );
    },

    async registerExecution(
      input: RegisterFlowExecutionInput,
    ): Promise<FlowExecutionRegistrationResult> {
      const safe = snapshot(input);
      const plan = parsePlan(safe.compiled_flow_plan);
      if (
        !isExactObject(safe, [
          'run_id',
          'attempt_id',
          'lease_token',
          'lease_fencing_token',
          'flow_execution_id',
          'compiled_flow_plan',
          'plan_attestation_id',
          'plan_attestation_verifier',
        ]) ||
        !validLease(safe) ||
        !uuidPattern.test(String(safe.flow_execution_id)) ||
        !uuidPattern.test(String(safe.plan_attestation_id)) ||
        !verifierPattern.test(String(safe.plan_attestation_verifier))
      )
        invalidInput();
      const fact = { ...safe, compiled_flow_plan: plan };
      const row = await queryOne(
        client,
        'SELECT app.register_flow_execution($1::jsonb) AS result',
        [JSON.stringify(fact)],
      );
      if (
        !isExactObject(row, ['result']) ||
        !isExactObject(row.result, [
          'schema_version',
          'flow_execution_id',
          'compiled_flow_plan_hash',
          'replayed',
        ]) ||
        row.result.schema_version !== 'flow-execution-registration-result/1' ||
        row.result.flow_execution_id !== safe.flow_execution_id ||
        row.result.compiled_flow_plan_hash !== plan.compiled_hash ||
        typeof row.result.replayed !== 'boolean'
      )
        projectionInvalid();
      return row.result as unknown as FlowExecutionRegistrationResult;
    },

    async recordModelUsage(input: RecordFlowModelUsageInput): Promise<FlowModelUsageRecordResult> {
      const safe = snapshot(input);
      const receipt = FlowModelUsageReceiptV1Schema.safeParse(safe.receipt);
      if (
        !isExactObject(safe, [
          'run_id',
          'attempt_id',
          'lease_token',
          'lease_fencing_token',
          'reservation_id',
          'step_id',
          'receipt',
        ]) ||
        !validLease(safe) ||
        !uuidPattern.test(String(safe.reservation_id)) ||
        !uuidPattern.test(String(safe.step_id)) ||
        !receipt.success
      )
        invalidInput();
      const row = await queryOne(
        client,
        'SELECT app.record_flow_model_usage_receipt($1::jsonb) AS result',
        [JSON.stringify({ ...safe, receipt: receipt.data })],
      );
      if (
        !isExactObject(row, ['result']) ||
        !isExactObject(row.result, [
          'schema_version',
          'receipt',
          'usage_attribution_id',
          'replayed',
        ]) ||
        row.result.schema_version !== 'flow-model-usage-record-result/1' ||
        !uuidPattern.test(String(row.result.usage_attribution_id)) ||
        typeof row.result.replayed !== 'boolean'
      )
        projectionInvalid();
      const projected = FlowModelUsageReceiptV1Schema.safeParse(row.result.receipt);
      if (
        !projected.success ||
        projected.data.receipt_hash !==
          canonicalSha256ExcludingRootKeys(projected.data, ['receipt_hash']) ||
        projected.data.receipt_hash !== receipt.data.receipt_hash ||
        projected.data.model_usage_receipt_id !== receipt.data.model_usage_receipt_id
      )
        projectionInvalid();
      return row.result as unknown as FlowModelUsageRecordResult;
    },

    async recordCheckpoint(
      input: RecordFlowStepCheckpointInput,
    ): Promise<FlowStepCheckpointRecordResult> {
      const safe = snapshot(input);
      const checkpoint = FlowStepCheckpointV1Schema.safeParse(safe.checkpoint);
      if (
        !isExactObject(safe, [
          'run_id',
          'attempt_id',
          'lease_token',
          'lease_fencing_token',
          'step_id',
          'checkpoint',
        ]) ||
        !validLease(safe) ||
        !uuidPattern.test(String(safe.step_id)) ||
        !checkpoint.success
      )
        invalidInput();
      const row = await queryOne(
        client,
        'SELECT app.record_flow_step_checkpoint($1::jsonb) AS result',
        [JSON.stringify({ ...safe, checkpoint: checkpoint.data })],
      );
      if (
        !isExactObject(row, ['result']) ||
        !isExactObject(row.result, [
          'schema_version',
          'run_checkpoint_id',
          'checkpoint',
          'replayed',
        ]) ||
        row.result.schema_version !== 'flow-step-checkpoint-record-result/1' ||
        !uuidPattern.test(String(row.result.run_checkpoint_id)) ||
        typeof row.result.replayed !== 'boolean'
      )
        projectionInvalid();
      const projected = FlowStepCheckpointV1Schema.safeParse(row.result.checkpoint);
      if (
        !projected.success ||
        projected.data.checkpoint_hash !==
          canonicalSha256ExcludingRootKeys(projected.data, ['checkpoint_hash']) ||
        projected.data.checkpoint_hash !== checkpoint.data.checkpoint_hash ||
        projected.data.flow_execution_id !== checkpoint.data.flow_execution_id
      )
        projectionInvalid();
      return row.result as unknown as FlowStepCheckpointRecordResult;
    },
  });
}
