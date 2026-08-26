import { z } from 'zod';

import { FlowVersionPinV1Schema } from './agent-release-v1.js';
import { UuidV1Schema } from './auth-v1.js';
import {
  addEntryGrantLifecycleIssues,
  createDeploymentCredentialMappingV1Schema,
  DeploymentEnvironmentV1Schema,
  DeploymentEpochV1Schema,
  DeploymentSecurityStatusV1Schema,
  policyPinSchemaFor,
} from './deployment-common-v1.js';
import {
  addCustomIssue,
  hasUniqueBy,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  Sha256HexV1Schema,
} from './primitives.js';

export const FlowDeploymentIngressChannelV1Schema = z.enum(['service_api', 'internal_preview']);

export const FlowServiceApiEntryScopeV1Schema = z.enum([
  'flow:run:create',
  'run:read',
  'run:cancel',
  'run:resume',
  'run:events:read',
]);

export const FlowDeploymentCredentialMappingV1Schema = createDeploymentCredentialMappingV1Schema(
  'flow-deployment-credential-mapping/1',
);

const G005FlowVersionPinV1Schema = FlowVersionPinV1Schema.extend({
  contract_hash: Sha256HexV1Schema,
});

export const FlowDeploymentV1Schema = z.strictObject({
  schema_version: z.literal('flow-deployment-stable/1'),
  workspace_id: UuidV1Schema,
  flow_deployment_id: UuidV1Schema,
  flow_id: UuidV1Schema,
  public_selector: NonEmptyStringSchema.max(255),
  environment: DeploymentEnvironmentV1Schema,
  ingress_channel: FlowDeploymentIngressChannelV1Schema,
});

export const FlowDeploymentRevisionV1Schema = z
  .strictObject({
    schema_version: z.literal('flow-deployment/1'),
    deployment_kind: z.literal('flow'),
    workspace_id: UuidV1Schema,
    flow_deployment_id: UuidV1Schema,
    flow_deployment_revision_id: UuidV1Schema,
    flow_id: UuidV1Schema,
    environment: DeploymentEnvironmentV1Schema,
    ingress_channel: FlowDeploymentIngressChannelV1Schema,
    flow_version: G005FlowVersionPinV1Schema,
    policy_profile: policyPinSchemaFor('deployment_profile'),
    entry_grant_policy: policyPinSchemaFor('entry_grant'),
    entry_scope_policy: policyPinSchemaFor('entry_scope'),
    credential_mappings: z.array(FlowDeploymentCredentialMappingV1Schema),
    credential_mapping_hash: Sha256HexV1Schema,
    dependency_manifest_hash: Sha256HexV1Schema,
    change_set_hash: Sha256HexV1Schema,
    revision_contract_hash: Sha256HexV1Schema,
  })
  .superRefine((revision, ctx) => {
    if (!hasUniqueBy(revision.credential_mappings, (mapping) => mapping.requirement_id)) {
      addCustomIssue(ctx, ['credential_mappings'], 'requirement mappings must be unique');
    }
    const workspacePins = [
      revision.flow_version.workspace_id,
      revision.policy_profile.workspace_id,
      revision.entry_grant_policy.workspace_id,
      revision.entry_scope_policy.workspace_id,
      ...revision.credential_mappings.map((mapping) => mapping.credential_policy.workspace_id),
    ];
    if (!workspacePins.every((workspaceId) => workspaceId === revision.workspace_id)) {
      addCustomIssue(ctx, ['workspace_id'], 'all revision pins must use the revision workspace');
    }
    if (revision.flow_version.resource_id !== revision.flow_id) {
      addCustomIssue(ctx, ['flow_version'], 'Flow Version must belong to the stable Flow');
    }
  });

export const FlowDeploymentActivePointerV1Schema = z.strictObject({
  schema_version: z.literal('flow-deployment-active-pointer/1'),
  workspace_id: UuidV1Schema,
  flow_deployment_id: UuidV1Schema,
  active_revision_id: UuidV1Schema,
  activation_epoch: DeploymentEpochV1Schema,
});

export const FlowDeploymentSecurityStateV1Schema = z.strictObject({
  schema_version: z.literal('flow-deployment-security-state/1'),
  workspace_id: UuidV1Schema,
  flow_deployment_id: UuidV1Schema,
  status: DeploymentSecurityStatusV1Schema,
  revoke_epoch: DeploymentEpochV1Schema,
});

