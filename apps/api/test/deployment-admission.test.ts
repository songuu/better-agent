import { formatAccessKey } from '@better-agent/auth';
import { describe, expect, it, vi } from 'vitest';

import { createAuthBoundary } from '../src/modules/auth/index.js';
import {
  admitAgentServiceDeploymentInTransaction,
  DeploymentBoundaryError,
  type DeploymentDatabaseTransaction,
} from '../src/modules/deployments/deployment-admission.js';

const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303eee';
const credentialId = '018f47f2-c541-7cc6-9292-4a2c35303e15';
const keyId = '018f47f2-c541-7cc6-9292-4a2c35303ee4';
const agentId = '018f47f2-c541-7cc6-9292-4a2c35303e01';
const agentReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303e02';
const experienceId = '018f47f2-c541-7cc6-9292-4a2c35303e07';
const experienceReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303e08';
const agentDeploymentId = '018f47f2-c541-7cc6-9292-4a2c35303e10';
const agentRevisionId = '018f47f2-c541-7cc6-9292-4a2c35303e11';
const grantId = '018f47f2-c541-7cc6-9292-4a2c35303e18';
const hash = `sha256:${'a'.repeat(64)}` as const;

const route = {
  method: 'POST',
  operationId: 'createAgentChatRun',
  routeTemplate: '/v1/oapi/agent/chat',
} as const;

function agentFacts(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'agent-deployment-entry-admission-facts/1',
    deployment_kind: 'agent',
    entry_source_kind: 'service_credential',
    workspace_id: workspaceId,
    agent_deployment_id: agentDeploymentId,
    agent_deployment_revision_id: agentRevisionId,
    agent_deployment_revision_contract_hash: hash,
    agent_release: {
      workspace_id: workspaceId,
      published_resource_kind: 'AGENT_RELEASE',
      resource_id: agentId,
      resource_version_id: agentReleaseId,
      contract_hash: hash,
      binding_mode: 'pinned',
    },
    experience_release: {
      workspace_id: workspaceId,
      published_resource_kind: 'EXPERIENCE_RELEASE',
      resource_id: experienceId,
      resource_version_id: experienceReleaseId,
      contract_hash: hash,
      binding_mode: 'pinned',
    },
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
    entry_grant_id: grantId,
    entry_grant_authorization_epoch: 4,
    entry_credential_kind: 'service_api',
    entry_principal_mode: 'credential_service_principal',
    entry_audience: 'agent_runtime_api',
    entry_channel: 'service_api',
    entry_scope: 'agent:run:create',
    entry_target_cardinality: 'exactly_one_agent_deployment',
    policy_profile_contract_hash: hash,
    entry_scope_policy_contract_hash: hash,
    credential_mapping_hash: hash,
    dependency_manifest_hash: hash,
    ...overrides,
  };
}

function transaction(
  overrides: Partial<DeploymentDatabaseTransaction> = {},
): DeploymentDatabaseTransaction {
  return {
    authenticateCredential: vi.fn(async () => ({
      credentialId,
      credentialAuthorizationEpoch: 5,
      credentialKind: 'service_api' as const,
      scopes: ['agent:run:create'] as const,
      workspaceId,
      workspaceAuthorizationEpoch: 9,
    })),
    resolveAgentServiceAdmission: vi.fn(async () => agentFacts()),
    resolveFlowServiceAdmission: vi.fn(async () => {
      throw new Error('wrong resolver');
    }),
    ...overrides,
  };
}

function accessKey() {
  return formatAccessKey({ keyId, secret: Buffer.alloc(32, 7) });
}

async function authenticatedContext(tx: DeploymentDatabaseTransaction) {
  const authenticator = createAuthBoundary({
    accessKeyPepper: async () => Buffer.alloc(32, 9),
  }).bindServiceRoute(route);
  return authenticator.authenticateAccessKey({
    accessKey: accessKey(),
    declaredWorkspaceId: workspaceId,
    transaction: tx,
  });
}

describe('transaction-scoped Deployment admission', () => {
  it('uses the caller-owned transaction directly and returns closed Agent facts', async () => {
    const tx = transaction();
    const context = await authenticatedContext(tx);

    const result = await admitAgentServiceDeploymentInTransaction(tx, context, {
      publicSelector: 'assistant',
      requiredScope: 'agent:run:create',
    });

    expect(tx.resolveAgentServiceAdmission).toHaveBeenCalledTimes(1);
    expect(tx.resolveAgentServiceAdmission).toHaveBeenCalledWith('assistant', 'agent:run:create');
    expect(result).toMatchObject({
      schema_version: 'agent-deployment-entry-admission-snapshot/1',
      agent_deployment_id: agentDeploymentId,
      snapshot_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
  });

  it('rejects scope drift and caller authority fields before resolving admission', async () => {
    const tx = transaction();
    const context = await authenticatedContext(tx);

    for (const input of [
      { publicSelector: 'assistant', requiredScope: 'run:read' },
      {
        publicSelector: 'assistant',
        requiredScope: 'agent:run:create',
        snapshot_hash: hash,
      },
    ]) {
      await expect(
        admitAgentServiceDeploymentInTransaction(tx, context, input),
      ).rejects.toBeInstanceOf(DeploymentBoundaryError);
    }
    expect(tx.resolveAgentServiceAdmission).not.toHaveBeenCalled();
  });
});
