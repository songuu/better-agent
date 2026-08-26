import { formatAccessKey } from '@better-agent/auth';
import { describe, expect, it, vi } from 'vitest';

import {
  AuthBoundaryError,
  AuthContextForbiddenError,
  createAuthBoundary,
} from '../src/modules/auth/index.js';
import type { AuthDatabaseTransaction } from '../src/modules/auth/auth-boundary.js';

const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303ee2';
const credentialId = '018f47f2-c541-7cc6-9292-4a2c35303ee3';
const keyId = '018f47f2-c541-7cc6-9292-4a2c35303ee4';
const createAgentChatRoute = {
  method: 'POST',
  operationId: 'createAgentChatRun',
  routeTemplate: '/v1/oapi/agent/chat',
} as const;

function createTransaction(
  overrides: Partial<AuthDatabaseTransaction> = {},
): AuthDatabaseTransaction {
  return {
    authenticateCredential: vi.fn(async () => ({
      credentialId,
      credentialAuthorizationEpoch: 7,
      credentialKind: 'service_api' as const,
      scopes: ['agent:run:create'] as const,
      workspaceId,
      workspaceAuthorizationEpoch: 11,
    })),
    ...overrides,
  };
}

describe('API auth boundary', () => {
  it('authenticates an Access-Key with a derived verifier but never returns final authorization', async () => {
    const transaction = createTransaction();
    const secret = Buffer.alloc(32, 7);
    const pepper = Buffer.alloc(32, 9);
    const accessKey = formatAccessKey({ keyId, secret });
    const boundary = createAuthBoundary({
      accessKeyPepper: async () => pepper,
    });

    const boundAuthenticator = boundary.bindServiceRoute(createAgentChatRoute);
    const handlerInputWithIgnoredOperation = {
      accessKey,
      declaredWorkspaceId: workspaceId,
      operationId: 'getRun',
      transaction,
    };
    const result = await boundAuthenticator.authenticateAccessKey(handlerInputWithIgnoredOperation);

    expect(result).toMatchObject({
      policyPhase: {
        httpMethod: 'POST',
        operationId: 'createAgentChatRun',
        policyHash: expect.stringMatching(/^cp1\.[A-Za-z0-9_-]{43}$/u),
        requiredScopes: ['agent:run:create'],
        routeTemplate: '/v1/oapi/agent/chat',
        status: 'credential_phase_passed',
      },
      tenantAuthContext: {
        caller_principal: {
          credential_id: credentialId,
          kind: 'credential',
          schema_version: 'caller-principal/1',
        },
        observed_authorization_epochs: { credential: 7, workspace: 11 },
        schema_version: 'tenant-auth-context/1',
        workspace_id: workspaceId,
      },
    });
    expect(result).not.toHaveProperty('authorized');
    expect(transaction.authenticateCredential).toHaveBeenCalledWith(keyId, expect.any(Uint8Array));
    expect(
      (transaction.authenticateCredential as ReturnType<typeof vi.fn>).mock.calls[0]?.[1],
    ).toHaveLength(32);
    expect([...pepper]).toEqual(Array(32).fill(9));
    expect(boundary).not.toHaveProperty('authenticateAndConsumeBrowserExchange');
  });

  it('keeps a cached provider-owned pepper stable across consecutive scoped authentications', async () => {
    const pepper = Buffer.alloc(32, 9);
    const verifiers: number[][] = [];
    const transaction = createTransaction({
      authenticateCredential: vi.fn(async (_keyId, verifier) => {
        verifiers.push([...verifier]);
        return {
          credentialId,
          credentialAuthorizationEpoch: 7,
          credentialKind: 'service_api' as const,
          scopes: ['agent:run:create'] as const,
          workspaceId,
          workspaceAuthorizationEpoch: 11,
        };
      }),
    });
    const authenticator = createAuthBoundary({
      accessKeyPepper: async () => pepper,
    }).bindServiceRoute(createAgentChatRoute);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await authenticator.authenticateAccessKey({
        accessKey: formatAccessKey({ keyId, secret: Buffer.alloc(32, 7) }),
        declaredWorkspaceId: workspaceId,
        transaction,
      });
    }

    expect(verifiers).toHaveLength(2);
    expect(verifiers[1]).toEqual(verifiers[0]);
    expect([...pepper]).toEqual(Array(32).fill(9));
  });

  it('rejects a Workspace-Id mismatch without leaking the Access-Key', async () => {
    const raw = formatAccessKey({ keyId, secret: Buffer.alloc(32, 3) });
    const boundary = createAuthBoundary({
      accessKeyPepper: async () => Buffer.alloc(32, 9),
    });
    try {
      await boundary.bindServiceRoute(createAgentChatRoute).authenticateAccessKey({
        accessKey: raw,
        declaredWorkspaceId: '018f47f2-c541-7cc6-9292-4a2c35303eee',
        transaction: createTransaction(),
      });
      expect.unreachable('authentication should fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthContextForbiddenError);
      expect(error).toEqual(expect.objectContaining({ code: 'WORKSPACE_FORBIDDEN' }));
      expect(String(error)).not.toContain(raw);
    }
  });

  it('normalizes secret-provider and database failures at the boundary', async () => {
    const raw = formatAccessKey({ keyId, secret: Buffer.alloc(32, 4) });
    const boundary = createAuthBoundary({
      accessKeyPepper: async () => {
        throw new Error(`secret provider exposed ${raw}`);
      },
    });

    await expect(
      boundary.bindServiceRoute(createAgentChatRoute).authenticateAccessKey({
        accessKey: raw,
        declaredWorkspaceId: workspaceId,
        transaction: createTransaction(),
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'AUTHENTICATION_FAILED' }));
    try {
      await boundary.bindServiceRoute(createAgentChatRoute).authenticateAccessKey({
        accessKey: raw,
        declaredWorkspaceId: workspaceId,
        transaction: createTransaction(),
      });
    } catch (error) {
      expect(String(error)).not.toContain(raw);
    }

    const databaseBoundary = createAuthBoundary({
      accessKeyPepper: async () => Buffer.alloc(32, 9),
    });
    try {
      await databaseBoundary.bindServiceRoute(createAgentChatRoute).authenticateAccessKey({
        accessKey: raw,
        declaredWorkspaceId: workspaceId,
        transaction: createTransaction({
          authenticateCredential: vi.fn(async () => {
            throw new Error(`database exposed ${raw}`);
          }),
        }),
      });
      expect.unreachable('database failure should reject');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthBoundaryError);
      expect(String(error)).not.toContain(raw);
    }
  });

  it('rejects a valid credential that lacks the reviewed operation scope as a safe 403', async () => {
    const raw = formatAccessKey({ keyId, secret: Buffer.alloc(32, 5) });
    const transaction = createTransaction({
      authenticateCredential: vi.fn(async () => ({
        credentialId,
        credentialAuthorizationEpoch: 7,
        credentialKind: 'service_api' as const,
        scopes: ['agent:conversation:write'] as const,
        workspaceId,
        workspaceAuthorizationEpoch: 11,
      })),
    });
    const boundary = createAuthBoundary({
      accessKeyPepper: async () => Buffer.alloc(32, 9),
    });

    try {
      await boundary.bindServiceRoute(createAgentChatRoute).authenticateAccessKey({
        accessKey: raw,
        declaredWorkspaceId: workspaceId,
        transaction,
      });
      expect.unreachable('policy phase should fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthContextForbiddenError);
      expect(error).toEqual(expect.objectContaining({ code: 'ENDPOINT_SCOPE_FORBIDDEN' }));
      expect(String(error)).not.toContain('agent:run:create');
      expect(String(error)).not.toContain('agent:conversation:write');
    }
  });

  it('rejects malformed database facts before they become a tenant context', async () => {
    const raw = formatAccessKey({ keyId, secret: Buffer.alloc(32, 6) });
    const boundary = createAuthBoundary({
      accessKeyPepper: async () => Buffer.alloc(32, 9),
    });

    await expect(
      boundary.bindServiceRoute(createAgentChatRoute).authenticateAccessKey({
        accessKey: raw,
        declaredWorkspaceId: workspaceId,
        transaction: createTransaction({
          authenticateCredential: vi.fn(async () => ({
            credentialId: 'not-a-uuid',
            credentialAuthorizationEpoch: -1,
            credentialKind: 'service_api' as const,
            scopes: ['agent:run:create'] as const,
            workspaceId,
            workspaceAuthorizationEpoch: 11,
          })),
        }),
      }),
    ).rejects.toBeInstanceOf(AuthBoundaryError);
  });

  it('rejects cross-route operation substitution while binding the router', () => {
    const boundary = createAuthBoundary({
      accessKeyPepper: async () => Buffer.alloc(32, 9),
    });

    expect(() =>
      boundary.bindServiceRoute({
        method: 'GET',
        operationId: 'createAgentChatRun',
        routeTemplate: '/v1/oapi/runs/{run_id}',
      }),
    ).toThrowError(/route binding/i);
  });
});
