import {
  CapabilityRequirementExpressionV1Schema,
  CanonicalBindingPathV1Schema,
  ClosureDependencyEdgeV1Schema,
  ClosureResourceNodeIdV1Schema,
  ClosureResourceNodeV1Schema,
  ClosureRootV1Schema,
  CompiledBindingEntryV1Schema,
  ContractHashSchema,
  EffectiveCapabilityPolicyV1Schema,
  PublishedResourcePinV1Schema,
} from '@better-agent/domain-contracts';

import type { PreparedAgentRootBindingEntrySetV1 } from './agent-root-binding-entry-set.js';
import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import {
  canonicalEmptyCapabilityRequirementExpression,
  normalizeCapabilityRequirementExpression,
} from './capability-policy.js';
import { canonicalJsonBytes } from './canonical-json.js';
import { canonicalBindingPath, canonicalResourceNodeId } from './closure-identity.js';
import {
  compareCanonicalStrings,
  deepFreezeJson,
  deriveDependencyManifest,
} from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import {
  preparePinnedDependencyGraph,
  type PreparedPinnedDependencyGraphV1,
} from './pinned-dependency-graph.js';

type ResourceNode = ReturnType<typeof ClosureResourceNodeV1Schema.parse>;
type DependencyEdge = ReturnType<typeof ClosureDependencyEdgeV1Schema.parse>;
type Pin = ReturnType<typeof PublishedResourcePinV1Schema.parse>;
const maximumClosureGraphEntries = 8_192;

export function withinRecursiveResourceGraphCapacity(
  bindingEdgeCount: number,
  typedSourcePathCounts: readonly number[],
): boolean {
  if (!Number.isSafeInteger(bindingEdgeCount) || bindingEdgeCount < 0) return false;
  let total = bindingEdgeCount;
  for (const count of typedSourcePathCounts) {
    if (!Number.isSafeInteger(count) || count < 0 || total > maximumClosureGraphEntries - count)
      return false;
    total += count;
  }
  return total <= maximumClosureGraphEntries;
}

export interface PreparedAgentRootResourceGraphV1 {
  readonly schema_version: 'prepared-agent-root-resource-graph/1';
  readonly graph_hash: `sha256:${string}`;
  readonly resource_nodes: readonly ResourceNode[];
  readonly dependency_edges: readonly DependencyEdge[];
}

function invalid(path: string, reason: string): never {
  throw new ReleaseCoreError('COMPILED_CAPABILITY_CLOSURE_INVALID', path, reason);
}

