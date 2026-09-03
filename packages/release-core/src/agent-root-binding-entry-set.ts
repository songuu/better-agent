import {
  type CapabilityBindingV1,
  type CapabilityRequirementExpressionV1,
  BindingPathSegmentV1Schema,
  CanonicalBindingPathV1Schema,
  CompiledBindingEntryV1Schema,
  CompiledGateSpecEntryV1Schema,
  type CompiledCapabilityClosureV1,
  ClosureResourceNodeV1Schema,
  ContractHashSchema,
  type EffectiveCapabilityPolicyV1,
  PublishedResourcePinV1Schema,
} from '@better-agent/domain-contracts';

import { parseAgentBindingPolicyInput } from './agent-binding-policy.js';
import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import {
  canonicalEmptyCapabilityRequirementExpression,
  compileCapabilityRequirementEnvelope,
  meetCapabilityPolicyCeilings,
  normalizeCapabilityRequirementExpression,
  resolveEffectiveCapabilityPolicy,
} from './capability-policy.js';
import { canonicalJsonBytes } from './canonical-json.js';
import { canonicalBindingPath, canonicalResourceNodeId } from './closure-identity.js';
import { prepareNestedCapabilityDependency } from './compiled-capability-closure.js';
import { compareCanonicalStrings, deepFreezeJson } from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { prepareExecutableSource } from './executable-source.js';
import { canonicalSha256 } from './hash.js';
import { projectNestedGateSpecs } from './nested-gate-spec-projection.js';
import { prepareRootBindingPaths } from './root-binding-paths.js';
import {
  bindingAdmissionEvidence,
  verifyProjectedBindingAdmission,
} from './required-binding-call.js';

type CompiledBindingEntryV1 = ReturnType<typeof CompiledBindingEntryV1Schema.parse>;
type CompiledGateSpecEntryV1 = ReturnType<typeof CompiledGateSpecEntryV1Schema.parse>;

interface RequirementExpressionByPath {
  readonly binding_path: `bp1.${string}`;
  readonly expression: CapabilityRequirementExpressionV1;
}

export interface DependencyIntrinsicPolicyEvidence {
  readonly node_id: ReturnType<typeof canonicalResourceNodeId>;
  readonly pin: ReturnType<typeof PublishedResourcePinV1Schema.parse>;
  readonly intrinsic_policy: CapabilityRequirementExpressionV1;
  readonly dependency_manifest_hash?: string;
  readonly nested_closure_hash?: string;
}

export function mergeDependencyIntrinsicPolicyEvidence(
  existing: DependencyIntrinsicPolicyEvidence | undefined,
  evidence: DependencyIntrinsicPolicyEvidence,
): DependencyIntrinsicPolicyEvidence {
  if (existing === undefined) return evidence;
  if (
    !canonicalJsonBytes({
      node_id: existing.node_id,
      pin: existing.pin,
      intrinsic_policy: existing.intrinsic_policy,
    }).equals(
      canonicalJsonBytes({
        node_id: evidence.node_id,
        pin: evidence.pin,
        intrinsic_policy: evidence.intrinsic_policy,
      }),
    ) ||
    (existing.dependency_manifest_hash !== undefined &&
      evidence.dependency_manifest_hash !== undefined &&
      existing.dependency_manifest_hash !== evidence.dependency_manifest_hash) ||
    (existing.nested_closure_hash !== undefined &&
      evidence.nested_closure_hash !== undefined &&
      existing.nested_closure_hash !== evidence.nested_closure_hash)
  ) {
    notClosed('$.dependency_intrinsic_policies');
  }
  const dependencyManifestHash =
    existing.dependency_manifest_hash ?? evidence.dependency_manifest_hash;
  const nestedClosureHash = existing.nested_closure_hash ?? evidence.nested_closure_hash;
  return {
    ...evidence,
    ...(dependencyManifestHash === undefined
      ? {}
      : { dependency_manifest_hash: dependencyManifestHash }),
    ...(nestedClosureHash === undefined ? {} : { nested_closure_hash: nestedClosureHash }),
  };
}

interface ParsedSlice {
  readonly graph_hash: `sha256:${string}`;
  readonly entries: readonly CompiledBindingEntryV1[];
  readonly requirement_expressions: readonly RequirementExpressionByPath[];
  readonly dependency_intrinsic_policies: readonly DependencyIntrinsicPolicyEvidence[];
  readonly descendant_binding_entries: readonly CompiledBindingEntryV1[];
  readonly descendant_disabled_binding_paths: readonly `bp1.${string}`[];
  readonly descendant_gate_specs: readonly CompiledGateSpecEntryV1[];
  readonly nested_gate_closures: readonly NestedGateClosureEvidenceV1[];
  readonly root?: unknown;
}

export interface NestedGateClosureEvidenceV1 {
  readonly source_node_id: string;
  readonly nested_closure_hash: string;
  readonly nested_closure: CompiledCapabilityClosureV1;
}

