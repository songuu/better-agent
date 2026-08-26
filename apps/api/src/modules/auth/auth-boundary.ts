import {
  AuthorizationBoundaryError,
  bindReviewedServiceCredentialRoute,
  type CredentialPolicyPhasePassed,
  deriveCredentialVerifier,
  evaluateCredentialPolicyPhase,
  inspectSubjectAssertionSelector,
  parseAccessKey,
  type ReviewedServiceCredentialRoute,
  type ServiceCredentialRouteBindingInput,
  SubjectAssertionError,
  type SubjectAssertionTrustConfig,
  verifySubjectAssertion,
} from '@better-agent/auth';
import {
  CallerPrincipalV1Schema,
  type CredentialKindV1,
  CredentialKindV1Schema,
  type InboundCredentialScopeV1,
  InboundCredentialScopeV1Schema,
  type TenantAuthContextV1,
  TenantAuthContextV1Schema,
  UuidV1Schema,
  type VerifiedSubjectAssertionV1,
} from '@better-agent/domain-contracts';

export class AuthBoundaryError extends Error {
  readonly code = 'AUTHENTICATION_FAILED';

  constructor() {
    super('authentication boundary rejected the request');
    this.name = 'AuthBoundaryError';
  }
}

export class AuthContextForbiddenError extends Error {
  constructor(
    readonly code: 'WORKSPACE_FORBIDDEN' | 'BROWSER_ORIGIN_FORBIDDEN' | 'ENDPOINT_SCOPE_FORBIDDEN',
  ) {
    super('request context is forbidden');
    this.name = 'AuthContextForbiddenError';
  }
}

export class AuthRouteBindingError extends Error {
  readonly code = 'AUTH_ROUTE_BINDING_INVALID';

  constructor() {
    super('service route binding does not match the reviewed contract');
    this.name = 'AuthRouteBindingError';
  }
}

export interface AuthenticatedCredentialRecord {
  credentialId: string;
  credentialAuthorizationEpoch: number;
  credentialKind: CredentialKindV1;
  scopes: readonly InboundCredentialScopeV1[];
  workspaceAuthorizationEpoch: number;
  workspaceId: string;
}

export interface ConsumedSubjectAssertionRecord {
  assertionUseId: string;
  principalId: string;
  workspaceId: string;
}

export interface ConsumedSubjectAssertion {
  assertionUseId: string;
  callerPrincipal: Extract<TenantAuthContextV1['caller_principal'], { kind: 'end_user' }>;
  workspaceId: string;
}

export interface AuthDatabaseTransaction {
  authenticateCredential(
    keyId: string,
    verifier: Uint8Array,
  ): Promise<AuthenticatedCredentialRecord | null>;
  consumeSubjectAssertion(
    assertion: VerifiedSubjectAssertionV1,
  ): Promise<ConsumedSubjectAssertionRecord>;
}

export interface SubjectAssertionTrustRegistry {
  get(issuerConfigId: string, keyVersion: number): Promise<SubjectAssertionTrustConfig | null>;
}

export interface AuthBoundaryDependencies {
  accessKeyPepper(): Promise<Uint8Array>;
  assertionIdentityHashKey(workspaceId: string): Promise<Uint8Array>;
  assertionTrustRegistry: SubjectAssertionTrustRegistry;
  now?: () => Date;
}

export interface BoundAuthenticateAccessKeyInput {
  accessKey: string;
  declaredWorkspaceId: string;
  transaction: AuthDatabaseTransaction;
}

export interface AuthenticatedAccessKeyContext {
  credentialKind: CredentialKindV1;
  policyPhase: CredentialPolicyPhasePassed;
  tenantAuthContext: TenantAuthContextV1;
}

export interface AuthenticateAndConsumeBrowserExchangeInput {
  accessKey: string;
  assertion: string;
  declaredWorkspaceId: string;
  expectedOrigin: string;
  transaction: AuthDatabaseTransaction;
}

export interface AuthenticatedBrowserExchangeContext {
  exchangeCredential: AuthenticatedAccessKeyContext;
  subject: ConsumedSubjectAssertion;
}