function graphMismatch(path: string): never {
  throw new ReleaseCoreError(
    'CAPABILITY_GRAPH_HASH_MISMATCH',
    path,
    'resource graph input is not the exact canonical pinned graph',
  );
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(path, 'expected a closed object');
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function owner(pin: Pin) {
  return {
    workspace_id: pin.workspace_id,
    published_resource_kind: pin.published_resource_kind,
    resource_id: pin.resource_id,
    resource_version_id: pin.resource_version_id,
  };
}

function parsePinnedGraph(input: unknown): PreparedPinnedDependencyGraphV1 {
  const snapshot = boundedDataSnapshot(input, 'graph');
  const value = record(snapshot, '$.graph');
  if (
    !exactKeys(value, [
      'schema_version',
      'root',
      'root_node_id',
      'nodes',
      'edges',
      'dependency_order',
      'graph_hash',
    ]) ||
    value.schema_version !== 'pinned-dependency-graph/1' ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges) ||
    !Array.isArray(value.dependency_order)
  ) {
    graphMismatch('$.graph');
  }
  const root = ClosureRootV1Schema.safeParse(value.root);
  const rootNodeId = ClosureResourceNodeIdV1Schema.safeParse(value.root_node_id);
  const graphHash = ContractHashSchema.safeParse(value.graph_hash);
  if (!root.success || !rootNodeId.success || !graphHash.success) graphMismatch('$.graph');

  const nodes = value.nodes.map((candidate, index) => {
    const node = record(candidate, `$.graph.nodes[${index}]`);
    if (!exactKeys(node, ['node_id', 'pin', 'dependency_manifest_hash'], ['nested_closure_hash'])) {
      graphMismatch(`$.graph.nodes[${index}]`);
    }
    const nodeId = ClosureResourceNodeIdV1Schema.safeParse(node.node_id);
    const pin = PublishedResourcePinV1Schema.safeParse(node.pin);
    const manifestHash = ContractHashSchema.safeParse(node.dependency_manifest_hash);
    const nestedHash =
      node.nested_closure_hash === undefined
        ? undefined
        : ContractHashSchema.safeParse(node.nested_closure_hash);
    if (!nodeId.success || !pin.success || !manifestHash.success || nestedHash?.success === false) {
      graphMismatch(`$.graph.nodes[${index}]`);
    }
    return {
      node_id: nodeId.data,
      pin: pin.data,
      dependency_manifest_hash: manifestHash.data,
      ...(nestedHash === undefined ? {} : { nested_closure_hash: nestedHash.data }),
    };
  });
  const byId = new Map(nodes.map((node) => [node.node_id, node]));
  const edges = value.edges.map((candidate, index) => {
    const edge = record(candidate, `$.graph.edges[${index}]`);
    if (!exactKeys(edge, ['from_node_id', 'to_node_id'])) graphMismatch('$.graph.edges');
    const from = ClosureResourceNodeIdV1Schema.safeParse(edge.from_node_id);
    const to = ClosureResourceNodeIdV1Schema.safeParse(edge.to_node_id);
    if (!from.success || !to.success || !byId.has(from.data) || !byId.has(to.data)) {
      graphMismatch('$.graph.edges');
    }
    return { from_node_id: from.data, to_node_id: to.data };
  });
  const dependencyOrder = value.dependency_order.map((candidate) => {
    const parsed = ClosureResourceNodeIdV1Schema.safeParse(candidate);
    if (!parsed.success) graphMismatch('$.graph.dependency_order');
    return parsed.data;
  });
  if (!byId.has(rootNodeId.data)) graphMismatch('$.graph.root_node_id');

  const dependenciesFor = (nodeId: string) =>
    edges
      .map((edge) => (edge.from_node_id === nodeId ? byId.get(edge.to_node_id)?.pin : undefined))
      .filter((pin): pin is Pin => pin !== undefined);
  const candidate = {
    schema_version: 'pinned-dependency-graph-candidate/1' as const,
    root: root.data,
    root_dependencies: dependenciesFor(rootNodeId.data),
    resources: nodes
      .filter((node) => node.node_id !== rootNodeId.data)
      .map((node) => ({
        schema_version: 'pinned-dependency-record/1' as const,
        pin: node.pin,
        publication_state: 'sealed' as const,
        dependency_manifest: deriveDependencyManifest(
          owner(node.pin),
          dependenciesFor(node.node_id),
        ),
        ...(node.nested_closure_hash === undefined
          ? {}
          : { nested_closure_hash: node.nested_closure_hash }),
      })),
  };
  let prepared: PreparedPinnedDependencyGraphV1;
  try {
    prepared = preparePinnedDependencyGraph(candidate);
  } catch {
    graphMismatch('$.graph');
  }
  if (
    prepared.graph_hash !== graphHash.data ||
    prepared.dependency_order.length !== dependencyOrder.length ||
    !canonicalJsonBytes(prepared).equals(canonicalJsonBytes(snapshot))
  ) {
    graphMismatch('$.graph');
  }
  return prepared;
}

