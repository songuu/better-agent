import { describe, expect, it, vi } from 'vitest';

import { OpenAiResponsesRuntime } from '../src/model-runtime.js';

describe('OpenAI-compatible product model runtime', () => {
  it('sends the immutable release instructions and returns bounded usage', async () => {
    const fetchImplementation = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: 'resp_123',
            output_text: '已完成核验。',
            usage: { input_tokens: 23, output_tokens: 8 },
          }),
          { headers: { 'Content-Type': 'application/json' }, status: 200 },
        ),
    );
    const runtime = new OpenAiResponsesRuntime({
      apiKey: 'test-secret',
      baseUrl: 'https://models.example.test/v1',
      fetchImplementation,
    });

    const result = await runtime.generate({
      history: [{ assistant: '你好。', user: '你好' }],
      instructions: '只回答已核验事实。',
      model: 'gpt-5.6-sol',
      prompt: '现在状态如何？',
    });

    expect(result).toEqual({
      inputTokens: 23,
      outputText: '已完成核验。',
      outputTokens: 8,
      providerRequestId: 'resp_123',
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://models.example.test/v1/responses',
      expect.objectContaining({ method: 'POST' }),
    );
    const request = fetchImplementation.mock.calls[0]?.[1];
    if (request === undefined) throw new Error('expected model request options');
    expect(request.headers).toEqual(
      expect.objectContaining({ Authorization: 'Bearer test-secret' }),
    );
    expect(JSON.parse(String(request.body))).toMatchObject({
      instructions: '只回答已核验事实。',
      model: 'gpt-5.6-sol',
    });
  });

  it('fails with bounded context without reflecting provider bodies or credentials', async () => {
    const runtime = new OpenAiResponsesRuntime({
      apiKey: 'never-reflect-this',
      baseUrl: 'https://models.example.test/v1/',
      fetchImplementation: async () =>
        new Response('upstream secret and oversized diagnostics', { status: 503 }),
    });

    await expect(
      runtime.generate({ history: [], instructions: 'Do work', model: 'gpt-5.5', prompt: 'Go' }),
    ).rejects.toThrow('model_provider_http_503');
  });

  it('rejects an oversized success response before retaining the provider body', async () => {
    const runtime = new OpenAiResponsesRuntime({
      apiKey: 'never-reflect-this',
      baseUrl: 'https://models.example.test/v1',
      fetchImplementation: async () =>
        new Response('x'.repeat(1024 * 1024 + 1), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
    });

    await expect(
      runtime.generate({ history: [], instructions: 'Do work', model: 'gpt-5.5', prompt: 'Go' }),
    ).rejects.toThrow('model_provider_response_too_large');
  });
});
