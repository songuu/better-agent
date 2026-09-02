import type { CapabilityBindingV1, OperationContractPinV1 } from '@better-agent/domain-contracts';

import { canonicalJsonBytes } from './canonical-json.js';
import { prepareNestedCapabilityDependency } from './compiled-capability-closure.js';
import { compareCanonicalStrings, deepFreezeJson } from './dependency-manifest.js';
import { prepareExecutableSource } from './executable-source.js';
import { ReleaseCoreError } from './errors.js';
import { prepareGraphBoundInternalSubagentPaths } from './graph-bound-direct-paths.js';
import { prepareRootBindingPaths } from './root-binding-paths.js';

export interface PreparedNestedAgentBindingOperationsV1 {
  readonly schema_version: 'prepared-nested-agent-binding-operations/1';
  readonly graph_hash: `sha256:${string}`;
  readonly nested_closure_hash: string;
  readonly binding_operations: readonly {
    readonly binding_id: string;
    readonly binding_kind: CapabilityBindingV1['kind'];
    readonly binding_path: `bp1.${string}`;
    readonly operation_contracts: readonly OperationContractPinV1[];
  }[];
}

function mismatch(path: string, reason: string): never {
  throw new ReleaseCoreError('NESTED_CAPABILITY_CLOSURE_MISMATCH', path, reason);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}

/** Project verified child-root Binding operations into every parent-prefixed SubAgent namespace. */
export function prepareGraphBoundNestedAgentBindingOperations(
  expectedGraph: unknown,
  graphCandidate: unknown,
  rootInput: unknown,
  dependencyInput: unknown,
  nestedClosureInput: unknown,
): PreparedNestedAgentBindingOperationsV1 {
  const graphBound = prepareGraphBoundInternalSubagentPaths(
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
    }
  >();
  for (const childPath of childRootPaths.bindings) {
    const entry = closureBindings.get(childPath.binding_path);
    if (
      entry === undefined ||
      entry.binding_id !== childPath.binding_id ||
      entry.binding_kind !== childPath.binding_kind
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
      };
    });
    return [parent, ...nested];
  });

  return deepFreezeJson({
    schema_version: 'prepared-nested-agent-binding-operations/1',
    graph_hash: graphBound.graph_binding.graph_hash,
    nested_closure_hash: nestedClosure.closure_hash,
    binding_operations: bindingOperations.sort((left, right) =>
      compareCanonicalStrings(left.binding_path, right.binding_path),
    ),
  });
}
