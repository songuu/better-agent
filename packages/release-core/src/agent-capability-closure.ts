import {
  BindingPathSegmentV1Schema,
  ClosureRootV1Schema,
  CompiledBindingEntryV1Schema,
  type CompiledCapabilityClosureV1,
} from '@better-agent/domain-contracts';
import { prepareAgentGateSpecs } from './agent-gate-specs.js';
import type { PreparedAgentRootBindingEntrySetV1 } from './agent-root-binding-entry-set.js';
import { prepareAgentRootResourceGraph } from './agent-root-resource-graph.js';
import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import { canonicalJsonBytes } from './canonical-json.js';
import {
  prepareCompiledCapabilityClosure,
  prepareNestedCapabilityDependency,
} from './compiled-capability-closure.js';
import { compareCanonicalStrings } from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { prepareExecutableSource } from './executable-source.js';
import { canonicalSha256ExcludingRootKeys } from './hash.js';
import { projectNestedGateSpecs } from './nested-gate-spec-projection.js';
import { accumulateProjectedBindingCapacity } from './projection-capacity.js';

function notClosed(path: string, reason: string): never {
  throw new ReleaseCoreError('COMPILED_CAPABILITY_CLOSURE_INVALID', path, reason);
}

function parseRetainedEntrySet(input: unknown): PreparedAgentRootBindingEntrySetV1 {
  const snapshot = boundedDataSnapshot(input, 'closure');
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    notClosed('$.entry_set', 'Agent entry set must be a closed object');
  }
  const entrySet = snapshot as unknown as PreparedAgentRootBindingEntrySetV1;
  const root = ClosureRootV1Schema.safeParse(entrySet.root);
  if (
    entrySet.schema_version !== 'prepared-agent-root-binding-entry-set/1' ||
    !root.success ||
    !Array.isArray(entrySet.entries) ||
    !Array.isArray(entrySet.descendant_binding_entries) ||
    !Array.isArray(entrySet.descendant_gate_specs) ||
    !Array.isArray(entrySet.nested_gate_closures)
  ) {
    notClosed('$.entry_set', 'Agent entry set does not retain closure assembly facts');
  }
  for (const [index, entry] of [
    ...entrySet.entries,
    ...entrySet.descendant_binding_entries,
  ].entries()) {
    if (!CompiledBindingEntryV1Schema.safeParse(entry).success) {
      notClosed(`$.entry_set.bindings[${index}]`, 'Agent entry set contains an invalid Binding');
    }
  }
  return entrySet;
}

type GateSpec = CompiledCapabilityClosureV1['gate_specs'][number];
type Binding = CompiledCapabilityClosureV1['bindings'][number];

function gateIdentity(gate: GateSpec): string {
  return `${gate.source_node_id}\u0000${gate.source_kind === 'flow_node' ? gate.source_binding_path : ''}\u0000${gate.gate_spec_id}`;
}

function versionIdentity(pin: {
  workspace_id: string;
  published_resource_kind: string;
  resource_id: string;
  resource_version_id: string;
  binding_mode: string;
}): string {
  return `${pin.workspace_id}\u0000${pin.published_resource_kind}\u0000${pin.resource_id}\u0000${pin.resource_version_id}\u0000${pin.binding_mode}`;
}

function sourceNodeForBinding(
  binding: Binding,
  rootNodeId: string,
  nodeIdByPin: ReadonlyMap<string, string>,
): string {
  let sourceNodeId = rootNodeId;
  for (const segment of binding.binding_path_segments) {
    const pin =
      segment.segment_kind === 'binding' || segment.segment_kind === 'flow_node'
        ? segment.owner.owner_kind === 'published_dependency'
          ? segment.owner.pin
          : undefined
        : segment.segment_kind === 'subagent_target'
          ? segment.target_pin
          : undefined;
    if (pin !== undefined) {
      sourceNodeId = nodeIdByPin.get(versionIdentity(pin)) ?? sourceNodeId;
    }
  }
  return sourceNodeId;
}

function sourceScopePrefix(
  segments: Binding['binding_path_segments'],
  sourceNodeId: string,
  nodeIdByPin: ReadonlyMap<string, string>,
): readonly unknown[] | undefined {
  const boundaryIndex = segments.findIndex((segment) => {
    const pin =
      segment.segment_kind === 'binding' || segment.segment_kind === 'flow_node'
        ? segment.owner.owner_kind === 'published_dependency'
          ? segment.owner.pin
          : undefined
        : segment.segment_kind === 'subagent_target'
          ? segment.target_pin
          : undefined;
    return pin !== undefined && nodeIdByPin.get(versionIdentity(pin)) === sourceNodeId;
  });
  return boundaryIndex < 0 ? undefined : segments.slice(0, boundaryIndex);
}

function encodedScope(prefix: readonly unknown[] | undefined): string | undefined {
  return prefix === undefined ? undefined : canonicalJsonBytes(prefix).toString('base64url');
}

function approvalIndexKey(
  sourceNodeId: string,
  gateSpecId: string,
  gateSpecHash: string,
  scope: string,
): string {
  return `${sourceNodeId}\u0000${gateSpecId}\u0000${gateSpecHash}\u0000${scope}`;
}

