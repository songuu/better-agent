import { formatAccessKey } from '@better-agent/auth';
import { describe, expect, it, vi } from 'vitest';

import { type AuthBoundary, createAuthBoundary } from '../src/modules/auth/index.js';
import {
  createDeploymentBoundary,
  DeploymentBoundaryError,
} from '../src/modules/deployments/index.js';
import type { DeploymentDatabaseTransaction } from '../src/modules/deployments/deployment-boundary.js';

const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303eee';
const credentialId = '018f47f2-c541-7cc6-9292-4a2c35303e15';
const keyId = '018f47f2-c541-7cc6-9292-4a2c35303ee4';
const agentId = '018f47f2-c541-7cc6-9292-4a2c35303e01';
const agentReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303e02';
const experienceId = '018f47f2-c541-7cc6-9292-4a2c35303e07';
const experienceReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303e08';
const agentDeploymentId = '018f47f2-c541-7cc6-9292-4a2c35303e10';
const agentRevisionId = '018f47f2-c541-7cc6-9292-4a2c35303e11';
const flowId = '018f47f2-c541-7cc6-9292-4a2c35303e05';
const flowVersionId = '018f47f2-c541-7cc6-9292-4a2c35303e06';
const flowDeploymentId = '018f47f2-c541-7cc6-9292-4a2c35303e12';
const flowRevisionId = '018f47f2-c541-7cc6-9292-4a2c35303e13';
const grantId = '018f47f2-c541-7cc6-9292-4a2c35303e18';
const hashA = `sha256:${'a'.repeat(64)}` as const;

const agentRoute = {
  method: 'POST',
  operationId: 'createAgentChatRun',
  routeTemplate: '/v1/oapi/agent/chat',
} as const;
const agentConversationRoute = {
  method: 'POST',
  operationId: 'createAgentConversation',
  routeTemplate: '/v1/oapi/agent/conversation',
} as const;
const flowRoute = {
  method: 'POST',
  operationId: 'createFlowRun',
  routeTemplate: '/v1/oapi/flow/run',
} as const;

function agentFacts(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'agent-deployment-entry-admission-facts/1',
    deployment_kind: 'agent',
    entry_source_kind: 'service_credential',
    workspace_id: workspaceId,
    agent_deployment_id: agentDeploymentId,
    agent_deployment_revision_id: agentRevisionId,
    agent_deployment_revision_contract_hash: hashA,
    agent_release: {
      workspace_id: workspaceId,
      published_resource_kind: 'AGENT_RELEASE',
      resource_id: agentId,
      resource_version_id: agentReleaseId,
      contract_hash: hashA,
      binding_mode: 'pinned',
    },
    experience_release: {
      workspace_id: workspaceId,
      published_resource_kind: 'EXPERIENCE_RELEASE',
      resource_id: experienceId,
      resource_version_id: experienceReleaseId,
      contract_hash: hashA,
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
    policy_profile_contract_hash: hashA,
    entry_scope_policy_contract_hash: hashA,
    credential_mapping_hash: hashA,
    dependency_manifest_hash: hashA,
    ...overrides,
  };
}

function flowFacts(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'flow-deployment-entry-admission-facts/1',
    deployment_kind: 'flow',
    entry_source_kind: 'service_credential',
    workspace_id: workspaceId,
    flow_deployment_id: flowDeploymentId,
    flow_deployment_revision_id: flowRevisionId,
    flow_deployment_revision_contract_hash: hashA,
    flow_version: {
      workspace_id: workspaceId,
      published_resource_kind: 'FLOW_VERSION',
      resource_id: flowId,
      resource_version_id: flowVersionId,
      contract_hash: hashA,
      binding_mode: 'pinned',
    },
    environment: 'staging',
    ingress_channel: 'service_api',
    admission_activation_epoch: 2,
    observed_revoke_epoch: 6,
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
    entry_audience: 'flow_runtime_api',
    entry_channel: 'service_api',
    entry_scope: 'flow:run:create',
    entry_target_cardinality: 'exactly_one_flow_deployment',
    policy_profile_contract_hash: hashA,
    entry_scope_policy_contract_hash: hashA,
    credential_mapping_hash: hashA,
    dependency_manifest_hash: hashA,
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
      scopes: ['agent:run:create', 'flow:run:create'] as const,
      workspaceId,
      workspaceAuthorizationEpoch: 9,
    })),
    resolveAgentServiceAdmission: vi.fn(async () => agentFacts()),
    resolveFlowServiceAdmission: vi.fn(async () => flowFacts()),
    ...overrides,
  };
}

