import type { PublishedResourcePinV1 } from '@better-agent/domain-contracts';

import { deepFreezeJson } from './dependency-manifest.js';
import { prepareGraphBoundDirectDependency } from './pinned-graph-slice.js';
import {
  prepareAgentExternalSubagentDependencyPaths,
  prepareAgentFlowDependencyPaths,
  prepareAgentInternalSubagentDependencyPaths,
} from './root-binding-paths.js';

function bind<
  T extends {
    root: { pin: PublishedResourcePinV1 };
    dependency: PublishedResourcePinV1 | { pin: PublishedResourcePinV1 };
  },
>(expectedGraph: unknown, graphCandidate: unknown, paths: T) {
  const dependencyPin = 'pin' in paths.dependency ? paths.dependency.pin : paths.dependency;
  return deepFreezeJson({
    graph_binding: prepareGraphBoundDirectDependency(
      expectedGraph,
      graphCandidate,
      paths.root.pin,
      dependencyPin,
    ),
    prepared_paths: paths,
  });
}

export function prepareGraphBoundAgentFlowPaths(
  expectedGraph: unknown,
  graphCandidate: unknown,
  rootInput: unknown,
  dependencyInput: unknown,
) {
  return bind(
    expectedGraph,
    graphCandidate,
    prepareAgentFlowDependencyPaths(rootInput, dependencyInput),
  );
}

export function prepareGraphBoundInternalSubagentPaths(
  expectedGraph: unknown,
  graphCandidate: unknown,
  rootInput: unknown,
  dependencyInput: unknown,
) {
  return bind(
    expectedGraph,
    graphCandidate,
    prepareAgentInternalSubagentDependencyPaths(rootInput, dependencyInput),
  );
}

export function prepareGraphBoundExternalSubagentPaths(
  expectedGraph: unknown,
  graphCandidate: unknown,
  rootInput: unknown,
  dependencyInput: unknown,
) {
  return bind(
    expectedGraph,
    graphCandidate,
    prepareAgentExternalSubagentDependencyPaths(rootInput, dependencyInput),
  );
}
