import { z } from 'zod';

import { AgentReleasePinV1Schema, PublishedResourcePinV1Schema } from './agent-release-v1.js';
import { CanonicalHttpsOriginV1Schema, UuidV1Schema } from './auth-v1.js';
import {
  addEntryGrantLifecycleIssues,
  BrowserClientChannelV1Schema,
  BrowserSessionTokenAudienceV1Schema,
  createDeploymentCredentialMappingV1Schema,
  DeploymentEnvironmentV1Schema,
  DeploymentEpochV1Schema,
  DeploymentSecurityStatusV1Schema,
  policyPinSchemaFor,
} from './deployment-common-v1.js';
import {
  addCustomIssue,
  hasUniqueBy,
  hasUniqueStrings,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  Sha256HexV1Schema,
} from './primitives.js';

export const AgentDeploymentIngressChannelV1Schema = z.enum([
  'browser',
  'service_api',
  'internal_preview',
]);

export const AgentServiceApiEntryScopeV1Schema = z.enum([
  'agent:conversation:write',
  'agent:conversation:read',
  'agent:run:create',
  'run:read',
  'run:cancel',
  'run:resume',
  'run:events:read',
]);

export const ExperienceReleasePinV1Schema = PublishedResourcePinV1Schema.extend({
  published_resource_kind: z.literal('EXPERIENCE_RELEASE'),
  contract_hash: Sha256HexV1Schema,
});

const G005AgentReleasePinV1Schema = AgentReleasePinV1Schema.extend({
  contract_hash: Sha256HexV1Schema,
});

export const AgentDeploymentCredentialMappingV1Schema = createDeploymentCredentialMappingV1Schema(
  'agent-deployment-credential-mapping/1',
);

export const AgentDeploymentV1Schema = z.strictObject({
  schema_version: z.literal('agent-deployment-stable/1'),
  workspace_id: UuidV1Schema,
  agent_deployment_id: UuidV1Schema,
  agent_id: UuidV1Schema,
  public_selector: NonEmptyStringSchema.max(255),
  environment: DeploymentEnvironmentV1Schema,
  ingress_channel: AgentDeploymentIngressChannelV1Schema,
});

const revisionBaseShape = {
  schema_version: z.literal('agent-deployment/1'),
  deployment_kind: z.literal('agent'),
  workspace_id: UuidV1Schema,
  agent_deployment_id: UuidV1Schema,
  agent_deployment_revision_id: UuidV1Schema,
  agent_id: UuidV1Schema,
  environment: DeploymentEnvironmentV1Schema,
  agent_release: G005AgentReleasePinV1Schema,
  experience_release: ExperienceReleasePinV1Schema,
  policy_profile: policyPinSchemaFor('deployment_profile'),
  entry_grant_policy: policyPinSchemaFor('entry_grant'),
  entry_scope_policy: policyPinSchemaFor('entry_scope'),
  credential_mappings: z.array(AgentDeploymentCredentialMappingV1Schema),
  credential_mapping_hash: Sha256HexV1Schema,
  conversation_contract_hash: Sha256HexV1Schema,
  dependency_manifest_hash: Sha256HexV1Schema,
  change_set_hash: Sha256HexV1Schema,
  revision_contract_hash: Sha256HexV1Schema,
};

