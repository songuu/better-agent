import { formatBrowserSessionToken } from '@better-agent/auth';
import {
  prepareCanonicalAcceptanceReceipt,
  prepareCanonicalRunIntent,
} from '@better-agent/run-core';
import { describe, expect, it, vi } from 'vitest';

import { createAuthBoundary } from '../src/modules/auth/index.js';
import {
  createRunBoundary,
  type RunBoundaryDependencies,
  type RunDatabaseTransaction,
} from '../src/modules/runs/index.js';

const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303ee2';
const browserSessionId = '018f47f2-c541-7cc6-9292-4a2c35303ee3';
const principalId = '018f47f2-c541-7cc6-9292-4a2c35303ee4';
const deploymentId = '018f47f2-c541-7cc6-9292-4a2c35303ee5';
const conversationId = '018f47f2-c541-7cc6-9292-4a2c35303ee6';
const runId = '018f47f2-c541-7cc6-9292-4a2c35303ee7';
const acceptedRequestId = '018f47f2-c541-7cc6-9292-4a2c35303ee8';
const exchangeRequestId = '018f47f2-c541-7cc6-9292-4a2c35303ee9';
const secondExchangeRequestId = '018f47f2-c541-7cc6-9292-4a2c35303eea';
const secondRunId = '018f47f2-c541-7cc6-9292-4a2c35303eeb';
const token = formatBrowserSessionToken({
  browserSessionId,
  secret: Buffer.alloc(32, 6),
});
const request = {
  robot_id: 'agent-public',
  conversation_id: conversationId,
  content: 'browser hello',
  inputs: { value: 1 },
} as const;
const intent = prepareCanonicalRunIntent({ route: '/v1/oapi/agent/chat', request });
const receipt = prepareCanonicalAcceptanceReceipt({
  http_status: 202,
  run_id: runId,
  accepted_request_id: acceptedRequestId,
  conversation_id: conversationId,
});

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function identityFacts() {
  return {
    workspaceId,
    browserSessionId,
    endUserPrincipalId: principalId,
    agentDeploymentId: deploymentId,
    sessionAuthorizationEpoch: 3,
    principalAuthorizationEpoch: 5,
    deploymentAuthorizationEpoch: 7,
  };
}

function databaseIdentityFacts() {
  return {
    workspace_id: workspaceId,
    browser_session_id: browserSessionId,
    end_user_principal_id: principalId,
    agent_deployment_id: deploymentId,
    session_epoch: 3,
    observed_principal_session_epoch: 5,
    observed_deployment_revoke_epoch: 7,
  };
}

const trustedBrowserRequestContext = {
  actualOrigin: 'https://agent.example.com',
  tokenAudience: 'agent_browser_api' as const,
  clientChannel: 'WEB_SDK' as const,
};

function authorizationFacts() {
  return {
    acceptedPrincipal: {
      schema_version: 'conversation-principal/1' as const,
      kind: 'end_user' as const,
      end_user_principal_id: principalId,
    },
    authorizedScope: 'run:read' as const,
    browserSessionId,
    deploymentAuthorizationEpoch: 7,
    deploymentId,
    principalAuthorizationEpoch: 5,
    runId,
    sessionAuthorizationEpoch: 3,
    targetKind: 'agent' as const,
    workspaceId,
  };
}

