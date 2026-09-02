import {
  type CapabilityRequirementExpressionV1,
  CompiledBindingEntryV1Schema,
  type CapabilityBindingV1,
} from '@better-agent/domain-contracts';

import { prepareAgentLeafBindingOperations } from './agent-leaf-binding-operations.js';
import { prepareAgentBindingApprovalGate } from './agent-gate-specs.js';
import { parseAgentBindingPolicyInput } from './agent-binding-policy.js';
import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import {
  meetCapabilityPolicyCeilings,
  normalizeCapabilityRequirementExpression,
  resolveEffectiveCapabilityPolicy,
} from './capability-policy.js';
import { canonicalResourceNodeId } from './closure-identity.js';
import {
  compareCanonicalStrings,
  deepFreezeJson,
  publishedResourcePinKey,
} from './dependency-manifest.js';
import { prepareExecutableSource } from './executable-source.js';
import { ReleaseCoreError } from './errors.js';
import { canonicalSha256 } from './hash.js';
import { prepareLeafResourceSource } from './leaf-resource-source.js';
import { prepareGraphBoundDirectDependencies } from './pinned-graph-slice.js';
import { prepareRootBindingPaths } from './root-binding-paths.js';

type CompiledBindingEntryV1 = ReturnType<typeof CompiledBindingEntryV1Schema.parse>;

interface PreparedAgentLeafBindingEntriesV1 {
  readonly schema_version: 'prepared-agent-leaf-binding-entries/1';
  readonly root: ReturnType<typeof prepareExecutableSource>['root'];
  readonly dependency: ReturnType<typeof prepareAgentLeafBindingOperations>['dependency'];
  readonly intrinsic_policy: ReturnType<
    typeof prepareAgentLeafBindingOperations
  >['intrinsic_policy'];
  readonly entries: readonly CompiledBindingEntryV1[];
  readonly requirement_expressions: readonly {
    readonly binding_path: `bp1.${string}`;
    readonly expression: CapabilityRequirementExpressionV1;
  }[];
}

interface PreparedAgentLeafBindingEntrySetV1 {
  readonly schema_version: 'prepared-agent-leaf-binding-entry-set/1';
  readonly root: ReturnType<typeof prepareExecutableSource>['root'];
  readonly dependencies: readonly ReturnType<typeof prepareLeafResourceSource>['full_pin'][];
  readonly dependency_intrinsic_policies: readonly {
    readonly node_id: ReturnType<typeof canonicalResourceNodeId>;
    readonly pin: ReturnType<typeof prepareLeafResourceSource>['full_pin'];
    readonly intrinsic_policy: CapabilityRequirementExpressionV1;
  }[];
  readonly entries: readonly CompiledBindingEntryV1[];
  readonly requirement_expressions: PreparedAgentLeafBindingEntriesV1['requirement_expressions'];
}

interface GraphBoundAgentLeafBindingEntrySetV1 {
  readonly schema_version: 'graph-bound-agent-leaf-binding-entry-set/1';
  readonly graph_hash: `sha256:${string}`;
  readonly prepared_entries: PreparedAgentLeafBindingEntrySetV1;
}

function notClosed(path = '$.policy'): never {
  throw new ReleaseCoreError(
    'CLOSURE_BINDING_ENTRY_NOT_CLOSED',
    path,
    'leaf Binding entry inputs do not form one exact closed path projection',
  );
}

/**
 * Assemble complete root Binding entries for one independently verified leaf dependency.
 * Typed ceilings are compiler facts only; registry/admission provenance remains external.
 */
