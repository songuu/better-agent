import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { formatAccessKey } from '@better-agent/auth';
import { describe, expect, it, vi } from 'vitest';

import {
  AuthBoundaryError,
  AuthContextForbiddenError,
  type AuthDatabaseTransaction,
  createAuthBoundary,
} from '../src/modules/auth/index.js';

const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303ee2';
const credentialId = '018f47f2-c541-7cc6-9292-4a2c35303ee3';
const keyId = '018f47f2-c541-7cc6-9292-4a2c35303ee4';
const issuerConfigId = '018f47f2-c541-7cc6-9292-4a2c35303ee5';
const assertionUseId = '018f47f2-c541-7cc6-9292-4a2c35303ee6';
const principalId = '018f47f2-c541-7cc6-9292-4a2c35303ee7';
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
    consumeSubjectAssertion: vi.fn(async () => ({
      assertionUseId,
      principalId: `end_user:${principalId}`,
      workspaceId,
    })),
    ...overrides,
  };
}

function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function signedAssertion(privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']): string {
  const header = {
    alg: 'EdDSA',
    kid: `${issuerConfigId}.v1`,
    typ: 'ba-subject-assertion+jwt',
  };
  const payload = {
    aud: 'better-agent:browser-exchange',
    exp: 1_788_000_240,
    iat: 1_788_000_000,
    iss: 'https://host.example/identity',
    issuer_config_id: issuerConfigId,
    key_version: 1,
    nonce: randomBytes(24).toString('base64url'),
    origin: 'https://app.example',
    sub: 'host-user-42',
    version: 'subject-assertion/1',
  };
  const headerSegment = Buffer.from(canonicalJson(header)).toString('base64url');
  const payloadSegment = Buffer.from(canonicalJson(payload)).toString('base64url');
  const input = `${headerSegment}.${payloadSegment}`;
  return `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
}

describe('API auth boundary', () => {
  it('authenticates an Access-Key with a derived verifier but never returns final authorization', async () => {
    const transaction = createTransaction();
    const secret = Buffer.alloc(32, 7);
    const accessKey = formatAccessKey({ keyId, secret });
    const boundary = createAuthBoundary({
      accessKeyPepper: async () => Buffer.alloc(32, 9),
      assertionIdentityHashKey: async () => Buffer.alloc(32, 8),
      assertionTrustRegistry: { get: vi.fn() },
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
  });

  it('rejects a Workspace-Id mismatch without leaking the Access-Key', async () => {
    const raw = formatAccessKey({ keyId, secret: Buffer.alloc(32, 3) });
    const boundary = createAuthBoundary({
      accessKeyPepper: async () => Buffer.alloc(32, 9),
      assertionIdentityHashKey: async () => Buffer.alloc(32, 8),
      assertionTrustRegistry: { get: vi.fn() },
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
      assertionIdentityHashKey: async () => Buffer.alloc(32, 8),
      assertionTrustRegistry: { get: vi.fn() },
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
      assertionIdentityHashKey: async () => Buffer.alloc(32, 8),
      assertionTrustRegistry: { get: vi.fn() },
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
      assertionIdentityHashKey: async () => Buffer.alloc(32, 8),
      assertionTrustRegistry: { get: vi.fn() },
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
      assertionIdentityHashKey: async () => Buffer.alloc(32, 8),
      assertionTrustRegistry: { get: vi.fn() },
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
      assertionIdentityHashKey: async () => Buffer.alloc(32, 8),
      assertionTrustRegistry: { get: vi.fn() },
    });

    expect(() =>
      boundary.bindServiceRoute({
        method: 'GET',
        operationId: 'createAgentChatRun',
        routeTemplate: '/v1/oapi/runs/{run_id}',
      }),
    ).toThrowError(/route binding/i);
  });

  it('authenticates publish exchange, verifies and consumes in one transaction boundary', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const assertion = signedAssertion(privateKey);
    const transaction = createTransaction({
      authenticateCredential: vi.fn(async () => ({
        credentialId,
        credentialAuthorizationEpoch: 3,
        credentialKind: 'publish' as const,
        scopes: ['browser-session:exchange'] as const,
        workspaceId,
        workspaceAuthorizationEpoch: 4,
      })),
    });
    const assertionIdentityHashKey = vi.fn(async () => Buffer.alloc(32, 8));
    const boundary = createAuthBoundary({
      accessKeyPepper: async () => Buffer.alloc(32, 9),
      assertionIdentityHashKey,
      assertionTrustRegistry: {
        get: vi.fn(async () => ({
          audience: 'better-agent:browser-exchange',
          clockSkewSeconds: 30,
          issuer: 'https://host.example/identity',
          issuerConfigId,
          keyVersion: 1,
          maxTtlSeconds: 300,
          publicKey,
          status: 'active' as const,
          workspaceId,
        })),
      },
      now: () => new Date(1_788_000_000_000),
    });

    const result = await boundary.authenticateAndConsumeBrowserExchange({
      accessKey: formatAccessKey({ keyId, secret: Buffer.alloc(32, 7) }),
      assertion,
      declaredWorkspaceId: workspaceId,
      expectedOrigin: 'https://app.example',
      transaction,
    });

    expect(result).toMatchObject({
      exchangeCredential: {
        policyPhase: {
          operationId: 'exchangeBrowserSession',
          status: 'credential_phase_passed',
        },
      },
      subject: {
        assertionUseId,
        callerPrincipal: {
          end_user_principal_id: principalId,
          kind: 'end_user',
          schema_version: 'caller-principal/1',
        },
        workspaceId,
      },
    });
    expect(result).not.toHaveProperty('accessToken');
    expect(assertionIdentityHashKey).toHaveBeenCalledWith(workspaceId);
    expect(transaction.consumeSubjectAssertion).toHaveBeenCalledWith(
      expect.objectContaining({
        issuer_config_id: issuerConfigId,
        subject_hash: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      }),
    );

    await expect(
      boundary.authenticateAndConsumeBrowserExchange({
        accessKey: formatAccessKey({ keyId, secret: Buffer.alloc(32, 7) }),
        assertion,
        declaredWorkspaceId: workspaceId,
        expectedOrigin: 'https://other.example',
        transaction,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'BROWSER_ORIGIN_FORBIDDEN' }));
  });

  it('normalizes assertion registry and database failures without leaking assertion material', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const assertion = signedAssertion(privateKey);
    const boundary = createAuthBoundary({
      accessKeyPepper: async () => Buffer.alloc(32, 9),
      assertionIdentityHashKey: async () => Buffer.alloc(32, 8),
      assertionTrustRegistry: {
        get: vi.fn(async () => {
          throw new Error(`registry exposed ${assertion} host-user-42`);
        }),
      },
    });

    try {
      await boundary.authenticateAndConsumeBrowserExchange({
        accessKey: formatAccessKey({ keyId, secret: Buffer.alloc(32, 7) }),
        assertion,
        declaredWorkspaceId: workspaceId,
        expectedOrigin: 'https://app.example',
        transaction: createTransaction({
          authenticateCredential: vi.fn(async () => ({
            credentialId,
            credentialAuthorizationEpoch: 3,
            credentialKind: 'publish' as const,
            scopes: ['browser-session:exchange'] as const,
            workspaceId,
            workspaceAuthorizationEpoch: 4,
          })),
        }),
      });
      expect.unreachable('registry failure should reject');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthBoundaryError);
      expect(String(error)).not.toContain(assertion);
      expect(String(error)).not.toContain('host-user-42');
    }

    const databaseBoundary = createAuthBoundary({
      accessKeyPepper: async () => Buffer.alloc(32, 9),
      assertionIdentityHashKey: async () => Buffer.alloc(32, 8),
      assertionTrustRegistry: {
        get: vi.fn(async () => ({
          audience: 'better-agent:browser-exchange',
          clockSkewSeconds: 30,
          issuer: 'https://host.example/identity',
          issuerConfigId,
          keyVersion: 1,
          maxTtlSeconds: 300,
          publicKey,
          status: 'active' as const,
          workspaceId,
        })),
      },
      now: () => new Date(1_788_000_000_000),
    });
    try {
      await databaseBoundary.authenticateAndConsumeBrowserExchange({
        accessKey: formatAccessKey({ keyId, secret: Buffer.alloc(32, 7) }),
        assertion,
        declaredWorkspaceId: workspaceId,
        expectedOrigin: 'https://app.example',
        transaction: createTransaction({
          authenticateCredential: vi.fn(async () => ({
            credentialId,
            credentialAuthorizationEpoch: 3,
            credentialKind: 'publish' as const,
            scopes: ['browser-session:exchange'] as const,
            workspaceId,
            workspaceAuthorizationEpoch: 4,
          })),
          consumeSubjectAssertion: vi.fn(async () => {
            throw new Error(`database exposed ${assertion} host-user-42`);
          }),
        }),
      });
      expect.unreachable('assertion database failure should reject');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthBoundaryError);
      expect(String(error)).not.toContain(assertion);
      expect(String(error)).not.toContain('host-user-42');
    }
  });
});
