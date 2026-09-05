import type { ProductModel } from './product-store.js';

export interface ModelHistoryTurn {
  readonly assistant: string;
  readonly user: string;
}

export interface ModelGenerationInput {
  readonly history: readonly ModelHistoryTurn[];
  readonly instructions: string;
  readonly model: ProductModel;
  readonly prompt: string;
}

export interface ModelGenerationResult {
  readonly inputTokens: number;
  readonly outputText: string;
  readonly outputTokens: number;
  readonly providerRequestId: string;
}

export interface ProductModelRuntime {
  generate(input: ModelGenerationInput): Promise<ModelGenerationResult>;
}

interface OpenAiResponsesRuntimeOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
}

const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

async function readBoundedProviderJson(response: Response): Promise<Record<string, unknown>> {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    (/^(?:0|[1-9][0-9]*)$/u.test(contentLength) === false ||
      Number(contentLength) > MAX_PROVIDER_RESPONSE_BYTES)
  ) {
    throw new Error('model_provider_response_too_large');
  }
  if (response.body === null) throw new Error('model_provider_invalid_json');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('model_provider_response_too_large');
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof Error && error.message === 'model_provider_response_too_large') {
      throw error;
    }
    throw new Error('model_provider_invalid_json', { cause: error });
  } finally {
    reader.releaseLock();
  }
  try {
    const payload: unknown = JSON.parse(text);
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error('provider JSON root must be an object');
    }
    return payload as Record<string, unknown>;
  } catch (error) {
    throw new Error('model_provider_invalid_json', { cause: error });
  }
}

function boundedInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function responseOutputText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === 'string') return payload.output_text.trim();
  if (!Array.isArray(payload.output)) return '';
  const parts: string[] = [];
  for (const item of payload.output) {
    if (typeof item !== 'object' || item === null) continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const entry of content) {
      if (typeof entry !== 'object' || entry === null) continue;
      const text = (entry as Record<string, unknown>).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n').trim();
}

export class OpenAiResponsesRuntime implements ProductModelRuntime {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: OpenAiResponsesRuntimeOptions) {
    if (options.apiKey.length < 8) throw new Error('model_api_key_is_invalid');
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new Error('model_base_url_is_invalid');
    }
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      throw new Error('model_base_url_requires_https');
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = url.toString().replace(/\/$/u, '');
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  async generate(input: ModelGenerationInput): Promise<ModelGenerationResult> {
    const messages = input.history.flatMap((turn) => [
      { content: turn.user, role: 'user' },
      { content: turn.assistant, role: 'assistant' },
    ]);
    messages.push({ content: input.prompt, role: 'user' });
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/responses`, {
        body: JSON.stringify({
          input: messages,
          instructions: input.instructions,
          max_output_tokens: 2_000,
          model: input.model,
          store: false,
        }),
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new Error('model_provider_unreachable', { cause: error });
    }
    if (!response.ok) throw new Error(`model_provider_http_${String(response.status)}`);
    const payload = await readBoundedProviderJson(response);
    const outputText = responseOutputText(payload);
    if (outputText.length < 1 || outputText.length > 50_000) {
      throw new Error('model_provider_invalid_output');
    }
    const providerRequestId = typeof payload.id === 'string' ? payload.id : '';
    if (providerRequestId.length < 1 || providerRequestId.length > 200) {
      throw new Error('model_provider_invalid_request_id');
    }
    const usage =
      typeof payload.usage === 'object' && payload.usage !== null
        ? (payload.usage as Record<string, unknown>)
        : {};
    return Object.freeze({
      inputTokens: boundedInteger(usage.input_tokens),
      outputText,
      outputTokens: boundedInteger(usage.output_tokens),
      providerRequestId,
    });
  }
}

export function createModelRuntimeFromEnvironment(): ProductModelRuntime | undefined {
  const apiKey = process.env.BETTER_AGENT_MODEL_API_KEY;
  if (apiKey === undefined) return undefined;
  return new OpenAiResponsesRuntime({
    apiKey,
    baseUrl: process.env.BETTER_AGENT_MODEL_BASE_URL ?? 'https://api.openai.com/v1',
  });
}
