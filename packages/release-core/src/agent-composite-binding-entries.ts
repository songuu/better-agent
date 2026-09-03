import {
  type CapabilityPolicyCeilingV1,
  type CapabilityBindingV1,
  type CapabilityRequirementExpressionV1,
  CompiledBindingEntryV1Schema,
  type EffectiveCapabilityPolicyV1,
  EffectiveCapabilityPolicyV1Schema,
} from '@better-agent/domain-contracts';
import { parseAgentBindingPolicyInput } from './agent-binding-policy.js';
import {
  type PreparedAgentChildCallOperationsV1,
  prepareGraphBoundAgentFlowCallOperations,
  prepareGraphBoundAgentSubagentCallOperations,
} from './agent-child-call-operations.js';
import { prepareAgentBindingApprovalGate } from './agent-gate-specs.js';
import {
  compileCapabilityRequirementEnvelope,
  meetCapabilityPolicyCeilings,
  normalizeCapabilityRequirementExpression,
  resolveEffectiveCapabilityPolicy,
} from './capability-policy.js';
import { canonicalResourceNodeId } from './closure-identity.js';
import { compareCanonicalStrings, deepFreezeJson } from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { prepareExecutableSource } from './executable-source.js';
import { canonicalSha256 } from './hash.js';
import { prepareRootBindingPaths } from './root-binding-paths.js';

type CompiledBindingEntryV1 = ReturnType<typeof CompiledBindingEntryV1Schema.parse>;

export interface PreparedAgentCompositeBindingEntriesV1 {
  readonly schema_version: 'prepared-agent-composite-binding-entries/1';
  readonly dependency_kind: 'AGENT_RELEASE' | 'FLOW_VERSION';
  readonly graph_hash: `sha256:${string}`;
  readonly nested_closure_hash: string;
  readonly dependency_resource_node: PreparedAgentChildCallOperationsV1['dependency_resource_node'];
  readonly dependency_resource_nodes: PreparedAgentChildCallOperationsV1['projected_resource_nodes'];
  readonly entries: readonly CompiledBindingEntryV1[];
  readonly descendant_binding_entries: readonly CompiledBindingEntryV1[];
  readonly descendant_disabled_binding_paths: readonly `bp1.${string}`[];
  readonly requirement_expressions: readonly {
    readonly binding_path: `bp1.${string}`;
    readonly expression: CapabilityRequirementExpressionV1;
  }[];
}

function notClosed(
  path = '$.composite',
  reason = 'composite Binding inputs do not form one exact closed path projection',
): never {
  throw new ReleaseCoreError('CLOSURE_BINDING_ENTRY_NOT_CLOSED', path, reason);
}

function effectivePolicyAsCeiling(policy: EffectiveCapabilityPolicyV1): CapabilityPolicyCeilingV1 {
  const allowances = new Map<string, CapabilityPolicyCeilingV1['credential_allowances'][number]>();
  for (const requirement of policy.credential_requirements) {
    const key = `${requirement.provider_id}\u0000${requirement.audience}`;
    const current = allowances.get(key);
    allowances.set(key, {
      provider_id: requirement.provider_id,
      audience: requirement.audience,
      allowed_scopes: [
        ...new Set([...(current?.allowed_scopes ?? []), ...requirement.required_scopes]),
      ].sort(),
      principal_modes: [
        ...new Set([...(current?.principal_modes ?? []), ...requirement.allowed_principal_modes]),
      ].sort(),
    });
  }
  const { credential_requirements: _requirements, ...shape } = policy;
  return {
    schema_version: 'capability-policy-ceiling/1',
    credential_allowances: [...allowances.values()],
    ...shape,
  };
}

