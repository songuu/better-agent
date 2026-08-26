import { randomBytes as cryptoRandomBytes, randomUUID } from 'node:crypto';
import {
  deriveBrowserSessionVerifier,
  formatBrowserSessionToken,
  inspectSubjectAssertionSelector,
  isCredentialPolicyPhasePassed,
  SubjectAssertionError,
  type SubjectAssertionTrustConfig,
  verifySubjectAssertion,
} from '@better-agent/auth';
import {
  BrowserClientChannelV1Schema,
  type BrowserClientChannelV1,
  type VerifiedSubjectAssertionV1,
  UuidV1Schema,
} from '@better-agent/domain-contracts';

import type { AuthBoundary, AuthenticatedAccessKeyContext } from '../auth/index.js';
import type { AuthDatabaseTransaction } from '../auth/auth-boundary.js';

export type BrowserSessionBoundaryErrorCode =
  | 'BROWSER_SESSION_BOUNDARY_INPUT_INVALID'
  | 'BROWSER_ORIGIN_FORBIDDEN'
  | 'BROWSER_SESSION_EXCHANGE_FAILED';

export class BrowserSessionBoundaryError extends Error {
  constructor(readonly code: BrowserSessionBoundaryErrorCode) {
    super('browser session boundary rejected the exchange');
    this.name = 'BrowserSessionBoundaryError';
  }
}

interface BrowserSessionExchangeCommand {
  readonly browserSessionId: string;
  readonly sessionVerifier: Uint8Array;
  readonly publicSelector: string;
  readonly clientChannel: BrowserClientChannelV1;
  readonly canonicalOrigin: string;
  readonly tokenAudience: 'agent_browser_api';
  readonly sessionExpiresAt: string;
  readonly verifiedAssertion: VerifiedSubjectAssertionV1;
}

export interface BrowserSessionDatabaseReceipt {
  readonly browserSessionId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly expiresAt: string;
}

export interface BrowserSessionDatabaseTransaction extends AuthDatabaseTransaction {
  exchangeBrowserSubjectAssertionForSession(
    command: BrowserSessionExchangeCommand,
  ): Promise<BrowserSessionDatabaseReceipt>;
}

export interface BrowserSessionTrustRegistry {
  get(issuerConfigId: string, keyVersion: number): Promise<SubjectAssertionTrustConfig | null>;
}

