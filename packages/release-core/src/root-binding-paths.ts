import type {
  BindingPathSegmentV1Schema,
  CapabilityBindingV1,
  FlowGraphV1,
} from '@better-agent/domain-contracts';

import { createClosureIdentityRegistry, type ClosureIdentityRegistry } from './closure-identity.js';
import {
  compareCanonicalStrings,
  deepFreezeJson,
  publishedResourcePinKey,
} from './dependency-manifest.js';
import { prepareExecutableSource, type PreparedExecutableSourceV1 } from './executable-source.js';
import { ReleaseCoreError } from './errors.js';

type BindingPathSegmentV1 = ReturnType<typeof BindingPathSegmentV1Schema.parse>;

interface CompiledRootBindingPathV1 {
  readonly binding_id: string;
  readonly binding_kind: CapabilityBindingV1['kind'];
  readonly binding_path: `bp1.${string}`;
  readonly binding_path_segments: readonly BindingPathSegmentV1[];
  readonly enabled: boolean;
}

interface RootBindingPaths {
  readonly root: PreparedExecutableSourceV1['root'];
  readonly bindings: readonly CompiledRootBindingPathV1[];
  readonly source_disabled_binding_paths: readonly `bp1.${string}`[];
}

interface CompiledFlowNodePathV1 {
  readonly graph_id: string;
  readonly node_id: string;
  readonly node_type: string;
  readonly source_path: `bp1.${string}`;
  readonly source_path_segments: readonly BindingPathSegmentV1[];
}

interface FlowNodePaths {
  readonly root: PreparedExecutableSourceV1['root'];
  readonly nodes: readonly CompiledFlowNodePathV1[];
}

interface AgentFlowDependencyPaths {
  readonly root: PreparedExecutableSourceV1['root'];
  readonly dependency: PreparedExecutableSourceV1['root'];
  readonly bindings: readonly (CompiledRootBindingPathV1 & {
    readonly nodes: readonly CompiledFlowNodePathV1[];
  })[];
  readonly source_disabled_binding_paths: readonly `bp1.${string}`[];
}

function rootBindingSegments(
  root: PreparedExecutableSourceV1['root'],
  binding: CapabilityBindingV1,
): BindingPathSegmentV1[] {
  return [
    { segment_kind: 'root', pin: root.pin },
    {
      segment_kind: 'binding',
      owner: { owner_kind: 'root', pin: root.pin },
      binding_kind: binding.kind,
      local_binding_id: binding.binding_id,
    },
  ];
}

function compileFlowNodes(
  graph: FlowGraphV1,
  owner: Extract<BindingPathSegmentV1, { segment_kind: 'flow_node' }>['owner'],
  prefix: readonly BindingPathSegmentV1[],
  identity: ClosureIdentityRegistry,
): CompiledFlowNodePathV1[] {
  const nodes: CompiledFlowNodePathV1[] = [];
  function walk(current: FlowGraphV1, ancestors: readonly BindingPathSegmentV1[]): void {
    for (const node of current.nodes) {
      const segment: BindingPathSegmentV1 = {
        segment_kind: 'flow_node',
        owner,
        graph_id: current.graph_id,
        node_id: node.node_id,
      };
      const segments = [...prefix, ...ancestors, segment];
      nodes.push({
        graph_id: current.graph_id,
        node_id: node.node_id,
        node_type: node.type,
        source_path: identity.registerBindingPath(segments),
        source_path_segments: segments,
      });
      const config = node.config as Record<string, unknown>;
      if (node.type === 'loop') walk(config.body as FlowGraphV1, [...ancestors, segment]);
      if (node.type === 'branch') {
        for (const item of config.cases as { graph: FlowGraphV1 }[])
          walk(item.graph, [...ancestors, segment]);
        walk((config.else_case as { graph: FlowGraphV1 }).graph, [...ancestors, segment]);
      }
    }
  }
  walk(graph, []);
  return nodes.sort((left, right) => compareCanonicalStrings(left.source_path, right.source_path));
}

/** Compile the root Agent namespace. Nested Flow/Pack/SubAgent segments are appended by later expansion. */
export function prepareRootBindingPaths(input: unknown): RootBindingPaths {
  const source = prepareExecutableSource(input);
  if (source.root.pin.published_resource_kind !== 'AGENT_RELEASE')
    throw new ReleaseCoreError(
      'CLOSURE_SOURCE_INVALID',
      '$.document',
      'root Binding paths require an Agent executable source',
    );

  const document = source.preimage.document as unknown as {
    capability_bindings: readonly CapabilityBindingV1[];
  };
  const identity = createClosureIdentityRegistry();
  identity.registerResourceNode(source.root.pin);
  const bindings = document.capability_bindings
    .map((binding): CompiledRootBindingPathV1 => {
      const segments = rootBindingSegments(source.root, binding);
      return {
        binding_id: binding.binding_id,
        binding_kind: binding.kind,
        binding_path: identity.registerBindingPath(segments),
        binding_path_segments: segments,
        enabled: binding.enabled,
      };
    })
    .sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path));
  const source_disabled_binding_paths = bindings
    .filter((binding) => !binding.enabled)
    .map((binding) => binding.binding_path)
    .sort(compareCanonicalStrings);
  return deepFreezeJson({
    root: source.root,
    bindings,
    source_disabled_binding_paths,
  });
}

