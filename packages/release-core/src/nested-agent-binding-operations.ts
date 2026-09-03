import type {
  BindingPathSegmentV1Schema,
  CapabilityBindingV1,
  CapabilityRequirementExpressionV1,
  CompiledBindingEntryV1Schema,
  OperationContractPinV1,
} from '@better-agent/domain-contracts';

import { canonicalJsonBytes } from './canonical-json.js';
import { canonicalBindingPath } from './closure-identity.js';
import {
  prepareCompiledCapabilityClosure,
  prepareNestedCapabilityDependency,
} from './compiled-capability-closure.js';
import { compareCanonicalStrings, deepFreezeJson } from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { prepareExecutableSource } from './executable-source.js';
import { prepareGraphBoundInternalSubagentPaths } from './graph-bound-direct-paths.js';
import { prepareAgentGateSpecs } from './agent-gate-specs.js';
import { projectNestedGateSpecs, verifyDirectGateSpecs } from './nested-gate-spec-projection.js';
import { withinProjectedBindingCapacity } from './projection-capacity.js';
import { prepareRootBindingPaths } from './root-binding-paths.js';
import { bindingAdmissionEvidence } from './required-binding-call.js';

export interface PreparedNestedAgentBindingOperationsV1 {
  readonly schema_version: 'prepared-nested-agent-binding-operations/1';
  readonly graph_hash: `sha256:${string}`;
  readonly nested_closure_hash: string;
  readonly nested_closure: ReturnType<typeof prepareNestedCapabilityDependency>['closure'];
  readonly dependency_resource_node: ReturnType<
    typeof prepareNestedCapabilityDependency
  >['resource_node'];
  readonly projected_resource_nodes: readonly ReturnType<
    typeof prepareNestedCapabilityDependency
  >['resource_node'][];
  readonly projected_gate_specs: ReturnType<typeof projectNestedGateSpecs>;
  readonly binding_operations: readonly {
    readonly binding_id: string;
    readonly binding_kind: CapabilityBindingV1['kind'];
    readonly binding_path: `bp1.${string}`;
    readonly operation_contracts: readonly OperationContractPinV1[];
    readonly requirement_expression?: CapabilityRequirementExpressionV1;
  }[];
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

function segmentPrefixOrEqual(prefix: readonly unknown[], value: readonly unknown[]): boolean {
  return (
    prefix.length <= value.length &&
    prefix.every((segment, index) => sameJson(segment, value[index]))
  );
}

/** Project verified child-root Binding operations into every parent-prefixed SubAgent namespace. */
export function prepareGraphBoundNestedAgentBindingOperations(
  expectedGraph: unknown,
  graphCandidate: unknown,
  rootInput: unknown,
  dependencyInput: unknown,
  nestedClosureInput: unknown,
): PreparedNestedAgentBindingOperationsV1 {
  const verifiedClosure = prepareCompiledCapabilityClosure(nestedClosureInput);
  const graphBound = prepareGraphBoundInternalSubagentPaths(
    expectedGraph,
    graphCandidate,
    rootInput,
    dependencyInput,
    verifiedClosure.closure_hash,
  );
  const nestedDependency = prepareNestedCapabilityDependency(
    graphBound.graph_binding.dependency_node,
    verifiedClosure,
  );
  const nestedClosure = nestedDependency.closure;
  verifyDirectGateSpecs(nestedClosure, prepareAgentGateSpecs(dependencyInput).gate_specs);
  const childSource = prepareExecutableSource(dependencyInput);
  const childRootPaths = prepareRootBindingPaths(dependencyInput);
  if (!sameJson(childRootPaths.root.pin, nestedClosure.root.pin)) {
    mismatch(
      '$.nested_closure.root.pin',
      'nested closure does not describe the supplied child source',
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
      'Agent source, graph dependency manifest, and nested closure assembly do not agree',
    );
  }

  const closureBindings = new Map(
    nestedClosure.bindings.map((entry) => [entry.binding_path, entry]),
  );
  const childOperations = new Map<
    string,
    {
      binding_kind: CapabilityBindingV1['kind'];
      target: unknown;
      operations: readonly OperationContractPinV1[];
      requirement_expression: CapabilityRequirementExpressionV1;
    }
  >();
  for (const childPath of childRootPaths.bindings) {
    const entry = closureBindings.get(childPath.binding_path);
    const sourceBinding = (
      childSource.preimage.document as unknown as { capability_bindings: CapabilityBindingV1[] }
    ).capability_bindings.find((binding) => binding.binding_id === childPath.binding_id);
    if (
      entry === undefined ||
      entry.binding_id !== childPath.binding_id ||
      entry.binding_kind !== childPath.binding_kind ||
      sourceBinding === undefined ||
      !sameJson(bindingAdmissionEvidence(sourceBinding), {
        admission_requirement: entry.admission_requirement,
        ...(entry.required_call === undefined ? {} : { required_call: entry.required_call }),
      })
    ) {
      mismatch(
        `$.nested_closure.bindings.${childPath.binding_path}`,
        'nested closure is missing the exact direct child Binding path',
      );
    }
    childOperations.set(childPath.binding_id, {
      binding_kind: childPath.binding_kind,
      target: entry.target,
      operations: entry.operation_contracts,
      requirement_expression: entry.requirement_expression,
    });
  }

  const bindingOperations = graphBound.prepared_paths.bindings.flatMap((parentBinding) => {
    const parent = {
      binding_id: parentBinding.binding_id,
      binding_kind: parentBinding.binding_kind,
      binding_path: parentBinding.binding_path,
      operation_contracts: [] as readonly OperationContractPinV1[],
    };
    if (parentBinding.subagent_target === undefined) return [parent];
    const nested = parentBinding.subagent_target.bindings.map((targetBinding) => {
      const source = childOperations.get(targetBinding.binding_id);
      if (
        source === undefined ||
        source.binding_kind !== targetBinding.binding_kind ||
        !sameJson(source.target, targetBinding.target)
      ) {
        mismatch(
          `$.prepared_paths.${targetBinding.binding_path}`,
          'prefixed child Binding does not match its verified closure entry',
        );
      }
      return {
        binding_id: targetBinding.binding_id,
        binding_kind: targetBinding.binding_kind,
        binding_path: targetBinding.binding_path,
        operation_contracts: source.operations,
        requirement_expression: source.requirement_expression,
      };
    });
    return [parent, ...nested];
  });

  const projectedParents = graphBound.prepared_paths.bindings.filter(
    (parentBinding) => parentBinding.subagent_target !== undefined,
  );
  if (!withinProjectedBindingCapacity(projectedParents.length, nestedClosure.bindings.length)) {
    mismatch('$.nested_closure.bindings', 'projected child Binding namespace exceeds its bound');
  }
  const disabledSourceSegments = nestedClosure.bindings
    .filter((entry) => nestedClosure.disabled_binding_paths.includes(entry.binding_path))
    .map((entry) => entry.binding_path_segments);
  const projectedBindingEntries = projectedParents.flatMap((parentBinding) => {
    const target = parentBinding.subagent_target;
    if (target === undefined) return [];
    return nestedClosure.bindings.map((entry) => {
      const [rootSegment, ...descendantSegments] = entry.binding_path_segments;
      if (
        rootSegment?.segment_kind !== 'root' ||
        !sameJson(rootSegment.pin, nestedClosure.root.pin)
      ) {
        mismatch(
          `$.nested_closure.bindings.${entry.binding_path}`,
          'nested Binding path is not rooted in the verified child Agent',
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
              pin: nestedDependency.resource_node.pin,
            },
          };
        }
        return segment;
      });
      const bindingPathSegments = [
        ...target.target_path_segments,
        ...rewrittenSegments,
      ] as ReturnType<typeof BindingPathSegmentV1Schema.parse>[];
      const bindingPath = canonicalBindingPath(bindingPathSegments);
      const direct = target.bindings.find((candidate) => candidate.binding_id === entry.binding_id);
      if (
        descendantSegments.length === 1 &&
        descendantSegments[0]?.segment_kind === 'binding' &&
        direct?.binding_path !== bindingPath
      ) {
        mismatch(
          `$.nested_closure.bindings.${entry.binding_path}`,
          'projected direct child Binding path does not match the prepared namespace',
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
      'projected child Binding namespace is not bounded and unique',
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
  const projectedGateSpecs = projectNestedGateSpecs(
    nestedClosure,
    projectedParents.map(
      (parentBinding) => parentBinding.subagent_target?.target_path_segments ?? [],
    ),
    nestedDependency.resource_node,
  );

  return deepFreezeJson({
    schema_version: 'prepared-nested-agent-binding-operations/1',
    graph_hash: graphBound.graph_binding.graph_hash,
    nested_closure_hash: nestedClosure.closure_hash,
    nested_closure: nestedClosure,
    dependency_resource_node: nestedDependency.resource_node,
    projected_resource_nodes: projectedResourceNodes,
    projected_gate_specs: projectedGateSpecs,
    binding_operations: bindingOperations.sort((left, right) =>
      compareCanonicalStrings(left.binding_path, right.binding_path),
    ),
    projected_binding_entries: projectedBindingEntries.sort((left, right) =>
      compareCanonicalStrings(left.binding_path, right.binding_path),
    ),
  });
}
