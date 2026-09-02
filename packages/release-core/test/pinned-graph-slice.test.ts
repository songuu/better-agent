import { describe, expect, it } from 'vitest';

import type { PublishedResourcePinV1 } from '@better-agent/domain-contracts';
import { deriveDependencyManifest, preparePinnedDependencyGraph } from '../src/index.js';
import {
  prepareGraphBoundDirectDependencies,
  prepareGraphBoundDirectDependency,
} from '../src/pinned-graph-slice.js';
import { hashA, hashB, workspaceId } from './fixtures.js';

function uuid(value: number) {
  return `00000000-0000-7000-8000-${value.toString(16).padStart(12, '0')}`;
}

function pin(
  index: number,
  kind: PublishedResourcePinV1['published_resource_kind'],
): PublishedResourcePinV1 {
  return {
    workspace_id: workspaceId,
    published_resource_kind: kind,
    resource_id: uuid(index * 2 + 1),
    resource_version_id: uuid(index * 2 + 2),
    contract_hash: hashA,
    binding_mode: 'pinned',
  };
}

function record(resource: PublishedResourcePinV1, dependencies: PublishedResourcePinV1[] = []) {
  const { contract_hash: _hash, binding_mode: _mode, ...owner } = resource;
  return {
    schema_version: 'pinned-dependency-record/1',
    pin: resource,
    publication_state: 'sealed',
    dependency_manifest: deriveDependencyManifest(owner, dependencies),
    ...(resource.published_resource_kind === 'AGENT_RELEASE' ||
    resource.published_resource_kind === 'FLOW_VERSION'
      ? { nested_closure_hash: hashB }
      : {}),
  };
}

function fixture() {
  const root = pin(0, 'AGENT_RELEASE');
  const direct = pin(1, 'FLOW_VERSION');
  const transitive = pin(2, 'PLUGIN_TOOL_RELEASE');
  const candidate = {
    schema_version: 'pinned-dependency-graph-candidate/1',
    root: { pin: root, semantic_seed_hash: hashA },
    root_dependencies: [direct],
    resources: [record(direct, [transitive]), record(transitive)],
  };
  return { root, direct, transitive, candidate, graph: preparePinnedDependencyGraph(candidate) };
}

describe('graph-bound direct dependency slices', () => {
  it('returns exact root/dependency nodes and preserves the nested closure seal', () => {
    const value = fixture();
    const result = prepareGraphBoundDirectDependency(
      value.graph,
      value.candidate,
      value.root,
      value.direct,
    );
    expect(result.graph_hash).toBe(value.graph.graph_hash);
    expect(result.root_node.pin).toEqual(value.root);
    expect(result.dependency_node.pin).toEqual(value.direct);
    expect(result.dependency_node.nested_closure_hash).toBe(hashB);
  });

  it('rejects a transitive node when no direct root edge exists', () => {
    const value = fixture();
    expect(() =>
      prepareGraphBoundDirectDependency(value.graph, value.candidate, value.root, value.transitive),
    ).toThrow('CAPABILITY_DEPENDENCY_UNRESOLVED');
  });

  it('rejects a different requested root even when that node exists', () => {
    const value = fixture();
    expect(() =>
      prepareGraphBoundDirectDependency(
        value.graph,
        value.candidate,
        value.direct,
        value.transitive,
      ),
    ).toThrow('CAPABILITY_DEPENDENCY_UNRESOLVED');
  });

  it('rejects stored graph drift before resolving the requested edge', () => {
    const value = fixture();
    expect(() =>
      prepareGraphBoundDirectDependency(
        { ...value.graph, graph_hash: hashB },
        value.candidate,
        value.root,
        value.direct,
      ),
    ).toThrow('CAPABILITY_GRAPH_HASH_MISMATCH');
  });

  it('rejects candidate drift against a previously prepared graph', () => {
    const value = fixture();
    const changed = structuredClone(value.candidate);
    changed.resources.reverse();
    const target = changed.resources[0];
    if (target === undefined) throw new Error('fixture resource is missing');
    changed.resources[0] = {
      ...target,
      dependency_manifest: { ...target.dependency_manifest, manifest_hash: hashB },
    };
    expect(() =>
      prepareGraphBoundDirectDependency(value.graph, changed, value.root, value.direct),
    ).toThrow();
  });

  it('returns a deeply frozen non-authoritative linkage artifact', () => {
    const value = fixture();
    const result = prepareGraphBoundDirectDependency(
      value.graph,
      value.candidate,
      value.root,
      value.direct,
    );
    expect(result).not.toHaveProperty('closure_hash');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.dependency_node.pin)).toBe(true);
  });

  it('verifies multiple direct dependencies in one graph-bound batch', () => {
    const value = fixture();
    const candidate = {
      ...value.candidate,
      root_dependencies: [value.direct, value.transitive],
      resources: [record(value.direct), record(value.transitive)],
    };
    const graph = preparePinnedDependencyGraph(candidate);
    const result = prepareGraphBoundDirectDependencies(graph, candidate, value.root, [
      value.direct,
      value.transitive,
    ]);
    expect(result.dependency_nodes.map((node) => node.pin)).toEqual([
      value.direct,
      value.transitive,
    ]);
    expect(Object.isFrozen(result.dependency_nodes)).toBe(true);
  });

  it('rejects duplicate dependency pins in a direct batch', () => {
    const value = fixture();
    expect(() =>
      prepareGraphBoundDirectDependencies(value.graph, value.candidate, value.root, [
        value.direct,
        value.direct,
      ]),
    ).toThrow('CAPABILITY_DEPENDENCY_UNRESOLVED');
  });
});
