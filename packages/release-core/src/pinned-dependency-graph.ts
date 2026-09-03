import {
  ClosureRootV1Schema,
  type PublishedResourcePinV1,
  Sha256HexV1Schema,
} from '@better-agent/domain-contracts';

import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import { canonicalJsonBytes } from './canonical-json.js';
import { createClosureIdentityRegistry, type ClosureResourceNodeIdV1 } from './closure-identity.js';
import {
  compareCanonicalStrings,
  deepFreezeJson,
  deriveDependencyManifest,
  normalizeDependencyPins,
  parseStrictPublishedResourcePin,
  publishedResourcePinKey,
} from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { canonicalSha256 } from './hash.js';

type Pin = PublishedResourcePinV1;
type Root = ReturnType<typeof ClosureRootV1Schema.parse>;
type GraphError =
  | 'CAPABILITY_GRAPH_INPUT_INVALID'
  | 'CAPABILITY_GRAPH_HASH_MISMATCH'
  | 'CAPABILITY_DEPENDENCY_UNRESOLVED'
  | 'CAPABILITY_DEPENDENCY_CYCLE'
  | 'CAPABILITY_CLOSURE_LIMIT_EXCEEDED';
const maximumNodes = 256;
const maximumEdges = 1_024;
const maximumDepth = 32;
const maximumBytes = 8_388_608;

export interface PinnedDependencyGraphNodeV1 {
  readonly node_id: ClosureResourceNodeIdV1;
  readonly pin: Pin;
  readonly dependency_manifest_hash: string;
  readonly nested_closure_hash?: string;
}
export interface PreparedPinnedDependencyGraphV1 {
  readonly schema_version: 'pinned-dependency-graph/1';
  readonly root: Root;
  readonly root_node_id: ClosureResourceNodeIdV1;
  readonly nodes: readonly PinnedDependencyGraphNodeV1[];
  readonly edges: readonly {
    readonly from_node_id: ClosureResourceNodeIdV1;
    readonly to_node_id: ClosureResourceNodeIdV1;
  }[];
  readonly dependency_order: readonly ClosureResourceNodeIdV1[];
  readonly graph_hash: `sha256:${string}`;
}
interface ParsedRecord {
  pin: Pin;
  dependencies: readonly Pin[];
  manifestHash: string;
  nestedClosureHash?: string;
}

function fail(code: GraphError, path: string, reason: string): never {
  throw new ReleaseCoreError(code, path, reason);
}
function invalid(path: string): never {
  fail('CAPABILITY_GRAPH_INPUT_INVALID', path, 'graph input does not match the closed contract');
}
function unresolved(path: string): never {
  fail(
    'CAPABILITY_DEPENDENCY_UNRESOLVED',
    path,
    'pinned resource snapshot is incomplete or inconsistent',
  );
}
function limit(path: string): never {
  fail(
    'CAPABILITY_CLOSURE_LIMIT_EXCEEDED',
    path,
    'pinned dependency graph exceeds an absolute budget',
  );
}

function object(
  input: unknown,
  required: string[],
  optional: string[] = [],
  path = '$',
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalid(path);
  const value = input as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  )
    invalid(path);
  return value;
}
function array(input: unknown, path: string): unknown[] {
  if (!Array.isArray(input)) invalid(path);
  return input;
}
function hash(input: unknown, path: string): string {
  if (
    typeof input !== 'string' ||
    input.length !== 71 ||
    !Sha256HexV1Schema.safeParse(input).success
  )
    unresolved(path);
  return input;
}
function strictPin(input: unknown, path: string): Pin {
  try {
    const value = parseStrictPublishedResourcePin(input, path);
    for (const id of [value.workspace_id, value.resource_id, value.resource_version_id])
      if (id !== id.toLowerCase()) unresolved(path);
    hash(value.contract_hash, path);
    return value;
  } catch {
    // Do not echo foreign resource identities, payloads, or lower-layer parser diagnostics.
    unresolved(path);
  }
}
function versionKey(value: Pin): string {
  return JSON.stringify([
    value.workspace_id,
    value.published_resource_kind,
    value.resource_id,
    value.resource_version_id,
  ]);
}
function owner(value: Pin) {
  return {
    workspace_id: value.workspace_id,
    published_resource_kind: value.published_resource_kind,
    resource_id: value.resource_id,
    resource_version_id: value.resource_version_id,
  };
}
function dependencies(input: unknown, workspace: string, path: string): readonly Pin[] {
  const values = array(input, path).map((value) => strictPin(value, path));
  try {
    return normalizeDependencyPins(workspace, values);
  } catch {
    unresolved(path);
  }
}

