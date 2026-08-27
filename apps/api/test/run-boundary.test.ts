import { formatAccessKey } from '@better-agent/auth';
import {
  prepareCanonicalAcceptanceReceipt,
  prepareCanonicalRunIntent,
} from '@better-agent/run-core';
import { describe, expect, it, vi } from 'vitest';

import { createAuthBoundary } from '../src/modules/auth/index.js';
import {
  createRunBoundary,
  type RunBoundaryDependencies,
  type RunBoundaryError,
  type RunDatabaseTransaction,
} from '../src/modules/runs/index.js';
import { mapRunTransactionSqlState } from '../src/modules/runs/run-transaction.js';

const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303ee2';
const credentialId = '018f47f2-c541-7cc6-9292-4a2c35303ee3';
const keyId = '018f47f2-c541-7cc6-9292-4a2c35303ee4';
const conversationId = '018f47f2-c541-7cc6-9292-4a2c35303ee5';
const runId = '018f47f2-c541-7cc6-9292-4a2c35303ee6';
const acceptedRequestId = '018f47f2-c541-7cc6-9292-4a2c35303ee7';
const exchangeRequestId = '018f47f2-c541-7cc6-9292-4a2c35303ee8';
const deploymentId = '018f47f2-c541-7cc6-9292-4a2c35303ee9';
const accessKey = formatAccessKey({ keyId, secret: Buffer.alloc(32, 7) });
const request = {
  robot_id: 'agent-public',
  conversation_id: conversationId,
  content: 'hello',
  inputs: { nested: { value: 1 } },
} as const;
const intent = prepareCanonicalRunIntent({ route: '/v1/oapi/agent/chat', request });
const flowRequest = { inputs: { value: 1 } } as const;
const flowIntent = prepareCanonicalRunIntent({
  route: '/v1/oapi/flow/run',
  request: flowRequest,
});
const receipt = prepareCanonicalAcceptanceReceipt({
  http_status: 202,
  run_id: runId,
  accepted_request_id: acceptedRequestId,
  conversation_id: conversationId,
});
const flowReceipt = prepareCanonicalAcceptanceReceipt({
  http_status: 202,
  run_id: runId,
  accepted_request_id: acceptedRequestId,
});
const secondRunId = '018f47f2-c541-7cc6-9292-4a2c35303eea';
const secondConversationId = '018f47f2-c541-7cc6-9292-4a2c35303eeb';
const terminalCancellationReceipt = {
  http_status: 200,
  data: {
    run_id: runId,
    accepted_request_id: acceptedRequestId,
    status: 'CANCELLED',
    last_sequence: '9',
    billing_pending: false,
    billing_state: 'SETTLED',
    billing_settled_at: '2026-08-27T00:00:00.000Z',
    error: {
      code: 'USER_CANCELLED',
      retryable: false,
      category: 'EXECUTION',
    },
  },
} as const;

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createTransaction(
  trace: string[],
  overrides: Partial<RunDatabaseTransaction> = {},
): RunDatabaseTransaction {
  let authenticationCount = 0;
  return {
    authenticateCredential: vi.fn(async () => {
      authenticationCount += 1;
      trace.push(authenticationCount === 1 ? 'authenticate:create' : 'authenticate:read');
      return {
        credentialId,
        credentialAuthorizationEpoch: 7,
        credentialKind: 'service_api' as const,
        scopes: ['agent:run:create', 'run:read', 'run:cancel'] as const,
        workspaceId,
        workspaceAuthorizationEpoch: 11,
      };
    }),
    lockExistingRunIdempotencyNamespace: vi.fn(async (command) => {
      trace.push('lock:key');
      return {
        namespace: command.namespace,
        intentHash: intent.intent_hash,
        receipt,
        runId,
      };
    }),
    authorizeServiceOriginalRun: vi.fn(async () => {
      trace.push('authorize:original-run');
      return {
        acceptedPrincipal: {
          schema_version: 'conversation-principal/1' as const,
          kind: 'credential' as const,
          credential_id: credentialId,
        },
        authorizedScope: 'run:read' as const,
        deploymentId,
        runId,
        targetKind: 'agent' as const,
        workspaceId,
      };
    }),
    trustedBrowserRequestContext: vi.fn(() => ({
      actualOrigin: 'https://agent.example.com',
      tokenAudience: 'agent_browser_api' as const,
      clientChannel: 'WEB_SDK' as const,
    })),
    authenticateBrowserSessionIdentity: vi.fn(async () => null),
    authorizeBrowserOriginalRun: vi.fn(async () => null),
    requestRunCancellation: vi.fn(async () => ({ outcome: 'NOT_FOUND' as const })),
    ...overrides,
  };
}

