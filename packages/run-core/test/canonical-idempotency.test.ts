import { describe, expect, it } from 'vitest';

import {
  decideIdempotency,
  prepareCanonicalAcceptanceReceipt,
  prepareCanonicalRunIntent,
} from '../src/index.js';
import {
  conversationId,
  credentialId,
  credentialPrincipal,
  gateId,
  requestId,
  runId,
  workspaceId,
} from './fixtures.js';

const chatRequest = {
  robot_id: 'agent-public',
  conversation_id: conversationId,
  content: 'hello',
  inputs: { nested: { b: true, a: 1 }, list: [1, 2] },
};

describe('canonical route intents', () => {
  it('uses release-core JCS with fixed independent digest vectors', () => {
    const chat = prepareCanonicalRunIntent({
      route: '/v1/oapi/agent/chat',
      request: chatRequest,
    });
    const cancel = prepareCanonicalRunIntent({
      route: '/v1/oapi/runs/{run_id}/cancel',
      request: { run_id: runId },
    });

    expect(chat.intent_hash).toBe(
      'sha256:9969edcba865b575d1cabc43c560450c05504f7a855e8bb51170fd979e7bca76',
    );
    expect(cancel.intent_hash).toBe(
      'sha256:a16deb0e33e5713133fbe9eb9cbc43768627286ef8218ca9efcda3cca30a1582',
    );
    expect(chat.preimage.request).toMatchObject({ response_mode: 'blocking' });
  });

  it('treats object key order as equivalent and array order as significant', () => {
    const first = prepareCanonicalRunIntent({
      route: '/v1/oapi/agent/chat',
      request: chatRequest,
    });
    const reordered = prepareCanonicalRunIntent({
      route: '/v1/oapi/agent/chat',
      request: {
        inputs: { list: [1, 2], nested: { a: 1, b: true } },
        content: 'hello',
        conversation_id: conversationId,
        robot_id: 'agent-public',
        response_mode: 'blocking',
      },
    });
    const reversedArray = prepareCanonicalRunIntent({
      route: '/v1/oapi/agent/chat',
      request: { ...chatRequest, inputs: { ...chatRequest.inputs, list: [2, 1] } },
    });

    expect(reordered.intent_hash).toBe(first.intent_hash);
    expect(reversedArray.intent_hash).not.toBe(first.intent_hash);
  });

  it('changes for every public route field and rejects authority facts', () => {
    const base = prepareCanonicalRunIntent({
      route: '/v1/oapi/agent/chat',
      request: chatRequest,
    });
    for (const request of [
      { ...chatRequest, robot_id: 'other-agent' },
      { ...chatRequest, conversation_id: runId },
      { ...chatRequest, content: 'changed' },
      { ...chatRequest, inputs: { changed: true } },
      { ...chatRequest, response_mode: 'streaming' as const },
    ]) {
      expect(
        prepareCanonicalRunIntent({ route: '/v1/oapi/agent/chat', request }).intent_hash,
      ).not.toBe(base.intent_hash);
    }

    const withCredential = { ...chatRequest, credential_id: credentialId };
    const withDeployment = { ...chatRequest, agent_deployment_id: requestId };
    const withPlan = { ...chatRequest, accepted_plan_hash: `sha256:${'a'.repeat(64)}` };
    expect(() =>
      prepareCanonicalRunIntent({
        route: '/v1/oapi/agent/chat',
        request: withCredential,
      }),
    ).toThrowError(/RUN_INTENT_INVALID/);
    expect(() =>
      prepareCanonicalRunIntent({
        route: '/v1/oapi/agent/chat',
        request: withDeployment,
      }),
    ).toThrowError(/RUN_INTENT_INVALID/);
    expect(() =>
      prepareCanonicalRunIntent({
        route: '/v1/oapi/agent/chat',
        request: withPlan,
      }),
    ).toThrowError(/RUN_INTENT_INVALID/);
  });

  it('hashes Flow, cancel and resume targets inside their route-specific request', () => {
    const flow = prepareCanonicalRunIntent({
      route: '/v1/oapi/flow/run',
      request: { inputs: { value: 1 } },
    });
    expect(
      prepareCanonicalRunIntent({
        route: '/v1/oapi/flow/run',
        request: { inputs: { value: 2 } },
      }).intent_hash,
    ).not.toBe(flow.intent_hash);

    const cancel = prepareCanonicalRunIntent({
      route: '/v1/oapi/runs/{run_id}/cancel',
      request: { run_id: runId },
    });
    expect(
      prepareCanonicalRunIntent({
        route: '/v1/oapi/runs/{run_id}/cancel',
        request: { run_id: requestId },
      }).intent_hash,
    ).not.toBe(cancel.intent_hash);

    const resume = prepareCanonicalRunIntent({
      route: '/v1/oapi/runs/{run_id}/gates/{gate_id}/resume',
      request: { run_id: runId, gate_id: gateId, action: 'approve' },
    });
    expect(
      prepareCanonicalRunIntent({
        route: '/v1/oapi/runs/{run_id}/gates/{gate_id}/resume',
        request: { run_id: runId, gate_id: gateId, action: 'reject' },
      }).intent_hash,
    ).not.toBe(resume.intent_hash);
    for (const request of [
      { run_id: requestId, gate_id: gateId, action: 'approve' as const },
      { run_id: runId, gate_id: requestId, action: 'approve' as const },
      { run_id: runId, gate_id: gateId, action: 'submit' as const, input: { value: 1 } },
    ]) {
      expect(
        prepareCanonicalRunIntent({
          route: '/v1/oapi/runs/{run_id}/gates/{gate_id}/resume',
          request,
        }).intent_hash,
      ).not.toBe(resume.intent_hash);
    }
  });
});