export function prepareAgentLeafBindingEntries(
  rootInput: unknown,
  dependencyInput: unknown,
  policyInput: unknown,
): PreparedAgentLeafBindingEntriesV1 {
  const source = prepareExecutableSource(rootInput);
  if (source.root.pin.published_resource_kind !== 'AGENT_RELEASE') notClosed('$.root');
  const projection = prepareAgentLeafBindingOperations(rootInput, dependencyInput);
  const rootPaths = prepareRootBindingPaths(rootInput);
  const policies = parseAgentBindingPolicyInput(policyInput, 'agent-leaf-binding-policy-input/1');
  const document = source.preimage.document as unknown as {
    capability_bindings: readonly CapabilityBindingV1[];
  };
  const selectedPaths = projection.bindings.filter(
    (binding) => binding.operation_contracts.length > 0,
  );
  if (selectedPaths.length === 0 || policies.binding_ceilings.length !== selectedPaths.length)
    notClosed();
  const uniquePolicyPaths = new Set(policies.binding_ceilings.map((item) => item.binding_path));
  if (uniquePolicyPaths.size !== policies.binding_ceilings.length) notClosed();
  const sharedCeiling = meetCapabilityPolicyCeilings(
    policies.workspace_ceiling,
    policies.root_ceiling,
  );
  const dependencyNodeId = canonicalResourceNodeId(projection.dependency);
  const entries = selectedPaths
    .map((path) => {
      const binding = document.capability_bindings.find(
        (candidate) => candidate.binding_id === path.binding_id,
      );
      const compiledPath = rootPaths.bindings.find(
        (candidate) => candidate.binding_path === path.binding_path,
      );
      const policy = policies.binding_ceilings.find(
        (candidate) => candidate.binding_path === path.binding_path,
      );
      if (binding === undefined || compiledPath === undefined || policy === undefined) notClosed();
      const approval = prepareAgentBindingApprovalGate(
        rootInput,
        binding.binding_id,
        path.operation_contracts,
      );
      const effectivePolicy = resolveEffectiveCapabilityPolicy(
        meetCapabilityPolicyCeilings(sharedCeiling, policy.ceiling),
        {
          ...projection.intrinsic_policy,
          approval_required:
            projection.intrinsic_policy.approval_required ||
            binding.side_effect.approval === 'required',
        },
      );
      if (
        effectivePolicy.side_effect.approval === 'required' &&
        approval.approval_gate_spec === undefined
      )
        notClosed('$.entry.approval_gate_spec');
      const candidate = {
        binding_path_encoding_version: 'binding-path-lp-utf8/1' as const,
        binding_path: path.binding_path,
        binding_path_segments: compiledPath.binding_path_segments,
        binding_id: binding.binding_id,
        binding_kind: binding.kind,
        target: binding.pin,
        config_schema_version: binding.config.schema_version,
        config_hash: canonicalSha256(binding.config),
        source_contract_hash: projection.dependency.contract_hash,
        effective_policy: effectivePolicy,
        operation_contracts: path.operation_contracts,
        dependency_node_ids: [dependencyNodeId],
        ...(approval.approval_gate_spec === undefined
          ? {}
          : { approval_gate_spec: approval.approval_gate_spec }),
        ...(binding.kind === 'subagent' && binding.config.invocation === 'async'
          ? { async_child_policy_hash: canonicalSha256(binding.config.async_child) }
          : {}),
      };
      const parsed = CompiledBindingEntryV1Schema.safeParse(candidate);
      if (!parsed.success) notClosed('$.entry');
      return parsed.data;
    })
    .sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path));
  if (entries.length !== policies.binding_ceilings.length) notClosed();
  const requirementExpressions = selectedPaths
    .filter((path) => path.enabled)
    .map((path) => ({
      binding_path: path.binding_path,
      expression: normalizeCapabilityRequirementExpression({
        schema_version: 'capability-requirement-expression/1',
        expression_kind: 'leaf',
        requirements: projection.intrinsic_policy,
      }),
    }))
    .sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path));
  return deepFreezeJson({
    schema_version: 'prepared-agent-leaf-binding-entries/1',
    root: source.root,
    dependency: projection.dependency,
    intrinsic_policy: projection.intrinsic_policy,
    entries,
    requirement_expressions: requirementExpressions,
  });
}

