import { formatAccessKey, formatBrowserSessionToken } from '@better-agent/auth';
import { describe, expect, it, vi } from 'vitest';

import { createAuthBoundary } from '../src/modules/auth/index.js';
import { prepareAgentChatConversationInTransaction } from '../src/modules/conversations/conversation-transaction.js';
import {
  type ConversationBoundaryDependencies,
  type ConversationDatabaseTransaction,
  createConversationBoundary,
} from '../src/modules/conversations/index.js';

const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303ee2';
const credentialId = '018f47f2-c541-7cc6-9292-4a2c35303ee3';
const keyId = '018f47f2-c541-7cc6-9292-4a2c35303ee4';
const conversationId = '018f47f2-c541-7cc6-9292-4a2c35303ee5';
const deploymentId = '018f47f2-c541-7cc6-9292-4a2c35303ee6';
const revisionId = '018f47f2-c541-7cc6-9292-4a2c35303ee7';
const requestId = '018f47f2-c541-7cc6-9292-4a2c35303ee8';
const browserSessionId = '018f47f2-c541-7cc6-9292-4a2c35303ee9';
const endUserPrincipalId = '018f47f2-c541-7cc6-9292-4a2c35303eea';
const userMessageId = '018f47f2-c541-7cc6-9292-4a2c35303eeb';
const agentId = '018f47f2-c541-7cc6-9292-4a2c35303eec';
const agentReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303eed';
const experienceReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303eee';
const accessKey = formatAccessKey({ keyId, secret: Buffer.alloc(32, 7) });
const browserToken = formatBrowserSessionToken({
  browserSessionId,
  secret: Buffer.alloc(32, 6),
});

function conversation() {
  return {
    schema_version: 'conversation/1' as const,
    workspace_id: workspaceId,
    conversation_id: conversationId,
    principal: {
      schema_version: 'conversation-principal/1' as const,
      kind: 'credential' as const,
      credential_id: credentialId,
    },
    agent_deployment_id: deploymentId,
    created_under_agent_deployment_revision_id: revisionId,
    conversation_contract_hash: `sha256:${'a'.repeat(64)}`,
    state_version: 0,
  };
}

function resolvedAuthority(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId,
    publicRobotId: 'agent-public',
    agentDeploymentId: deploymentId,
    activeRevisionId: revisionId,
    conversationContractHash: `sha256:${'a'.repeat(64)}`,
    ...overrides,
  };
}

function createTransaction(trace: string[]): ConversationDatabaseTransaction {
  return {
    authenticateCredential: vi.fn(async () => {
      trace.push('authenticate:create-conversation');
      return {
        credentialId,
        credentialAuthorizationEpoch: 7,
        credentialKind: 'service_api' as const,
        scopes: ['agent:conversation:write'] as const,
        workspaceId,
        workspaceAuthorizationEpoch: 11,
      };
    }),
    trustedBrowserRequestContext: vi.fn(() => ({
      actualOrigin: 'https://agent.example.com',
      tokenAudience: 'agent_browser_api' as const,
      clientChannel: 'WEB_SDK' as const,
    })),
    authenticateBrowserSessionIdentity: vi.fn(async () => null),
    createAgentConversation: vi.fn(async (command) => {
      trace.push('create:conversation');
      return {
        conversation: conversation(),
        resolvedAuthority: resolvedAuthority({ publicRobotId: command.publicRobotId }),
        publicRobotId: command.publicRobotId,
        createdAt: '2026-08-27T01:00:00Z',
        title: command.title,
        clientType: command.clientType,
      };
    }),
    loadAgentChatConversation: vi.fn(async () => conversation()),
  };
}