function parseRecord(input: unknown, workspace: string): ParsedRecord {
  const path = '$.resources';
  const value = object(
    input,
    ['schema_version', 'pin', 'publication_state', 'dependency_manifest'],
    ['nested_closure_hash'],
    path,
  );
  if (value.schema_version !== 'pinned-dependency-record/1' || value.publication_state !== 'sealed')
    unresolved(path);
  const pin = strictPin(value.pin, path);
  if (pin.workspace_id !== workspace) unresolved(path);
  const manifest = object(
    value.dependency_manifest,
    ['schema_version', 'owner', 'dependencies', 'manifest_hash'],
    [],
    path,
  );
  if (manifest.schema_version !== 'published-resource-dependency-manifest/1') unresolved(path);
  if (!canonicalJsonBytes(manifest.owner).equals(canonicalJsonBytes(owner(pin)))) unresolved(path);
  const pins = dependencies(manifest.dependencies, workspace, path);
  const expected = deriveDependencyManifest(owner(pin), pins);
  if (hash(manifest.manifest_hash, path) !== expected.manifest_hash) unresolved(path);
  const needsNested =
    pin.published_resource_kind === 'AGENT_RELEASE' ||
    pin.published_resource_kind === 'FLOW_VERSION';
  if (needsNested !== Object.hasOwn(value, 'nested_closure_hash')) unresolved(path);
  return {
    pin,
    dependencies: pins,
    manifestHash: expected.manifest_hash,
    ...(needsNested ? { nestedClosureHash: hash(value.nested_closure_hash, path) } : {}),
  };
}

function bounded(input: unknown): unknown {
  const value = boundedDataSnapshot(input, 'graph');
  if (canonicalJsonBytes(value).length > maximumBytes) limit('$');
  return value;
}

/**
 * A deterministic manifest graph, NOT a published closure or proof of registry provenance.
 * The caller must obtain exact records from the authoritative snapshot in the publish transaction.
 */
