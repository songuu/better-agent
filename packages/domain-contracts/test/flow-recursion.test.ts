import { describe, expect, it } from 'vitest';
import { FlowIrV1Schema, type FlowGraphV1 } from '../src/index.js';

describe('recursive Flow schema discrimination', () => {
  it.each(['collection', 'condition'] as const)(
    'parses nested %s loops without exponential body revalidation',
    (mode) => {
      let leafReads = 0;
      const leaf = {
        get node_id() {
          leafReads += 1;
          return 'leaf';
        },
        key: 'leaf',
        type: 'output',
        config: {},
        inputs: {},
        output_schema: {},
      };
      let graph: FlowGraphV1 = {
        graph_id: 'leaf-graph',
        entry_node_id: 'leaf',
        exit_node_ids: ['leaf'],
        nodes: [leaf],
        edges: [],
      };
      for (let depth = 0; depth < 12; depth += 1) {
        const id = `loop-${depth}`;
        graph = {
          graph_id: `graph-${depth}`,
          entry_node_id: id,
          exit_node_ids: [id],
          edges: [],
          nodes: [
            {
              node_id: id,
              key: `loop_${depth}`,
              type: 'loop',
              inputs: {},
              output_schema: {},
              config: {
                mode,
                max_iterations: 3,
                body: graph,
                exports: {},
                ...(mode === 'condition' ? { continue_when: 'true' } : { collection: [] }),
              },
            },
          ],
        };
      }
      const flow = {
        schema_version: 'flow-ir/1',
        flow_id: 'flow',
        flow_version_id: 'version',
        title: 'Nested loops',
        resources: [],
        credential_requirements: [],
        input_schema: {},
        output_schema: {},
        execution_defaults: {},
        entry_graph: {
          graph_id: 'root',
          entry_node_id: 'start',
          exit_node_ids: ['top'],
          nodes: [
            {
              node_id: 'start',
              key: 'start',
              type: 'start',
              config: {},
              inputs: {},
              output_schema: {},
            },
            {
              node_id: 'top',
              key: 'top',
              type: 'loop',
              config: {
                mode,
                max_iterations: 3,
                body: graph,
                exports: {},
                ...(mode === 'condition' ? { continue_when: 'true' } : { collection: [] }),
              },
              inputs: {},
              output_schema: {},
            },
          ],
          edges: [
            {
              edge_id: 'start-top',
              kind: 'control',
              from: { node_id: 'start', port: 'next' },
              to: { node_id: 'top', port: 'in' },
            },
          ],
        },
      };
      expect(FlowIrV1Schema.safeParse(flow).success).toBe(true);
      // Controlled schema-only getter counts work, not wall-clock time. Public source APIs forbid getters.
      expect(leafReads).toBeLessThanOrEqual(64);
    },
  );
  it.each([
    { mode: 'condition', collection: [] },
    { mode: 'collection', continue_when: 'true' },
    { mode: 'other', continue_when: 'true' },
  ])('rejects missing or mixed loop discriminator fields: %j', (fields) => {
    const node = {
      node_id: 'start',
      key: 'start',
      type: 'start',
      inputs: {},
      output_schema: {},
      config: {},
    };
    const graph = {
      graph_id: 'root',
      entry_node_id: 'start',
      exit_node_ids: ['start'],
      nodes: [node],
      edges: [],
    };
    const input = {
      schema_version: 'flow-ir/1',
      flow_id: 'flow',
      flow_version_id: 'version',
      title: 'Invalid loop',
      resources: [],
      credential_requirements: [],
      input_schema: {},
      output_schema: {},
      execution_defaults: {},
      entry_graph: {
        ...graph,
        exit_node_ids: ['loop'],
        nodes: [
          node,
          {
            ...node,
            node_id: 'loop',
            key: 'loop',
            type: 'loop',
            config: { ...fields, max_iterations: 1, exports: {}, body: graph },
          },
        ],
        edges: [
          {
            edge_id: 'next',
            kind: 'control',
            from: { node_id: 'start', port: 'next' },
            to: { node_id: 'loop', port: 'in' },
          },
        ],
      },
    };
    expect(FlowIrV1Schema.safeParse(input).success).toBe(false);
  });
});