export interface BoundServiceCredentialAuthenticator {
  authenticateAccessKey(
    input: BoundAuthenticateAccessKeyInput,
  ): Promise<AuthenticatedAccessKeyContext>;
}

export interface AuthBoundary {
  bindServiceRoute(route: ServiceCredentialRouteBindingInput): BoundServiceCredentialAuthenticator;
  authenticateAndConsumeBrowserExchange(
    input: AuthenticateAndConsumeBrowserExchangeInput,
  ): Promise<AuthenticatedBrowserExchangeContext>;
}

interface NormalizedCredentialRecord {
  credentialKind: CredentialKindV1;
  scopes: readonly InboundCredentialScopeV1[];
  tenantAuthContext: TenantAuthContextV1;
}

function normalizeCredentialRecord(
  record: AuthenticatedCredentialRecord,
): NormalizedCredentialRecord {
  const credentialKind = CredentialKindV1Schema.safeParse(record.credentialKind);
  if (!credentialKind.success || !Array.isArray(record.scopes)) throw new AuthBoundaryError();

  const scopes: InboundCredentialScopeV1[] = [];
  for (const scopeInput of record.scopes) {
    const scope = InboundCredentialScopeV1Schema.safeParse(scopeInput);
    if (!scope.success) throw new AuthBoundaryError();
    scopes.push(scope.data);
  }
  if (new Set(scopes).size !== scopes.length) throw new AuthBoundaryError();

  const tenantAuthContext = TenantAuthContextV1Schema.safeParse({
    caller_principal: {
      credential_id: record.credentialId,
      kind: 'credential',
      schema_version: 'caller-principal/1',
    },
    observed_authorization_epochs: {
      credential: record.credentialAuthorizationEpoch,
      workspace: record.workspaceAuthorizationEpoch,
    },
    schema_version: 'tenant-auth-context/1',
    workspace_id: record.workspaceId,
  });
  if (!tenantAuthContext.success) throw new AuthBoundaryError();

  return {
    credentialKind: credentialKind.data,
    scopes: Object.freeze(scopes),
    tenantAuthContext: tenantAuthContext.data,
  };
}

function normalizeConsumedSubject(
  record: ConsumedSubjectAssertionRecord,
  expectedWorkspaceId: string,
): ConsumedSubjectAssertion {
  const prefix = 'end_user:';
  if (!record.principalId.startsWith(prefix) || record.workspaceId !== expectedWorkspaceId) {
    throw new AuthBoundaryError();
  }
  const callerPrincipal = CallerPrincipalV1Schema.safeParse({
    end_user_principal_id: record.principalId.slice(prefix.length),
    kind: 'end_user',
    schema_version: 'caller-principal/1',
  });
  if (
    !callerPrincipal.success ||
    callerPrincipal.data.kind !== 'end_user' ||
    !UuidV1Schema.safeParse(record.assertionUseId).success
  ) {
    throw new AuthBoundaryError();
  }
  return {
    assertionUseId: record.assertionUseId,
    callerPrincipal: callerPrincipal.data,
    workspaceId: record.workspaceId,
  };
}