function createFixture(
  transactionFactory: (trace: string[]) => ConversationDatabaseTransaction = createTransaction,
) {
  const trace: string[] = [];
  const transaction = transactionFactory(trace);
  const withTransaction = vi.fn(async function withOwnedTransaction<T>(
    callback: (owned: ConversationDatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    trace.push('transaction');
    return callback(transaction);
  });
  const boundary = createConversationBoundary({
    authBoundary: createAuthBoundary({ accessKeyPepper: async () => Buffer.alloc(32, 9) }),
    browserSessionPepper: async () => Buffer.alloc(32, 10),
    currentRequestId: () => requestId,
    currentUnixTime: () => 1_777_777_779,
    withTransaction:
      withTransaction as unknown as ConversationBoundaryDependencies['withTransaction'],
  });
  return { boundary, trace, transaction, withTransaction };
}

describe('G0-06 internal Conversation create boundary', () => {
  it('clones and recursively freezes variables before the first async authorization boundary', async () => {
    const fixture = createFixture();
    const variables = {
      locale: 'zh-CN',
      nested: { items: [{ value: 'before' }] },
    };

    const pending = fixture.boundary.createServiceConversation({
      accessKey,
      declaredWorkspaceId: workspaceId,
      request: { robot_id: 'agent-public', variables },
    });
    const callerItem = variables.nested.items[0];
    if (callerItem === undefined) throw new Error('expected the caller variable item');
    callerItem.value = 'after';
    await pending;

    const command = vi.mocked(fixture.transaction.createAgentConversation).mock.calls[0]?.[0];
    expect(command?.variables).toEqual({
      locale: 'zh-CN',
      nested: { items: [{ value: 'before' }] },
    });
    expect(command?.variables).not.toBe(variables);
    const commandVariables = command?.variables;
    if (commandVariables === undefined) throw new Error('expected validated variables');
    const nested = commandVariables.nested as { items: Array<{ value: string }> };
    expect(Object.isFrozen(commandVariables)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(nested.items)).toBe(true);
    expect(Object.isFrozen(nested.items[0])).toBe(true);
  });

  it('derives the principal from route authentication and returns only public conversation data', async () => {
    const { boundary, trace, transaction } = createFixture();

    const result = await boundary.createServiceConversation({
      accessKey,
      declaredWorkspaceId: workspaceId,
      request: {
        robot_id: 'agent-public',
        title: 'Research',
        variables: { language: 'zh-CN' },
        client_type: 'PC',
      },
    });

    expect(trace).toEqual([
      'transaction',
      'authenticate:create-conversation',
      'create:conversation',
    ]);
    expect(transaction.createAgentConversation).toHaveBeenCalledWith({
      workspaceId,
      principal: {
        schema_version: 'conversation-principal/1',
        kind: 'credential',
        credential_id: credentialId,
      },
      publicRobotId: 'agent-public',
      title: 'Research',
      variables: { language: 'zh-CN' },
      clientType: 'PC',
    });
    expect(result).toEqual({
      code: 201,
      success: true,
      message: 'created',
      request_id: requestId,
      data: {
        conversation_id: conversationId,
        robot_id: 'agent-public',
        title: 'Research',
        client_type: 'PC',
        created_at: '2026-08-27T01:00:00Z',
      },
      now_time: 1_777_777_779,
    });
    expect(result).not.toHaveProperty('data.principal');
    expect(result).not.toHaveProperty('data.created_under_agent_deployment_revision_id');
    expect(result).not.toHaveProperty('data.conversation_contract_hash');
  });

  it('rejects idempotency, principal, revision, contract and transaction injection before I/O', async () => {
    const { boundary, withTransaction } = createFixture();
    for (const injected of [
      { idempotencyKey: 'not-supported' },
      { principal: { kind: 'credential', credential_id: credentialId } },
      { agentDeploymentId: deploymentId },
      { createdRevisionId: revisionId },
      { conversationContractHash: `sha256:${'a'.repeat(64)}` },
      { state_version: 0 },
      { next_state_version: 1 },
      { transaction: {} },
    ]) {
      await expect(
        boundary.createServiceConversation({
          accessKey,
          declaredWorkspaceId: workspaceId,
          request: { robot_id: 'agent-public' },
          ...injected,
        } as never),
      ).rejects.toEqual(expect.objectContaining({ code: 'CONVERSATION_BOUNDARY_INPUT_INVALID' }));
    }
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('derives browser principal and stable Deployment from pointer-free session identity', async () => {
    let verifierReference: Uint8Array | undefined;
    const activePointerResolver = vi.fn();
    const providerPepper = Buffer.alloc(32, 10);
    const fixture = createFixture((trace) => {
      const transaction = {
        authenticateCredential: vi.fn(async () => null),
        trustedBrowserRequestContext: vi.fn(() => ({
          actualOrigin: 'https://agent.example.com',
          tokenAudience: 'agent_browser_api' as const,
          clientChannel: 'WEB_SDK' as const,
        })),
        authenticateBrowserSessionIdentity: vi.fn(async (command) => {
          trace.push('browser:identity');
          verifierReference = command.verifier;
          return {
            workspace_id: workspaceId,
            browser_session_id: browserSessionId,
            end_user_principal_id: endUserPrincipalId,
            agent_deployment_id: deploymentId,
            session_epoch: 3,
            observed_principal_session_epoch: 5,
            observed_deployment_revoke_epoch: 7,
          };
        }),
        createAgentConversation: vi.fn(async (command) => {
          trace.push('create:conversation');
          return {
            conversation: {
              ...conversation(),
              principal: {
                schema_version: 'conversation-principal/1' as const,
                kind: 'end_user' as const,
                end_user_principal_id: endUserPrincipalId,
              },
            },
            resolvedAuthority: resolvedAuthority({ publicRobotId: command.publicRobotId }),
            publicRobotId: command.publicRobotId,
            createdAt: '2026-08-27T01:00:00Z',
          };
        }),
        loadAgentChatConversation: vi.fn(async () => null),
        authenticateBrowserSessionFacts: activePointerResolver,
      } as ConversationDatabaseTransaction & {
        authenticateBrowserSessionFacts: ReturnType<typeof vi.fn>;
      };
      return transaction;
    });
    const boundary = createConversationBoundary({
      authBoundary: createAuthBoundary({ accessKeyPepper: async () => Buffer.alloc(32, 9) }),
      browserSessionPepper: async () => providerPepper,
      currentRequestId: () => requestId,
      currentUnixTime: () => 1_777_777_779,
      withTransaction:
        fixture.withTransaction as unknown as ConversationBoundaryDependencies['withTransaction'],
    });

    const result = await boundary.createBrowserConversation({
      browserSessionToken: browserToken,
      declaredWorkspaceId: workspaceId,
      request: { robot_id: 'agent-public' },
    });

    expect(fixture.trace).toEqual(['transaction', 'browser:identity', 'create:conversation']);
    expect(fixture.transaction.authenticateBrowserSessionIdentity).toHaveBeenCalledWith({
      actualOrigin: 'https://agent.example.com',
      browserSessionId,
      clientChannel: 'WEB_SDK',
      declaredWorkspaceId: workspaceId,
      tokenAudience: 'agent_browser_api',
      verifier: expect.any(Uint8Array),
    });
    expect(fixture.transaction.createAgentConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        publicRobotId: 'agent-public',
        principal: {
          schema_version: 'conversation-principal/1',
          kind: 'end_user',
          end_user_principal_id: endUserPrincipalId,
        },
        agentDeploymentId: deploymentId,
        browserIdentity: expect.objectContaining({
          browserSessionId,
          agentDeploymentId: deploymentId,
        }),
      }),
    );
    expect(result.data.conversation_id).toBe(conversationId);
    expect([...(verifierReference ?? [])]).toEqual(Array(32).fill(0));
    expect([...providerPepper]).toEqual(Array(32).fill(10));
    expect(activePointerResolver).not.toHaveBeenCalled();
  });

  it('rejects nested and outer authority injection for service and browser before I/O', async () => {
    const service = createFixture();
    const browser = createFixture();
    const injected = [
      { principal: { kind: 'credential', credential_id: credentialId } },
      { agentDeploymentId: deploymentId },
      { activeRevisionId: revisionId },
      { conversationContractHash: `sha256:${'a'.repeat(64)}` },
      { state_version: 0 },
      { transaction: {} },
    ];
    for (const authority of injected) {
      await expect(
        service.boundary.createServiceConversation({
          accessKey,
          declaredWorkspaceId: workspaceId,
          request: { robot_id: 'agent-public', ...authority } as never,
        }),
      ).rejects.toEqual(expect.objectContaining({ code: 'CONVERSATION_BOUNDARY_INPUT_INVALID' }));
      await expect(
        browser.boundary.createBrowserConversation({
          browserSessionToken: browserToken,
          declaredWorkspaceId: workspaceId,
          request: { robot_id: 'agent-public', ...authority } as never,
        }),
      ).rejects.toEqual(expect.objectContaining({ code: 'CONVERSATION_BOUNDARY_INPUT_INVALID' }));
    }
    expect(service.withTransaction).not.toHaveBeenCalled();
    expect(browser.withTransaction).not.toHaveBeenCalled();
  });

  it('requires authoritative active revision and contract facts to match the created Conversation', async () => {
    for (const authority of [
      resolvedAuthority({ activeRevisionId: requestId }),
      resolvedAuthority({ conversationContractHash: `sha256:${'b'.repeat(64)}` }),
      resolvedAuthority({ agentDeploymentId: requestId }),
      resolvedAuthority({ publicRobotId: 'different-agent' }),
    ]) {
      const fixture = createFixture((trace) => {
        const transaction = createTransaction(trace);
        transaction.createAgentConversation = vi.fn(async () => ({
          conversation: conversation(),
          resolvedAuthority: authority,
          publicRobotId: 'agent-public',
          createdAt: '2026-08-27T01:00:00Z',
        }));
        return transaction;
      });
      await expect(
        fixture.boundary.createServiceConversation({
          accessKey,
          declaredWorkspaceId: workspaceId,
          request: { robot_id: 'agent-public' },
        }),
      ).rejects.toEqual(expect.objectContaining({ code: 'CONVERSATION_CREATE_FAILED' }));
    }
  });

  it('rejects a real Flow family/cardinality proof before creating an Agent Conversation', async () => {
    const transaction = createTransaction([]);
    transaction.authenticateCredential = vi.fn(async () => ({
      credentialId,
      credentialAuthorizationEpoch: 7,
      credentialKind: 'service_api' as const,
      scopes: ['flow:run:create'] as const,
      workspaceId,
      workspaceAuthorizationEpoch: 11,
    }));
    const realAuth = createAuthBoundary({ accessKeyPepper: async () => Buffer.alloc(32, 9) });
    const wrongAuthenticator = realAuth.bindServiceRoute({
      method: 'POST',
      operationId: 'createFlowRun',
      routeTemplate: '/v1/oapi/flow/run',
    });
    const boundary = createConversationBoundary({
      authBoundary: { bindServiceRoute: () => wrongAuthenticator },
      browserSessionPepper: async () => Buffer.alloc(32, 10),
      currentRequestId: () => requestId,
      currentUnixTime: () => 1_777_777_779,
      withTransaction: async <T>(
        callback: (owned: ConversationDatabaseTransaction) => Promise<T>,
      ) => callback(transaction),
    });

    await expect(
      boundary.createServiceConversation({
        accessKey,
        declaredWorkspaceId: workspaceId,
        request: { robot_id: 'agent-public' },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'CONVERSATION_AUTHORIZATION_FAILED' }));
    expect(transaction.createAgentConversation).not.toHaveBeenCalled();
  });
});

describe('G0-06 package-private Agent Chat Conversation composition', () => {
  function runTarget(overrides: Record<string, unknown> = {}) {
    return {
      schema_version: 'run-target/1' as const,
      target_kind: 'agent' as const,
      agent_deployment_id: deploymentId,
      agent_deployment_revision_id: revisionId,
      agent_id: agentId,
      agent_release_id: agentReleaseId,
      experience_release_id: experienceReleaseId,
      conversation_id: conversationId,
      conversation_contract_hash: `sha256:${'a'.repeat(64)}`,
      accepted_conversation_state_version: 1,
      user_message_id: userMessageId,
      ...overrides,
    };
  }

  function chatTransaction(value: unknown = conversation()) {
    const appendUserMessage = vi.fn();
    const transaction = {
      authenticateCredential: vi.fn(async () => null),
      trustedBrowserRequestContext: vi.fn(() => ({
        actualOrigin: 'https://agent.example.com',
        tokenAudience: 'agent_browser_api' as const,
        clientChannel: 'WEB_SDK' as const,
      })),
      authenticateBrowserSessionIdentity: vi.fn(async () => null),
      createAgentConversation: vi.fn(async () => null),
      loadAgentChatConversation: vi.fn(async () => value),
      appendUserMessage,
    } as ConversationDatabaseTransaction & { appendUserMessage: ReturnType<typeof vi.fn> };
    return { appendUserMessage, transaction };
  }

  const principal = {
    schema_version: 'conversation-principal/1' as const,
    kind: 'credential' as const,
    credential_id: credentialId,
  };

  it('loads and prepares CAS on the caller-owned transaction without committing a user message', async () => {
    const { appendUserMessage, transaction } = chatTransaction();

    const result = await prepareAgentChatConversationInTransaction(transaction, {
      workspaceId,
      conversationId,
      principal,
      expectedStateVersion: 0,
      userMessageId,
      runTarget: runTarget(),
    });

    expect(transaction.loadAgentChatConversation).toHaveBeenCalledWith({
      workspaceId,
      conversationId,
      principal,
      agentDeploymentId: deploymentId,
    });
    expect(result.transition).toEqual({
      previous_state_version: 0,
      next_state_version: 1,
    });
    expect(Object.isFrozen(result.conversation)).toBe(true);
    expect(Object.isFrozen(result.conversation.principal)).toBe(true);
    expect(result.conversation.principal).not.toBe(principal);
    const loadCommand = vi.mocked(transaction.loadAgentChatConversation).mock.calls[0]?.[0];
    expect(Object.isFrozen(loadCommand?.principal)).toBe(true);
    expect(appendUserMessage).not.toHaveBeenCalled();
  });

  it('uses one canonical input snapshot across the asynchronous Conversation load', async () => {
    const { transaction } = chatTransaction();
    let resolveConversation = (_value: unknown): void => {
      throw new Error('conversation resolver was not initialized');
    };
    const pendingConversation = new Promise<unknown>((resolve) => {
      resolveConversation = resolve;
    });
    vi.mocked(transaction.loadAgentChatConversation).mockImplementation(() => pendingConversation);
    const mutablePrincipal = { ...principal };
    const mutableTarget = { ...runTarget() };
    const mutableInput = {
      workspaceId,
      conversationId,
      principal: mutablePrincipal,
      expectedStateVersion: 0,
      userMessageId,
      runTarget: mutableTarget,
    };

    const resultPromise = prepareAgentChatConversationInTransaction(transaction, mutableInput);
    expect(transaction.loadAgentChatConversation).toHaveBeenCalledTimes(1);

    mutableInput.workspaceId = requestId;
    mutableInput.conversationId = requestId;
    mutableInput.expectedStateVersion = 1;
    mutableInput.userMessageId = requestId;
    mutablePrincipal.credential_id = requestId;
    mutableTarget.conversation_id = requestId;
    mutableTarget.accepted_conversation_state_version = 2;
    mutableTarget.user_message_id = requestId;
    resolveConversation(conversation());

    await expect(resultPromise).resolves.toMatchObject({
      conversation: {
        workspace_id: workspaceId,
        conversation_id: conversationId,
      },
      transition: {
        previous_state_version: 0,
        next_state_version: 1,
      },
    });
    const loadCommand = vi.mocked(transaction.loadAgentChatConversation).mock.calls[0]?.[0];
    expect(loadCommand).toMatchObject({ workspaceId, conversationId, principal });
    expect(Object.isFrozen(loadCommand)).toBe(true);
    expect(Object.isFrozen(loadCommand?.principal)).toBe(true);
  });

  it('rejects stale state, contract/message mismatch and cross-principal rows', async () => {
    const stale = chatTransaction();
    await expect(
      prepareAgentChatConversationInTransaction(stale.transaction, {
        workspaceId,
        conversationId,
        principal,
        expectedStateVersion: 1,
        userMessageId,
        runTarget: runTarget(),
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'CONVERSATION_STALE' }));

    for (const target of [
      runTarget({ conversation_contract_hash: `sha256:${'b'.repeat(64)}` }),
      runTarget({ user_message_id: requestId }),
    ]) {
      const fixture = chatTransaction();
      await expect(
        prepareAgentChatConversationInTransaction(fixture.transaction, {
          workspaceId,
          conversationId,
          principal,
          expectedStateVersion: 0,
          userMessageId,
          runTarget: target,
        }),
      ).rejects.toEqual(expect.objectContaining({ code: 'CONVERSATION_CONTRACT_MISMATCH' }));
    }

    const crossPrincipal = chatTransaction({
      ...conversation(),
      principal: {
        schema_version: 'conversation-principal/1' as const,
        kind: 'credential' as const,
        credential_id: requestId,
      },
    });
    await expect(
      prepareAgentChatConversationInTransaction(crossPrincipal.transaction, {
        workspaceId,
        conversationId,
        principal,
        expectedStateVersion: 0,
        userMessageId,
        runTarget: runTarget(),
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'CONVERSATION_NOT_FOUND' }));
  });

  it('does not expose the transaction-scoped loader/CAS from the boundary object', () => {
    const { boundary } = createFixture();
    expect(boundary).not.toHaveProperty('loadAgentChatConversation');
    expect(boundary).not.toHaveProperty('prepareAgentChatConversation');
    expect(boundary).not.toHaveProperty('appendUserMessage');
  });
});
