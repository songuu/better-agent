import {
  isCredentialPolicyPhasePassed,
  type ServiceCredentialRouteBindingInput,
} from '@better-agent/auth';
import {
  type ConversationPrincipalV1,
  ConversationV1Schema,
  type JsonObject,
  JsonObjectSchema,
  Sha256HexV1Schema,
  UuidV1Schema,
} from '@better-agent/domain-contracts';

import type { AuthBoundary, AuthenticatedAccessKeyContext } from '../auth/index.js';
import { authenticateBrowserRunIdentityInTransaction } from '../runs/browser-run-auth.js';
import { deepFreeze, hasExactKeys, samePrincipal } from '../runs/run-transaction.js';
import {
  ConversationBoundaryError,
  type ConversationDatabaseTransaction,
  type CreateAgentConversationCommand,
} from './conversation-transaction.js';

const createRoute = {
  method: 'POST',
  operationId: 'createAgentConversation',
  routeTemplate: '/v1/oapi/agent/conversation',
} as const satisfies ServiceCredentialRouteBindingInput;

type ConversationClientType = 'PC' | 'MOBILE' | 'DINGTALK_WEB' | 'CLIENT';

export interface ConversationCreateRequest {
  readonly robot_id: string;
  readonly title?: string;
  readonly variables?: JsonObject;
  readonly client_type?: ConversationClientType;
}

export interface ServiceConversationCreateInput {
  readonly accessKey: string;
  readonly declaredWorkspaceId: string;
  readonly request: ConversationCreateRequest;
}

export interface BrowserConversationCreateInput {
  readonly browserSessionToken: string;
  readonly declaredWorkspaceId: string;
  readonly request: ConversationCreateRequest;
}

export interface ConversationCreateExchange {
  readonly code: 201;
  readonly success: true;
  readonly message: 'created';
  readonly request_id: string;
  readonly data: Readonly<{
    conversation_id: string;
    robot_id: string;
    title?: string;
    client_type?: ConversationClientType;
    created_at: string;
  }>;
  readonly now_time: number;
}

