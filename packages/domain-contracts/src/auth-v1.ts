import { z } from 'zod';

import { NonEmptyStringSchema, NonNegativeIntegerSchema } from './primitives.js';

export const CredentialKindsV1 = [
  'service_api',
  'publish',
  'webhook',
  'mcp',
  'permission_callback',
] as const;
export const CredentialKindV1Schema = z.enum(CredentialKindsV1);
export const CredentialKindSchema = CredentialKindV1Schema;
export type CredentialKindV1 = z.infer<typeof CredentialKindV1Schema>;
export type CredentialKind = CredentialKindV1;

export const InboundCredentialScopesV1 = [
  'browser-session:exchange',
  'agent:conversation:write',
  'agent:conversation:read',
  'agent:run:create',
  'flow:run:create',
  'run:read',
  'run:cancel',
  'run:resume',
  'run:events:read',
] as const;
export const InboundCredentialScopeV1Schema = z.enum(InboundCredentialScopesV1);
export const InboundCredentialScopeSchema = InboundCredentialScopeV1Schema;
export type InboundCredentialScopeV1 = z.infer<typeof InboundCredentialScopeV1Schema>;
export type InboundCredentialScope = InboundCredentialScopeV1;

export const UuidV1Schema = z.string().uuid();
const IdentityHashV1Schema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u, 'expected a canonical 32-byte base64url identity hash');

const CredentialCallerPrincipalV1Schema = z.strictObject({
  schema_version: z.literal('caller-principal/1'),
  kind: z.literal('credential'),
  credential_id: UuidV1Schema,
});

const UserCallerPrincipalV1Schema = z.strictObject({
  schema_version: z.literal('caller-principal/1'),
  kind: z.literal('user'),
  user_id: UuidV1Schema,
});

const EndUserCallerPrincipalV1Schema = z.strictObject({
  schema_version: z.literal('caller-principal/1'),
  kind: z.literal('end_user'),
  end_user_principal_id: UuidV1Schema,
});

export const CallerPrincipalV1Schema = z.discriminatedUnion('kind', [
  CredentialCallerPrincipalV1Schema,
  UserCallerPrincipalV1Schema,
  EndUserCallerPrincipalV1Schema,
]);
export const CallerPrincipalSchema = CallerPrincipalV1Schema;
export type CallerPrincipalV1 = z.infer<typeof CallerPrincipalV1Schema>;
export type CallerPrincipal = CallerPrincipalV1;

const CanonicalHttpsOriginV1Schema = z.string().superRefine((value, ctx) => {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== '/' ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      parsed.origin !== value
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'expected a canonical RFC 6454 HTTPS origin',
      });
    }
  } catch {
    ctx.addIssue({ code: 'custom', message: 'expected a canonical RFC 6454 HTTPS origin' });
  }
});

export const VerifiedSubjectAssertionV1Schema = z
  .strictObject({
    schema_version: z.literal('verified-subject-assertion/1'),
    signature_profile: z.literal('jws-eddsa/1'),
    issuer_config_id: UuidV1Schema,
    issuer: NonEmptyStringSchema,
    audience: NonEmptyStringSchema,
    subject_hash: IdentityHashV1Schema,
    nonce_hash: IdentityHashV1Schema,
    issued_at: z.iso.datetime({ offset: true }),
    expires_at: z.iso.datetime({ offset: true }),
    canonical_origin: CanonicalHttpsOriginV1Schema,
    key_version: z.number().int().positive(),
  })
  .superRefine((assertion, ctx) => {
    const issuedAt = Date.parse(assertion.issued_at);
    const expiresAt = Date.parse(assertion.expires_at);
    if (expiresAt <= issuedAt) {
      ctx.addIssue({
        code: 'custom',
        message: 'verified assertion expires_at must be later than issued_at',
        path: ['expires_at'],
      });
    } else if (expiresAt - issuedAt > 300_000) {
      ctx.addIssue({
        code: 'custom',
        message: 'assertion TTL must not exceed 300 seconds',
        path: ['expires_at'],
      });
    }
  });
export const VerifiedSubjectAssertionSchema = VerifiedSubjectAssertionV1Schema;
export type VerifiedSubjectAssertionV1 = z.infer<typeof VerifiedSubjectAssertionV1Schema>;
export type VerifiedSubjectAssertion = VerifiedSubjectAssertionV1;

