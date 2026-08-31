import { canonicalSha256ExcludingRootKeys } from '@better-agent/release-core';

export const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303eee';
export const credentialId = '018f47f2-c541-7cc6-9292-4a2c35303e01';
export const principalId = '018f47f2-c541-7cc6-9292-4a2c35303e02';
export const conversationId = '018f47f2-c541-7cc6-9292-4a2c35303e03';
export const agentDeploymentId = '018f47f2-c541-7cc6-9292-4a2c35303e04';
export const agentRevisionId = '018f47f2-c541-7cc6-9292-4a2c35303e05';
export const agentId = '018f47f2-c541-7cc6-9292-4a2c35303e06';
export const agentReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303e07';
export const experienceId = '018f47f2-c541-7cc6-9292-4a2c35303e08';
export const experienceReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303e09';
export const runId = '018f47f2-c541-7cc6-9292-4a2c35303e0d';
export const requestId = '018f47f2-c541-7cc6-9292-4a2c35303e0e';
export const messageId = '018f47f2-c541-7cc6-9292-4a2c35303e0f';
export const gateId = '018f47f2-c541-7cc6-9292-4a2c35303e10';
export const attemptId = '018f47f2-c541-7cc6-9292-4a2c35303e16';
export const stepId = '018f47f2-c541-7cc6-9292-4a2c35303e17';
export const checkpointId = '018f47f2-c541-7cc6-9292-4a2c35303e18';
export const recoveryTicketId = '018f47f2-c541-7cc6-9292-4a2c35303e19';
export const recoveryDispositionId = '018f47f2-c541-7cc6-9292-4a2c35303e1a';
export const holdIntentId = '018f47f2-c541-7cc6-9292-4a2c35303e1b';
export const effectEnvelopeId = '018f47f2-c541-7cc6-9292-4a2c35303e1c';
export const effectReceiptId = '018f47f2-c541-7cc6-9292-4a2c35303e1d';
export const outboxMessageId = '018f47f2-c541-7cc6-9292-4a2c35303e1e';
export const dispatchRetirementReceiptId = '018f47f2-c541-7cc6-9292-4a2c35303e1f';
export const leaseTokenA = '018f47f2-c541-7cc6-9292-4a2c35303e20';
export const leaseTokenB = '018f47f2-c541-7cc6-9292-4a2c35303e21';
export const terminalSourceId = '018f47f2-c541-7cc6-9292-4a2c35303e22';
export const hashA = `sha256:${'a'.repeat(64)}` as const;
export const hashB = `sha256:${'b'.repeat(64)}` as const;
export const hashC = `sha256:${'c'.repeat(64)}` as const;

export const credentialPrincipal = {
  schema_version: 'conversation-principal/1',
  kind: 'credential',
  credential_id: credentialId,
} as const;

const agentReleasePin = {
  workspace_id: workspaceId,
  published_resource_kind: 'AGENT_RELEASE',
  resource_id: agentId,
  resource_version_id: agentReleaseId,
  contract_hash: hashA,
  binding_mode: 'pinned',
} as const;

const experienceReleasePin = {
  workspace_id: workspaceId,
  published_resource_kind: 'EXPERIENCE_RELEASE',
  resource_id: experienceId,
  resource_version_id: experienceReleaseId,
  contract_hash: hashA,
  binding_mode: 'pinned',
} as const;

export function makeAgentSnapshot(overrides: Record<string, unknown> = {}) {
  const candidate = {
    schema_version: 'agent-deployment-entry-admission-snapshot/1',
    deployment_kind: 'agent',
    entry_source_kind: 'service_credential',
    workspace_id: workspaceId,
    agent_deployment_id: agentDeploymentId,
    agent_deployment_revision_id: agentRevisionId,
    agent_deployment_revision_contract_hash: hashA,
    agent_release: agentReleasePin,
    experience_release: experienceReleasePin,
    environment: 'development',
    ingress_channel: 'service_api',
    admission_activation_epoch: 3,
    observed_revoke_epoch: 7,
    authenticated_principal: {
      schema_version: 'caller-principal/1',
      kind: 'credential',
      credential_id: credentialId,
    },
    credential_id: credentialId,
    credential_authorization_epoch: 5,
    workspace_authorization_epoch: 9,
    entry_grant_id: '018f47f2-c541-7cc6-9292-4a2c35303e11',
    entry_grant_authorization_epoch: 4,
    entry_credential_kind: 'service_api',
    entry_principal_mode: 'credential_service_principal',
    entry_audience: 'agent_runtime_api',
    entry_channel: 'service_api',
    entry_scope: 'agent:run:create',
    entry_target_cardinality: 'exactly_one_agent_deployment',
    policy_profile_contract_hash: hashA,
    entry_scope_policy_contract_hash: hashA,
    credential_mapping_hash: hashA,
    dependency_manifest_hash: hashA,
    snapshot_hash: hashA,
    ...overrides,
  };
  return {
    ...candidate,
    snapshot_hash: canonicalSha256ExcludingRootKeys(candidate, ['snapshot_hash']),
  };
}