function fixture(
  scopedTransaction: DeploymentDatabaseTransaction = transaction(),
  authBoundary: AuthBoundary = createAuthBoundary({
    accessKeyPepper: async () => Buffer.alloc(32, 9),
  }),
) {
  const withTransaction = vi.fn(
    async (callback: (transaction: DeploymentDatabaseTransaction) => Promise<unknown>) =>
      callback(scopedTransaction),
  ) as unknown as {
    <T>(callback: (transaction: DeploymentDatabaseTransaction) => Promise<T>): Promise<T>;
    mock: ReturnType<typeof vi.fn>['mock'];
  };
  return {
    boundary: createDeploymentBoundary({ authBoundary, withTransaction }),
    withTransaction,
  };
}

function accessKey() {
  return formatAccessKey({ keyId, secret: Buffer.alloc(32, 7) });
}

describe('G0-05 Deployment service admission composition boundary', () => {
  it('authenticates and resolves Agent admission inside one factory-owned transaction callback', async () => {
    const calls: string[] = [];
    const tx = transaction({
      authenticateCredential: vi.fn(async () => {
        calls.push('authenticate');
        return {
          credentialId,
          credentialAuthorizationEpoch: 5,
          credentialKind: 'service_api' as const,
          scopes: ['agent:run:create'] as const,
          workspaceId,
          workspaceAuthorizationEpoch: 9,
        };
      }),
      resolveAgentServiceAdmission: vi.fn(async () => {
        calls.push('admit');
        return agentFacts();
      }),
    });

    const { boundary, withTransaction } = fixture(tx);
    const result = await boundary.bindAgentServiceRoute(agentRoute).admit({
      accessKey: accessKey(),
      declaredWorkspaceId: workspaceId,
      publicSelector: 'assistant',
    });

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['authenticate', 'admit']);
    expect(tx.resolveAgentServiceAdmission).toHaveBeenCalledWith('assistant', 'agent:run:create');
    expect(result).toMatchObject({
      schema_version: 'agent-deployment-entry-admission-snapshot/1',
      deployment_kind: 'agent',
      agent_deployment_id: agentDeploymentId,
      agent_deployment_revision_id: agentRevisionId,
      snapshot_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(result).not.toHaveProperty('authorized');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('preserves the reviewed Agent Conversation scope at the database resolver seam', async () => {
    const tx = transaction({
      authenticateCredential: vi.fn(async () => ({
        credentialId,
        credentialAuthorizationEpoch: 5,
        credentialKind: 'service_api' as const,
        scopes: ['agent:conversation:write'] as const,
        workspaceId,
        workspaceAuthorizationEpoch: 9,
      })),
      resolveAgentServiceAdmission: vi.fn(async () =>
        agentFacts({ entry_scope: 'agent:conversation:write' }),
      ),
    });
    const { boundary } = fixture(tx);

    const result = await boundary.bindAgentServiceRoute(agentConversationRoute).admit({
      accessKey: accessKey(),
      declaredWorkspaceId: workspaceId,
      publicSelector: 'assistant',
    });

    expect(tx.resolveAgentServiceAdmission).toHaveBeenCalledWith(
      'assistant',
      'agent:conversation:write',
    );
    expect(result).toMatchObject({ entry_scope: 'agent:conversation:write' });
  });

  it('supports only a Flow policy proof for the Flow resolver', async () => {
    const tx = transaction();
    const { boundary } = fixture(tx);
    const result = await boundary.bindFlowServiceRoute(flowRoute).admit({
      accessKey: accessKey(),
      declaredWorkspaceId: workspaceId,
      publicSelector: 'flow',
    });

    expect(tx.resolveFlowServiceAdmission).toHaveBeenCalledWith('flow', 'flow:run:create');
    expect(result).toMatchObject({
      schema_version: 'flow-deployment-entry-admission-snapshot/1',
      deployment_kind: 'flow',
      flow_deployment_id: flowDeploymentId,
    });

    const substituted = transaction();
    expect(() => boundary.bindAgentServiceRoute(flowRoute)).toThrowError(
      expect.objectContaining({ code: 'DEPLOYMENT_ROUTE_BINDING_INVALID' }),
    );
    expect(substituted.resolveAgentServiceAdmission).not.toHaveBeenCalled();
  });

  it('rejects a caller transaction and authority fields before opening a transaction', async () => {
    const tx = transaction();
    const { boundary, withTransaction } = fixture(tx);
    const baseInput = {
      accessKey: accessKey(),
      declaredWorkspaceId: workspaceId,
      publicSelector: 'assistant',
    };

    for (const invalidInput of [
      { ...baseInput, transaction: tx },
      {
        ...baseInput,
        agentDeploymentId,
        revisionId: agentRevisionId,
        entryGrantId: grantId,
      },
    ]) {
      await expect(boundary.bindAgentServiceRoute(agentRoute).admit(invalidInput)).rejects.toEqual(
        expect.objectContaining({ code: 'DEPLOYMENT_BOUNDARY_INPUT_INVALID' }),
      );
    }
    expect(withTransaction).not.toHaveBeenCalled();
    expect(tx.authenticateCredential).not.toHaveBeenCalled();
    expect(tx.resolveAgentServiceAdmission).not.toHaveBeenCalled();
  });

  it('rejects wrong-kind, credential-epoch and caller-supplied hash facts', async () => {
    for (const facts of [
      flowFacts(),
      agentFacts({ credential_authorization_epoch: 4 }),
      agentFacts({ snapshot_hash: hashA }),
    ]) {
      const tx = transaction({ resolveAgentServiceAdmission: vi.fn(async () => facts) });
      const { boundary } = fixture(tx);
      await expect(
        boundary.bindAgentServiceRoute(agentRoute).admit({
          accessKey: accessKey(),
          declaredWorkspaceId: workspaceId,
          publicSelector: 'assistant',
        }),
      ).rejects.toBeInstanceOf(DeploymentBoundaryError);
    }
  });

  it('rejects a structurally forged credential proof before calling database admission', async () => {
    const forgedAuthBoundary = {
      bindServiceRoute: () => ({
        authenticateAccessKey: async () => ({
          credentialKind: 'service_api',
          policyPhase: {
            httpMethod: 'POST',
            operationId: 'createAgentChatRun',
            operationPurpose: 'agent_invoke',
            policyHash: `cp1.${'a'.repeat(43)}`,
            remainingGate: {
              targetCardinality: 'exactly_one_deployment',
              typedGrantFamily: 'agent_deployment_entry_grants',
            },
            requiredScopes: ['agent:run:create'],
            routeTemplate: '/v1/oapi/agent/chat',
            status: 'credential_phase_passed',
          },
          tenantAuthContext: {
            caller_principal: {
              credential_id: credentialId,
              kind: 'credential',
              schema_version: 'caller-principal/1',
            },
            observed_authorization_epochs: { credential: 5, workspace: 9 },
            schema_version: 'tenant-auth-context/1',
            workspace_id: workspaceId,
          },
        }),
      }),
    } as unknown as AuthBoundary;
    const tx = transaction();
    const { boundary } = fixture(tx, forgedAuthBoundary);

    await expect(
      boundary.bindAgentServiceRoute(agentRoute).admit({
        accessKey: accessKey(),
        declaredWorkspaceId: workspaceId,
        publicSelector: 'assistant',
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'DEPLOYMENT_ADMISSION_FAILED' }));
    expect(tx.resolveAgentServiceAdmission).not.toHaveBeenCalled();
  });

  it('normalizes database failures without leaking Access-Key or database details', async () => {
    const raw = accessKey();
    const tx = transaction({
      resolveAgentServiceAdmission: vi.fn(async () => {
        throw new Error(`database exposed ${raw} ${agentRevisionId}`);
      }),
    });
    const { boundary } = fixture(tx);
    try {
      await boundary.bindAgentServiceRoute(agentRoute).admit({
        accessKey: raw,
        declaredWorkspaceId: workspaceId,
        publicSelector: 'assistant',
      });
      expect.unreachable('database failure should reject');
    } catch (error) {
      expect(error).toBeInstanceOf(DeploymentBoundaryError);
      expect(String(error)).not.toContain(raw);
      expect(String(error)).not.toContain(agentRevisionId);
    }
  });
});
