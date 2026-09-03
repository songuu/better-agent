import type {
  BindingPathSegmentV1Schema,
  CapabilityBindingV1,
  CapabilityRequirementExpressionV1,
  CompiledBindingEntryV1Schema,
  OperationContractPinV1,
} from '@better-agent/domain-contracts';

import { canonicalJsonBytes } from './canonical-json.js';
import { canonicalBindingPath } from './closure-identity.js';
import { prepareNestedCapabilityDependency } from './compiled-capability-closure.js';
import { compareCanonicalStrings, deepFreezeJson } from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { prepareExecutableSource } from './executable-source.js';
import { prepareGraphBoundAgentFlowPaths } from './graph-bound-direct-paths.js';
import { withinProjectedBindingCapacity } from './projection-capacity.js';
import { prepareFlowNodePaths } from './root-binding-paths.js';

interface ProjectedFlowBindingOperationV1 {
  readonly binding_id: string;
  readonly binding_kind: CapabilityBindingV1['kind'];
  readonly binding_path: `bp1.${string}`;
  readonly operation_contracts: readonly OperationContractPinV1[];
  readonly requirement_expression?: CapabilityRequirementExpressionV1;
}

export interface PreparedNestedFlowBindingOperationsV1 {
  readonly schema_version: 'prepared-nested-flow-binding-operations/1';
  readonly graph_hash: `sha256:${string}`;
  readonly nested_closure_hash: string;
  readonly dependency_resource_node: ReturnType<
    typeof prepareNestedCapabilityDependency
  >['resource_node'];
  readonly projected_resource_nodes: readonly ReturnType<
    typeof prepareNestedCapabilityDependency
  >['resource_node'][];
  readonly binding_operations: readonly ProjectedFlowBindingOperationV1[];
  readonly projected_binding_entries: readonly {
    readonly parent_binding_path: `bp1.${string}`;
    readonly parent_enabled: boolean;
    readonly source_binding_path: `bp1.${string}`;
    readonly source_disabled: boolean;
    readonly binding_path: `bp1.${string}`;
    readonly binding_path_segments: readonly ReturnType<typeof BindingPathSegmentV1Schema.parse>[];
    readonly entry: ReturnType<typeof CompiledBindingEntryV1Schema.parse>;
  }[];
}

function mismatch(path: string, reason: string): never {
  throw new ReleaseCoreError('NESTED_CAPABILITY_CLOSURE_MISMATCH', path, reason);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}

function flowNodeSequence(segments: readonly unknown[]): string {
  const nodes = segments.flatMap((segment) => {
    if (
      typeof segment !== 'object' ||
      segment === null ||
      !('segment_kind' in segment) ||
      segment.segment_kind !== 'flow_node' ||
      !('graph_id' in segment) ||
      !('node_id' in segment)
    )
      return [];
    return [{ graph_id: segment.graph_id, node_id: segment.node_id }];
  });
  return canonicalJsonBytes(nodes).toString('base64url');
}

function segmentPrefix(prefix: readonly unknown[], value: readonly unknown[]): boolean {
  return (
    prefix.length < value.length &&
    prefix.every((segment, index) => sameJson(segment, value[index]))
  );
}

function segmentPrefixOrEqual(prefix: readonly unknown[], value: readonly unknown[]): boolean {
  return (
    prefix.length <= value.length &&
    prefix.every((segment, index) => sameJson(segment, value[index]))
  );
}

