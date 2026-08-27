import {
  type ConversationPrincipalV1,
  ConversationPrincipalV1Schema,
  type ConversationV1,
  ConversationV1Schema,
  type JsonObject,
  RunTargetV1Schema,
  UuidV1Schema,
} from '@better-agent/domain-contracts';
import { prepareConversationChatCas } from '@better-agent/run-core';

import type {
  BrowserIdentityDatabaseTransaction,
  BrowserSessionIdentityFacts,
} from '../runs/run-transaction.js';
import { deepFreeze, samePrincipal } from '../runs/run-transaction.js';

export type ConversationBoundaryErrorCode =
  | 'CONVERSATION_BOUNDARY_INPUT_INVALID'
  | 'CONVERSATION_AUTHORIZATION_FAILED'
  | 'CONVERSATION_CREATE_FAILED'
  | 'CONVERSATION_NOT_FOUND'
  | 'CONVERSATION_STALE'
  | 'CONVERSATION_CONTRACT_MISMATCH';

export class ConversationBoundaryError extends Error {
  constructor(readonly code: ConversationBoundaryErrorCode) {
    super('conversation boundary rejected the request');
    this.name = 'ConversationBoundaryError';
  }
}

export interface CreateAgentConversationCommand {
  readonly workspaceId: string;
  readonly principal: ConversationPrincipalV1;
  readonly publicRobotId: string;
  readonly title?: string;
  readonly variables?: JsonObject;
  readonly clientType?: 'PC' | 'MOBILE' | 'DINGTALK_WEB' | 'CLIENT';
  readonly agentDeploymentId?: string;
  readonly browserIdentity?: BrowserSessionIdentityFacts;
}

export interface LoadAgentChatConversationCommand {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly principal: ConversationPrincipalV1;
  readonly agentDeploymentId: string;
}

export interface ConversationDatabaseTransaction extends BrowserIdentityDatabaseTransaction {
  createAgentConversation(command: CreateAgentConversationCommand): Promise<unknown>;
  loadAgentChatConversation(command: LoadAgentChatConversationCommand): Promise<unknown>;
}

export interface PrepareAgentChatConversationInput {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly principal: ConversationPrincipalV1;
  readonly expectedStateVersion: number;
  readonly userMessageId: string;
  readonly runTarget: unknown;
}

export interface PreparedAgentChatConversation {
  readonly conversation: ConversationV1;
  readonly transition: Readonly<{
    previous_state_version: number;
    next_state_version: number;
  }>;
}

export async function prepareAgentChatConversationInTransaction(
  transaction: ConversationDatabaseTransaction,
  input: PrepareAgentChatConversationInput,
): Promise<PreparedAgentChatConversation> {
  const principal = ConversationPrincipalV1Schema.safeParse(input.principal);
  const target = RunTargetV1Schema.safeParse(input.runTarget);
  if (
    !principal.success ||
    !target.success ||
    target.data.target_kind !== 'agent' ||
    !UuidV1Schema.safeParse(input.workspaceId).success ||
    !UuidV1Schema.safeParse(input.conversationId).success ||
    !UuidV1Schema.safeParse(input.userMessageId).success ||
    !Number.isSafeInteger(input.expectedStateVersion) ||
    input.expectedStateVersion < 0
  ) {
    throw new ConversationBoundaryError('CONVERSATION_BOUNDARY_INPUT_INVALID');
  }
  const canonicalInput = deepFreeze({
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    principal: principal.data,
    expectedStateVersion: input.expectedStateVersion,
    userMessageId: input.userMessageId,
    runTarget: target.data,
  });
  const rawConversation = await transaction.loadAgentChatConversation(
    deepFreeze({
      workspaceId: canonicalInput.workspaceId,
      conversationId: canonicalInput.conversationId,
      principal: canonicalInput.principal,
      agentDeploymentId: canonicalInput.runTarget.agent_deployment_id,
    }),
  );
  if (rawConversation === null) {
    throw new ConversationBoundaryError('CONVERSATION_NOT_FOUND');
  }
  const conversation = ConversationV1Schema.safeParse(rawConversation);
  if (!conversation.success) throw new ConversationBoundaryError('CONVERSATION_NOT_FOUND');
  if (
    conversation.data.workspace_id !== canonicalInput.workspaceId ||
    conversation.data.conversation_id !== canonicalInput.conversationId ||
    conversation.data.agent_deployment_id !== canonicalInput.runTarget.agent_deployment_id ||
    !samePrincipal(conversation.data.principal, canonicalInput.principal)
  ) {
    throw new ConversationBoundaryError('CONVERSATION_NOT_FOUND');
  }
  try {
    const frozenConversation = deepFreeze(conversation.data);
    const transition = prepareConversationChatCas({
      conversation: frozenConversation,
      cas: {
        schema_version: 'conversation-state-cas/1',
        workspace_id: canonicalInput.workspaceId,
        conversation_id: canonicalInput.conversationId,
        expected_state_version: canonicalInput.expectedStateVersion,
      },
      user_message_id: canonicalInput.userMessageId,
      run_target: canonicalInput.runTarget,
    });
    return deepFreeze({ conversation: frozenConversation, transition });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, 'code') === 'RUN_CONVERSATION_CAS_STALE'
    ) {
      throw new ConversationBoundaryError('CONVERSATION_STALE');
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, 'code') === 'RUN_CONVERSATION_IDENTITY_MISMATCH'
    ) {
      throw new ConversationBoundaryError('CONVERSATION_CONTRACT_MISMATCH');
    }
    throw new ConversationBoundaryError('CONVERSATION_BOUNDARY_INPUT_INVALID');
  }
}