describe('idempotency and canonical acceptance receipt', () => {
  const namespace = {
    schema_version: 'run-idempotency-namespace/1',
    workspace_id: workspaceId,
    authenticated_principal: credentialPrincipal,
    fixed_route: '/v1/oapi/flow/run',
    idempotency_key: 'same-key',
  } as const;
  const receipt = prepareCanonicalAcceptanceReceipt({
    http_status: 202,
    run_id: runId,
    accepted_request_id: requestId,
  });
  const otherRunReceipt = prepareCanonicalAcceptanceReceipt({
    http_status: 202,
    run_id: requestId,
    accepted_request_id: requestId,
  });
  const intent = prepareCanonicalRunIntent({
    route: '/v1/oapi/flow/run',
    request: { inputs: { value: 1 } },
  });

  it('replays equal facts, conflicts on target/hash, and treats another route as a miss', () => {
    const stored = {
      namespace,
      intent_hash: intent.intent_hash,
      target: { run_id: runId },
      receipt,
    } as const;
    expect(decideIdempotency({ current: stored, stored })).toEqual({
      decision: 'REPLAY',
      receipt,
    });
    expect(
      decideIdempotency({
        current: { ...stored, target: { run_id: requestId }, receipt: otherRunReceipt },
        stored,
      }),
    ).toEqual({ decision: 'CONFLICT' });
    expect(
      decideIdempotency({
        current: { ...stored, intent_hash: `sha256:${'f'.repeat(64)}` },
        stored,
      }),
    ).toEqual({ decision: 'CONFLICT' });
    expect(
      decideIdempotency({
        current: {
          ...stored,
          namespace: { ...namespace, fixed_route: '/v1/oapi/agent/chat' },
          intent_hash: prepareCanonicalRunIntent({
            route: '/v1/oapi/agent/chat',
            request: chatRequest,
          }).intent_hash,
          receipt: prepareCanonicalAcceptanceReceipt({
            http_status: 202,
            run_id: runId,
            accepted_request_id: requestId,
            conversation_id: conversationId,
          }),
        },
        stored,
      }),
    ).toEqual({ decision: 'MISS' });
  });

  it('supports only canonical Agent Chat and Flow create receipts', () => {
    const flowFact = {
      namespace,
      intent_hash: intent.intent_hash,
      target: { run_id: runId },
      receipt,
    } as const;
    const agentReceipt = prepareCanonicalAcceptanceReceipt({
      http_status: 202,
      run_id: runId,
      accepted_request_id: requestId,
      conversation_id: conversationId,
    });
    const agentFact = {
      namespace: { ...namespace, fixed_route: '/v1/oapi/agent/chat' },
      intent_hash: prepareCanonicalRunIntent({
        route: '/v1/oapi/agent/chat',
        request: chatRequest,
      }).intent_hash,
      target: { run_id: runId },
      receipt: agentReceipt,
    } as const;

    expect(decideIdempotency({ current: flowFact, stored: flowFact })).toEqual({
      decision: 'REPLAY',
      receipt,
    });
    expect(decideIdempotency({ current: agentFact, stored: agentFact })).toEqual({
      decision: 'REPLAY',
      receipt: agentReceipt,
    });

    expect(() =>
      decideIdempotency({
        current: { ...flowFact, receipt: agentReceipt },
      }),
    ).toThrowError(/RUN_IDEMPOTENCY_INVALID/);
    expect(() =>
      decideIdempotency({
        current: { ...agentFact, receipt },
      }),
    ).toThrowError(/RUN_IDEMPOTENCY_INVALID/);

    for (const fixedRoute of [
      '/v1/oapi/runs/{run_id}/cancel',
      '/v1/oapi/runs/{run_id}/gates/{gate_id}/resume',
    ] as const) {
      expect(() =>
        decideIdempotency({
          current: {
            ...flowFact,
            namespace: { ...namespace, fixed_route: fixedRoute },
          },
        }),
      ).toThrowError(/RUN_IDEMPOTENCY_INVALID/);
    }
  });

  it('keeps exchange fields out of receipt and refuses a blocking 200 as durable acceptance', () => {
    expect(receipt).toEqual({
      http_status: 202,
      data: {
        status: 'QUEUED',
        run_id: runId,
        accepted_request_id: requestId,
        operation_url: `/v1/oapi/runs/${runId}`,
        events_url: `/v1/oapi/runs/${runId}/events`,
        cancel_url: `/v1/oapi/runs/${runId}/cancel`,
      },
    });
    expect(receipt).not.toHaveProperty('request_id');
    expect(receipt).not.toHaveProperty('now_time');
    expect(() =>
      prepareCanonicalAcceptanceReceipt({
        http_status: 200,
        run_id: runId,
        accepted_request_id: requestId,
      }),
    ).toThrowError(/RUN_ACCEPTANCE_RECEIPT_INVALID/);
  });

  it('rejects non-canonical target and receipt facts before making a decision', () => {
    const canonical = {
      namespace,
      intent_hash: intent.intent_hash,
      target: { run_id: runId },
      receipt,
    } as const;
    const malformedFacts = [
      {
        ...canonical,
        target: { run_id: runId, authority_workspace_id: workspaceId },
      },
      {
        ...canonical,
        target: { run_id: runId, gate_id: gateId },
      },
      {
        ...canonical,
        namespace: {
          ...namespace,
          fixed_route: '/v1/oapi/runs/{run_id}/gates/{gate_id}/resume',
        },
      },
      {
        ...canonical,
        receipt: { ...receipt, http_status: 200 },
      },
      {
        ...canonical,
        receipt: { ...receipt, data: { ...receipt.data, status: 'RUNNING' } },
      },
      {
        ...canonical,
        receipt: {
          ...receipt,
          data: { ...receipt.data, operation_url: `/v1/oapi/runs/${requestId}` },
        },
      },
      {
        ...canonical,
        receipt: {
          ...receipt,
          data: { ...receipt.data, run_id: requestId },
        },
      },
      {
        ...canonical,
        receipt: {
          ...receipt,
          data: { ...receipt.data, server_authority: 'must-not-survive' },
        },
      },
      {
        ...canonical,
        receipt: otherRunReceipt,
      },
    ];

    for (const fact of malformedFacts) {
      expect(() => decideIdempotency({ current: fact as never })).toThrowError(
        /RUN_IDEMPOTENCY_INVALID/,
      );
    }
  });

  it('schema-clones and recursively freezes the replayed canonical 202 receipt', () => {
    const callerReceipt = {
      http_status: 202 as const,
      data: {
        status: 'QUEUED' as const,
        run_id: runId,
        accepted_request_id: requestId,
        operation_url: `/v1/oapi/runs/${runId}`,
        events_url: `/v1/oapi/runs/${runId}/events`,
        cancel_url: `/v1/oapi/runs/${runId}/cancel`,
      },
    };
    const stored = {
      namespace: {
        ...namespace,
        authenticated_principal: { ...namespace.authenticated_principal },
      },
      intent_hash: intent.intent_hash,
      target: { run_id: runId },
      receipt: callerReceipt,
    };

    const decision = decideIdempotency({ current: stored, stored });
    if (decision.decision !== 'REPLAY') throw new Error('expected an idempotency replay');

    expect(decision.receipt).toEqual(callerReceipt);
    expect(decision.receipt).not.toBe(callerReceipt);
    expect(decision.receipt.data).not.toBe(callerReceipt.data);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.receipt)).toBe(true);
    expect(Object.isFrozen(decision.receipt.data)).toBe(true);

    callerReceipt.data.operation_url = '/caller-tampered';
    expect(decision.receipt.data.operation_url).toBe(`/v1/oapi/runs/${runId}`);
    expect(Reflect.set(decision.receipt.data, 'status', 'RUNNING')).toBe(false);
    expect(decision.receipt.data.status).toBe('QUEUED');
  });
});
