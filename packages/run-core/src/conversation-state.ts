import {
  ConversationStateCasV1Schema,
  ConversationV1Schema,
  RunTargetV1Schema,
  UuidV1Schema,
} from '@better-agent/domain-contracts';

import { failRunCore } from './errors.js';

export interface PrepareConversationChatCasInputV1 {
  readonly conversation: unknown;
  readonly cas: unknown;
  readonly user_message_id: string;
  readonly run_target: unknown;
}

export interface ConversationStateTransitionV1 {
  readonly previous_state_version: number;
  readonly next_state_version: number;
}

export function prepareConversationChatCas(
  input: PrepareConversationChatCasInputV1,
): ConversationStateTransitionV1 {
  const conversation = ConversationV1Schema.safeParse(input.conversation);
  const cas = ConversationStateCasV1Schema.safeParse(input.cas);
  const target = RunTargetV1Schema.safeParse(input.run_target);
  if (!conversation.success || !cas.success || !target.success) {
    failRunCore(
      'RUN_CONVERSATION_CAS_INVALID',
      '$',
      'Conversation, CAS command, or Run target is not a closed contract',
    );
  }
  if (target.data.target_kind !== 'agent') {
    failRunCore(
      'RUN_CONVERSATION_IDENTITY_MISMATCH',
      '$.run_target.target_kind',
      'Conversation CAS can bind only an Agent Chat target',
    );
  }
  if (!UuidV1Schema.safeParse(input.user_message_id).success) {
    failRunCore(
      'RUN_CONVERSATION_CAS_INVALID',
      '$.user_message_id',
      'user message identity must be a UUID',
    );
  }
  if (
    cas.data.workspace_id !== conversation.data.workspace_id ||
    cas.data.conversation_id !== conversation.data.conversation_id
  ) {
    failRunCore(
      'RUN_CONVERSATION_IDENTITY_MISMATCH',
      '$.cas',
      'CAS command does not target the locked Conversation',
    );
  }
  if (cas.data.expected_state_version !== conversation.data.state_version) {
    failRunCore(
      'RUN_CONVERSATION_CAS_STALE',
      '$.cas.expected_state_version',
      'expected Conversation state version is stale',
    );
  }
  if (conversation.data.state_version === Number.MAX_SAFE_INTEGER) {
    failRunCore(
      'RUN_CONVERSATION_CAS_OVERFLOW',
      '$.conversation.state_version',
      'Conversation state version cannot advance safely',
    );
  }
  const nextStateVersion = conversation.data.state_version + 1;
  const agentTarget = target.data;
  if (
    agentTarget.agent_deployment_id !== conversation.data.agent_deployment_id ||
    agentTarget.conversation_id !== conversation.data.conversation_id ||
    agentTarget.conversation_contract_hash !== conversation.data.conversation_contract_hash ||
    agentTarget.accepted_conversation_state_version !== nextStateVersion ||
    agentTarget.user_message_id !== input.user_message_id
  ) {
    failRunCore(
      'RUN_CONVERSATION_IDENTITY_MISMATCH',
      '$.run_target',
      'Run target does not bind the Conversation contract, next state, and user message',
    );
  }
  return Object.freeze({
    previous_state_version: conversation.data.state_version,
    next_state_version: nextStateVersion,
  });
}
