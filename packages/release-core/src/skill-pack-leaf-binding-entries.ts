import {
  type CapabilityRequirementExpressionV1,
  type CapabilityBindingV1,
  CompiledBindingEntryV1Schema,
  EffectiveCapabilityPolicyV1Schema,
} from '@better-agent/domain-contracts';

import { prepareAgentBindingApprovalGate } from './agent-gate-specs.js';
import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import {
  compileCapabilityRequirementEnvelope,
  meetCapabilityPolicyCeilings,
  normalizeCapabilityRequirementExpression,
  normalizeCapabilityPolicyCeiling,
  resolveEffectiveCapabilityPolicy,
} from './capability-policy.js';
import { canonicalResourceNodeId } from './closure-identity.js';
import {
  compareCanonicalStrings,
  deepFreezeJson,
  publishedResourcePinKey,
} from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { prepareExecutableSource } from './executable-source.js';
import { canonicalSha256 } from './hash.js';
import { prepareLeafResourceSource, verifyLeafResourceBindings } from './leaf-resource-source.js';
import { prepareGraphBoundDependencyFanout } from './pinned-graph-slice.js';
import { prepareAgentSkillPackDependencyPaths } from './root-binding-paths.js';
import { prepareSkillPackOperationRoutes } from './skill-pack-operation-routes.js';
import { prepareSkillPackSource } from './skill-pack-source.js';

type CompiledBindingEntryV1 = ReturnType<typeof CompiledBindingEntryV1Schema.parse>;
type PathCeiling = { readonly binding_path: string; readonly ceiling: unknown };

interface PackPolicyInput {
  readonly workspace_ceiling: unknown;
  readonly root_ceiling: unknown;
  readonly pack_binding_ceilings: readonly PathCeiling[];
  readonly member_binding_ceilings: readonly PathCeiling[];
}

export interface PreparedSkillPackLeafBindingEntrySetV1 {
  readonly schema_version: 'prepared-skill-pack-leaf-binding-entry-set/1';
  readonly root: ReturnType<typeof prepareExecutableSource>['root'];
  readonly pack_dependency: ReturnType<typeof prepareSkillPackSource>['full_pin'];
  readonly leaf_dependencies: readonly ReturnType<typeof prepareLeafResourceSource>['full_pin'][];
  readonly leaf_dependency_intrinsic_policies: readonly {
    readonly node_id: ReturnType<typeof canonicalResourceNodeId>;
    readonly pin: ReturnType<typeof prepareLeafResourceSource>['full_pin'];
    readonly intrinsic_policy: CapabilityRequirementExpressionV1;
  }[];
  readonly pack_dependency_intrinsic_policy?: {
    readonly node_id: ReturnType<typeof canonicalResourceNodeId>;
    readonly pin: ReturnType<typeof prepareSkillPackSource>['full_pin'];
    readonly intrinsic_policy: CapabilityRequirementExpressionV1;
  };
  readonly pack_entries: readonly CompiledBindingEntryV1[];
  readonly pack_requirement_expressions: readonly {
    readonly binding_path: `bp1.${string}`;
    readonly expression: CapabilityRequirementExpressionV1;
  }[];
  readonly entries: readonly CompiledBindingEntryV1[];
  readonly policy_disabled_binding_paths: readonly `bp1.${string}`[];
}

export interface GraphBoundSkillPackLeafBindingEntrySetV1 {
  readonly schema_version: 'graph-bound-skill-pack-leaf-binding-entry-set/1';
  readonly graph_hash: `sha256:${string}`;
  readonly prepared_entries: PreparedSkillPackLeafBindingEntrySetV1;
}

