import { describe, expect, it } from 'vitest';

import {
  compileStructuredAgentInstructions,
  createDefaultAgentStrategyProfile,
  parseAgentStrategyProfile,
  validateAgentInput,
  validateDatabaseQueryInput,
  validateDatabaseRowsInput,
  validateDatabaseTableInput,
  validateFlowDebugInput,
  validateFlowDraftInput,
  validateFlowEnvironment,
  validateKnowledgeBaseInput,
  validateKnowledgeDocumentInput,
  validateKnowledgeQuery,
  validateRunInput,
} from '../src/product-store.js';

const structuredRole = {
  audience: { content: '企业运维团队', weight: 70 },
  constraints: { content: '不猜测，不泄露敏感信息', weight: 100 },
  expertise: { content: 'PostgreSQL 与服务可用性', weight: 80 },
  identity: { content: '可靠的生产运行顾问', weight: 90 },
  objective: { content: '基于证据判断服务状态', weight: 100 },
  process: { content: '先检索证据，再给出结论', weight: 90 },
  tone: { content: '简洁、直接、中文优先', weight: 60 },
};

describe('product Agent input', () => {
  it('validates a closed, versioned strategy and derives safe defaults', () => {
    expect(createDefaultAgentStrategyProfile('gpt-5.5')).toEqual({
      forcedCapability: 'none',
      maxInputTokens: 32_000,
      maxIterations: 1,
      maxOutputTokens: 2_000,
      maxToolCalls: 2,
      parameterDefaults: { databaseContains: '', knowledgeQuery: '' },
      parameterExtraction: false,
      routes: [{ description: '默认模型', model: 'gpt-5.5' }],
      routingMode: 'fixed',
      schemaVersion: 'product-agent-strategy/2',
      temperature: 0.2,
    });
    const strategy = parseAgentStrategyProfile({
      forced_capability: 'knowledge',
      max_input_tokens: 16000,
      max_iterations: 1,
      max_output_tokens: 1200,
      max_tool_calls: 1,
      parameter_defaults: {
        database_contains: 'healthy',
        knowledge_query: '生产健康检查',
      },
      parameter_extraction: true,
      routes: [
        { description: '低成本分类', model: 'gpt-5.4-mini' },
        { description: '复杂推理', model: 'gpt-5.6-sol' },
      ],
      routing_mode: 'autonomous',
      schema_version: 'product-agent-strategy/2',
      temperature: 0.4,
    });
    expect(strategy.routingMode).toBe('autonomous');
    expect(strategy.parameterDefaults).toEqual({
      databaseContains: 'healthy',
      knowledgeQuery: '生产健康检查',
    });
    expect(strategy.routes).toHaveLength(2);
    expect(Object.isFrozen(strategy.routes)).toBe(true);
    expect(Object.isFrozen(strategy.parameterDefaults)).toBe(true);
    expect(
      parseAgentStrategyProfile({
        forced_capability: 'none',
        max_input_tokens: 32000,
        max_iterations: 3,
        max_output_tokens: 2000,
        max_tool_calls: 2,
        parameter_defaults: { database_contains: '', knowledge_query: '' },
        parameter_extraction: false,
        routes: [{ description: '迭代模型', model: 'gpt-5.6-sol' }],
        routing_mode: 'fixed',
        schema_version: 'product-agent-strategy/3',
        temperature: 0.2,
      }),
    ).toMatchObject({ maxIterations: 3, schemaVersion: 'product-agent-strategy/3' });
    expect(
      parseAgentStrategyProfile({
        forced_capability: 'none',
        max_input_tokens: 32000,
        max_iterations: 4,
        max_output_tokens: 2000,
        max_tool_calls: 2,
        parameter_defaults: { database_contains: '', knowledge_query: '' },
        parameter_extraction: false,
        routes: [{ description: '工具决策模型', model: 'gpt-5.6-sol' }],
        routing_mode: 'fixed',
        schema_version: 'product-agent-strategy/4',
        temperature: 0.2,
      }),
    ).toMatchObject({ maxIterations: 4, schemaVersion: 'product-agent-strategy/4' });
    expect(() => parseAgentStrategyProfile({ ...strategy, maxIterations: 2 })).toThrow(
      'Agent strategy v2 supports exactly one model iteration',
    );
    expect(() =>
      parseAgentStrategyProfile({
        ...strategy,
        maxIterations: 5,
        schemaVersion: 'product-agent-strategy/3',
      }),
    ).toThrow('Agent strategy v3 supports 1–4 model iterations');
  });

  it('reads immutable v1 strategy releases with empty parameter defaults', () => {
    expect(
      parseAgentStrategyProfile({
        forced_capability: 'none',
        max_input_tokens: 32000,
        max_iterations: 1,
        max_output_tokens: 2000,
        max_tool_calls: 2,
        parameter_extraction: false,
        routes: [{ description: 'default', model: 'gpt-5.6-sol' }],
        routing_mode: 'fixed',
        schema_version: 'product-agent-strategy/1',
        temperature: 0.2,
      }),
    ).toMatchObject({
      parameterDefaults: { databaseContains: '', knowledgeQuery: '' },
      schemaVersion: 'product-agent-strategy/1',
    });
  });

  it.each([
    [{ schema_version: 'latest' }],
    [{ ...createDefaultAgentStrategyProfile('gpt-5.5'), extra: true }],
    [{ ...createDefaultAgentStrategyProfile('gpt-5.5'), routing_mode: 'fixed' }],
    [
      {
        ...createDefaultAgentStrategyProfile('gpt-5.5'),
        routingMode: 'autonomous',
        routes: [{ description: 'only one', model: 'gpt-5.5' }],
      },
    ],
    [{ ...createDefaultAgentStrategyProfile('gpt-5.5'), maxOutputTokens: 50000 }],
    [
      {
        ...createDefaultAgentStrategyProfile('gpt-5.5'),
        parameterDefaults: { databaseContains: 'x'.repeat(501), knowledgeQuery: '' },
      },
    ],
    [
      {
        ...createDefaultAgentStrategyProfile('gpt-5.5'),
        parameterDefaults: { databaseContains: '', extra: true, knowledgeQuery: '' },
      },
    ],
  ])('rejects an open or unsafe strategy profile', (profile) => {
    expect(() => parseAgentStrategyProfile(profile)).toThrow();
  });

  it('compiles and freezes the closed seven-theme structured role profile', () => {
    const input = validateAgentInput({
      database_table_id: null,
      description: '面向运维团队的助手',
      instructions: 'caller text must not override the structured role',
      knowledge_base_id: '12345678-1234-4123-8123-123456789abc',
      model: 'gpt-5.6-sol',
      name: '运行守望者',
      strategy_profile: {
        forced_capability: 'knowledge',
        max_input_tokens: 16000,
        max_iterations: 1,
        max_output_tokens: 1200,
        max_tool_calls: 1,
        parameter_defaults: { database_contains: '', knowledge_query: '' },
        parameter_extraction: true,
        routes: [
          { description: '默认', model: 'gpt-5.6-sol' },
          { description: '快速', model: 'gpt-5.4-mini' },
        ],
        routing_mode: 'autonomous',
        schema_version: 'product-agent-strategy/2',
        temperature: 0.3,
      },
      role_mode: 'structured',
      role_profile: structuredRole,
    });

    expect(input.roleMode).toBe('structured');
    expect(input.roleProfile).toEqual(structuredRole);
    expect(input.instructions).toBe(compileStructuredAgentInstructions(structuredRole));
    expect(input.strategyProfile.forcedCapability).toBe('knowledge');
    expect(input.instructions).toContain('可靠的生产运行顾问');
    expect(input.instructions).not.toContain('caller text');
    expect(Object.isFrozen(input.roleProfile)).toBe(true);
    expect(Object.isFrozen(input.roleProfile?.identity)).toBe(true);
  });

  it('accepts and freezes the closed product draft payload', () => {
    const input = validateAgentInput({
      description: '面向运维团队的助手',
      database_table_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      instructions: '只根据已核验的运行事实回答。',
      knowledge_base_id: '12345678-1234-4123-8123-123456789abc',
      model: 'gpt-5.6-sol',
      name: '运行守望者',
    });

    expect(input).toEqual({
      databaseTableId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      description: '面向运维团队的助手',
      instructions: '只根据已核验的运行事实回答。',
      knowledgeBaseId: '12345678-1234-4123-8123-123456789abc',
      model: 'gpt-5.6-sol',
      name: '运行守望者',
      roleMode: 'text',
      roleProfile: null,
      strategyProfile: createDefaultAgentStrategyProfile('gpt-5.6-sol'),
    });
    expect(Object.isFrozen(input)).toBe(true);
  });

  it.each([
    [{ description: '', instructions: '', model: 'gpt-5.6-sol', name: 'A' }],
    [{ description: '', extra: true, instructions: 'Do work', model: 'gpt-5.6-sol', name: 'A' }],
    [{ description: '', instructions: 'Do work', model: 'latest', name: 'A' }],
    [
      {
        description: '',
        instructions: 'Do work',
        knowledge_base_id: 'not-a-uuid',
        model: 'gpt-5.6-sol',
        name: 'A',
      },
    ],
    [
      {
        description: '',
        instructions: '',
        model: 'gpt-5.6-sol',
        name: 'A',
        role_mode: 'structured',
        role_profile: { ...structuredRole, identity: { content: '', weight: 90 } },
      },
    ],
    [
      {
        description: '',
        instructions: '',
        model: 'gpt-5.6-sol',
        name: 'A',
        role_mode: 'structured',
        role_profile: { ...structuredRole, extra: { content: '扩展字段', weight: 1 } },
      },
    ],
    [
      {
        database_table_id: 'not-a-uuid',
        description: '',
        instructions: 'Do work',
        model: 'gpt-5.6-sol',
        name: 'A',
      },
    ],
  ])('rejects an incomplete, open or mutable draft payload', (payload) => {
    expect(() => validateAgentInput(payload)).toThrow();
  });
});

