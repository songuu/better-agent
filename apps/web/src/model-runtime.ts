import type {
  ProductAgentModelRoute,
  ProductAgentToolCapability,
  ProductModel,
} from './product-store.js';

export interface ModelHistoryTurn {
  readonly assistant: string;
  readonly user: string;
}

export interface ModelGenerationInput {
  readonly history: readonly ModelHistoryTurn[];
  readonly instructions: string;
  readonly maxOutputTokens?: number;
  readonly model: ProductModel;
  readonly prompt: string;
  readonly temperature?: number;
}

export interface ModelGenerationResult {
  readonly inputTokens: number;
  readonly outputText: string;
  readonly outputTokens: number;
  readonly providerRequestId: string;
}

export type ProductAgentActionDecision =
  | {
      readonly action: 'final';
      readonly finalOutput: string;
    }
  | {
      readonly action: 'tool';
      readonly capability: ProductAgentToolCapability;
      readonly toolInput: string;
    };

export type ModelActionDecisionResult = ModelGenerationResult & ProductAgentActionDecision;

export interface ProductAgentExtractedParameters {
  readonly databaseContains: string;
  readonly knowledgeQuery: string;
}

export interface ProductModelRuntime {
  decideAction?(
    input: ModelGenerationInput & {
      readonly availableCapabilities: readonly ProductAgentToolCapability[];
    },
  ): Promise<ModelActionDecisionResult>;
  extractParameters?(input: {
    readonly maxOutputTokens: number;
    readonly model: ProductModel;
    readonly prompt: string;
  }): Promise<ModelGenerationResult & ProductAgentExtractedParameters>;
  generate(input: ModelGenerationInput): Promise<ModelGenerationResult>;
  selectModel?(input: {
    readonly defaultModel: ProductModel;
    readonly prompt: string;
    readonly routes: readonly ProductAgentModelRoute[];
  }): Promise<ModelGenerationResult & { readonly model: ProductModel }>;
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
          max_output_tokens: input.maxOutputTokens ?? 2_000,
          model: input.model,
          store: false,
          ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
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

  async extractParameters(input: {
    readonly maxOutputTokens: number;
    readonly model: ProductModel;
    readonly prompt: string;
  }): Promise<ModelGenerationResult & ProductAgentExtractedParameters> {
    const result = await this.generate({
      history: [],
      instructions: [
        '你是 Agent 能力参数抽取器。只输出一个 JSON 对象，且只能包含以下两个字段：',
        'knowledge_query：用于知识检索的字符串，0–500 字符；无法确定时输出空字符串以使用已发布默认值。',
        'database_contains：用于收窄数据库快照记录的字符串，0–500 字符；无需过滤时输出空字符串。',
        '不得输出 Markdown、解释或其他字段。',
      ].join('\n'),
      maxOutputTokens: Math.min(256, input.maxOutputTokens),
      model: input.model,
      prompt: input.prompt,
      temperature: 0,
    });
    try {
      const parsed: unknown = JSON.parse(result.outputText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('invalid');
      }
      const record = parsed as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      if (
        keys.length !== 2 ||
        keys[0] !== 'database_contains' ||
        keys[1] !== 'knowledge_query' ||
        typeof record.database_contains !== 'string' ||
        typeof record.knowledge_query !== 'string'
      ) {
        throw new Error('invalid');
      }
      const databaseContains = record.database_contains.trim();
      const knowledgeQuery = record.knowledge_query.trim();
      if (databaseContains.length > 500 || knowledgeQuery.length > 500) {
        throw new Error('invalid');
      }
      return Object.freeze({ ...result, databaseContains, knowledgeQuery });
    } catch (error) {
      throw new Error('model_parameter_extraction_invalid_output', { cause: error });
    }
  }

  async decideAction(
    input: ModelGenerationInput & {
      readonly availableCapabilities: readonly ProductAgentToolCapability[];
    },
  ): Promise<ModelActionDecisionResult> {
    const available = [...new Set(input.availableCapabilities)];
    if (
      available.some(
        (capability) =>
          capability !== 'knowledge' && capability !== 'database' && capability !== 'subagent',
      )
    ) {
      throw new Error('model_action_capabilities_invalid');
    }
    const result = await this.generate({
      history: input.history,
      instructions: [
        input.instructions,
        '',
        'AGENT_ACTION_PROTOCOL_V1',
        '只输出一个 JSON 对象，不得输出 Markdown 或解释。',
        '直接回答：{"action":"final","output":"1–50000 字符的最终回答"}',
        ...(available.length === 0
          ? ['当前没有可调用能力。']
          : [
              '调用能力：{"action":"tool","capability":"knowledge|database|subagent","input":"1–500 字符"}',
              `可调用能力：${available.join(',')}`,
            ]),
        'END_AGENT_ACTION_PROTOCOL_V1',
      ].join('\n'),
      model: input.model,
      prompt: input.prompt,
      ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    });
    try {
      const parsed: unknown = JSON.parse(result.outputText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('invalid');
      }
      const decision = parsed as Record<string, unknown>;
      if (
        decision.action === 'final' &&
        Object.keys(decision).sort().join(',') === 'action,output' &&
        typeof decision.output === 'string'
      ) {
        const finalOutput = decision.output.trim();
        if (finalOutput.length < 1 || finalOutput.length > 50_000) throw new Error('invalid');
        return Object.freeze({ ...result, action: 'final', finalOutput });
      }
      if (
        decision.action === 'tool' &&
        Object.keys(decision).sort().join(',') === 'action,capability,input' &&
        available.includes(decision.capability as ProductAgentToolCapability) &&
        typeof decision.input === 'string'
      ) {
        const toolInput = decision.input.trim();
        if (toolInput.length < 1 || toolInput.length > 500) throw new Error('invalid');
        return Object.freeze({
          ...result,
          action: 'tool',
          capability: decision.capability as ProductAgentToolCapability,
          toolInput,
        });
      }
      throw new Error('invalid');
    } catch (error) {
      throw new Error('model_action_invalid_output', { cause: error });
    }
  }

  async selectModel(input: {
    readonly defaultModel: ProductModel;
    readonly prompt: string;
    readonly routes: readonly ProductAgentModelRoute[];
  }): Promise<ModelGenerationResult & { readonly model: ProductModel }> {
    const allowedModels = new Set(input.routes.map((route) => route.model));
    const result = await this.generate({
      history: [],
      instructions: [
        '你是模型路由器。只输出 JSON：{"model":"<allowed model>"}。',
        ...input.routes.map((route) => `${route.model}: ${route.description}`),
      ].join('\n'),
      maxOutputTokens: 64,
      model: input.defaultModel,
      prompt: input.prompt,
      temperature: 0,
    });
    try {
      const parsed: unknown = JSON.parse(result.outputText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error('invalid');
      const record = parsed as Record<string, unknown>;
      if (
        Object.keys(record).length !== 1 ||
        typeof record.model !== 'string' ||
        !allowedModels.has(record.model as ProductModel)
      )
        throw new Error('invalid');
      return Object.freeze({ ...result, model: record.model as ProductModel });
    } catch (error) {
      throw new Error('model_router_invalid_output', { cause: error });
    }
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