export function createAuthBoundary(dependencies: AuthBoundaryDependencies): AuthBoundary {
  async function authenticateAccessKey(
    input: BoundAuthenticateAccessKeyInput,
    route: ReviewedServiceCredentialRoute,
  ): Promise<AuthenticatedAccessKeyContext> {
    let parsed: ReturnType<typeof parseAccessKey>;
    try {
      parsed = parseAccessKey(input.accessKey);
    } catch {
      throw new AuthBoundaryError();
    }

    let pepper: Buffer | undefined;
    let verifier: Buffer | undefined;
    let credentialRecord: AuthenticatedCredentialRecord | null;
    try {
      pepper = Buffer.from(await dependencies.accessKeyPepper());
      verifier = deriveCredentialVerifier(parsed.secret, pepper);
      credentialRecord = await input.transaction.authenticateCredential(parsed.keyId, verifier);
    } catch {
      throw new AuthBoundaryError();
    } finally {
      parsed.secret.fill(0);
      pepper?.fill(0);
      verifier?.fill(0);
    }

    if (credentialRecord === null) throw new AuthBoundaryError();
    const credential = normalizeCredentialRecord(credentialRecord);
    if (credential.tenantAuthContext.workspace_id !== input.declaredWorkspaceId) {
      throw new AuthContextForbiddenError('WORKSPACE_FORBIDDEN');
    }

    let policyPhase: CredentialPolicyPhasePassed;
    try {
      policyPhase = evaluateCredentialPolicyPhase(route, {
        credentialKind: credential.credentialKind,
        scopes: credential.scopes,
      });
    } catch (error) {
      if (error instanceof AuthorizationBoundaryError) {
        throw new AuthContextForbiddenError('ENDPOINT_SCOPE_FORBIDDEN');
      }
      throw new AuthBoundaryError();
    }

    return {
      credentialKind: credential.credentialKind,
      policyPhase,
      tenantAuthContext: credential.tenantAuthContext,
    };
  }

  function bindServiceRoute(
    routeInput: ServiceCredentialRouteBindingInput,
  ): BoundServiceCredentialAuthenticator {
    let route: ReviewedServiceCredentialRoute;
    try {
      route = bindReviewedServiceCredentialRoute(routeInput);
    } catch (error) {
      if (error instanceof AuthorizationBoundaryError) throw new AuthRouteBindingError();
      throw error;
    }

    return Object.freeze({
      authenticateAccessKey: (input: BoundAuthenticateAccessKeyInput) =>
        authenticateAccessKey(input, route),
    });
  }

  async function verifyAndConsumeSubjectAssertion(
    input: AuthenticateAndConsumeBrowserExchangeInput,
    credentialContext: AuthenticatedAccessKeyContext,
  ): Promise<ConsumedSubjectAssertion> {
    let selector: ReturnType<typeof inspectSubjectAssertionSelector>;
    try {
      selector = inspectSubjectAssertionSelector(input.assertion);
    } catch {
      throw new AuthBoundaryError();
    }

    let trust: SubjectAssertionTrustConfig | null;
    try {
      trust = await dependencies.assertionTrustRegistry.get(
        selector.issuerConfigId,
        selector.keyVersion,
      );
    } catch {
      throw new AuthBoundaryError();
    }
    if (trust === null || trust.workspaceId !== credentialContext.tenantAuthContext.workspace_id) {
      throw new AuthBoundaryError();
    }

    let identityHashKey: Buffer | undefined;
    try {
      identityHashKey = Buffer.from(await dependencies.assertionIdentityHashKey(trust.workspaceId));
      const verified = verifySubjectAssertion(input.assertion, trust, {
        expectedOrigin: input.expectedOrigin,
        workspaceIdentityHashKey: identityHashKey,
        ...(dependencies.now === undefined ? {} : { now: dependencies.now() }),
      });
      const consumed = await input.transaction.consumeSubjectAssertion(verified);
      return normalizeConsumedSubject(consumed, credentialContext.tenantAuthContext.workspace_id);
    } catch (error) {
      if (error instanceof AuthContextForbiddenError) throw error;
      if (error instanceof SubjectAssertionError && error.reason === 'origin') {
        throw new AuthContextForbiddenError('BROWSER_ORIGIN_FORBIDDEN');
      }
      throw new AuthBoundaryError();
    } finally {
      identityHashKey?.fill(0);
    }
  }

  const browserExchangeAuthenticator = bindServiceRoute({
    method: 'POST',
    operationId: 'exchangeBrowserSession',
    routeTemplate: '/v1/oapi/browser/sessions/exchange',
  });

  return {
    bindServiceRoute,
    async authenticateAndConsumeBrowserExchange(input) {
      const exchangeCredential = await browserExchangeAuthenticator.authenticateAccessKey({
        accessKey: input.accessKey,
        declaredWorkspaceId: input.declaredWorkspaceId,
        transaction: input.transaction,
      });
      const subject = await verifyAndConsumeSubjectAssertion(input, exchangeCredential);
      return { exchangeCredential, subject };
    },
  };
}