/** Compile every structured Flow node path, retaining parent-node ancestry across nested graphs. */
export function prepareFlowNodePaths(input: unknown): FlowNodePaths {
  const source = prepareExecutableSource(input);
  if (source.root.pin.published_resource_kind !== 'FLOW_VERSION')
    throw new ReleaseCoreError(
      'CLOSURE_SOURCE_INVALID',
      '$.document',
      'Flow node paths require a Flow executable source',
    );
  const flowPin = { ...source.root.pin, published_resource_kind: 'FLOW_VERSION' as const };
  const identity = createClosureIdentityRegistry();
  identity.registerResourceNode(flowPin);
  const rootSegment: BindingPathSegmentV1 = { segment_kind: 'root', pin: flowPin };
  const owner = { owner_kind: 'root' as const, pin: flowPin };
  const document = source.preimage.document as unknown as { entry_graph: FlowGraphV1 };
  const nodes = compileFlowNodes(document.entry_graph, owner, [rootSegment], identity);
  return deepFreezeJson({ root: source.root, nodes });
}

/**
 * Compile every root Agent Binding that targets one exact Flow source using one closure-local
 * identity registry. Registry provenance and transitive dependency records remain later steps.
 */
export function prepareAgentFlowDependencyPaths(
  rootInput: unknown,
  dependencyInput: unknown,
): AgentFlowDependencyPaths {
  const rootSource = prepareExecutableSource(rootInput);
  const dependencySource = prepareExecutableSource(dependencyInput);
  if (rootSource.root.pin.published_resource_kind !== 'AGENT_RELEASE')
    throw new ReleaseCoreError(
      'CLOSURE_SOURCE_INVALID',
      '$.root',
      'nested Flow paths require an Agent root source',
    );
  if (dependencySource.root.pin.published_resource_kind !== 'FLOW_VERSION')
    throw new ReleaseCoreError(
      'CLOSURE_SOURCE_INVALID',
      '$.dependency',
      'nested Flow paths require a Flow dependency source',
    );

  const rootDocument = rootSource.preimage.document as unknown as {
    capability_bindings: readonly CapabilityBindingV1[];
  };
  const flowDocument = dependencySource.preimage.document as unknown as {
    entry_graph: FlowGraphV1;
  };
  const flowPin = {
    ...dependencySource.root.pin,
    published_resource_kind: 'FLOW_VERSION' as const,
  };
  const targetKey = publishedResourcePinKey(flowPin);
  const matching = rootDocument.capability_bindings.filter(
    (binding) => binding.kind === 'flow' && publishedResourcePinKey(binding.pin) === targetKey,
  );
  if (matching.length === 0)
    throw new ReleaseCoreError(
      'CAPABILITY_DEPENDENCY_UNRESOLVED',
      '$.dependency',
      'Flow source is not an exact dependency of any root Binding',
    );

  const identity = createClosureIdentityRegistry();
  identity.registerResourceNode(rootSource.root.pin);
  identity.registerResourceNode(flowPin);
  const matchingIds = new Set(matching.map((binding) => binding.binding_id));
  const bindings = rootDocument.capability_bindings
    .map((binding) => {
      const segments = rootBindingSegments(rootSource.root, binding);
      const binding_path = identity.registerBindingPath(segments);
      const nodes = matchingIds.has(binding.binding_id)
        ? compileFlowNodes(
            flowDocument.entry_graph,
            { owner_kind: 'published_dependency', pin: flowPin },
            segments,
            identity,
          )
        : [];
      return {
        binding_id: binding.binding_id,
        binding_kind: binding.kind,
        binding_path,
        binding_path_segments: segments,
        enabled: binding.enabled,
        nodes,
      };
    })
    .sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path));
  const source_disabled_binding_paths = bindings
    .filter((binding) => !binding.enabled)
    .map((binding) => binding.binding_path)
    .sort(compareCanonicalStrings);
  return deepFreezeJson({
    root: rootSource.root,
    dependency: dependencySource.root,
    bindings,
    source_disabled_binding_paths,
  });
}