export function verifyAgentClosureApprovalCoverage(
  bindings: readonly Binding[],
  gates: readonly GateSpec[],
  resourceGraph: Pick<ReturnType<typeof prepareAgentRootResourceGraph>, 'resource_nodes'>,
): void {
  const rootNode = resourceGraph.resource_nodes.find((node) => node.node_role === 'root');
  if (rootNode === undefined) notClosed('$.resource_nodes', 'closure root resource is missing');
  const nodeIdByPin = new Map(
    resourceGraph.resource_nodes.map((node) => [versionIdentity(node.pin), node.node_id]),
  );
  const nodesById = new Map(resourceGraph.resource_nodes.map((node) => [node.node_id, node]));
  const gatesByJoinKey = new Map<string, GateSpec[]>();
  for (const gate of gates) {
    if (gate.kind !== 'approval') continue;
    const sourceKind = nodesById.get(gate.source_node_id)?.pin.published_resource_kind;
    const scope =
      sourceKind === 'FLOW_VERSION' && gate.source_kind === 'flow_node'
        ? encodedScope(
            sourceScopePrefix(gate.source_binding_path_segments, gate.source_node_id, nodeIdByPin),
          )
        : sourceKind === 'AGENT_RELEASE' && gate.source_kind === 'agent_release'
          ? ''
          : undefined;
    if (scope === undefined) continue;
    const key = approvalIndexKey(
      gate.source_node_id,
      gate.gate_spec_id,
      gate.gate_spec_hash,
      scope,
    );
    const candidates = gatesByJoinKey.get(key) ?? [];
    candidates.push(gate);
    gatesByJoinKey.set(key, candidates);
  }
  for (const binding of bindings) {
    if (binding.approval_gate_spec === undefined) continue;
    const sourceNodeId = sourceNodeForBinding(binding, rootNode.node_id, nodeIdByPin);
    const sourceKind = nodesById.get(sourceNodeId)?.pin.published_resource_kind;
    const scope =
      sourceKind === 'FLOW_VERSION'
        ? encodedScope(sourceScopePrefix(binding.binding_path_segments, sourceNodeId, nodeIdByPin))
        : sourceKind === 'AGENT_RELEASE'
          ? ''
          : undefined;
    const matches =
      scope === undefined
        ? []
        : (gatesByJoinKey.get(
            approvalIndexKey(
              sourceNodeId,
              binding.approval_gate_spec.gate_spec_id,
              binding.approval_gate_spec.gate_spec_hash,
              scope,
            ),
          ) ?? []);
    const gate = matches[0];
    if (
      matches.length !== 1 ||
      gate === undefined ||
      !binding.operation_contracts.every((operation) =>
        gate.protected_operation_contract_hashes.includes(operation.contract_hash),
      )
    ) {
      notClosed(
        `$.bindings.${binding.binding_path}.approval_gate_spec`,
        'Binding approval must resolve to one exact same-source GateSpec with complete operation coverage',
      );
    }
  }
}

function verifyNestedGateDirectory(
  entrySet: PreparedAgentRootBindingEntrySetV1,
  resourceGraph: ReturnType<typeof prepareAgentRootResourceGraph>,
): void {
  const nodesById = new Map(resourceGraph.resource_nodes.map((node) => [node.node_id, node]));
  const directRecursiveNodeIds = new Set(
    entrySet.entries
      .filter(
        (entry) =>
          (entry.binding_kind === 'flow' &&
            entry.target.published_resource_kind === 'FLOW_VERSION') ||
          (entry.binding_kind === 'subagent' &&
            entry.target.published_resource_kind === 'AGENT_RELEASE'),
      )
      .flatMap((entry) => entry.dependency_node_ids),
  );
  if (
    entrySet.nested_gate_closures.length !== directRecursiveNodeIds.size ||
    new Set(entrySet.nested_gate_closures.map((evidence) => evidence.source_node_id)).size !==
      entrySet.nested_gate_closures.length
  ) {
    notClosed('$.entry_set.nested_gate_closures', 'recursive Gate closure directory is incomplete');
  }
  const expectedByIdentity = new Map<string, GateSpec>();
  let projectedGateCount = 0;
  for (const evidence of entrySet.nested_gate_closures) {
    const node = nodesById.get(evidence.source_node_id);
    if (
      !directRecursiveNodeIds.has(evidence.source_node_id) ||
      node === undefined ||
      node.node_role !== 'dependency' ||
      node.nested_closure_hash !== evidence.nested_closure_hash
    ) {
      notClosed('$.entry_set.nested_gate_closures', 'recursive Gate evidence is not graph-bound');
    }
    const nested = prepareNestedCapabilityDependency(
      {
        node_id: node.node_id,
        pin: node.pin,
        dependency_manifest_hash: node.dependency_manifest_hash,
        nested_closure_hash: node.nested_closure_hash,
      },
      evidence.nested_closure,
    );
    const parents = entrySet.entries.filter(
      (entry) =>
        ((entry.binding_kind === 'flow' &&
          entry.target.published_resource_kind === 'FLOW_VERSION') ||
          (entry.binding_kind === 'subagent' &&
            entry.target.published_resource_kind === 'AGENT_RELEASE')) &&
        entry.dependency_node_ids.includes(node.node_id),
    );
    const mountPaths = parents.map((entry) =>
      entry.binding_kind === 'flow'
        ? entry.binding_path_segments
        : [
            ...entry.binding_path_segments,
            BindingPathSegmentV1Schema.parse({
              segment_kind: 'subagent_target',
              target_pin: nested.closure.root.pin,
            }),
          ],
    );
    const nextProjectedGateCount = accumulateProjectedBindingCapacity(
      projectedGateCount,
      mountPaths.length,
      nested.closure.gate_specs.length,
    );
    if (nextProjectedGateCount === undefined) {
      notClosed(
        '$.entry_set.nested_gate_closures',
        'recursive Gate replay exceeds the global projection bound',
      );
    }
    projectedGateCount = nextProjectedGateCount;
    for (const gate of projectNestedGateSpecs(nested.closure, mountPaths, node.node_id)) {
      const identity = gateIdentity(gate);
      const existing = expectedByIdentity.get(identity);
      if (
        existing !== undefined &&
        !canonicalJsonBytes(existing).equals(canonicalJsonBytes(gate))
      ) {
        notClosed('$.entry_set.descendant_gate_specs', 'recursive Gate identity is ambiguous');
      }
      expectedByIdentity.set(identity, gate);
    }
  }
  const expected = [...expectedByIdentity.entries()]
    .sort(([left], [right]) => compareCanonicalStrings(left, right))
    .map(([, gate]) => gate);
  if (!canonicalJsonBytes(expected).equals(canonicalJsonBytes(entrySet.descendant_gate_specs))) {
    notClosed(
      '$.entry_set.descendant_gate_specs',
      'recursive Gate directory is not the exact projection of retained child closures',
    );
  }
}