function unavailableDescendantPolicy(entry: CompiledBindingEntryV1): EffectiveCapabilityPolicyV1 {
  const operations = entry.operation_contracts;
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
      approval:
        entry.approval_gate_spec !== undefined ||
        operations.some((operation) => operation.approval_required)
          ? 'required'
          : 'none',
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

function prepareEntries(
  projection: PreparedAgentChildCallOperationsV1,
  rootInput: unknown,
  policyInput: unknown,
): PreparedAgentCompositeBindingEntriesV1 {
  const source = prepareExecutableSource(rootInput);
  if (source.root.pin.published_resource_kind !== 'AGENT_RELEASE') notClosed('$.root');
  const document = source.preimage.document as unknown as {
    capability_bindings: readonly CapabilityBindingV1[];
  };
  const rootPaths = prepareRootBindingPaths(rootInput);
  const parents = projection.binding_operations.filter(
    (item) => item.invocation_requirements !== undefined,
  );
  if (parents.length === 0) notClosed('$.calls');
  const policies = parseAgentBindingPolicyInput(
    policyInput,
    'agent-composite-binding-policy-input/1',
  );
  const parentPaths = new Set<string>(parents.map((item) => item.binding_path));
  if (
    parentPaths.size !== parents.length ||
    policies.binding_ceilings.length !== parents.length ||
    new Set(policies.binding_ceilings.map((item) => item.binding_path)).size !== parents.length ||
    policies.binding_ceilings.some((item) => !parentPaths.has(item.binding_path))
  )
    notClosed('$.policy.binding_ceilings');
  const sharedCeiling = meetCapabilityPolicyCeilings(
    policies.workspace_ceiling,
    policies.root_ceiling,
  );
  const dependencyNodeId = canonicalResourceNodeId(projection.dependency_resource_node.pin);
  const expressions: PreparedAgentCompositeBindingEntriesV1['requirement_expressions'][number][] =
    [];
  const entries = parents
    .map((parent) => {
      const binding = document.capability_bindings.find(
        (item) => item.binding_id === parent.binding_id,
      );
      const path = rootPaths.bindings.find((item) => item.binding_path === parent.binding_path);
      const policy = policies.binding_ceilings.find(
        (item) => item.binding_path === parent.binding_path,
      );
      const invocation = parent.invocation_requirements;
      if (
        binding === undefined ||
        path === undefined ||
        policy === undefined ||
        invocation === undefined
      )
        notClosed('$.entry');
      const expectedKind = projection.dependency_kind === 'FLOW_VERSION' ? 'flow' : 'subagent';
      if (binding.kind !== expectedKind || parent.operation_contracts.length !== 1)
        notClosed('$.entry.operation_contracts');
      const expression = normalizeCapabilityRequirementExpression({
        schema_version: 'capability-requirement-expression/1',
        expression_kind: 'nested_call',
        invocation,
        child: projection.dependency_resource_node.intrinsic_policy,
      });
      const compositeRequirements = compileCapabilityRequirementEnvelope(expression);
      const compositePolicy = resolveEffectiveCapabilityPolicy(
        meetCapabilityPolicyCeilings(sharedCeiling, policy.ceiling),
        compositeRequirements,
      );
      const operationHashes = parent.operation_contracts.map(
        (operation) => operation.contract_hash,
      );
      const effectivePolicy = { ...compositePolicy, operation_contract_hashes: operationHashes };
      const approval = prepareAgentBindingApprovalGate(
        rootInput,
        binding.binding_id,
        parent.operation_contracts,
      );
      if (
        effectivePolicy.side_effect.approval === 'required' &&
        approval.approval_gate_spec === undefined
      )
        notClosed('$.entry.approval_gate_spec');
      const candidate = {
        binding_path_encoding_version: 'binding-path-lp-utf8/1' as const,
        binding_path: parent.binding_path,
        binding_path_segments: path.binding_path_segments,
        binding_id: binding.binding_id,
        binding_kind: binding.kind,
        target: binding.pin,
        config_schema_version: binding.config.schema_version,
        config_hash: canonicalSha256(binding.config),
        source_contract_hash: projection.dependency_resource_node.pin.contract_hash,
        requirement_expression: expression,
        effective_policy: effectivePolicy,
        operation_contracts: parent.operation_contracts,
        dependency_node_ids: [dependencyNodeId],
        ...(approval.approval_gate_spec === undefined
          ? {}
          : { approval_gate_spec: approval.approval_gate_spec }),
        ...(binding.config.invocation === 'async'
          ? { async_child_policy_hash: canonicalSha256(binding.config.async_child) }
          : {}),
      };
      const parsed = CompiledBindingEntryV1Schema.safeParse(candidate);
      if (!parsed.success) notClosed('$.entry');
      if (path.enabled) expressions.push({ binding_path: parent.binding_path, expression });
      return parsed.data;
    })
    .sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path));
  const projected = projection.projected_binding_entries ?? [];
  const projectedPathByParentAndSource = new Map(
    projected.map((item) => [
      `${item.parent_binding_path}\u0000${item.source_binding_path}`,
      item.binding_path,
    ]),
  );
  const policyByParentPath = new Map(
    policies.binding_ceilings.map((item) => [item.binding_path, item.ceiling]),
  );
  const descendantEntries = projected
    .map((item) => {
      const parentCeiling = policyByParentPath.get(item.parent_binding_path);
      if (parentCeiling === undefined) notClosed('$.policy.binding_ceilings');
      const requirements = compileCapabilityRequirementEnvelope(item.entry.requirement_expression);
      const operationHashes = item.entry.operation_contracts
        .map((operation) => operation.contract_hash)
        .sort();
      if (
        requirements.operation_contract_hashes.length !== operationHashes.length ||
        requirements.operation_contract_hashes.some(
          (hash, index) => hash !== operationHashes[index],
        )
      ) {
        notClosed(
          `$.descendant_binding_entries.${item.binding_path}.requirement_expression`,
          'descendant requirement expression does not bind the compiled operation set',
        );
      }
      const disabled = !item.parent_enabled || item.source_disabled;
      const effectivePolicy = disabled
        ? unavailableDescendantPolicy(item.entry)
        : resolveEffectiveCapabilityPolicy(
            meetCapabilityPolicyCeilings(
              meetCapabilityPolicyCeilings(sharedCeiling, parentCeiling),
              effectivePolicyAsCeiling(item.entry.effective_policy),
            ),
            requirements,
          );
      const skillPackOperationRoutes = item.entry.skill_pack_operation_routes?.map((route) => {
        if (route.pack_binding_path !== item.source_binding_path) {
          notClosed(
            `$.descendant_binding_entries.${item.binding_path}.skill_pack_operation_routes`,
            'descendant Pack route is not bound to its source Binding path',
          );
        }
        const memberBindingPath = projectedPathByParentAndSource.get(
          `${item.parent_binding_path}\u0000${route.member_binding_path}`,
        );
        if (memberBindingPath === undefined) {
          notClosed(
            `$.descendant_binding_entries.${item.binding_path}.skill_pack_operation_routes`,
            'descendant Pack member route has no projected Binding path',
          );
        }
        const content = {
          pack_binding_path: item.binding_path,
          exposed_operation_id: route.exposed_operation_id,
          exposed_operation_contract_hash: route.exposed_operation_contract_hash,
          member_binding_path: memberBindingPath,
          member_target: route.member_target,
          member_operation_contract_hash: route.member_operation_contract_hash,
        };
        return {
          ...content,
          route_hash: canonicalSha256({
            schema_version: 'skill-pack-operation-route-preimage/1',
            ...content,
          }),
        };
      });
      const parsed = CompiledBindingEntryV1Schema.safeParse({
        ...item.entry,
        binding_path: item.binding_path,
        binding_path_segments: item.binding_path_segments,
        effective_policy: effectivePolicy,
        ...(skillPackOperationRoutes === undefined
          ? {}
          : { skill_pack_operation_routes: skillPackOperationRoutes }),
      });
      if (!parsed.success) {
        notClosed(
          `$.descendant_binding_entries.${item.binding_path}`,
          `parent-relative descendant Binding is invalid: ${parsed.error.issues[0]?.message ?? 'unknown schema failure'}`,
        );
      }
      return parsed.data;
    })
    .sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path));
  if (
    descendantEntries.some(
      (entry, index) =>
        index > 0 && (descendantEntries[index - 1]?.binding_path ?? '') >= entry.binding_path,
    )
  )
    notClosed('$.descendant_binding_entries');
  const descendantDisabledPaths = projected
    .filter((item) => !item.parent_enabled || item.source_disabled)
    .map((item) => item.binding_path)
    .sort(compareCanonicalStrings);
  return deepFreezeJson({
    schema_version: 'prepared-agent-composite-binding-entries/1',
    dependency_kind: projection.dependency_kind,
    graph_hash: projection.graph_hash,
    nested_closure_hash: projection.nested_closure_hash,
    dependency_resource_node: projection.dependency_resource_node,
    dependency_resource_nodes: projection.projected_resource_nodes,
    entries,
    descendant_binding_entries: descendantEntries,
    descendant_disabled_binding_paths: descendantDisabledPaths,
    requirement_expressions: expressions.sort((left, right) =>
      compareCanonicalStrings(left.binding_path, right.binding_path),
    ),
  });
}

export function prepareAgentFlowBindingEntries(
  expectedGraph: unknown,
  graphCandidate: unknown,
  rootInput: unknown,
  dependencyInput: unknown,
  nestedClosureInput: unknown,
  declarationInput: unknown,
  policyInput: unknown,
): PreparedAgentCompositeBindingEntriesV1 {
  return prepareEntries(
    prepareGraphBoundAgentFlowCallOperations(
      expectedGraph,
      graphCandidate,
      rootInput,
      dependencyInput,
      nestedClosureInput,
      declarationInput,
    ),
    rootInput,
    policyInput,
  );
}

export function prepareAgentSubagentBindingEntries(
  expectedGraph: unknown,
  graphCandidate: unknown,
  rootInput: unknown,
  dependencyInput: unknown,
  nestedClosureInput: unknown,
  declarationInput: unknown,
  policyInput: unknown,
): PreparedAgentCompositeBindingEntriesV1 {
  return prepareEntries(
    prepareGraphBoundAgentSubagentCallOperations(
      expectedGraph,
      graphCandidate,
      rootInput,
      dependencyInput,
      nestedClosureInput,
      declarationInput,
    ),
    rootInput,
    policyInput,
  );
}
