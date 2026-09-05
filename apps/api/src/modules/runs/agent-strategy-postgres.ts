import {
  type CompiledAgentPlanV1,
  CompiledAgentPlanV1Schema,
  type StrategyCheckpointV1,
  StrategyCheckpointV1Schema,
} from '@better-agent/domain-contracts';
import {
  boundedDataSnapshot,
  canonicalSha256ExcludingRootKeys,
  verifyCompiledAgentPlan,
} from '@better-agent/release-core';

import type { G1SourceSqlQueryClient } from '../releases/g1-source-postgres-readback.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hash = /^sha256:[0-9a-f]{64}$/u;
const verifier = /^[0-9a-f]{64}$/u;
const positive = /^[1-9][0-9]{0,15}$/u;

export interface AgentStrategyLeaseFact {
  readonly run_id: string;
  readonly attempt_id: string;
  readonly lease_token: string;
  readonly lease_fencing_token: string;
}

export interface IssueAgentStrategyPlanAttestationInput {
  readonly attestation_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly agent_strategy_execution_id: string;
  readonly bound_session_user: string;
  readonly compiled_agent_plan: CompiledAgentPlanV1;
  readonly verifier_hex: string;
  readonly expires_at: string;
}

export interface RegisterAgentStrategyExecutionInput extends AgentStrategyLeaseFact {
  readonly agent_strategy_execution_id: string;
  readonly compiled_agent_plan: CompiledAgentPlanV1;
  readonly plan_attestation_id: string;
  readonly plan_attestation_verifier: string;
}

export interface CommitAgentStrategyCheckpointInput extends AgentStrategyLeaseFact {
  readonly agent_strategy_execution_id: string;
  readonly commit_sequence: string;
  readonly checkpoint: StrategyCheckpointV1;
  readonly decision_hash?: string;
  readonly outbox?: Readonly<Record<string, unknown>>;
}

export interface CommitAgentStrategyActionResultInput extends AgentStrategyLeaseFact {
  readonly agent_strategy_execution_id: string;
  readonly commit_sequence: string;
  readonly action_result: Readonly<Record<string, unknown>>;
  readonly checkpoint: StrategyCheckpointV1;
  readonly reservation_id?: string;
  readonly step_id?: string;
  readonly model_usage_receipt?: Readonly<Record<string, unknown>>;
}

type Code = 'INPUT_INVALID' | 'QUERY_FAILED' | 'PROJECTION_INVALID';
export class AgentStrategyPostgresError extends Error {
  constructor(
    readonly code: Code,
    options?: ErrorOptions,
  ) {
    super(
      code === 'INPUT_INVALID'
        ? 'Agent Strategy PostgreSQL adapter rejected the input'
        : code === 'QUERY_FAILED'
          ? 'Agent Strategy PostgreSQL query failed'
          : 'Agent Strategy PostgreSQL projection is invalid',
      options,
    );
    this.name = 'AgentStrategyPostgresError';
  }
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function invalid(cause?: unknown): never {
  throw new AgentStrategyPostgresError('INPUT_INVALID', { cause });
}
function projection(): never {
  throw new AgentStrategyPostgresError('PROJECTION_INVALID');
}
function snapshot<T>(input: T): T {
  try {
    return boundedDataSnapshot(input, 'closure') as T;
  } catch (error) {
    return invalid(error);
  }
}
function validLease(value: Record<string, unknown>) {
  return (
    uuid.test(String(value.run_id)) &&
    uuid.test(String(value.attempt_id)) &&
    uuid.test(String(value.lease_token)) &&
    typeof value.lease_fencing_token === 'string' &&
    positive.test(value.lease_fencing_token)
  );
}
function parsePlan(value: unknown) {
  const parsed = CompiledAgentPlanV1Schema.safeParse(value);
  if (!parsed.success) invalid(parsed.error);
  try {
    return verifyCompiledAgentPlan(parsed.data, parsed.data.plan_hash);
  } catch (error) {
    return invalid(error);
  }
}
function parseCheckpoint(value: unknown) {
  const parsed = StrategyCheckpointV1Schema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.checkpoint_hash !==
      canonicalSha256ExcludingRootKeys(parsed.data, ['checkpoint_hash'])
  )
    invalid(parsed.success ? undefined : parsed.error);
  return parsed.data;
}
async function queryOne(client: G1SourceSqlQueryClient, sql: string, values: readonly unknown[]) {
  try {
    const { rows } = await client.query(sql, values);
    if (rows.length !== 1) projection();
    return rows[0];
  } catch (error) {
    if (error instanceof AgentStrategyPostgresError) throw error;
    throw new AgentStrategyPostgresError('QUERY_FAILED', { cause: error });
  }
}

