import type { PublishedResourcePinV1 } from '@better-agent/domain-contracts';

import { deepFreezeJson, publishedResourcePinKey } from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import {
  type PinnedDependencyGraphNodeV1,
  verifyPinnedDependencyGraph,
} from './pinned-dependency-graph.js';

export interface PreparedGraphBoundDirectDependencyV1 {
  readonly schema_version: 'graph-bound-direct-dependency/1';
  readonly graph_hash: `sha256:${string}`;
  readonly root_node: PinnedDependencyGraphNodeV1;
  readonly dependency_node: PinnedDependencyGraphNodeV1;
}

export interface PreparedGraphBoundDirectDependenciesV1 {
  readonly schema_version: 'graph-bound-direct-dependencies/1';
  readonly graph_hash: `sha256:${string}`;
  readonly root_node: PinnedDependencyGraphNodeV1;
  readonly dependency_nodes: readonly PinnedDependencyGraphNodeV1[];
}

export interface PreparedGraphBoundDependencyFanoutV1 {
  readonly schema_version: 'graph-bound-dependency-fanout/1';
  readonly graph_hash: `sha256:${string}`;
  readonly root_node: PinnedDependencyGraphNodeV1;
  readonly parent_node: PinnedDependencyGraphNodeV1;
  readonly dependency_nodes: readonly PinnedDependencyGraphNodeV1[];
}

function unresolved(): never {
  throw new ReleaseCoreError(
    'CAPABILITY_DEPENDENCY_UNRESOLVED',
    '$.graph',
    'direct dependency slice is absent from the recomputed pinned graph',
  );
}

/** Bind one direct compiler slice to exact nodes and an edge in a recomputed graph snapshot. */
export function prepareGraphBoundDirectDependency(
  expectedGraph: unknown,
  graphCandidate: unknown,
  rootPin: PublishedResourcePinV1,
  dependencyPin: PublishedResourcePinV1,
): PreparedGraphBoundDirectDependencyV1 {
  const batch = prepareGraphBoundDirectDependencies(expectedGraph, graphCandidate, rootPin, [
    dependencyPin,
  ]);
  const dependencyNode = batch.dependency_nodes[0];
  if (dependencyNode === undefined) unresolved();
  return deepFreezeJson({
    schema_version: 'graph-bound-direct-dependency/1',
    graph_hash: batch.graph_hash,
    root_node: batch.root_node,
    dependency_node: dependencyNode,
  });
}

/** Verify a bounded direct dependency set while parsing and hashing the graph only once. */
export function prepareGraphBoundDirectDependencies(
  expectedGraph: unknown,
  graphCandidate: unknown,
  rootPin: PublishedResourcePinV1,
  dependencyPins: readonly PublishedResourcePinV1[],
): PreparedGraphBoundDirectDependenciesV1 {
  const graph = verifyPinnedDependencyGraph(expectedGraph, graphCandidate);
  if (publishedResourcePinKey(graph.root.pin) !== publishedResourcePinKey(rootPin)) unresolved();
  const rootNode = graph.nodes.find(
    (node) => publishedResourcePinKey(node.pin) === publishedResourcePinKey(rootPin),
  );
  if (rootNode === undefined || dependencyPins.length > 128) unresolved();
  const keys = dependencyPins.map(publishedResourcePinKey);
  if (new Set(keys).size !== keys.length) unresolved();
  const dependencyNodes = keys.map((key) => {
    const node = graph.nodes.find((candidate) => publishedResourcePinKey(candidate.pin) === key);
    if (
      node === undefined ||
      !graph.edges.some(
        (edge) => edge.from_node_id === rootNode.node_id && edge.to_node_id === node.node_id,
      )
    )
      unresolved();
    return node;
  });
  return deepFreezeJson({
    schema_version: 'graph-bound-direct-dependencies/1',
    graph_hash: graph.graph_hash,
    root_node: rootNode,
    dependency_nodes: dependencyNodes,
  });
}

/** Verify root→parent and parent→children in one recomputed graph snapshot. */
export function prepareGraphBoundDependencyFanout(
  expectedGraph: unknown,
  graphCandidate: unknown,
  rootPin: PublishedResourcePinV1,
  parentPin: PublishedResourcePinV1,
  dependencyPins: readonly PublishedResourcePinV1[],
): PreparedGraphBoundDependencyFanoutV1 {
  const graph = verifyPinnedDependencyGraph(expectedGraph, graphCandidate);
  const findNode = (pin: PublishedResourcePinV1) =>
    graph.nodes.find(
      (candidate) => publishedResourcePinKey(candidate.pin) === publishedResourcePinKey(pin),
    );
  const rootNode = findNode(rootPin);
  const parentNode = findNode(parentPin);
  if (
    publishedResourcePinKey(graph.root.pin) !== publishedResourcePinKey(rootPin) ||
    rootNode === undefined ||
    parentNode === undefined ||
    !graph.edges.some(
      (edge) => edge.from_node_id === rootNode.node_id && edge.to_node_id === parentNode.node_id,
    ) ||
    dependencyPins.length === 0 ||
    dependencyPins.length > 128
  )
    unresolved();
  const keys = dependencyPins.map(publishedResourcePinKey);
  if (new Set(keys).size !== keys.length) unresolved();
  const dependencyNodes = dependencyPins.map((pin) => {
    const node = findNode(pin);
    if (
      node === undefined ||
      !graph.edges.some(
        (edge) => edge.from_node_id === parentNode.node_id && edge.to_node_id === node.node_id,
      )
    )
      unresolved();
    return node;
  });
  return deepFreezeJson({
    schema_version: 'graph-bound-dependency-fanout/1',
    graph_hash: graph.graph_hash,
    root_node: rootNode,
    parent_node: parentNode,
    dependency_nodes: dependencyNodes,
  });
}
