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
  const graph = verifyPinnedDependencyGraph(expectedGraph, graphCandidate);
  if (publishedResourcePinKey(graph.root.pin) !== publishedResourcePinKey(rootPin)) unresolved();
  const rootNode = graph.nodes.find(
    (node) => publishedResourcePinKey(node.pin) === publishedResourcePinKey(rootPin),
  );
  const dependencyNode = graph.nodes.find(
    (node) => publishedResourcePinKey(node.pin) === publishedResourcePinKey(dependencyPin),
  );
  if (rootNode === undefined || dependencyNode === undefined) unresolved();
  if (
    !graph.edges.some(
      (edge) =>
        edge.from_node_id === rootNode.node_id && edge.to_node_id === dependencyNode.node_id,
    )
  )
    unresolved();
  return deepFreezeJson({
    schema_version: 'graph-bound-direct-dependency/1',
    graph_hash: graph.graph_hash,
    root_node: rootNode,
    dependency_node: dependencyNode,
  });
}