export const AgentDeploymentRevisionV1Schema = z
  .discriminatedUnion('ingress_channel', [
    z.strictObject({
      ...revisionBaseShape,
      ingress_channel: z.literal('browser'),
      allowed_origins: z
        .array(CanonicalHttpsOriginV1Schema)
        .min(1)
        .refine(hasUniqueStrings, 'allowed origins must be unique'),
      browser_client_channels: z
        .array(BrowserClientChannelV1Schema)
        .min(1)
        .refine(hasUniqueStrings, 'browser client channels must be unique'),
      session_token_audience: BrowserSessionTokenAudienceV1Schema,
    }),
    z.strictObject({
      ...revisionBaseShape,
      ingress_channel: z.literal('service_api'),
    }),
    z.strictObject({
      ...revisionBaseShape,
      ingress_channel: z.literal('internal_preview'),
    }),
  ])
  .superRefine((revision, ctx) => {
    if (!hasUniqueBy(revision.credential_mappings, (mapping) => mapping.requirement_id)) {
      addCustomIssue(ctx, ['credential_mappings'], 'requirement mappings must be unique');
    }
    const workspacePins = [
      revision.agent_release.workspace_id,
      revision.experience_release.workspace_id,
      revision.policy_profile.workspace_id,
      revision.entry_grant_policy.workspace_id,
      revision.entry_scope_policy.workspace_id,
      ...revision.credential_mappings.map((mapping) => mapping.credential_policy.workspace_id),
    ];
    if (!workspacePins.every((workspaceId) => workspaceId === revision.workspace_id)) {
      addCustomIssue(ctx, ['workspace_id'], 'all revision pins must use the revision workspace');
    }
    if (revision.agent_release.resource_id !== revision.agent_id) {
      addCustomIssue(ctx, ['agent_release'], 'Agent Release must belong to the stable Agent');
    }
  });

export const AgentDeploymentActivePointerV1Schema = z.strictObject({
  schema_version: z.literal('agent-deployment-active-pointer/1'),
  workspace_id: UuidV1Schema,
  agent_deployment_id: UuidV1Schema,
  active_revision_id: UuidV1Schema,
  activation_epoch: DeploymentEpochV1Schema,
});

export const AgentDeploymentSecurityStateV1Schema = z.strictObject({
  schema_version: z.literal('agent-deployment-security-state/1'),
  workspace_id: UuidV1Schema,
  agent_deployment_id: UuidV1Schema,
  status: DeploymentSecurityStatusV1Schema,
  revoke_epoch: DeploymentEpochV1Schema,
});

const entryGrantBaseShape = {
  schema_version: z.literal('agent-deployment-entry-grant/1'),
  entry_grant_id: UuidV1Schema,
  workspace_id: UuidV1Schema,
  credential_id: UuidV1Schema,
  agent_deployment_id: UuidV1Schema,
  status: z.enum(['ACTIVE', 'REVOKED']),
  authorization_epoch: NonNegativeIntegerSchema,
  not_before_at: z.iso.datetime({ offset: true }).optional(),
  expires_at: z.iso.datetime({ offset: true }).optional(),
  revoked_at: z.iso.datetime({ offset: true }).optional(),
};

export const AgentDeploymentEntryGrantV1Schema = z
  .discriminatedUnion('credential_kind', [
    z.strictObject({
      ...entryGrantBaseShape,
      credential_kind: z.literal('publish'),
      principal_mode: z.literal('issuer_asserted_end_user'),
      entry_audience: z.literal('browser_session_exchange'),
      ingress_channel: z.literal('browser'),
      scope: z.literal('browser-session:exchange'),
      target_cardinality: z.literal('exactly_one_agent_deployment'),
    }),
    z.strictObject({
      ...entryGrantBaseShape,
      credential_kind: z.literal('service_api'),
      principal_mode: z.literal('credential_service_principal'),
      entry_audience: z.literal('agent_runtime_api'),
      ingress_channel: z.literal('service_api'),
      scope: AgentServiceApiEntryScopeV1Schema,
      target_cardinality: z.literal('exactly_one_agent_deployment'),
    }),
  ])
  .superRefine(addEntryGrantLifecycleIssues);

const credentialPrincipalSchema = z.strictObject({
  schema_version: z.literal('caller-principal/1'),
  kind: z.literal('credential'),
  credential_id: UuidV1Schema,
});

const endUserPrincipalSchema = z.strictObject({
  schema_version: z.literal('caller-principal/1'),
  kind: z.literal('end_user'),
  end_user_principal_id: UuidV1Schema,
});