function createFixture(
  options: {
    readonly identity?: unknown;
    readonly authorization?: unknown;
    readonly miss?: boolean;
    readonly requestIds?: readonly string[];
    readonly nowTimes?: readonly number[];
  } = {},
) {
  const trace: string[] = [];
  let verifierReference: Uint8Array | undefined;
  const activePointerResolver = vi.fn();
  const conversationLoader = vi.fn();
  const transaction = {
    authenticateCredential: vi.fn(async () => null),
    trustedBrowserRequestContext: vi.fn(() => trustedBrowserRequestContext),
    authenticateBrowserSessionIdentity: vi.fn(async (command) => {
      trace.push('browser:identity');
      verifierReference = command.verifier;
      return options.identity ?? databaseIdentityFacts();
    }),
    lockExistingRunIdempotencyNamespace: vi.fn(async (command) => {
      trace.push('lock:key');
      if (options.miss === true) return null;
      return { namespace: command.namespace, intentHash: intent.intent_hash, receipt, runId };
    }),
    authorizeServiceOriginalRun: vi.fn(async () => null),
    authorizeBrowserOriginalRun: vi.fn(async () => {
      trace.push('browser:persisted-target');
      return Object.hasOwn(options, 'authorization') ? options.authorization : authorizationFacts();
    }),
    requestRunCancellation: vi.fn(async () => ({ outcome: 'NOT_FOUND' as const })),
    authenticateBrowserSessionFacts: activePointerResolver,
    loadConversationForAgentChat: conversationLoader,
  } as RunDatabaseTransaction & {
    authenticateBrowserSessionFacts: ReturnType<typeof vi.fn>;
    loadConversationForAgentChat: ReturnType<typeof vi.fn>;
  };
  const withTransaction = vi.fn(async function withOwnedTransaction<T>(
    callback: (owned: RunDatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    trace.push('transaction');
    return callback(transaction);
  });
  const providerPepper = Buffer.alloc(32, 10);
  let requestIndex = 0;
  let timeIndex = 0;
  const boundary = createRunBoundary({
    authBoundary: createAuthBoundary({ accessKeyPepper: async () => Buffer.alloc(32, 9) }),
    browserSessionPepper: async () => providerPepper,
    currentRequestId: () => options.requestIds?.[requestIndex++] ?? exchangeRequestId,
    currentUnixTime: () => options.nowTimes?.[timeIndex++] ?? 1_777_777_778,
    withTransaction: withTransaction as unknown as RunBoundaryDependencies['withTransaction'],
  });
  return {
    activePointerResolver,
    boundary,
    conversationLoader,
    providerPepper,
    trace,
    transaction,
    verifierReference: () => verifierReference,
    withTransaction,
  };
}

describe('G0-06 browser original-Run replay boundary', () => {
  it('keeps pointer-free identity, namespace lock and persisted-target authorization in one transaction', async () => {
    const fixture = createFixture();

    const result = await fixture.boundary.replayBrowserAgentChat({
      browserSessionToken: token,
      declaredWorkspaceId: workspaceId,
      idempotencyKey: 'browser-key',
      request,
    });

    expect(fixture.trace).toEqual([
      'transaction',
      'browser:identity',
      'lock:key',
      'browser:persisted-target',
    ]);
    expect(fixture.transaction.trustedBrowserRequestContext).toHaveBeenCalledTimes(1);
    expect(fixture.transaction.authenticateBrowserSessionIdentity).toHaveBeenCalledWith({
      browserSessionId,
      declaredWorkspaceId: workspaceId,
      verifier: expect.any(Uint8Array),
      ...trustedBrowserRequestContext,
    });
    expect(fixture.transaction.lockExistingRunIdempotencyNamespace).toHaveBeenCalledWith({
      namespace: {
        schema_version: 'run-idempotency-namespace/1',
        workspace_id: workspaceId,
        authenticated_principal: {
          schema_version: 'conversation-principal/1',
          kind: 'end_user',
          end_user_principal_id: principalId,
        },
        fixed_route: '/v1/oapi/agent/chat',
        idempotency_key: 'browser-key',
      },
      browserIdentity: identityFacts(),
    });
    expect(fixture.transaction.authorizeBrowserOriginalRun).toHaveBeenCalledWith({
      ...identityFacts(),
      runId,
      targetKind: 'agent',
      requiredScope: 'run:read',
    });
    expect(result).toEqual({
      code: 202,
      success: true,
      message: 'accepted',
      request_id: exchangeRequestId,
      data: receipt.data,
      now_time: 1_777_777_778,
    });
    expect([...(fixture.verifierReference() ?? [])]).toEqual(Array(32).fill(0));
    expect([...fixture.providerPepper]).toEqual(Array(32).fill(10));
    expect(fixture.activePointerResolver).not.toHaveBeenCalled();
    expect(fixture.conversationLoader).not.toHaveBeenCalled();
  });

  it('snapshots browser replay input before session authentication yields', async () => {
    const authenticationEntered = createDeferred();
    const releaseAuthentication = createDeferred();
    const fixture = createFixture();
    vi.mocked(fixture.transaction.authenticateBrowserSessionIdentity).mockImplementation(
      async () => {
        fixture.trace.push('browser:identity');
        authenticationEntered.resolve();
        await releaseAuthentication.promise;
        return databaseIdentityFacts();
      },
    );
    const mutableInput = {
      browserSessionToken: token,
      declaredWorkspaceId: workspaceId,
      idempotencyKey: 'browser-key',
      request: {
        robot_id: request.robot_id,
        conversation_id: conversationId,
        content: request.content,
        inputs: { value: 1 },
      },
    };

    const pending = fixture.boundary.replayBrowserAgentChat(mutableInput);
    await authenticationEntered.promise;
    mutableInput.idempotencyKey = 'mutated-browser-key';
    mutableInput.request.conversation_id = secondRunId;
    releaseAuthentication.resolve();

    await expect(pending).resolves.toMatchObject({ code: 202, data: receipt.data });
    expect(fixture.transaction.lockExistingRunIdempotencyNamespace).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: expect.objectContaining({ idempotency_key: 'browser-key' }),
      }),
    );
  });

  it('stops a miss after identity and key lookup without application side effects', async () => {
    const fixture = createFixture({ miss: true });

    await expect(
      fixture.boundary.replayBrowserAgentChat({
        browserSessionToken: token,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'missing-key',
        request,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_PLAN_PROVIDER_UNAVAILABLE' }));
    expect(fixture.trace).toEqual(['transaction', 'browser:identity', 'lock:key']);
    expect(fixture.transaction.authorizeBrowserOriginalRun).not.toHaveBeenCalled();

    const unkeyed = createFixture();
    await expect(
      unkeyed.boundary.replayBrowserAgentChat({
        browserSessionToken: token,
        declaredWorkspaceId: workspaceId,
        request,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_PLAN_PROVIDER_UNAVAILABLE' }));
    expect(unkeyed.withTransaction).not.toHaveBeenCalled();
  });

  it('fails closed on end-user, stable Deployment or epoch drift', async () => {
    const wrongId = '018f47f2-c541-7cc6-9292-4a2c35303eef';
    for (const authorization of [
      {
        ...authorizationFacts(),
        acceptedPrincipal: {
          ...authorizationFacts().acceptedPrincipal,
          end_user_principal_id: wrongId,
        },
      },
      { ...authorizationFacts(), deploymentId: wrongId },
      { ...authorizationFacts(), sessionAuthorizationEpoch: 4 },
      { ...authorizationFacts(), principalAuthorizationEpoch: 6 },
      { ...authorizationFacts(), deploymentAuthorizationEpoch: 8 },
    ]) {
      const fixture = createFixture({ authorization });
      await expect(
        fixture.boundary.replayBrowserAgentChat({
          browserSessionToken: token,
          declaredWorkspaceId: workspaceId,
          idempotencyKey: 'browser-key',
          request,
        }),
      ).rejects.toEqual(expect.objectContaining({ code: 'RUN_NOT_FOUND' }));
      expect(fixture.activePointerResolver).not.toHaveBeenCalled();
    }
  });

  it('authorizes an unreadable persisted target before comparing browser intent and performs no application side effects', async () => {
    const fixture = createFixture({ authorization: null });
    const admission = vi.fn();
    const conversation = vi.fn();
    const plan = vi.fn();
    const billing = vi.fn();
    const event = vi.fn();
    const outbox = vi.fn();
    Object.assign(fixture.transaction, {
      resolveAgentAdmission: admission,
      loadConversation: conversation,
      loadPlan: plan,
      reserveBilling: billing,
      appendRunEvent: event,
      enqueueOutbox: outbox,
    });

    await expect(
      fixture.boundary.replayBrowserAgentChat({
        browserSessionToken: token,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'browser-key',
        request: { ...request, content: 'different intent' },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_NOT_FOUND' }));
    expect(fixture.trace.at(-1)).toBe('browser:persisted-target');
    for (const forbidden of [admission, conversation, plan, billing, event, outbox]) {
      expect(forbidden).not.toHaveBeenCalled();
    }
  });

  it('keeps persisted replay data stable while rebuilding current request and time facts', async () => {
    const fixture = createFixture({
      requestIds: [exchangeRequestId, secondExchangeRequestId],
      nowTimes: [1_777_777_778, 1_777_777_779],
    });
    const input = {
      browserSessionToken: token,
      declaredWorkspaceId: workspaceId,
      idempotencyKey: 'browser-key',
      request,
    } as const;

    const first = await fixture.boundary.replayBrowserAgentChat(input);
    const second = await fixture.boundary.replayBrowserAgentChat(input);

    expect(first.data).toEqual(second.data);
    expect(first.data.accepted_request_id).toBe(acceptedRequestId);
    expect(first.request_id).toBe(exchangeRequestId);
    expect(second.request_id).toBe(secondExchangeRequestId);
    expect(first.now_time).toBe(1_777_777_778);
    expect(second.now_time).toBe(1_777_777_779);
  });

  it('cancels through pointer-free identity, current persisted target authorization and one definer', async () => {
    const fixture = createFixture();
    let storedRunId: string | undefined;
    vi.mocked(fixture.transaction.requestRunCancellation).mockImplementation(async (command) => {
      fixture.trace.push('definer:request_run_cancellation');
      if (storedRunId !== undefined && storedRunId !== command.runId) {
        return { outcome: 'CONFLICT' as const };
      }
      const outcome = storedRunId === undefined ? 'ACCEPTED' : 'REPLAY';
      storedRunId = command.runId;
      return {
        outcome,
        receipt: {
          http_status: 202,
          data: {
            run_id: command.runId,
            accepted_request_id: acceptedRequestId,
            status: 'CANCEL_REQUESTED',
            operation_url: `/v1/oapi/runs/${command.runId}`,
            events_url: `/v1/oapi/runs/${command.runId}/events`,
          },
        },
      };
    });
    const event = vi.fn();
    const outbox = vi.fn();
    Object.assign(fixture.transaction, { appendRunEvent: event, enqueueOutbox: outbox });
    const input = {
      browserSessionToken: token,
      declaredWorkspaceId: workspaceId,
      idempotencyKey: 'browser-cancel-key',
      runId,
    } as const;

    const first = await fixture.boundary.requestBrowserCancellation(input);
    const replay = await fixture.boundary.requestBrowserCancellation(input);
    await expect(
      fixture.boundary.requestBrowserCancellation({ ...input, runId: secondRunId }),
    ).rejects.toEqual(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }));

    expect(first.data).toEqual(replay.data);
    expect(fixture.trace.slice(0, 3)).toEqual([
      'transaction',
      'browser:identity',
      'definer:request_run_cancellation',
    ]);
    expect(fixture.transaction.authorizeBrowserOriginalRun).not.toHaveBeenCalled();
    expect(fixture.transaction.requestRunCancellation).toHaveBeenCalledWith(
      expect.objectContaining({
        browserIdentity: identityFacts(),
        authenticatedPrincipal: {
          schema_version: 'conversation-principal/1',
          kind: 'end_user',
          end_user_principal_id: principalId,
        },
        idempotencyKey: 'browser-cancel-key',
        runId,
      }),
    );
    expect(
      vi.mocked(fixture.transaction.requestRunCancellation).mock.calls[0]?.[0],
    ).not.toHaveProperty('intentHash');
    expect(fixture.activePointerResolver).not.toHaveBeenCalled();
    expect(event).not.toHaveBeenCalled();
    expect(outbox).not.toHaveBeenCalled();
  });

  it('snapshots browser cancellation input before session authentication yields', async () => {
    const authenticationEntered = createDeferred();
    const releaseAuthentication = createDeferred();
    const fixture = createFixture();
    vi.mocked(fixture.transaction.authenticateBrowserSessionIdentity).mockImplementation(
      async () => {
        fixture.trace.push('browser:identity');
        authenticationEntered.resolve();
        await releaseAuthentication.promise;
        return databaseIdentityFacts();
      },
    );
    vi.mocked(fixture.transaction.requestRunCancellation).mockResolvedValue({
      outcome: 'ACCEPTED' as const,
      receipt: {
        http_status: 202,
        data: {
          run_id: runId,
          accepted_request_id: acceptedRequestId,
          status: 'CANCEL_REQUESTED',
          operation_url: `/v1/oapi/runs/${runId}`,
          events_url: `/v1/oapi/runs/${runId}/events`,
        },
      },
    });
    const mutableInput = {
      browserSessionToken: token,
      declaredWorkspaceId: workspaceId,
      idempotencyKey: 'browser-cancel-key',
      runId,
    };

    const pending = fixture.boundary.requestBrowserCancellation(mutableInput);
    await authenticationEntered.promise;
    mutableInput.idempotencyKey = 'mutated-browser-cancel-key';
    mutableInput.runId = secondRunId;
    releaseAuthentication.resolve();

    await expect(pending).resolves.toMatchObject({ code: 202, data: { run_id: runId } });
    expect(fixture.transaction.requestRunCancellation).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'browser-cancel-key', runId }),
    );
  });

  it('passes unkeyed cancellation as key=null and accepts a terminal 200 from the same definer', async () => {
    const unkeyed = createFixture();
    vi.mocked(unkeyed.transaction.requestRunCancellation).mockImplementation(async (command) => ({
      outcome: 'ACCEPTED' as const,
      receipt: {
        http_status: 202,
        data: {
          run_id: command.runId,
          accepted_request_id: acceptedRequestId,
          status: 'CANCEL_REQUESTED',
          operation_url: `/v1/oapi/runs/${command.runId}`,
          events_url: `/v1/oapi/runs/${command.runId}/events`,
        },
      },
    }));
    await expect(
      unkeyed.boundary.requestBrowserCancellation({
        browserSessionToken: token,
        declaredWorkspaceId: workspaceId,
        runId,
      }),
    ).resolves.toMatchObject({ code: 202, data: { run_id: runId } });
    expect(unkeyed.transaction.requestRunCancellation).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: null }),
    );
    expect(unkeyed.transaction.lockExistingRunIdempotencyNamespace).not.toHaveBeenCalled();

    const terminal = createFixture();
    vi.mocked(terminal.transaction.requestRunCancellation).mockResolvedValue({
      outcome: 'REPLAY' as const,
      receipt: {
        http_status: 200,
        data: {
          run_id: runId,
          accepted_request_id: acceptedRequestId,
          status: 'CANCELLED',
          last_sequence: '10',
          error: { code: 'USER_CANCELLED', retryable: false, category: 'EXECUTION' },
          billing_pending: false,
          billing_state: 'SETTLED',
          billing_settled_at: '2026-08-27T00:00:00.000Z',
        },
      },
    });
    await expect(
      terminal.boundary.requestBrowserCancellation({
        browserSessionToken: token,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'terminal-key',
        runId,
      }),
    ).resolves.toMatchObject({ code: 200, data: { run_id: runId, status: 'CANCELLED' } });
  });

  it('stops browser cancellation after current-target authorization failure with zero Event/Outbox', async () => {
    const fixture = createFixture();
    vi.mocked(fixture.transaction.requestRunCancellation).mockImplementation(async () => {
      fixture.trace.push('definer:request_run_cancellation');
      return { outcome: 'NOT_FOUND' as const };
    });
    const event = vi.fn();
    const outbox = vi.fn();
    Object.assign(fixture.transaction, { appendRunEvent: event, enqueueOutbox: outbox });

    await expect(
      fixture.boundary.requestBrowserCancellation({
        browserSessionToken: token,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'browser-cancel-key',
        runId,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_NOT_FOUND' }));
    expect(fixture.transaction.requestRunCancellation).toHaveBeenCalledTimes(1);
    expect(fixture.transaction.authorizeBrowserOriginalRun).not.toHaveBeenCalled();
    expect(fixture.activePointerResolver).not.toHaveBeenCalled();
    expect(event).not.toHaveBeenCalled();
    expect(outbox).not.toHaveBeenCalled();
  });

  it('rejects authority fields before opening a transaction', async () => {
    const fixture = createFixture();
    for (const injected of [
      { actualOrigin: 'https://attacker.example.com' },
      { tokenAudience: 'agent_browser_api' },
      { clientChannel: 'WEB_SDK' },
      { publicSelector: 'agent-public' },
      { principalId },
      { deploymentId },
      { revisionId: runId },
      { admissionSnapshot: {} },
      { acceptedPlanHash: `sha256:${'a'.repeat(64)}` },
      { transaction: fixture.transaction },
    ]) {
      await expect(
        fixture.boundary.replayBrowserAgentChat({
          browserSessionToken: token,
          declaredWorkspaceId: workspaceId,
          idempotencyKey: 'browser-key',
          request,
          ...injected,
        } as never),
      ).rejects.toEqual(expect.objectContaining({ code: 'RUN_BOUNDARY_INPUT_INVALID' }));
    }
    for (const injected of [
      { actualOrigin: 'https://attacker.example.com' },
      { tokenAudience: 'agent_browser_api' },
      { clientChannel: 'WEB_SDK' },
      { principalId },
      { deploymentId },
      { revisionId: runId },
      { snapshot: {} },
      { acceptedPlanHash: `sha256:${'a'.repeat(64)}` },
      { transaction: fixture.transaction },
    ]) {
      await expect(
        fixture.boundary.requestBrowserCancellation({
          browserSessionToken: token,
          declaredWorkspaceId: workspaceId,
          idempotencyKey: 'browser-cancel-key',
          runId,
          ...injected,
        } as never),
      ).rejects.toEqual(expect.objectContaining({ code: 'RUN_BOUNDARY_INPUT_INVALID' }));
    }
    expect(fixture.withTransaction).not.toHaveBeenCalled();
  });
});