export const TenantAuthContextV1Schema = z.strictObject({
  schema_version: z.literal('tenant-auth-context/1'),
  workspace_id: UuidV1Schema,
  caller_principal: CallerPrincipalV1Schema,
  observed_authorization_epochs: z.strictObject({
    workspace: NonNegativeIntegerSchema,
    credential: NonNegativeIntegerSchema,
  }),
});
export const TenantAuthContextSchema = TenantAuthContextV1Schema;
export type TenantAuthContextV1 = z.infer<typeof TenantAuthContextV1Schema>;
export type TenantAuthContext = TenantAuthContextV1;

export interface CredentialOperationPolicyV1 {
  readonly schema_version: 'credential-operation-policy/1';
  readonly operation_purpose:
    | 'deployment_publish'
    | 'agent_invoke'
    | 'flow_invoke'
    | 'run_read'
    | 'run_cancel'
    | 'run_resume'
    | 'run_events_read';
  readonly allowed_kinds: readonly CredentialKindV1[];
  readonly required_scopes: readonly InboundCredentialScopeV1[];
  readonly typed_grant_family:
    | 'agent_deployment_entry_grants'
    | 'flow_deployment_entry_grants'
    | 'original_run_entry_grant';
  readonly allowed_original_run_target_kinds?: readonly ('agent' | 'flow')[];
  readonly target_cardinality: 'exactly_one_deployment' | 'exactly_one_flow' | 'original_run_only';
}

const AgentInvokePolicyV1Schema = z.strictObject({
  schema_version: z.literal('credential-operation-policy/1'),
  operation_purpose: z.literal('agent_invoke'),
  allowed_kinds: z.tuple([z.literal('service_api')]),
  required_scopes: z.tuple([
    z.enum(['agent:conversation:write', 'agent:conversation:read', 'agent:run:create']),
  ]),
  typed_grant_family: z.literal('agent_deployment_entry_grants'),
  target_cardinality: z.literal('exactly_one_deployment'),
});

const OriginalRunPolicyV1Schema = (
  operationPurpose: 'run_read' | 'run_cancel' | 'run_resume' | 'run_events_read',
  scope: 'run:read' | 'run:cancel' | 'run:resume' | 'run:events:read',
) =>
  z.strictObject({
    schema_version: z.literal('credential-operation-policy/1'),
    operation_purpose: z.literal(operationPurpose),
    allowed_kinds: z.tuple([z.literal('service_api')]),
    required_scopes: z.tuple([z.literal(scope)]),
    typed_grant_family: z.literal('original_run_entry_grant'),
    allowed_original_run_target_kinds: z.tuple([z.literal('agent'), z.literal('flow')]),
    target_cardinality: z.literal('original_run_only'),
  });

const CredentialOperationPolicyV1ExactSchema = z.discriminatedUnion('operation_purpose', [
  z.strictObject({
    schema_version: z.literal('credential-operation-policy/1'),
    operation_purpose: z.literal('deployment_publish'),
    allowed_kinds: z.tuple([z.literal('publish')]),
    required_scopes: z.tuple([z.literal('browser-session:exchange')]),
    typed_grant_family: z.literal('agent_deployment_entry_grants'),
    target_cardinality: z.literal('exactly_one_deployment'),
  }),
  AgentInvokePolicyV1Schema,
  z.strictObject({
    schema_version: z.literal('credential-operation-policy/1'),
    operation_purpose: z.literal('flow_invoke'),
    allowed_kinds: z.tuple([z.literal('service_api')]),
    required_scopes: z.tuple([z.literal('flow:run:create')]),
    typed_grant_family: z.literal('flow_deployment_entry_grants'),
    target_cardinality: z.literal('exactly_one_flow'),
  }),
  OriginalRunPolicyV1Schema('run_read', 'run:read'),
  OriginalRunPolicyV1Schema('run_cancel', 'run:cancel'),
  OriginalRunPolicyV1Schema('run_resume', 'run:resume'),
  OriginalRunPolicyV1Schema('run_events_read', 'run:events:read'),
]);
export const CredentialOperationPolicyV1Schema: z.ZodType<CredentialOperationPolicyV1> =
  CredentialOperationPolicyV1ExactSchema;
export const CredentialOperationPolicySchema = CredentialOperationPolicyV1Schema;
export type CredentialOperationPolicy = CredentialOperationPolicyV1;
