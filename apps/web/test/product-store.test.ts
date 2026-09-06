import { describe, expect, it } from 'vitest';

import {
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

describe('product Agent input', () => {
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
