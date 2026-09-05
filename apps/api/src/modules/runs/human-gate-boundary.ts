import {
  ConversationPrincipalV1Schema,
  type JsonObject,
  JsonObjectSchema,
  RunIdempotencyKeyV1Schema,
  UuidV1Schema,
} from '@better-agent/domain-contracts';
import { prepareCanonicalRunIntent } from '@better-agent/run-core';

import type { ResumeHumanGateCommand, ResumeHumanGateResult } from './human-gate-postgres.js';
import {
  hasExactKeys,
  RunBoundaryError,
  type BrowserSessionIdentityFacts,
} from './run-transaction.js';

export class HumanGateBoundaryError extends Error {
  readonly code = 'RUN_HUMAN_GATE_EXPIRE_UNAVAILABLE';

  constructor() {
    super('HumanGate expiry is owned by the join-only worker');
    this.name = 'HumanGateBoundaryError';
  }
}

export interface HumanGateResumeInput {
  readonly runId: string;
  readonly gateId: string;
  readonly idempotencyKey: string;
  readonly action: 'submit' | 'approve' | 'reject';
  readonly input?: JsonObject;
}

export interface HumanGateExpireInput {
  readonly runId: string;
  readonly gateId: string;
}

export interface HumanGateResumeAuthorization {
  readonly workspaceId: string;
  readonly authenticatedPrincipal: ResumeHumanGateCommand['authenticatedPrincipal'];
  readonly browserIdentity: BrowserSessionIdentityFacts | null;
}

export interface HumanGateBoundaryDependencies {
  authorizeResume(): Promise<HumanGateResumeAuthorization>;
  resume(command: ResumeHumanGateCommand): Promise<ResumeHumanGateResult>;
}

export interface HumanGateBoundary {
  resume(input: HumanGateResumeInput): Promise<ResumeHumanGateResult>;
  expire(input: HumanGateExpireInput): Promise<never>;
}

const dependencyKeys = ['authorizeResume', 'resume'] as const;
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

function parseAuthorization(value: unknown): HumanGateResumeAuthorization {
  if (!hasExactKeys(value, ['authenticatedPrincipal', 'browserIdentity', 'workspaceId'])) {
    throw new RunBoundaryError('RUN_AUTHORIZATION_FAILED');
  }
  const workspaceId = UuidV1Schema.safeParse(value.workspaceId);
  const principal = ConversationPrincipalV1Schema.safeParse(value.authenticatedPrincipal);
  if (!workspaceId.success || !principal.success) {
    throw new RunBoundaryError('RUN_AUTHORIZATION_FAILED');
  }
  if (principal.data.kind === 'credential') {
    if (value.browserIdentity !== null) throw new RunBoundaryError('RUN_AUTHORIZATION_FAILED');
    return {
      workspaceId: workspaceId.data,
      authenticatedPrincipal: principal.data,
      browserIdentity: null,
    };
  }
  if (!hasExactKeys(value.browserIdentity, browserIdentityKeys)) {
    throw new RunBoundaryError('RUN_AUTHORIZATION_FAILED');
  }
  const browser = value.browserIdentity;
  if (
    ![
      browser.workspaceId,
      browser.browserSessionId,
      browser.endUserPrincipalId,
      browser.agentDeploymentId,
    ].every((field) => UuidV1Schema.safeParse(field).success) ||
    !validEpoch(browser.sessionAuthorizationEpoch) ||
    !validEpoch(browser.principalAuthorizationEpoch) ||
    !validEpoch(browser.deploymentAuthorizationEpoch) ||
    browser.workspaceId !== workspaceId.data ||
    browser.endUserPrincipalId !== principal.data.end_user_principal_id
  ) {
    throw new RunBoundaryError('RUN_AUTHORIZATION_FAILED');
  }
  return {
    workspaceId: workspaceId.data,
    authenticatedPrincipal: principal.data,
    browserIdentity: browser as unknown as BrowserSessionIdentityFacts,
  };
}

function validateResumeInput(input: HumanGateResumeInput): JsonObject | undefined {
  if (
    (!hasExactKeys(input, ['action', 'gateId', 'idempotencyKey', 'runId']) &&
      !hasExactKeys(input, ['action', 'gateId', 'idempotencyKey', 'input', 'runId'])) ||
    (input.action !== 'submit' && input.action !== 'approve' && input.action !== 'reject') ||
    !UuidV1Schema.safeParse(input.runId).success ||
    !UuidV1Schema.safeParse(input.gateId).success ||
    !RunIdempotencyKeyV1Schema.safeParse(input.idempotencyKey).success
  ) {
    throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
  }
  const expectedKeys =
    input.action === 'submit'
      ? ['action', 'gateId', 'idempotencyKey', 'input', 'runId']
      : ['action', 'gateId', 'idempotencyKey', 'runId'];
  if (!hasExactKeys(input, expectedKeys)) throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
  const parsedInput =
    input.action === 'submit' ? JsonObjectSchema.safeParse(input.input) : undefined;
  if (parsedInput !== undefined && !parsedInput.success) {
    throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
  }
  try {
    if (input.action === 'submit' && parsedInput?.success === true) {
      prepareCanonicalRunIntent({
        route: '/v1/oapi/runs/{run_id}/gates/{gate_id}/resume',
        request: {
          run_id: input.runId,
          gate_id: input.gateId,
          action: input.action,
          input: parsedInput.data,
        },
      });
    } else if (input.action === 'approve' || input.action === 'reject') {
      prepareCanonicalRunIntent({
        route: '/v1/oapi/runs/{run_id}/gates/{gate_id}/resume',
        request: { run_id: input.runId, gate_id: input.gateId, action: input.action },
      });
    } else {
      throw new Error('unreachable Human Gate action');
    }
  } catch {
    throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
  }
  return parsedInput?.success === true ? parsedInput.data : undefined;
}

export function createHumanGateBoundary(
  dependencies: HumanGateBoundaryDependencies,
): HumanGateBoundary {
  if (
    !hasExactKeys(dependencies, dependencyKeys) ||
    typeof dependencies.authorizeResume !== 'function' ||
    typeof dependencies.resume !== 'function'
  ) {
    throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
  }
  return Object.freeze({
    async resume(input: HumanGateResumeInput) {
      const parsedInput = validateResumeInput(input);
      let authorization: HumanGateResumeAuthorization;
      try {
        authorization = parseAuthorization(await dependencies.authorizeResume());
      } catch (error) {
        if (error instanceof RunBoundaryError) throw error;
        throw new RunBoundaryError('RUN_AUTHORIZATION_FAILED');
      }
      return dependencies.resume({
        workspaceId: authorization.workspaceId,
        authenticatedPrincipal: authorization.authenticatedPrincipal,
        browserIdentity: authorization.browserIdentity,
        idempotencyKey: input.idempotencyKey,
        runId: input.runId,
        gateId: input.gateId,
        action: input.action,
        ...(parsedInput === undefined ? {} : { input: parsedInput }),
        requiredScope: 'run:resume',
      });
    },
    async expire(input: HumanGateExpireInput) {
      if (
        !hasExactKeys(input, ['gateId', 'runId']) ||
        !UuidV1Schema.safeParse(input.runId).success ||
        !UuidV1Schema.safeParse(input.gateId).success
      ) {
        throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
      }
      throw new HumanGateBoundaryError();
    },
  });
}
