import { describe, expect, it } from 'vitest';

import { FlowIrV1Schema } from '../src/flow-ir-v1.js';

const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303eee';
const hashA = `sha256:${'a'.repeat(64)}` as const;

function makeFlowIr() {
  return {
    schema_version: 'flow-ir/1',
    flow_id: '018f47f2-c541-7cc6-9292-4a2c35303e05',
    flow_version_id: '018f47f2-c541-7cc6-9292-4a2c35303e06',
    title: 'LLM flow',
    entry_graph: {
      graph_id: 'root',
      entry_node_id: 'start-1',
      exit_node_ids: ['output-1'],
      nodes: [
        {
          node_id: 'start-1',
          key: 'start',
          type: 'start',
          config: {},
          inputs: {},
          output_schema: { type: 'object' },
        },
        {
          node_id: 'output-1',
          key: 'output',
          type: 'output',
          config: {},
          inputs: {},
          output_schema: { type: 'object' },
        },
      ],
      edges: [
        {
          edge_id: 'edge-1',
          from: { node_id: 'start-1', port: 'control' },
          to: { node_id: 'output-1', port: 'control' },
          kind: 'control',
        },
      ],
    },
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    resources: [],
    credential_requirements: [],
    execution_defaults: {},
  } as const;
}

function llmFlow() {
  const flow = structuredClone(makeFlowIr()) as unknown as Record<string, unknown> & {
    entry_graph: { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] };
  };
  const model = {
    workspace_id: workspaceId,
    published_resource_kind: 'SYSTEM_RELEASE',
    resource_id: '018f47f2-c541-7cc6-9292-4a2c35303e71',
    resource_version_id: '018f47f2-c541-7cc6-9292-4a2c35303e72',
    contract_hash: hashA,
    binding_mode: 'pinned',
  } as const;
  flow.resources = [model];
  flow.credential_requirements = [
    {
      schema_version: 'credential-requirement/1',
      requirement_id: 'model-provider',
      provider_id: 'model-provider',
      audience: 'model-runtime',
      required_scopes: ['model:invoke'],
      allowed_principal_modes: ['service_principal'],
    },
  ];
  flow.entry_graph.nodes.splice(1, 0, {
    node_id: 'llm-1',
    key: 'llm_1',
    type: 'llm',
    inputs: {},
    output_schema: { type: 'object' },
    config: {
      schema_version: 'flow-llm-node-config/1',
      model,
      credential_requirement_id: 'model-provider',
      prompt: '{{start.content}}',
      max_amount_credits: '1000',
      max_input_tokens: 4096,
      max_output_tokens: 512,
      temperature: 0.2,
    },
  });
  flow.entry_graph.edges = [
    {
      edge_id: 'edge-1',
      from: { node_id: 'start-1', port: 'control' },
      to: { node_id: 'llm-1', port: 'control' },
      kind: 'control',
    },
    {
      edge_id: 'edge-2',
      from: { node_id: 'llm-1', port: 'control' },
      to: { node_id: 'output-1', port: 'control' },
      kind: 'control',
    },
  ];
  return flow;
}

describe('Flow LLM node config', () => {
  it('accepts one exact model release and credential requirement reference', () => {
    expect(FlowIrV1Schema.safeParse(llmFlow()).success).toBe(true);
  });

  it.each([
    [
      'unknown config field',
      (flow: ReturnType<typeof llmFlow>) => {
        (flow.entry_graph.nodes[1]?.config as Record<string, unknown>).extra = true;
      },
    ],
    [
      'wrong model kind',
      (flow: ReturnType<typeof llmFlow>) => {
        const config = flow.entry_graph.nodes[1]?.config as Record<string, unknown>;
        config.model = { ...(config.model as object), published_resource_kind: 'FLOW_VERSION' };
      },
    ],
    [
      'unregistered model pin',
      (flow: ReturnType<typeof llmFlow>) => {
        flow.resources = [];
      },
    ],
    [
      'unknown credential requirement',
      (flow: ReturnType<typeof llmFlow>) => {
        const config = flow.entry_graph.nodes[1]?.config as Record<string, unknown>;
        config.credential_requirement_id = 'other-provider';
      },
    ],
    [
      'credit budget above PostgreSQL bigint',
      (flow: ReturnType<typeof llmFlow>) => {
        const config = flow.entry_graph.nodes[1]?.config as Record<string, unknown>;
        config.max_amount_credits = '9223372036854775808';
      },
    ],
    [
      'combined token budget above the G1 limit',
      (flow: ReturnType<typeof llmFlow>) => {
        const config = flow.entry_graph.nodes[1]?.config as Record<string, unknown>;
        config.max_input_tokens = 600_000;
        config.max_output_tokens = 500_000;
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const flow = llmFlow();
    mutate(flow);
    expect(FlowIrV1Schema.safeParse(flow).success).toBe(false);
  });
});