export function preparePinnedDependencyGraph(input: unknown): PreparedPinnedDependencyGraphV1 {
  const candidate = object(bounded(input), [
    'schema_version',
    'root',
    'root_dependencies',
    'resources',
  ]);
  if (candidate.schema_version !== 'pinned-dependency-graph-candidate/1')
    invalid('$.schema_version');
  const parsedRoot = ClosureRootV1Schema.safeParse(candidate.root);
  if (!parsedRoot.success) invalid('$.root');
  const root = parsedRoot.data;
  strictPin(root.pin, '$.root');
  const values = array(candidate.resources, '$.resources');
  if (values.length + 1 > maximumNodes) limit('$.resources');
  const rootDependencies = dependencies(
    candidate.root_dependencies,
    root.pin.workspace_id,
    '$.root_dependencies',
  );
  const records: ParsedRecord[] = [
    {
      pin: root.pin,
      dependencies: rootDependencies,
      manifestHash: deriveDependencyManifest(owner(root.pin), rootDependencies).manifest_hash,
    },
    ...values.map((value) => parseRecord(value, root.pin.workspace_id)),
  ];
  const byVersion = new Map<string, ParsedRecord>();
  const byPin = new Map<string, ParsedRecord>();
  for (const record of records) {
    const key = versionKey(record.pin);
    if (byVersion.has(key)) unresolved('$.resources');
    byVersion.set(key, record);
    byPin.set(publishedResourcePinKey(record.pin), record);
  }
  const identities = createClosureIdentityRegistry();
  const nodeIds = new Map<string, ClosureResourceNodeIdV1>();
  const nodes = records
    .map((record): PinnedDependencyGraphNodeV1 => {
      const nodeId = identities.registerResourceNode(record.pin);
      nodeIds.set(publishedResourcePinKey(record.pin), nodeId);
      return {
        node_id: nodeId,
        pin: record.pin,
        dependency_manifest_hash: record.manifestHash,
        ...(record.nestedClosureHash === undefined
          ? {}
          : { nested_closure_hash: record.nestedClosureHash }),
      };
    })
    .sort((a, b) => compareCanonicalStrings(a.node_id, b.node_id));
  function nodeId(pin: Pin): ClosureResourceNodeIdV1 {
    const id = nodeIds.get(publishedResourcePinKey(pin));
    if (id === undefined) unresolved('$.resources');
    return id;
  }
  const rootId = nodeId(root.pin);
  const adjacency = new Map(nodes.map((node) => [node.node_id, [] as ClosureResourceNodeIdV1[]]));
  const edges: { from_node_id: ClosureResourceNodeIdV1; to_node_id: ClosureResourceNodeIdV1 }[] =
    [];
  for (const record of records) {
    const from = nodeId(record.pin);
    for (const dependency of record.dependencies) {
      if (versionKey(dependency) === versionKey(root.pin))
        fail('CAPABILITY_DEPENDENCY_CYCLE', '$.root', 'dependency returns to the root version');
      if (!byPin.has(publishedResourcePinKey(dependency))) unresolved('$.resources');
      const to = nodeId(dependency);
      adjacency.get(from)?.push(to);
      edges.push({ from_node_id: from, to_node_id: to });
      if (edges.length > maximumEdges) limit('$.edges');
    }
  }
  edges.sort(
    (a, b) =>
      compareCanonicalStrings(a.from_node_id, b.from_node_id) ||
      compareCanonicalStrings(a.to_node_id, b.to_node_id),
  );
  for (const targets of adjacency.values()) targets.sort(compareCanonicalStrings);
  const dependencyOrder: ClosureResourceNodeIdV1[] = [];
  const heights = new Map<ClosureResourceNodeIdV1, number>();
  const active = new Set<ClosureResourceNodeIdV1>();
  function visit(id: ClosureResourceNodeIdV1): number {
    if (active.has(id))
      fail(
        'CAPABILITY_DEPENDENCY_CYCLE',
        '$.resources',
        'dependency graph contains a version cycle',
      );
    const known = heights.get(id);
    if (known !== undefined) return known;
    active.add(id);
    let height = 0;
    for (const target of adjacency.get(id) ?? []) height = Math.max(height, 1 + visit(target));
    active.delete(id);
    if (height > maximumDepth) limit('$.dependency_order');
    heights.set(id, height);
    dependencyOrder.push(id);
    return height;
  }
  visit(rootId);
  if (heights.size !== nodes.length) unresolved('$.resources');
  const content = {
    schema_version: 'pinned-dependency-graph/1' as const,
    root,
    root_node_id: rootId,
    nodes,
    edges,
    dependency_order: dependencyOrder,
  };
  const result = { ...content, graph_hash: canonicalSha256(content) };
  bounded(result);
  return deepFreezeJson(result);
}

/** Verify complete stored bytes against the exact source snapshot, not a caller's claimed hash. */
export function verifyPinnedDependencyGraph(
  expected: unknown,
  candidate: unknown,
): PreparedPinnedDependencyGraphV1 {
  const snapshot = bounded(expected);
  const actual = preparePinnedDependencyGraph(candidate);
  if (!canonicalJsonBytes(snapshot).equals(canonicalJsonBytes(actual)))
    fail(
      'CAPABILITY_GRAPH_HASH_MISMATCH',
      '$',
      'stored graph differs from its recomputed canonical artifact',
    );
  return actual;
}