describe('product Knowledge input', () => {
  it('accepts closed bounded base, document and query inputs', () => {
    expect(validateKnowledgeBaseInput({ description: '已核验手册', name: '运维知识库' })).toEqual({
      description: '已核验手册',
      name: '运维知识库',
    });
    expect(
      validateKnowledgeDocumentInput({ content: '服务健康检查使用 /healthz。', title: '运行手册' }),
    ).toMatchObject({ title: '运行手册' });
    expect(validateKnowledgeQuery('  健康检查  ')).toBe('健康检查');
  });

  it.each([
    [{ description: '', name: '' }],
    [{ description: '', extra: true, name: '知识库' }],
    [{ content: '', title: '空文档' }],
    [{ content: '内容', title: '' }],
  ])('rejects malformed Knowledge inputs', (input) => {
    expect(() =>
      'name' in input ? validateKnowledgeBaseInput(input) : validateKnowledgeDocumentInput(input),
    ).toThrow();
  });

  it('rejects empty and oversized search queries', () => {
    expect(() => validateKnowledgeQuery('')).toThrow();
    expect(() => validateKnowledgeQuery('x'.repeat(501))).toThrow();
  });
});

describe('product Database input', () => {
  it('accepts closed table, scalar row and bounded query payloads', () => {
    expect(
      validateDatabaseTableInput({
        columns: ['customer_id', 'status'],
        description: '客户状态投影',
        name: 'customers',
      }),
    ).toEqual({
      columns: ['customer_id', 'status'],
      description: '客户状态投影',
      name: 'customers',
    });
    expect(validateDatabaseRowsInput({ rows: [{ customer_id: 7, status: 'active' }] })).toEqual({
      rows: [{ customer_id: 7, status: 'active' }],
    });
    expect(validateDatabaseQueryInput({ column: 'status', contains: 'active', limit: 20 })).toEqual(
      {
        column: 'status',
        contains: 'active',
        limit: 20,
      },
    );
  });

  it.each([
    [{ columns: [], description: '', name: 'empty' }],
    [{ columns: ['bad-column'], description: '', name: 'bad' }],
    [{ columns: ['id', 'id'], description: '', name: 'duplicate' }],
    [{ rows: [{ nested: { unsafe: true } }] }],
    [{ rows: [{ score: Number.NaN }] }],
    [{ column: 'status', contains: '', limit: 101 }],
  ])('rejects unsafe or unbounded Database payloads', (payload) => {
    expect(() =>
      'columns' in payload
        ? validateDatabaseTableInput(payload)
        : 'rows' in payload
          ? validateDatabaseRowsInput(payload)
          : validateDatabaseQueryInput(payload),
    ).toThrow();
  });
});

