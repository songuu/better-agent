import {
  ClosureResourceNodeV1Schema,
  CompiledCapabilityClosureV1Schema,
} from '@better-agent/domain-contracts';

import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import { canonicalJsonBytes } from './canonical-json.js';
import { verifyCanonicalBindingPath, verifyCanonicalResourceNodeId } from './closure-identity.js';
import { deepFreezeJson, publishedResourcePinKey } from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { canonicalSha256ExcludingRootKeys } from './hash.js';

type CompiledClosureV1 = ReturnType<typeof CompiledCapabilityClosureV1Schema.parse>;
type ClosureResourceNodeV1 = ReturnType<typeof ClosureResourceNodeV1Schema.parse>;

function invalid(path: string, reason: string): never {
  throw new ReleaseCoreError('COMPILED_CAPABILITY_CLOSURE_INVALID', path, reason);
}

function assertCanonicalSetOrder<T>(
  values: readonly T[],
  path: string,
  key: (value: T) => string,
): void {
  let previous: string | undefined;
  for (const value of values) {
    const current = key(value);
    if (previous !== undefined && previous >= current) {
      invalid(path, 'canonical set entries must be strictly increasing and unique');
    }
    previous = current;
  }
}

export function prepareCompiledCapabilityClosure(input: unknown): Readonly<CompiledClosureV1> {
  const snapshot = boundedDataSnapshot(input, 'closure');
  const parsed = CompiledCapabilityClosureV1Schema.safeParse(snapshot);
  if (!parsed.success) invalid('$', 'closure does not match the closed compiled contract');
  if (!canonicalJsonBytes(snapshot).equals(canonicalJsonBytes(parsed.data))) {
    invalid('$', 'closure parsing must preserve every canonical input byte');
  }
  for (const node of parsed.data.resource_nodes) {
    verifyCanonicalResourceNodeId(node.node_id, node.pin);
  }
  for (const binding of parsed.data.bindings) {
    verifyCanonicalBindingPath(binding.binding_path, binding.binding_path_segments);
  }
  assertCanonicalSetOrder(parsed.data.assembly_pins, '$.assembly_pins', publishedResourcePinKey);
  assertCanonicalSetOrder(parsed.data.bindings, '$.bindings', (value) => value.binding_path);
  assertCanonicalSetOrder(
    parsed.data.gate_specs,
    '$.gate_specs',
    (value) => `${value.source_node_id}\u0000${value.gate_spec_id}`,
  );
  assertCanonicalSetOrder(parsed.data.resource_nodes, '$.resource_nodes', (value) => value.node_id);
  assertCanonicalSetOrder(
    parsed.data.dependency_edges,
    '$.dependency_edges',
    (value) =>
      `${value.from_node_id}\u0000${value.to_node_id}\u0000${value.relation}\u0000${value.source_path}`,
  );
  assertCanonicalSetOrder(
    parsed.data.disabled_binding_paths,
    '$.disabled_binding_paths',
    (value) => value,
  );
  const expectedHash = canonicalSha256ExcludingRootKeys(parsed.data, ['closure_hash']);
  if (parsed.data.closure_hash !== expectedHash) {
    throw new ReleaseCoreError(
      'COMPILED_CAPABILITY_CLOSURE_HASH_MISMATCH',
      '$.closure_hash',
      'closure hash does not match the complete canonical artifact',
    );
  }
  return deepFreezeJson(parsed.data);
}

function sameVersionIdentity(
  node: Extract<ClosureResourceNodeV1, { node_role: 'dependency' }>,
  closure: CompiledClosureV1,
): boolean {
  const left = node.pin;
  const right = closure.root.pin;
  return (
    left.workspace_id === right.workspace_id &&
    left.published_resource_kind === right.published_resource_kind &&
    left.resource_id === right.resource_id &&
    left.resource_version_id === right.resource_version_id &&
    left.binding_mode === right.binding_mode
  );
}

/**
 * A registry pin may use the final published hash while the nested root carries its semantic seed.
 * Identity therefore joins on the immutable version tuple and the separately committed closure hash.
 */
export function prepareNestedCapabilityClosure(
  dependencyNodeInput: unknown,
  closureInput: unknown,
): Readonly<CompiledClosureV1> {
  const nodeSnapshot = boundedDataSnapshot(dependencyNodeInput, 'closure');
  const node = ClosureResourceNodeV1Schema.safeParse(nodeSnapshot);
  if (
    !node.success ||
    node.data.node_role !== 'dependency' ||
    (node.data.pin.published_resource_kind !== 'AGENT_RELEASE' &&
      node.data.pin.published_resource_kind !== 'FLOW_VERSION')
  ) {
    invalid('$.dependency_node', 'nested closure requires an Agent or Flow dependency node');
  }
  verifyCanonicalResourceNodeId(node.data.node_id, node.data.pin);
  const closure = prepareCompiledCapabilityClosure(closureInput);
  if (!sameVersionIdentity(node.data, closure)) {
    throw new ReleaseCoreError(
      'NESTED_CAPABILITY_CLOSURE_MISMATCH',
      '$.root.pin',
      'nested closure root does not match the dependency version identity',
    );
  }
  if (node.data.nested_closure_hash !== closure.closure_hash) {
    throw new ReleaseCoreError(
      'NESTED_CAPABILITY_CLOSURE_MISMATCH',
      '$.closure_hash',
      'nested closure hash does not match the dependency graph commitment',
    );
  }
  return closure;
}