export interface PreparedAgentRootBindingEntrySetV1 {
  readonly schema_version: 'prepared-agent-root-binding-entry-set/1';
  readonly graph_hash: `sha256:${string}`;
  readonly root: ReturnType<typeof prepareExecutableSource>['root'];
  readonly entries: readonly CompiledBindingEntryV1[];
  readonly requirement_expressions: readonly RequirementExpressionByPath[];
  readonly disabled_binding_paths: readonly `bp1.${string}`[];
  readonly dependency_intrinsic_policies: readonly DependencyIntrinsicPolicyEvidence[];
  readonly descendant_binding_entries: readonly CompiledBindingEntryV1[];
  readonly descendant_gate_specs: readonly CompiledGateSpecEntryV1[];
  readonly nested_gate_closures: readonly NestedGateClosureEvidenceV1[];
  readonly intrinsic_policy: CapabilityRequirementExpressionV1;
  readonly aggregate_limits: EffectiveCapabilityPolicyV1;
}

function notClosed(path: string): never {
  throw new ReleaseCoreError(
    'CLOSURE_BINDING_ENTRY_NOT_CLOSED',
    path,
    'root Binding slices do not form one exact Agent entry set',
  );
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) notClosed(path);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  optional: readonly string[] = [],
): void {
  const actual = Object.keys(value).sort();
  const allowed = new Set([...keys, ...optional]);
  if (!keys.every((key) => Object.hasOwn(value, key)) || actual.some((key) => !allowed.has(key)))
    notClosed(path);
}

function parseEntries(
  value: unknown,
  accepts: (entry: CompiledBindingEntryV1) => boolean,
  path: string,
  allowEmpty = false,
  maxCount = 128,
): CompiledBindingEntryV1[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > maxCount)
    notClosed(path);
  const entries = value.map((candidate, index) => {
    const parsed = CompiledBindingEntryV1Schema.safeParse(candidate);
    if (!parsed.success || !accepts(parsed.data)) notClosed(`${path}[${index}]`);
    return parsed.data;
  });
  if (
    entries.some(
      (entry, index) => index > 0 && (entries[index - 1]?.binding_path ?? '') >= entry.binding_path,
    )
  )
    notClosed(path);
  return entries;
}

function parseExpressions(value: unknown, path: string): RequirementExpressionByPath[] {
  if (!Array.isArray(value) || value.length > 128) notClosed(path);
  const expressions = value.map((candidate, index) => {
    const item = record(candidate, `${path}[${index}]`);
    exactKeys(item, ['binding_path', 'expression'], `${path}[${index}]`);
    if (typeof item.binding_path !== 'string' || !item.binding_path.startsWith('bp1.')) {
      notClosed(`${path}[${index}].binding_path`);
    }
    const expression = normalizeCapabilityRequirementExpression(item.expression);
    if (!canonicalJsonBytes(expression).equals(canonicalJsonBytes(item.expression))) {
      notClosed(`${path}[${index}].expression`);
    }
    return {
      binding_path: item.binding_path as `bp1.${string}`,
      expression,
    };
  });
  if (
    expressions.some(
      (item, index) =>
        index > 0 && (expressions[index - 1]?.binding_path ?? '') >= item.binding_path,
    )
  )
    notClosed(path);
  return expressions;
}

function parseCanonicalPaths(value: unknown, path: string, maxCount = 256): `bp1.${string}`[] {
  if (!Array.isArray(value) || value.length > maxCount) notClosed(path);
  const paths = value.map((candidate, index) => {
    const parsed = CanonicalBindingPathV1Schema.safeParse(candidate);
    if (!parsed.success) notClosed(`${path}[${index}]`);
    return parsed.data as `bp1.${string}`;
  });
  if (paths.some((item, index) => index > 0 && (paths[index - 1] ?? '') >= item)) {
    notClosed(path);
  }
  return paths;
}

function gateIdentity(gate: CompiledGateSpecEntryV1): string {
  return `${gate.source_node_id}\u0000${gate.source_kind === 'flow_node' ? gate.source_binding_path : ''}\u0000${gate.gate_spec_id}`;
}

function parseGateSpecs(value: unknown, path: string): CompiledGateSpecEntryV1[] {
  if (!Array.isArray(value) || value.length > 8_192) notClosed(path);
  const gates = value.map((candidate, index) => {
    const parsed = CompiledGateSpecEntryV1Schema.safeParse(candidate);
    if (!parsed.success) notClosed(`${path}[${index}]`);
    if (
      parsed.data.source_kind === 'flow_node' &&
      canonicalBindingPath(parsed.data.source_binding_path_segments) !==
        parsed.data.source_binding_path
    ) {
      notClosed(`${path}[${index}].source_binding_path`);
    }
    return parsed.data;
  });
  if (
    gates.some((gate, index) => {
      const previous = gates[index - 1];
      return previous !== undefined && gateIdentity(previous) >= gateIdentity(gate);
    })
  ) {
    notClosed(path);
  }
  return gates;
}