describe('product Run input', () => {
  it('accepts a closed bounded message', () => {
    expect(validateRunInput({ message: '  请核对当前状态。  ' })).toEqual({
      message: '请核对当前状态。',
    });
  });

  it.each([
    [null],
    [{}],
    [{ message: '' }],
    [{ message: 'x'.repeat(8_001) }],
    [{ extra: true, message: 'hello' }],
  ])('rejects malformed, empty, oversized or open input', (input) => {
    expect(() => validateRunInput(input)).toThrow();
  });
});

describe('product Flow input', () => {
  const graph = {
    edges: [
      { id: 'input_prompt', source: 'input', target: 'prompt' },
      { id: 'prompt_output', source: 'prompt', target: 'output' },
    ],
    nodes: [
      { config: { key: 'message' }, id: 'input', label: '输入', type: 'input' },
      {
        config: { template: '处理 {{message}}' },
        id: 'prompt',
        label: '模板',
        type: 'template',
      },
      { config: { source: 'prompt' }, id: 'output', label: '输出', type: 'output' },
    ],
  };

  it('accepts a closed bounded Flow draft and debug request', () => {
    expect(
      validateFlowDraftInput({ description: '串联输入与模板', graph, name: '快速处理' }),
    ).toMatchObject({ description: '串联输入与模板', name: '快速处理' });
    expect(validateFlowDebugInput({ input: '  验证映射  ' })).toBe('验证映射');
    expect(validateFlowEnvironment('production')).toBe('production');
  });

  it.each([
    [{ description: '', graph, name: '' }],
    [{ description: '', extra: true, graph, name: 'Flow' }],
    [{ description: '', graph: { edges: [], nodes: [] }, name: 'Flow' }],
  ])('rejects malformed Flow drafts', (input) => {
    expect(() => validateFlowDraftInput(input)).toThrow();
  });

  it('rejects open debug input and unknown deployment environments', () => {
    expect(() => validateFlowDebugInput({ input: 'ok', extra: true })).toThrow();
    expect(() => validateFlowEnvironment('preview')).toThrow('unsupported');
  });
});
