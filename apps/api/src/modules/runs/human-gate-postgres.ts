import {
  ConversationPrincipalV1Schema,
  type ConversationPrincipalV1,
  JsonObjectSchema,
  RunIdempotencyKeyV1Schema,
  UuidV1Schema,
} from '@better-agent/domain-contracts';
import { boundedDataSnapshot } from '@better-agent/release-core';

import type { G1SourceSqlQueryClient } from '../releases/g1-source-postgres-readback.js';
import type { BrowserSessionIdentityFacts } from './run-transaction.js';

export interface ResumeHumanGateCommand {
  readonly workspaceId: string;
  readonly authenticatedPrincipal: ConversationPrincipalV1;
  readonly browserIdentity: BrowserSessionIdentityFacts | null;
  readonly idempotencyKey: string;
  readonly runId: string;
  readonly gateId: string;
  readonly action: 'submit' | 'approve' | 'reject';
  readonly input?: Readonly<Record<string, unknown>>;
  readonly requiredScope: 'run:resume';
}

export interface ResumeHumanGateResult {
  readonly outcome: 'ACCEPTED' | 'REPLAY';
  readonly receipt: Readonly<{
    readonly http_status: 202;
    readonly data: Readonly<Record<string, unknown>>;
  }>;
}

type Code = 'INPUT_INVALID' | 'QUERY_FAILED' | 'PROJECTION_INVALID';
export class HumanGatePostgresError extends Error {
  constructor(
    readonly code: Code,
    options?: ErrorOptions,
  ) {
    super(`Human Gate PostgreSQL ${code.toLowerCase().replaceAll('_', ' ')}`, options);
    this.name = 'HumanGatePostgresError';
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
function invalid(): never {
  throw new HumanGatePostgresError('INPUT_INVALID');
}

const browserIdentityKeys = [
  'agentDeploymentId',
  'browserSessionId',
  'deploymentAuthorizationEpoch',
  'endUserPrincipalId',
  'principalAuthorizationEpoch',
  'sessionAuthorizationEpoch',
  'workspaceId',
] as const;

function validEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validBrowserIdentity(
  value: unknown,
  workspaceId: string,
  endUserPrincipalId: string,
): value is BrowserSessionIdentityFacts {
  return (
    exact(value, browserIdentityKeys) &&
    [
      value.workspaceId,
      value.browserSessionId,
      value.endUserPrincipalId,
      value.agentDeploymentId,
    ].every((field) => UuidV1Schema.safeParse(field).success) &&
    validEpoch(value.sessionAuthorizationEpoch) &&
    validEpoch(value.principalAuthorizationEpoch) &&
    validEpoch(value.deploymentAuthorizationEpoch) &&
    value.workspaceId === workspaceId &&
    value.endUserPrincipalId === endUserPrincipalId
  );
}

export function createHumanGatePostgresAdapter(client: G1SourceSqlQueryClient) {
  return Object.freeze({
    async resume(command: ResumeHumanGateCommand) {
      let safe: ResumeHumanGateCommand;
      try {
        safe = boundedDataSnapshot(command, 'closure') as ResumeHumanGateCommand;
      } catch {
        invalid();
      }
      const expected = [
        'workspaceId',
        'authenticatedPrincipal',
        'browserIdentity',
        'idempotencyKey',
        'runId',
        'gateId',
        'action',
        ...(safe.input === undefined ? [] : ['input']),
        'requiredScope',
      ];
      const principal = ConversationPrincipalV1Schema.safeParse(safe.authenticatedPrincipal);
      if (
        !exact(safe, expected) ||
        ![safe.workspaceId, safe.runId, safe.gateId].every(
          (value) => UuidV1Schema.safeParse(value).success,
        ) ||
        !RunIdempotencyKeyV1Schema.safeParse(safe.idempotencyKey).success ||
        !['submit', 'approve', 'reject'].includes(safe.action) ||
        safe.requiredScope !== 'run:resume' ||
        (safe.action === 'submit') !== (safe.input !== undefined) ||
        (safe.input !== undefined && !JsonObjectSchema.safeParse(safe.input).success) ||
        !principal.success ||
        (principal.success && principal.data.kind === 'credential'
          ? safe.browserIdentity !== null
          : !validBrowserIdentity(
              safe.browserIdentity,
              safe.workspaceId,
              principal.success && principal.data.kind === 'end_user'
                ? principal.data.end_user_principal_id
                : '',
            ))
      )
        invalid();
      let rows: readonly unknown[];
      try {
        ({ rows } = await client.query('SELECT app.resume_human_gate($1::jsonb) AS result', [
          JSON.stringify(safe),
        ]));
      } catch (error) {
        throw new HumanGatePostgresError('QUERY_FAILED', { cause: error });
      }
      const row = rows[0];
      if (rows.length !== 1 || !exact(row, ['result']))
        throw new HumanGatePostgresError('PROJECTION_INVALID');
      const result = row.result;
      const data =
        exact(result, ['outcome', 'receipt']) && exact(result.receipt, ['data', 'http_status'])
          ? result.receipt.data
          : undefined;
      const dataKeys =
        exact(data, [
          'accepted_request_id',
          'events_url',
          'operation_url',
          'outcome',
          'run_id',
          'status',
        ]) ||
        exact(data, [
          'accepted_request_id',
          'events_url',
          'operation_url',
          'outcome',
          'pending_action',
          'run_id',
          'status',
        ]);
      if (
        !exact(result, ['outcome', 'receipt']) ||
        !['ACCEPTED', 'REPLAY'].includes(String(result.outcome)) ||
        !exact(result.receipt, ['data', 'http_status']) ||
        result.receipt.http_status !== 202 ||
        !dataKeys ||
        data.run_id !== safe.runId ||
        data.status !== 'RUNNING' ||
        !['NEXT_GATE_WAITING', 'RUN_RESUMED', 'TERMINAL_INTENT_ACCEPTED'].includes(
          String(data.outcome),
        ) ||
        (data.outcome === 'NEXT_GATE_WAITING') !== Object.hasOwn(data, 'pending_action')
      )
        throw new HumanGatePostgresError('PROJECTION_INVALID');
      return result as unknown as ResumeHumanGateResult;
    },
  });
}
