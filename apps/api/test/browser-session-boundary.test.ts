import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { formatAccessKey } from '@better-agent/auth';
import { describe, expect, it, vi } from 'vitest';

import { type AuthBoundary, createAuthBoundary } from '../src/modules/auth/index.js';
import {
  BrowserSessionBoundaryError,
  createBrowserSessionBoundary,
} from '../src/modules/deployments/index.js';
import type { BrowserSessionDatabaseTransaction } from '../src/modules/deployments/browser-session-boundary.js';

const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303ee2';
const credentialId = '018f47f2-c541-7cc6-9292-4a2c35303ee3';
const keyId = '018f47f2-c541-7cc6-9292-4a2c35303ee4';
const issuerConfigId = '018f47f2-c541-7cc6-9292-4a2c35303ee5';
const browserSessionId = '018f47f2-c541-7cc6-9292-4a2c35303ee6';
const principalId = '018f47f2-c541-7cc6-9292-4a2c35303ee7';
const nowMilliseconds = 1_788_000_000_000;

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

function createTransaction(
  overrides: Partial<BrowserSessionDatabaseTransaction> = {},
): BrowserSessionDatabaseTransaction {
  return {
    authenticateCredential: vi.fn(async () => ({
      credentialId,
      credentialAuthorizationEpoch: 3,
      credentialKind: 'publish' as const,
      scopes: ['browser-session:exchange'] as const,
      workspaceId,
      workspaceAuthorizationEpoch: 4,
    })),
    exchangeBrowserSubjectAssertionForSession: vi.fn(async (command) => ({
      browserSessionId: command.browserSessionId,
      expiresAt: command.sessionExpiresAt,
      principalId,
      workspaceId,
    })),
    ...overrides,
  };
}

function createFixture(
  authBoundary?: AuthBoundary,
  scopedTransaction: BrowserSessionDatabaseTransaction = createTransaction(),
) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const assertion = signedAssertion(privateKey);
  const issuedSecret = Buffer.alloc(32, 6);
  const identityKey = Buffer.alloc(32, 8);
  const sessionPepper = Buffer.alloc(32, 10);
  const withTransaction = vi.fn(
    async (callback: (transaction: BrowserSessionDatabaseTransaction) => Promise<unknown>) =>
      callback(scopedTransaction),
  ) as unknown as {
    <T>(callback: (transaction: BrowserSessionDatabaseTransaction) => Promise<T>): Promise<T>;
    mock: ReturnType<typeof vi.fn>['mock'];
  };
  const boundary = createBrowserSessionBoundary({
    authBoundary:
      authBoundary ?? createAuthBoundary({ accessKeyPepper: async () => Buffer.alloc(32, 9) }),
    assertionIdentityHashKey: async () => identityKey,
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
    browserSessionPepper: async () => sessionPepper,
    now: () => new Date(nowMilliseconds),
    randomBytes: () => issuedSecret,
    randomUuid: () => browserSessionId,
    sessionTtlSeconds: 120,
    withTransaction,
  });
  return {
    assertion,
    boundary,
    identityKey,
    issuedSecret,
    sessionPepper,
    transaction: scopedTransaction,
    withTransaction,
  };
}

function exchangeInput(assertion: string) {
  return {
    accessKey: formatAccessKey({ keyId, secret: Buffer.alloc(32, 7) }),
    assertion,
    clientChannel: 'WEB_SDK' as const,
    declaredWorkspaceId: workspaceId,
    expectedOrigin: 'https://app.example',
    publicSelector: 'assistant',
  };
}

