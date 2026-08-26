import {
  AuthorizationBoundaryError,
  bindReviewedServiceCredentialRoute,
  type CredentialPolicyPhasePassed,
  deriveCredentialVerifier,
  evaluateCredentialPolicyPhase,
  parseAccessKey,
  type ReviewedServiceCredentialRoute,
  type ServiceCredentialRouteBindingInput,
} from '@better-agent/auth';
import {
  type CredentialKindV1,
  CredentialKindV1Schema,
  type InboundCredentialScopeV1,
  InboundCredentialScopeV1Schema,
  type TenantAuthContextV1,
  TenantAuthContextV1Schema,
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

export interface AuthDatabaseTransaction {
  authenticateCredential(
    keyId: string,
    verifier: Uint8Array,
  ): Promise<AuthenticatedCredentialRecord | null>;
}

export interface AuthBoundaryDependencies {
  accessKeyPepper(): Promise<Uint8Array>;
}

interface ScopedAuthenticateAccessKeyInput {
  accessKey: string;
  declaredWorkspaceId: string;
  transaction: AuthDatabaseTransaction;
}

export interface AuthenticatedAccessKeyContext {
  credentialKind: CredentialKindV1;
  policyPhase: CredentialPolicyPhasePassed;
  tenantAuthContext: TenantAuthContextV1;
}

interface BoundServiceCredentialAuthenticator {
  authenticateAccessKey(
    input: ScopedAuthenticateAccessKeyInput,
  ): Promise<AuthenticatedAccessKeyContext>;
}

export interface AuthBoundary {
  bindServiceRoute(route: ServiceCredentialRouteBindingInput): BoundServiceCredentialAuthenticator;
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

export function createAuthBoundary(dependencies: AuthBoundaryDependencies): AuthBoundary {
  async function authenticateAccessKey(
    input: ScopedAuthenticateAccessKeyInput,
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
      authenticateAccessKey: (input: ScopedAuthenticateAccessKeyInput) =>
        authenticateAccessKey(input, route),
    });
  }

  return { bindServiceRoute };
}
