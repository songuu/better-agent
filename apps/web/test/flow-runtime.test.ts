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
