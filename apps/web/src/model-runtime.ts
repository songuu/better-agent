import { OpenAiAgentRuntime } from '@better-agent/agent-runtime';

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

export class OpenAiResponsesRuntime extends OpenAiAgentRuntime implements ProductModelRuntime {
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