/** Project verified Flow closure operations into every parent-prefixed Flow node namespace. */
export function prepareGraphBoundNestedFlowBindingOperations(
  expectedGraph: unknown,
  graphCandidate: unknown,
  rootInput: unknown,
  dependencyInput: unknown,
  nestedClosureInput: unknown,
): PreparedNestedFlowBindingOperationsV1 {
  const graphBound = prepareGraphBoundAgentFlowPaths(
    expectedGraph,
    graphCandidate,
    rootInput,
    dependencyInput,
  );
  const nestedDependency = prepareNestedCapabilityDependency(
    graphBound.graph_binding.dependency_node,
    nestedClosureInput,
  );
  const nestedClosure = nestedDependency.closure;
  const childSource = prepareExecutableSource(dependencyInput);
  const childNodes = prepareFlowNodePaths(dependencyInput);
  if (!sameJson(childNodes.root.pin, nestedClosure.root.pin)) {
    mismatch(
      '$.nested_closure.root.pin',
      'nested closure does not describe the supplied Flow source',
    );
  }
  const closureRootNode = nestedClosure.resource_nodes.find((node) => node.node_role === 'root');
  if (
    nestedDependency.resource_node.dependency_manifest_hash !==
      childSource.dependency_manifest.manifest_hash ||
    closureRootNode?.dependency_manifest_hash !== childSource.dependency_manifest.manifest_hash ||
    !sameJson(nestedClosure.assembly_pins, childSource.dependency_manifest.dependencies)
  ) {
    mismatch(
      '$.nested_closure.assembly_pins',
      'Flow source, graph dependency manifest, and nested closure assembly do not agree',
    );
  }

  const childNodeByPath = new Map<string, (typeof childNodes.nodes)[number]>(
    childNodes.nodes.map((node) => [node.source_path, node]),
  );
  const childOperations = new Map<
    string,
    {
      binding_id: string;
      binding_kind: CapabilityBindingV1['kind'];
      operations: readonly OperationContractPinV1[];
      requirement_expression: CapabilityRequirementExpressionV1;
    }
  >();
  for (const entry of nestedClosure.bindings) {
    const node = childNodeByPath.get(entry.binding_path);
    if (
      node === undefined &&
      !childNodes.nodes.some((candidate) =>
        segmentPrefix(candidate.source_path_segments, entry.binding_path_segments),
      )
    ) {
      mismatch(
        `$.nested_closure.bindings.${entry.binding_path}`,
        'nested Flow Binding path is not rooted at an exact source Flow node path',
      );
    }
    if (node === undefined) continue;
    const key = flowNodeSequence(entry.binding_path_segments);
    if (childOperations.has(key)) {
      mismatch(
        `$.nested_closure.bindings.${entry.binding_path}`,
        'nested Flow closure contains more than one Binding for a source node path',
      );
    }
    childOperations.set(key, {
      binding_id: entry.binding_id,
      binding_kind: entry.binding_kind,
      operations: entry.operation_contracts,
      requirement_expression: entry.requirement_expression,
    });
  }

  const bindingOperations = graphBound.prepared_paths.bindings.flatMap((parentBinding) => {
    const parent: ProjectedFlowBindingOperationV1 = {
      binding_id: parentBinding.binding_id,
      binding_kind: parentBinding.binding_kind,
      binding_path: parentBinding.binding_path,
      operation_contracts: [],
    };
    const nested = parentBinding.nodes.flatMap((targetNode) => {
      const source = childOperations.get(flowNodeSequence(targetNode.source_path_segments));
      if (source === undefined) return [];
      return [
        {
          binding_id: source.binding_id,
          binding_kind: source.binding_kind,
          binding_path: targetNode.source_path,
          operation_contracts: source.operations,
          requirement_expression: source.requirement_expression,
        },
      ];
    });
    return [parent, ...nested];
  });

  if (
    childOperations.size > 0 &&
    !graphBound.prepared_paths.bindings.some((binding) => binding.nodes.length > 0)
  ) {
    mismatch('$.prepared_paths', 'verified Flow operations have no parent-prefixed namespace');
  }

  const projectedParents = graphBound.prepared_paths.bindings.filter(
    (parentBinding) => parentBinding.nodes.length > 0,
  );
  if (!withinProjectedBindingCapacity(projectedParents.length, nestedClosure.bindings.length)) {
    mismatch('$.nested_closure.bindings', 'projected Flow Binding namespace exceeds its bound');
  }
  const disabledSourceSegments = nestedClosure.bindings
    .filter((entry) => nestedClosure.disabled_binding_paths.includes(entry.binding_path))
    .map((entry) => entry.binding_path_segments);
  const projectedBindingEntries = projectedParents.flatMap((parentBinding) => {
    return nestedClosure.bindings.map((entry) => {
      const [rootSegment, ...descendantSegments] = entry.binding_path_segments;
      if (
        rootSegment?.segment_kind !== 'root' ||
        !sameJson(rootSegment.pin, nestedClosure.root.pin)
      ) {
        mismatch(
          `$.nested_closure.bindings.${entry.binding_path}`,
          'nested Binding path is not rooted in the verified Flow',
        );
      }
      const rewrittenSegments = descendantSegments.map((segment) => {
        if (
          (segment.segment_kind === 'binding' || segment.segment_kind === 'flow_node') &&
          segment.owner.owner_kind === 'root' &&
          sameJson(segment.owner.pin, nestedClosure.root.pin)
        ) {
          return {
            ...segment,
            owner: {
              owner_kind: 'published_dependency' as const,
              pin: nestedClosure.root.pin,
            },
          };
        }
        return segment;
      });
      const bindingPathSegments = [
        ...parentBinding.binding_path_segments,
        ...rewrittenSegments,
      ] as ReturnType<typeof BindingPathSegmentV1Schema.parse>[];
      const bindingPath = canonicalBindingPath(bindingPathSegments);
      const directNode = childNodeByPath.get(entry.binding_path);
      if (
        directNode !== undefined &&
        !parentBinding.nodes.some(
          (candidate) =>
            flowNodeSequence(candidate.source_path_segments) ===
              flowNodeSequence(directNode.source_path_segments) &&
            candidate.source_path === bindingPath,
        )
      ) {
        mismatch(
          `$.nested_closure.bindings.${entry.binding_path}`,
          'projected direct Flow-node path does not match the prepared namespace',
        );
      }
      return {
        parent_binding_path: parentBinding.binding_path,
        parent_enabled: parentBinding.enabled,
        source_binding_path: entry.binding_path as `bp1.${string}`,
        source_disabled: disabledSourceSegments.some((segments) =>
          segmentPrefixOrEqual(segments, entry.binding_path_segments),
        ),
        binding_path: bindingPath,
        binding_path_segments: bindingPathSegments,
        entry,
      };
    });
  });
  if (
    projectedBindingEntries.length > 8_192 ||
    new Set(projectedBindingEntries.map((item) => item.binding_path)).size !==
      projectedBindingEntries.length
  ) {
    mismatch(
      '$.nested_closure.bindings',
      'projected Flow Binding namespace is not bounded and unique',
    );
  }
  const projectedResourceNodes = nestedClosure.resource_nodes
    .map((node) => (node.node_role === 'root' ? nestedDependency.resource_node : node))
    .sort((left, right) => compareCanonicalStrings(left.node_id, right.node_id));
  if (
    projectedResourceNodes.some(
      (node, index) =>
        node.node_role !== 'dependency' ||
        (index > 0 && (projectedResourceNodes[index - 1]?.node_id ?? '') >= node.node_id),
    )
  ) {
    mismatch('$.nested_closure.resource_nodes', 'projected resource nodes are not canonical');
  }

  return deepFreezeJson({
    schema_version: 'prepared-nested-flow-binding-operations/1',
    graph_hash: graphBound.graph_binding.graph_hash,
    nested_closure_hash: nestedClosure.closure_hash,
    dependency_resource_node: nestedDependency.resource_node,
    projected_resource_nodes: projectedResourceNodes,
    binding_operations: bindingOperations.sort((left, right) =>
      compareCanonicalStrings(left.binding_path, right.binding_path),
    ),
    projected_binding_entries: projectedBindingEntries.sort((left, right) =>
      compareCanonicalStrings(left.binding_path, right.binding_path),
    ),
  });
}
