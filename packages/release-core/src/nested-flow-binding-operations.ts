import type { CapabilityBindingV1, OperationContractPinV1 } from '@better-agent/domain-contracts';

import { canonicalJsonBytes } from './canonical-json.js';
import { prepareNestedCapabilityClosure } from './compiled-capability-closure.js';
import { compareCanonicalStrings, deepFreezeJson } from './dependency-manifest.js';
import { prepareExecutableSource } from './executable-source.js';
import { ReleaseCoreError } from './errors.js';
import { prepareGraphBoundAgentFlowPaths } from './graph-bound-direct-paths.js';
import { prepareFlowNodePaths } from './root-binding-paths.js';

interface ProjectedFlowBindingOperationV1 {
  readonly binding_id: string;
  readonly binding_kind: CapabilityBindingV1['kind'];
  readonly binding_path: `bp1.${string}`;
  readonly operation_contracts: readonly OperationContractPinV1[];
}

export interface PreparedNestedFlowBindingOperationsV1 {
  readonly schema_version: 'prepared-nested-flow-binding-operations/1';
  readonly graph_hash: `sha256:${string}`;
  readonly nested_closure_hash: string;
  readonly binding_operations: readonly ProjectedFlowBindingOperationV1[];
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
  const nestedClosure = prepareNestedCapabilityClosure(
    graphBound.graph_binding.dependency_node,
    nestedClosureInput,
  );
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
    graphBound.graph_binding.dependency_node.dependency_manifest_hash !==
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
    }
  >();
  for (const entry of nestedClosure.bindings) {
    const node = childNodeByPath.get(entry.binding_path);
    if (node === undefined) {
      mismatch(
        `$.nested_closure.bindings.${entry.binding_path}`,
        'nested Flow Binding path is not an exact source Flow node path',
      );
    }
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

  return deepFreezeJson({
    schema_version: 'prepared-nested-flow-binding-operations/1',
    graph_hash: graphBound.graph_binding.graph_hash,
    nested_closure_hash: nestedClosure.closure_hash,
    binding_operations: bindingOperations.sort((left, right) =>
      compareCanonicalStrings(left.binding_path, right.binding_path),
    ),
  });
}
