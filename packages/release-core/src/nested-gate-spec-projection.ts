import {
  type BindingPathSegmentV1Schema,
  CompiledGateSpecEntryV1Schema,
  type CompiledCapabilityClosureV1,
  type PublishedResourcePinV1,
} from '@better-agent/domain-contracts';

import { canonicalJsonBytes } from './canonical-json.js';
import { canonicalBindingPath, verifyCanonicalResourceNodeId } from './closure-identity.js';
import { compareCanonicalStrings } from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { withinProjectedBindingCapacity } from './projection-capacity.js';

type BindingPathSegmentV1 = ReturnType<typeof BindingPathSegmentV1Schema.parse>;
type CompiledGateSpecEntryV1 = ReturnType<typeof CompiledGateSpecEntryV1Schema.parse>;
type NestedGateClosure = {
  readonly root: CompiledCapabilityClosureV1['root'];
  readonly resource_nodes: readonly CompiledCapabilityClosureV1['resource_nodes'][number][];
  readonly gate_specs: readonly CompiledGateSpecEntryV1[];
};

function mismatch(path: string, reason: string): never {
  throw new ReleaseCoreError('NESTED_CAPABILITY_CLOSURE_MISMATCH', path, reason);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}

/** Prove that the child closure carries exactly the GateSpecs owned by its source root. */
export function verifyDirectGateSpecs(
  nestedClosure: NestedGateClosure,
  directGates: readonly CompiledGateSpecEntryV1[],
): void {
  const rootNode = nestedClosure.resource_nodes.find((node) => node.node_role === 'root');
  if (rootNode === undefined) mismatch('$.nested_closure.resource_nodes', 'child root is missing');
  const retained = nestedClosure.gate_specs.filter(
    (gate) => gate.source_node_id === rootNode.node_id,
  );
  if (!sameJson(retained, directGates)) {
    mismatch(
      '$.nested_closure.gate_specs',
      'child closure does not retain the exact GateSpecs compiled from its source',
    );
  }
}

/** Re-root every path-bearing child GateSpec under each exact parent mount. */
export function projectNestedGateSpecs(
  nestedClosure: NestedGateClosure,
  mountPathSegments: readonly (readonly BindingPathSegmentV1[])[],
  publishedRoot: { readonly node_id: string; readonly pin: PublishedResourcePinV1 },
): readonly CompiledGateSpecEntryV1[] {
  verifyCanonicalResourceNodeId(publishedRoot.node_id, publishedRoot.pin);
  if (!withinProjectedBindingCapacity(mountPathSegments.length, nestedClosure.gate_specs.length)) {
    mismatch('$.nested_closure.gate_specs', 'projected child GateSpec namespace exceeds its bound');
  }
  const rootNode = nestedClosure.resource_nodes.find((node) => node.node_role === 'root');
  if (rootNode === undefined) mismatch('$.nested_closure.resource_nodes', 'child root is missing');
  const projected = mountPathSegments.flatMap((mountSegments) =>
    nestedClosure.gate_specs.map((gate) => {
      const sourceNodeId =
        gate.source_node_id === rootNode.node_id ? publishedRoot.node_id : gate.source_node_id;
      if (gate.source_kind === 'agent_release') return { ...gate, source_node_id: sourceNodeId };
      const [rootSegment, ...descendantSegments] = gate.source_binding_path_segments;
      if (
        rootSegment?.segment_kind !== 'root' ||
        !sameJson(rootSegment.pin, nestedClosure.root.pin)
      ) {
        mismatch(
          `$.nested_closure.gate_specs.${gate.gate_spec_id}`,
          'nested Flow GateSpec path is not rooted in the verified child closure',
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
            owner: { owner_kind: 'published_dependency' as const, pin: publishedRoot.pin },
          };
        }
        return segment;
      });
      const sourceBindingPathSegments = [
        ...mountSegments,
        ...rewrittenSegments,
      ] as BindingPathSegmentV1[];
      const parsed = CompiledGateSpecEntryV1Schema.safeParse({
        ...gate,
        source_node_id: sourceNodeId,
        source_binding_path: canonicalBindingPath(sourceBindingPathSegments),
        source_binding_path_segments: sourceBindingPathSegments,
      });
      if (!parsed.success) {
        mismatch(
          `$.nested_closure.gate_specs.${gate.gate_spec_id}`,
          'projected child GateSpec is not a closed path-bound entry',
        );
      }
      return parsed.data;
    }),
  );
  const byIdentity = new Map<string, CompiledGateSpecEntryV1>();
  for (const gate of projected) {
    const key = `${gate.source_node_id}\u0000${gate.source_kind === 'flow_node' ? gate.source_binding_path : ''}\u0000${gate.gate_spec_id}`;
    const existing = byIdentity.get(key);
    if (existing !== undefined && !sameJson(existing, gate)) {
      mismatch('$.nested_closure.gate_specs', 'projected GateSpec identity is ambiguous');
    }
    byIdentity.set(key, gate);
  }
  return [...byIdentity.entries()]
    .sort(([left], [right]) => compareCanonicalStrings(left, right))
    .map(([, gate]) => gate);
}