/** Assemble every root leaf Binding exactly once; composite mounts remain for later compilers. */
export function prepareAgentLeafBindingEntrySet(
  rootInput: unknown,
  dependencyInputs: unknown,
  policyInput: unknown,
): PreparedAgentLeafBindingEntrySetV1 {
  const dependencies = boundedDataSnapshot(dependencyInputs, 'source');
  if (!Array.isArray(dependencies) || dependencies.length === 0) notClosed('$.dependencies');
  const source = prepareExecutableSource(rootInput);
  if (source.root.pin.published_resource_kind !== 'AGENT_RELEASE') notClosed('$.root');
  const document = source.preimage.document as unknown as {
    capability_bindings: readonly CapabilityBindingV1[];
  };
  const rootPaths = prepareRootBindingPaths(rootInput);
  const leafBindings = document.capability_bindings.filter(
    (binding) =>
      binding.kind === 'knowledge' ||
      binding.kind === 'database' ||
      binding.kind === 'plugin' ||
      (binding.kind === 'subagent' && binding.target_kind === 'external_a2a'),
  );
  if (leafBindings.length === 0) notClosed('$.root.capability_bindings');
  const expected = leafBindings.map((binding) => {
    const path = rootPaths.bindings.find(
      (candidate) => candidate.binding_id === binding.binding_id,
    );
    if (path === undefined) notClosed('$.binding_path');
    return { path: path.binding_path, target_key: publishedResourcePinKey(binding.pin) };
  });
  const policies = parseAgentBindingPolicyInput(policyInput, 'agent-leaf-binding-policy-input/1');
  const expectedPaths = new Set<string>(expected.map((item) => item.path));
  if (
    policies.binding_ceilings.length !== expectedPaths.size ||
    policies.binding_ceilings.some((item) => !expectedPaths.has(item.binding_path))
  )
    notClosed('$.policy.binding_ceilings');

  const preparedByTarget = new Map<
    string,
    { input: unknown; pin: ReturnType<typeof prepareLeafResourceSource>['full_pin'] }
  >();
  for (const dependency of dependencies) {
    const prepared = prepareLeafResourceSource(dependency);
    const key = publishedResourcePinKey(prepared.full_pin);
    if (preparedByTarget.has(key) || !expected.some((item) => item.target_key === key))
      notClosed('$.dependencies');
    preparedByTarget.set(key, { input: dependency, pin: prepared.full_pin });
  }
  if (expected.some((item) => !preparedByTarget.has(item.target_key))) notClosed('$.dependencies');

  const preparedSets = [...preparedByTarget.entries()].map(([targetKey, dependency]) => {
    const targetPaths = new Set<string>(
      expected.filter((item) => item.target_key === targetKey).map((item) => item.path),
    );
    return prepareAgentLeafBindingEntries(rootInput, dependency.input, {
      schema_version: 'agent-leaf-binding-policy-input/1',
      workspace_ceiling: policies.workspace_ceiling,
      root_ceiling: policies.root_ceiling,
      binding_ceilings: policies.binding_ceilings.filter((item) =>
        targetPaths.has(item.binding_path),
      ),
    });
  });
  const entries = preparedSets
    .flatMap((prepared) => prepared.entries)
    .sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path));
  if (
    entries.length !== expectedPaths.size ||
    new Set(entries.map((entry) => entry.binding_path)).size !== entries.length
  )
    notClosed('$.entries');
  return deepFreezeJson({
    schema_version: 'prepared-agent-leaf-binding-entry-set/1',
    root: source.root,
    dependencies: [...preparedByTarget.values()]
      .map((item) => item.pin)
      .sort((left, right) =>
        compareCanonicalStrings(publishedResourcePinKey(left), publishedResourcePinKey(right)),
      ),
    dependency_intrinsic_policies: preparedSets
      .map((prepared) => ({
        node_id: canonicalResourceNodeId(prepared.dependency),
        pin: prepared.dependency,
        intrinsic_policy: normalizeCapabilityRequirementExpression({
          schema_version: 'capability-requirement-expression/1',
          expression_kind: 'leaf',
          requirements: prepared.intrinsic_policy,
        }),
      }))
      .sort((left, right) => compareCanonicalStrings(left.node_id, right.node_id)),
    entries,
    requirement_expressions: preparedSets
      .flatMap((prepared) => prepared.requirement_expressions)
      .sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path)),
  });
}

/** Bind the complete leaf entry set to the source's exact graph manifest and direct edges. */
export function prepareGraphBoundAgentLeafBindingEntrySet(
  expectedGraph: unknown,
  graphCandidate: unknown,
  rootInput: unknown,
  dependencyInputs: unknown,
  policyInput: unknown,
): GraphBoundAgentLeafBindingEntrySetV1 {
  const prepared = prepareAgentLeafBindingEntrySet(rootInput, dependencyInputs, policyInput);
  const source = prepareExecutableSource(rootInput);
  const graphBinding = prepareGraphBoundDirectDependencies(
    expectedGraph,
    graphCandidate,
    prepared.root.pin,
    prepared.dependencies,
  );
  if (graphBinding.root_node.dependency_manifest_hash !== source.dependency_manifest.manifest_hash)
    notClosed('$.graph');
  return deepFreezeJson({
    schema_version: 'graph-bound-agent-leaf-binding-entry-set/1',
    graph_hash: graphBinding.graph_hash,
    prepared_entries: prepared,
  });
}