export interface ConversationBoundaryDependencies {
  readonly authBoundary: AuthBoundary;
  browserSessionPepper(): Promise<Uint8Array>;
  currentRequestId(): string;
  currentUnixTime(): number;
  withTransaction<T>(
    callback: (transaction: ConversationDatabaseTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface ConversationBoundary {
  createServiceConversation(
    input: ServiceConversationCreateInput,
  ): Promise<ConversationCreateExchange>;
  createBrowserConversation(
    input: BrowserConversationCreateInput,
  ): Promise<ConversationCreateExchange>;
}

const dependencyKeys = Object.freeze([
  'authBoundary',
  'browserSessionPepper',
  'currentRequestId',
  'currentUnixTime',
  'withTransaction',
]);
const serviceInputKeys = Object.freeze(['accessKey', 'declaredWorkspaceId', 'request']);
const browserInputKeys = Object.freeze(['browserSessionToken', 'declaredWorkspaceId', 'request']);
const requestKeys = new Set(['robot_id', 'title', 'variables', 'client_type']);
const clientTypes = new Set<ConversationClientType>(['PC', 'MOBILE', 'DINGTALK_WEB', 'CLIENT']);

function readRequest(value: unknown): ConversationCreateRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConversationBoundaryError('CONVERSATION_BOUNDARY_INPUT_INVALID');
  }
  const record = value as Record<string, unknown>;
  const variables =
    record.variables === undefined ? undefined : JsonObjectSchema.safeParse(record.variables);
  if (
    !Object.keys(record).every((key) => requestKeys.has(key)) ||
    !Object.hasOwn(record, 'robot_id') ||
    typeof record.robot_id !== 'string' ||
    record.robot_id.length < 1 ||
    record.robot_id.length > 255 ||
    (record.title !== undefined &&
      (typeof record.title !== 'string' || record.title.length > 512)) ||
    (variables !== undefined && !variables.success) ||
    (record.client_type !== undefined &&
      !clientTypes.has(record.client_type as ConversationClientType))
  ) {
    throw new ConversationBoundaryError('CONVERSATION_BOUNDARY_INPUT_INVALID');
  }
  return deepFreeze({
    robot_id: record.robot_id,
    ...(record.title === undefined ? {} : { title: record.title as string }),
    ...(variables?.success ? { variables: deepFreeze(variables.data) } : {}),
    ...(record.client_type === undefined
      ? {}
      : { client_type: record.client_type as ConversationClientType }),
  });
}

function servicePrincipal(context: AuthenticatedAccessKeyContext): ConversationPrincipalV1 {
  const proof = context.policyPhase;
  const principal = context.tenantAuthContext.caller_principal;
  if (
    !isCredentialPolicyPhasePassed(proof) ||
    context.credentialKind !== 'service_api' ||
    proof.operationId !== 'createAgentConversation' ||
    proof.operationPurpose !== 'agent_invoke' ||
    proof.requiredScopes.length !== 1 ||
    proof.requiredScopes[0] !== 'agent:conversation:write' ||
    proof.remainingGate.typedGrantFamily !== 'agent_deployment_entry_grants' ||
    proof.remainingGate.targetCardinality !== 'exactly_one_deployment' ||
    principal.kind !== 'credential'
  ) {
    throw new ConversationBoundaryError('CONVERSATION_AUTHORIZATION_FAILED');
  }
  return {
    schema_version: 'conversation-principal/1',
    kind: 'credential',
    credential_id: principal.credential_id,
  };
}

function commandFor(input: {
  workspaceId: string;
  principal: ConversationPrincipalV1;
  request: ConversationCreateRequest;
  agentDeploymentId?: string;
  browserIdentity?: CreateAgentConversationCommand['browserIdentity'];
}): CreateAgentConversationCommand {
  return deepFreeze({
    workspaceId: input.workspaceId,
    principal: input.principal,
    publicRobotId: input.request.robot_id,
    ...(input.request.title === undefined ? {} : { title: input.request.title }),
    ...(input.request.variables === undefined ? {} : { variables: input.request.variables }),
    ...(input.request.client_type === undefined ? {} : { clientType: input.request.client_type }),
    ...(input.agentDeploymentId === undefined
      ? {}
      : { agentDeploymentId: input.agentDeploymentId }),
    ...(input.browserIdentity === undefined ? {} : { browserIdentity: input.browserIdentity }),
  });
}

function readCreationReceipt(input: {
  value: unknown;
  expectedWorkspaceId: string;
  expectedPrincipal: ConversationPrincipalV1;
  expectedRobotId: string;
  expectedDeploymentId?: string;
}): {
  conversationId: string;
  publicRobotId: string;
  createdAt: string;
  title?: string;
  clientType?: ConversationClientType;
} {
  if (typeof input.value !== 'object' || input.value === null || Array.isArray(input.value)) {
    throw new ConversationBoundaryError('CONVERSATION_CREATE_FAILED');
  }
  const value = input.value as Record<string, unknown>;
  const allowed = new Set([
    'conversation',
    'publicRobotId',
    'createdAt',
    'resolvedAuthority',
    'title',
    'clientType',
  ]);
  if (
    !Object.keys(value).every((key) => allowed.has(key)) ||
    !['conversation', 'publicRobotId', 'createdAt', 'resolvedAuthority'].every((key) =>
      Object.hasOwn(value, key),
    ) ||
    typeof value.publicRobotId !== 'string' ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    (value.title !== undefined && typeof value.title !== 'string') ||
    (value.clientType !== undefined && !clientTypes.has(value.clientType as ConversationClientType))
  ) {
    throw new ConversationBoundaryError('CONVERSATION_CREATE_FAILED');
  }
  const conversation = ConversationV1Schema.safeParse(value.conversation);
  const authority = value.resolvedAuthority;
  if (
    !conversation.success ||
    !hasExactKeys(authority, [
      'activeRevisionId',
      'agentDeploymentId',
      'conversationContractHash',
      'publicRobotId',
      'workspaceId',
    ]) ||
    !UuidV1Schema.safeParse(authority.workspaceId).success ||
    !UuidV1Schema.safeParse(authority.agentDeploymentId).success ||
    !UuidV1Schema.safeParse(authority.activeRevisionId).success ||
    !Sha256HexV1Schema.safeParse(authority.conversationContractHash).success ||
    typeof authority.publicRobotId !== 'string' ||
    conversation.data.workspace_id !== input.expectedWorkspaceId ||
    !samePrincipal(conversation.data.principal, input.expectedPrincipal) ||
    conversation.data.state_version !== 0 ||
    value.publicRobotId !== input.expectedRobotId ||
    authority.workspaceId !== input.expectedWorkspaceId ||
    authority.publicRobotId !== input.expectedRobotId ||
    authority.agentDeploymentId !== conversation.data.agent_deployment_id ||
    authority.activeRevisionId !== conversation.data.created_under_agent_deployment_revision_id ||
    authority.conversationContractHash !== conversation.data.conversation_contract_hash ||
    (input.expectedDeploymentId !== undefined &&
      conversation.data.agent_deployment_id !== input.expectedDeploymentId)
  ) {
    throw new ConversationBoundaryError('CONVERSATION_CREATE_FAILED');
  }
  return Object.freeze({
    conversationId: conversation.data.conversation_id,
    publicRobotId: value.publicRobotId,
    createdAt: value.createdAt,
    ...(value.title === undefined ? {} : { title: value.title as string }),
    ...(value.clientType === undefined
      ? {}
      : { clientType: value.clientType as ConversationClientType }),
  });
}

function exchange(
  dependencies: ConversationBoundaryDependencies,
  receipt: ReturnType<typeof readCreationReceipt>,
): ConversationCreateExchange {
  const requestId = dependencies.currentRequestId();
  const nowTime = dependencies.currentUnixTime();
  if (!UuidV1Schema.safeParse(requestId).success || !Number.isSafeInteger(nowTime) || nowTime < 0) {
    throw new ConversationBoundaryError('CONVERSATION_CREATE_FAILED');
  }
  return Object.freeze({
    code: 201,
    success: true,
    message: 'created',
    request_id: requestId,
    data: Object.freeze({
      conversation_id: receipt.conversationId,
      robot_id: receipt.publicRobotId,
      ...(receipt.title === undefined ? {} : { title: receipt.title }),
      ...(receipt.clientType === undefined ? {} : { client_type: receipt.clientType }),
      created_at: receipt.createdAt,
    }),
    now_time: nowTime,
  });
}

function normalize(error: unknown): never {
  if (error instanceof ConversationBoundaryError) throw error;
  throw new ConversationBoundaryError('CONVERSATION_AUTHORIZATION_FAILED');
}

export function createConversationBoundary(
  dependencies: ConversationBoundaryDependencies,
): ConversationBoundary {
  if (!hasExactKeys(dependencies, dependencyKeys)) {
    throw new ConversationBoundaryError('CONVERSATION_BOUNDARY_INPUT_INVALID');
  }
  const serviceAuthenticator = dependencies.authBoundary.bindServiceRoute(createRoute);
  return Object.freeze({
    async createServiceConversation(input: ServiceConversationCreateInput) {
      if (
        !hasExactKeys(input, serviceInputKeys) ||
        typeof input.accessKey !== 'string' ||
        typeof input.declaredWorkspaceId !== 'string'
      ) {
        throw new ConversationBoundaryError('CONVERSATION_BOUNDARY_INPUT_INVALID');
      }
      const request = readRequest(input.request);
      try {
        return await dependencies.withTransaction(async (transaction) => {
          const context = await serviceAuthenticator.authenticateAccessKey({
            accessKey: input.accessKey,
            declaredWorkspaceId: input.declaredWorkspaceId,
            transaction,
          });
          const principal = servicePrincipal(context);
          const value = await transaction.createAgentConversation(
            commandFor({
              workspaceId: context.tenantAuthContext.workspace_id,
              principal,
              request,
            }),
          );
          return exchange(
            dependencies,
            readCreationReceipt({
              value,
              expectedWorkspaceId: context.tenantAuthContext.workspace_id,
              expectedPrincipal: principal,
              expectedRobotId: request.robot_id,
            }),
          );
        });
      } catch (error) {
        normalize(error);
      }
    },
    async createBrowserConversation(input: BrowserConversationCreateInput) {
      if (
        !hasExactKeys(input, browserInputKeys) ||
        typeof input.browserSessionToken !== 'string' ||
        typeof input.declaredWorkspaceId !== 'string'
      ) {
        throw new ConversationBoundaryError('CONVERSATION_BOUNDARY_INPUT_INVALID');
      }
      const request = readRequest(input.request);
      try {
        return await dependencies.withTransaction(async (transaction) => {
          const identity = await authenticateBrowserRunIdentityInTransaction({
            transaction,
            token: input.browserSessionToken,
            declaredWorkspaceId: input.declaredWorkspaceId,
            browserSessionPepper: dependencies.browserSessionPepper,
          });
          const principal: ConversationPrincipalV1 = {
            schema_version: 'conversation-principal/1',
            kind: 'end_user',
            end_user_principal_id: identity.endUserPrincipalId,
          };
          const value = await transaction.createAgentConversation(
            commandFor({
              workspaceId: identity.workspaceId,
              principal,
              request,
              agentDeploymentId: identity.agentDeploymentId,
              browserIdentity: identity,
            }),
          );
          return exchange(
            dependencies,
            readCreationReceipt({
              value,
              expectedWorkspaceId: identity.workspaceId,
              expectedPrincipal: principal,
              expectedRobotId: request.robot_id,
              expectedDeploymentId: identity.agentDeploymentId,
            }),
          );
        });
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          Reflect.get(error, 'code') === 'RUN_AUTHORIZATION_FAILED'
        ) {
          throw new ConversationBoundaryError('CONVERSATION_AUTHORIZATION_FAILED');
        }
        normalize(error);
      }
    },
  });
}
