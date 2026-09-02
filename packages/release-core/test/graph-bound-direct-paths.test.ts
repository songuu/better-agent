import { describe, expect, it } from 'vitest';

import type { PublishedResourcePinV1 } from '@better-agent/domain-contracts';
import {
  deriveDependencyManifest,
  prepareExecutableSource,
  prepareLeafResourceSource,
  preparePinnedDependencyGraph,
} from '../src/index.js';
import {
  prepareGraphBoundAgentFlowPaths,
  prepareGraphBoundExternalSubagentPaths,
  prepareGraphBoundInternalSubagentPaths,
} from '../src/graph-bound-direct-paths.js';
import { nestedFlowSource, richAgentSource } from './executable-source-fixtures.js';
import { hashB, workspaceId } from './fixtures.js';
import { leafCandidate, record } from './leaf-resource-source-fixtures.js';

function candidate(document: unknown) {
  return { schema_version: 'executable-source-candidate/1', workspace_id: workspaceId, document };
}

function graph(
  root: { pin: PublishedResourcePinV1; semantic_seed_hash: string },
  dependency: PublishedResourcePinV1,
) {
  const { contract_hash: _hash, binding_mode: _mode, ...owner } = dependency;
  const graphCandidate = {
    schema_version: 'pinned-dependency-graph-candidate/1',
    root,
    root_dependencies: [dependency],
    resources: [
      {
        schema_version: 'pinned-dependency-record/1',
        pin: dependency,
        publication_state: 'sealed',
        dependency_manifest: deriveDependencyManifest(owner, []),
        ...(dependency.published_resource_kind === 'AGENT_RELEASE' ||
        dependency.published_resource_kind === 'FLOW_VERSION'
          ? { nested_closure_hash: hashB }
          : {}),
      },
    ],
  };
  return { graphCandidate, preparedGraph: preparePinnedDependencyGraph(graphCandidate) };
}

describe('graph-bound direct path adapters', () => {
  it('binds Agent→Flow paths to a direct graph edge and nested seal', () => {
    const flow = nestedFlowSource();
    const flowPin = {
      ...prepareExecutableSource(candidate(flow)).root.pin,
      published_resource_kind: 'FLOW_VERSION' as const,
    };
    const agent = richAgentSource();
    const binding = agent.capability_bindings.find((item) => item.kind === 'flow');
    if (binding === undefined) throw new Error('fixture Flow Binding is missing');
    binding.pin = flowPin;
    const root = prepareExecutableSource(candidate(agent)).root;
    const evidence = graph(root, flowPin);
    const result = prepareGraphBoundAgentFlowPaths(
      evidence.preparedGraph,
      evidence.graphCandidate,
      candidate(agent),
      candidate(flow),
    );
    expect(result.graph_binding.dependency_node.nested_closure_hash).toBe(hashB);
    expect(result.prepared_paths.bindings.some((item) => item.nodes.length > 0)).toBe(true);
  });

  it('binds internal Agent targets to a direct graph edge and nested seal', () => {
    const target = richAgentSource();
    target.agent_id = '00000000-0000-7000-8000-000000000098';
    target.agent_release_id = '00000000-0000-7000-8000-000000000099';
    const targetPin = {
      ...prepareExecutableSource(candidate(target)).root.pin,
      published_resource_kind: 'AGENT_RELEASE' as const,
    };
    const agent = richAgentSource();
    const binding = agent.capability_bindings.find(
      (item) => item.kind === 'subagent' && item.target_kind === 'internal_agent',
    );
    if (binding === undefined) throw new Error('fixture internal SubAgent Binding is missing');
    binding.pin = targetPin;
    const root = prepareExecutableSource(candidate(agent)).root;
    const evidence = graph(root, targetPin);
    const result = prepareGraphBoundInternalSubagentPaths(
      evidence.preparedGraph,
      evidence.graphCandidate,
      candidate(agent),
      candidate(target),
    );
    expect(result.graph_binding.dependency_node.nested_closure_hash).toBe(hashB);
    expect(result.prepared_paths.bindings.some((item) => item.subagent_target !== undefined)).toBe(
      true,
    );
  });

  it('binds external A2A terminal paths without inventing a nested seal', () => {
    const target = leafCandidate('A2A_AGENT_RELEASE');
    const prepared = prepareLeafResourceSource(target);
    const agent = richAgentSource();
    const binding = agent.capability_bindings.find((item) => item.kind === 'subagent');
    if (binding === undefined) throw new Error('fixture SubAgent Binding is missing');
    const mutable = record(binding);
    mutable.target_kind = 'external_a2a';
    mutable.pin = prepared.full_pin;
    mutable.manual = { ...record(target.document.manual), hash: prepared.component_hashes.manual };
    mutable.input_schema = structuredClone(record(target.document.operation).input_schema);
    mutable.output_schema = structuredClone(record(target.document.operation).output_schema);
    mutable.data_classification = 'internal';
    const requirements = record(target.document.requirements).credential_requirements;
    if (!Array.isArray(requirements)) throw new Error('fixture credentials are missing');
    mutable.credential_requirement = structuredClone(requirements[0]);
    const root = prepareExecutableSource(candidate(agent)).root;
    const evidence = graph(root, prepared.full_pin);
    const result = prepareGraphBoundExternalSubagentPaths(
      evidence.preparedGraph,
      evidence.graphCandidate,
      candidate(agent),
      target,
    );
    expect(result.graph_binding.dependency_node).not.toHaveProperty('nested_closure_hash');
    expect(result.prepared_paths.bindings.some((item) => item.subagent_target !== undefined)).toBe(
      true,
    );
  });
});
