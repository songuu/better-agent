import type { ServiceCredentialRouteBindingInput } from '@better-agent/auth';
import type {
  AgentDeploymentEntryAdmissionSnapshotV1,
  FlowDeploymentEntryAdmissionSnapshotV1,
} from '@better-agent/domain-contracts';

import type { AuthBoundary } from '../auth/index.js';
import {
  admitAgentServiceDeploymentInTransaction,
  admitFlowServiceDeploymentInTransaction,
  DeploymentBoundaryError,
  type DeploymentDatabaseTransaction,
} from './deployment-admission.js';

export type {
  DeploymentBoundaryErrorCode,
  DeploymentDatabaseTransaction,
} from './deployment-admission.js';
export { DeploymentBoundaryError } from './deployment-admission.js';

export interface ServiceDeploymentAdmissionInput {
  readonly accessKey: string;
  readonly declaredWorkspaceId: string;
  readonly publicSelector: string;
}

export interface BoundAgentServiceAdmission {
  admit(input: ServiceDeploymentAdmissionInput): Promise<AgentDeploymentEntryAdmissionSnapshotV1>;
}

export interface BoundFlowServiceAdmission {
  admit(input: ServiceDeploymentAdmissionInput): Promise<FlowDeploymentEntryAdmissionSnapshotV1>;
}

export interface DeploymentBoundary {
  bindAgentServiceRoute(route: ServiceCredentialRouteBindingInput): BoundAgentServiceAdmission;
  bindFlowServiceRoute(route: ServiceCredentialRouteBindingInput): BoundFlowServiceAdmission;
}

export interface DeploymentBoundaryDependencies {
  readonly authBoundary: AuthBoundary;
  withTransaction<T>(
    callback: (transaction: DeploymentDatabaseTransaction) => Promise<T>,
  ): Promise<T>;
}

const admissionInputKeys = Object.freeze(['accessKey', 'declaredWorkspaceId', 'publicSelector']);
const agentOperationIds = new Set([
  'createAgentChatRun',
  'createAgentConversation',
  'listAgentConversationMessages',
  'listAgentConversations',
]);
const flowOperationIds = new Set(['createFlowRun']);

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function assertInput(input: ServiceDeploymentAdmissionInput): void {
  if (
    !hasExactKeys(input, admissionInputKeys) ||
    typeof input.accessKey !== 'string' ||
    typeof input.declaredWorkspaceId !== 'string' ||
    typeof input.publicSelector !== 'string' ||
    input.publicSelector.length < 1 ||
    input.publicSelector.length > 255
  ) {
    throw new DeploymentBoundaryError('DEPLOYMENT_BOUNDARY_INPUT_INVALID');
  }
}

export function createDeploymentBoundary(
  dependencies: DeploymentBoundaryDependencies,
): DeploymentBoundary {
  return Object.freeze({
    bindAgentServiceRoute(route: ServiceCredentialRouteBindingInput) {
      if (!agentOperationIds.has(route.operationId)) {
        throw new DeploymentBoundaryError('DEPLOYMENT_ROUTE_BINDING_INVALID');
      }
      let authenticator: ReturnType<AuthBoundary['bindServiceRoute']>;
      try {
        authenticator = dependencies.authBoundary.bindServiceRoute(route);
      } catch {
        throw new DeploymentBoundaryError('DEPLOYMENT_ROUTE_BINDING_INVALID');
      }
      return Object.freeze({
        async admit(input: ServiceDeploymentAdmissionInput) {
          assertInput(input);
          try {
            return await dependencies.withTransaction(async (transaction) => {
              const context = await authenticator.authenticateAccessKey({
                accessKey: input.accessKey,
                declaredWorkspaceId: input.declaredWorkspaceId,
                transaction,
              });
              return admitAgentServiceDeploymentInTransaction(transaction, context, {
                publicSelector: input.publicSelector,
                requiredScope: context.policyPhase.requiredScopes[0] ?? '',
              });
            });
          } catch {
            throw new DeploymentBoundaryError('DEPLOYMENT_ADMISSION_FAILED');
          }
        },
      });
    },
    bindFlowServiceRoute(route: ServiceCredentialRouteBindingInput) {
      if (!flowOperationIds.has(route.operationId)) {
        throw new DeploymentBoundaryError('DEPLOYMENT_ROUTE_BINDING_INVALID');
      }
      let authenticator: ReturnType<AuthBoundary['bindServiceRoute']>;
      try {
        authenticator = dependencies.authBoundary.bindServiceRoute(route);
      } catch {
        throw new DeploymentBoundaryError('DEPLOYMENT_ROUTE_BINDING_INVALID');
      }
      return Object.freeze({
        async admit(input: ServiceDeploymentAdmissionInput) {
          assertInput(input);
          try {
            return await dependencies.withTransaction(async (transaction) => {
              const context = await authenticator.authenticateAccessKey({
                accessKey: input.accessKey,
                declaredWorkspaceId: input.declaredWorkspaceId,
                transaction,
              });
              return admitFlowServiceDeploymentInTransaction(transaction, context, {
                publicSelector: input.publicSelector,
                requiredScope: context.policyPhase.requiredScopes[0] ?? '',
              });
            });
          } catch {
            throw new DeploymentBoundaryError('DEPLOYMENT_ADMISSION_FAILED');
          }
        },
      });
    },
  });
}