const admissionSnapshotBaseShape = {
  schema_version: z.literal('agent-deployment-entry-admission-snapshot/1'),
  deployment_kind: z.literal('agent'),
  workspace_id: UuidV1Schema,
  agent_deployment_id: UuidV1Schema,
  agent_deployment_revision_id: UuidV1Schema,
  agent_deployment_revision_contract_hash: Sha256HexV1Schema,
  agent_release: G005AgentReleasePinV1Schema,
  experience_release: ExperienceReleasePinV1Schema,
  environment: DeploymentEnvironmentV1Schema,
  admission_activation_epoch: NonNegativeIntegerSchema,
  observed_revoke_epoch: NonNegativeIntegerSchema,
  workspace_authorization_epoch: NonNegativeIntegerSchema,
  policy_profile_contract_hash: Sha256HexV1Schema,
  entry_scope_policy_contract_hash: Sha256HexV1Schema,
  credential_mapping_hash: Sha256HexV1Schema,
  dependency_manifest_hash: Sha256HexV1Schema,
  snapshot_hash: Sha256HexV1Schema,
};

export const AgentDeploymentEntryAdmissionSnapshotV1Schema = z
  .discriminatedUnion('entry_source_kind', [
    z.strictObject({
      ...admissionSnapshotBaseShape,
      entry_source_kind: z.literal('service_credential'),
      ingress_channel: z.literal('service_api'),
      authenticated_principal: credentialPrincipalSchema,
      credential_id: UuidV1Schema,
      credential_authorization_epoch: NonNegativeIntegerSchema,
      entry_grant_id: UuidV1Schema,
      entry_grant_authorization_epoch: NonNegativeIntegerSchema,
      entry_credential_kind: z.literal('service_api'),
      entry_principal_mode: z.literal('credential_service_principal'),
      entry_audience: z.literal('agent_runtime_api'),
      entry_channel: z.literal('service_api'),
      entry_scope: AgentServiceApiEntryScopeV1Schema,
      entry_target_cardinality: z.literal('exactly_one_agent_deployment'),
    }),
    z.strictObject({
      ...admissionSnapshotBaseShape,
      entry_source_kind: z.literal('browser_session'),
      ingress_channel: z.literal('browser'),
      authenticated_principal: endUserPrincipalSchema,
      browser_session_id: UuidV1Schema,
      client_channel: BrowserClientChannelV1Schema,
      canonical_origin: CanonicalHttpsOriginV1Schema,
      token_audience: BrowserSessionTokenAudienceV1Schema,
      session_epoch: NonNegativeIntegerSchema,
      observed_principal_session_epoch: NonNegativeIntegerSchema,
    }),
  ])
  .superRefine((snapshot, ctx) => {
    if (
      snapshot.agent_release.workspace_id !== snapshot.workspace_id ||
      snapshot.experience_release.workspace_id !== snapshot.workspace_id
    ) {
      addCustomIssue(
        ctx,
        ['workspace_id'],
        'snapshot release pins must use the snapshot workspace',
      );
    }
    if (snapshot.entry_source_kind === 'service_credential') {
      if (snapshot.authenticated_principal.credential_id !== snapshot.credential_id) {
        addCustomIssue(
          ctx,
          ['authenticated_principal'],
          'snapshot credential principal must match credential_id',
        );
      }
    }
  });

export type AgentDeploymentCredentialMappingV1 = z.infer<
  typeof AgentDeploymentCredentialMappingV1Schema
>;
export type AgentDeploymentRevisionV1 = z.infer<typeof AgentDeploymentRevisionV1Schema>;
export type AgentDeploymentEntryGrantV1 = z.infer<typeof AgentDeploymentEntryGrantV1Schema>;
export type AgentDeploymentEntryAdmissionSnapshotV1 = z.infer<
  typeof AgentDeploymentEntryAdmissionSnapshotV1Schema
>;
