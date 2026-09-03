import {
  type CapabilityBindingV1,
  type CapabilityRequirementExpressionV1,
  CompiledBindingEntryV1Schema,
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
  readonly entries: readonly CompiledBindingEntryV1[];
  readonly requirement_expressions: readonly {
    readonly binding_path: `bp1.${string}`;
    readonly expression: CapabilityRequirementExpressionV1;
  }[];
}

function notClosed(path = '$.composite'): never {
  throw new ReleaseCoreError(
    'CLOSURE_BINDING_ENTRY_NOT_CLOSED',
    path,
    'composite Binding inputs do not form one exact closed path projection',
  );
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
  return deepFreezeJson({
    schema_version: 'prepared-agent-composite-binding-entries/1',
    dependency_kind: projection.dependency_kind,
    graph_hash: projection.graph_hash,
    nested_closure_hash: projection.nested_closure_hash,
    dependency_resource_node: projection.dependency_resource_node,
    entries,
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