/** Seal a complete Agent closure from verified root, recursive Binding and graph projections. */
export function prepareAgentCapabilityClosure(
  rootInput: unknown,
  graphInput: unknown,
  entrySetInput: unknown,
) {
  const source = prepareExecutableSource(rootInput);
  if (source.root.pin.published_resource_kind !== 'AGENT_RELEASE') {
    notClosed('$.root', 'non-recursive Agent closure assembly requires an Agent root');
  }
  const entrySet = parseRetainedEntrySet(entrySetInput);
  const resourceGraph = prepareAgentRootResourceGraph(graphInput, entrySetInput);
  verifyNestedGateDirectory(entrySet, resourceGraph);
  const gateSpecs = prepareAgentGateSpecs(rootInput);
  if (
    !canonicalJsonBytes(source.root).equals(canonicalJsonBytes(entrySet.root)) ||
    !canonicalJsonBytes(source.root).equals(canonicalJsonBytes(gateSpecs.root))
  ) {
    notClosed('$.entry_set.root', 'Agent entry set is not bound to the supplied source');
  }
  const bindings = [...entrySet.entries, ...entrySet.descendant_binding_entries].sort(
    (left, right) => compareCanonicalStrings(left.binding_path, right.binding_path),
  );
  const gateByIdentity = new Map<string, GateSpec>();
  for (const gate of [...gateSpecs.gate_specs, ...entrySet.descendant_gate_specs]) {
    const identity = gateIdentity(gate);
    const existing = gateByIdentity.get(identity);
    if (existing !== undefined && !canonicalJsonBytes(existing).equals(canonicalJsonBytes(gate))) {
      notClosed('$.gate_specs', 'GateSpec identity has conflicting compiled contents');
    }
    gateByIdentity.set(identity, gate);
  }
  const gates = [...gateByIdentity.entries()]
    .sort(([left], [right]) => compareCanonicalStrings(left, right))
    .map(([, gate]) => gate);
  const resourceNodeIds = new Set(resourceGraph.resource_nodes.map((node) => node.node_id));
  if (gates.some((gate) => !resourceNodeIds.has(gate.source_node_id))) {
    notClosed('$.gate_specs', 'GateSpec source is absent from the recursive resource graph');
  }
  verifyAgentClosureApprovalCoverage(bindings, gates, resourceGraph);
  const draft = {
    schema_version: 'compiled-capability-closure/1' as const,
    root: source.root,
    assembly_pins: source.dependency_manifest.dependencies,
    bindings,
    gate_specs: gates,
    resource_nodes: resourceGraph.resource_nodes,
    dependency_edges: resourceGraph.dependency_edges,
    disabled_binding_paths: entrySet.disabled_binding_paths,
    aggregate_limits: entrySet.aggregate_limits,
  };
  return prepareCompiledCapabilityClosure({
    ...draft,
    closure_hash: canonicalSha256ExcludingRootKeys(draft, ['closure_hash']),
  });
}

/** Compatibility alias retained while callers migrate to the recursive assembler name. */
export const prepareNonRecursiveAgentCapabilityClosure = prepareAgentCapabilityClosure;
