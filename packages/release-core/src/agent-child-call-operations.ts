import type { CapabilityBindingV1, OperationContractPinV1 } from '@better-agent/domain-contracts';

import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import {
  compareCanonicalStrings,
  deepFreezeJson,
  publishedResourcePinKey,
} from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { prepareExecutableSource } from './executable-source.js';
import {
  type PreparedNestedAgentBindingOperationsV1,
  prepareGraphBoundNestedAgentBindingOperations,
} from './nested-agent-binding-operations.js';
import {
  type PreparedNestedFlowBindingOperationsV1,
  prepareGraphBoundNestedFlowBindingOperations,
} from './nested-flow-binding-operations.js';
import { verifyBindingOperationContract } from './operation-contract-source.js';
import { prepareRootBindingPaths } from './root-binding-paths.js';

type NestedProjection =
  | PreparedNestedAgentBindingOperationsV1
  | PreparedNestedFlowBindingOperationsV1;

interface CallDeclaration {
  readonly binding_id: string;
  readonly operation: unknown;
}

export interface PreparedAgentChildCallOperationsV1 {
  readonly schema_version: 'prepared-agent-child-call-operations/1';
  readonly dependency_kind: 'AGENT_RELEASE' | 'FLOW_VERSION';
  readonly graph_hash: `sha256:${string}`;
  readonly nested_closure_hash: string;
  readonly dependency_resource_node: NestedProjection['dependency_resource_node'];
  readonly binding_operations: readonly {
    readonly binding_id: string;
    readonly binding_kind: CapabilityBindingV1['kind'];
    readonly binding_path: `bp1.${string}`;
    readonly operation_contracts: readonly OperationContractPinV1[];
  }[];
}

function mismatch(path: string, reason: string): never {
  throw new ReleaseCoreError('CAPABILITY_OPERATION_CONTRACT_MISMATCH', path, reason);
}

function declarations(input: unknown): readonly CallDeclaration[] {
  const snapshot = boundedDataSnapshot(input, 'source');
  if (!Array.isArray(snapshot)) mismatch('$', 'child call declarations must be an array');
  const seen = new Set<string>();
  return snapshot.map((entry, index) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 2 ||
      !Object.hasOwn(entry, 'binding_id') ||
      !Object.hasOwn(entry, 'operation')
    ) {
      mismatch(`$[${index}]`, 'child call declaration must contain only binding_id and operation');
    }
    const value = entry as Record<string, unknown>;
    if (typeof value.binding_id !== 'string' || value.binding_id.length === 0) {
      mismatch(`$[${index}].binding_id`, 'child call Binding ID must be non-empty');
    }
    if (seen.has(value.binding_id)) {
      mismatch(`$[${index}].binding_id`, 'child call Binding declaration is duplicated');
    }
    seen.add(value.binding_id);
    return { binding_id: value.binding_id, operation: value.operation };
  });
}

function prepare(
  projection: NestedProjection,
  rootInput: unknown,
  dependencyInput: unknown,
  declarationInput: unknown,
  dependencyKind: 'AGENT_RELEASE' | 'FLOW_VERSION',
): PreparedAgentChildCallOperationsV1 {
  const rootSource = prepareExecutableSource(rootInput);
  const dependencySource = prepareExecutableSource(dependencyInput);
  const targetPin = { ...dependencySource.root.pin, published_resource_kind: dependencyKind };
  const targetKey = publishedResourcePinKey(targetPin);
  const document = rootSource.preimage.document as unknown as {
    capability_bindings: readonly CapabilityBindingV1[];
  };
  const matching = document.capability_bindings.filter((binding) => {
    if (publishedResourcePinKey(binding.pin) !== targetKey) return false;
    if (dependencyKind === 'FLOW_VERSION') return binding.kind === 'flow';
    return binding.kind === 'subagent' && binding.target_kind === 'internal_agent';
  });
  const supplied = declarations(declarationInput);
  if (matching.length === 0 || supplied.length !== matching.length) {
    mismatch('$', 'every exact child mount requires one call operation declaration');
  }
  const matchingById = new Map(matching.map((binding) => [binding.binding_id, binding]));
  const operationById = new Map<string, OperationContractPinV1>();
  for (const declaration of supplied) {
    const binding = matchingById.get(declaration.binding_id);
    if (binding === undefined) {
      mismatch(
        `$.${declaration.binding_id}`,
        'call operation declaration does not identify an exact child mount',
      );
    }
    operationById.set(
      declaration.binding_id,
      verifyBindingOperationContract(binding, declaration.operation),
    );
  }
  const operationByPath = new Map<string, OperationContractPinV1>();
  for (const path of prepareRootBindingPaths(rootInput).bindings) {
    const operation = operationById.get(path.binding_id);
    if (operation !== undefined) operationByPath.set(path.binding_path, operation);
  }
  if (operationByPath.size !== matching.length) {
    mismatch('$', 'child call operation could not be bound to its canonical parent path');
  }

  return deepFreezeJson({
    schema_version: 'prepared-agent-child-call-operations/1',
    dependency_kind: dependencyKind,
    graph_hash: projection.graph_hash,
    nested_closure_hash: projection.nested_closure_hash,
    dependency_resource_node: projection.dependency_resource_node,
    binding_operations: projection.binding_operations
      .map((entry) => {
        const operation = operationByPath.get(entry.binding_path);
        return operation === undefined
          ? entry
          : { ...entry, operation_contracts: [operation] as readonly OperationContractPinV1[] };
      })
      .sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path)),
  });
}

/** Attach one verified flow_call declaration to every exact parent Flow mount. */
export function prepareGraphBoundAgentFlowCallOperations(
  expectedGraph: unknown,
  graphCandidate: unknown,
  rootInput: unknown,
  dependencyInput: unknown,
  nestedClosureInput: unknown,
  declarationInput: unknown,
): PreparedAgentChildCallOperationsV1 {
  return prepare(
    prepareGraphBoundNestedFlowBindingOperations(
      expectedGraph,
      graphCandidate,
      rootInput,
      dependencyInput,
      nestedClosureInput,
    ),
    rootInput,
    dependencyInput,
    declarationInput,
    'FLOW_VERSION',
  );
}

/** Attach one verified subagent_call declaration to every exact parent internal-Agent mount. */
export function prepareGraphBoundAgentSubagentCallOperations(
  expectedGraph: unknown,
  graphCandidate: unknown,
  rootInput: unknown,
  dependencyInput: unknown,
  nestedClosureInput: unknown,
  declarationInput: unknown,
): PreparedAgentChildCallOperationsV1 {
  return prepare(
    prepareGraphBoundNestedAgentBindingOperations(
      expectedGraph,
      graphCandidate,
      rootInput,
      dependencyInput,
      nestedClosureInput,
    ),
    rootInput,
    dependencyInput,
    declarationInput,
    'AGENT_RELEASE',
  );
}