function parseEntrySet(input: unknown): PreparedAgentRootBindingEntrySetV1 {
  const snapshot = boundedDataSnapshot(input, 'closure');
  const value = record(snapshot, '$.entry_set');
  if (
    !exactKeys(value, [
      'schema_version',
      'graph_hash',
      'root',
      'entries',
      'requirement_expressions',
      'disabled_binding_paths',
      'dependency_intrinsic_policies',
      'descendant_binding_entries',
      'intrinsic_policy',
      'aggregate_limits',
    ]) ||
    value.schema_version !== 'prepared-agent-root-binding-entry-set/1' ||
    !Array.isArray(value.entries) ||
    !Array.isArray(value.requirement_expressions) ||
    !Array.isArray(value.disabled_binding_paths) ||
    !Array.isArray(value.dependency_intrinsic_policies) ||
    !Array.isArray(value.descendant_binding_entries)
  ) {
    invalid('$.entry_set', 'entry set does not match its closed intermediate shape');
  }
  const graphHash = ContractHashSchema.safeParse(value.graph_hash);
  const root = ClosureRootV1Schema.safeParse(value.root);
  const aggregate = EffectiveCapabilityPolicyV1Schema.safeParse(value.aggregate_limits);
  const intrinsic = CapabilityRequirementExpressionV1Schema.safeParse(value.intrinsic_policy);
  if (!graphHash.success || !root.success || !aggregate.success || !intrinsic.success) {
    invalid('$.entry_set', 'entry set contains an invalid root policy identity');
  }
  const normalizedRootPolicy = normalizeCapabilityRequirementExpression(intrinsic.data);
  if (!canonicalJsonBytes(normalizedRootPolicy).equals(canonicalJsonBytes(intrinsic.data))) {
    invalid('$.entry_set.intrinsic_policy', 'root intrinsic policy is not canonical');
  }
  const entries = value.entries.map((candidate, index) => {
    const parsed = CompiledBindingEntryV1Schema.safeParse(candidate);
    if (!parsed.success) invalid(`$.entry_set.entries[${index}]`, 'invalid Binding entry');
    return parsed.data;
  });
  if (
    entries.some(
      (entry, index) => index > 0 && (entries[index - 1]?.binding_path ?? '') >= entry.binding_path,
    )
  ) {
    invalid('$.entry_set.entries', 'Binding entries must be sorted and unique');
  }
  const disabledBindingPaths = value.disabled_binding_paths.map((candidate, index) => {
    const parsed = CanonicalBindingPathV1Schema.safeParse(candidate);
    if (!parsed.success) {
      invalid(`$.entry_set.disabled_binding_paths[${index}]`, 'invalid disabled Binding path');
    }
    return parsed.data;
  });
  if (
    disabledBindingPaths.some(
      (path, index) => index > 0 && (disabledBindingPaths[index - 1] ?? '') >= path,
    )
  ) {
    invalid('$.entry_set.disabled_binding_paths', 'disabled paths must be sorted and unique');
  }
  const policies = value.dependency_intrinsic_policies.map((candidate, index) => {
    const path = `$.entry_set.dependency_intrinsic_policies[${index}]`;
    const evidence = record(candidate, path);
    if (
      !exactKeys(
        evidence,
        ['node_id', 'pin', 'intrinsic_policy'],
        ['dependency_manifest_hash', 'nested_closure_hash'],
      )
    ) {
      invalid(path, 'dependency policy evidence is not closed');
    }
    const pin = PublishedResourcePinV1Schema.safeParse(evidence.pin);
    const policy = CapabilityRequirementExpressionV1Schema.safeParse(evidence.intrinsic_policy);
    const manifestHash =
      evidence.dependency_manifest_hash === undefined
        ? undefined
        : ContractHashSchema.safeParse(evidence.dependency_manifest_hash);
    const nestedHash =
      evidence.nested_closure_hash === undefined
        ? undefined
        : ContractHashSchema.safeParse(evidence.nested_closure_hash);
    if (
      !pin.success ||
      !policy.success ||
      manifestHash?.success === false ||
      nestedHash?.success === false
    )
      invalid(path, 'dependency policy evidence is invalid');
    const nodeId = canonicalResourceNodeId(pin.data);
    const normalized = normalizeCapabilityRequirementExpression(policy.data);
    if (
      evidence.node_id !== nodeId ||
      !canonicalJsonBytes(normalized).equals(canonicalJsonBytes(policy.data))
    ) {
      invalid(path, 'dependency policy identity or canonical form does not match');
    }
    return {
      node_id: nodeId,
      pin: pin.data,
      intrinsic_policy: normalized,
      ...(manifestHash === undefined ? {} : { dependency_manifest_hash: manifestHash.data }),
      ...(nestedHash === undefined ? {} : { nested_closure_hash: nestedHash.data }),
    };
  });
  if (
    policies.some(
      (policy, index) => index > 0 && (policies[index - 1]?.node_id ?? '') >= policy.node_id,
    )
  ) {
    invalid(
      '$.entry_set.dependency_intrinsic_policies',
      'dependency policy identities must be sorted and unique',
    );
  }
  const descendantBindingEntries = value.descendant_binding_entries.map((candidate, index) => {
    const parsed = CompiledBindingEntryV1Schema.safeParse(candidate);
    if (!parsed.success) {
      invalid(`$.entry_set.descendant_binding_entries[${index}]`, 'invalid descendant Binding');
    }
    return parsed.data;
  });
  if (
    descendantBindingEntries.some(
      (entry, index) =>
        index > 0 &&
        (descendantBindingEntries[index - 1]?.binding_path ?? '') >= entry.binding_path,
    )
  ) {
    invalid(
      '$.entry_set.descendant_binding_entries',
      'descendant Bindings must be sorted and unique',
    );
  }
  if (
    descendantBindingEntries.some((entry) =>
      entries.some((rootEntry) => rootEntry.binding_path === entry.binding_path),
    )
  ) {
    invalid('$.entry_set.descendant_binding_entries', 'root and descendant paths must be disjoint');
  }
  return {
    ...(snapshot as PreparedAgentRootBindingEntrySetV1),
    graph_hash: graphHash.data as `sha256:${string}`,
    root: root.data as PreparedAgentRootBindingEntrySetV1['root'],
    entries,
    dependency_intrinsic_policies: policies,
    descendant_binding_entries: descendantBindingEntries,
    intrinsic_policy: normalizedRootPolicy,
    aggregate_limits: aggregate.data,
  };
}

