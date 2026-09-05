import { describe, expect, it, vi } from 'vitest';

import {
  createHumanGateBoundary,
  type HumanGateBoundaryDependencies,
} from '../src/modules/runs/index.js';

const runId = '018f47f2-c541-7cc6-9292-4a2c35303ee2';
const gateId = '018f47f2-c541-7cc6-9292-4a2c35303ee3';
const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303ee4';
const credentialId = '018f47f2-c541-7cc6-9292-4a2c35303ee5';
const receipt = {
  outcome: 'ACCEPTED' as const,
  receipt: {
    http_status: 202 as const,
    data: { run_id: runId, outcome: 'RUN_RESUMED' },
  },
};

function serviceDependencies() {
  return {
    authorizeResume: vi.fn(async () => ({
      workspaceId,
      authenticatedPrincipal: {
        schema_version: 'conversation-principal/1' as const,
        kind: 'credential' as const,
        credential_id: credentialId,
      },
      browserIdentity: null,
    })),
    resume: vi.fn(async () => receipt),
  } satisfies HumanGateBoundaryDependencies;
}

describe('G1 HumanGate boundary', () => {
  it('derives authority outside caller input and forwards only the closed resume command', async () => {
    const dependencies = serviceDependencies();
    const boundary = createHumanGateBoundary(dependencies);

    await expect(
      boundary.resume({ runId, gateId, idempotencyKey: 'gate-key', action: 'approve' }),
    ).resolves.toEqual(receipt);
    expect(dependencies.resume).toHaveBeenCalledWith({
      workspaceId,
      authenticatedPrincipal: {
        schema_version: 'conversation-principal/1',
        kind: 'credential',
        credential_id: credentialId,
      },
      browserIdentity: null,
      idempotencyKey: 'gate-key',
      runId,
      gateId,
      action: 'approve',
      requiredScope: 'run:resume',
    });
  });

  it('forwards submit input and accepts a verified browser principal snapshot', async () => {
    const endUserPrincipalId = '018f47f2-c541-7cc6-9292-4a2c35303ee6';
    const browserIdentity = {
      workspaceId,
      browserSessionId: '018f47f2-c541-7cc6-9292-4a2c35303ee7',
      endUserPrincipalId,
      agentDeploymentId: '018f47f2-c541-7cc6-9292-4a2c35303ee8',
      sessionAuthorizationEpoch: 1,
      principalAuthorizationEpoch: 2,
      deploymentAuthorizationEpoch: 3,
    };
    const dependencies = {
      authorizeResume: vi.fn(async () => ({
        workspaceId,
        authenticatedPrincipal: {
          schema_version: 'conversation-principal/1' as const,
          kind: 'end_user' as const,
          end_user_principal_id: endUserPrincipalId,
        },
        browserIdentity,
      })),
      resume: vi.fn(async () => receipt),
    } satisfies HumanGateBoundaryDependencies;
    const boundary = createHumanGateBoundary(dependencies);

    await boundary.resume({
      runId,
      gateId,
      idempotencyKey: 'gate-key',
      action: 'submit',
      input: { answer: 'yes' },
    });
    expect(dependencies.resume).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'submit', input: { answer: 'yes' }, browserIdentity }),
    );
  });

  it('rejects open caller authority and malformed authorization before mutation', async () => {
    const dependencies = serviceDependencies();
    const boundary = createHumanGateBoundary(dependencies);
    await expect(
      boundary.resume({
        runId,
        gateId,
        idempotencyKey: 'gate-key',
        action: 'approve',
        principal: { kind: 'credential' },
      } as never),
    ).rejects.toMatchObject({ code: 'RUN_BOUNDARY_INPUT_INVALID' });
    expect(dependencies.authorizeResume).not.toHaveBeenCalled();

    dependencies.authorizeResume.mockResolvedValueOnce({
      workspaceId,
      authenticatedPrincipal: {
        schema_version: 'conversation-principal/1',
        kind: 'credential',
        credential_id: credentialId,
      },
      browserIdentity: {} as never,
    });
    await expect(
      boundary.resume({ runId, gateId, idempotencyKey: 'gate-key', action: 'approve' }),
    ).rejects.toMatchObject({ code: 'RUN_AUTHORIZATION_FAILED' });
    expect(dependencies.resume).not.toHaveBeenCalled();
  });

  it('keeps expiry join-only and rejects malformed intent without invoking dependencies', async () => {
    const dependencies = serviceDependencies();
    const boundary = createHumanGateBoundary(dependencies);
    await expect(boundary.expire({ runId, gateId })).rejects.toMatchObject({
      code: 'RUN_HUMAN_GATE_EXPIRE_UNAVAILABLE',
    });
    await expect(
      boundary.resume({ runId, gateId, idempotencyKey: 'gate-key', action: 'submit' } as never),
    ).rejects.toMatchObject({ code: 'RUN_BOUNDARY_INPUT_INVALID' });
    await expect(
      boundary.resume({
        runId: 'not-a-uuid',
        gateId,
        idempotencyKey: 'gate-key',
        action: 'approve',
      }),
    ).rejects.toMatchObject({ code: 'RUN_BOUNDARY_INPUT_INVALID' });
    expect(dependencies.authorizeResume).not.toHaveBeenCalled();
    expect(boundary).not.toHaveProperty('claim');
    expect(boundary).not.toHaveProperty('decide');
    expect(boundary).not.toHaveProperty('createAttempt');
    expect(boundary).not.toHaveProperty('finalize');
  });
});