function createFixture(
  transactionFactory: (trace: string[]) => RunDatabaseTransaction = createTransaction,
) {
  const trace: string[] = [];
  const transaction = transactionFactory(trace);
  const withTransaction = vi.fn(async function withOwnedTransaction<T>(
    callback: (scoped: RunDatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    trace.push('transaction');
    return callback(transaction);
  });
  const boundary = createRunBoundary({
    authBoundary: createAuthBoundary({ accessKeyPepper: async () => Buffer.alloc(32, 9) }),
    browserSessionPepper: async () => Buffer.alloc(32, 10),
    currentRequestId: () => exchangeRequestId,
    currentUnixTime: () => 1_777_777_777,
    withTransaction: withTransaction as unknown as RunBoundaryDependencies['withTransaction'],
  });
  return { boundary, trace, transaction, withTransaction };
}

describe('G0-06 internal Run replay boundary', () => {
  it('uses one owned transaction and orders create auth, key lock, current read auth, then compare/replay', async () => {
    const { boundary, trace, transaction } = createFixture();

    const result = await boundary.replayServiceAgentChat({
      accessKey,
      declaredWorkspaceId: workspaceId,
      idempotencyKey: 'same-key',
      request,
    });

    expect(trace).toEqual([
      'transaction',
      'authenticate:create',
      'lock:key',
      'authenticate:read',
      'authorize:original-run',
    ]);
    expect(transaction.authorizeServiceOriginalRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId, requiredScope: 'run:read', targetKind: 'agent' }),
    );
    expect(transaction.lockExistingRunIdempotencyNamespace).toHaveBeenCalledWith({
      namespace: {
        schema_version: 'run-idempotency-namespace/1',
        workspace_id: workspaceId,
        authenticated_principal: {
          schema_version: 'conversation-principal/1',
          kind: 'credential',
          credential_id: credentialId,
        },
        fixed_route: '/v1/oapi/agent/chat',
        idempotency_key: 'same-key',
      },
      browserIdentity: null,
    });
    expect(result).toEqual({
      code: 202,
      success: true,
      message: 'accepted',
      request_id: exchangeRequestId,
      data: receipt.data,
      now_time: 1_777_777_777,
    });
  });

  it('snapshots service replay input before create authentication yields', async () => {
    const authenticationEntered = createDeferred();
    const releaseAuthentication = createDeferred();
    let authenticationCount = 0;
    const fixture = createFixture((trace) =>
      createTransaction(trace, {
        authenticateCredential: vi.fn(async () => {
          authenticationCount += 1;
          trace.push(authenticationCount === 1 ? 'authenticate:create' : 'authenticate:read');
          if (authenticationCount === 1) {
            authenticationEntered.resolve();
            await releaseAuthentication.promise;
          }
          return {
            credentialId,
            credentialAuthorizationEpoch: 7,
            credentialKind: 'service_api' as const,
            scopes: ['agent:run:create', 'run:read'] as const,
            workspaceId,
            workspaceAuthorizationEpoch: 11,
          };
        }),
      }),
    );
    const mutableInput = {
      accessKey,
      declaredWorkspaceId: workspaceId,
      idempotencyKey: 'same-key',
      request: {
        robot_id: request.robot_id,
        conversation_id: conversationId,
        content: request.content,
        inputs: { nested: { value: 1 } },
      },
    };

    const pending = fixture.boundary.replayServiceAgentChat(mutableInput);
    await authenticationEntered.promise;
    mutableInput.idempotencyKey = 'mutated-key';
    mutableInput.request.conversation_id = secondConversationId;
    releaseAuthentication.resolve();

    await expect(pending).resolves.toMatchObject({ code: 202, data: receipt.data });
    expect(fixture.transaction.lockExistingRunIdempotencyNamespace).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: expect.objectContaining({ idempotency_key: 'same-key' }),
      }),
    );
  });

  it('compares a persisted namespace by closed-field semantics instead of JSON key order', async () => {
    const fixture = createFixture((trace) =>
      createTransaction(trace, {
        lockExistingRunIdempotencyNamespace: vi.fn(async (command) => ({
          namespace: {
            idempotency_key: command.namespace.idempotency_key,
            fixed_route: command.namespace.fixed_route,
            authenticated_principal: {
              credential_id:
                command.namespace.authenticated_principal.kind === 'credential'
                  ? command.namespace.authenticated_principal.credential_id
                  : credentialId,
              kind: 'credential' as const,
              schema_version: 'conversation-principal/1' as const,
            },
            workspace_id: command.namespace.workspace_id,
            schema_version: 'run-idempotency-namespace/1' as const,
          },
          intentHash: intent.intent_hash,
          receipt,
          runId,
        })),
      }),
    );

    await expect(
      fixture.boundary.replayServiceAgentChat({
        accessKey,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'same-key',
        request,
      }),
    ).resolves.toMatchObject({ code: 202, data: receipt.data });
  });

  it('compares canonical acceptance receipt fields without depending on jsonb key order', async () => {
    const shuffledReceipt = {
      data: {
        conversation_id: conversationId,
        cancel_url: `/v1/oapi/runs/${runId}/cancel`,
        events_url: `/v1/oapi/runs/${runId}/events`,
        operation_url: `/v1/oapi/runs/${runId}`,
        accepted_request_id: acceptedRequestId,
        run_id: runId,
        status: 'QUEUED' as const,
      },
      http_status: 202 as const,
    };
    const fixture = createFixture((trace) =>
      createTransaction(trace, {
        lockExistingRunIdempotencyNamespace: vi.fn(async (command) => ({
          namespace: command.namespace,
          intentHash: intent.intent_hash,
          receipt: shuffledReceipt,
          runId,
        })),
      }),
    );

    await expect(
      fixture.boundary.replayServiceAgentChat({
        accessKey,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'same-key',
        request,
      }),
    ).resolves.toMatchObject({ code: 202, data: receipt.data });
  });

  it('replays a Flow receipt only through exactly-one-flow authorization and rejects cross-kind facts', async () => {
    const flowFixture = createFixture((trace) =>
      createTransaction(trace, {
        authenticateCredential: vi.fn(async () => {
          const phase = trace.includes('authenticate:create')
            ? 'authenticate:read'
            : 'authenticate:create';
          trace.push(phase);
          return {
            credentialId,
            credentialAuthorizationEpoch: 7,
            credentialKind: 'service_api' as const,
            scopes: ['flow:run:create', 'run:read'] as const,
            workspaceId,
            workspaceAuthorizationEpoch: 11,
          };
        }),
        lockExistingRunIdempotencyNamespace: vi.fn(async (command) => {
          trace.push('lock:key');
          return {
            namespace: command.namespace,
            intentHash: flowIntent.intent_hash,
            receipt: flowReceipt,
            runId,
          };
        }),
        authorizeServiceOriginalRun: vi.fn(async () => ({
          acceptedPrincipal: {
            schema_version: 'conversation-principal/1' as const,
            kind: 'credential' as const,
            credential_id: credentialId,
          },
          authorizedScope: 'run:read' as const,
          deploymentId,
          runId,
          targetKind: 'flow' as const,
          workspaceId,
        })),
      }),
    );

    await expect(
      flowFixture.boundary.replayServiceFlowRun({
        accessKey,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'flow-key',
        request: flowRequest,
      }),
    ).resolves.toMatchObject({ code: 202, data: flowReceipt.data });
    expect(flowFixture.transaction.authorizeServiceOriginalRun).toHaveBeenCalledWith(
      expect.objectContaining({ targetKind: 'flow' }),
    );

    const crossKind = createFixture((trace) =>
      createTransaction(trace, {
        authenticateCredential: vi.fn(async () => ({
          credentialId,
          credentialAuthorizationEpoch: 7,
          credentialKind: 'service_api' as const,
          scopes: ['flow:run:create', 'run:read'] as const,
          workspaceId,
          workspaceAuthorizationEpoch: 11,
        })),
        lockExistingRunIdempotencyNamespace: vi.fn(async (command) => ({
          namespace: command.namespace,
          intentHash: flowIntent.intent_hash,
          receipt: flowReceipt,
          runId,
        })),
        authorizeServiceOriginalRun: vi.fn(async () => ({
          acceptedPrincipal: {
            schema_version: 'conversation-principal/1' as const,
            kind: 'credential' as const,
            credential_id: credentialId,
          },
          authorizedScope: 'run:read' as const,
          deploymentId,
          runId,
          targetKind: 'agent' as const,
          workspaceId,
        })),
      }),
    );
    await expect(
      crossKind.boundary.replayServiceFlowRun({
        accessKey,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'flow-key',
        request: flowRequest,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_NOT_FOUND' }));
  });

  it('checks current Flow readability before intent comparison and calls no acceptance side effects', async () => {
    const fixture = createFixture((trace) =>
      createTransaction(trace, {
        authenticateCredential: vi.fn(async () => ({
          credentialId,
          credentialAuthorizationEpoch: 7,
          credentialKind: 'service_api' as const,
          scopes: ['flow:run:create', 'run:read'] as const,
          workspaceId,
          workspaceAuthorizationEpoch: 11,
        })),
        lockExistingRunIdempotencyNamespace: vi.fn(async (command) => ({
          namespace: command.namespace,
          intentHash: flowIntent.intent_hash,
          receipt: flowReceipt,
          runId,
        })),
        authorizeServiceOriginalRun: vi.fn(async () => null),
      }),
    );
    const admission = vi.fn();
    const conversation = vi.fn();
    const plan = vi.fn();
    const billing = vi.fn();
    const event = vi.fn();
    const outbox = vi.fn();
    Object.assign(fixture.transaction, {
      resolveFlowAdmission: admission,
      loadConversation: conversation,
      loadPlan: plan,
      reserveBilling: billing,
      appendRunEvent: event,
      enqueueOutbox: outbox,
    });

    await expect(
      fixture.boundary.replayServiceFlowRun({
        accessKey,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'flow-key',
        request: { inputs: { value: 2 } },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_NOT_FOUND' }));
    expect(fixture.transaction.authorizeServiceOriginalRun).toHaveBeenCalledTimes(1);
    for (const forbidden of [admission, conversation, plan, billing, event, outbox]) {
      expect(forbidden).not.toHaveBeenCalled();
    }
  });

  it('fails closed without a key before opening a transaction', async () => {
    const { boundary, withTransaction } = createFixture();

    await expect(
      boundary.replayServiceAgentChat({
        accessKey,
        declaredWorkspaceId: workspaceId,
        request,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<RunBoundaryError>>({
        code: 'RUN_PLAN_PROVIDER_UNAVAILABLE',
      }),
    );
    await expect(
      boundary.replayServiceFlowRun({
        accessKey,
        declaredWorkspaceId: workspaceId,
        request: flowRequest,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_PLAN_PROVIDER_UNAVAILABLE' }));
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('authenticates a miss but exposes no application acceptance or side-effect seam', async () => {
    const { boundary, trace, transaction } = createFixture((ownedTrace) =>
      createTransaction(ownedTrace, {
        lockExistingRunIdempotencyNamespace: vi.fn(async () => {
          ownedTrace.push('lock:key');
          return null;
        }),
      }),
    );
    const admission = vi.fn();
    const loadConversation = vi.fn();
    const getPlan = vi.fn();
    const reserve = vi.fn();
    const appendEvent = vi.fn();
    const enqueueOutbox = vi.fn();
    Object.assign(transaction, {
      resolveAgentServiceAdmission: admission,
      loadConversationForAgentChat: loadConversation,
      getTrustedPlan: getPlan,
      reserveCredits: reserve,
      appendRunEvent: appendEvent,
      enqueueOutbox,
    });

    await expect(
      boundary.replayServiceAgentChat({
        accessKey,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'missing-key',
        request,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_PLAN_PROVIDER_UNAVAILABLE' }));
    expect(trace).toEqual(['transaction', 'authenticate:create', 'lock:key']);
    expect(transaction.authorizeServiceOriginalRun).not.toHaveBeenCalled();
    for (const forbidden of [
      admission,
      loadConversation,
      getPlan,
      reserve,
      appendEvent,
      enqueueOutbox,
    ]) {
      expect(forbidden).not.toHaveBeenCalled();
    }
  });

  it('requires create scope and the independent current run:read gate', async () => {
    for (const scopes of [['run:read'] as const, ['agent:run:create'] as const]) {
      let authenticationCount = 0;
      const { boundary, transaction } = createFixture((trace) =>
        createTransaction(trace, {
          authenticateCredential: vi.fn(async () => {
            authenticationCount += 1;
            trace.push(authenticationCount === 1 ? 'authenticate:create' : 'authenticate:read');
            return {
              credentialId,
              credentialAuthorizationEpoch: 7,
              credentialKind: 'service_api' as const,
              scopes,
              workspaceId,
              workspaceAuthorizationEpoch: 11,
            };
          }),
        }),
      );

      await expect(
        boundary.replayServiceAgentChat({
          accessKey,
          declaredWorkspaceId: workspaceId,
          idempotencyKey: 'same-key',
          request,
        }),
      ).rejects.toEqual(expect.objectContaining({ code: 'RUN_AUTHORIZATION_FAILED' }));
      expect(transaction.authorizeServiceOriginalRun).not.toHaveBeenCalled();
      if (scopes[0] === 'run:read') {
        expect(transaction.lockExistingRunIdempotencyNamespace).not.toHaveBeenCalled();
      } else {
        expect(transaction.lockExistingRunIdempotencyNamespace).toHaveBeenCalledTimes(1);
      }
    }
  });

  it('returns RUN_NOT_FOUND before intent comparison when the original target is unreadable', async () => {
    const { boundary, transaction } = createFixture((trace) =>
      createTransaction(trace, {
        authorizeServiceOriginalRun: vi.fn(async () => {
          trace.push('authorize:original-run');
          return null;
        }),
      }),
    );

    await expect(
      boundary.replayServiceAgentChat({
        accessKey,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'same-key',
        request: { ...request, content: 'different intent' },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_NOT_FOUND' }));
    expect(transaction.authorizeServiceOriginalRun).toHaveBeenCalledTimes(1);
  });

  it('maps only persisted-lookup P0002/42501 failures to RUN_NOT_FOUND', async () => {
    for (const sqlState of ['P0002', '42501'] as const) {
      const fixture = createFixture((trace) =>
        createTransaction(trace, {
          lockExistingRunIdempotencyNamespace: vi.fn(async () => {
            throw mapRunTransactionSqlState('lockExistingRunIdempotencyNamespace', sqlState);
          }),
        }),
      );

      await expect(
        fixture.boundary.replayServiceAgentChat({
          accessKey,
          declaredWorkspaceId: workspaceId,
          idempotencyKey: 'same-key',
          request,
        }),
      ).rejects.toEqual(expect.objectContaining({ code: 'RUN_NOT_FOUND' }));
    }
  });

  it('compares the intent only after current authorization and rejects a different intent', async () => {
    const { boundary, trace } = createFixture();

    await expect(
      boundary.replayServiceAgentChat({
        accessKey,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'same-key',
        request: { ...request, content: 'different intent' },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }));
    expect(trace.at(-1)).toBe('authorize:original-run');
  });

  it('reports a changed Chat conversation as an intent conflict before validating receipt binding', async () => {
    const changedConversation = createFixture();
    await expect(
      changedConversation.boundary.replayServiceAgentChat({
        accessKey,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'same-key',
        request: { ...request, conversation_id: secondConversationId },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }));

    const mismatchedReceipt = prepareCanonicalAcceptanceReceipt({
      http_status: 202,
      run_id: runId,
      accepted_request_id: acceptedRequestId,
      conversation_id: secondConversationId,
    });
    const sameIntent = createFixture((trace) =>
      createTransaction(trace, {
        lockExistingRunIdempotencyNamespace: vi.fn(async (command) => ({
          namespace: command.namespace,
          intentHash: intent.intent_hash,
          receipt: mismatchedReceipt,
          runId,
        })),
      }),
    );
    await expect(
      sameIntent.boundary.replayServiceAgentChat({
        accessKey,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'same-key',
        request,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_REPLAY_RECEIPT_INVALID' }));
  });

  it('rejects corrupt blocking receipts and accepted-principal or target-kind drift', async () => {
    const badReceipt = {
      http_status: 200,
      data: receipt.data,
    };
    const badReceiptFixture = createFixture((trace) =>
      createTransaction(trace, {
        lockExistingRunIdempotencyNamespace: vi.fn(async (command) => {
          trace.push('lock:key');
          return {
            namespace: command.namespace,
            intentHash: intent.intent_hash,
            receipt: badReceipt,
            runId,
          };
        }),
      }),
    );
    await expect(
      badReceiptFixture.boundary.replayServiceAgentChat({
        accessKey,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'same-key',
        request,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_REPLAY_RECEIPT_INVALID' }));

    for (const authorization of [
      {
        acceptedPrincipal: {
          schema_version: 'conversation-principal/1' as const,
          kind: 'credential' as const,
          credential_id: secondRunId,
        },
        authorizedScope: 'run:read' as const,
        deploymentId,
        runId,
        targetKind: 'agent' as const,
        workspaceId,
      },
      {
        acceptedPrincipal: {
          schema_version: 'conversation-principal/1' as const,
          kind: 'credential' as const,
          credential_id: credentialId,
        },
        authorizedScope: 'run:read' as const,
        deploymentId,
        runId,
        targetKind: 'flow' as const,
        workspaceId,
      },
    ]) {
      const fixture = createFixture((trace) =>
        createTransaction(trace, {
          authorizeServiceOriginalRun: vi.fn(async () => authorization),
        }),
      );
      await expect(
        fixture.boundary.replayServiceAgentChat({
          accessKey,
          declaredWorkspaceId: workspaceId,
          idempotencyKey: 'same-key',
          request,
        }),
      ).rejects.toEqual(expect.objectContaining({ code: 'RUN_NOT_FOUND' }));
    }
  });

  it('rejects authority-field injection and a factory-provided trusted Plan seam before I/O', async () => {
    const { boundary, withTransaction } = createFixture();
    for (const injected of [
      { principal: { kind: 'credential', credential_id: credentialId } },
      { deploymentId },
      { revisionId: deploymentId },
      { admissionSnapshot: {} },
      { acceptedPlanHash: `sha256:${'a'.repeat(64)}` },
      { transaction: {} },
      { state_version: 1 },
      { next_state_version: 2 },
    ]) {
      await expect(
        boundary.replayServiceAgentChat({
          accessKey,
          declaredWorkspaceId: workspaceId,
          idempotencyKey: 'same-key',
          request,
          ...injected,
        } as never),
      ).rejects.toEqual(expect.objectContaining({ code: 'RUN_BOUNDARY_INPUT_INVALID' }));
    }
    expect(withTransaction).not.toHaveBeenCalled();

    expect(() =>
      createRunBoundary({
        authBoundary: createAuthBoundary({ accessKeyPepper: async () => Buffer.alloc(32, 9) }),
        browserSessionPepper: async () => Buffer.alloc(32, 10),
        currentRequestId: () => exchangeRequestId,
        currentUnixTime: () => 1_777_777_777,
        withTransaction: async <T>(callback: (transaction: RunDatabaseTransaction) => Promise<T>) =>
          callback(createTransaction([])),
        trustedPlanProvider: async () => ({ accepted_plan_hash: `sha256:${'a'.repeat(64)}` }),
      } as never),
    ).toThrowError(/run boundary rejected/i);
  });
});

describe('G0-06 controlled Run cancellation seam', () => {
  it('snapshots service cancellation input before authentication yields', async () => {
    const authenticationEntered = createDeferred();
    const releaseAuthentication = createDeferred();
    const fixture = createFixture((trace) =>
      createTransaction(trace, {
        authenticateCredential: vi.fn(async () => {
          trace.push('authenticate:cancel');
          authenticationEntered.resolve();
          await releaseAuthentication.promise;
          return {
            credentialId,
            credentialAuthorizationEpoch: 7,
            credentialKind: 'service_api' as const,
            scopes: ['run:cancel'] as const,
            workspaceId,
            workspaceAuthorizationEpoch: 11,
          };
        }),
        requestRunCancellation: vi.fn(async () => ({
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
        })),
      }),
    );
    const mutableInput = {
      accessKey,
      declaredWorkspaceId: workspaceId,
      idempotencyKey: 'cancel-key',
      runId,
    };

    const pending = fixture.boundary.requestServiceCancellation(mutableInput);
    await authenticationEntered.promise;
    mutableInput.idempotencyKey = 'mutated-cancel-key';
    mutableInput.runId = secondRunId;
    releaseAuthentication.resolve();

    await expect(pending).resolves.toMatchObject({ code: 202, data: { run_id: runId } });
    expect(fixture.transaction.requestRunCancellation).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'cancel-key', runId }),
    );
  });

  it('clones and recursively freezes a validated successful terminal result', async () => {
    const originalResult = {
      summary: { items: [{ label: 'before' }] },
    };
    const fixture = createFixture((trace) =>
      createTransaction(trace, {
        requestRunCancellation: vi.fn(async () => ({
          outcome: 'REPLAY' as const,
          receipt: {
            http_status: 200,
            data: {
              run_id: runId,
              accepted_request_id: acceptedRequestId,
              status: 'SUCCEEDED',
              last_sequence: '10',
              result: originalResult,
              billing_pending: false,
              billing_state: 'SETTLED',
              billing_settled_at: '2026-08-27T00:00:00.000Z',
            },
          },
        })),
      }),
    );

    const exchange = await fixture.boundary.requestServiceCancellation({
      accessKey,
      declaredWorkspaceId: workspaceId,
      idempotencyKey: 'cancel-key',
      runId,
    });
    if (exchange.code !== 200) throw new Error('expected a terminal cancellation exchange');
    const result = exchange.data.result as typeof originalResult;

    expect(result).toEqual(originalResult);
    expect(result).not.toBe(originalResult);
    expect(result.summary).not.toBe(originalResult.summary);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.summary)).toBe(true);
    expect(Object.isFrozen(result.summary.items)).toBe(true);
    expect(Object.isFrozen(result.summary.items[0])).toBe(true);
    const originalItem = originalResult.summary.items[0];
    if (originalItem === undefined) throw new Error('expected the original result item');
    originalItem.label = 'after';
    expect(result.summary.items[0]?.label).toBe('before');
  });

  it('rejects terminal receipts whose status, reason, billing, cursor or timestamp are not canonical', async () => {
    const baseData = terminalCancellationReceipt.data;
    const successfulData = {
      run_id: runId,
      accepted_request_id: acceptedRequestId,
      status: 'SUCCEEDED' as const,
      last_sequence: '10',
      billing_pending: false,
      billing_state: 'SETTLED' as const,
      billing_settled_at: '2026-08-27T00:00:00.000Z',
    };
    const invalidData = [
      { ...baseData, status: 'FAILED' },
      {
        ...baseData,
        error: { code: 'INTERNAL_FAILURE', retryable: false, category: 'EXECUTION' },
      },
      {
        ...baseData,
        error: { ...baseData.error, requires_operator_action: false },
      },
      { ...baseData, last_sequence: '0' },
      { ...baseData, last_sequence: '01' },
      { ...baseData, billing_settled_at: 'August 27, 2026' },
      { ...successfulData, result: null },
      { ...successfulData, result: 'not-an-object' },
      { ...successfulData, result: [] },
    ];

    for (const data of invalidData) {
      const fixture = createFixture((trace) =>
        createTransaction(trace, {
          requestRunCancellation: vi.fn(async () => ({
            outcome: 'REPLAY' as const,
            receipt: { http_status: 200, data },
          })),
        }),
      );
      await expect(
        fixture.boundary.requestServiceCancellation({
          accessKey,
          declaredWorkspaceId: workspaceId,
          idempotencyKey: 'cancel-key',
          runId,
        }),
      ).rejects.toEqual(expect.objectContaining({ code: 'RUN_CANCELLATION_FAILED' }));
    }
  });

  it('accepts the PostgreSQL bigint maximum terminal sequence and rejects max plus one', async () => {
    const atMaximum = createFixture((trace) =>
      createTransaction(trace, {
        requestRunCancellation: vi.fn(async () => ({
          outcome: 'REPLAY' as const,
          receipt: {
            ...terminalCancellationReceipt,
            data: {
              ...terminalCancellationReceipt.data,
              last_sequence: '9223372036854775807',
            },
          },
        })),
      }),
    );
    await expect(
      atMaximum.boundary.requestServiceCancellation({
        accessKey,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'cancel-key',
        runId,
      }),
    ).resolves.toMatchObject({
      code: 200,
      data: { last_sequence: '9223372036854775807' },
    });

    const aboveMaximum = createFixture((trace) =>
      createTransaction(trace, {
        requestRunCancellation: vi.fn(async () => ({
          outcome: 'REPLAY' as const,
          receipt: {
            ...terminalCancellationReceipt,
            data: {
              ...terminalCancellationReceipt.data,
              last_sequence: '9223372036854775808',
            },
          },
        })),
      }),
    );
    await expect(
      aboveMaximum.boundary.requestServiceCancellation({
        accessKey,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'cancel-key',
        runId,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_CANCELLATION_FAILED' }));
  });

  it('accepts SIDE_EFFECT_UNKNOWN only without SQL-external flow_category metadata', async () => {
    const sideEffectReceipt = {
      http_status: 200,
      data: {
        run_id: runId,
        accepted_request_id: acceptedRequestId,
        status: 'FAILED',
        last_sequence: '10',
        billing_pending: false,
        billing_state: 'NEEDS_ATTENTION',
        error: {
          code: 'SIDE_EFFECT_UNKNOWN',
          retryable: false,
          category: 'EXECUTION',
          requires_operator_action: true,
        },
      },
    } as const;
    const withoutFlowCategory = createFixture((trace) =>
      createTransaction(trace, {
        requestRunCancellation: vi.fn(async () => ({
          outcome: 'REPLAY' as const,
          receipt: sideEffectReceipt,
        })),
      }),
    );

    await expect(
      withoutFlowCategory.boundary.requestServiceCancellation({
        accessKey,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'cancel-key',
        runId,
      }),
    ).resolves.toMatchObject({ code: 200, data: sideEffectReceipt.data });

    for (const flowCategory of ['SIDE_EFFECT_UNKNOWN', 'INTERNAL'] as const) {
      const fixture = createFixture((trace) =>
        createTransaction(trace, {
          requestRunCancellation: vi.fn(async () => ({
            outcome: 'REPLAY' as const,
            receipt: {
              ...sideEffectReceipt,
              data: {
                ...sideEffectReceipt.data,
                error: { ...sideEffectReceipt.data.error, flow_category: flowCategory },
              },
            },
          })),
        }),
      );
      await expect(
        fixture.boundary.requestServiceCancellation({
          accessKey,
          declaredWorkspaceId: workspaceId,
          idempotencyKey: 'cancel-key',
          runId,
        }),
      ).rejects.toEqual(expect.objectContaining({ code: 'RUN_CANCELLATION_FAILED' }));
    }
  });

  it('maps only cancellation 23505 to the idempotency conflict outcome', async () => {
    const fixture = createFixture((trace) =>
      createTransaction(trace, {
        authenticateCredential: vi.fn(async () => ({
          credentialId,
          credentialAuthorizationEpoch: 7,
          credentialKind: 'service_api' as const,
          scopes: ['run:cancel'] as const,
          workspaceId,
          workspaceAuthorizationEpoch: 11,
        })),
        requestRunCancellation: vi.fn(async () => {
          throw mapRunTransactionSqlState('requestRunCancellation', '23505');
        }),
      }),
    );

    await expect(
      fixture.boundary.requestServiceCancellation({
        accessKey,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'cancel-key',
        runId,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }));
  });

  it('delegates same-intent replay and different-intent conflict to one controlled definer', async () => {
    let storedRunId: string | undefined;
    const eventWriter = vi.fn();
    const outboxWriter = vi.fn();
    const fixture = createFixture((trace) => {
      const transaction = createTransaction(trace, {
        authenticateCredential: vi.fn(async () => {
          trace.push('authenticate:cancel');
          return {
            credentialId,
            credentialAuthorizationEpoch: 7,
            credentialKind: 'service_api' as const,
            scopes: ['run:cancel'] as const,
            workspaceId,
            workspaceAuthorizationEpoch: 11,
          };
        }),
        requestRunCancellation: vi.fn(async (command) => {
          trace.push('definer:request_run_cancellation');
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
        }),
      });
      Object.assign(transaction, { appendRunEvent: eventWriter, enqueueOutbox: outboxWriter });
      return transaction;
    });
    const input = {
      accessKey,
      declaredWorkspaceId: workspaceId,
      idempotencyKey: 'cancel-key',
      runId,
    } as const;

    const first = await fixture.boundary.requestServiceCancellation(input);
    const replay = await fixture.boundary.requestServiceCancellation(input);
    await expect(
      fixture.boundary.requestServiceCancellation({ ...input, runId: secondRunId }),
    ).rejects.toEqual(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }));

    expect(first.data).toEqual(replay.data);
    expect(first.data).toMatchObject({ run_id: runId, status: 'CANCEL_REQUESTED' });
    expect(fixture.transaction.requestRunCancellation).toHaveBeenCalledTimes(3);
    expect(fixture.transaction.requestRunCancellation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        authenticatedPrincipal: {
          schema_version: 'conversation-principal/1',
          kind: 'credential',
          credential_id: credentialId,
        },
        idempotencyKey: 'cancel-key',
        requiredScope: 'run:cancel',
        runId,
      }),
    );
    expect(
      vi.mocked(fixture.transaction.requestRunCancellation).mock.calls[0]?.[0],
    ).not.toHaveProperty('intentHash');
    expect(eventWriter).not.toHaveBeenCalled();
    expect(outboxWriter).not.toHaveBeenCalled();
  });

  it('rebuilds current exchange facts around a persisted terminal 200 cancellation receipt', async () => {
    const fixture = createFixture((trace) =>
      createTransaction(trace, {
        authenticateCredential: vi.fn(async () => ({
          credentialId,
          credentialAuthorizationEpoch: 7,
          credentialKind: 'service_api' as const,
          scopes: ['run:cancel'] as const,
          workspaceId,
          workspaceAuthorizationEpoch: 11,
        })),
        requestRunCancellation: vi.fn(async () => ({
          outcome: 'REPLAY' as const,
          receipt: terminalCancellationReceipt,
        })),
      }),
    );

    await expect(
      fixture.boundary.requestServiceCancellation({
        accessKey,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'terminal-key',
        runId,
      }),
    ).resolves.toEqual({
      code: 200,
      success: true,
      message: '',
      request_id: exchangeRequestId,
      data: terminalCancellationReceipt.data,
      now_time: 1_777_777_777,
    });
  });

  it('rejects a real but wrong family/cardinality policy proof before the cancellation definer', async () => {
    const transaction = createTransaction([], {
      authenticateCredential: vi.fn(async () => ({
        credentialId,
        credentialAuthorizationEpoch: 7,
        credentialKind: 'service_api' as const,
        scopes: ['agent:run:create'] as const,
        workspaceId,
        workspaceAuthorizationEpoch: 11,
      })),
    });
    const realAuth = createAuthBoundary({ accessKeyPepper: async () => Buffer.alloc(32, 9) });
    const wrongAuthenticator = realAuth.bindServiceRoute({
      method: 'POST',
      operationId: 'createAgentChatRun',
      routeTemplate: '/v1/oapi/agent/chat',
    });
    const boundary = createRunBoundary({
      authBoundary: { bindServiceRoute: () => wrongAuthenticator },
      browserSessionPepper: async () => Buffer.alloc(32, 10),
      currentRequestId: () => exchangeRequestId,
      currentUnixTime: () => 1_777_777_777,
      withTransaction: async <T>(callback: (owned: RunDatabaseTransaction) => Promise<T>) =>
        callback(transaction),
    });

    await expect(
      boundary.requestServiceCancellation({
        accessKey,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'cancel-key',
        runId,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_AUTHORIZATION_FAILED' }));
    expect(transaction.requestRunCancellation).not.toHaveBeenCalled();
  });

  it('rejects non-canonical uppercase UUID input before opening a transaction', async () => {
    const fixture = createFixture();

    await expect(
      fixture.boundary.requestServiceCancellation({
        accessKey,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'cancel-key',
        runId: runId.toUpperCase(),
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_BOUNDARY_INPUT_INVALID' }));
    expect(fixture.withTransaction).not.toHaveBeenCalled();
  });

  it('returns RUN_NOT_FOUND from the definer and rejects caller authority before I/O', async () => {
    const fixture = createFixture((trace) =>
      createTransaction(trace, {
        authenticateCredential: vi.fn(async () => ({
          credentialId,
          credentialAuthorizationEpoch: 7,
          credentialKind: 'service_api' as const,
          scopes: ['run:cancel'] as const,
          workspaceId,
          workspaceAuthorizationEpoch: 11,
        })),
      }),
    );
    await expect(
      fixture.boundary.requestServiceCancellation({
        accessKey,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'cancel-key',
        runId,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_NOT_FOUND' }));

    const cleanFixture = createFixture();
    await expect(
      cleanFixture.boundary.requestServiceCancellation({
        accessKey,
        declaredWorkspaceId: workspaceId,
        idempotencyKey: 'cancel-key',
        runId,
        principal: { kind: 'credential', credential_id: credentialId },
      } as never),
    ).rejects.toEqual(expect.objectContaining({ code: 'RUN_BOUNDARY_INPUT_INVALID' }));
    expect(cleanFixture.withTransaction).not.toHaveBeenCalled();
  });
});