export function createAgentStrategyPostgresAdapter(client: G1SourceSqlQueryClient) {
  return Object.freeze({
    async issuePlanAttestation(input: IssueAgentStrategyPlanAttestationInput): Promise<void> {
      const safe = snapshot(input);
      const plan = parsePlan(safe.compiled_agent_plan);
      if (
        !exact(safe, [
          'attestation_id',
          'workspace_id',
          'run_id',
          'agent_strategy_execution_id',
          'bound_session_user',
          'compiled_agent_plan',
          'verifier_hex',
          'expires_at',
        ]) ||
        ![
          safe.attestation_id,
          safe.workspace_id,
          safe.run_id,
          safe.agent_strategy_execution_id,
        ].every((item) => uuid.test(String(item))) ||
        typeof safe.bound_session_user !== 'string' ||
        safe.bound_session_user.trim().length === 0 ||
        safe.bound_session_user.length > 63 ||
        !verifier.test(String(safe.verifier_hex)) ||
        !Number.isFinite(Date.parse(String(safe.expires_at)))
      )
        invalid();
      await queryOne(
        client,
        "SELECT auth.issue_agent_strategy_plan_attestation($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::name,$6::jsonb,decode($7,'hex'),$8::timestamptz) AS issued",
        [
          safe.attestation_id,
          safe.workspace_id,
          safe.run_id,
          safe.agent_strategy_execution_id,
          safe.bound_session_user,
          JSON.stringify(plan),
          safe.verifier_hex,
          safe.expires_at,
        ],
      );
    },

    async registerExecution(input: RegisterAgentStrategyExecutionInput) {
      const safe = snapshot(input);
      const plan = parsePlan(safe.compiled_agent_plan);
      if (
        !exact(safe, [
          'run_id',
          'attempt_id',
          'lease_token',
          'lease_fencing_token',
          'agent_strategy_execution_id',
          'compiled_agent_plan',
          'plan_attestation_id',
          'plan_attestation_verifier',
        ]) ||
        !validLease(safe) ||
        !uuid.test(String(safe.agent_strategy_execution_id)) ||
        !uuid.test(String(safe.plan_attestation_id)) ||
        !verifier.test(String(safe.plan_attestation_verifier))
      )
        invalid();
      const row = await queryOne(
        client,
        'SELECT app.register_agent_strategy_execution($1::jsonb) AS result',
        [JSON.stringify({ ...safe, compiled_agent_plan: plan })],
      );
      if (
        !exact(row, ['result']) ||
        !exact(row.result, [
          'schema_version',
          'agent_strategy_execution_id',
          'compiled_agent_plan_hash',
          'replayed',
        ]) ||
        row.result.schema_version !== 'agent-strategy-execution-registration-result/1' ||
        row.result.agent_strategy_execution_id !== safe.agent_strategy_execution_id ||
        row.result.compiled_agent_plan_hash !== plan.plan_hash ||
        typeof row.result.replayed !== 'boolean'
      )
        projection();
      return row.result;
    },

    async commitCheckpoint(input: CommitAgentStrategyCheckpointInput) {
      const safe = snapshot(input);
      const keys = [
        'run_id',
        'attempt_id',
        'lease_token',
        'lease_fencing_token',
        'agent_strategy_execution_id',
        'commit_sequence',
        'checkpoint',
        ...(safe.decision_hash === undefined ? [] : ['decision_hash']),
        ...(safe.outbox === undefined ? [] : ['outbox']),
      ];
      const checkpoint = parseCheckpoint(safe.checkpoint);
      if (
        !exact(safe, keys) ||
        !validLease(safe) ||
        !uuid.test(String(safe.agent_strategy_execution_id)) ||
        !positive.test(String(safe.commit_sequence)) ||
        (safe.decision_hash === undefined) !== (safe.outbox === undefined) ||
        (safe.decision_hash !== undefined && !hash.test(safe.decision_hash))
      )
        invalid();
      const row = await queryOne(
        client,
        'SELECT app.commit_agent_strategy_checkpoint($1::jsonb) AS result',
        [JSON.stringify({ ...safe, checkpoint })],
      );
      if (
        !exact(row, ['result']) ||
        !exact(row.result, ['schema_version', 'checkpoint', 'replayed']) ||
        row.result.schema_version !== 'agent-strategy-checkpoint-commit-result/1' ||
        typeof row.result.replayed !== 'boolean'
      )
        projection();
      const projected = parseCheckpoint(row.result.checkpoint);
      if (projected.checkpoint_hash !== checkpoint.checkpoint_hash) projection();
      return row.result;
    },

    async commitActionResult(input: CommitAgentStrategyActionResultInput) {
      const safe = snapshot(input);
      const optional = ['reservation_id', 'step_id', 'model_usage_receipt'].filter(
        (key) => safe[key as keyof typeof safe] !== undefined,
      );
      const checkpoint = parseCheckpoint(safe.checkpoint);
      const result = safe.action_result;
      const baseResultKeys = [
        'schema_version',
        'operation_id',
        'action_kind',
        'completion_id',
        'status',
      ];
      const resultKeys =
        result.status === 'SUCCEEDED'
          ? [...baseResultKeys, 'observation_hash', 'observation_ref', 'receipt_hash']
          : result.status === 'FAILED'
            ? [...baseResultKeys, 'safe_error']
            : baseResultKeys;
      if (
        !exact(safe, [
          'run_id',
          'attempt_id',
          'lease_token',
          'lease_fencing_token',
          'agent_strategy_execution_id',
          'commit_sequence',
          'action_result',
          'checkpoint',
          ...optional,
        ]) ||
        !validLease(safe) ||
        !uuid.test(String(safe.agent_strategy_execution_id)) ||
        !positive.test(String(safe.commit_sequence)) ||
        !exact(result, resultKeys) ||
        result.schema_version !== 'strategy-action-result/1' ||
        !hash.test(String(result.operation_id)) ||
        !['model', 'capability', 'instruction_skill'].includes(String(result.action_kind)) ||
        !['SUCCEEDED', 'FAILED', 'OUTCOME_UNKNOWN'].includes(String(result.status)) ||
        (result.action_kind === 'instruction_skill' && result.status === 'OUTCOME_UNKNOWN') ||
        (safe.reservation_id !== undefined && !uuid.test(String(safe.reservation_id))) ||
        (safe.step_id !== undefined && !uuid.test(String(safe.step_id)))
      )
        invalid();
      const row = await queryOne(
        client,
        'SELECT app.commit_agent_strategy_action_result($1::jsonb) AS result',
        [JSON.stringify({ ...safe, checkpoint })],
      );
      if (
        !exact(row, ['result']) ||
        !exact(row.result, ['schema_version', 'result', 'checkpoint_hash', 'replayed']) ||
        row.result.schema_version !== 'agent-strategy-action-result-commit/1' ||
        row.result.checkpoint_hash !== checkpoint.checkpoint_hash ||
        typeof row.result.replayed !== 'boolean'
      )
        projection();
      return row.result;
    },
  });
}
