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
      async () =>
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
  });

  it('ignores DeepSeek reasoning items and returns only final output text', async () => {
    const runtime = new OpenAiAgentRuntime({
      apiKey: 'test-secret',
      baseUrl: 'https://api.deepseek.com',
      fetchImplementation: async () =>
        new Response(
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
        ),
    });

    await expect(
      runtime.generate({
        history: [],
        instructions: 'return json',
        model: 'deepseek-v4-flash',
        prompt: 'status',
      }),
    ).resolves.toMatchObject({ outputText: '{"result":"verified"}' });
  });

  it('does not create an unconfigured runtime', () => {
    expect(createAgentModelRuntimeFromEnvironment({})).toBeUndefined();
  });

  it('creates the same runtime from an isolated environment map', () => {
    expect(
      createAgentModelRuntimeFromEnvironment({
        BETTER_AGENT_MODEL_API_KEY: 'test-secret',
        BETTER_AGENT_MODEL_BASE_URL: 'https://models.example.test/v1',
      }),
    ).toBeInstanceOf(OpenAiAgentRuntime);
  });
});