function parseDependencyIntrinsicPolicies(
  value: unknown,
  accepts: (
    kind: ReturnType<typeof PublishedResourcePinV1Schema.parse>['published_resource_kind'],
  ) => boolean,
  path: string,
): DependencyIntrinsicPolicyEvidence[] {
  if (!Array.isArray(value) || value.length > 256) notClosed(path);
  const policies = value.map((candidate, index) => {
    const itemPath = `${path}[${index}]`;
    const item = record(candidate, itemPath);
    exactKeys(item, ['node_id', 'pin', 'intrinsic_policy'], itemPath, [
      'dependency_manifest_hash',
      'nested_closure_hash',
    ]);
    const pin = PublishedResourcePinV1Schema.safeParse(item.pin);
    if (!pin.success || !accepts(pin.data.published_resource_kind)) notClosed(`${itemPath}.pin`);
    const nodeId = canonicalResourceNodeId(pin.data);
    if (item.node_id !== nodeId) notClosed(`${itemPath}.node_id`);
    const intrinsicPolicy = normalizeCapabilityRequirementExpression(item.intrinsic_policy);
    if (!canonicalJsonBytes(intrinsicPolicy).equals(canonicalJsonBytes(item.intrinsic_policy))) {
      notClosed(`${itemPath}.intrinsic_policy`);
    }
    const dependencyManifestHash =
      item.dependency_manifest_hash === undefined
        ? undefined
        : ContractHashSchema.safeParse(item.dependency_manifest_hash);
    const nestedClosureHash =
      item.nested_closure_hash === undefined
        ? undefined
        : ContractHashSchema.safeParse(item.nested_closure_hash);
    if (dependencyManifestHash?.success === false || nestedClosureHash?.success === false) {
      notClosed(itemPath);
    }
    return {
      node_id: nodeId,
      pin: pin.data,
      intrinsic_policy: intrinsicPolicy,
      ...(dependencyManifestHash === undefined
        ? {}
        : { dependency_manifest_hash: dependencyManifestHash.data }),
      ...(nestedClosureHash === undefined ? {} : { nested_closure_hash: nestedClosureHash.data }),
    };
  });
  if (
    policies.some(
      (item, index) => index > 0 && (policies[index - 1]?.node_id ?? '') >= item.node_id,
    )
  )
    notClosed(path);
  return policies;
}

function parseDependencyResourceNodes(value: unknown, path: string) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8_192) notClosed(path);
  const nodes = value.map((candidate, index) => {
    const parsed = ClosureResourceNodeV1Schema.safeParse(candidate);
    if (
      !parsed.success ||
      parsed.data.node_role !== 'dependency' ||
      parsed.data.node_id !== canonicalResourceNodeId(parsed.data.pin)
    ) {
      notClosed(`${path}[${index}]`);
    }
    return parsed.data;
  });
  if (nodes.some((node, index) => index > 0 && (nodes[index - 1]?.node_id ?? '') >= node.node_id)) {
    notClosed(path);
  }
  return nodes;
}