/** Assemble direct and recursively projected resource facts from verified Binding provenance. */
export function prepareAgentRootResourceGraph(
  graphInput: unknown,
  entrySetInput: unknown,
): PreparedAgentRootResourceGraphV1 {
  const graph = parsePinnedGraph(graphInput);
  const entrySet = parseEntrySet(entrySetInput);
  if (
    graph.graph_hash !== entrySet.graph_hash ||
    !canonicalJsonBytes(graph.root).equals(canonicalJsonBytes(entrySet.root))
  ) {
    graphMismatch('$.entry_set.graph_hash');
  }
  const graphRoot = graph.nodes.find((node) => node.node_id === graph.root_node_id);
  if (
    graphRoot === undefined ||
    canonicalResourceNodeId(entrySet.root.pin) !== graph.root_node_id
  ) {
    graphMismatch('$.graph.root_node_id');
  }
  const dependencyGraphNodes = graph.nodes.filter((node) => node.node_id !== graph.root_node_id);
  const policiesByNode = new Map(
    entrySet.dependency_intrinsic_policies.map((evidence) => [evidence.node_id, evidence]),
  );
  if (policiesByNode.size !== entrySet.dependency_intrinsic_policies.length) {
    invalid(
      '$.entry_set.dependency_intrinsic_policies',
      'dependency policy node identities must be unique',
    );
  }
  const assemblyOnlyKinds = new Set(['INSTRUCTION_SKILL_RELEASE', 'AGENT_STRATEGY_RELEASE']);
  for (const node of dependencyGraphNodes) {
    if (
      !policiesByNode.has(node.node_id) &&
      assemblyOnlyKinds.has(node.pin.published_resource_kind)
    ) {
      policiesByNode.set(node.node_id, {
        node_id: canonicalResourceNodeId(node.pin),
        pin: node.pin,
        intrinsic_policy: canonicalEmptyCapabilityRequirementExpression(),
      });
    }
  }
  if (policiesByNode.size !== dependencyGraphNodes.length) {
    invalid(
      '$.entry_set.dependency_intrinsic_policies',
      'dependency policy coverage is incomplete',
    );
  }
  const resourceNodes: ResourceNode[] = [
    ClosureResourceNodeV1Schema.parse({
      node_id: graph.root_node_id,
      intrinsic_policy: entrySet.intrinsic_policy,
      dependency_manifest_hash: graphRoot.dependency_manifest_hash,
      node_role: 'root',
      pin: entrySet.root.pin,
    }),
  ];
  for (const node of dependencyGraphNodes) {
    const evidence = policiesByNode.get(node.node_id);
    if (
      evidence === undefined ||
      !canonicalJsonBytes(evidence.pin).equals(canonicalJsonBytes(node.pin)) ||
      (node.pin.published_resource_kind === 'AGENT_RELEASE' ||
      node.pin.published_resource_kind === 'FLOW_VERSION'
        ? evidence.dependency_manifest_hash !== node.dependency_manifest_hash ||
          evidence.nested_closure_hash !== node.nested_closure_hash
        : evidence.nested_closure_hash !== undefined ||
          (evidence.dependency_manifest_hash !== undefined &&
            evidence.dependency_manifest_hash !== node.dependency_manifest_hash))
    ) {
      invalid(
        '$.entry_set.dependency_intrinsic_policies',
        `dependency policy commitment does not match graph node ${node.node_id}: ${String(evidence?.dependency_manifest_hash)} / ${node.dependency_manifest_hash}; ${String(evidence?.nested_closure_hash)} / ${String(node.nested_closure_hash)}`,
      );
    }
    const parsed = ClosureResourceNodeV1Schema.safeParse({
      node_id: node.node_id,
      intrinsic_policy: evidence.intrinsic_policy,
      dependency_manifest_hash: node.dependency_manifest_hash,
      node_role: 'dependency',
      pin: node.pin,
      ...(node.nested_closure_hash === undefined
        ? {}
        : { nested_closure_hash: node.nested_closure_hash }),
    });
    if (!parsed.success)
      invalid('$.resource_nodes', 'dependency node does not match closure contract');
    resourceNodes.push(parsed.data);
  }
  resourceNodes.sort((left, right) => compareCanonicalStrings(left.node_id, right.node_id));

  const graphEdgeKeys = new Set(
    graph.edges.map((edge) => `${edge.from_node_id}\u0000${edge.to_node_id}`),
  );
  const allBindingEntries = [...entrySet.entries, ...entrySet.descendant_binding_entries];
  if (allBindingEntries.length > maximumClosureGraphEntries) {
    invalid('$.dependency_edges', 'Binding edge projection exceeds the closure limit');
  }
  const bindingEntryByPath = new Map(
    allBindingEntries.map((entry) => [entry.binding_path, entry] as const),
  );
  const dependencyEdges: DependencyEdge[] = [];
  for (const entry of entrySet.descendant_binding_entries) {
    const lastSegment = entry.binding_path_segments.at(-1);
    const targetNodeId = entry.dependency_node_ids[0];
    const ownerPin =
      lastSegment?.segment_kind === 'skill_pack_member'
        ? lastSegment.owner_pin
        : (lastSegment?.segment_kind === 'binding' || lastSegment?.segment_kind === 'flow_node') &&
            lastSegment.owner.owner_kind === 'published_dependency'
          ? lastSegment.owner.pin
          : undefined;
    let ownerEntry: (typeof allBindingEntries)[number] | undefined;
    for (let length = 1; length < entry.binding_path_segments.length; length += 1) {
      const prefixPath = canonicalBindingPath(entry.binding_path_segments.slice(0, length));
      ownerEntry = bindingEntryByPath.get(prefixPath) ?? ownerEntry;
    }
    if (
      ownerPin === undefined ||
      ownerEntry === undefined ||
      !canonicalJsonBytes(ownerPin).equals(canonicalJsonBytes(ownerEntry.target)) ||
      (lastSegment?.segment_kind === 'skill_pack_member' &&
        lastSegment.local_member_binding_id !== entry.binding_id) ||
      (lastSegment?.segment_kind === 'binding' &&
        lastSegment.local_binding_id !== entry.binding_id) ||
      canonicalBindingPath(entry.binding_path_segments) !== entry.binding_path ||
      entry.dependency_node_ids.length !== 1 ||
      targetNodeId === undefined ||
      targetNodeId !== canonicalResourceNodeId(entry.target)
    ) {
      invalid('$.dependency_edges', 'descendant Binding shape is unsupported');
    }
    const fromNodeId = canonicalResourceNodeId(ownerPin);
    if (!graphEdgeKeys.has(`${fromNodeId}\u0000${targetNodeId}`)) {
      invalid('$.dependency_edges', 'descendant Binding edge is absent from the pinned graph');
    }
    const parsed = ClosureDependencyEdgeV1Schema.safeParse({
      from_node_id: fromNodeId,
      to_node_id: targetNodeId,
      relation: 'binding_target',
      source_path: entry.binding_path,
    });
    if (!parsed.success) invalid('$.dependency_edges', 'descendant Binding edge is not canonical');
    dependencyEdges.push(parsed.data);
  }
  dependencyEdges.push(
    ...entrySet.entries.map((entry) => {
      const targetNodeId = entry.dependency_node_ids[0];
      if (
        entry.dependency_node_ids.length !== 1 ||
        targetNodeId === undefined ||
        !graphEdgeKeys.has(`${graph.root_node_id}\u0000${targetNodeId}`)
      ) {
        invalid('$.dependency_edges', 'root Binding does not match a direct pinned graph edge');
      }
      const parsed = ClosureDependencyEdgeV1Schema.safeParse({
        from_node_id: graph.root_node_id,
        to_node_id: targetNodeId,
        relation: 'binding_target',
        source_path: entry.binding_path,
      });
      if (!parsed.success) invalid('$.dependency_edges', 'Binding edge is not canonical');
      return parsed.data;
    }),
  );
  const rootSourcePath = canonicalBindingPath([{ segment_kind: 'root', pin: entrySet.root.pin }]);
  const sourcePathsByNode = new Map<string, Set<`bp1.${string}`>>([
    [graph.root_node_id, new Set([rootSourcePath])],
  ]);
  for (const entry of allBindingEntries) {
    const sourceNodeId = canonicalResourceNodeId(entry.target);
    const sourcePath =
      entry.target.published_resource_kind === 'AGENT_RELEASE'
        ? canonicalBindingPath([
            ...entry.binding_path_segments,
            { segment_kind: 'subagent_target', target_pin: entry.target },
          ])
        : (entry.binding_path as `bp1.${string}`);
    const paths = sourcePathsByNode.get(sourceNodeId) ?? new Set<`bp1.${string}`>();
    paths.add(sourcePath);
    sourcePathsByNode.set(sourceNodeId, paths);
  }
  const typedSourcePathCounts: number[] = [];
  for (const edge of graph.edges) {
    if (
      dependencyEdges.some(
        (candidate) =>
          candidate.from_node_id === edge.from_node_id && candidate.to_node_id === edge.to_node_id,
      )
    )
      continue;
    typedSourcePathCounts.push(sourcePathsByNode.get(edge.from_node_id)?.size ?? 0);
  }
  if (!withinRecursiveResourceGraphCapacity(dependencyEdges.length, typedSourcePathCounts)) {
    invalid('$.dependency_edges', 'recursive edge projection exceeds the closure limit');
  }
  for (const edge of graph.edges) {
    if (
      dependencyEdges.some(
        (candidate) =>
          candidate.from_node_id === edge.from_node_id && candidate.to_node_id === edge.to_node_id,
      )
    )
      continue;
    const target = graph.nodes.find((node) => node.node_id === edge.to_node_id);
    const sourcePaths = sourcePathsByNode.get(edge.from_node_id);
    if (
      target === undefined ||
      !assemblyOnlyKinds.has(target.pin.published_resource_kind) ||
      sourcePaths === undefined ||
      sourcePaths.size === 0
    ) {
      invalid('$.dependency_edges', 'capability graph edge has no Binding provenance');
    }
    for (const sourcePath of sourcePaths) {
      dependencyEdges.push(
        ClosureDependencyEdgeV1Schema.parse({
          from_node_id: edge.from_node_id,
          to_node_id: edge.to_node_id,
          relation: 'typed_internal_dependency',
          source_path: sourcePath,
        }),
      );
    }
  }
  dependencyEdges.sort(
    (left, right) =>
      compareCanonicalStrings(left.from_node_id, right.from_node_id) ||
      compareCanonicalStrings(left.to_node_id, right.to_node_id) ||
      compareCanonicalStrings(left.relation, right.relation) ||
      compareCanonicalStrings(left.source_path, right.source_path),
  );
  return deepFreezeJson({
    schema_version: 'prepared-agent-root-resource-graph/1',
    graph_hash: graph.graph_hash,
    resource_nodes: resourceNodes,
    dependency_edges: dependencyEdges,
  });
}