const flowGrantBaseShape = {
  schema_version: z.literal('flow-deployment-entry-grant/1'),
  entry_grant_id: UuidV1Schema,
  workspace_id: UuidV1Schema,
  credential_id: UuidV1Schema,
  flow_deployment_id: UuidV1Schema,
  credential_kind: z.literal('service_api'),
  principal_mode: z.literal('credential_service_principal'),
  entry_audience: z.literal('flow_runtime_api'),
  ingress_channel: z.literal('service_api'),
  scope: FlowServiceApiEntryScopeV1Schema,
  target_cardinality: z.literal('exactly_one_flow_deployment'),
  status: z.enum(['ACTIVE', 'REVOKED']),
  authorization_epoch: NonNegativeIntegerSchema,
  not_before_at: z.iso.datetime({ offset: true }).optional(),
  expires_at: z.iso.datetime({ offset: true }).optional(),
  revoked_at: z.iso.datetime({ offset: true }).optional(),
};

export const FlowDeploymentEntryGrantV1Schema = z
  .strictObject(flowGrantBaseShape)
  .superRefine(addEntryGrantLifecycleIssues);

export const FlowDeploymentEntryAdmissionSnapshotV1Schema = z
  .strictObject({
    schema_version: z.literal('flow-deployment-entry-admission-snapshot/1'),
    deployment_kind: z.literal('flow'),
    entry_source_kind: z.literal('service_credential'),
    workspace_id: UuidV1Schema,
    flow_deployment_id: UuidV1Schema,
    flow_deployment_revision_id: UuidV1Schema,
    flow_deployment_revision_contract_hash: Sha256HexV1Schema,
    flow_version: G005FlowVersionPinV1Schema,
    environment: DeploymentEnvironmentV1Schema,
    ingress_channel: z.literal('service_api'),
    admission_activation_epoch: NonNegativeIntegerSchema,
    observed_revoke_epoch: NonNegativeIntegerSchema,
    authenticated_principal: z.strictObject({
      schema_version: z.literal('caller-principal/1'),
      kind: z.literal('credential'),
      credential_id: UuidV1Schema,
    }),
    credential_id: UuidV1Schema,
    credential_authorization_epoch: NonNegativeIntegerSchema,
    workspace_authorization_epoch: NonNegativeIntegerSchema,
    entry_grant_id: UuidV1Schema,
    entry_grant_authorization_epoch: NonNegativeIntegerSchema,
    entry_credential_kind: z.literal('service_api'),
    entry_principal_mode: z.literal('credential_service_principal'),
    entry_audience: z.literal('flow_runtime_api'),
    entry_channel: z.literal('service_api'),
    entry_scope: FlowServiceApiEntryScopeV1Schema,
    entry_target_cardinality: z.literal('exactly_one_flow_deployment'),
    policy_profile_contract_hash: Sha256HexV1Schema,
    entry_scope_policy_contract_hash: Sha256HexV1Schema,
    credential_mapping_hash: Sha256HexV1Schema,
    dependency_manifest_hash: Sha256HexV1Schema,
    snapshot_hash: Sha256HexV1Schema,
  })
  .superRefine((snapshot, ctx) => {
    if (snapshot.flow_version.workspace_id !== snapshot.workspace_id) {
      addCustomIssue(ctx, ['flow_version'], 'Flow Version must use the snapshot workspace');
    }
    if (snapshot.authenticated_principal.credential_id !== snapshot.credential_id) {
      addCustomIssue(
        ctx,
        ['authenticated_principal'],
        'snapshot credential principal must match credential_id',
      );
    }
  });

export type FlowDeploymentCredentialMappingV1 = z.infer<
  typeof FlowDeploymentCredentialMappingV1Schema
>;
export type FlowDeploymentRevisionV1 = z.infer<typeof FlowDeploymentRevisionV1Schema>;
export type FlowDeploymentEntryGrantV1 = z.infer<typeof FlowDeploymentEntryGrantV1Schema>;
export type FlowDeploymentEntryAdmissionSnapshotV1 = z.infer<
  typeof FlowDeploymentEntryAdmissionSnapshotV1Schema
>;