function parseSlice(input: unknown, index: number): ParsedSlice {
  const path = `$.slices[${index}]`;
  const slice = record(input, path);
  const graphHash = ContractHashSchema.safeParse(slice.graph_hash);
  if (!graphHash.success) notClosed(`${path}.graph_hash`);
  const canonicalGraphHash = graphHash.data as `sha256:${string}`;
  if (slice.schema_version === 'graph-bound-agent-leaf-binding-entry-set/1') {
    exactKeys(slice, ['schema_version', 'graph_hash', 'prepared_entries'], path);
    const prepared = record(slice.prepared_entries, `${path}.prepared_entries`);
    exactKeys(
      prepared,
      [
        'schema_version',
        'root',
        'dependencies',
        'dependency_intrinsic_policies',
        'entries',
        'requirement_expressions',
      ],
      `${path}.prepared_entries`,
    );
    if (prepared.schema_version !== 'prepared-agent-leaf-binding-entry-set/1') notClosed(path);
    return {
      graph_hash: canonicalGraphHash,
      root: prepared.root,
      entries: parseEntries(
        prepared.entries,
        (entry) =>
          entry.binding_kind === 'knowledge' ||
          entry.binding_kind === 'database' ||
          entry.binding_kind === 'plugin' ||
          (entry.binding_kind === 'subagent' &&
            entry.target.published_resource_kind === 'A2A_AGENT_RELEASE'),
        `${path}.prepared_entries.entries`,
      ),
      requirement_expressions: parseExpressions(
        prepared.requirement_expressions,
        `${path}.prepared_entries.requirement_expressions`,
      ),
      dependency_intrinsic_policies: parseDependencyIntrinsicPolicies(
        prepared.dependency_intrinsic_policies,
        (kind) =>
          kind === 'KNOWLEDGE_INDEX_GENERATION' ||
          kind === 'DATABASE_OPERATION_RELEASE' ||
          kind === 'PLUGIN_TOOL_RELEASE' ||
          kind === 'A2A_AGENT_RELEASE',
        `${path}.prepared_entries.dependency_intrinsic_policies`,
      ),
      descendant_binding_entries: [],
      descendant_disabled_binding_paths: [],
      descendant_gate_specs: [],
      nested_gate_closures: [],
    };
  }
  if (slice.schema_version === 'graph-bound-skill-pack-leaf-binding-entry-set/1') {
    exactKeys(slice, ['schema_version', 'graph_hash', 'prepared_entries'], path);
    const prepared = record(slice.prepared_entries, `${path}.prepared_entries`);
    exactKeys(
      prepared,
      [
        'schema_version',
        'root',
        'pack_dependency',
        'leaf_dependencies',
        'leaf_dependency_intrinsic_policies',
        'pack_entries',
        'pack_requirement_expressions',
        'entries',
        'policy_disabled_binding_paths',
      ],
      `${path}.prepared_entries`,
      ['pack_dependency_intrinsic_policy'],
    );
    if (prepared.schema_version !== 'prepared-skill-pack-leaf-binding-entry-set/1') notClosed(path);
    const packPin = PublishedResourcePinV1Schema.safeParse(prepared.pack_dependency);
    if (!packPin.success || packPin.data.published_resource_kind !== 'SKILL_PACK_RELEASE') {
      notClosed(`${path}.prepared_entries.pack_dependency`);
    }
    const memberEntries = parseEntries(
      prepared.entries,
      (entry) =>
        entry.binding_kind === 'knowledge' ||
        entry.binding_kind === 'database' ||
        entry.binding_kind === 'plugin' ||
        (entry.binding_kind === 'subagent' &&
          entry.target.published_resource_kind === 'A2A_AGENT_RELEASE'),
      `${path}.prepared_entries.entries`,
    );
    const packEntries = parseEntries(
      prepared.pack_entries,
      (entry) => entry.binding_kind === 'skill_pack',
      `${path}.prepared_entries.pack_entries`,
    );
    memberEntries.forEach((entry, entryIndex) => {
      const lastSegment = entry.binding_path_segments.at(-1);
      if (
        lastSegment?.segment_kind !== 'skill_pack_member' ||
        lastSegment.local_member_binding_id !== entry.binding_id ||
        !canonicalJsonBytes(lastSegment.owner_pin).equals(canonicalJsonBytes(packPin.data)) ||
        canonicalBindingPath(entry.binding_path_segments) !== entry.binding_path ||
        entry.dependency_node_ids.length !== 1 ||
        entry.dependency_node_ids[0] !== canonicalResourceNodeId(entry.target)
      ) {
        notClosed(`${path}.prepared_entries.entries[${entryIndex}]`);
      }
    });
    const packPolicies =
      prepared.pack_dependency_intrinsic_policy === undefined
        ? []
        : parseDependencyIntrinsicPolicies(
            [prepared.pack_dependency_intrinsic_policy],
            (kind) => kind === 'SKILL_PACK_RELEASE',
            `${path}.prepared_entries.pack_dependency_intrinsic_policy`,
          );
    const descendantDisabledBindingPaths = parseCanonicalPaths(
      prepared.policy_disabled_binding_paths,
      `${path}.prepared_entries.policy_disabled_binding_paths`,
    );
    const compiledPaths = new Set(
      [...packEntries, ...memberEntries].map((entry) => entry.binding_path),
    );
    if (descendantDisabledBindingPaths.some((bindingPath) => !compiledPaths.has(bindingPath))) {
      notClosed(`${path}.prepared_entries.policy_disabled_binding_paths`);
    }
    return {
      graph_hash: canonicalGraphHash,
      root: prepared.root,
      entries: packEntries,
      requirement_expressions: parseExpressions(
        prepared.pack_requirement_expressions,
        `${path}.prepared_entries.pack_requirement_expressions`,
      ),
      dependency_intrinsic_policies: [
        ...packPolicies,
        ...parseDependencyIntrinsicPolicies(
          prepared.leaf_dependency_intrinsic_policies,
          (kind) =>
            kind === 'KNOWLEDGE_INDEX_GENERATION' ||
            kind === 'DATABASE_OPERATION_RELEASE' ||
            kind === 'PLUGIN_TOOL_RELEASE' ||
            kind === 'A2A_AGENT_RELEASE',
          `${path}.prepared_entries.leaf_dependency_intrinsic_policies`,
        ),
      ].sort((left, right) => compareCanonicalStrings(left.node_id, right.node_id)),
      descendant_binding_entries: memberEntries,
      descendant_disabled_binding_paths: descendantDisabledBindingPaths,
      descendant_gate_specs: [],
      nested_gate_closures: [],
    };
  }
  if (slice.schema_version === 'prepared-agent-composite-binding-entries/1') {
    exactKeys(
      slice,
      [
        'schema_version',
        'dependency_kind',
        'graph_hash',
        'nested_closure_hash',
        'nested_closure',
        'dependency_resource_node',
        'dependency_resource_nodes',
        'entries',
        'descendant_binding_entries',
        'descendant_disabled_binding_paths',
        'descendant_gate_specs',
        'requirement_expressions',
      ],
      path,
    );
    const dependencyKind = slice.dependency_kind;
    if (dependencyKind !== 'FLOW_VERSION' && dependencyKind !== 'AGENT_RELEASE') notClosed(path);
    const dependencyNode = ClosureResourceNodeV1Schema.safeParse(slice.dependency_resource_node);
    const nestedClosureHash = ContractHashSchema.safeParse(slice.nested_closure_hash);
    if (
      !dependencyNode.success ||
      !nestedClosureHash.success ||
      dependencyNode.data.node_role !== 'dependency' ||
      dependencyNode.data.nested_closure_hash !== nestedClosureHash.data
    ) {
      notClosed(`${path}.dependency_resource_node`);
    }
    if (dependencyNode.data.pin.published_resource_kind !== dependencyKind) {
      notClosed(`${path}.dependency_resource_node.pin`);
    }
    const nestedDependency = prepareNestedCapabilityDependency(
      {
        node_id: dependencyNode.data.node_id,
        pin: dependencyNode.data.pin,
        dependency_manifest_hash: dependencyNode.data.dependency_manifest_hash,
        nested_closure_hash: dependencyNode.data.nested_closure_hash,
      },
      slice.nested_closure,
    );
    const dependencyNodeId = canonicalResourceNodeId(dependencyNode.data.pin);
    if (dependencyNode.data.node_id !== dependencyNodeId) {
      notClosed(`${path}.dependency_resource_node.node_id`);
    }
    const dependencyNodes = parseDependencyResourceNodes(
      slice.dependency_resource_nodes,
      `${path}.dependency_resource_nodes`,
    );
    const descendantGateSpecs = parseGateSpecs(
      slice.descendant_gate_specs,
      `${path}.descendant_gate_specs`,
    );
    const dependencyNodeIds = new Set(dependencyNodes.map((node) => node.node_id));
    if (descendantGateSpecs.some((gate) => !dependencyNodeIds.has(gate.source_node_id))) {
      notClosed(`${path}.descendant_gate_specs`);
    }
    const projectedRootNode = dependencyNodes.find((node) => node.node_id === dependencyNodeId);
    if (
      projectedRootNode === undefined ||
      !canonicalJsonBytes(projectedRootNode).equals(canonicalJsonBytes(dependencyNode.data))
    ) {
      notClosed(`${path}.dependency_resource_nodes`);
    }
    const parentEntries = parseEntries(
      slice.entries,
      (entry) =>
        dependencyKind === 'FLOW_VERSION'
          ? entry.binding_kind === 'flow' && entry.target.published_resource_kind === 'FLOW_VERSION'
          : entry.binding_kind === 'subagent' &&
            entry.target.published_resource_kind === 'AGENT_RELEASE',
      `${path}.entries`,
    );
    if (
      parentEntries.some(
        (entry) =>
          !canonicalJsonBytes(entry.target).equals(canonicalJsonBytes(dependencyNode.data.pin)),
      )
    ) {
      notClosed(`${path}.entries`);
    }
    const gateMountPaths = parentEntries.map((entry) =>
      dependencyKind === 'FLOW_VERSION'
        ? entry.binding_path_segments
        : [
            ...entry.binding_path_segments,
            BindingPathSegmentV1Schema.parse({
              segment_kind: 'subagent_target',
              target_pin: nestedDependency.closure.root.pin,
            }),
          ],
    );
    const expectedGateSpecs = projectNestedGateSpecs(
      nestedDependency.closure,
      gateMountPaths,
      dependencyNode.data.node_id,
    );
    if (!canonicalJsonBytes(expectedGateSpecs).equals(canonicalJsonBytes(descendantGateSpecs))) {
      notClosed(`${path}.descendant_gate_specs`);
    }
    const descendantEntries = parseEntries(
      slice.descendant_binding_entries,
      () => true,
      `${path}.descendant_binding_entries`,
      true,
      8_192,
    );
    try {
      verifyProjectedBindingAdmission(nestedDependency.closure, gateMountPaths, descendantEntries);
    } catch {
      notClosed(`${path}.descendant_binding_entries`);
    }
    descendantEntries.forEach((entry, entryIndex) => {
      if (canonicalBindingPath(entry.binding_path_segments) !== entry.binding_path) {
        notClosed(`${path}.descendant_binding_entries[${entryIndex}].binding_path`);
      }
      const parent = parentEntries.find(
        (candidate) =>
          candidate.binding_path_segments.length < entry.binding_path_segments.length &&
          candidate.binding_path_segments.every((segment, segmentIndex) =>
            canonicalJsonBytes(segment).equals(
              canonicalJsonBytes(entry.binding_path_segments[segmentIndex]),
            ),
          ),
      );
      const boundary = entry.binding_path_segments[parent?.binding_path_segments.length ?? -1];
      const validBoundary =
        dependencyKind === 'FLOW_VERSION'
          ? boundary?.segment_kind === 'flow_node' &&
            boundary.owner.owner_kind === 'published_dependency' &&
            canonicalJsonBytes(boundary.owner.pin).equals(
              canonicalJsonBytes(dependencyNode.data.pin),
            )
          : boundary?.segment_kind === 'subagent_target' &&
            canonicalJsonBytes(boundary.target_pin).equals(
              canonicalJsonBytes(dependencyNode.data.pin),
            );
      if (parent === undefined || !validBoundary) {
        notClosed(`${path}.descendant_binding_entries[${entryIndex}].binding_path_segments`);
      }
    });
    const descendantDisabledBindingPaths = parseCanonicalPaths(
      slice.descendant_disabled_binding_paths,
      `${path}.descendant_disabled_binding_paths`,
      8_192,
    );
    const descendantPaths = new Set(descendantEntries.map((entry) => entry.binding_path));
    if (descendantDisabledBindingPaths.some((bindingPath) => !descendantPaths.has(bindingPath))) {
      notClosed(`${path}.descendant_disabled_binding_paths`);
    }
    const disabledPaths = new Set(descendantDisabledBindingPaths);
    descendantEntries.forEach((entry, entryIndex) => {
      const parent = parentEntries.find(
        (candidate) =>
          candidate.binding_path_segments.length < entry.binding_path_segments.length &&
          candidate.binding_path_segments.every((segment, segmentIndex) =>
            canonicalJsonBytes(segment).equals(
              canonicalJsonBytes(entry.binding_path_segments[segmentIndex]),
            ),
          ),
      );
      const unavailable =
        entry.effective_policy.credential_requirements.length === 0 &&
        entry.effective_policy.principal_modes.length === 0 &&
        entry.effective_policy.egress.length === 0 &&
        entry.effective_policy.max_calls === 0 &&
        entry.effective_policy.max_depth === 0 &&
        entry.effective_policy.max_parallelism === 0 &&
        entry.effective_policy.budget.amount_credits === '0' &&
        entry.effective_policy.budget.input_tokens === 0 &&
        entry.effective_policy.budget.output_tokens === 0 &&
        entry.effective_policy.budget.total_tokens === 0 &&
        entry.effective_policy.budget.duration_ms === 0;
      if (
        disabledPaths.has(entry.binding_path as `bp1.${string}`) !== unavailable ||
        parent === undefined
      ) {
        notClosed(`${path}.descendant_binding_entries[${entryIndex}].effective_policy`);
      }
    });
    return {
      graph_hash: canonicalGraphHash,
      entries: parentEntries,
      requirement_expressions: parseExpressions(
        slice.requirement_expressions,
        `${path}.requirement_expressions`,
      ),
      dependency_intrinsic_policies: dependencyNodes.map((node) => ({
        node_id: canonicalResourceNodeId(node.pin),
        pin: node.pin,
        intrinsic_policy: node.intrinsic_policy,
        dependency_manifest_hash: node.dependency_manifest_hash,
        ...(node.nested_closure_hash === undefined
          ? {}
          : { nested_closure_hash: node.nested_closure_hash }),
      })),
      descendant_binding_entries: descendantEntries,
      descendant_disabled_binding_paths: descendantDisabledBindingPaths,
      descendant_gate_specs: descendantGateSpecs,
      nested_gate_closures: [
        {
          source_node_id: dependencyNode.data.node_id,
          nested_closure_hash: nestedClosureHash.data,
          nested_closure: nestedDependency.closure,
        },
      ],
    };
  }
  return notClosed(`${path}.schema_version`);
}

