import { describe, expect, it } from 'vitest';

import { canonicalResourceNodeId } from '../src/index.js';
import { prepareFlowGateSpecs } from '../src/agent-gate-specs.js';
import { richAgentSource } from './executable-source-fixtures.js';
import { hashA, hashB, makeFlowIr, workspaceId } from './fixtures.js';

function candidate(document: unknown) {
  return { schema_version: 'executable-source-candidate/1', workspace_id: workspaceId, document };
}

function gate(id = 'flow-approval') {
  return {
    schema_version: 'human-gate/1' as const,
    gate_spec_id: id,
    kind: 'approval' as const,
    decision_schema: { type: 'object' },
    decision_schema_hash: hashA,
    approver_policy_ref: 'flow-policy',
    approver_policy_hash: hashB,
    expires_after_seconds: 30,
    on_reject: 'fail_run' as const,
    on_expire: 'cancel_run' as const,
    gate_spec_hash: hashA,
    protected_operation_contract_hashes: [hashB],
  };
}

function flowWithGate() {
  const flow = structuredClone(makeFlowIr()) as unknown as {
    entry_graph: {
      nodes: Record<string, unknown>[];
      edges: Record<string, unknown>[];
      exit_node_ids: string[];
    };
    [key: string]: unknown;
  };
  flow.entry_graph.nodes[1] = {
    node_id: 'output-1',
    key: 'output',
    type: 'human_gate',
    inputs: {},
    output_schema: { type: 'object' },
    config: { gate: gate(), prompt: {}, operation_intent: {}, exports: {} },
  };
  return flow;
}

describe('Flow GateSpec preparation', () => {
  it('binds a human gate to its exact Flow node path and root resource node', () => {
    const result = prepareFlowGateSpecs(candidate(flowWithGate()));
    expect(result.gate_specs).toHaveLength(1);
    expect(result.gate_specs[0]).toMatchObject({
      gate_spec_id: 'flow-approval',
      source_kind: 'flow_node',
      source_node_id: canonicalResourceNodeId(result.root.pin),
      source_flow_node_id: 'output-1',
      protected_operation_contract_hashes: [hashB],
    });
    const compiled = result.gate_specs[0];
    expect(compiled?.source_kind).toBe('flow_node');
    if (compiled?.source_kind !== 'flow_node') throw new Error('compiled Flow gate is missing');
    expect(compiled.source_binding_path).toMatch(/^bp1\.[A-Za-z0-9_-]{43}$/u);
    expect(compiled.source_binding_path_segments.map((segment) => segment.segment_kind)).toEqual([
      'root',
      'flow_node',
    ]);
    expect(compiled.source_binding_path_segments[1]).toMatchObject({
      segment_kind: 'flow_node',
      graph_id: 'root',
      node_id: 'output-1',
    });
  });

  it('returns an empty closed projection for a Flow without human gates', () => {
    expect(prepareFlowGateSpecs(candidate(makeFlowIr())).gate_specs).toEqual([]);
  });

  it('rejects duplicate gate IDs across distinct Flow nodes', () => {
    const flow = flowWithGate();
    flow.entry_graph.nodes.push({
      node_id: 'gate-2',
      key: 'gate-2',
      type: 'human_gate',
      inputs: {},
      output_schema: {},
      config: { gate: gate(), prompt: {}, operation_intent: {}, exports: {} },
    });
    flow.entry_graph.edges.push({
      edge_id: 'edge-2',
      from: { node_id: 'output-1', port: 'control' },
      to: { node_id: 'gate-2', port: 'control' },
      kind: 'control',
    });
    flow.entry_graph.exit_node_ids = ['gate-2'];
    expect(() => prepareFlowGateSpecs(candidate(flow))).toThrow();
  });

  it('rejects Agent sources at the Flow gate boundary', () => {
    expect(() => prepareFlowGateSpecs(candidate(richAgentSource()))).toThrow(
      'GATE_SPEC_NOT_CLOSED',
    );
  });

  it('returns deeply frozen entries without closure authority', () => {
    const result = prepareFlowGateSpecs(candidate(flowWithGate()));
    expect(result).not.toHaveProperty('closure_hash');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.gate_specs[0]?.protected_operation_contract_hashes)).toBe(true);
  });
});