export interface BrowserSessionBoundaryDependencies {
  readonly authBoundary: AuthBoundary;
  assertionIdentityHashKey(workspaceId: string): Promise<Uint8Array>;
  readonly assertionTrustRegistry: BrowserSessionTrustRegistry;
  browserSessionPepper(): Promise<Uint8Array>;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly randomUuid?: () => string;
  readonly sessionTtlSeconds?: number;
  withTransaction<T>(
    callback: (transaction: BrowserSessionDatabaseTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface BrowserSessionExchangeInput {
  readonly accessKey: string;
  readonly assertion: string;
  readonly clientChannel: BrowserClientChannelV1;
  readonly declaredWorkspaceId: string;
  readonly expectedOrigin: string;
  readonly publicSelector: string;
}

export interface BrowserSessionExchangeReceipt {
  readonly schema_version: 'browser-session-exchange-receipt/1';
  readonly browser_session_id: string;
  readonly access_token: string;
  readonly expires_at: string;
}

export interface BrowserSessionBoundary {
  exchange(input: BrowserSessionExchangeInput): Promise<BrowserSessionExchangeReceipt>;
}

const exchangeInputKeys = Object.freeze([
  'accessKey',
  'assertion',
  'clientChannel',
  'declaredWorkspaceId',
  'expectedOrigin',
  'publicSelector',
]);

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function assertInput(input: BrowserSessionExchangeInput): void {
  if (
    !hasExactKeys(input, exchangeInputKeys) ||
    typeof input.accessKey !== 'string' ||
    typeof input.assertion !== 'string' ||
    !BrowserClientChannelV1Schema.safeParse(input.clientChannel).success ||
    typeof input.declaredWorkspaceId !== 'string' ||
    typeof input.expectedOrigin !== 'string' ||
    typeof input.publicSelector !== 'string' ||
    input.publicSelector.length < 1 ||
    input.publicSelector.length > 255
  ) {
    throw new BrowserSessionBoundaryError('BROWSER_SESSION_BOUNDARY_INPUT_INVALID');
  }
}

function isDatabaseReceipt(value: unknown): value is BrowserSessionDatabaseReceipt {
  if (!hasExactKeys(value, ['browserSessionId', 'expiresAt', 'principalId', 'workspaceId'])) {
    return false;
  }
  return (
    typeof value.browserSessionId === 'string' &&
    typeof value.workspaceId === 'string' &&
    typeof value.principalId === 'string' &&
    typeof value.expiresAt === 'string'
  );
}

function clear(bytes: Uint8Array | undefined): void {
  bytes?.fill(0);
}

export function createBrowserSessionBoundary(
  dependencies: BrowserSessionBoundaryDependencies,
): BrowserSessionBoundary {
  const sessionTtlSeconds = dependencies.sessionTtlSeconds ?? 300;
  if (
    !Number.isSafeInteger(sessionTtlSeconds) ||
    sessionTtlSeconds < 1 ||
    sessionTtlSeconds > 900
  ) {
    throw new BrowserSessionBoundaryError('BROWSER_SESSION_BOUNDARY_INPUT_INVALID');
  }

  let exchangeAuthenticator: ReturnType<AuthBoundary['bindServiceRoute']>;
  try {
    exchangeAuthenticator = dependencies.authBoundary.bindServiceRoute({
      method: 'POST',
      operationId: 'exchangeBrowserSession',
      routeTemplate: '/v1/oapi/browser/sessions/exchange',
    });
  } catch {
    throw new BrowserSessionBoundaryError('BROWSER_SESSION_EXCHANGE_FAILED');
  }

  return Object.freeze({
    async exchange(input: BrowserSessionExchangeInput) {
      assertInput(input);
      try {
        return await dependencies.withTransaction(async (transaction) => {
          let credentialContext: AuthenticatedAccessKeyContext;
          try {
            credentialContext = await exchangeAuthenticator.authenticateAccessKey({
              accessKey: input.accessKey,
              declaredWorkspaceId: input.declaredWorkspaceId,
              transaction,
            });
          } catch {
            throw new BrowserSessionBoundaryError('BROWSER_SESSION_EXCHANGE_FAILED');
          }
          const policy = credentialContext.policyPhase;
          if (
            !isCredentialPolicyPhasePassed(policy) ||
            policy.operationId !== 'exchangeBrowserSession' ||
            policy.remainingGate.typedGrantFamily !== 'agent_deployment_entry_grants' ||
            policy.remainingGate.targetCardinality !== 'exactly_one_deployment' ||
            policy.requiredScopes.length !== 1 ||
            policy.requiredScopes[0] !== 'browser-session:exchange' ||
            credentialContext.credentialKind !== 'publish' ||
            credentialContext.tenantAuthContext.caller_principal.kind !== 'credential'
          ) {
            throw new BrowserSessionBoundaryError('BROWSER_SESSION_EXCHANGE_FAILED');
          }

          let selector: ReturnType<typeof inspectSubjectAssertionSelector>;
          try {
            selector = inspectSubjectAssertionSelector(input.assertion);
          } catch {
            throw new BrowserSessionBoundaryError('BROWSER_SESSION_EXCHANGE_FAILED');
          }
          let trust: SubjectAssertionTrustConfig | null;
          try {
            trust = await dependencies.assertionTrustRegistry.get(
              selector.issuerConfigId,
              selector.keyVersion,
            );
          } catch {
            throw new BrowserSessionBoundaryError('BROWSER_SESSION_EXCHANGE_FAILED');
          }
          if (
            trust === null ||
            trust.workspaceId !== credentialContext.tenantAuthContext.workspace_id
          ) {
            throw new BrowserSessionBoundaryError('BROWSER_SESSION_EXCHANGE_FAILED');
          }

          let exchangeNow: Date;
          try {
            exchangeNow = dependencies.now?.() ?? new Date();
            if (!Number.isFinite(exchangeNow.getTime())) throw new Error('invalid exchange clock');
          } catch {
            throw new BrowserSessionBoundaryError('BROWSER_SESSION_EXCHANGE_FAILED');
          }
          let identityKey: Buffer | undefined;
          let verifiedAssertion: VerifiedSubjectAssertionV1;
          try {
            identityKey = Buffer.from(
              await dependencies.assertionIdentityHashKey(trust.workspaceId),
            );
            verifiedAssertion = Object.freeze(
              verifySubjectAssertion(input.assertion, trust, {
                expectedOrigin: input.expectedOrigin,
                workspaceIdentityHashKey: identityKey,
                now: exchangeNow,
              }),
            );
          } catch (error) {
            if (error instanceof SubjectAssertionError && error.reason === 'origin') {
              throw new BrowserSessionBoundaryError('BROWSER_ORIGIN_FORBIDDEN');
            }
            throw new BrowserSessionBoundaryError('BROWSER_SESSION_EXCHANGE_FAILED');
          } finally {
            clear(identityKey);
          }

          const assertionExpiresAt = Date.parse(verifiedAssertion.expires_at);
          const sessionExpiryMilliseconds = Math.min(
            exchangeNow.getTime() + sessionTtlSeconds * 1000,
            assertionExpiresAt,
          );
          if (
            !Number.isFinite(sessionExpiryMilliseconds) ||
            sessionExpiryMilliseconds <= exchangeNow.getTime()
          ) {
            throw new BrowserSessionBoundaryError('BROWSER_SESSION_EXCHANGE_FAILED');
          }
          const sessionExpiresAt = new Date(sessionExpiryMilliseconds).toISOString();
          let browserSessionId: string;
          try {
            browserSessionId = (dependencies.randomUuid ?? randomUUID)();
          } catch {
            throw new BrowserSessionBoundaryError('BROWSER_SESSION_EXCHANGE_FAILED');
          }
          if (!UuidV1Schema.safeParse(browserSessionId).success) {
            throw new BrowserSessionBoundaryError('BROWSER_SESSION_EXCHANGE_FAILED');
          }

          let secretSource: Uint8Array | undefined;
          let secret: Buffer | undefined;
          let pepper: Buffer | undefined;
          let verifier: Buffer | undefined;
          try {
            secretSource = (dependencies.randomBytes ?? cryptoRandomBytes)(32);
            secret = Buffer.from(secretSource);
            if (secret.byteLength !== 32) {
              throw new BrowserSessionBoundaryError('BROWSER_SESSION_EXCHANGE_FAILED');
            }
            pepper = Buffer.from(await dependencies.browserSessionPepper());
            verifier = deriveBrowserSessionVerifier(secret, pepper);
            const token = formatBrowserSessionToken({ browserSessionId, secret });
            const databaseReceipt = await transaction.exchangeBrowserSubjectAssertionForSession(
              Object.freeze({
                browserSessionId,
                sessionVerifier: verifier,
                publicSelector: input.publicSelector,
                clientChannel: input.clientChannel,
                canonicalOrigin: verifiedAssertion.canonical_origin,
                tokenAudience: 'agent_browser_api',
                sessionExpiresAt,
                verifiedAssertion,
              }),
            );
            if (
              !isDatabaseReceipt(databaseReceipt) ||
              databaseReceipt.browserSessionId !== browserSessionId ||
              databaseReceipt.workspaceId !== credentialContext.tenantAuthContext.workspace_id ||
              databaseReceipt.expiresAt !== sessionExpiresAt ||
              !UuidV1Schema.safeParse(databaseReceipt.principalId).success
            ) {
              throw new BrowserSessionBoundaryError('BROWSER_SESSION_EXCHANGE_FAILED');
            }
            return Object.freeze({
              schema_version: 'browser-session-exchange-receipt/1' as const,
              browser_session_id: browserSessionId,
              access_token: token,
              expires_at: sessionExpiresAt,
            });
          } catch {
            throw new BrowserSessionBoundaryError('BROWSER_SESSION_EXCHANGE_FAILED');
          } finally {
            clear(verifier);
            clear(pepper);
            clear(secret);
            clear(secretSource);
          }
        });
      } catch (error) {
        if (error instanceof BrowserSessionBoundaryError) throw error;
        throw new BrowserSessionBoundaryError('BROWSER_SESSION_EXCHANGE_FAILED');
      }
    },
  });
}
