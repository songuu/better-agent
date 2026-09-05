import { describe, expect, it } from 'vitest';

import { prepareFlowCapabilityClosure } from '../src/flow-capability-closure.js';
import { preparePinnedDependencyGraph } from '../src/pinned-dependency-graph.js';
import { prepareExecutableSource } from '../src/executable-source.js';
import { deriveDependencyManifest } from '../src/dependency-manifest.js';
import { hashA, makeFlowIr, workspaceId } from './fixtures.js';

function source(document: unknown = makeFlowIr()) {
  return { schema_version: 'executable-source-candidate/1', workspace_id: workspaceId, document };
}

function graph(input = source()) {
  const prepared = prepareExecutableSource(input);
  const dependencies = prepared.dependency_manifest.dependencies;
  return preparePinnedDependencyGraph({
    schema_version: 'pinned-dependency-graph-candidate/1',
    root: prepared.root,
    root_dependencies: dependencies,
    resources: dependencies.map((pin) => ({
      schema_version: 'pinned-dependency-record/1',
      pin,
      publication_state: 'sealed',
      dependency_manifest: deriveDependencyManifest(
        {
          workspace_id: pin.workspace_id,
          published_resource_kind: pin.published_resource_kind,
          resource_id: pin.resource_id,
          resource_version_id: pin.resource_version_id,
        },
        [],
      ),
    })),
  });
}

function linearLlmFlow() {
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
  };
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
    timeout_ms: 45_000,
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

describe('Flow capability closure compiler', () => {
  it('seals a resource-free Flow from its exact source and pinned graph', () => {
    const input = source();
    const closure = prepareFlowCapabilityClosure(input, graph(input));

    expect(closure.root).toEqual(prepareExecutableSource(input).root);
    expect(closure.assembly_pins).toEqual([]);
    expect(closure.bindings).toEqual([]);
    expect(closure.resource_nodes).toHaveLength(1);
    expect(closure.resource_nodes[0]?.node_role).toBe('root');
    expect(closure.dependency_edges).toEqual([]);
    expect(closure.disabled_binding_paths).toEqual([]);
    expect(closure.closure_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is deterministic across independently prepared equivalent inputs', () => {
    const left = source();
    const right = structuredClone(left);
    expect(prepareFlowCapabilityClosure(left, graph(left))).toEqual(
      prepareFlowCapabilityClosure(right, graph(right)),
    );
  });

  it('rejects a graph that is not the exact Flow source graph', () => {
    const input = source();
    const other = structuredClone(input) as unknown as {
      schema_version: string;
      workspace_id: string;
      document: Record<string, unknown>;
    };
    other.document.flow_version_id = '018f47f2-c541-7cc6-9292-4a2c35303eff';
    expect(() => prepareFlowCapabilityClosure(input, graph(other))).toThrow(
      'COMPILED_CAPABILITY_CLOSURE_INVALID',
    );
  });

  it('fails closed for external resources without a supported G1-A2 topology', () => {
    const document = structuredClone(makeFlowIr()) as unknown as Record<string, unknown>;
    document.resources = [
      {
        workspace_id: workspaceId,
        published_resource_kind: 'PLUGIN_TOOL_RELEASE',
        resource_id: '018f47f2-c541-7cc6-9292-4a2c35303e61',
        resource_version_id: '018f47f2-c541-7cc6-9292-4a2c35303e62',
        contract_hash: `sha256:${'1'.repeat(64)}`,
        binding_mode: 'pinned',
      },
    ];
    const input = source(document);
    expect(() => prepareFlowCapabilityClosure(input, graph(input))).toThrow(
      'Start to LLM to Output',
    );
  });

  it('seals exact Start to LLM to Output authority from typed source facts', () => {
    const input = source(linearLlmFlow());
    const closure = prepareFlowCapabilityClosure(input, graph(input));
    expect(closure.assembly_pins).toHaveLength(1);
    expect(closure.resource_nodes).toHaveLength(2);
    expect(closure.dependency_edges).toHaveLength(1);
    expect(closure.aggregate_limits).toMatchObject({
      max_calls: 1,
      max_parallelism: 1,
      budget: {
        amount_credits: '1000',
        input_tokens: 4096,
        output_tokens: 512,
        total_tokens: 4608,
        duration_ms: 45_000,
      },
    });
    expect(
      closure.resource_nodes.find((node) => node.node_role === 'root')?.intrinsic_policy,
    ).toMatchObject({
      requirements: { credential_requirements: [{ requirement_id: 'model-provider' }] },
    });
  });

  it('rejects capability-bearing Flow topology beyond the G1-A2 linear subset', () => {
    const flow = linearLlmFlow();
    flow.entry_graph.nodes.push({
      node_id: 'text-1',
      key: 'text_1',
      type: 'text',
      config: {},
      inputs: {},
      output_schema: { type: 'object' },
    });
    flow.entry_graph.edges.push({
      edge_id: 'edge-3',
      from: { node_id: 'llm-1', port: 'control' },
      to: { node_id: 'text-1', port: 'control' },
      kind: 'control',
    });
    const input = source(flow);
    expect(() => prepareFlowCapabilityClosure(input, graph(input))).toThrow(
      'Start to LLM to Output',
    );
  });

  it('does not treat an opaque resource-free action as an inert Flow', () => {
    const flow = structuredClone(makeFlowIr()) as unknown as {
      entry_graph: { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] };
    };
    flow.entry_graph.nodes.splice(1, 0, {
      node_id: 'api-1',
      key: 'api_1',
      type: 'api',
      config: {},
      inputs: {},
      output_schema: { type: 'object' },
    });
    flow.entry_graph.edges = [
      {
        edge_id: 'edge-1',
        from: { node_id: 'start-1', port: 'control' },
        to: { node_id: 'api-1', port: 'control' },
        kind: 'control',
      },
      {
        edge_id: 'edge-2',
        from: { node_id: 'api-1', port: 'control' },
        to: { node_id: 'output-1', port: 'control' },
        kind: 'control',
      },
    ];
    const input = source(flow);
    expect(() => prepareFlowCapabilityClosure(input, graph(input))).toThrow('inert Flow');
  });

  it('rejects graph accessors without invoking caller code', () => {
    const input = source();
    const candidate = structuredClone(graph(input)) as unknown as Record<string, unknown>;
    let calls = 0;
    Object.defineProperty(candidate, 'graph_hash', {
      enumerable: true,
      get() {
        calls += 1;
        return `sha256:${'0'.repeat(64)}`;
      },
    });
    expect(() => prepareFlowCapabilityClosure(input, candidate)).toThrow();
    expect(calls).toBe(0);
  });
});
