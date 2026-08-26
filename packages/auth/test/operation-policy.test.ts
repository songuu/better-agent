import { describe, expect, it } from 'vitest';

import {
  AuthorizationBoundaryError,
  bindReviewedServiceCredentialRoute,
  evaluateCredentialPolicyPhase,
  isCredentialPolicyPhasePassed,
} from '../src/index.js';

const exchangeBrowserSessionRoute = bindReviewedServiceCredentialRoute({
  method: 'POST',
  operationId: 'exchangeBrowserSession',
  routeTemplate: '/v1/oapi/browser/sessions/exchange',
});

const createAgentConversationRoute = bindReviewedServiceCredentialRoute({
  method: 'POST',
  operationId: 'createAgentConversation',
  routeTemplate: '/v1/oapi/agent/conversation',
});

const listAgentConversationsRoute = bindReviewedServiceCredentialRoute({
  method: 'GET',
  operationId: 'listAgentConversations',
  routeTemplate: '/v1/oapi/agent/conversations',
});

const listAgentConversationMessagesRoute = bindReviewedServiceCredentialRoute({
  method: 'GET',
  operationId: 'listAgentConversationMessages',
  routeTemplate: '/v1/oapi/agent/conversation/messages',
});

describe('credential policy phase', () => {
  it('passes only the credential phase and preserves the remaining G0-05 gate', () => {
    const proof = evaluateCredentialPolicyPhase(exchangeBrowserSessionRoute, {
      credentialKind: 'publish',
      scopes: ['browser-session:exchange'],
    });
    expect(proof).toEqual({
      operationId: 'exchangeBrowserSession',
      operationPurpose: 'deployment_publish',
      httpMethod: 'POST',
      policyHash: expect.stringMatching(/^cp1\.[A-Za-z0-9_-]{43}$/u),
      requiredScopes: ['browser-session:exchange'],
      remainingGate: {
        targetCardinality: 'exactly_one_deployment',
        typedGrantFamily: 'agent_deployment_entry_grants',
      },
      routeTemplate: '/v1/oapi/browser/sessions/exchange',
      status: 'credential_phase_passed',
    });
    expect(isCredentialPolicyPhasePassed(proof)).toBe(true);
    expect(
      isCredentialPolicyPhasePassed({
        ...proof,
        status: 'credential_phase_passed',
      }),
    ).toBe(false);
  });

  it.each([
    { credentialKind: 'service_api', scopes: ['browser-session:exchange'] },
    { credentialKind: 'publish', scopes: ['agent:run:create'] },
    { credentialKind: 'publish', scopes: [] },
  ] as const)('rejects kind/scope confusion: %j', (facts) => {
    expect(() => evaluateCredentialPolicyPhase(exchangeBrowserSessionRoute, facts)).toThrow(
      AuthorizationBoundaryError,
    );
  });

  it('binds the proof to the exact reviewed OpenAPI operation', () => {
    const createConversation = evaluateCredentialPolicyPhase(createAgentConversationRoute, {
      credentialKind: 'service_api',
      scopes: ['agent:conversation:write'],
    });
    const listConversations = evaluateCredentialPolicyPhase(listAgentConversationsRoute, {
      credentialKind: 'service_api',
      scopes: ['agent:conversation:read'],
    });
    const listMessages = evaluateCredentialPolicyPhase(listAgentConversationMessagesRoute, {
      credentialKind: 'service_api',
      scopes: ['agent:conversation:read'],
    });

    expect(createConversation.requiredScopes).toEqual(['agent:conversation:write']);
    expect(() =>
      evaluateCredentialPolicyPhase(createAgentConversationRoute, {
        credentialKind: 'service_api',
        scopes: ['agent:run:create'],
      }),
    ).toThrow(AuthorizationBoundaryError);
    expect(listConversations.operationId).not.toBe(listMessages.operationId);
    expect(listConversations.policyHash).not.toBe(listMessages.policyHash);
  });

  it('fails closed for an operation outside the reviewed registry', () => {
    expect(() =>
      bindReviewedServiceCredentialRoute({
        method: 'POST',
        operationId: 'handlerSuppliedOperation' as 'createAgentChatRun',
        routeTemplate: '/v1/oapi/agent/chat',
      }),
    ).toThrow(AuthorizationBoundaryError);
  });

  it('rejects cross-route operation substitution before request authentication', () => {
    expect(() =>
      bindReviewedServiceCredentialRoute({
        method: 'GET',
        operationId: 'createAgentChatRun',
        routeTemplate: '/v1/oapi/runs/{run_id}',
      }),
    ).toThrow(AuthorizationBoundaryError);
  });

  it('rejects a structurally copied route that was not issued by the binder', () => {
    expect(() =>
      evaluateCredentialPolicyPhase(
        { ...exchangeBrowserSessionRoute },
        {
          credentialKind: 'publish',
          scopes: ['browser-session:exchange'],
        },
      ),
    ).toThrow(AuthorizationBoundaryError);
  });
});
