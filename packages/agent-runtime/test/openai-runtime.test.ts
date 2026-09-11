import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAgentModelRuntimeFromEnvironment,
  OpenAiAgentRuntime,
} from '../src/openai-runtime.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shared OpenAI-compatible Agent runtime', () => {
  it('generates bounded output for Web and worker consumers', async () => {
    const fetchImplementation = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: 'resp_shared_1',
            output_text: 'verified',
            usage: { input_tokens: 7, output_tokens: 2 },
          }),
          { status: 200 },
        ),
    );
    const runtime = new OpenAiAgentRuntime({
      apiKey: 'test-secret',
      baseUrl: 'https://models.example.test/v1',
      fetchImplementation,
    });

    await expect(
      runtime.generate({
        history: [],
        instructions: 'verify',
        model: 'gpt-5.5',
        prompt: 'status',
      }),
    ).resolves.toEqual({
      inputTokens: 7,
      outputText: 'verified',
      outputTokens: 2,
      providerRequestId: 'resp_shared_1',
    });
    const request = fetchImplementation.mock.calls[0]?.[1];
    if (request === undefined) throw new Error('provider request was not sent');
    expect(JSON.parse(String(request.body))).not.toHaveProperty('reasoning');
  });

  it('ignores DeepSeek reasoning items and returns only final output text', async () => {
    const requests: RequestInit[] = [];
    const runtime = new OpenAiAgentRuntime({
      apiKey: 'test-secret',
      baseUrl: 'https://api.deepseek.com',
      fetchImplementation: async (_input, init) => {
        requests.push(init ?? {});
        return new Response(
          JSON.stringify({
            id: 'resp_deepseek_1',
            output: [
              {
                type: 'reasoning',
                content: [{ type: 'reasoning_text', text: 'internal reasoning' }],
              },
              {
                type: 'message',
                content: [{ type: 'output_text', text: '{"result":"verified"}' }],
              },
            ],
            usage: { input_tokens: 11, output_tokens: 5 },
          }),
          { status: 200 },
        );
      },
    });

    await expect(
      runtime.generate({
        history: [],
        instructions: 'return json',
        model: 'deepseek-v4-flash',
        prompt: 'status',
      }),
    ).resolves.toMatchObject({ outputText: '{"result":"verified"}' });
    expect(JSON.parse(String(requests[0]?.body))).toMatchObject({
      reasoning: { effort: 'none' },
    });
  });

  it('reports a DeepSeek reasoning-only truncation as an exhausted output budget', async () => {
    const runtime = new OpenAiAgentRuntime({
      apiKey: 'test-secret',
      baseUrl: 'https://api.deepseek.com',
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            id: 'resp_deepseek_exhausted',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [
              {
                type: 'reasoning',
                content: [{ type: 'reasoning_text', text: 'budget consumed' }],
              },
            ],
            status: 'incomplete',
            usage: {
              input_tokens: 10,
              output_tokens: 3200,
              output_tokens_details: { reasoning_tokens: 3200 },
            },
          }),
          { status: 200 },
        ),
    });

    await expect(
      runtime.generate({
        history: [],
        instructions: 'return json',
        maxOutputTokens: 3200,
        model: 'deepseek-v4-flash',
        prompt: 'status',
      }),
    ).rejects.toThrow('model_provider_output_budget_exhausted');
  });

  it('does not create an unconfigured runtime', () => {
    expect(createAgentModelRuntimeFromEnvironment({})).toBeUndefined();
  });

  it('creates the same runtime from an isolated environment map', () => {
    expect(
      createAgentModelRuntimeFromEnvironment({
        BETTER_AGENT_MODEL_API_KEY: 'test-secret',
        BETTER_AGENT_MODEL_BASE_URL: 'https://models.example.test/v1',
        BETTER_AGENT_MODEL_NAME: 'provider-deployment-model',
      }),
    ).toBeInstanceOf(OpenAiAgentRuntime);
  });

  it('uses the deployment-selected provider model instead of the product-facing model alias', async () => {
    const requests: RequestInit[] = [];
    const fetchImplementation: typeof fetch = async (_input, init) => {
      requests.push(init ?? {});
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_provider_model',
          output_text: 'verified',
          usage: { input_tokens: 7, output_tokens: 2 },
        }),
        { status: 200 },
      );
    };
    const runtime = new OpenAiAgentRuntime({
      apiKey: 'test-secret',
      baseUrl: 'https://models.example.test/v1',
      fetchImplementation,
      providerModel: 'provider-deployment-model',
    });
    await runtime.generate({
      history: [],
      instructions: 'verify',
      model: 'deepseek-v4-flash',
      prompt: 'status',
    });

    const request = requests[0];
    if (request === undefined) throw new Error('provider request was not sent');
    expect(JSON.parse(String(request.body))).toMatchObject({ model: 'provider-deployment-model' });
  });

  it('rejects malformed deployment provider model names', () => {
    expect(() =>
      createAgentModelRuntimeFromEnvironment({
        BETTER_AGENT_MODEL_API_KEY: 'test-secret',
        BETTER_AGENT_MODEL_NAME: 'provider model name with spaces',
      }),
    ).toThrow('model_name_is_invalid');
  });
});
