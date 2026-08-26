import { z } from 'zod';

import { UuidV1Schema } from './auth-v1.js';
import {
  addCustomIssue,
  hasUniqueStrings,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  Sha256HexV1Schema,
} from './primitives.js';

export const DeploymentEnvironmentV1Schema = z.enum(['development', 'staging', 'production']);

export const BrowserClientChannelV1Schema = z.enum(['WEB_SDK', 'DINGTALK_WEB']);
export const BrowserSessionTokenAudienceV1Schema = z.literal('agent_browser_api');

export const DeploymentPolicyKindV1Schema = z.enum([
  'deployment_profile',
  'entry_grant',
  'entry_scope',
  'oauth_delegation',
  'service_principal',
  'team_credential',
]);

export const ImmutableDeploymentPolicyPinV1Schema = z.strictObject({
  schema_version: z.literal('deployment-policy-pin/1'),
  workspace_id: UuidV1Schema,
  policy_kind: DeploymentPolicyKindV1Schema,
  policy_id: UuidV1Schema,
  policy_version_id: UuidV1Schema,
  contract_hash: Sha256HexV1Schema,
});

export function policyPinSchemaFor(kind: z.infer<typeof DeploymentPolicyKindV1Schema>) {
  return ImmutableDeploymentPolicyPinV1Schema.extend({ policy_kind: z.literal(kind) });
}

const credentialMappingBaseShape = {
  requirement_id: NonEmptyStringSchema,
  provider_id: NonEmptyStringSchema,
  audience: NonEmptyStringSchema,
  allowed_scopes: z
    .array(NonEmptyStringSchema)
    .min(1)
    .refine(hasUniqueStrings, 'allowed scopes must be unique'),
  mapping_hash: Sha256HexV1Schema,
};

export function createDeploymentCredentialMappingV1Schema<
  const SchemaVersion extends
    | 'agent-deployment-credential-mapping/1'
    | 'flow-deployment-credential-mapping/1',
>(schemaVersion: SchemaVersion) {
  return z.discriminatedUnion('principal_mode', [
    z.strictObject({
      schema_version: z.literal(schemaVersion),
      ...credentialMappingBaseShape,
      principal_mode: z.literal('caller_delegated'),
      credential_source_kind: z.literal('oauth_delegation_policy'),
      principal_source: z.literal('authenticated_end_user'),
      credential_policy: policyPinSchemaFor('oauth_delegation'),
    }),
    z.strictObject({
      schema_version: z.literal(schemaVersion),
      ...credentialMappingBaseShape,
      principal_mode: z.literal('service_principal'),
      credential_source_kind: z.literal('service_principal_policy'),
      service_principal_id: UuidV1Schema,
      credential_policy: policyPinSchemaFor('service_principal'),
    }),
    z.strictObject({
      schema_version: z.literal(schemaVersion),
      ...credentialMappingBaseShape,
      principal_mode: z.literal('team_shared'),
      credential_source_kind: z.literal('team_credential_policy'),
      team_credential_policy_id: UuidV1Schema,
      credential_policy: policyPinSchemaFor('team_credential'),
    }),
  ]);
}

export function addEntryGrantLifecycleIssues(
  grant: {
    status: 'ACTIVE' | 'REVOKED';
    not_before_at?: string | undefined;
    expires_at?: string | undefined;
    revoked_at?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if ((grant.status === 'REVOKED') !== (grant.revoked_at !== undefined)) {
    addCustomIssue(
      ctx,
      ['revoked_at'],
      'revoked grants require revoked_at and active grants forbid it',
    );
  }
  if (
    grant.not_before_at !== undefined &&
    grant.expires_at !== undefined &&
    Date.parse(grant.expires_at) <= Date.parse(grant.not_before_at)
  ) {
    addCustomIssue(ctx, ['expires_at'], 'grant expires_at must be later than not_before_at');
  }
}

export const DeploymentSecurityStatusV1Schema = z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']);
export const DeploymentEpochV1Schema = NonNegativeIntegerSchema;

export type DeploymentEnvironmentV1 = z.infer<typeof DeploymentEnvironmentV1Schema>;
export type BrowserClientChannelV1 = z.infer<typeof BrowserClientChannelV1Schema>;
export type ImmutableDeploymentPolicyPinV1 = z.infer<typeof ImmutableDeploymentPolicyPinV1Schema>;
