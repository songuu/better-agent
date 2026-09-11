import type {
  AgentActionDecisionResult,
  AgentModelRuntime,
  AgentModelGenerationInput,
  AgentModelGenerationResult,
  AgentToolCapability,
} from './index.js';

export interface OpenAiAgentRuntimeOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetchImplementation?: typeof fetch;
  /** Provider-native model selected by the deployment, if it differs from the product alias. */
  readonly providerModel?: string;
  readonly timeoutMs?: number;
}

export interface AgentRuntimeEnvironment {
  readonly BETTER_AGENT_MODEL_API_KEY?: string;
  readonly BETTER_AGENT_MODEL_BASE_URL?: string;
  readonly BETTER_AGENT_MODEL_NAME?: string;
}

const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const PROVIDER_MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;

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
      const contentEntry = entry as Record<string, unknown>;
      if (contentEntry.type !== 'output_text') continue;
      const text = contentEntry.text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n').trim();
}

function isDeepSeekV4Model(model: string): boolean {
  return /^deepseek-v4-[A-Za-z0-9._-]+$/u.test(model);
}

function isOutputBudgetExhausted(payload: Record<string, unknown>): boolean {
  if (payload.status !== 'incomplete') return false;
  const details = payload.incomplete_details;
  return (
    typeof details === 'object' &&
    details !== null &&
    (details as Record<string, unknown>).reason === 'max_output_tokens'
  );
}

export class OpenAiAgentRuntime implements AgentModelRuntime {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #providerModel: string | undefined;
  readonly #timeoutMs: number;

  constructor(options: OpenAiAgentRuntimeOptions) {
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
    if (options.providerModel !== undefined && !PROVIDER_MODEL_NAME.test(options.providerModel)) {
      throw new Error('model_name_is_invalid');
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = url.toString().replace(/\/$/u, '');
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#providerModel = options.providerModel;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  async generate(input: AgentModelGenerationInput): Promise<AgentModelGenerationResult> {
    const messages = input.history.flatMap((turn) => [
      { content: turn.user, role: 'user' },
      { content: turn.assistant, role: 'assistant' },
    ]);
    messages.push({ content: input.prompt, role: 'user' });
    const providerModel = this.#providerModel ?? input.model;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/responses`, {
        body: JSON.stringify({
          input: messages,
          instructions: input.instructions,
          max_output_tokens: input.maxOutputTokens ?? 2_000,
          model: providerModel,
          // DeepSeek thinking tokens share max_output_tokens with the visible answer. Agent
          // protocol calls need the bounded answer, not hidden reasoning that can consume it all.
          ...(isDeepSeekV4Model(providerModel) ? { reasoning: { effort: 'none' } } : {}),
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
    if (outputText.length < 1 && isOutputBudgetExhausted(payload)) {
      throw new Error('model_provider_output_budget_exhausted');
    }
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

  async decideAction(
    input: AgentModelGenerationInput & {
      readonly availableCapabilities: readonly AgentToolCapability[];
    },
  ): Promise<AgentActionDecisionResult> {
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
        available.includes(decision.capability as AgentToolCapability) &&
        typeof decision.input === 'string'
      ) {
        const toolInput = decision.input.trim();
        if (toolInput.length < 1 || toolInput.length > 500) throw new Error('invalid');
        return Object.freeze({
          ...result,
          action: 'tool',
          capability: decision.capability as AgentToolCapability,
          toolInput,
        });
      }
      throw new Error('invalid');
    } catch (error) {
      throw new Error('model_action_invalid_output', { cause: error });
    }
  }
}

export function createAgentModelRuntimeFromEnvironment(
  environment: AgentRuntimeEnvironment = process.env,
): OpenAiAgentRuntime | undefined {
  const apiKey = environment.BETTER_AGENT_MODEL_API_KEY;
  if (apiKey === undefined) return undefined;
  return new OpenAiAgentRuntime({
    apiKey,
    baseUrl: environment.BETTER_AGENT_MODEL_BASE_URL ?? 'https://api.openai.com/v1',
    ...(environment.BETTER_AGENT_MODEL_NAME === undefined
      ? {}
      : { providerModel: environment.BETTER_AGENT_MODEL_NAME }),
  });
}