describe('G0-05 browser-session exchange composition boundary', () => {
  it('verifies the assertion and atomically consumes it while creating the session', async () => {
    let verifierReference: Uint8Array | undefined;
    const transaction = createTransaction({
      exchangeBrowserSubjectAssertionForSession: vi.fn(async (command) => {
        verifierReference = command.sessionVerifier;
        expect(Object.isFrozen(command)).toBe(true);
        expect(Object.isFrozen(command.verifiedAssertion)).toBe(true);
        expect(command).toMatchObject({
          browserSessionId,
          clientChannel: 'WEB_SDK',
          canonicalOrigin: 'https://app.example',
          publicSelector: 'assistant',
          tokenAudience: 'agent_browser_api',
          verifiedAssertion: {
            schema_version: 'verified-subject-assertion/1',
            issuer_config_id: issuerConfigId,
          },
        });
        return {
          browserSessionId: command.browserSessionId,
          expiresAt: command.sessionExpiresAt,
          principalId,
          workspaceId,
        };
      }),
    });
    const { assertion, boundary, identityKey, issuedSecret, sessionPepper, withTransaction } =
      createFixture(undefined, transaction);

    const result = await boundary.exchange(exchangeInput(assertion));

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(transaction.exchangeBrowserSubjectAssertionForSession).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      schema_version: 'browser-session-exchange-receipt/1',
      browser_session_id: browserSessionId,
      access_token: `bs1.${browserSessionId}.${Buffer.alloc(32, 6).toString('base64url')}`,
      expires_at: new Date(nowMilliseconds + 120_000).toISOString(),
    });
    expect(result).not.toHaveProperty('verifiedAssertion');
    expect(result).not.toHaveProperty('sessionVerifier');
    expect(verifierReference).toBeDefined();
    expect([...(verifierReference ?? [])]).toEqual(Array(32).fill(0));
    expect([...issuedSecret]).toEqual(Array(32).fill(0));
    expect([...identityKey]).toEqual(Array(32).fill(8));
    expect([...sessionPepper]).toEqual(Array(32).fill(10));
  });

  it('keeps cached provider-owned identity and session keys stable across exchanges', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const assertions = [signedAssertion(privateKey), signedAssertion(privateKey)];
    const identityKey = Buffer.alloc(32, 8);
    const sessionPepper = Buffer.alloc(32, 10);
    const sessionIds = [browserSessionId, '018f47f2-c541-7cc6-9292-4a2c35303ee8'];
    const subjectHashes: string[] = [];
    const nonceHashes: string[] = [];
    const verifiers: number[][] = [];
    const transaction = createTransaction({
      exchangeBrowserSubjectAssertionForSession: vi.fn(async (command) => {
        subjectHashes.push(command.verifiedAssertion.subject_hash);
        nonceHashes.push(command.verifiedAssertion.nonce_hash);
        verifiers.push([...command.sessionVerifier]);
        return {
          browserSessionId: command.browserSessionId,
          expiresAt: command.sessionExpiresAt,
          principalId,
          workspaceId,
        };
      }),
    });
    const withTransaction = vi.fn(
      async (
        callback: (scopedTransaction: BrowserSessionDatabaseTransaction) => Promise<unknown>,
      ) => callback(transaction),
    ) as unknown as {
      <T>(
        callback: (scopedTransaction: BrowserSessionDatabaseTransaction) => Promise<T>,
      ): Promise<T>;
      mock: ReturnType<typeof vi.fn>['mock'];
    };
    const boundary = createBrowserSessionBoundary({
      authBoundary: createAuthBoundary({ accessKeyPepper: async () => Buffer.alloc(32, 9) }),
      assertionIdentityHashKey: async () => identityKey,
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
      browserSessionPepper: async () => sessionPepper,
      now: () => new Date(nowMilliseconds),
      randomBytes: () => Buffer.alloc(32, 6),
      randomUuid: () => sessionIds.shift() ?? browserSessionId,
      sessionTtlSeconds: 120,
      withTransaction,
    });

    for (const assertion of assertions) {
      await boundary.exchange(exchangeInput(assertion));
    }

    expect(withTransaction).toHaveBeenCalledTimes(2);
    expect(subjectHashes[1]).toBe(subjectHashes[0]);
    expect(nonceHashes[1]).not.toBe(nonceHashes[0]);
    expect(verifiers[1]).toEqual(verifiers[0]);
    expect([...identityKey]).toEqual(Array(32).fill(8));
    expect([...sessionPepper]).toEqual(Array(32).fill(10));
  });

  it('does not expose a consume-only seam or accept caller transaction and authority fields', async () => {
    const { assertion, boundary, transaction, withTransaction } = createFixture();
    expect(boundary).not.toHaveProperty('consumeSubjectAssertion');
    for (const invalidInput of [
      { ...exchangeInput(assertion), transaction },
      {
        ...exchangeInput(assertion),
        deploymentId: '018f47f2-c541-7cc6-9292-4a2c35303eff',
        principalId,
        revisionId: '018f47f2-c541-7cc6-9292-4a2c35303efd',
      },
    ]) {
      await expect(boundary.exchange(invalidInput)).rejects.toEqual(
        expect.objectContaining({ code: 'BROWSER_SESSION_BOUNDARY_INPUT_INVALID' }),
      );
    }
    expect(withTransaction).not.toHaveBeenCalled();
    expect(transaction.authenticateCredential).not.toHaveBeenCalled();
    expect(transaction.exchangeBrowserSubjectAssertionForSession).not.toHaveBeenCalled();
  });

  it('normalizes atomic database failure and clears verifier/secret on failure', async () => {
    let verifierReference: Uint8Array | undefined;
    const rawAccessKey = formatAccessKey({ keyId, secret: Buffer.alloc(32, 7) });
    const transaction = createTransaction({
      exchangeBrowserSubjectAssertionForSession: vi.fn(async (command) => {
        verifierReference = command.sessionVerifier;
        throw new Error(`duplicate assertion leaked ${assertion} ${rawAccessKey}`);
      }),
    });
    const { assertion, boundary, issuedSecret, sessionPepper } = createFixture(
      undefined,
      transaction,
    );

    try {
      await boundary.exchange({
        ...exchangeInput(assertion),
        accessKey: rawAccessKey,
      });
      expect.unreachable('database failure should reject');
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserSessionBoundaryError);
      expect(error).toEqual(expect.objectContaining({ code: 'BROWSER_SESSION_EXCHANGE_FAILED' }));
      expect(String(error)).not.toContain(assertion);
      expect(String(error)).not.toContain(rawAccessKey);
    }
    expect([...(verifierReference ?? [])]).toEqual(Array(32).fill(0));
    expect([...issuedSecret]).toEqual(Array(32).fill(0));
    expect([...sessionPepper]).toEqual(Array(32).fill(10));
  });

  it('rejects a forged publish proof before verifying or exchanging the assertion', async () => {
    const forgedAuthBoundary = {
      bindServiceRoute: () => ({
        authenticateAccessKey: async () => ({
          credentialKind: 'publish',
          policyPhase: {
            httpMethod: 'POST',
            operationId: 'exchangeBrowserSession',
            operationPurpose: 'deployment_publish',
            policyHash: `cp1.${'a'.repeat(43)}`,
            remainingGate: {
              targetCardinality: 'exactly_one_deployment',
              typedGrantFamily: 'agent_deployment_entry_grants',
            },
            requiredScopes: ['browser-session:exchange'],
            routeTemplate: '/v1/oapi/browser/sessions/exchange',
            status: 'credential_phase_passed',
          },
          tenantAuthContext: {
            caller_principal: {
              credential_id: credentialId,
              kind: 'credential',
              schema_version: 'caller-principal/1',
            },
            observed_authorization_epochs: { credential: 3, workspace: 4 },
            schema_version: 'tenant-auth-context/1',
            workspace_id: workspaceId,
          },
        }),
      }),
    } as unknown as AuthBoundary;
    const transaction = createTransaction();
    const { assertion, boundary } = createFixture(forgedAuthBoundary, transaction);

    await expect(boundary.exchange(exchangeInput(assertion))).rejects.toEqual(
      expect.objectContaining({ code: 'BROWSER_SESSION_EXCHANGE_FAILED' }),
    );
    expect(transaction.exchangeBrowserSubjectAssertionForSession).not.toHaveBeenCalled();
  });

  it('delegates duplicate assertion/session rejection to the same atomic exchange method', async () => {
    let exchangeCount = 0;
    const transaction = createTransaction({
      exchangeBrowserSubjectAssertionForSession: vi.fn(async (command) => {
        exchangeCount += 1;
        if (exchangeCount > 1) throw new Error(`duplicate ${assertion}`);
        return {
          browserSessionId: command.browserSessionId,
          expiresAt: command.sessionExpiresAt,
          principalId,
          workspaceId,
        };
      }),
    });
    const { assertion, boundary } = createFixture(undefined, transaction);

    await expect(boundary.exchange(exchangeInput(assertion))).resolves.toMatchObject({
      browser_session_id: browserSessionId,
    });
    await expect(boundary.exchange(exchangeInput(assertion))).rejects.toEqual(
      expect.objectContaining({ code: 'BROWSER_SESSION_EXCHANGE_FAILED' }),
    );
    expect(transaction.exchangeBrowserSubjectAssertionForSession).toHaveBeenCalledTimes(2);
  });

  it('rejects origin mismatch and malformed database receipts without leaking assertion facts', async () => {
    const transaction = createTransaction();
    const { assertion, boundary } = createFixture(undefined, transaction);
    await expect(
      boundary.exchange({
        ...exchangeInput(assertion),
        expectedOrigin: 'https://other.example',
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'BROWSER_ORIGIN_FORBIDDEN' }));
    expect(transaction.exchangeBrowserSubjectAssertionForSession).not.toHaveBeenCalled();

    const badReceipt = createTransaction({
      exchangeBrowserSubjectAssertionForSession: vi.fn(async (command) => ({
        browserSessionId: '018f47f2-c541-7cc6-9292-4a2c35303eff',
        expiresAt: command.sessionExpiresAt,
        principalId,
        workspaceId,
      })),
    });
    const invalidReceiptFixture = createFixture(undefined, badReceipt);
    await expect(
      invalidReceiptFixture.boundary.exchange(exchangeInput(invalidReceiptFixture.assertion)),
    ).rejects.toEqual(expect.objectContaining({ code: 'BROWSER_SESSION_EXCHANGE_FAILED' }));
  });
});
