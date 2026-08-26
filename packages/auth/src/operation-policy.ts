import { createHash } from 'node:crypto';

import {
  credentialOperationPolicyRegistrySchemaVersion,
  getReviewedServiceCredentialOperation,
  serviceCredentialOperationIds,
  type ServiceCredentialOperationId as GeneratedServiceCredentialOperationId,
} from '@better-agent/api-contract/credential-operation-policy-registry.js';
import {
  type CredentialKindV1,
  type CredentialOperationPolicyV1,
  CredentialOperationPolicyV1Schema,
  type InboundCredentialScopeV1,
} from '@better-agent/domain-contracts';

import { AuthorizationBoundaryError } from './errors.js';

export type ServiceCredentialOperationId = GeneratedServiceCredentialOperationId;

export const ServiceCredentialOperationIds = serviceCredentialOperationIds;

export type ReviewedHttpMethod =
  | 'DELETE'
  | 'GET'
  | 'HEAD'
  | 'OPTIONS'
  | 'PATCH'
  | 'POST'
  | 'PUT'
  | 'TRACE';

const reviewedRouteBrand: unique symbol = Symbol('better-agent.reviewed-service-route');
const credentialPolicyProofBrand: unique symbol = Symbol('better-agent.credential-policy-proof');

export interface ServiceCredentialRouteBindingInput {
  method: ReviewedHttpMethod;
  operationId: ServiceCredentialOperationId;
  routeTemplate: string;
}

export interface ReviewedServiceCredentialRoute {
  readonly [reviewedRouteBrand]: true;
  readonly method: ReviewedHttpMethod;
  readonly operationId: ServiceCredentialOperationId;
  readonly routeTemplate: string;
}

export interface CredentialAuthorizationFacts {
  credentialKind: CredentialKindV1;
  scopes: readonly InboundCredentialScopeV1[];
}

export interface CredentialPolicyPhasePassed {
  readonly [credentialPolicyProofBrand]: true;
  readonly httpMethod: ReviewedHttpMethod;
  readonly operationId: ServiceCredentialOperationId;
  readonly operationPurpose: CredentialOperationPolicyV1['operation_purpose'];
  readonly policyHash: `cp1.${string}`;
  readonly remainingGate: Readonly<{
    targetCardinality: CredentialOperationPolicyV1['target_cardinality'];
    typedGrantFamily: CredentialOperationPolicyV1['typed_grant_family'];
  }>;
  readonly requiredScopes: readonly InboundCredentialScopeV1[];
  readonly routeTemplate: string;
  readonly status: 'credential_phase_passed';
}

const reviewedRoutePolicies = new WeakMap<object, CredentialOperationPolicyV1>();
const issuedCredentialPolicyProofs = new WeakSet<object>();

class BoundReviewedServiceCredentialRoute implements ReviewedServiceCredentialRoute {
  declare readonly [reviewedRouteBrand]: true;

  constructor(
    readonly method: ReviewedHttpMethod,
    readonly operationId: ServiceCredentialOperationId,
    readonly routeTemplate: string,
  ) {
    Object.defineProperty(this, reviewedRouteBrand, { value: true });
    Object.freeze(this);
  }
}

class IssuedCredentialPolicyPhasePassed implements CredentialPolicyPhasePassed {
  declare readonly [credentialPolicyProofBrand]: true;

  readonly httpMethod: ReviewedHttpMethod;
  readonly operationId: ServiceCredentialOperationId;
  readonly operationPurpose: CredentialOperationPolicyV1['operation_purpose'];
  readonly policyHash: `cp1.${string}`;
  readonly remainingGate: CredentialPolicyPhasePassed['remainingGate'];
  readonly requiredScopes: readonly InboundCredentialScopeV1[];
  readonly routeTemplate: string;
  readonly status = 'credential_phase_passed' as const;

  constructor(route: ReviewedServiceCredentialRoute, policy: CredentialOperationPolicyV1) {
    Object.defineProperty(this, credentialPolicyProofBrand, { value: true });
    this.httpMethod = route.method;
    this.operationId = route.operationId;
    this.operationPurpose = policy.operation_purpose;
    this.policyHash = hashReviewedPolicyBinding(route, policy);
    this.remainingGate = Object.freeze({
      targetCardinality: policy.target_cardinality,
      typedGrantFamily: policy.typed_grant_family,
    });
    this.requiredScopes = Object.freeze([...policy.required_scopes]);
    this.routeTemplate = route.routeTemplate;
    issuedCredentialPolicyProofs.add(this);
    Object.freeze(this);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new AuthorizationBoundaryError('policy_contract');
}

function hashReviewedPolicyBinding(
  route: ReviewedServiceCredentialRoute,
  policy: CredentialOperationPolicyV1,
): `cp1.${string}` {
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        http_method: route.method,
        operation_id: route.operationId,
        policy,
        route_template: route.routeTemplate,
        schema_version: 'reviewed-credential-operation-binding/1',
      }),
      'utf8',
    )
    .digest('base64url');
  return `cp1.${digest}`;
}

export function bindReviewedServiceCredentialRoute(
  input: ServiceCredentialRouteBindingInput,
): ReviewedServiceCredentialRoute {
  const operation = getReviewedServiceCredentialOperation(input.operationId);
  if (
    credentialOperationPolicyRegistrySchemaVersion !== 'openapi-credential-operation-policy/1' ||
    operation === undefined ||
    operation.method !== input.method ||
    operation.path !== input.routeTemplate
  ) {
    throw new AuthorizationBoundaryError('policy_contract');
  }

  const parsed = CredentialOperationPolicyV1Schema.safeParse(operation.policy);
  if (!parsed.success) throw new AuthorizationBoundaryError('policy_contract');

  const route = new BoundReviewedServiceCredentialRoute(
    input.method,
    input.operationId,
    input.routeTemplate,
  );
  reviewedRoutePolicies.set(route, parsed.data);
  return route;
}

export function isCredentialPolicyPhasePassed(
  value: unknown,
): value is CredentialPolicyPhasePassed {
  return typeof value === 'object' && value !== null && issuedCredentialPolicyProofs.has(value);
}

export function evaluateCredentialPolicyPhase(
  route: ReviewedServiceCredentialRoute,
  facts: CredentialAuthorizationFacts,
): CredentialPolicyPhasePassed {
  const policy =
    typeof route === 'object' && route !== null ? reviewedRoutePolicies.get(route) : undefined;
  if (policy === undefined) throw new AuthorizationBoundaryError('policy_contract');

  const grantedScopes = new Set(facts.scopes);
  if (!policy.allowed_kinds.includes(facts.credentialKind)) {
    throw new AuthorizationBoundaryError('credential_kind');
  }
  if (!policy.required_scopes.every((scope) => grantedScopes.has(scope))) {
    throw new AuthorizationBoundaryError('credential_scope');
  }

  // This deliberately cannot return "authorized": G0-05 still has to prove the
  // typed Deployment grant and target cardinality in the admission transaction.
  return new IssuedCredentialPolicyPhasePassed(route, policy);
}
