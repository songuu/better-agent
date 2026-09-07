import { describe, expect, it } from 'vitest';

import { executeProductFlow, validateProductFlowGraph } from '../src/flow-runtime.js';

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
