import {
  type JsonObject,
  JsonObjectSchema,
  RunIdempotencyKeyV1Schema,
  UuidV1Schema,
} from '@better-agent/domain-contracts';
import { prepareCanonicalRunIntent } from '@better-agent/run-core';

import { hasExactKeys, RunBoundaryError } from './run-transaction.js';

export class HumanGateBoundaryError extends Error {
  readonly code = 'RUN_HUMAN_GATE_APPLY_UNAVAILABLE';

  constructor() {
    super('HumanGate mutation is unavailable in G0-06');
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

export interface HumanGateBoundary {
  resume(input: HumanGateResumeInput): Promise<never>;
  expire(input: HumanGateExpireInput): Promise<never>;
}

export function createHumanGateBoundary(): HumanGateBoundary {
  return Object.freeze({
    async resume(input: HumanGateResumeInput) {
      if (
        !hasExactKeys(input, ['action', 'gateId', 'idempotencyKey', 'runId']) &&
        !hasExactKeys(input, ['action', 'gateId', 'idempotencyKey', 'input', 'runId'])
      ) {
        throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
      }
      if (
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
      if (!hasExactKeys(input, expectedKeys)) {
        throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
      }
      try {
        if (input.action === 'submit') {
          const parsedInput = JsonObjectSchema.safeParse(input.input);
          if (!parsedInput.success) throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
          prepareCanonicalRunIntent({
            route: '/v1/oapi/runs/{run_id}/gates/{gate_id}/resume',
            request: {
              run_id: input.runId,
              gate_id: input.gateId,
              action: input.action,
              input: parsedInput.data,
            },
          });
        } else {
          prepareCanonicalRunIntent({
            route: '/v1/oapi/runs/{run_id}/gates/{gate_id}/resume',
            request: { run_id: input.runId, gate_id: input.gateId, action: input.action },
          });
        }
      } catch {
        throw new RunBoundaryError('RUN_BOUNDARY_INPUT_INVALID');
      }
      throw new HumanGateBoundaryError();
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
