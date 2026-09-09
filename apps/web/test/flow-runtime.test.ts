import { describe, expect, it } from 'vitest';

import {
  executeProductFlow,
  executeProductFlowWithApis,
  validateProductFlowGraph,
} from '../src/flow-runtime.js';

const graph = {
  edges: [
    { id: 'edge_input_prompt', source: 'input', target: 'prompt' },
    { id: 'edge_prompt_output', source: 'prompt', target: 'output' },
  ],
  nodes: [
    { config: { key: 'message' }, id: 'input', label: '输入', type: 'input' },
    {
      config: { template: '已处理：{{message}}' },
      id: 'prompt',
      label: '模板',
      type: 'template',
    },
    { config: { source: 'prompt' }, id: 'output', label: '输出', type: 'output' },
  ],
};

describe('product Flow runtime', () => {
  it('executes a version-pinned Database Operation through the supplied executor', async () => {
    const databaseGraph = {
      edges: [
        { id: 'edge_input_database', source: 'input', target: 'database' },
        { id: 'edge_database_output', source: 'database', target: 'output' },
      ],
      nodes: [
        { config: { key: 'message' }, id: 'input', label: '输入', type: 'input' },
        {
          config: {
            operationId: 'd1000000-0000-4000-8000-000000000001',
            operationRevision: 4,
            source: 'input',
          },
          id: 'database',
          label: '客户查询',
          type: 'database',
        },
        { config: { source: 'database' }, id: 'output', label: '输出', type: 'output' },
      ],
    };
    const calls: unknown[] = [];

    const result = await executeProductFlowWithApis(
      databaseGraph,
      { input: 'active' },
      async () => 'unused',
      async (request) => {
        calls.push(request);
        return '[{"customer_id":1,"status":"active"}]';
      },
    );

    expect(calls).toEqual([
      {
        input: 'active',
        operationId: 'd1000000-0000-4000-8000-000000000001',
        operationRevision: 4,
      },
    ]);
    expect(result.output).toBe('[{"customer_id":1,"status":"active"}]');
  });

  it('rejects unpinned and disconnected Database Operation nodes', () => {
    const databaseNode = {
      config: {
        operationId: 'd1000000-0000-4000-8000-000000000001',
        operationRevision: 1,
        source: 'input',
      },
      id: 'database',
      label: '客户查询',
      type: 'database',
    };
    const databaseGraph = {
      edges: [
        { id: 'edge_input_database', source: 'input', target: 'database' },
        { id: 'edge_database_output', source: 'database', target: 'output' },
      ],
      nodes: [
        { config: { key: 'message' }, id: 'input', label: '输入', type: 'input' },
        databaseNode,
        { config: { source: 'database' }, id: 'output', label: '输出', type: 'output' },
      ],
    };

    expect(() =>
      validateProductFlowGraph({
        ...databaseGraph,
        nodes: databaseGraph.nodes.map((node) =>
          node.id === 'database'
            ? { ...node, config: { ...databaseNode.config, operationRevision: 0 } }
            : node,
        ),
      }),
    ).toThrow('Database Operation revision');
    expect(() =>
      validateProductFlowGraph({
        ...databaseGraph,
        edges: databaseGraph.edges.filter((edge) => edge.target !== 'database'),
      }),
    ).toThrow('source must be connected');
  });

  it('executes a pinned custom API node through the supplied secure executor', async () => {
    const apiGraph = {
      edges: [
        { id: 'edge_input_api', source: 'input', target: 'api' },
        { id: 'edge_api_output', source: 'api', target: 'output' },
      ],
      nodes: [
        { config: { key: 'message' }, id: 'input', label: '输入', type: 'input' },
        {
          config: {
            apiId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            apiRevision: 3,
            method: 'POST',
            responsePath: 'data.answer',
            source: 'input',
            url: 'https://api.example.com/v1/answer',
          },
          id: 'api',
          label: '业务 API',
          type: 'api',
        },
        { config: { source: 'api' }, id: 'output', label: '输出', type: 'output' },
      ],
    };
    const calls: unknown[] = [];

    const result = await executeProductFlowWithApis(
      apiGraph,
      { input: '查询订单' },
      async (request) => {
        calls.push(request);
        return '已受理';
      },
    );

    expect(calls).toEqual([
      {
        input: '查询订单',
        method: 'POST',
        responsePath: 'data.answer',
        url: 'https://api.example.com/v1/answer',
      },
    ]);
    expect(result.output).toBe('已受理');
    expect(result.logs.at(-2)).toEqual({
      nodeId: 'api',
      outputPreview: '已受理',
      status: 'completed',
    });
  });

  it('rejects unpinned, unsafe and disconnected custom API nodes', () => {
    const apiNode = {
      config: {
        apiId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        apiRevision: 1,
        method: 'GET',
        responsePath: '',
        source: 'input',
        url: 'https://api.example.com/value',
      },
      id: 'api',
      label: 'API',
      type: 'api',
    };
    const apiGraph = {
      edges: [
        { id: 'edge_input_api', source: 'input', target: 'api' },
        { id: 'edge_api_output', source: 'api', target: 'output' },
      ],
      nodes: [
        { config: { key: 'message' }, id: 'input', label: '输入', type: 'input' },
        apiNode,
        { config: { source: 'api' }, id: 'output', label: '输出', type: 'output' },
      ],
    };

    for (const url of [
      'http://api.example.com/value',
      'https://localhost/value',
      'https://127.0.0.1/value',
      'https://user:secret@api.example.com/value',
      'https://api.example.com:8443/value',
      'https://api.example.com/value#fragment',
    ]) {
      expect(() =>
        validateProductFlowGraph({
          ...apiGraph,
          nodes: apiGraph.nodes.map((node) =>
            node.id === 'api' ? { ...node, config: { ...apiNode.config, url } } : node,
          ),
        }),
      ).toThrow(/API|custom_api/u);
    }
    expect(() =>
      validateProductFlowGraph({
        ...apiGraph,
        edges: apiGraph.edges.filter((edge) => edge.target !== 'api'),
      }),
    ).toThrow('source must be connected');
  });

  it('executes a connected versioned builtin plugin operation', () => {
    const pluginGraph = {
      edges: [
        { id: 'edge_input_plugin', source: 'input', target: 'plugin' },
        { id: 'edge_plugin_output', source: 'plugin', target: 'output' },
      ],
      nodes: [
        { config: { key: 'message' }, id: 'input', label: '输入', type: 'input' },
        {
          config: {
            operation: 'character_count',
            plugin: 'builtin.text.v1',
            source: 'input',
          },
          id: 'plugin',
          label: '文本工具',
          type: 'plugin',
        },
        { config: { source: 'plugin' }, id: 'output', label: '输出', type: 'output' },
      ],
    };

    expect(executeProductFlow(pluginGraph, { input: '你好 Agent' }).output).toBe('8');
  });

  it('executes a version-pinned custom Plugin through the secure HTTP executor', async () => {
    const pluginGraph = {
      edges: [
        { id: 'edge_input_plugin', source: 'input', target: 'plugin' },
        { id: 'edge_plugin_output', source: 'plugin', target: 'output' },
      ],
      nodes: [
        { config: { key: 'message' }, id: 'input', label: '输入', type: 'input' },
        {
          config: {
            endpointUrl: 'https://plugins.example.com/tools/summarize',
            operation: 'summarize',
            plugin: 'custom.f1000000000040008000000000000001.v3',
            pluginId: 'f1000000-0000-4000-8000-000000000001',
            pluginRevision: 3,
            responsePath: 'result.text',
            source: 'input',
          },
          id: 'plugin',
          label: '摘要插件',
          type: 'plugin',
        },
        { config: { source: 'plugin' }, id: 'output', label: '输出', type: 'output' },
      ],
    };
    const calls: unknown[] = [];

    const result = await executeProductFlowWithApis(
      pluginGraph,
      { input: '待摘要内容' },
      async (call) => {
        calls.push(call);
        return '摘要结果';
      },
    );

    expect(calls).toEqual([
      {
        input: '待摘要内容',
        method: 'POST',
        responsePath: 'result.text',
        url: 'https://plugins.example.com/tools/summarize',
      },
    ]);
    expect(result.output).toBe('摘要结果');
  });

  it('rejects unknown plugin identities, operations and disconnected plugin inputs', () => {
    const pluginNode = {
      config: {
        operation: 'character_count',
        plugin: 'builtin.text.v1',
        source: 'input',
      },
      id: 'plugin',
      label: '文本工具',
      type: 'plugin',
    };
    const pluginGraph = {
      edges: [
        { id: 'edge_input_plugin', source: 'input', target: 'plugin' },
        { id: 'edge_plugin_output', source: 'plugin', target: 'output' },
      ],
      nodes: [
        { config: { key: 'message' }, id: 'input', label: '输入', type: 'input' },
        pluginNode,
        { config: { source: 'plugin' }, id: 'output', label: '输出', type: 'output' },
      ],
    };

    expect(() =>
      validateProductFlowGraph({
        ...pluginGraph,
        nodes: pluginGraph.nodes.map((node) =>
          node.id === 'plugin'
            ? { ...node, config: { ...pluginNode.config, plugin: 'custom.network' } }
            : node,
        ),
      }),
    ).toThrow('Plugin identity');
    expect(() =>
      validateProductFlowGraph({
        ...pluginGraph,
        nodes: pluginGraph.nodes.map((node) =>
          node.id === 'plugin'
            ? { ...node, config: { ...pluginNode.config, operation: 'eval' } }
            : node,
        ),
      }),
    ).toThrow('Plugin operation');
    expect(() =>
      validateProductFlowGraph({
        ...pluginGraph,
        edges: pluginGraph.edges.filter((edge) => edge.target !== 'plugin'),
      }),
    ).toThrow('source must be connected');
  });

  it('executes transform, plugin and condition nodes in one connected pipeline', () => {
    const combinedGraph = {
      edges: [
        { id: 'input_prompt', source: 'input', target: 'prompt' },
        { id: 'prompt_transform', source: 'prompt', target: 'transform' },
        { id: 'transform_plugin', source: 'transform', target: 'plugin' },
        { id: 'plugin_condition', source: 'plugin', target: 'condition' },
        { id: 'condition_output', source: 'condition', target: 'output' },
      ],
      nodes: [
        { config: { key: 'message' }, id: 'input', label: '输入', type: 'input' },
        {
          config: { template: '{{message}}' },
          id: 'prompt',
          label: '模板',
          type: 'template',
        },
        {
          config: { operation: 'uppercase', source: 'prompt' },
          id: 'transform',
          label: '变换',
          type: 'transform',
        },
        {
          config: {
            operation: 'character_count',
            plugin: 'builtin.text.v1',
            source: 'transform',
          },
          id: 'plugin',
          label: '文本插件',
          type: 'plugin',
        },
        {
          config: {
            operand: '5',
            operator: 'equals',
            source: 'plugin',
            whenFalse: '长度异常：{{value}}',
            whenTrue: '长度正确：{{value}}',
          },
          id: 'condition',
          label: '条件',
          type: 'condition',
        },
        { config: { source: 'condition' }, id: 'output', label: '输出', type: 'output' },
      ],
    };

    expect(executeProductFlow(combinedGraph, { input: 'Agent' })).toEqual({
      logs: [
        { nodeId: 'input', outputPreview: 'Agent', status: 'completed' },
        { nodeId: 'prompt', outputPreview: 'Agent', status: 'completed' },
        { nodeId: 'transform', outputPreview: 'AGENT', status: 'completed' },
        { nodeId: 'plugin', outputPreview: '5', status: 'completed' },
        { nodeId: 'condition', outputPreview: '长度正确：5', status: 'completed' },
        { nodeId: 'output', outputPreview: '长度正确：5', status: 'completed' },
      ],
      output: '长度正确：5',
    });
  });

  it('executes a connected allowlisted transform without evaluating code', () => {
    const transformGraph = {
      edges: [
        { id: 'edge_input_transform', source: 'input', target: 'transform' },
        { id: 'edge_transform_output', source: 'transform', target: 'output' },
      ],
      nodes: [
        { config: { key: 'message' }, id: 'input', label: '输入', type: 'input' },
        {
          config: { operation: 'uppercase', source: 'input' },
          id: 'transform',
          label: '受控变换',
          type: 'transform',
        },
        { config: { source: 'transform' }, id: 'output', label: '输出', type: 'output' },
      ],
    };

    expect(executeProductFlow(transformGraph, { input: 'Release 36' }).output).toBe('RELEASE 36');
  });

  it('rejects unsupported or disconnected transforms', () => {
    const transform = {
      config: { operation: 'eval', source: 'input' },
      id: 'transform',
      label: '禁止执行',
      type: 'transform',
    };
    const transformGraph = {
      edges: [
        { id: 'edge_input_transform', source: 'input', target: 'transform' },
        { id: 'edge_transform_output', source: 'transform', target: 'output' },
      ],
      nodes: [
        { config: { key: 'message' }, id: 'input', label: '输入', type: 'input' },
        transform,
        { config: { source: 'transform' }, id: 'output', label: '输出', type: 'output' },
      ],
    };
    expect(() => validateProductFlowGraph(transformGraph)).toThrow('Transform operation');
    expect(() =>
      validateProductFlowGraph({
        ...transformGraph,
        edges: transformGraph.edges.filter((edge) => edge.target !== 'transform'),
        nodes: transformGraph.nodes.map((node) =>
          node.id === 'transform'
            ? { ...node, config: { operation: 'trim', source: 'input' } }
            : node,
        ),
      }),
    ).toThrow('source must be connected');
  });

  it('executes a closed condition node against a connected upstream value', () => {
    const conditionalGraph = {
      edges: [
        { id: 'edge_input_prompt', source: 'input', target: 'prompt' },
        { id: 'edge_prompt_condition', source: 'prompt', target: 'route' },
        { id: 'edge_condition_output', source: 'route', target: 'output' },
      ],
      nodes: [
        { config: { key: 'message' }, id: 'input', label: '输入', type: 'input' },
        {
          config: { template: '工单：{{message}}' },
          id: 'prompt',
          label: '模板',
          type: 'template',
        },
        {
          config: {
            operand: '紧急',
            operator: 'contains',
            source: 'prompt',
            whenFalse: '普通队列：{{value}}',
            whenTrue: '紧急队列：{{value}}',
          },
          id: 'route',
          label: '条件路由',
          type: 'condition',
        },
        { config: { source: 'route' }, id: 'output', label: '输出', type: 'output' },
      ],
    };

    expect(executeProductFlow(conditionalGraph, { input: '紧急处理' })).toEqual({
      logs: [
        { nodeId: 'input', outputPreview: '紧急处理', status: 'completed' },
        { nodeId: 'prompt', outputPreview: '工单：紧急处理', status: 'completed' },
        { nodeId: 'route', outputPreview: '紧急队列：工单：紧急处理', status: 'completed' },
        { nodeId: 'output', outputPreview: '紧急队列：工单：紧急处理', status: 'completed' },
      ],
      output: '紧急队列：工单：紧急处理',
    });
    expect(executeProductFlow(conditionalGraph, { input: '例行检查' }).output).toBe(
      '普通队列：工单：例行检查',
    );
  });

  it('rejects open, unsupported and disconnected condition configuration', () => {
    const condition = {
      config: {
        operand: 'ok',
        operator: 'equals',
        source: 'prompt',
        whenFalse: 'NO',
        whenTrue: 'YES',
      },
      id: 'route',
      label: '条件',
      type: 'condition',
    };
    const conditionalGraph = {
      edges: [
        ...graph.edges.slice(0, 1),
        { id: 'edge_prompt_route', source: 'prompt', target: 'route' },
        { id: 'edge_route_output', source: 'route', target: 'output' },
      ],
      nodes: [
        ...graph.nodes.slice(0, 2),
        condition,
        { config: { source: 'route' }, id: 'output', label: '输出', type: 'output' },
      ],
    };
    expect(() =>
      validateProductFlowGraph({
        ...conditionalGraph,
        nodes: conditionalGraph.nodes.map((node) =>
          node.id === 'route'
            ? { ...node, config: { ...condition.config, operator: 'matches' } }
            : node,
        ),
      }),
    ).toThrow('operator');
    expect(() =>
      validateProductFlowGraph({
        ...conditionalGraph,
        nodes: conditionalGraph.nodes.map((node) =>
          node.id === 'route' ? { ...node, config: { ...condition.config, extra: true } } : node,
        ),
      }),
    ).toThrow('invalid shape');
    expect(() =>
      validateProductFlowGraph({
        ...conditionalGraph,
        edges: conditionalGraph.edges.filter((edge) => edge.target !== 'route'),
      }),
    ).toThrow('source must be connected');
  });

  it('validates, freezes and executes a connected variable mapping', () => {
    const validated = validateProductFlowGraph(graph);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(executeProductFlow(validated, { input: '检查发布链' })).toEqual({
      logs: [
        { nodeId: 'input', outputPreview: '检查发布链', status: 'completed' },
        { nodeId: 'prompt', outputPreview: '已处理：检查发布链', status: 'completed' },
        { nodeId: 'output', outputPreview: '已处理：检查发布链', status: 'completed' },
      ],
      output: '已处理：检查发布链',
    });
  });

  it('rejects cycles and disconnected graph nodes', () => {
    expect(() =>
      validateProductFlowGraph({
        ...graph,
        edges: [...graph.edges, { id: 'cycle', source: 'output', target: 'prompt' }],
      }),
    ).toThrow('acyclic');
    expect(() =>
      validateProductFlowGraph({
        ...graph,
        nodes: [
          ...graph.nodes,
          { config: { template: '{{message}}' }, id: 'lost', label: '孤岛', type: 'template' },
        ],
      }),
    ).toThrow('reachable');
  });

  it('rejects unavailable variable mappings and an unconnected output source', () => {
    expect(() =>
      validateProductFlowGraph({
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.id === 'prompt' ? { ...node, config: { template: '{{secret}}' } } : node,
        ),
      }),
    ).toThrow('unavailable variable');
    expect(() =>
      validateProductFlowGraph({
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.id === 'output' ? { ...node, config: { source: 'input' } } : node,
        ),
      }),
    ).toThrow('must be connected');
  });

  it('rejects open graph shapes and unbounded debug input', () => {
    expect(() => validateProductFlowGraph({ ...graph, extra: true })).toThrow('invalid shape');
    expect(() => executeProductFlow(graph, { input: 'x'.repeat(8_001) })).toThrow('1–8000');
    expect(() => executeProductFlow(graph, { input: 'ok', extra: true })).toThrow('invalid shape');
  });
});
