import type {
  BindingPathSegmentV1Schema,
  CapabilityBindingV1,
  FlowGraphV1,
} from '@better-agent/domain-contracts';

import { compareCanonicalStrings, deepFreezeJson } from './dependency-manifest.js';
import { createClosureIdentityRegistry } from './closure-identity.js';
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
  const rootSegment: BindingPathSegmentV1 = { segment_kind: 'root', pin: source.root.pin };
  const bindings = document.capability_bindings
    .map((binding): CompiledRootBindingPathV1 => {
      const segments: BindingPathSegmentV1[] = [
        rootSegment,
        {
          segment_kind: 'binding',
          owner: { owner_kind: 'root', pin: source.root.pin },
          binding_kind: binding.kind,
          local_binding_id: binding.binding_id,
        },
      ];
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
  const nodes: CompiledFlowNodePathV1[] = [];

  function walk(graph: FlowGraphV1, ancestors: readonly BindingPathSegmentV1[]): void {
    for (const node of graph.nodes) {
      const segment: BindingPathSegmentV1 = {
        segment_kind: 'flow_node',
        owner,
        graph_id: graph.graph_id,
        node_id: node.node_id,
      };
      const segments = [rootSegment, ...ancestors, segment];
      nodes.push({
        graph_id: graph.graph_id,
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

  walk(document.entry_graph, []);
  nodes.sort((left, right) => compareCanonicalStrings(left.source_path, right.source_path));
  return deepFreezeJson({ root: source.root, nodes });
}
