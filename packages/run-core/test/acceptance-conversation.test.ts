import { describe, expect, it } from 'vitest';

import { prepareConversationChatCas, prepareRunAcceptanceFacts } from '../src/index.js';
import {
  conversationId,
  expectedAgentAdmission,
  hashC,
  makeAcceptance,
  makeAgentSnapshot,
  makeAgentTarget,
  makeConversation,
  messageId,
  requestId,
  runId,
  workspaceId,
} from './fixtures.js';

describe('Run acceptance fact preparation', () => {
  it('revalidates the G0-05 snapshot and binds it to target, principal and output pins', () => {
    const result = prepareRunAcceptanceFacts({
      acceptance: makeAcceptance(),
      admission_snapshot: makeAgentSnapshot(),
      expected_admission: expectedAgentAdmission(),
    });

    expect(result.acceptance.run_id).toBe(runId);
    expect(result.admission_snapshot.snapshot_hash).toBe(result.acceptance.admission_snapshot_hash);
    expect(Object.isFrozen(result.acceptance.target)).toBe(true);
    expect(result).not.toHaveProperty('persistence_authorized');
  });

  it('rejects forged/cross-workspace snapshots and principal or target drift', () => {
    expect(() =>
      prepareRunAcceptanceFacts({
        acceptance: makeAcceptance(),
        admission_snapshot: { ...makeAgentSnapshot(), snapshot_hash: hashC },
        expected_admission: expectedAgentAdmission(),
      }),
    ).toThrowError(/RUN_ADMISSION_SNAPSHOT_INVALID/);
    expect(() =>
      prepareRunAcceptanceFacts({
        acceptance: makeAcceptance(),
        admission_snapshot: makeAgentSnapshot(),
        expected_admission: expectedAgentAdmission({ workspace_id: requestId }),
      }),
    ).toThrowError(/RUN_ADMISSION_SNAPSHOT_INVALID/);
    expect(() =>
      prepareRunAcceptanceFacts({
        acceptance: makeAcceptance({
          accepted_principal: {
            schema_version: 'conversation-principal/1',
            kind: 'credential',
            credential_id: requestId,
          },
        }),
        admission_snapshot: makeAgentSnapshot(),
        expected_admission: expectedAgentAdmission(),
      }),
    ).toThrowError(/RUN_ACCEPTANCE_INVALID/);
    expect(() =>
      prepareRunAcceptanceFacts({
        acceptance: makeAcceptance({
          target: makeAgentTarget({ agent_deployment_revision_id: requestId }),
        }),
        admission_snapshot: makeAgentSnapshot(),
        expected_admission: expectedAgentAdmission(),
      }),
    ).toThrowError(/RUN_ACCEPTANCE_INVALID/);
  });

  it('rejects missing Plan/output/Conversation facts before producing acceptance facts', () => {
    for (const field of ['accepted_plan_hash', 'accepted_output_schema_hash'] as const) {
      const acceptance = { ...makeAcceptance() } as Record<string, unknown>;
      delete acceptance[field];
      expect(() =>
        prepareRunAcceptanceFacts({
          acceptance,
          admission_snapshot: makeAgentSnapshot(),
          expected_admission: expectedAgentAdmission(),
        }),
      ).toThrowError(/RUN_ACCEPTANCE_INVALID/);
    }
    const target = { ...makeAgentTarget() } as Record<string, unknown>;
    delete target.conversation_contract_hash;
    expect(() =>
      prepareRunAcceptanceFacts({
        acceptance: makeAcceptance({ target }),
        admission_snapshot: makeAgentSnapshot(),
        expected_admission: expectedAgentAdmission(),
      }),
    ).toThrowError(/RUN_ACCEPTANCE_INVALID/);
  });
});

describe('Conversation Chat CAS', () => {
  it('computes exactly current + 1 and binds the user message to the Run target', () => {
    expect(
      prepareConversationChatCas({
        conversation: makeConversation(),
        cas: {
          schema_version: 'conversation-state-cas/1',
          workspace_id: workspaceId,
          conversation_id: conversationId,
          expected_state_version: 0,
        },
        user_message_id: messageId,
        run_target: makeAgentTarget(),
      }),
    ).toEqual({ previous_state_version: 0, next_state_version: 1 });
  });

  it('rejects stale/overflow CAS and message-to-Run identity drift', () => {
    expect(() =>
      prepareConversationChatCas({
        conversation: makeConversation(),
        cas: {
          schema_version: 'conversation-state-cas/1',
          workspace_id: workspaceId,
          conversation_id: conversationId,
          expected_state_version: 1,
        },
        user_message_id: messageId,
        run_target: makeAgentTarget(),
      }),
    ).toThrowError(/RUN_CONVERSATION_CAS_STALE/);
    expect(() =>
      prepareConversationChatCas({
        conversation: makeConversation({ state_version: Number.MAX_SAFE_INTEGER }),
        cas: {
          schema_version: 'conversation-state-cas/1',
          workspace_id: workspaceId,
          conversation_id: conversationId,
          expected_state_version: Number.MAX_SAFE_INTEGER,
        },
        user_message_id: messageId,
        run_target: makeAgentTarget({
          accepted_conversation_state_version: Number.MAX_SAFE_INTEGER,
        }),
      }),
    ).toThrowError(/RUN_CONVERSATION_CAS_OVERFLOW/);
    expect(() =>
      prepareConversationChatCas({
        conversation: makeConversation(),
        cas: {
          schema_version: 'conversation-state-cas/1',
          workspace_id: workspaceId,
          conversation_id: conversationId,
          expected_state_version: 0,
        },
        user_message_id: messageId,
        run_target: makeAgentTarget({ user_message_id: requestId }),
      }),
    ).toThrowError(/RUN_CONVERSATION_IDENTITY_MISMATCH/);
  });
});