function notClosed(path = '$.pack'): never {
  throw new ReleaseCoreError(
    'CLOSURE_BINDING_ENTRY_NOT_CLOSED',
    path,
    'Skill Pack leaf inputs do not form one exact closed member projection',
  );
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function parsePathCeilings(value: unknown, path: string): PathCeiling[] {
  if (!Array.isArray(value)) notClosed(path);
  return value.map((item, index) => {
    if (
      !plainRecord(item) ||
      !exactKeys(item, ['binding_path', 'ceiling']) ||
      typeof item.binding_path !== 'string'
    )
      notClosed(`${path}[${index}]`);
    return {
      binding_path: item.binding_path,
      ceiling: normalizeCapabilityPolicyCeiling(item.ceiling),
    };
  });
}

function parsePolicyInput(input: unknown): PackPolicyInput {
  const snapshot = boundedDataSnapshot(input, 'policy');
  if (
    !plainRecord(snapshot) ||
    !exactKeys(snapshot, [
      'schema_version',
      'workspace_ceiling',
      'root_ceiling',
      'pack_binding_ceilings',
      'member_binding_ceilings',
    ]) ||
    snapshot.schema_version !== 'skill-pack-leaf-binding-policy-input/1'
  )
    notClosed('$.policy');
  return {
    workspace_ceiling: normalizeCapabilityPolicyCeiling(snapshot.workspace_ceiling),
    root_ceiling: normalizeCapabilityPolicyCeiling(snapshot.root_ceiling),
    pack_binding_ceilings: parsePathCeilings(
      snapshot.pack_binding_ceilings,
      '$.policy.pack_binding_ceilings',
    ),
    member_binding_ceilings: parsePathCeilings(
      snapshot.member_binding_ceilings,
      '$.policy.member_binding_ceilings',
    ),
  };
}

function isLeafBinding(binding: CapabilityBindingV1): boolean {
  return (
    binding.kind === 'knowledge' ||
    binding.kind === 'database' ||
    binding.kind === 'plugin' ||
    (binding.kind === 'subagent' && binding.target_kind === 'external_a2a')
  );
}

function requireExactPaths(
  actual: readonly PathCeiling[],
  expected: Set<string>,
  path: string,
): void {
  const actualPaths = actual.map((item) => item.binding_path);
  if (
    actualPaths.length !== expected.size ||
    new Set(actualPaths).size !== actualPaths.length ||
    actualPaths.some((item) => !expected.has(item))
  )
    notClosed(path);
}

function unavailablePolicy(
  operations: readonly CompiledBindingEntryV1['operation_contracts'][number][],
): ReturnType<typeof EffectiveCapabilityPolicyV1Schema.parse> {
  const effectRank = { safe: 0, requires_key: 1, unsafe: 2 } as const;
  const maximumClass = operations.reduce<'safe' | 'requires_key' | 'unsafe'>(
    (current, operation) =>
      effectRank[operation.side_effect_class] > effectRank[current]
        ? operation.side_effect_class
        : current,
    'safe',
  );
  return EffectiveCapabilityPolicyV1Schema.parse({
    credential_requirements: [],
    principal_modes: [],
    egress: [],
    readable_data_classification_ceiling: 'public',
    output_data_classification: 'public',
    side_effect: {
      maximum_class: maximumClass,
      approval: operations.some((operation) => operation.approval_required) ? 'required' : 'none',
    },
    operation_contract_hashes: operations.map((operation) => operation.contract_hash),
    max_calls: 0,
    max_depth: 0,
    max_parallelism: 0,
    budget: {
      schema_version: 'capability-budget/1',
      amount_credits: '0',
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      duration_ms: 0,
    },
  });
}

/** Compile every leaf member under every exact Pack mount; graph sealing remains a later step. */
export function prepareSkillPackLeafBindingEntrySet(
  rootInput: unknown,
  packInput: unknown,
  leafInputs: unknown,
  policyInput: unknown,
): PreparedSkillPackLeafBindingEntrySetV1 {
  const rootSource = prepareExecutableSource(rootInput);
  if (rootSource.root.pin.published_resource_kind !== 'AGENT_RELEASE') notClosed('$.root');
  const pack = prepareSkillPackSource(packInput);
  const paths = prepareAgentSkillPackDependencyPaths(rootInput, packInput);
  const routes = prepareSkillPackOperationRoutes(rootInput, packInput);
  const rootDocument = rootSource.preimage.document as unknown as {
    capability_bindings: readonly CapabilityBindingV1[];
  };
  const packDocument = pack.document as unknown as {
    member_bindings: readonly CapabilityBindingV1[];
  };
  const mounted = paths.bindings.filter((binding) => binding.members.length > 0);
  const leafMembers = packDocument.member_bindings.filter(isLeafBinding);
  if (mounted.length === 0 || leafMembers.length === 0) notClosed('$.pack.member_bindings');

  const expectedTargets = new Set(
    leafMembers.map((binding) => publishedResourcePinKey(binding.pin)),
  );
  const snapshots = boundedDataSnapshot(leafInputs, 'source');
  if (!Array.isArray(snapshots) || snapshots.length === 0) notClosed('$.leaf_dependencies');
  const leaves = new Map<
    string,
    { readonly input: unknown; readonly prepared: ReturnType<typeof prepareLeafResourceSource> }
  >();
  for (const input of snapshots) {
    const prepared = prepareLeafResourceSource(input);
    const key = publishedResourcePinKey(prepared.full_pin);
    if (!expectedTargets.has(key) || leaves.has(key)) notClosed('$.leaf_dependencies');
    leaves.set(key, { input, prepared });
  }
  if (leaves.size !== expectedTargets.size) notClosed('$.leaf_dependencies');
  for (const [targetKey, leaf] of leaves) {
    verifyLeafResourceBindings(
      leafMembers.filter((binding) => publishedResourcePinKey(binding.pin) === targetKey),
      leaf.input,
    );
  }

  const policies = parsePolicyInput(policyInput);
  const expectedPackPaths = new Set(mounted.map((binding) => binding.binding_path));
  const expectedMemberPaths = new Set(
    mounted.flatMap((binding) =>
      binding.members
        .filter((member) =>
          leafMembers.some((source) => source.binding_id === member.member_binding_id),
        )
        .map((member) => member.member_binding_path),
    ),
  );
  requireExactPaths(
    policies.pack_binding_ceilings,
    expectedPackPaths,
    '$.policy.pack_binding_ceilings',
  );
  requireExactPaths(
    policies.member_binding_ceilings,
    expectedMemberPaths,
    '$.policy.member_binding_ceilings',
  );
  const sharedCeiling = meetCapabilityPolicyCeilings(
    policies.workspace_ceiling,
    policies.root_ceiling,
  );
  const routedMemberPaths = new Set(routes.routes.map((route) => route.member_binding_path));
  const disabledPaths = new Set<`bp1.${string}`>();
  const packRequirementExpressions: PreparedSkillPackLeafBindingEntrySetV1['pack_requirement_expressions'][number][] =
    [];
  const packEntries = mounted
    .map((mount) => {
      const packBinding = rootDocument.capability_bindings.find(
        (binding) => binding.binding_id === mount.binding_id && binding.kind === 'skill_pack',
      );
      const packPolicy = policies.pack_binding_ceilings.find(
        (item) => item.binding_path === mount.binding_path,
      );
      if (
        packBinding === undefined ||
        packBinding.kind !== 'skill_pack' ||
        packPolicy === undefined
      )
        notClosed('$.pack_binding');
      const packRoutes = routes.routes.filter(
        (route) => route.pack_binding_path === mount.binding_path,
      );
      const bindingOperations = routes.binding_operations.find(
        (item) => item.pack_binding_path === mount.binding_path,
      );
      const enabled = packBinding.enabled;
      if (enabled && (bindingOperations === undefined || packRoutes.length === 0)) {
        notClosed('$.pack_entry.operation_contracts');
      }
      const operations = bindingOperations?.operation_contracts ?? [];
      const operationRequirements = operations.map((operation) => {
        const matchingRoutes = packRoutes.filter(
          (route) => route.member_operation_contract_hash === operation.contract_hash,
        );
        if (matchingRoutes.length === 0) notClosed('$.pack_entry.skill_pack_operation_routes');
        const requirements = matchingRoutes.map((route) => {
          const leaf = leaves.get(publishedResourcePinKey(route.member_target));
          if (leaf?.prepared.operation_contract.contract_hash !== operation.contract_hash) {
            notClosed('$.pack_entry.operation_contracts');
          }
          return leaf.prepared.intrinsic_policy;
        });
        const first = requirements[0];
        if (
          first === undefined ||
          requirements.some(
            (requirement) => canonicalSha256(requirement) !== canonicalSha256(first),
          )
        )
          notClosed('$.pack_entry.requirements');
        return first;
      });
      let effectivePolicy = unavailablePolicy(operations);
      if (enabled) {
        const children = operationRequirements.map((requirements) => ({
          schema_version: 'capability-requirement-expression/1' as const,
          expression_kind: 'leaf' as const,
          requirements,
        }));
        const expression = normalizeCapabilityRequirementExpression(
          children.length === 1
            ? children[0]
            : {
                schema_version: 'capability-requirement-expression/1',
                expression_kind: 'alternative',
                children,
              },
        );
        const requirements = compileCapabilityRequirementEnvelope(expression);
        effectivePolicy = resolveEffectiveCapabilityPolicy(
          meetCapabilityPolicyCeilings(sharedCeiling, packPolicy.ceiling),
          {
            ...requirements,
            approval_required:
              requirements.approval_required || packBinding.side_effect.approval === 'required',
          },
        );
        packRequirementExpressions.push({ binding_path: mount.binding_path, expression });
      } else {
        disabledPaths.add(mount.binding_path);
      }
      const approval = prepareAgentBindingApprovalGate(
        rootInput,
        packBinding.binding_id,
        operations,
      );
      if (
        effectivePolicy.side_effect.approval === 'required' &&
        approval.approval_gate_spec === undefined
      )
        notClosed('$.pack_entry.approval_gate_spec');
      const parsed = CompiledBindingEntryV1Schema.safeParse({
        binding_path_encoding_version: 'binding-path-lp-utf8/1',
        binding_path: mount.binding_path,
        binding_path_segments: mount.binding_path_segments,
        binding_id: packBinding.binding_id,
        binding_kind: packBinding.kind,
        target: packBinding.pin,
        config_schema_version: packBinding.config.schema_version,
        config_hash: canonicalSha256(packBinding.config),
        source_contract_hash: pack.full_pin.contract_hash,
        effective_policy: effectivePolicy,
        operation_contracts: operations,
        dependency_node_ids: [canonicalResourceNodeId(pack.full_pin)],
        skill_pack_operation_routes: packRoutes,
        ...(approval.approval_gate_spec === undefined
          ? {}
          : { approval_gate_spec: approval.approval_gate_spec }),
      });
      if (!parsed.success) notClosed('$.pack_entry');
      return parsed.data;
    })
    .sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path));
  const entries = mounted
    .flatMap((mount) => {
      const packBinding = rootDocument.capability_bindings.find(
        (binding) => binding.binding_id === mount.binding_id && binding.kind === 'skill_pack',
      );
      const packPolicy = policies.pack_binding_ceilings.find(
        (item) => item.binding_path === mount.binding_path,
      );
      if (
        packBinding === undefined ||
        packBinding.kind !== 'skill_pack' ||
        packPolicy === undefined
      )
        notClosed('$.pack_binding');
      const mountCeiling = meetCapabilityPolicyCeilings(sharedCeiling, packPolicy.ceiling);
      return mount.members.flatMap((memberPath) => {
        const member = leafMembers.find(
          (binding) => binding.binding_id === memberPath.member_binding_id,
        );
        if (member === undefined) return [];
        const leaf = leaves.get(publishedResourcePinKey(member.pin));
        const memberPolicy = policies.member_binding_ceilings.find(
          (item) => item.binding_path === memberPath.member_binding_path,
        );
        if (leaf === undefined || memberPolicy === undefined) notClosed('$.member_binding');
        const approval = prepareAgentBindingApprovalGate(rootInput, packBinding.binding_id, [
          leaf.prepared.operation_contract,
        ]);
        const effectivePolicy = resolveEffectiveCapabilityPolicy(
          meetCapabilityPolicyCeilings(mountCeiling, memberPolicy.ceiling),
          {
            ...leaf.prepared.intrinsic_policy,
            approval_required:
              leaf.prepared.intrinsic_policy.approval_required ||
              packBinding.side_effect.approval === 'required' ||
              member.side_effect.approval === 'required',
          },
        );
        if (
          effectivePolicy.side_effect.approval === 'required' &&
          approval.approval_gate_spec === undefined
        )
          notClosed('$.entry.approval_gate_spec');
        if (
          !packBinding.enabled ||
          !member.enabled ||
          !routedMemberPaths.has(memberPath.member_binding_path)
        )
          disabledPaths.add(memberPath.member_binding_path);
        const candidate = {
          binding_path_encoding_version: 'binding-path-lp-utf8/1' as const,
          binding_path: memberPath.member_binding_path,
          binding_path_segments: memberPath.member_binding_path_segments,
          binding_id: member.binding_id,
          binding_kind: member.kind,
          target: member.pin,
          config_schema_version: member.config.schema_version,
          config_hash: canonicalSha256(member.config),
          source_contract_hash: leaf.prepared.full_pin.contract_hash,
          effective_policy: effectivePolicy,
          operation_contracts: [leaf.prepared.operation_contract],
          dependency_node_ids: [canonicalResourceNodeId(leaf.prepared.full_pin)],
          ...(approval.approval_gate_spec === undefined
            ? {}
            : { approval_gate_spec: approval.approval_gate_spec }),
          ...(member.kind === 'subagent' && member.config.invocation === 'async'
            ? { async_child_policy_hash: canonicalSha256(member.config.async_child) }
            : {}),
        };
        const parsed = CompiledBindingEntryV1Schema.safeParse(candidate);
        if (!parsed.success) notClosed('$.entry');
        return [parsed.data];
      });
    })
    .sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path));
  if (entries.length !== expectedMemberPaths.size) notClosed('$.entries');
  const leafDependencyIntrinsicPolicies = [...leaves.values()]
    .map(({ prepared }) => ({
      node_id: canonicalResourceNodeId(prepared.full_pin),
      pin: prepared.full_pin,
      intrinsic_policy: normalizeCapabilityRequirementExpression({
        schema_version: 'capability-requirement-expression/1',
        expression_kind: 'leaf',
        requirements: prepared.intrinsic_policy,
      }),
    }))
    .sort((left, right) => compareCanonicalStrings(left.node_id, right.node_id));
  const uniquePackChildren = new Map<string, CapabilityRequirementExpressionV1>();
  for (const evidence of leafDependencyIntrinsicPolicies) {
    uniquePackChildren.set(canonicalSha256(evidence.intrinsic_policy), evidence.intrinsic_policy);
  }
  const packChildren = [...uniquePackChildren.values()];
  const packDependencyIntrinsicPolicy =
    leafMembers.length === packDocument.member_bindings.length
      ? {
          node_id: canonicalResourceNodeId(pack.full_pin),
          pin: pack.full_pin,
          intrinsic_policy: normalizeCapabilityRequirementExpression(
            packChildren.length === 1
              ? packChildren[0]
              : {
                  schema_version: 'capability-requirement-expression/1',
                  expression_kind: 'alternative',
                  children: packChildren,
                },
          ),
        }
      : undefined;
  return deepFreezeJson({
    schema_version: 'prepared-skill-pack-leaf-binding-entry-set/1',
    root: rootSource.root,
    pack_dependency: pack.full_pin,
    leaf_dependencies: [...leaves.values()]
      .map((leaf) => leaf.prepared.full_pin)
      .sort((left, right) =>
        compareCanonicalStrings(publishedResourcePinKey(left), publishedResourcePinKey(right)),
      ),
    leaf_dependency_intrinsic_policies: leafDependencyIntrinsicPolicies,
    ...(packDependencyIntrinsicPolicy === undefined
      ? {}
      : { pack_dependency_intrinsic_policy: packDependencyIntrinsicPolicy }),
    pack_entries: packEntries,
    pack_requirement_expressions: packRequirementExpressions.sort((left, right) =>
      compareCanonicalStrings(left.binding_path, right.binding_path),
    ),
    entries,
    policy_disabled_binding_paths: [...disabledPaths].sort(compareCanonicalStrings),
  });
}