/** Join graph-bound per-kind compiler outputs into the exact Agent root Binding namespace. */
export function prepareAgentRootBindingEntrySet(
  rootInput: unknown,
  graphHashInput: unknown,
  sliceInputs: unknown,
  policyInput: unknown,
): PreparedAgentRootBindingEntrySetV1 {
  const rootSource = prepareExecutableSource(rootInput);
  if (rootSource.root.pin.published_resource_kind !== 'AGENT_RELEASE') notClosed('$.root');
  const graphHash = ContractHashSchema.safeParse(graphHashInput);
  if (!graphHash.success) notClosed('$.graph_hash');
  const canonicalGraphHash = graphHash.data as `sha256:${string}`;
  const snapshots = boundedDataSnapshot(sliceInputs, 'closure');
  if (!Array.isArray(snapshots) || snapshots.length === 0 || snapshots.length > 128) {
    notClosed('$.slices');
  }
  let descendantCount = 0;
  let descendantDisabledCount = 0;
  let dependencyResourceNodeCount = 0;
  let descendantGateSpecCount = 0;
  for (const [index, snapshot] of snapshots.entries()) {
    const slice = record(snapshot, `$.slices[${index}]`);
    const descendants =
      slice.schema_version === 'prepared-agent-composite-binding-entries/1'
        ? slice.descendant_binding_entries
        : slice.schema_version === 'graph-bound-skill-pack-leaf-binding-entry-set/1'
          ? record(slice.prepared_entries, `$.slices[${index}].prepared_entries`).entries
          : [];
    const disabled =
      slice.schema_version === 'prepared-agent-composite-binding-entries/1'
        ? slice.descendant_disabled_binding_paths
        : slice.schema_version === 'graph-bound-skill-pack-leaf-binding-entry-set/1'
          ? record(slice.prepared_entries, `$.slices[${index}].prepared_entries`)
              .policy_disabled_binding_paths
          : [];
    const resourceNodes =
      slice.schema_version === 'prepared-agent-composite-binding-entries/1'
        ? slice.dependency_resource_nodes
        : [];
    const gateSpecs =
      slice.schema_version === 'prepared-agent-composite-binding-entries/1'
        ? slice.descendant_gate_specs
        : [];
    if (
      !Array.isArray(descendants) ||
      !Array.isArray(disabled) ||
      !Array.isArray(resourceNodes) ||
      !Array.isArray(gateSpecs)
    )
      notClosed(`$.slices[${index}]`);
    descendantCount += descendants.length;
    descendantDisabledCount += disabled.length;
    dependencyResourceNodeCount += resourceNodes.length;
    descendantGateSpecCount += gateSpecs.length;
    if (
      descendantCount > 8_192 ||
      descendantDisabledCount > 8_192 ||
      dependencyResourceNodeCount > 8_192 ||
      descendantGateSpecCount > 8_192
    ) {
      notClosed('$.descendant_binding_entries');
    }
  }
  const slices = snapshots.map(parseSlice);
  if (slices.some((slice) => slice.graph_hash !== canonicalGraphHash)) notClosed('$.graph_hash');
  for (const slice of slices) {
    if (
      slice.root !== undefined &&
      !canonicalJsonBytes(slice.root).equals(canonicalJsonBytes(rootSource.root))
    )
      notClosed('$.slices.root');
  }

  const paths = prepareRootBindingPaths(rootInput);
  const document = rootSource.preimage.document as unknown as {
    capability_bindings: readonly CapabilityBindingV1[];
  };
  const entries = slices
    .flatMap((slice) => slice.entries)
    .sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path));
  if (
    entries.length !== paths.bindings.length ||
    new Set(entries.map((entry) => entry.binding_path)).size !== entries.length
  )
    notClosed('$.entries');
  for (const entry of entries) {
    const path = paths.bindings.find((candidate) => candidate.binding_path === entry.binding_path);
    const binding = document.capability_bindings.find(
      (candidate) => candidate.binding_id === entry.binding_id,
    );
    if (
      path === undefined ||
      binding === undefined ||
      path.binding_id !== entry.binding_id ||
      path.binding_kind !== entry.binding_kind ||
      canonicalSha256(bindingAdmissionEvidence(binding)) !==
        canonicalSha256({
          admission_requirement: entry.admission_requirement,
          ...(entry.required_call === undefined ? {} : { required_call: entry.required_call }),
        }) ||
      !canonicalJsonBytes(path.binding_path_segments).equals(
        canonicalJsonBytes(entry.binding_path_segments),
      ) ||
      !canonicalJsonBytes(binding.pin).equals(canonicalJsonBytes(entry.target)) ||
      canonicalSha256(binding.config) !== entry.config_hash ||
      binding.pin.contract_hash !== entry.source_contract_hash ||
      entry.dependency_node_ids.length !== 1 ||
      entry.dependency_node_ids[0] !== canonicalResourceNodeId(binding.pin)
    )
      notClosed(`$.entries.${entry.binding_path}`);
  }

  const expressions = slices
    .flatMap((slice) => slice.requirement_expressions)
    .sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path));
  const enabledPaths = paths.bindings
    .filter((path) => path.enabled)
    .map((path) => path.binding_path)
    .sort(compareCanonicalStrings);
  if (
    expressions.length !== enabledPaths.length ||
    new Set(expressions.map((item) => item.binding_path)).size !== expressions.length ||
    expressions.some((item, index) => item.binding_path !== enabledPaths[index])
  )
    notClosed('$.requirement_expressions');

  const dependencyPoliciesByNode = new Map<string, DependencyIntrinsicPolicyEvidence>();
  for (const evidence of slices.flatMap((slice) => slice.dependency_intrinsic_policies)) {
    const existing = dependencyPoliciesByNode.get(evidence.node_id);
    dependencyPoliciesByNode.set(
      evidence.node_id,
      mergeDependencyIntrinsicPolicyEvidence(existing, evidence),
    );
  }
  const dependencyIntrinsicPolicies = [...dependencyPoliciesByNode.values()].sort((left, right) =>
    compareCanonicalStrings(left.node_id, right.node_id),
  );
  const descendantBindingEntries = slices
    .flatMap((slice) => slice.descendant_binding_entries)
    .sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path));
  if (
    descendantBindingEntries.some(
      (entry, index) =>
        index > 0 &&
        (descendantBindingEntries[index - 1]?.binding_path ?? '') >= entry.binding_path,
    )
  ) {
    notClosed('$.descendant_binding_entries');
  }
  const descendantGateSpecsByIdentity = new Map<string, CompiledGateSpecEntryV1>();
  for (const gate of slices.flatMap((slice) => slice.descendant_gate_specs)) {
    const identity = gateIdentity(gate);
    const existing = descendantGateSpecsByIdentity.get(identity);
    if (existing !== undefined && !canonicalJsonBytes(existing).equals(canonicalJsonBytes(gate))) {
      notClosed('$.descendant_gate_specs');
    }
    descendantGateSpecsByIdentity.set(identity, gate);
  }
  const descendantGateSpecs = [...descendantGateSpecsByIdentity.entries()]
    .sort(([left], [right]) => compareCanonicalStrings(left, right))
    .map(([, gate]) => gate);
  const nestedGateClosuresByNode = new Map<string, NestedGateClosureEvidenceV1>();
  for (const evidence of slices.flatMap((slice) => slice.nested_gate_closures)) {
    const existing = nestedGateClosuresByNode.get(evidence.source_node_id);
    if (
      existing !== undefined &&
      !canonicalJsonBytes(existing).equals(canonicalJsonBytes(evidence))
    ) {
      notClosed('$.nested_gate_closures');
    }
    nestedGateClosuresByNode.set(evidence.source_node_id, evidence);
  }
  const nestedGateClosures = [...nestedGateClosuresByNode.values()].sort((left, right) =>
    compareCanonicalStrings(left.source_node_id, right.source_node_id),
  );
  const descendantDisabledPaths = new Set(
    slices.flatMap((slice) => slice.descendant_disabled_binding_paths),
  );
  for (const parentPath of paths.bindings.filter((path) => !path.enabled)) {
    for (const descendant of descendantBindingEntries) {
      const belongsToParent =
        parentPath.binding_path_segments.length < descendant.binding_path_segments.length &&
        parentPath.binding_path_segments.every((segment, segmentIndex) =>
          canonicalJsonBytes(segment).equals(
            canonicalJsonBytes(descendant.binding_path_segments[segmentIndex]),
          ),
        );
      if (
        belongsToParent &&
        !descendantDisabledPaths.has(descendant.binding_path as `bp1.${string}`)
      ) {
        notClosed('$.descendant_disabled_binding_paths');
      }
    }
  }
  const disabledBindingPaths = [
    ...new Set([...paths.source_disabled_binding_paths, ...descendantDisabledPaths]),
  ].sort(compareCanonicalStrings);

  const policies = parseAgentBindingPolicyInput(policyInput, 'agent-root-binding-policy-input/1');
  const policyPaths = policies.binding_ceilings
    .map((item) => item.binding_path)
    .sort(compareCanonicalStrings);
  const rootPaths = paths.bindings.map((item) => item.binding_path).sort(compareCanonicalStrings);
  if (
    policyPaths.length !== rootPaths.length ||
    new Set(policyPaths).size !== policyPaths.length ||
    policyPaths.some((path, index) => path !== rootPaths[index])
  )
    notClosed('$.policy.binding_ceilings');

  const uniqueExpressions = new Map<string, CapabilityRequirementExpressionV1>();
  for (const item of expressions) {
    uniqueExpressions.set(
      canonicalJsonBytes(item.expression).toString('base64url'),
      item.expression,
    );
  }
  const intrinsicPolicy = normalizeCapabilityRequirementExpression(
    expressions.length === 0
      ? canonicalEmptyCapabilityRequirementExpression()
      : expressions.length === 1
        ? expressions[0]?.expression
        : {
            schema_version: 'capability-requirement-expression/1',
            expression_kind: 'alternative',
            children: [...uniqueExpressions.values()],
          },
  );
  const rootCeiling = meetCapabilityPolicyCeilings(
    policies.workspace_ceiling,
    policies.root_ceiling,
  );
  const aggregateLimits = resolveEffectiveCapabilityPolicy(
    rootCeiling,
    compileCapabilityRequirementEnvelope(intrinsicPolicy),
  );

  return deepFreezeJson({
    schema_version: 'prepared-agent-root-binding-entry-set/1',
    graph_hash: canonicalGraphHash,
    root: rootSource.root,
    entries,
    requirement_expressions: expressions,
    disabled_binding_paths: disabledBindingPaths,
    dependency_intrinsic_policies: dependencyIntrinsicPolicies,
    descendant_binding_entries: descendantBindingEntries,
    descendant_gate_specs: descendantGateSpecs,
    nested_gate_closures: nestedGateClosures,
    intrinsic_policy: intrinsicPolicy,
    aggregate_limits: aggregateLimits,
  });
}