export function expectedAgentAdmission(overrides: Record<string, unknown> = {}) {
  return {
    deployment_kind: 'agent',
    workspace_id: workspaceId,
    deployment_id: agentDeploymentId,
    deployment_revision_id: agentRevisionId,
    deployment_revision_contract_hash: hashA,
    admission_activation_epoch: 3,
    observed_revoke_epoch: 7,
    ...overrides,
  } as const;
}

export function makeAgentTarget(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'run-target/1',
    target_kind: 'agent',
    agent_deployment_id: agentDeploymentId,
    agent_deployment_revision_id: agentRevisionId,
    agent_id: agentId,
    agent_release_id: agentReleaseId,
    experience_release_id: experienceReleaseId,
    conversation_id: conversationId,
    conversation_contract_hash: hashA,
    accepted_conversation_state_version: 1,
    user_message_id: messageId,
    ...overrides,
  } as const;
}

export function makeAcceptance(overrides: Record<string, unknown> = {}) {
  const snapshot = makeAgentSnapshot();
  return {
    schema_version: 'run-acceptance/1',
    workspace_id: workspaceId,
    run_id: runId,
    accepted_request_id: requestId,
    accepted_principal: credentialPrincipal,
    admission_snapshot_hash: snapshot.snapshot_hash,
    accepted_plan_hash: hashB,
    accepted_output_schema_ref: 'registry://agent-output/1',
    accepted_output_schema_hash: hashC,
    dependency_pins_hash: hashA,
    status: 'QUEUED',
    execution_status: 'ACCEPTED',
    billing_state: 'PENDING',
    target: makeAgentTarget(),
    ...overrides,
  } as const;
}

export function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'conversation/1',
    workspace_id: workspaceId,
    conversation_id: conversationId,
    principal: credentialPrincipal,
    agent_deployment_id: agentDeploymentId,
    created_under_agent_deployment_revision_id: agentRevisionId,
    conversation_contract_hash: hashA,
    state_version: 0,
    ...overrides,
  } as const;
}

export const retentionHorizons = {
  schema_version: 'run-retention-horizons/1',
  workspace_id: workspaceId,
  run_id: runId,
  finished_at: '2026-01-01T00:00:00Z',
  events_retention_until: '2026-01-08T00:00:00Z',
  recovery_retention_until: '2026-01-31T00:00:00Z',
  retention_until: '2026-02-01T00:00:00Z',
} as const;

export const archiveEvidence = {
  schema_version: 'run-archive-evidence/1',
  manifest: {
    schema_version: 'run-archive-manifest/1',
    manifest_id: '018f47f2-c541-7cc6-9292-4a2c35303e12',
    workspace_id: workspaceId,
    run_id: runId,
    archive_ref: 'archive://run/manifest',
    archive_sha256: hashA,
    created_at: '2026-01-02T00:00:00Z',
  },
  verification_receipt: {
    schema_version: 'run-archive-verification-receipt/1',
    verification_receipt_id: '018f47f2-c541-7cc6-9292-4a2c35303e13',
    manifest_id: '018f47f2-c541-7cc6-9292-4a2c35303e12',
    workspace_id: workspaceId,
    run_id: runId,
    archive_ref: 'archive://run/manifest',
    archive_sha256: hashA,
    receipt_ref: 'archive://run/verification',
    receipt_sha256: hashB,
    status: 'VERIFIED',
    verified_at: '2026-01-03T00:00:00Z',
  },
  approval_receipt: {
    schema_version: 'run-archive-approval-receipt/1',
    approval_receipt_id: '018f47f2-c541-7cc6-9292-4a2c35303e14',
    manifest_id: '018f47f2-c541-7cc6-9292-4a2c35303e12',
    verification_receipt_id: '018f47f2-c541-7cc6-9292-4a2c35303e13',
    verification_receipt_sha256: hashB,
    workspace_id: workspaceId,
    run_id: runId,
    receipt_ref: 'archive://run/approval',
    receipt_sha256: hashC,
    status: 'APPROVED',
    approved_at: '2026-01-04T00:00:00Z',
  },
} as const;

export const eventsPurgeReceipt = {
  schema_version: 'run-retention-purge-receipt/1',
  purge_receipt_id: '018f47f2-c541-7cc6-9292-4a2c35303e15',
  workspace_id: workspaceId,
  run_id: runId,
  manifest_id: archiveEvidence.manifest.manifest_id,
  material_kind: 'EVENTS',
  purged_checkpoints: '0',
  purged_events: '1',
  purged_outbox: '0',
  financial_ledger_purged: false,
  purged_at: '2026-01-10T00:00:00Z',
} as const;