/** Seal Agent→Pack→leaf provenance against one recomputed pinned graph. */
export function prepareGraphBoundSkillPackLeafBindingEntrySet(
  expectedGraph: unknown,
  graphCandidate: unknown,
  rootInput: unknown,
  packInput: unknown,
  leafInputs: unknown,
  policyInput: unknown,
): GraphBoundSkillPackLeafBindingEntrySetV1 {
  const prepared = prepareSkillPackLeafBindingEntrySet(
    rootInput,
    packInput,
    leafInputs,
    policyInput,
  );
  const root = prepareExecutableSource(rootInput);
  const pack = prepareSkillPackSource(packInput);
  const graph = prepareGraphBoundDependencyFanout(
    expectedGraph,
    graphCandidate,
    prepared.root.pin,
    prepared.pack_dependency,
    prepared.leaf_dependencies,
  );
  if (
    graph.root_node.dependency_manifest_hash !== root.dependency_manifest.manifest_hash ||
    graph.parent_node.dependency_manifest_hash !== pack.dependency_manifest.manifest_hash
  )
    notClosed('$.graph');
  return deepFreezeJson({
    schema_version: 'graph-bound-skill-pack-leaf-binding-entry-set/1',
    graph_hash: graph.graph_hash,
    prepared_entries: prepared,
  });
}
